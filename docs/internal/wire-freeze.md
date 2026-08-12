# 0.3-C TypeBox Wire Freeze（提案）

> **Status:** PROPOSED — 待 P1–P16 ADR + 本清单评审后冻结
> **Branch:** `rc/0.3.0-trusted-effects`
> **Date:** 2026-08-12
> **Normative parent:** [RFC v7.6 快照 §22/§24](./rfc-0.3.0-control-plane-v7.6.md)（步骤 3: "Wire freeze + TypeBox"）
> **前置门槛:** [P1–P16 ADR](./p-adrs/README.md) 全部 required，无可选洞（RFC §22.5）。

## 1. 目标

把 0.3-C Control Plane 的**核心 wire 契约**冻结为 TypeBox schema 清单：标明哪些**复用 TE 现有 schema**、哪些**新增**、哪些**修改**。本文件是设计文档；实际 `.ts` 实现随 S2（taskflow-control 包）落地，落地时以本清单为准并回填文件引用。

## 2. TypeBox 约定（沿用 TE 现行风格）

- 包名 `typebox`（vendored，TE 已依赖）；`import { Type } from "typebox"`。
- 枚举用 `StringEnum(...)`（`src/typebox-helpers.ts`，兼容不支持 anyOf/const 的 provider）。
- 对象 schema 一律 `{ additionalProperties: false }`（closed contract）。
- 类型导出用 `Static<typeof X>`；同一 schema 文件是 wire 单一事实来源。
- 每个顶层 wire doc 带 `schemaVersion`；协商交换 `supportedReadSchemas[] / supportedWriteSchemas[]`（P4）。
- **禁止** optional holes：wire 必填字段不得用 `Type.Optional` 回避（例外需在对应 P-ADR 显式批准）。

## 3. 核心 wire types 清单

图例：🟩 **REUSE** = 直接复用 TE 现有 schema（不改动）；🟨 **MODIFY** = 在 TE schema 基础上扩展/收紧；🟥 **NEW** = 0.3-C 新增。

### 3.1 执行权威层（TE 已有，冻结不动）

| Type | 标记 | 来源 | 0.3-C 用途 |
|------|------|------|-----------|
| `PathRefSchema`（literalPath/argPath/segments + PathIntent） | 🟩 REUSE | `taskflow-core/src/resources/schema.ts` | BoundPlan/BoundFragment 路径绑定、ArtifactRef 物理路径 |
| `EffectDeclSchema` / EffectIR（closed kinds + labels） | 🟩 REUSE | `taskflow-core/src/effects/schema.ts` | BoundPlan 声明式效果面、Receipt 效果清单 |
| `SecretRef { secretId, issuer? }` | 🟩 REUSE | `taskflow-core/src/effects/types.ts` | 与 RFC §12 一致（RFC 显示 issuer 必填；0.3-C 以 TE 可选 issuer 为兼容超集，binder 填充） |
| `ServiceRef { serviceId, operation? }` | 🟩 REUSE | `taskflow-core/src/effects/types.ts` | 0.3-C 无活 adapter，wire 保留句柄形态 |
| `ConfidentialityLabel / IntegrityLabel` | 🟩 REUSE | `taskflow-core/src/effects/types.ts` | Receipt.assurance.provenance 标签 |
| `ExecutionOwner { runId, phaseId, attemptId, unitId, ancestry }` | 🟩 REUSE | `taskflow-core/src/resources/types.ts` | Run/Attempt 身份基座；0.3-C 映射 nodeInstanceId |
| `ScopedContentEvidence { effectId?, capabilityBindingId?, beforeContentId?, afterContentId? }` | 🟩 REUSE | `taskflow-core/src/resources/types.ts` | ArtifactRef ledger-reachability 证据、Receipt 内容完整性 |
| `WriteIntentRecord / WriteIntentStatus` | 🟩 REUSE | `taskflow-core/src/resources/journal.ts` | execution-authority 层账本（与 ControlStore 账本并存，后者引用前者证据） |
| `HostProbeClassification / HostSupportCell` | 🟩 REUSE | `taskflow-core/src/resources/baseline.ts` | EnforcementCapabilities.processIsolation 证据面（P8） |
| `BoundCapabilityLifetimeSchema` | 🟩 REUSE | `taskflow-core/src/resources/schema.ts` | capability 绑定生命周期（phase/run/external） |
| `canonical-hash.ts`（sha256 库） | 🟩 REUSE | `taskflow-core/src/flowir/canonical-hash.ts` | 唯一哈希库（P6） |

### 3.2 ControlDomain / ControlStore 层

