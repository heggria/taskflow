# Library RFC — 交叉对抗 Review Changelog

> 日期：2026-07-06 · 流程：`adversarial-rfc-review`（两轮交叉对抗，全 Qwen agent）
> Run id: `adversarial-rfc-review-mr8xd8fc-fff582`
> Reviewers: analyst / critic / risk-reviewer（均 `anthropic/qwen3.7-max:xhigh`）
> 结构：R1 三视角独立批评 → 互相反驳（交叉对抗）→ 仲裁收敛 → 修订；R2 红队复查修订版 → 仲裁 → 终修订
> 结果：R1 发现 18 项 → 全部整合；R2 发现 10 项 → 全部整合。无遗留未解决项。

---

## R1 Findings（18 项：4 blocker · 11 major · 3 minor）

### Blockers (4)

| ID | 问题 | 解决方式 |
|---|---|---|
| A1 | `listFlows` 的 `endsWith('.json')` 会把 `.meta.json` sidecar 误识为候选 flow | §二 + §八：显式添加 `!name.endsWith('.meta.json')` 排除条件（`store.ts:668`），加专项测试 |
| A2 | `Embedder` 挂在 `RuntimeDeps` 上是错误的 DI seam——embedding 发生在 tool handler 层而非 DAG 执行层 | §4.1：新建独立 `LibraryDeps` 接口，`RuntimeDeps` 保持不变 |
| A4 | `argShape` 类型推断不可行（`ArgSpecSchema` 无 `type` 字段），query 侧提取算法也未定义 | §5.2：Phase 1-2 移除 argShape 成分，仅保留 phaseSignature + phaseCount；Phase 3 路径明确列出三个前置条件 |
| A8 | generality 公式用 `literalChars` 做分母结构性惩罚冗长 flow，verbose flow 比 terse 版低 41% | §3.3：改用 `literalTokenRatio = literalChars / (literalChars + placeholderChars)` 归一化；附 5 个 worked examples 校准 |

### Majors (11)

| ID | 问题 | 解决方式 |
|---|---|---|
| A3 | `why`/`reuseHint` 生成机制未定义——是模板还是 LLM？与零 token 承诺矛盾 | §5.3：定义 Tier 1 始终模板化（零 token），Tier 2 LLM 增强留 Phase 3；给出完整模板代码 |
| A5 | 无 `taskflow_save` / `taskflow_search` MCP 工具——codex/claude/opencode/grok 无法保存或搜索 | §5.4：新增两个 MCP 工具，含完整 input schema；pi 适配器扩展 `purpose`/`tags`/`notes` 透传 |
| A6 | reuseCount 两半都未定义：无检测机制 + 无并发合约 | §七 Phase 1：新增 `reusedFromSearch` 标记，递增在 tool handler 层 + `withLock` 保护，sub-flow 不计 |
| A7 | embedding 输入文本构造完全未定义——直接影响语义检索质量 | §3.4：给出完整算法（5 段拼接）+ 512 字符预算 + 截断优先级 |
| C3 | 降级矩阵遗漏 malformed-vector 场景（维度错误/NaN/Infinity） | §4.1 + §4.3：新增 `validateEmbedding()` 接口，写入前必校验，失败 → `null` + warn |
| R2 | flow 文件与 sidecar 双文件写入无原子性合约 | §七 Phase 1 + §九：两个 `writeFileAtomic` 在同一 `withLock` 临界区执行 |
| R4 | embedding-dim 不匹配恢复路径模糊，`reembed --stale-only` 推迟到 Phase 3 太晚 | §七 Phase 2：`reembed --stale-only` 提前到阶段 2 必交付；dim triple-check 规范化 |
| R6 | command-kind embedder 无超时/无输出上限/无界冷启动 | §4.2：`timeoutMs` 默认 30s + stdout 64KB 上限 + 冷启动显著警告 |
| N1 | sidecar 命名规则未指定，与 `safeFlowDirName` 碰撞风险 | §3.1：明确 sidecar 文件名 = `safeFlowDirName(def.name) + '.meta.json'`，继承归一化限制 |
| N2 | search action 无 MCP 工具（与 A5 同根） | §5.4：统一枚举所有新增 MCP 工具（`taskflow_save` + `taskflow_search`） |

### Minors (3)

