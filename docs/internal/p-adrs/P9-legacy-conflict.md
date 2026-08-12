# P9: legacy-conflict（0.2 写者冲突）

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §20](../rfc-0.3.0-control-plane-v7.6.md)（D20）
> TE 基底: TE 已并入 0.2.10 runtime（单一运行时），0.3-C 控制面与之共存于同一项目；冲突面 = 0.2 写者对 flow 存储的并发写入。

## Decision

当 0.3 control 激活期间检测到同一项目 flow 存储上的 **0.2 写者**：

- 0.3 **停止新的 Attempts**（`legacy-conflict` 状态，`TF_LEGACY_CONFLICT`）。
- 既有 0.3 journal 对 0.3 runs 保持权威。
- **Dual-write（D20）**: 0.3 只能停自己；**不能**杀死外来 0.2 写者。

### 语义

| 情形 | 行为 |
|------|------|
| 0.2 writer 与 0.3 control 同时活跃 | 0.3 侧新 Attempt 拒绝（TF_LEGACY_CONFLICT, recoveryAction=operator） |
| 0.2 writer 停止 | 0.3 恢复 admit（operator 确认后） |
| 0.3 journal 与 0.2 历史并存 | 0.3 runs 以 0.3 journal 为准；0.2 历史仅以 `LegacyEvidenceImported` 导入 |

- 导入语义：0.2 历史只作为 evidence import，**不**合并进 0.3 journal 的权威叙事。

## Wire impact (TypeBox)

- 错误码 `TF_LEGACY_CONFLICT` 入错误信封（P4）；RunStatus 不新增值（保持 blocked/unknown + needs-operator 标志）。

## Status

Accepted for 0.3-C wire freeze。
