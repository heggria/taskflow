# P15: Approval protocol

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
### Durability modes (D34)
| Mode | Behavior |
| compat-auto-reject (default) | Headless auto-reject → blocked |
| durable-optional | Prefer durable if negotiated; else auto-reject |
| durable-required | Link/Admit TF_FEATURE_REQUIRED if host cannot durable |

### Wire status
pending | approved | rejected | edited | **expired** | cancelled

Timeout → request `expired` only; Run → **blocked** (never permanent paused). Never default approve.

### Park (D38)
Durable pending + provider quiescent → RunStatus paused + RunStage **parked**; normalRelease slot; on approve → queued + re-reserve.

Approve is a control decision, not an execution outcome. The winning CAS commits `running/queued` with the re-reservation and hands off to the normal dispatcher/provider path. Approval alone must never write `completed/terminal` or issue a Receipt; those require proven provider outcome. Losing approval/cancel contenders do not dispatch or issue evidence.

### Exact continuation checkpoint

Parking a scheduler approval MUST persist a private continuation checkpoint before releasing capacity. The checkpoint is bound to exactly:

- the Run id and immutable `BoundPlanHash`;
- the unconsumed approval `nodeInstanceId`;
- every already-settled phase Attempt identity and terminal status;
- the bounded phase outputs required for downstream interpolation.

Only `completed` and `skipped` Attempts may be checkpointed. Phase ids are unique, every stored output belongs to a checkpointed Attempt, and the approval phase itself is not yet present. The checkpoint is a `secret` ControlStore artifact with role `approval-continuation`; its blob digest is verified on read. It MUST NOT be referenced by a Receipt, returned by browser artifact APIs, or interpreted by the browser.

Approving MUST reload the original content-addressed BoundPlan and exact checkpoint. The scheduler consumes exactly the named approval as a providerless completed Attempt, preserves prior Attempts and outputs, and starts only unsettled downstream phases. It MUST NOT submit the whole BoundPlan again or replay any pre-approval side effect. A later approval creates a new checkpoint and parks again; one decision consumes one boundary.

After the ApprovalRequest decision and coordinator reservation binding are durable, the approve CommandRecord may become `completed`: that status records the control decision, not the eventual Run outcome. The Run reaches `completed/terminal` and receives a Receipt only after the resumed scheduler/provider path proves completion. Providerless approval Attempts are valid provenance; all provider-executed Attempts still require their provider evidence.

If the ApprovalRequest, BoundPlan, artifact metadata/blob, checkpoint identity, reservation binding, or dispatcher handoff cannot be proven, approve fails closed: the command remains `accepted` when settlement was not proven, the Run becomes `unknown/reconciling + needsOperator`, the reservation becomes orphan-suspect, `TF_RECONCILE_REQUIRED` is returned, and no Receipt is issued.

### Crash recovery of the approve handoff

`running/queued` plus the exact approval request, private checkpoint, original BoundPlan, approve CommandRecord and re-reservation is a durable dispatcher handoff. Before taskflowd exposes UDS or WebGateway, it MUST inspect every such handoff and recover the saga from any of these committed prefixes:

1. project approve/CAS committed, coordinator reservation still `reserved`;
2. coordinator binding committed, ApprovalRequest still `pending`;
3. ApprovalRequest is `approved`, approve CommandRecord still `accepted`;
4. approve CommandRecord and `ApprovalDispatchAccepted` are durable, dispatcher has not begun.

Recovery commits only the missing suffix, revalidates all identities after mutation, and dispatches the exact checkpoint once. It never creates a new command, reservation, plan, checkpoint or attempt prefix. The queued → executing CAS is the single dispatch claim, so repeated startup recovery is idempotent.

Once `running/executing` is durable, a process loss may have occurred before or after provider submission. Without a provider-specific idempotent/reconstructable submit checkpoint, startup MUST NOT replay that work. It moves the Run to `unknown/reconciling + needsOperator`, preserves capacity as orphan-suspect when committed, and issues no Receipt. This conservative boundary is distinct from recovering the pre-dispatch `running/queued` saga.

`edit` remains a separate capability gate. It requires a content-addressed edit artifact, schema and re-Link validation, a durably persisted edited BoundPlan, and the same exact dispatcher handoff; plain approve continuation does not satisfy that gate.

### Implementation evidence boundary

The beta.2 working tree implements and locally tests restart-safe approve continuation, all four pre-dispatch crash prefixes above, post-dispatch ambiguity fail-closed behavior, repeated-recovery idempotency, multiple sequential approvals, pre-approval non-replay, corrupt-checkpoint fail-closed behavior, HTTP command dispatch, and packaged browser approve → downstream execution → Receipt. This is implementation evidence for the accepted target; it does not by itself declare P17 Conforming, wire-frozen, or GA.

## Status
Accepted for 0.3.0 wire freeze.
