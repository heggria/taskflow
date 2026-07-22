# P1: Policy overlay

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.6

## Decision
Effective authority = host ∩ user ∩ project ∩ invocation (RFC §14).

## Ops
- **deny** — remove a capability
- **substitute** — replace with an allowed alternative (conflict → deny)
- **attenuate** — shrink scope (never enlarge)

## Rules
- Security-unknown fields **fail closed**.
- Catalog labels ≠ authority.
- Project policy cannot enlarge user/host ceilings.
- Single canonical hash library (see P6).

## Wire impact
Policy decisions recorded on CommandRecord.authorizationContextHash; re-check live authz on disclosure (P12).

## Status
Accepted for 0.3.0 wire freeze.
