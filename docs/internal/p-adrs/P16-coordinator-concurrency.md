# P16: UserCoordinatorStore concurrency + release

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.6
>
> **Implementation amendment:** [P16-1R versioned first-dispatch-owner
> saga](./P16-1R-versioned-first-dispatch-owner.md) is a proposed, mandatory
> design gate before any runtime adds automatic recovery across the
> SlotCommitted-to-first-dispatch boundary. It does not change this ADR's
> wire-freeze status, does not promote the GA matrix, and does not authorize a
> generic retry.
>
> **Integrity amendment (this worktree):** coordinator-local D1–D4 hardening
> below. Does **not** claim P16 GA closure. Host-side D37 ownership binding
> remains a sibling lane.

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

## Integrity hardening (D1–D4)

### D1 — Clock authority
TTL decisions (`reserve` expiry, `commitReservation` elapsed check, `reclaimExpiredReserved`) use a **store-owned wall clock** only.

- `openUserCoordinatorStore` always uses wall time and **refuses** a `clock` option. There is **no** injectable-clock construction on the public package barrel (no `openUserCoordinatorStoreForTests` / `CoordinatorClock` export).
- `commitReservation` has no third-argument `opts.now`. An elapsed reserved lease (including one whose `reservedExpiresAt` has been observed past wall time) cannot be resurrected by a caller timestamp.
- `reclaimExpiredReserved(now?)` retains the optional parameter for signature compatibility, but a caller timestamp is **never** TTL authority: only the store wall clock decides. A forged future `now` frees zero still-valid reserved slots. Invalid timestamps still fail closed (`TF_INVALID_ARGUMENT`).
- Tests simulate expiry by elapsing `reservedExpiresAt` on disk and calling the production reclaim/commit path with **no** caller timestamp — never by forging reclaim timestamps.

### D2 — Admission uniqueness
Under `state.lock`, `commitReservation` enforces uniqueness of
`(projectId, projectControlDomainId, runId)` among `committed` / `orphan-suspect` rows.

- Same reservation + same binding is idempotent.
- A second reservation claiming the same triple raises `CoordinatorAdmissionConflictError` (`TF_ADMISSION_BINDING_CONFLICT`).
- Durable load validation rejects duplicate logical admissions already on disk.

### D3 — Legacy residue migration
Pre-upgrade `expired` / `released` rows that still carry a residual `reservedExpiresAt` **must reopen**. That field is historical and non-occupying for those states.

- Legitimate legacy residue: open succeeds (released or expired with residual TTL field; project-bound released residual is allowed).
- Tampering: `committed`/`orphan-suspect` with residual `reservedExpiresAt`, or `expired` with `reservedExpiresAt > updatedAt`, fail closed (`TF_DURABILITY_FAILED`) and leave bytes intact.

(On this base, D3 already held for legitimate residue; tests lock both branches.)

### D4 — normalRelease idempotency
- Exact same-owner retry after a successful `normalRelease` returns the prior `released` record without churning `updatedAt`.
- Optional `ReleaseContext.ownership` (coordinator-local match against the durable binding): when supplied, mismatch is refused even if already released. Host-side mandatory ownership binding is **not** claimed here.
- Boolean-only callers (no `ownership`) remain supported and get the same idempotent retry.

### Mutations
All capacity mutations remain load → mutate → save under exclusive `state.lock` (cross-process safe).

## Status
Accepted for 0.3.0 wire freeze. Integrity amendment documents store-local D1–D4 behaviour; does not claim P16 or GA closure.
