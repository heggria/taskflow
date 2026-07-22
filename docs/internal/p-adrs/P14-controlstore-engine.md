# P14: ControlStore engine (files-only)

> Status: **Accepted** (0.3.0 wire-freeze gate)
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

## Status
Accepted for 0.3.0 wire freeze.
