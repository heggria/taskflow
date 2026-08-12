# P4: Negotiation + errors + recoveryAction

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §18](../rfc-0.3.0-control-plane-v7.6.md)
> TE 基底: `resources/*` 已用 typed errors（如 `TF_DURABILITY_FAILED`、`TF_INVALID_ARGUMENT`、`ControlStoreDurabilityError`）；0.3-C 将其统一为 wire 错误信封。

## Decision

### 握手（negotiation）

```text
{ protocolMajor, supportedReadSchemas[], supportedWriteSchemas[],
  requiredFeatures[], offeredFeatures[], buildInfo }
```

- `protocolMajor` 不匹配 → `TF_PROTOCOL_INCOMPATIBLE`。
- `requiredFeatures` 无法满足 → `TF_FEATURE_REQUIRED`（link/admit 阶段拒绝，见 P15 durable-required）。

### Error envelope（统一错误信封）

```text
{
  code, message,
  recoveryAction: retry-same-command | retry-new-command | refresh
                | reconcile | operator | none,
  sideEffects: none | possible | unknown,
  commandId?, commitSeq?, controlDomainId?, projectId?
}
```

Codes（0.3-C wire 全集，禁止自定义裸 code）：`TF_PROTOCOL_INCOMPATIBLE`、`TF_SCHEMA_*`、`TF_FEATURE_REQUIRED`、`TF_POLICY_DENIED`、`TF_AUTHORITY_REVOKED`、`TF_STALE_VERSION`、`TF_IDEMPOTENCY_CONFLICT`、`TF_CROSS_PRINCIPAL_COMMAND`、`TF_LEGACY_CONFLICT`、`TF_PROVIDER_AMBIGUOUS`、`TF_JOURNAL_UNAVAILABLE`、`TF_DURABILITY_FAILED`、`TF_CURSOR_EXPIRED`、`TF_COMMAND_FAILED`、`TF_BOOTSTRAP_FAILED`、`TF_RECONCILE_REQUIRED`、`TF_ADMISSION_BINDING_CONFLICT`、`TF_CAPACITY_EXCEEDED`。

### TF_RECONCILE_REQUIRED（normative pin）

- `recoveryAction: operator`，`sideEffects: unknown`。
- `taskflow_runs(wait)` / 状态 RPC 返回**正常快照**（status=unknown、needs-operator 标志），**不是** transport 级 RPC 失败。

### Cursor

- `minAvailableCommitSeq`、cursor lease/TTL；`TF_CURSOR_EXPIRED` → checkpoint resync（见 P11）。

## Status

Accepted for 0.3-C wire freeze。
