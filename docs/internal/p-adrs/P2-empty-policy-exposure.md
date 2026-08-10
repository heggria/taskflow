# P2: Empty-policy Exposure

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
When no explicit project/user policy is present, Exposure is **host-default attenuated**:
- Allow link/admit of public 0.2.4 surface (D21).
- Do not grant network, cross-project, or DomainTransfer.
- Approval mode defaults to `compat-auto-reject`.

## Empty ≠ unrestricted
Missing policy never means "allow all". Unknown capability requests → deny.

## Status
Accepted for 0.3.0 wire freeze.
