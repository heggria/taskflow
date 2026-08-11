# rc: 0.3.0 Trusted Effects candidate (do not publish)

> Draft PR body. **Not for npm publish** — published packages stay at **0.2.8** until a human cuts `v0.3.0`.
> This file is the source for the GitHub PR description.

## Base / Head

| | |
|---|---|
| Base | `main` @ `4b04e0d` — fix(pi): require explicit approval confirmation (#119) |
| Head | `rc/0.3.0-trusted-effects` @ `d532f69` (10 commits ahead of main) |
| Status | **DRAFT — do not merge, do not publish** |

This PR supersedes the historical Draft **PR #117** (`head: codex/0.3.0-trusted-effects-candidate`). The `rc/0.3.0-trusted-effects` branch is the canonical candidate branch and its tip `d532f69` is the exact head this PR is built from.

## Summary

- **Trusted Effects MVP** (`packages/taskflow-core/src/effects/`):
  - EffectIR (`EFFECT_KINDS`), PathRef reuse, SecretRef/ServiceRef (type-only fail-closed)
  - closed TypeBox EffectIR + confidentiality/integrity source-to-sink validation
  - resource-controlled FS transaction: durable snapshot → persistent lease → journal intent/permit → stage → `Commit` or `Restore+Reject`
  - declaration-only bridge in `effects/runtime-apply.ts`; no second changeset/gateway authority
  - ledger-backed `whyAuthorized` / `whyContext` / `whyEffect`
- Optional phase `effects[]`; FlowIR translate/compile/hash include effects
- Built-in `detectEffectsIssues` (category `effects`) + `effectsLintVerifier`
- Every imperative phase fast path finalizes declared `fs.write` through the resource transaction; event-kernel-enabled runs use the same safe imperative path
- Honest host baseline: `conformance/workspace/host-support-baseline.json`
- Docs: `docs/internal/0.3.0-trusted-effects-mvp.md`, `0.3.0-agent-goal.md`, `0.3.0-ga-scoreboard.md`
- Example: `examples/trusted-effects-write.json`
- Tests: `test/effects*.test.ts`, `test/verify-effects.test.ts`
- **Store hardening:** project `.pi` discovery hardened against tmp and home roots (`96a32e8`)

## Fixed

- Resource-bearing inline/saved/expanded/`ctx_spawn` children can no longer be skipped by parent cache or resume reuse.
- Information-flow labels compose across nested flow boundaries; unresolved dynamic definitions remain tainted, malformed non-array `effects` fail admission/compile, and `why-effect` follows DAG dependencies.
- Durable commit/abort results survive staging/lease cleanup faults, activation double faults release leases, and clean-terminal/aged-orphan before-images are garbage-collected.

## Scope boundary

This candidate guarantees **admitted declared filesystem write targets**. It does not claim a full FileBroker/native OS sandbox and cannot prevent or roll back writes to undeclared paths under resolve-only execution. SecretRef/ServiceRef have **no** vault/network backends in this cut (fail-closed, unsupported). Historical Control Plane (`feat/0.3.0`) is **not** this release definition.

## Evidence (honest)

| Gate | Status | Notes |
|---|---|---|
| L1 local | **PASS** | `96a32e8`: monorepo typecheck PASS + `pnpm audit --prod` clean; store-discovery delta re-verified at exact SHA (focused store suite 69/69 + typecheck) |
| L2 contract | **PASS** | full unit suite 2202 tests → 2198 pass / 0 fail / 4 skipped; full build PASS; `test:pack` 9 packages PASS (pipeline logs built at evidence SHA `6071fb2`) |
| L3 browser/electron | N/A | — |
| L4 real-environment | **PASS (built-MCP fixture)** | built Codex MCP comprehensive e2e 16/16 incl. TE fixture — `fs.write` committed through resources + ledger-backed why-effect — against the built dist bin (`codex-mcp-full.log`; evidence SHA `6071fb2` per build-info stamp). **NOT** a live Codex CLI run: `test:e2e-codex` NOT rerun on the current tip (prior-candidate A→B→C historical only) |
| L5 released | **FAIL** | no tag/publish — human gate |
| L6 ga | **FAIL** | L5 missing — **NOT GA** |

Exact-SHA remote CI is **open** and is exactly what this PR provides: `.github/workflows/ci.yml` triggers only on PR→main / push to main, and no PR has yet had head = current rc tip (`d532f69`). This Draft PR head is the exact-SHA gate; historical Draft PR #117 run `31167592775` passed all 10 matrix jobs + GitHub CodeQL on `1478510f` (earlier candidate SHA) — prior green is NOT exact-SHA for `d532f69`.

## Commits (rc/0.3.0-trusted-effects vs main, newest first)

```
d532f69 docs: raise scoreboard to L4 built-MCP fixture for rc/96a32e8
59fd9c3 docs(skills): teach 0.3 Trusted Effects authoring surface
7add160 docs: add draft PR body for 0.3 trusted-effects RC
0834c59 docs: refresh 0.3 scoreboard for rc/96a32e8
96a32e8 fix(store): harden project .pi discovery against tmp and home roots
6071fb2 docs: refresh trusted effects candidate evidence
467bc28 fix(effects): close composition and transaction gaps
5529ae1 docs: record remote candidate CI evidence
f2cee92 docs: record clean 0.3 candidate evidence
e6efcd4 feat(effects): add resource-controlled trusted writes
```

## Release state

- CHANGELOG: `## [0.3.0] — Unreleased (Trusted Effects candidate)` — still Unreleased.
- **Not released; not GA.** No tag, no npm publish — blocked on explicit human authorization to cut `v0.3.0`.
