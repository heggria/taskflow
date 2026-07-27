# P14: ControlStore engine (files-only)

> Status: **Accepted files-only/local-disk trust model; coherent whole-root
> rollback is explicitly outside the 0.3.0 GA contract; remaining in-scope
> durability work is NOT PASS**
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.6

## Decision
0.3 GA engine is **files-only** (still a full engine):
- Atomic commit batch: temp + fsync + rename
- Journal segments under `journal/`
- Projections under `projections/`
- Commands under `commands/`
- Receipts under `receipts/`
- Header: projectId, controlDomainId, schemaVersion, directoryBinding
- commit-seq.json monotonic counter

**No node:sqlite** without a future ADR replacing this one.

## Recovery
Re-read journal segments; rebuild projections from events if projection missing.

## Trust boundary and non-goal of the current implementation

The current project-root anchor and journal hash chain detect several useful
local failures: loss of only `.taskflow/`, missing anchored segments, malformed
or recomputed-invalid entries, and mismatched local identities. They do **not**
provide rollback freshness when an actor can restore every locally consulted
artifact, including both `.taskflow/` and `.taskflow-control.anchor.json`, from
one older coherent snapshot.

That is not a missing hash comparison. Let `S_old` be a legitimate on-disk
state and let `S_new` be a later state. If an opener reads only files inside the
project root, a restorer can replace those files with exactly `S_old`. The
opener then observes identical bytes in the legitimate-old and restored-old
worlds, so no local-only algorithm can accept the first while reliably rejecting
the second. More local hashes, filenames, or timestamps do not change this
indistinguishability argument.

`store-recovery.test.ts` preserves this as a named P14 counterexample: after a
second durable event, it restores the earlier control tree plus root anchor and
proves that the current store reopens with the older internally valid history.
The test is a permanent negative-capability proof. It prevents a future release
from accidentally claiming anti-rollback protection that this model does not
provide.

## Frozen 0.3 scope decision (2026-07-27)

The product owner selected an explicitly narrowed **trusted-local-disk** model
for 0.3.0:

- the project root, `.taskflow/`, and `.taskflow-control.anchor.json` are
  assumed not to be restored together to one older coherent snapshot after an
  acknowledged operation;
- an actor, backup system, VM snapshot, filesystem administrator, or recovery
  tool that can coherently roll back every locally consulted byte is outside
  the 0.3.0 threat model;
- 0.3.0 makes no anti-rollback, external freshness, or rollback-detection
  promise for that excluded event;
- no external monotonic witness or externally authenticated repair service is
  required for the 0.3.0 GA gate;
- release notes and operator documentation must retain this limitation. A
  coherent whole-root restore may reopen an older internally valid history.

This exclusion is deliberately narrow. It does **not** exclude malformed or
torn files, missing individual roots/anchors/segments, journal or sequence
discontinuity, crash-at-write-boundary behavior, concurrent writers, stale
owners, fencing violations, symlink/path replacement inside the supported
filesystem assumptions, compaction/retention correctness, or recovery racing a
mutation. Those remain in-scope P13/P14/P16 GA requirements and must fail
closed where current truth cannot be established.

The exclusion also does not make P14 PASS by declaration. It removes only the
information-theoretically impossible local freshness requirement. P14 remains
FAIL until every other in-scope durability, recovery, compaction, filesystem,
and entrypoint requirement has current behavior evidence.

## Repair is not, by itself, a freshness root

An authenticated-looking repair record stored only under the project root is
not sufficient. The same whole-root restorer can replace that record with the
older coherent snapshot, so a later opener again cannot distinguish legitimate
old state from rollback. A signature only proves who signed the replayed bytes;
it does not prove that the bytes are current.

Therefore a future externally authenticated repair design is viable only when
the authorization decision is itself
bound to a factor the restorer cannot roll back together with the project root:
for example an OS/hardware monotonic counter, an enterprise identity/audit
service with an append-only checkpoint, or an equivalent independently
authenticated service. A local repair file must never be relabelled as
anti-rollback evidence.

At a minimum, a failed or unavailable trust check may permit a clearly labeled
forensic read/export path, but it must not allow a ControlStore mutation,
provider dispatch, capacity change, approval settlement, or Receipt issuance.
The implementation must not use an error-recovery fallback that silently
continues from local bytes.

The existing `identityPolicy: "new-identity"` and `"rebind"` controls are not
an anchor-loss repair mechanism. They remain explicit path/clone identity
policies only when the existing root anchor is present and matches the header.
If an existing header has no root anchor, normal, read-only, rebind, and
new-identity opens fail closed until a separately approved migration protocol
exists; otherwise a caller could turn deleted identity evidence into an
implicit, unaudited migration.

## 0.3 decision record

