# P1: Policy overlay（策略叠加）

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §14](../rfc-0.3.0-control-plane-v7.6.md)（D10）
> TE 基底: `resources/authority.ts` InvocationAuthority + `resources/registry.ts` RootRegistry/RootGrant + `resources/types.ts` ScopedContentEvidence.capabilityBindingId + `effects/validate.ts` 静态检查。

## Decision

有效权威是各层策略的**交集**：

```text
effectiveAuthority = host ∩ user ∩ project ∩ invocation
```

- **host**：主机基线策略（`resources/baseline.ts` HostProbe 分类：sandboxed-single-root / sandboxed-multi-root / resolve-only / unsupported）。
- **user**：用户级策略（0.3-C 在 ControlRegistry/UserCoordinatorStore 层持有，S3 落地）。
- **project**：项目级策略（随 ControlDomain 的 ControlStore 持久化）。
- **invocation**：单次调用/声明级策略（TE 的 EffectIR 声明 + PathRef 绑定 + capabilityBindingId）。

### 操作（Ops）

| Ops | 语义 |
|-----|------|
| **deny** | 移除一项 capability |
| **substitute** | 替换为允许的替代（冲突 → deny） |
| **attenuate** | 收缩 scope（永不放大） |

### 规则

- Security-unknown 字段 **fail closed**（未知能力请求 → deny，见 P2）。
- 目录/标签 ≠ 权威（catalog labels ≠ authority）。
- Project 策略不能放大 user/host 天花板。
- 单一 canonical hash 库（见 P6）。
- 0.3-C 的 TE 执行权威不可被策略层绕过：策略只决定"绑定哪些 capability"，实际写入仍必须经过 `resources/*` 的资源事务（snapshot → lease → intent/permit → stage → commit/restore）。

## Wire impact (TypeBox)

- 策略决策记录在 `CommandRecord.authorizationContextHash`（审计元数据，accept 时记录）。
- disclosure 时用 **live authz** 重查（见 P12）。
- BoundPlan 携带 capabilitySetHash / policyHash（见 P7 wire-freeze）。

## Status

Accepted for 0.3-C wire freeze（决策内容 = RFC v7.6 §14 批准内容的钉住；TE 映射层新增，无架构分歧）。
