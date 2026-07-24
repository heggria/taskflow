# P14: ControlStore engine (files-only)

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
0.3 GA engine is **files-only** (still a full engine):
- Atomic commit batch: temp + fsync + rename
- Journal segments under `journal/`
- Projections under `projections/`
- Commands under `commands/`
- Receipts under `receipts/`
- Header: projectId, controlDomainId, schemaVersion, directoryBinding
- commit-seq.json monotonic counter
- `run-index.json`: project-local, watermark-bound, rebuildable Run projection accelerator
- `approval-recovery-index.json`: project-local, watermark-bound unsettled-approval recovery accelerator

The two indexes are derived from one project ledger, are updated under that
project's commit lock, and may be discarded/rebuilt. They are not Registry
authority and may not become a persisted cross-project Run or Approval ledger.

**No node:sqlite** without a future ADR replacing this one.

## Recovery
Re-read journal segments; rebuild a projection or command/Receipt index only
when its latest authoritative journal value is missing or different. An
already-current open/recovery is write-free. Any repaired Run projection
rebuilds both project-local indexes before reads are served; a read-only
inspector rejects a present stale/invalid index rather than mutating it.

## Status
Accepted for 0.3.0 wire freeze.