| Type | 标记 | 决策出处 | 说明 |
|------|------|----------|------|
| `ControlDomainId` / `projectId` | 🟥 NEW | P3 | UUID 标量约定；1:1 domain↔project ledger |
| `ControlStoreHeader { projectId, controlDomainId, schemaVersion, directoryBinding }` | 🟥 NEW | P3/P14 | 权威身份来源；registry 重建依据 |
| `ControlRegistryEntry { projectId, controlDomainId, storePath, directoryBinding, mountState, summary? }` | 🟥 NEW | P3 | 非权威发现/投影 |
| `ControlStoreStatus` | 🟥 NEW | P14 | store 健康/恢复状态（正常/恢复中/fail-closed） |
| `BootstrapManifest { controlBinaryPath, controlHome, singletonEndpoint, fencingEpoch }` | 🟥 NEW | P13 | 安装/启动契约 |

### 3.3 命令与事件（权威叙事）

| Type | 标记 | 决策出处 | 说明 |
|------|------|----------|------|
| `CommandRecord` | 🟥 NEW | P12 | 不可变权威记录；`(controlDomainId, commandId)` 唯一；与 events 同批原子提交 |
| `ControlEvent`（envelope: eventId, schemaVersion, controlDomainId, streamId, streamSeq, commitSeq, commandId?, commandEventIndex?, causationId, correlationId, projectId, recordedAt, payload） | 🟥 NEW | P12 | 账本事件信封；commitSeq 永不重编号 |
| `CompactionCheckpointEvent { throughCommitSeq }` | 🟥 NEW | P11 | cursor floor 唯一权威形态（journal 内事件） |
| `CursorState { minAvailableCommitSeq, cursorId, leaseExpiresAt }` | 🟥 NEW | P11 | 游标/订阅 |

### 3.4 计划与运行

| Type | 标记 | 决策出处 | 说明 |
|------|------|----------|------|
| `BoundPlan`（template: bindings, SpawnTemplate, savedFlowPins, grantRefs, claims, enforcementCapabilities, dynamicPolicy, boundPlanHash） | 🟥 NEW | P1/P7/P8 | 不可变模板；evidence-not-bearer |
| `BoundFragment`（双 hash + parent 链 + sourceEventId/sourceCommitSeq + fragmentIRHash/fragmentPolicyHash/capabilitySetHash/authorityEpoch） | 🟥 NEW | P7 | 动态 IR 产物 |
| `SpawnTemplate`（allowedAgentClasses, allowedProviderClasses, tool/effect ceilings, maxChildren, maxDepth, budgetShare） | 🟥 NEW | P7 | 动态展开天花板 |
| `RunStatus`（running\|completed\|failed\|paused\|blocked\|cancelled\|unknown） | 🟥 NEW | P5 | StringEnum；unknown 非终态 |
| `RunStage`（received\|compiled\|linked\|queued\|admitted\|executing\|parked\|reconciling\|terminal） | 🟥 NEW | P5 | 正交于 RunStatus |
| `RunSnapshot`（RunStatus + RunStage + slot 状态 + needs-operator 标志 + projectAdmitCommitSeq?） | 🟥 NEW | P5/P16 | wait/status RPC 正常返回形态 |

### 3.5 审批

| Type | 标记 | 决策出处 | 说明 |
|------|------|----------|------|
| `ApprovalRequest`（approvalRequestId, runId, nodeInstanceId, boundPlanHash\|boundFragmentHash, expectedRunVersion, allowedDecisions, owner/audience, deadline, timeoutPolicy, status 含 expired, decisionCommandId?, editArtifactRef?） | 🟥 NEW | P15 | 0.2.4 形态的协议升级 |
| `ApprovalDecisionCommand`（= CommandRecord.kind: "approval.decide" + decision + expectedRunVersion CAS） | 🟥 NEW | P15 | 决策=命令；CAS first-commit-wins |
| `ApprovalMode`（compat-auto-reject \| durable-optional \| durable-required） | 🟥 NEW | P15 | D34 |

### 3.6 并发协调（UserCoordinatorStore）

| Type | 标记 | 决策出处 | 说明 |
|------|------|----------|------|
| `CoordinatorLease { holderId, fencingEpoch, endpoint, expiresAt }` | 🟥 NEW | P16 | singleton 租约 |
| `ConcurrencyReservation`（reservationId, state 含 orphan-suspect, slots=1, projectId/projectControlDomainId/runId, projectAdmitCommitSeq, attemptId?, providerJobHandle?, coordinatorEpoch, reservedExpiresAt?, renewedAt?） | 🟥 NEW | P16 | 全局容量；committed 永不 TTL 释放 |
| `CoordinatorCommandRecord`（commandId, requestHash, callerPrincipal, kind: setMaxActiveRuns\|forceRelease, firstCommitSeq, lastCommitSeq, status） | 🟥 NEW | P16 | 窄命令权威 |
| `CapacitySnapshot { maxActiveRuns, active, reserved, committed, orphanSuspect }` | 🟥 NEW | P16 | 计量/统计 |