| Field | Frozen 0.3 decision |
|---|---|
| Selected model | Files-only, trusted-local-disk scope; coherent rollback of all local authority bytes is excluded |
| Trust authority | The current local filesystem and process authority inside the supported OS/filesystem contract; no external freshness authority |
| Protected tuple | Local integrity binds `(projectId, controlDomainId, commitSeq, tailSegmentHash)` and related journal/sequence records; it does not prove freshness after an excluded coherent restore |
| Fresh install and clone/worktree policy | Existing anchor/header rules remain mandatory; clone/rebind must be explicit and may not mint over partial existing authority |
| Availability policy | No external service dependency; local corruption or ambiguous partial loss fails closed with stable `TF_*` recovery guidance |
| Repair/rebind authorization | No automatic whole-root rollback repair exists in 0.3; local `rebind`/`new-identity` remain path/clone policies, not freshness recovery |
| Key lifecycle | N/A for 0.3 because no external key or witness is introduced |
| Privacy and retention | No ControlStore identity/checkpoint leaves the project root solely for P14 freshness |
| Rollback/recovery semantics | Coherent rollback of every local authority byte is outside contract and may reopen old history; all partial/incoherent rollback and corruption cases remain in scope |
| Owner and evidence | Product owner scope decision, 2026-07-27; permanent whole-root counterexample retained; independent release review must verify wording and remaining in-scope evidence |

## Future anti-rollback upgrade contract

If a later version adds anti-rollback protection, its design must define a
durable protocol, not just a new JSON file.
Before any mutation or external side effect, the execution path must check the
authoritative tuple and obtain a compare-and-advance or equivalent monotonic
authorization. Local copies of the last-seen tuple are advisory integrity data,
not the authority. A successful local journal append must not be reported as a
successful durable execution until the selected authority has accepted the
matching next checkpoint.

The future implementation and independent review must prove each of these
cases on the real open/mutate/reopen paths:

| Case | Required result |
|---|---|
| Restore whole project root plus matching old anchor | Detect mismatch or require externally authenticated repair; no mutation, dispatch, or Receipt |
| Authority unavailable, stale, revoked, or wrong project/domain/generation | Stable fail-closed error; no fallback to local execution |
| Concurrent writers / compare-and-advance race | At most one authorized next tuple; loser cannot append, dispatch, or issue a Receipt |
| Crash before and after every local write and authority transition | Reopen yields old complete state, new complete state, or fail-closed; never an unverified mixed state |
| Replay an old repair approval or bind it to another project/worktree | Reject by tuple, expiry, nonce/generation, and authenticated principal checks |
| Credential rotation/revocation and authority rollback | Old credential/checkpoint cannot revive execution; recovery behavior is explicit and audited |
| Legacy files-only store | Explicit migration/quarantine path; never infer a new trusted identity from missing local evidence |
| Every public entry point | MCP, Pi, CLI, and taskflowd all enforce the same gate before their first mutation/provider call |

This table is not a 0.3 GA gate under the frozen local-disk scope. It is the
minimum contract for any future anti-rollback claim. Physical
compaction/retention, no-follow race hardening, crash/power-loss coverage, and
the rest of the GA matrix remain current 0.3 gates.

## Round 53: temporary-path symlink hardening is not a trust root

`writeFileAtomic()` previously derived a temporary pathname from the target,
PID, and millisecond timestamp, then opened it with `"w"`. A pre-created
symlink at that exact pathname caused the old algorithm to follow the symlink
and overwrite bytes outside the intended durable directory before rename. The
isolated historical reproduction in
[`round53-p14-legacy-red.log`](../../../.scratch/logs/round53-p14-legacy-red.log)
records that external-sentinel mutation. The current permanent Unix regression
instead fixes `Date.now()`, plants the legacy-shaped symlink, and proves that
the *current* helper neither follows nor replaces it; it must not be described
as executing the removed old writer.

The current helper uses a random UUID name plus exclusive `"wx"` creation
(mode `0600`) before any write, retrying only an `EEXIST` collision. The
permanent Unix tests use a separate external root and prove both that the old
pre-created symlink remains a symlink and that a symlink planted at the newly
generated pathname is rejected/retried rather than followed. They inject
write+close, fsync+close, close-only, and rename failures; all such failures
now surface as typed `TF_DURABILITY_FAILED` errors preserving the original
cause, and the private temporary entry is cleaned up best-effort. The injected
I/O cases are error-propagation tests, not a disk-fault or power-loss proof.

A second permanent Unix counterexample deliberately preserves the remaining
post-open race: after exclusive creation has succeeded, a concurrent directory
writer replaces that new temporary source entry with a symlink before
`renameSync()`. The helper currently returns success and publishes the symlink
as the destination. The same class includes parent-directory and destination
replacement after open. A later `lstat` would merely move the race; only a
platform primitive that binds the directory/file descriptor to publication can
remove it.

This is only a **narrow local hardening**. It does not create an `openat(2)`
or directory-FD no-follow protocol; the hostile concurrent parent/source/target
replacement counterexample remains. `fsyncDirectory()` now fails closed on
directory open/fsync/close errors with `TF_DURABILITY_FAILED`, including a
post-rename directory-sync failure; it intentionally does not silently treat
unsupported directory sync as success. That classification is still neither a
physical power-loss proof nor a portable directory-FD publication primitive.
The slice cannot detect the explicitly excluded whole-root rollback, make
directory metadata universally durable, or permit physical compaction. P14
therefore remains **FAIL** for the in-scope post-open path-replacement race,
compaction, crash/power-loss, and public-entry coverage gaps.

## Status

Accepted for the files-only/local-disk trust model with coherent rollback of all
local authority bytes explicitly excluded. The GA durability gate remains
blocked by durable compaction, crash/power-loss coverage, the in-scope
hostile-filesystem race contract, and full public-entry coverage. No external
freshness service is required unless the product later expands the claim.
