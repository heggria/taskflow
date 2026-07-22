# P9: legacy-conflict

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.6

## Decision
When a 0.2 writer is detected on the same project flow storage while 0.3 control is active:
- 0.3 **stops new Attempts** (legacy-conflict).
- Existing 0.3 journal remains authoritative for 0.3 runs.
- Dual-write: 0.3 stops self; cannot kill foreign 0.2 writers (D20).

## Status
Accepted for 0.3.0 wire freeze.
