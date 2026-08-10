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

Implementation gate: until the dispatcher can durably reload the exact BoundPlan/BoundFragment and accept the re-admitted Run, `approve`/`edit` must keep their CommandRecord `accepted`, move the Run to `unknown/reconciling + needsOperator`, return `TF_RECONCILE_REQUIRED`, and issue no Receipt. This fail-closed state is truthful but is not GA completion of P15.

## Status
Accepted for 0.3.0 wire freeze.
