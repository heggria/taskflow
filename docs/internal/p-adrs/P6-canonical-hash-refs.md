# P6: Canonical hash + ArtifactRef + SecretRef

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.6

## Decision
- BoundPlan hash: `bp:<sha256-hex>` over stable JSON.
- executionSemanticHash: `es:<sha256-hex>` over resolved execution descriptor (RFC §11).
- ArtifactRef: `{ digest, size, mediaType, storageClass, redactionClass }` — digest is **not** a bearer token.
- SecretRef: `{ secretId, issuer }` — **no** content digest; never in general ArtifactStore.

## Library
Node `crypto.createHash("sha256")` only (taskflow-control/src/hash.ts).

## Status
Accepted for 0.3.0 wire freeze.
