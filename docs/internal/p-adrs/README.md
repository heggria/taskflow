# 0.3.0 Protocol ADRs (P1–P17)

Wire-freeze gate for taskflow 0.3.0 core plus the provisional beta.2 browser schema. Master RFC v7.7 is frozen; detail lives here + TypeBox.

| ID | Title | File |
|----|-------|------|
| P1 | Policy overlay | [P1-policy-overlay.md](./P1-policy-overlay.md) |
| P2 | Empty-policy Exposure | [P2-empty-policy-exposure.md](./P2-empty-policy-exposure.md) |
| P3 | Domain + Registry rebuild + clone/worktree identity | [P3-domain-registry-identity.md](./P3-domain-registry-identity.md) |
| P4 | Negotiation + errors + recoveryAction | [P4-negotiation-errors.md](./P4-negotiation-errors.md) |
| P5 | Phase × feature + RunStatus/Stage matrix | [P5-phase-feature-matrix.md](./P5-phase-feature-matrix.md) |
| P6 | Canonical hash + ArtifactRef + SecretRef | [P6-canonical-hash-refs.md](./P6-canonical-hash-refs.md) |
| P7 | Dynamic paths + dual hashes + cache | [P7-dynamic-paths-dual-hashes.md](./P7-dynamic-paths-dual-hashes.md) |
| P8 | Enforcement capabilities | [P8-enforcement-capabilities.md](./P8-enforcement-capabilities.md) |
| P9 | legacy-conflict | [P9-legacy-conflict.md](./P9-legacy-conflict.md) |
| P10 | Rollback tiers | [P10-rollback-tiers.md](./P10-rollback-tiers.md) |
| P11 | Compaction + cursor + minAvailableCommitSeq | [P11-compaction-cursor.md](./P11-compaction-cursor.md) |
| P12 | Command batch + re-auth disclosure | [P12-command-batch-reauth.md](./P12-command-batch-reauth.md) |
| P13 | Bootstrap / fresh-install / singleton lock / platforms | [P13-bootstrap-singleton.md](./P13-bootstrap-singleton.md) |
| P14 | ControlStore engine (files-only) | [P14-controlstore-engine.md](./P14-controlstore-engine.md) |
| P15 | Approval protocol | [P15-approval-protocol.md](./P15-approval-protocol.md) |
| P16 | UserCoordinatorStore concurrency + release | [P16-coordinator-concurrency.md](./P16-coordinator-concurrency.md) |
| P17 | Browser protocol + aggregate cursors | [P17-browser-protocol.md](./P17-browser-protocol.md) |

## Completeness

P1–P16 gate the core 0.3 wire. P17 is the independent initial beta.2 browser schema baseline and is not wire-frozen until its implementation/evidence gates pass. Files-only storage is specified in P14. P16 is not foldable into P13.
