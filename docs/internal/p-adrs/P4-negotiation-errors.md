# P4: Negotiation + errors + recoveryAction

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.6

## Decision
Handshake carries protocolMajor, supportedReadSchemas[], supportedWriteSchemas[], requiredFeatures[], offeredFeatures[], buildInfo.

## Error envelope
`{ code, message, recoveryAction, sideEffects, commandId?, commitSeq?, controlDomainId?, projectId? }`

## TF_RECONCILE_REQUIRED (normative)
- recoveryAction: **operator**
- sideEffects: **unknown**
- `taskflow_runs(wait)` / status return a **normal snapshot** (status=unknown, needs-operator) — **not** a transport RPC failure.

## Status
Accepted for 0.3.0 wire freeze.
