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

---

## B06 host notes (0.3.0 control-plane gap closure — open, not GA)

These notes document host-owned safety work that does **not** close P15 GA.
Approve / edit continuation remain out of scope; P15 stays open.

### Durable reservation-release outbox (host-local)

When ControlHost parks (or terminalizes) a Run and must free a coordinator
slot, it:

1. Journals a durable `ReservationReleaseIntent` in the host-local outbox
   (`<project>/.taskflow/control/release-outbox/`) **before** calling
   `Coordinator.normalRelease`
2. Applies release only through evidence-bound `releaseReservationWithProof`
3. Acknowledges the intent after Coordinator reports released
4. On host open / `reconcileReservationReleases()`, drains pending intents

A crash between intent write and Coordinator release therefore recovers
capacity on reopen without force-release. A Coordinator release error
surfaces `TF_RECONCILE_REQUIRED` and retains the pending intent — it must
never claim quiet success.

Generic cancel on this base remains **non-terminal** (C7 containment): it
does not journal `status=cancelled` / release capacity from a bare provider
`cancelled` enum. That cancel-terminal premise from earlier lanes is
not-reproducing here.

### Pending dispatch settlement (activeAttempt)

The durable scheduler cursor `RunContinuation.activeAttempt` is this base's
pending-dispatch checkpoint. Settlement evidence requires:

1. A non-empty `providerHandle` on the attempt (or matching Run handle)
2. A mounted provider whose durable record owns that exact `run:phase` handle
3. `isLive(handle) === false` (or terminal `loadHandle` status)

When evidence holds, ControlHost clears `activeAttempt`. When evidence is
absent, the attempt remains and capacity stays fail-closed.

### Host LLM abort containment

`createHostLlmExecutionProvider` wires `AbortSignal` into `runTask`, and
`isLive` stays true until the in-flight promise settles — cancel must not
make the host look quiescent while side effects are still running.

### D37 release authority binding

Host-side normalRelease derives `noLiveOrAmbiguousSideEffects` from provider
evidence (including the crash-recovery parked-intent path). It never treats a
tautological echo of `getReservation` fields as ownership. Release is refused
when independent project/domain/run binding disagrees, provider side effects
are not proven quiescent, or the caller requests parked-readmit while
`stage !== "parked"` (capacity must not free on reconciling/unknown runs).

### Durable park release order (host-local outbox)

Park journals a durable `ReservationReleaseIntent` **before** the park CAS
detaches `reservationId`. Open-time `reconcileReservationReleases` also
reconstructs a pending intent when a parked Run has no outbox row but a
bound committed/orphan-suspect reservation still occupies capacity (wipe /
crash after detach). This does not close P15 GA.

### Raw standalone co-admit guard (factory-level, not GA)

`createControlHost({ controlMode: "standalone", skipSingleton: true })` (and
any other unfenced singleton bypass without a **process-held, WeakMap-minted**
`mutationCapability`) **refuses to open** when a live multi-mount holder still
**possesses** the project, or when a live user-singleton owner plus multi-mount
registry claim is present.

Multi-mount possession is **not** a plain rewritable JSON file. It is bound
**only** where an exclusive lock can be taken **synchronously before
`installMultiMountPossession` returns**:

1. an open file descriptor the holder keeps for the host lifetime
2. Darwin/BSD `O_EXLOCK` at open time (the open either holds the lock or
   throws — no post-return race)
3. device + inode identity of the lease so a replaced path is not mistaken for
   the holder's lease
4. kernel-managed liveness (process death releases the lock — cannot be forged
   by editing file contents)

#### Platform support (Resolution B — no Linux multi-mount claim in 0.3)

**0.3 does not claim Linux multi-mount support.** Platforms without
synchronous exclusive open (including Linux) **refuse to install** multi-mount
possession (`TF_BOOTSTRAP_FAILED`). A former `flock(1)` child helper was
removed: async spawn did not bind the lock before install returned (dual
multi-mount open race), and child exit was not monitored (parent kept the
multi-mount role after lock loss). Leaving a code path that *looks like* it
holds a lock on Linux while it does not is forbidden. Pure standalone /
non-multi-mount hosts remain available where multi-mount install is refused.
`multiMountPossessionSupportedOnPlatform()` encodes the matrix (true only for
`darwin` / `freebsd` / `openbsd`).

A `mutator-hold.json` sidecar may exist for operators but is **never**
authoritative. Rewriting user-level `singleton.lock` to a dead PID, wiping or
rewriting `mutator-hold.json`, setting `multiMount: false`, or spoofing a dead
`hold.pid` while the original multi-mount host remains open must still refuse
co-admit. A forged empty object is not a valid capability. Crash recovery
(kernel releases the lock / clean close) may reopen.

Legitimate unowned `skipSingleton` fixtures remain: no live multi-mount
possession, and no live singleton+registry claim on the project. Parent-
authorized embedded mounts (taskflowd with a real `mutationCapability`) still
open on platforms that support multi-mount possession. This does **not** claim
single-ledger GA, P15 closure, or 0.3.0 GA.

### Same-UID non-cooperative residual — co-admits (not fail-closed)

**Observed residual dual-writer path (documented; not claimed closed):** a
cooperating-but-hostile same-UID process applies **both** of:

1. **lease path absent** — unlink or rename of `mutator-hold.lease` (pathname
   gone) while the original holder still has its open FD + `O_EXLOCK` on the
   orphaned inode; and
2. **user singleton absent or dead** — `singleton.lock` unlinked, or its
   recorded PID not alive.

That set **co-admits** a second unfenced mutator (`RESIDUAL_COADMIT` in tests).
POSIX filesystems do not give Node a portable compare-and-unlink that binds the
observed inode to a later unlink of a replaced path, and with the singleton
also gone the secondary registry/owner guard no longer refuses. **Never
describe this residual set as fail-closed.**

**Not residual (still refuses):** lease-only unlink or rename while the user
singleton is **still live** (secondary singleton + multi-mount registry claim
still refuses). Content-edit and dead-PID spoof of rewritable metadata under a
live multi-mount holder still refuse. Silent double-write under cooperative
hosts is not accepted. Same class of same-UID non-cooperative bound P13 leaves
open for automatic stale singleton reclaim.

### Crash-recovery release: absent provider is not free capacity

Host-side crash-recovery parked release (`applyReleaseIntent`) derives
`noLiveOrAmbiguousSideEffects` from independent provider evidence. An unmounted
or missing provider for a durable `providerName` / `providerHandle` is
**absence of evidence**, not proof that no side effect is live. That path fails
closed with a reconcile-required pending outcome — it must never soft-hardcode
free capacity. Legitimate reopen with the durable provider mounted (and
`isLive === false`) may still free.
