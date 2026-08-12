# P2: Empty-policy exposure（空策略暴露面）

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §14/§19](../rfc-0.3.0-control-plane-v7.6.md)（D21）
> TE 基底: `resources/baseline.ts` 主机默认分类（resolve-only 是 TE 当前唯一已证明分类）+ `effects/validate.ts` 默认拒绝路径。

## Decision

当不存在显式 project/user 策略时，暴露面 = **host-default attenuated**：

- 允许 link/admit 公共 0.2.4 表面（D21 兼容，`packages/taskflow-core/test/fixtures/public-surface-0.2.4.json` 为 golden）。
- **不**授予网络、跨项目、或 DomainTransfer 能力。
- Approval mode 默认 `compat-auto-reject`（见 P15）。

## Empty ≠ unrestricted

- 缺失策略**永不**等于"允许一切"。
- 未知 capability 请求 → deny（fail closed）。
- TE 语义映射：未声明的 `effects[]` 或未解析的 PathRef/SecretRef/ServiceRef → 编译/准入即拒绝（`validateEffectIR` + `runtime-apply` 桥只对已绑定 capability 放行）。

## Wire impact (TypeBox)

- 空策略在 wire 上仍显式存在：`PolicyBundle { hostCeiling, userCeiling?, projectCeiling?, invocationCeiling? }`，缺失层 = 继承上一层，最终 fail-closed 兜底。
- 不存在"无 PolicyBundle"的合法 wire 形态。

## Status

Accepted for 0.3-C wire freeze。