### 3.7 策略与执行能力

| Type | 标记 | 决策出处 | 说明 |
|------|------|----------|------|
| `PolicyBundle { hostCeiling, userCeiling?, projectCeiling?, invocationCeiling? }` | 🟥 NEW | P1/P2 | 空策略=显式继承+fail-closed 兜底；authorizationContextHash 记录决策 |
| `EnforcementCapabilities { resolution, mutationMediation, processIsolation, revocation }` | 🟥 NEW | P8 | 正交四维；取值绑定 TE 证据面（host probe / resources/*） |
| `CapabilitySetHash / policyHash` | 🟥 NEW | P7 | BoundFragment 携带 |

### 3.8 证据与结果

| Type | 标记 | 决策出处 | 说明 |
|------|------|----------|------|
| `ArtifactRef { digest, size, mediaType, storageClass, redactionClass }` | 🟥 NEW | P6 | digest 非 bearer；ledger-reachability 授权 |
| `Receipt`（controlDomainId, runId, boundPlanHash\|boundFragmentHash, eventManifest[]\|hash-chain root, startCommitSeq, endCommitSeq, artifactRefs[], assurance, buildInfo） | 🟥 NEW | P11/P14 | 一次性、不可变；compaction 后仍有效 |
| `ReceiptAssurance { journalContinuity, providerOutcome, artifactIntegrity, provenance, enforcement }` | 🟥 NEW | P8/P11 | enforcement promise vs observation（observedRevocationLatencyMs 可选） |

### 3.9 传输与错误

| Type | 标记 | 决策出处 | 说明 |
|------|------|----------|------|
| `NegotiationHandshake`（protocolMajor, supportedReadSchemas[], supportedWriteSchemas[], requiredFeatures[], offeredFeatures[], buildInfo） | 🟥 NEW | P4 | 握手 |
| `ErrorEnvelope`（code, message, recoveryAction, sideEffects, commandId?, commitSeq?, controlDomainId?, projectId?） | 🟥 NEW | P4 | 统一错误；TF_* code 全集见 P4 |
| `ExecutionProvider` DTO 组（probe/prepare/submit/watch/poll/cancel/collect/reconcile 的 discriminated unions: accepted\|rejected\|ambiguous） | 🟥 NEW | RFC §16 | 0.3-C 唯一实现 = TE resources/* 执行面 |

## 4. 复用 vs 新增 vs 修改汇总

| 类别 | 数量 | 内容 |
|------|------|------|
| 🟩 复用 TE（不动） | 11 | PathRef / EffectIR / SecretRef / ServiceRef / labels / ExecutionOwner / ScopedContentEvidence / WriteIntentRecord / HostProbe / BoundCapabilityLifetime / canonical-hash |
| 🟨 修改 TE | 0 | 本 freeze **不改任何 TE schema**（TE 是执行权威层，0.3-C 只引用其证据；新增 wire 全部落在 0.3-C 新包） |
| 🟥 新增（0.3-C） | ~33 | 见 §3.2–§3.9 |

## 5. 冻结规则

1. **P1–P16 全部 required**（RFC §22.5）；本清单的每行必须能在对应 P-ADR 找到出处（出处列已标）。
2. **无 optional holes**：wire 必填字段不得用 `Type.Optional` 规避；`BoundPlan.enforcementCapabilities`、`ConcurrencyReservation.slots`、`CommandRecord.requestHash` 等为必填。
3. **D21 兼容**：0.2.4 公共表面 golden 不变（P5）；`ApprovalRequest` 从 0.2.4 最小形态升级为 P15 协议——升级路径显式，不静默降级。
4. **扩展策略**：冻结后只允许 **additive** 变更（新字段 + schemaVersion bump）；旧 reader 见未知 schema → `TF_SCHEMA_UNSUPPORTED`（P4），绝不静默重解析。
5. **哈希纪律**：仅 sha256（P6）；`executionSemanticHash` 不含 authority epoch。
6. **位置**：TE schema 留在 `taskflow-core`；0.3-C wire types 落在 S2 新建的 `taskflow-control` 包（RFC §21 包结构），import TE schema 为只读依赖。
7. **Trusted-local-disk 限制**：P14 信任边界（整根一致回滚排除）进入 release notes 与 operator 文档，不随 wire 冻结悄悄扩大承诺。

## 6. 批准动作

- [ ] P1–P16 ADR 评审通过（13 Accepted + 3 Proposed: P8/P14/P15 重写版）
- [ ] 本清单与 P-ADR 出处核对无遗漏、无额外类型
- [x] S2 落地 `taskflow-control` 包时回填每个类型的实际文件路径，并保持本文件同步（见 §7）

## 7. S2 落地回填（文件引用）

> `packages/taskflow-control/`（RFC §21 包结构）。TE schema 只读导入；`resources/*`
> 因 workspace-capability 冻结不导出（`smoke-packed-packages.mjs` 断言
> `taskflow-core/resources/index` 不可解析），故镜像于 `src/schema/te-mirrors.ts`，
> TE 仍为权威。

### 7.1 🟩 REUSE — TE 只读依赖 / 镜像

| Type | 落地 | 说明 |
|------|------|------|
| `PathRefSchema`（literalPath/argPath/segments + PathIntent） | `src/schema/te-mirrors.ts` | 镜像（TE `resources/schema.ts` 不导出） |
| `EffectDeclSchema` / EffectIR | `taskflow-core/effects/schema` → `src/schema/index.ts` re-export | 只读导入 |
| `SecretRef { secretId, issuer? }` | `taskflow-core/effects/types`（类型） | 只读导入 |
| `ServiceRef { serviceId, operation? }` | `taskflow-core/effects/types`（类型） | 只读导入 |
| `ConfidentialityLabel / IntegrityLabel` | `taskflow-core/effects/types`（类型） | Receipt.assurance.provenance |
| `ExecutionOwner { runId, phaseId, attemptId, unitId, ancestry }` | `src/schema/te-mirrors.ts` | 镜像 |
| `ScopedContentEvidence` | `src/schema/te-mirrors.ts` | 镜像 |
| `WriteIntentRecord / WriteIntentStatus` | `src/schema/te-mirrors.ts` | 镜像 |
| `HostProbeClassification` | `src/schema/te-mirrors.ts` | EnforcementCapabilities 证据面 |
| `BoundCapabilityLifetimeSchema` | `src/schema/te-mirrors.ts` | 镜像 |
| canonical-hash（sha256 库） | `taskflow-core/flowir/canonical-hash` → `src/schema/index.ts` re-export | 只读导入（P6） |

### 7.2 🟥 NEW — wire types（全部在 `packages/taskflow-control/src/schema/`）

| 类别 | 文件 |
|------|------|
| `ControlDomainId`/`projectId`、`ControlStoreHeader`、`ControlRegistryEntry`、`ControlStoreStatus`、`BootstrapManifest` | `header.ts` |
| `CommandRecord`、`ControlEvent`（envelope + payload union）、`CompactionCheckpointEvent`、`CursorState` | `commands.ts` |
| `BoundPlan`、`BoundFragment`、`SpawnTemplate` | `plan.ts` |
| `RunStatus`、`RunStage`、`RunSnapshot` | `run.ts` |
| `ApprovalRequest`、`ApprovalDecisionCommand`、`ApprovalMode` | `approval.ts` |
| `CoordinatorLease`、`ConcurrencyReservation`（+ D2/D3 不变量）、`CoordinatorCommandRecord`、`CapacitySnapshot` | `coordinator.ts` |
| `PolicyBundle`、`EnforcementCapabilities` | `policy.ts` |
| `ArtifactRef`、`Receipt`、`ReceiptAssurance` | `evidence.ts` |
| `NegotiationHandshake`、`ErrorEnvelope` + TF_* 全集、ExecutionProvider DTO 组（accepted\|rejected\|ambiguous） | `transport.ts` |
| 公共标量：`CONTROL_WIRE_SCHEMA_VERSION`、UUID/SHA-256/CanonicalHashRef | `common.ts` |

### 7.3 ControlHost 实现

| 模块 | 文件 |
|------|------|
| controlMode 解析 + fail-closed 决策 | `src/modes.ts` |
| 用户 singleton lock/endpoint/fencing + stale 恢复 + 释放 | `src/singleton.ts` |
| hello-before-RPC 协商门 | `src/hello.ts` |
| TE 唯一执行权威适配（P8 能力映射） | `src/te-provider.ts` |
| ControlHost（auto/coordinated/standalone 契约 + dispatch） | `src/control-host.ts` |
| 统一错误信封（P4 全集 + ControlError） | `src/errors.ts` |

### 7.4 单元测试（`packages/taskflow-control/test/`）

`modes.test.ts`（模式选择/fail-closed）、`singleton.test.ts`（fencing/竞态/stale endpoint 恢复/释放）、`hello.test.ts`（hello-before-RPC）、`te-provider.test.ts`（TE 委托 + 仅 TE 权威）、`control-host.test.ts`（模式契约 + 集成）、`schema.test.ts`（closed contract + schemaVersion + 枚举）。
