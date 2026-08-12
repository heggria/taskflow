# P16: UserCoordinatorStore concurrency + release

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §4.3.2](../rfc-0.3.0-control-plane-v7.6.md)（D30/D36/D37）
> TE 基底: `resources/types.ts` ExecutionOwner（runId/phaseId/attemptId/unitId/ancestry）→ 预留绑定身份；`resources/leases.ts` 持久租约协调器 = 跨进程互斥先例。
> 说明: archive P16 含 D1–D4 store-local 硬化 + P16-1R 补充；0.3-C 冻结 wire/契约（slots/capacity/release/crash matrix），D1–D4 硬化语义并入 S3 实施门，P16-1R saga 留待 S4 重新推导。

## Decision

### 容量（D30）

```text
count(reservations where state ∈ {reserved, committed, orphan-suspect}) ≤ maxActiveRuns
```

- `slots ≡ 1` 每个 admitted Run（**不加权**；未来加权需要单独 `admissionWeight` ADR，不在 0.3）。
- 计量: `maxActiveRuns` = 并发 **admitted Runs**；`flow.concurrency` = 单个 Run 内并发 subagents——**不混用**。
- 0.3 全局预算: **statistics only**。

### 生命周期

```text
reserve (reserved, TTL OK)
  → Run Admitted + projectAdmitCommitSeq
  → committed (no TTL release)
  → dispatch / park / reconciling …
  → normalRelease | forceRelease
```

### Release predicates（D37 — product pin）

```text
noLiveOrAmbiguousSideEffects =
  provider/isolation 证明无活进程树
  AND 无该 run 的开放模糊 provider job
  AND (若 unknown/reconciling: 不是"仅 auto-reconcile 超时")

normalRelease =
  noLiveOrAmbiguousSideEffects
  AND ( runIsTerminal (completed|failed|blocked|cancelled)
        OR runIsParkedAndFutureDispatchRequiresReadmission )   // 如 durable approval pause + provider quiescent

forceRelease =
  authorizedOperatorCommand (CoordinatorCommandRecord)
  AND explicitRiskAcknowledgement
  → concurrency guarantee 标记 operator-overridden
```

| State | TTL auto-reclaim? | 备注 |
|-------|-------------------|------|
| **reserved** | Yes | pre-admit |
| **committed** | **Never by TTL** | **仅 D37** normalRelease / forceRelease |
| **orphan-suspect** | holds capacity | crash / reconcile 自动化耗尽；仍计入容量公式 |

### 禁止（forbidden）

- TTL-only committed release；reconcile 超时后 fake terminal；弱化 D37 的简写（status 字段单独不足以释放）；CLI 无 CoordinatorCommandRecord 直接改 reservation。

### Crash matrix（minimum，wire 冻结）

| Crash window | Reservation | Run |
|-------------|-------------|-----|
| reserve 后、admit 前 | TTL 过期 → expired | none |
| commit 后、provider ack 前 | committed | unknown/reconciling |
| reconcile 耗尽 | orphan-suspect | unknown + needs-operator |
| terminal + normalRelease 后 | released | terminal + Receipt |

### UserCoordinatorStore（scoped authority — 非项目总账本）

```text
UserCoordinatorStore (user-private)
├── CoordinatorLease { holderId, fencingEpoch, endpoint, expiresAt }
├── maxActiveRuns
├── CoordinatorCommandRecord {   # 窄命令权威（D6）
│     commandId, requestHash, callerPrincipal,
│     kind: setMaxActiveRuns | forceRelease | …
│     firstCommitSeq, lastCommitSeq, status
│   }
├── ConcurrencyReservation {
│     reservationId
│     state: reserved | committed | released | expired | orphan-suspect
│     slots: 1
│     # state ∈ {committed, orphan-suspect} 时必填:
│     projectId, projectControlDomainId, runId
│     projectAdmitCommitSeq
│     attemptId?, providerJobHandle?
│     coordinatorEpoch
│     reservedExpiresAt?       # 仅 reserved 期间
│     renewedAt?
│   }
└── (无项目 Run 历史 / 项目 Receipts)
```

### Store-local 硬化语义（并入 S3 实施门，wire 冻结）

- **D1 Clock authority**: TTL 决策只用 store 拥有的 wall clock；无可注入时钟构造。
- **D2 Admission uniqueness**: `(projectId, projectControlDomainId, runId)` 在 committed/orphan-suspect 行唯一；重复 → `TF_ADMISSION_BINDING_CONFLICT`。
- **D3 Legacy residue**: 旧 expired/released 行残留 `reservedExpiresAt` 必须能重开；committed/orphan-suspect 带残留 TTL 字段 → fail closed。
- **D4 normalRelease idempotency**: 同 owner 重试返回先前 released 记录，不 churn updatedAt。

### 实施门（S3，非 wire-freeze 门）

- 32 进程竞争、N+1 竞争、fencing、release 竞态、orphan-suspect 保持容量、CoordinatorCommandRecord 审计链。
- P15×P16 联合测试（approval park → release slot → approve → re-reserve）。

## Wire impact (TypeBox)

- `CoordinatorLeaseSchema`、`ConcurrencyReservationSchema`、`CoordinatorCommandRecordSchema`、`CapacitySnapshot { maxActiveRuns, active, reserved, committed, orphanSuspect }` 新增。
- 错误码 `TF_ADMISSION_BINDING_CONFLICT`、`TF_CAPACITY_EXCEEDED` 入 P4 信封。

## Status

Accepted for 0.3-C wire freeze。P16-1R（版本化 first-dispatch-owner saga）不在本 wire 冻结内；S4 运行控制阶段重新推导。