| ID | 问题 | 解决方式 |
|---|---|---|
| C4 | 跨宿主配置路径 UX 误导（非 pi 用户须手动创建 `~/.pi/agent/settings.json`） | §4.2：添加说明段落，不引入备用路径 |
| C7 | 混合排序权重 0.6/0.25/0.15 无实证 | §5.2 + §十一：开放 `searchWeights` 配置入口，列入开放问题 #6 |
| R8 | 库膨胀 O(n) 无上限 | §九 + §七 Phase 3：`maxFlows` 配置 + auto-prune 列为 Phase 3，风险表标注 scaling wall |

---

## R2 Findings（10 项，红队复查修订版后）

| ID | 问题 | 解决方式 |
|---|---|---|
| R2R1 | command-kind 未约束 `spawn` vs `exec`——shell 注入风险 | §4.2：明确要求 `child_process.spawn()`，禁止 `exec()` 和 shell 调用 |
| R2C1 | structScore 算法占 25% 权重但完全未定义（编辑距离算法/归一化/子权重均缺） | §5.2.1：给出完整实现（Levenshtein + countPenalty + 0.7/0.3 子权重），引用 `topoLayers()` |
| R2C2 | `taskflow_show`/`taskflow_list` 未扩展返回 library 元数据——复用时需额外 search 才能看到 purpose/tags | §5.5：show 返回 `{definition, library}` 结构；list 追加 purpose + generality + reuseCount |
| R2C3+R2R2 | `reusedFromSearch` 默认行为自相矛盾——RFC 正文与 self-critique 不一致 | §七 Phase 1：选定 (b) 方案——默认 false，仅 search→reuse 递增；附明确意图说明 |
| R2C4 | sidecar 陈旧时 search 用混合新鲜度数据评分（结构字段从 def 重新派生但 embedding 仍旧） | §5.2.2：形式化 sidecar staleness detection——比对 `freshSig` vs `sidecar.phaseSignature`，不匹配时重派生结构字段 + 标记 embedding stale |
| R2R3 | `withLock` callback 同步但 embedder 异步——执行顺序未说明 | §七 Phase 1 + §九：明确先 `await embed()`，再 `withLock` 内同步写入 |
| R2C5 | `searchMode` 无法表达混合向量结果集 | §5.3：枚举扩展为 `'semantic' \| 'structural' \| 'mixed'`，基于 `counts.withVectors` 判定 |
| R2R4 | embedding 文本预算单位对 CJK 歧义（chars vs bytes vs codepoints） | §3.4：明确 512 = JavaScript `string.length`（UTF-16 code units） |
| R2R5 | reembed action 锁定策略未指定 | §七 Phase 2：per-flow `withLock` 策略，与 save 共享锁 |
| R2R6 | cosine 性能 scaling 未文档化 | §4.1：添加 O(n·d) 性能说明 + 500×1024 ≈ 1ms 基准 |

---

## 统计

- **R1**：18 项（4 blocker / 11 major / 3 minor）→ 全部整合进 RFC 正文
- **R2**：10 项 → 全部整合进 RFC 正文
- **无遗留未解决项**（self-critique 列出 3 个 residual risks，均为 acceptable / 非 blocking，留 Phase 1-2 实证校准）

## Review 流程结构（供复用）

```
seed-doc (script: cat RFC)
  ↓
R1 三视角独立批评（parallel: analyst / critic / risk-reviewer，RFC 作 context）
  ↓
R1 交叉对抗反驳（parallel: 每个视角看另两个的 findings，concede/defend/sharpen）
  ↓
R1 仲裁（analyst，output:json {findings, converged, verdict}）
  ↓ (verdict==BLOCK)
R1 修订（critic 输出完整修订 markdown）
  ↓
R2 红队（parallel: critic + risk-reviewer，复查修订版是否真解决问题 + 新引入 + R1 盲区）
  ↓
R2 仲裁（analyst，output:json）
  ↓ (verdict==BLOCK)
R2 终修订（critic 输出终版 markdown）
  ↓
final-report（reduce: analyst，输出 changelog + 终版 RFC）
```

> 关键设计点：仲裁 phase 用 `type:"agent"` + `output:"json"` 而非 `type:"gate"`——因为 gate 的 VERDICT:BLOCK 会 halt 整个 flow，而这里 `verdict` 字段是 `when` 路由数据，不应 halt。这是一个容易踩的坑。
