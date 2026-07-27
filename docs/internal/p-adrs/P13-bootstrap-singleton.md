# P13: Bootstrap / fresh-install / singleton lock / platforms

> Status: **PARTIAL — exclusive-lock reclaim hardened; not wire-freeze or GA approval**
>
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.6

## Decision

### `controlMode`

| Mode | Behavior |
|---|---|
| `auto` (default) | Ensure registry + project store; start/attach user singleton multi-mount; fail closed |
| `coordinated` | External control required; fail closed if down |
| `standalone` | **Explicit only**; in-process ControlHost; same project store |

Silent `auto → standalone` is forbidden.

### Singleton (D32)

Embedded multi-mount competes for the **same** user lock + endpoint as
`taskflowd`. Losers attach and must not fork independent multi-mount authority.

Owner publication uses hard-link create (never rename-overwrite). Malformed
singleton metadata is fail-closed. Dead-PID automatic takeover of the singleton
**file** remains fail-closed on this base: POSIX/Node offer no compare-and-unlink
that binds the observed owner inode to a later unlink without an additional
OS-backed holder protocol. A fenced old writer cannot release a replacement
owner (process-held mutation capability + authority lock).

### Exclusive lock reclaim (paths.ts)

Cooperative contenders use identity-bound reclaim for directory locks:

1. Fixed claim file `${lock}.reclaim-claim` with `O_CREAT|O_EXCL` carrying the
   observed `{dev,ino,token,hasOwner,pid,at}`.
2. Peers wait while a non-orphaned claim is present; after exclusive `mkdir`
   they re-check the claim and yield if reclaim appeared (free-path race).
3. Reclaimer renames the observed generation to a private discard path, verifies
   identity, publishes a successor under the claim fence, then clears the claim.
   A mismatched generation is **restored**, never `destroyTree`'d.
4. Claim cleanup is recoverable (D3): dead claimant PID removes the claim only;
   a live claimant whose observed generation is gone after a short orphan grace
   also drops the claim so successors are not fenced unboundedly. Intentional
   claim unlink failures surface as `ControlStoreDurabilityError` (not swallowed).
   After a successful publish (`mkdir`+owner), claim-cleanup failure **must not**
   strand a live-PID owner: abandon the published generation (identity-bound)
   before rethrowing so the outcome is always “caller holds a releasable lock”
   or “publish is not left standing”.
5. Release is compare-and-delete on acquire-time device/inode + owner token via
   rename-to-discard; a successor generation survives a deposed finally.

Progress waits are generation/claim-aware (`Atomics.wait`) and **do not** burn
`maxAttempts`. Each free-path / reclaim / contended observe is one acquire pass;
`maxAttempts` is a hard pass budget (not `maxAttempts×K` spins), so N sequential
critical sections complete under a tight attempt budget without dual holders.

### Platforms

- **Unix UDS** required for 0.3 GA.
- **Windows named pipe**: non-GA in 0.3; release notes must say so. Lock-file
  coordination still applies.

### Layout

- User: `~/.taskflow/control/` (overridable via `TASKFLOW_HOME`)
- Project: `<root>/.taskflow/control/`

## Evidence

- `p13-reclaim-safety-liveness.test.ts` + `helpers/mp-p13-exclusive-lock.mts` —
  16-contender stale steal and incomplete abandon: **every contender enters**
  and **peak concurrent holders = 1** (D1 safety + D2 liveness together),
  including under a tight binding `maxAttempts` budget (plus a unit probe that
  `maxAttempts=N` caps reclaim claim-creates at ≤N+1, not N×32); post-publish
  claim-unlink failure does not strand a live-PID owner (D3); orphaned live-PID
  reclaim-claim recovery (D3); production-path TOCTOU successor restore (D4);
  L1 release fencing for exclusive locks.
- `stale-lock.test.ts` — dead exclusive-lock reclaim; live-owner refuse;
  singleton dead-PID still fail-closed; fencing/authority capability proofs.
- `paths-hardening.test.ts` — identity-bound release leaves mid-flight successor
  intact; durability fail-closed paths for atomic write / directory fsync.

## Remaining non-GA work (P13 stays open)

- Same-UID non-cooperative adversary (raw `rm -rf` / foreign `mkdir` bypassing
  the claim protocol) remains an OS/credentials lower bound.
- Singleton dead-PID automatic takeover is still fail-closed; needs an audited
  OS-backed holder-identity / compare-and-replace protocol before enablement.
- A full 32-process × 100-round stale-takeover proof is still absent.
- Windows transport remains non-GA.

Therefore P13 is **not** evidence for 0.3.0 wire freeze, closed-loop GA,
tagging, or publication.
