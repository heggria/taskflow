# P16: UserCoordinatorStore concurrency + release

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.6

## Decision
### Capacity (D30)
`count(state ∈ {reserved, committed, orphan-suspect}) ≤ maxActiveRuns`
slots ≡ **1** per admitted Run (not weighted).

### Lifecycle
reserve (TTL OK) → Admit + projectAdmitCommitSeq → **committed** (no TTL) → dispatch/park/reconciling → **D37** normalRelease | forceRelease

### D37
normalRelease = noLiveOrAmbiguousSideEffects ∧ (terminal ∨ parked-readmit)
forceRelease = CoordinatorCommandRecord + explicit risk ack → operator-overridden

### Forbidden
TTL-only committed release; fake terminal after reconcile timeout; CLI mutating reservations without CoordinatorCommandRecord.

### Crash matrix (minimum)
| Crash window | Reservation | Run |
| after reserve before admit | TTL expire → expired | none |
| after commit before provider ack | committed | unknown/reconciling |
| reconcile exhausted | orphan-suspect | unknown + needs-operator |
| after terminal + normalRelease | released | terminal + Receipt |

## Status
Accepted for 0.3.0 wire freeze.
