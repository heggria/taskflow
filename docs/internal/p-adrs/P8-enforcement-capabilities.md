# P8: Enforcement capabilities

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
Orthogonal capabilities (RFC §15):
| Capability | Values |
| resolution | contained | unbound |
| mutationMediation | none | brokered |
| processIsolation | none | sandboxed |
| revocation | admission-only | per-mutation | bounded-latency |

Unsupported sandbox → **fail closed** (D11).

## Status
Accepted for 0.3.0 wire freeze.
