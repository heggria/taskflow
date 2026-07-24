# P7: Dynamic paths + dual hashes + cache

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
Dynamic IR after Compile+Link produces BoundFragment with dual hashes:
- boundFragmentHash — full audit identity
- executionSemanticHash — reuse key

Cache reuse requires authority valid ∧ lease/version valid ∧ executionSemanticHash equal ∧ artifact integrity ∧ output contract ∧ re-Link/validate.

No blind promotedPhases restore.

## Durable link model

The Home Project ControlStore persists two separate immutable facts:

1. `bound-fragments/bf-<hash>.json` stores the normalized fragment body and
   dual hashes. Re-linking equal semantics may reuse this content-addressed
   body, subject to the full authority/cache gate above.
2. `bound-fragment-links/<linkId>.json` stores the Run-specific link fact:
   Run id, parent NodeInstance, origin phase, optional causation id, link kind,
   created commit, and bounded node counts.

The same atomic journal batch writes the `BoundFragmentLinked` event, current
Run projection, body, and link. `createdAtCommitSeq` is taken from that stamped
event rather than from caller input. Recovery rebuilds both directories from
the journal; a Run or dynamic NodeInstance that references a missing link
fails read-only ControlStore inspection.

`staticNodeCount` is the number of phase definitions in the immutable fragment
body. `dynamicNodeCount` is the number of NodeInstances instantiated from those
definitions at that link boundary. They are different grains and may be equal
for a one-instance-per-definition fragment; neither count includes nodes from
the parent BoundPlan. These counts do not mutate that plan and are not a
substitute for the paged graph inventory.

## Status
Accepted for 0.3.0 wire freeze.
