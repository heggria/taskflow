# P15: Approval protocol

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.6

## Decision
### Durability modes (D34)
| Mode | Behavior |
| compat-auto-reject (default) | Headless auto-reject → blocked |
| durable-optional | Prefer durable if negotiated; else auto-reject |
| durable-required | Link/Admit TF_FEATURE_REQUIRED if host cannot durable |

### Wire status
pending | approved | rejected | edited | **expired** | cancelled

Timeout → request `expired` only; Run → **blocked** (never permanent paused). Never default approve.

### Park (D38), historical V1 description — not safety implementation authorization
Durable pending + provider quiescent → RunStatus paused + RunStage **parked**;
normalRelease slot; on approve → queued + re-reserve.

### Proposed P16-1R schema-2/3 amendment — no current behavior change

[P16-1R versioned first-dispatch-owner saga](./P16-1R-versioned-first-dispatch-owner.md)
defines a proposed replacement for the V1 approval-resume implementation. Once
that ADR is independently accepted and implemented with project schema 2 /
coordinator schema 3, its §7 takes precedence over the preceding V1 sentence:
approval must first complete immutable P release intent → immutable C
parked-readmit release → exact P release observation, then create one
`ApprovalResumeAdmissionV2` child saga. The Run remains parked until that child
has a verified C commitment and first owner; it must not bare-queue, reuse a
parent reservation/owner/attempt, or project-admit before C commit.

This amendment is **Proposed**, not a retroactive acceptance of the shipped V1
path. Until P16-1R and P16-2 capability-bound release exist, a durable-approval
implementation must fail closed before it changes parked state; the V1 sentence
does not authorize the observed bare reserve → project-admit → C-commit path.
The GA matrix status remains FAIL.

## Status
Accepted for 0.3.0 wire freeze.
