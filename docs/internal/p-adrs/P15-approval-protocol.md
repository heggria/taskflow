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

### Park (D38)
Durable pending + provider quiescent → RunStatus paused + RunStage **parked**; normalRelease slot; on approve → queued + re-reserve.

## Status
Accepted for 0.3.0 wire freeze.
