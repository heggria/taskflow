# P8: Enforcement capabilities（TE 基底重写）

> Status: **Proposed** (0.3-C wire-freeze gate — TE 基底重写，需随 wire freeze 批准)
> Normative parent: [RFC v7.6 §15/§16](../rfc-0.3.0-control-plane-v7.6.md)（D23/D11）
> TE 基底: `resources/baseline.ts` HostProbeClassification + `resources/execution.ts`（resolve-only 执行协调器、单提交权威）+ `resources/schema.ts` PathRef 白名单 + `effects/schema.ts` 声明式 EffectIR。
> 重写说明: archive 草稿仅列出 RFC 能力值表；本 ADR 把每个能力维度的取值**映射到 TE 可证明的证据面**，并钉住 0.3-C 每个维度的默认档。

## Decision

正交能力维度（RFC §15，取值映射到 TE 证据）：

| Capability | 0.3-C 取值 | TE 证据面（可证明性） |
|---|---|---|
| resolution | `contained` \| `unbound` | **contained** = PathRef 白名单 + canonical prefix 解析（`normalizeCanonicalPrefix`、lease key 重叠检测）；unbound = 无 PathRef 约束（0.3-C **不提供**） |
| mutationMediation | `none` \| `brokered` | **brokered** = 声明式 fs 写入必须走 `resources/file-transaction.ts` 资源事务（snapshot → lease → intent/permit → stage → Commit\|Restore+Reject），resources/* 是唯一提交权威；none = 无中介（0.3-C 对已声明写入**不提供**） |
| processIsolation | `none` \| `sandboxed` | 由 HostProbe 分类映射：`sandboxed-single-root`/`sandboxed-multi-root` → sandboxed；`resolve-only` → **none**；`unsupported` → 拒绝执行（fail closed）。**无基线证据时只能 resolve-only**（TE 当前现实） |
| revocation | `admission-only` \| `per-mutation` \| `{mode:"bounded-latency", maxLatencyMs}` | **admission-only** = capabilityBindingId 准入期绑定（`ScopedContentEvidence.capabilityBindingId`），披露时 live re-auth（P12）；per-mutation / bounded-latency 0.3-C 不做（wire 保留取值，实施在 future ADR） |

### Fail-closed 规则（D11）

- 任何维度无法给出已证明取值 → 该维度取最弱档 + 对应能力拒绝（例如 HostProbe `unsupported` → 拒绝执行，绝不下放到"裸 shell + 无证据"）。
- `unsupported sandbox → fail closed`：archive 草稿的 D11 保留。
- Receipt.assurance.enforcement 记录**承诺**；使用 bounded-latency 时记录 promise vs observation（`observedRevocationLatencyMs` 可选字段）。

### 0.3-C 默认能力包（wire 冻结值）

```text
{ resolution: "contained", mutationMediation: "brokered",
  processIsolation: <host-probe-derived>, revocation: "admission-only" }
```

- processIsolation 由 HostProbe 证据派生：有已批准 sandbox 基线 → sandboxed；否则 resolve-only → none。
- 任何 flow 想获得 `unbound`/`per-mutation` 能力 → `TF_FEATURE_REQUIRED`（不是静默降级）。

## Wire impact (TypeBox)

- `EnforcementCapabilitiesSchema`（新增）: 四维正交字段，processIsolation 用 StringEnum(`sandboxed`|`none`) + provenance 字段（baselinePolicyId / hostProbeSha256）。
- `BoundPlan.enforcementCapabilities` 为必填（无洞）。
- 与 `resources/baseline.ts` HostSupportCell 一一对应：`classification` → processIsolation；`backendId/backendCapabilityVersion` → 证据指纹。

## Status

Proposed（重写）for 0.3-C wire freeze — archive 版 Accepted 于历史 0.3.0；本版把能力值绑定到 TE 证据面，维度取值与默认档需随 wire freeze 批准。
