# P7: Dynamic paths + dual hashes + cache

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
Dynamic IR after Compile+Link produces BoundFragment with dual hashes:
- boundFragmentHash — full audit identity
- executionSemanticHash — reuse key

Cache reuse requires authority valid ∧ lease/version valid ∧ executionSemanticHash equal ∧ artifact integrity ∧ output contract ∧ re-Link/validate.

No blind promotedPhases restore.

## Status
Accepted for 0.3.0 wire freeze.
