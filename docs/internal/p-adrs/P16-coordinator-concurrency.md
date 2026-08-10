# P16: UserCoordinatorStore concurrency + release

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
### Capacity (D30)
`count(state ∈ {reserved, committed, orphan-suspect}) ≤ maxActiveRuns`
slots ≡ **1** per admitted Run (not weighted).

`setMaxActiveRuns({value, expectedMaxActiveRuns, expectedCoordinatorEpoch}, command)` runs under the coordinator mutation lock. The store derives `requestHash` from that typed request itself, then checks command idempotency, expected maximum, fencing epoch, and occupancy under the same lock. After reclaiming only expired `reserved` records, a requested value below the current occupying count is rejected with `TF_CAPACITY_EXCEEDED`; the previous maximum remains authoritative and no completed CoordinatorCommandRecord is written. There is no `desired` value that can temporarily violate the invariant.

Read migration of a legacy-invalid file raises the effective maximum to its already occupying count; it never deletes or releases work to make the number fit.

### Lifecycle
reserve (TTL OK) → Admit + projectAdmitCommitSeq → **committed** (no TTL) → dispatch/park/reconciling → **D37** normalRelease | forceRelease

### D37
normalRelease = noLiveOrAmbiguousSideEffects ∧ (terminal ∨ parked-readmit)
forceRelease = CoordinatorCommandRecord + explicit risk ack + full observed-state CAS → operator-overridden

Every reservation carries a monotonic `revision`. Force-release requires and atomically compares:

- `reservationId`;
- expected `committed | orphan-suspect` state and revision;
- expected coordinator fencing epoch;
- bound `projectId`, `controlDomainId`, and `runId`;
- the exact acknowledgement `I understand this may allow overlapping live side effects`.

P16 owns this acknowledgement and the force-release CAS semantics. P17 reuses them byte-for-byte; it does not redefine either.

Any mismatch returns stale/conflict and leaves the slot untouched. Same `commandId + requestHash + principal` returns the prior CoordinatorCommandRecord without applying release twice; a different hash or principal fails according to P12. Coordinator methods never hash a caller-supplied shadow `requestBody`.

### Forbidden
TTL-only committed release; lowering `maxActiveRuns` below occupancy; force-release without complete CAS; fake terminal after reconcile timeout; CLI/Web mutating reservations without CoordinatorCommandRecord.

### Crash matrix (minimum)
| Crash window | Reservation | Run |
| after reserve before admit | TTL expire → expired | none |
| after commit before provider ack | committed | unknown/reconciling |
| reconcile exhausted | orphan-suspect | unknown + needs-operator |
| after terminal + normalRelease | released | terminal + Receipt |

## Status
Accepted for 0.3.0 wire freeze.
