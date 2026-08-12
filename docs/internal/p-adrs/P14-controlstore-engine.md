# P14: ControlStore engine（TE 基底重写）

> Status: **Proposed** (0.3-C wire-freeze gate — TE 基底重写，需随 wire freeze 批准)
> Normative parent: [RFC v7.6 §4.2/§22](../rfc-0.3.0-control-plane-v7.6.md)
> TE 基底: `resources/persistence.ts`（`writeJsonAtomicDurable`、`appendJsonLinesDurable`、`PersistentFileMutex`、`fsyncDirectory`）+ `resources/journal.ts`（追加式 intent 日志 + 原子批形态）+ `resources/file-transaction.ts`（snapshot → stage → atomic rename）。
> 重写说明: archive 草稿 = files-only 引擎 + trusted-local-disk 信任模型 + FAIL 状态；0.3-C 保留其**存储形态与信任边界决策**，但把引擎原语绑定到 TE 已有的持久化层，并明确 S3 的实施门。

## Decision

0.3 GA engine 是 **files-only**（仍是一个完整引擎——fsync、atomic batch、locks、recovery、compaction 都是 engine 职责）：

- **Atomic commit batch**: temp + fsync + rename（TE `writeJsonAtomicDurable` / `appendJsonLinesDurable` 直接复用）。
- Journal segments 在 `journal/`；projections 在 `projections/`；commands 在 `commands/`；receipts 在 `receipts/`。
- **Header**: `{ projectId, controlDomainId, schemaVersion, directoryBinding }`。
- `commit-seq.json` 单调计数器；`commitSeq` 永不重编号（P11）。
- **No `node:sqlite`**，除非未来 ADR 替换本 ADR。

### 恢复

重读 journal segments；projection 缺失时从 events 重建（幂等）。

### 信任边界（trusted-local-disk，沿用 archive 2026-07-27 scope 决策）

- 假设项目根、`.taskflow/`、`.taskflow-control.anchor.json` **不会被整体一致恢复到某个旧快照**。
- 能把所有本地咨询字节一致回滚的 actor（备份/VM 快照/FS 管理员）在 0.3.0 威胁模型**之外**：无 anti-rollback / external freshness 承诺。
- 不要求外部单调见证或外部认证修复服务。
- 该排除**很窄**：malformed/torn 文件、缺根/缺锚、journal 不连续、crash-at-write-boundary、并发写者、fencing 违规、symlink/路径替换、compaction/retention 正确性、recovery 与 mutation 竞态——**全部仍在 P13/P14/P16 GA 范围内**，必须 fail closed。
- 本地 `repair` 记录不能自称 freshness 根（可被整根回滚）；未来 anti-rollback 必须绑定 restorer 无法一起回滚的外部因素（OS/hardware 单调计数、enterprise 审计服务等）。
- 信任检查失败/不可用 → 允许清晰标注的 forensic read/export 路径，但**禁止** ControlStore mutation、provider dispatch、capacity change、approval settlement、Receipt issuance。

### 0.3-C 决策记录（在 archive 决策表上补充）

| 字段 | Frozen 0.3-C 决策 |
|---|---|
| 引擎 | files-only；原语 = TE `resources/persistence.ts` / `resources/journal.ts`；布局 = journal/projections/commands/receipts + header + commit-seq.json |
| 信任 | trusted-local-disk；整根一致回滚排除（archive 2026-07-27 决策保留，release notes 必须保留该限制声明） |
| 原子性 | CommandRecord + events 同批原子提交（P12）；permit/intent 顺序沿用 TE 资源事务 |
| 锁 | 单写者/恢复由 P13 singleton + PersistentFileMutex 承接；跨进程互斥由 TE persistence 层提供 |
| 恢复 | 重读 journal → 重建 projections；`unknown` 状态按 P5 保持非终态 |
| 物理 compaction | 契约在 P11（CompactionCheckpoint 事件）；物理删除需 S3 retention handoff 证明后才启用 |
| 反回滚 | 不在 0.3.0 承诺内；未来升级必须走"持久协议 + compare-and-advance 授权"，不是新 JSON 文件 |

### 实施门（S3，非 wire-freeze 门）

- 原子批 crash/power-loss 矩阵（写前/写中/写后重开：旧完整态 | 新完整态 | fail-closed，绝无未验证混合态）。
- 并发写者/单写者证明；fencing 与 stale owner 拒绝。
- temporary-path symlink 硬化（archive Round 53 教训: 随机 UUID + 独占 `"wx"` 创建 + EEXIST 重试；rename 目标被并发替换为 symlink 的残余竞态必须 fail closed 或文档化为 OS 下限）。
- recovery racing mutation 的 fail-closed 路径。
- 每个入口（MCP / CLI / taskflowd）在首次 mutation/provider 调用前执行同一 gate。

## Wire impact (TypeBox)

- `ControlStoreHeaderSchema`、`ControlStoreStatus`（store 健康/恢复状态）新增。
- `ControlStoreDurabilityError` → `TF_DURABILITY_FAILED`（P4 信封）。

## Status

Proposed（重写）for 0.3-C wire freeze — 存储形态与信任边界 = archive 批准的延续；原语绑定 TE persistence 层 + S3 实施门为本版新增内容。
