# 0.3-C Protocol ADRs (P1–P16) — wire-freeze gate

> **Branch:** `rc/0.3.0-trusted-effects`
> **Status:** S1 交付物 — 全部 P-ADR 为 0.3-C TypeBox wire freeze 的前置门槛（RFC §22 步骤 2.5）。
> **Normative parent:** [RFC v7.6 快照](../rfc-0.3.0-control-plane-v7.6.md)（archive `origin/backup/0.3-archive/mac-feat-0.3.0-control-plane`，只读蓝本）
> **TE 基底:** 本组 ADR 以当前 Trusted Effects 架构为执行权威层（`packages/taskflow-core/src/resources/*`），Control Plane 概念叠加其上。**抄概念，不搬代码。**

| ID | 标题 | 文件 | Status |
|----|------|------|--------|
| P1 | Policy overlay（策略叠加） | [P1-policy-overlay.md](./P1-policy-overlay.md) | Accepted |
| P2 | Empty-policy exposure（空策略暴露面） | [P2-empty-policy-exposure.md](./P2-empty-policy-exposure.md) | Accepted |
| P3 | Domain + Registry rebuild + clone/worktree identity | [P3-domain-registry-identity.md](./P3-domain-registry-identity.md) | Accepted |
| P4 | Negotiation + errors + recoveryAction | [P4-negotiation-errors.md](./P4-negotiation-errors.md) | Accepted |
| P5 | Phase × feature + RunStatus/Stage 矩阵 | [P5-phase-feature-matrix.md](./P5-phase-feature-matrix.md) | Accepted |
| P6 | Canonical hash + ArtifactRef + SecretRef | [P6-canonical-hash-refs.md](./P6-canonical-hash-refs.md) | Accepted |
| P7 | Dynamic paths + dual hashes + cache | [P7-dynamic-paths-dual-hashes.md](./P7-dynamic-paths-dual-hashes.md) | Accepted |
| P8 | Enforcement capabilities（TE 基底重写） | [P8-enforcement-capabilities.md](./P8-enforcement-capabilities.md) | **Proposed** |
| P9 | legacy-conflict | [P9-legacy-conflict.md](./P9-legacy-conflict.md) | Accepted |
| P10 | Rollback tiers | [P10-rollback-tiers.md](./P10-rollback-tiers.md) | Accepted |
| P11 | Compaction + cursor + minAvailableCommitSeq | [P11-compaction-cursor.md](./P11-compaction-cursor.md) | Accepted |
| P12 | Command batch + re-auth disclosure | [P12-command-batch-reauth.md](./P12-command-batch-reauth.md) | Accepted |
| P13 | Bootstrap / fresh-install / singleton lock / platforms | [P13-bootstrap-singleton.md](./P13-bootstrap-singleton.md) | Accepted |
| P14 | **ControlStore engine（TE 基底重写）** | [P14-controlstore-engine.md](./P14-controlstore-engine.md) | **Proposed** |
| P15 | **Approval protocol（TE 基底重写）** | [P15-approval-protocol.md](./P15-approval-protocol.md) | **Proposed** |
| P16 | UserCoordinatorStore concurrency + release | [P16-coordinator-concurrency.md](./P16-coordinator-concurrency.md) | Accepted |

## 门槛规则（RFC §22，统一无可选洞）

- **P1–P16 全部 required，wire freeze 之前必须齐全。** 不允许"可选洞"式跳过。
- 文件存储仍是 engine（P14）：fsync、atomic batch、locks、recovery、compaction。
- **P16 不可折叠进 P13。**
- Status 语义：`Accepted` = 决策直接钉住已批准的 RFC v7.6 架构决策，无重定标；`Proposed` = 以 TE 架构为基底**重定标**的决策，需随 wire freeze 一起批准。
- P8/P14/P15 的 archive 旧草稿（v7.6 wire-freeze gate 版本）已按 TE 架构重写，见各文件 "TE 基底" 节。

## 与 archive 草稿的关系

archive `backup/0.3-archive/mac-feat-0.3.0-control-plane` 下已有全部 16 个草稿（P1–P16 + P16-1R 补充）。
0.3-C 以 archive 草稿 + RFC v7.6 为输入，**在当前 TE 架构上概念重写**：TE 的 `resources/*` 是 execution authority（唯一提交权威），Control Plane 概念（ControlDomain/ControlStore/CommandRecord/Approval/Receipt/UserCoordinatorStore）叠加为新的控制面；archive 的实现细节（路径、锁协议、schema 版本）不作为 0.3-C 的已批准行为，除非本组 ADR 显式采纳。

## 实施补充（非 wire-freeze 门槛）

| 父 | 主题 | 状态 |
|----|------|------|
| P16 | 版本化 first-dispatch-owner saga（archive P16-1R） | 0.3-C 不在 S1 采纳；S4 运行控制阶段重新推导 |
