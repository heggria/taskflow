# P10: Rollback tiers

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
1. **Full rollback** possible before any 0.3 ControlStore write.
2. After 0.3 writes: read-only export / lossy export **without** execute promise.
3. No DomainTransfer as rollback mechanism.

## Status
Accepted for 0.3.0 wire freeze.
