# P11: Compaction + cursor + minAvailableCommitSeq

> Status: **Accepted** (0.3-C wire-freeze gate — 契约部分；实施在 S3/S4)
> Normative parent: [RFC v7.6 §13/§18](../rfc-0.3.0-control-plane-v7.6.md)
> TE 基底: `resources/journal.ts` 追加式意图日志 + `resources/persistence.ts` 持久化原语；0.3-C ControlStore journal 沿用"追加 + checkpoint"形态。
> 说明: archive 草稿为 PARTIAL（实施切片证据）；0.3-C 在本 ADR 只冻结 **wire/契约**，物理保留/删除策略交给 P14 + S3/S4 实施门。

## Decision

- `commitSeq` **永不**被 compaction 重编号。
- Receipt 内嵌 issue-time 的 `eventManifest[]` / merkle|hash-chain root → compaction 后仍有效；compaction 不得要求修改旧 Receipt。
- **Cursor floor 的唯一权威形态**：hash-linked project journal 中经校验的 `CompactionCheckpoint { throughCommitSeq }` 事件 → 派生 `minAvailableCommitSeq = throughCommitSeq + 1`。**无** loose `compaction.json` 缓存可作权威。
- 过期 cursor → `TF_CURSOR_EXPIRED` → checkpoint resync（P4）。
- 保留期后缺 blob → `artifactIntegrity: unknown`（**不是**静默 verify）。
- checkpoint 可推进**逻辑** resync floor，但**不**单独授权删除 journal 段；物理删除需 P14 retention handoff 证明（保留前缀、hash-chain 边界、Receipt 可达性、crash recovery、trust root）后才启用。

## Wire impact (TypeBox)

- `CompactionCheckpointEvent`（journal 内事件，含 throughCommitSeq）。
- `CursorState { minAvailableCommitSeq, cursorId, leaseExpiresAt }`。
- Receipt wire 已有 eventManifest/root 字段（P13/Receipt 类型，见 wire-freeze）。

## Status

Accepted（契约）for 0.3-C wire freeze。实施 PARTIAL 状态不阻塞 wire 冻结；P14 重写版在 S3 落地 engine 时承接 retention handoff。
