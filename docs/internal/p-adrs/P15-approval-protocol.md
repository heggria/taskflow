# P15: Approval protocol（TE 基底重写）

> Status: **Proposed** (0.3-C wire-freeze gate — TE 基底重写，需随 wire freeze 批准)
> Normative parent: [RFC v7.6 §17](../rfc-0.3.0-control-plane-v7.6.md)（D34/D38）
> TE 基底: `schema.ts` PHASE_TYPES 已有 `"approval"` phase kind + `effects/validate.ts`（OutputContract 检查面）+ P12 CommandRecord 决策权威 + P14 journal 原子批。
> 重写说明: archive 草稿 = V1 wire + P16-1R schema-2/3 修正提议 + B06 host notes，状态复杂（V1 路径曾 FAIL）。0.3-C 重写为**单一 wire 协议**：决策=CommandRecord、CAS first-commit-wins、park 经 D37 normalRelease、readmission 在 S4 以 P15×P16 联合测试落地（不再引用 archive 的 schema-2/3 迁移叙事）。

## Decision

0.3 是 0.2.4 `ApprovalRequest`（`phaseId/message/upstream`）的**协议升级**。

### ApprovalRequest（wire）

```text
ApprovalRequest {
  approvalRequestId
  runId, nodeInstanceId
  boundPlanHash | boundFragmentHash
  expectedRunVersion
  allowedDecisions: approve | reject | edit
  owner / audience / requiredPrincipals?
  deadline, timeoutPolicy
  status: pending | approved | rejected | edited | expired | cancelled
  createdAt, decidedAt?
  decisionCommandId?     // 决策 = CommandRecord
  editArtifactRef?       // 当 edit
}
```

### 规则（normative minimum）

- 请求 `pending` 期间 RunStatus = **`paused`**。
- 决策是 **CommandRecord**（幂等；披露 live re-auth，P12）。
- **CancelRequested 先到** → 后续 ApprovalDecision CAS 失败；request → `cancelled`。
- **ApprovalDecision 先到** → 清除 pause；后续 CancelRequested 仍可取消 Run。
- 同 `expectedRunVersion` 竞态 → first commit wins（store 锁内 CAS）。
- **Timeout → ApprovalRequest `expired` only**；Run → **`blocked`**（永不永久 paused）。**永不默认 approve**。
- **edit output** → OutputContract 检查；**不** re-link。
- **edit plan** → 必须 re-Link。
- Decider principal/audience 见本 ADR wire 字段；重启 + 双客户端测试是 GA 要求。

### Durability modes（D34 — 不折叠 requires/allows）

| Mode | Link/Admit | Runtime |
|------|-----------|---------|
| **`compat-auto-reject`**（默认） | 无 durable inbox 也 OK | 立即 **blocked**（0.2.4 headless 兼容） |
| **`durable-optional`** | host/caller 缺 durable 也 OK | 优先 durable（若协商成功）；否则 auto-reject → blocked |
| **`durable-required`** | host 或 caller 无法 durable → **`TF_FEATURE_REQUIRED` at Link/Admit**（不是假 human reject） | `paused` + pending 直到 decide/timeout/cancel |

协商: flow mode + ControlHost offers + caller accepts。历史: auto-rejected 保持 blocked 除非 resume/re-run；pending 可被任何已授权 durable client 决定。

### Park vs maxActiveRuns（D38 — product pin）

| 情形 | Run-slot |
|------|----------|
| durable approval **pending** + provider **quiescent**（无活/模糊副作用） | **normalRelease**（park）；Run 保持 `paused` |
| Approval **approved** | Run → **`queued`**（或 re-admit 路径）；必须**重新 reserve** 才能继续执行 |
| Approval **rejected/expired** → `blocked` | 若 quiescent 释放（terminal park） |
| cancel-in-flight / `unknown` / 非 quiescent | **保持** committed 或 orphan-suspect slot |
| compat-auto-reject | 永不占长期 approval slot |

### Quiescence 判定（0.3-C 钉住）

- `noLiveOrAmbiguousSideEffects`（D37）= provider/isolation 证明无活进程树 ∧ 无该 run 的开放模糊 provider job ∧（若 unknown/reconciling: 不是"仅 auto-reconcile 超时"）。
- 0.3-C 的 ExecutionProvider 唯一实现是 TE resources/* 执行面：quiescence = TE 资源事务无未决 intent/permit + 无活 phase 进程 + journal 无 `dirty-unknown` 意图。
- park 释放前先持久化 release intent（archive B06 outbox 概念 → 0.3-C 采纳为 S4 的 reservation-release outbox: 先 journal `ReservationReleaseIntent` 再 `normalRelease`，evidence-bound，host 打开时 drain）。

### readmission（S4 落地，wire 冻结内容）

- approve → queued → re-reserve → re-admit 是一条**独立 saga**（P15 × P16 联合测试要求）；不得复用父 reservation/owner/attempt/key/provider handle/Receipt。
- 0.3-C 不采用 archive P16-1R 的 schema-2/3 迁移叙事；版本化 readmission 在 S4 从本 wire 契约重新推导。

## Wire impact (TypeBox)

- `ApprovalRequestSchema`（新增，字段见上）+ `ApprovalDecisionCommand`（= CommandRecord.kind: "approval.decide"，含 decision + expectedRunVersion CAS 字段）。
- 错误码 `TF_STALE_VERSION`（CAS 失败）入 P4 信封。

## Status

Proposed（重写）for 0.3-C wire freeze — wire 协议 = RFC §17 批准内容；TE quiescence 判定 + outbox + readmission 重定义为 0.3-C 版本。S4 联合测试未过前，park 路径保持 fail-closed。
