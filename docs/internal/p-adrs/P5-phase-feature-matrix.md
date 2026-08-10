# P5: Phase × feature + RunStatus/Stage matrix

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
Public 0.2.4 surface goldens (packages/taskflow-core/test/fixtures/public-surface-0.2.4.json) are normative for D21.

## 0.3 RunStatus
running | completed | failed | paused | blocked | cancelled | **unknown** (non-terminal)

## 0.3 RunStage
received | compiled | linked | queued | admitted | executing | **parked** | reconciling | terminal

## Bounds
- Auto-reconcile default: maxAttempts=3 (overridable); bounds automation only.
- On exhaustion: keep unknown; no final Receipt; slot → orphan-suspect.

## Cancellation import
paused+detachedCancel+live → paused/executing; worker dead → cancelled/terminal.

## Status
Accepted for 0.3.0 wire freeze.
