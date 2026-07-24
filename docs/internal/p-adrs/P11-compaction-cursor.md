# P11: Compaction + cursor + minAvailableCommitSeq

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
- `commitSeq` is **never renumbered** by compaction.
- Receipts embed eventManifest / hash-chain roots issued at receipt time — remain valid after compaction.
- Cursor: minAvailableCommitSeq; TF_CURSOR_EXPIRED → checkpoint resync.
- Missing blob after retention → artifactIntegrity: unknown (not silent verify).

## Status
Accepted for 0.3.0 wire freeze.
