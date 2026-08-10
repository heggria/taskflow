# P12: Command batch + re-auth disclosure

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
CommandRecord commits in the **same atomic batch** as its ControlEvents.

Idempotency:
- same commandId + requestHash → do not re-execute; disclose only after **live** re-auth
- same id, different hash → TF_IDEMPOTENCY_CONFLICT
- different principal → TF_CROSS_PRINCIPAL_COMMAND

authorizationContextHash is audit metadata at accept; disclosure uses live authz.

## Status
Accepted for 0.3.0 wire freeze.
