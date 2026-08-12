# P10: Rollback tiers（回滚分层）

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §20](../rfc-0.3.0-control-plane-v7.6.md)（D12）
> TE 基底: P14 的 trusted-local-disk 信任模型（archive 2026-07-27 scope 决策保留）；`resources/persistence.ts` 原子写原语。

## Decision

1. **Full rollback**：任何 0.3 ControlStore 写入之前 → 可完整回滚到 0.2（无迁移成本）。
2. **首次 0.3 写入之后**：
   - read-only export / lossy export **可用**；
   - **execute promise 不存在**（导出的历史不得承诺可继续执行）。
3. **无 DomainTransfer 作为回滚机制**（回滚 ≠ 跨域搬账本）。

### 分层表

| Tier | 前提 | 能力 |
|------|------|------|
| T0 完整回滚 | 无 0.3 写 | 完整回到 0.2 行为 |
| T1 只读导出 | 有 0.3 写 | 只读/有损导出，无执行承诺 |
| T2 前向运行 | 0.3 GA | 0.3 持续执行（回滚仅 T1） |

- 0.3-C 的 store 信任模型 = trusted-local-disk（P14）：不声称外部单调见证/反回滚；整根一致回滚在 0.3.0 威胁模型之外。

## Wire impact (TypeBox)

- 导出格式复用 Receipt/eventManifest 的 wire types（无新类型）；导出文件带 `exportKind: "readonly" | "lossy"` 与 `executePromise: false` 字段。

## Status

Accepted for 0.3-C wire freeze。
