# P1: Policy overlay

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

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

## Persistence boundary

P1 specifies evaluation, overlay, hashing, and audit semantics only. It does **not** define an authoritative writable PolicyStore, policy revision/CAS protocol, or `update-policy` command. Clients may explain effective policy; mutation requires a separate accepted ADR naming authority, persistence, concurrency, rollback, and audit behavior. The beta.2 browser protocol is therefore read-only for policy.

## Status
Accepted for 0.3.0 wire freeze.
