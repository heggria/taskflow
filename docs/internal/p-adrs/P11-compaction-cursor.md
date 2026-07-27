# P11: Compaction + cursor + minAvailableCommitSeq

> Status: **Accepted normative contract; implementation PARTIAL; NOT a GA retention protocol**
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.6

## Decision
- `commitSeq` is **never renumbered** by compaction.
- Receipts embed eventManifest / hash-chain roots issued at receipt time — remain valid after compaction.
- Cursor: minAvailableCommitSeq; TF_CURSOR_EXPIRED → checkpoint resync.
- Missing blob after retention → artifactIntegrity: unknown (not silent verify).
- A cursor floor is authoritative only when represented by a validated
  `CompactionCheckpoint { throughCommitSeq }` event in the hash-linked project
  journal. The store derives `minAvailableCommitSeq = throughCommitSeq + 1`;
  no loose `compaction.json` cache is authoritative.
- A checkpoint may advance the **logical** resync floor, but it does not by
  itself authorize deletion of journal segments. Until the P14 retention
  handoff proves the retained prefix, hash-chain boundary, Receipt reachability,
  crash recovery, and trust root, physical deletion remains disabled.

## Status

The current implementation has a narrow local cursor-integrity slice:

- `advanceMinAvailable()` appends a monotonic checkpoint under the same commit
  lock and mutation fence as all other journal commits;
- checkpoint payloads must use the reserved stream, advance a prior retained
  prefix, and never reference themselves or a future tail;
- cursor reads derive their floor from a read-only validated journal and fail
  closed if a project-root identity anchor survives while the ControlStore
  subtree is missing;
- deleting, resetting, or adding a legacy loose cursor pathname cannot revive
  an expired cursor; and
- `deleteCompactedJournalFiles()` reports candidate old segments but removes
  none.

This is **not** physical compaction, retention, rollback protection, or a GA
claim. P11 remains `PARTIAL`; P14 remains `FAIL` until the trust/repair choice,
compaction handoff, crash/power-loss matrix, no-follow protocol, and full
entrypoint proof are complete.
