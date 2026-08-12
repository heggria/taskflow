# rc: 0.3.0 Trusted Effects beta.1

> Draft PR body for `0.3.0-beta.1`. The beta uses npm dist-tag `beta` and is not GA.
> This file is the source for the GitHub PR description.

## Base / Head

| | |
|---|---|
| Base | `main` @ `8fc6981` — current PR base |
| Head | `rc/0.3.0-trusted-effects` @ `f5284da` (23 commits ahead of main) |
| Status | **DRAFT — beta release preparation** |
| Post-ADV harden | `cbb4131` discovery/file-tx + `580daa0` S-H2; CI 31613909075 green |

This PR supersedes the historical Draft **PR #117** (`head: codex/0.3.0-trusted-effects-candidate`). The `rc/0.3.0-trusted-effects` branch is the canonical candidate branch and its tip `f5284da` is the exact head this PR is built from (Draft PR #122 — this PR).

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
- **Windows CI fix:** child-process store import specifiers portable via `pathToFileURL`/`fileURLToPath` (`e7c5e31`; test-harness only, no product change) — windows-latest store/process-supervisor jobs genuinely exercise saveRun/lock semantics

## Fixed

- Resource-bearing inline/saved/expanded/`ctx_spawn` children can no longer be skipped by parent cache or resume reuse.
- Information-flow labels compose across nested flow boundaries; unresolved dynamic definitions remain tainted, malformed non-array `effects` fail admission/compile, and `why-effect` follows DAG dependencies.
- Durable commit/abort results survive staging/lease cleanup faults, activation double faults release leases, and clean-terminal/aged-orphan before-images are garbage-collected.

## Scope boundary

This candidate guarantees **admitted declared filesystem write targets**. It does not claim a full FileBroker/native OS sandbox and cannot prevent or roll back writes to undeclared paths under resolve-only execution. SecretRef/ServiceRef have **no** vault/network backends in this cut (fail-closed, unsupported). Historical Control Plane (`feat/0.3.0`) is **not** this release definition.

## Evidence (honest)

| Gate | Status | Notes |
|---|---|---|
| L1 local | **PASS** | Current candidate has local typecheck/test/build/pack evidence; `pnpm audit --prod` remains a separate local gate |
| L2 contract | **PASS** | Exact-SHA CI run 31613909075: Node 22/24 tests, full build, packed consumer (10 packages) and MCP E2E all pass |
| L3 browser/electron | N/A | — |
| L4 real-environment | **PASS (built-MCP fixture)** | CI exercises the built MCP artifact and checked-in no-LLM Trusted Effects fixture. Live Codex evidence is historical to the current tip and is not being overclaimed. |
| L5 released | **FAIL** | no `v0.3.0-beta.1` tag/publish — human gate |
| L6 ga | **FAIL** | L5 missing — **NOT GA** |

Exact-SHA remote CI is **GREEN**: GitHub Actions run 31613909075 on this PR's head `f5284da` passed the full matrix (Node 22/24 tests, built MCP E2E, build, packed consumer, website export, process supervisor Ubuntu/macOS/Windows, CodeQL).

## Commits (rc/0.3.0-trusted-effects vs main, newest first)

```
e7c5e31 fix(test): make child-process store imports portable on Windows
0f9cf16 docs: sync 0.3 draft PR body to rc tip d532f69
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

- CHANGELOG: `## [0.3.0-beta.1] — 2026-08-13` — beta prerelease.
- **Beta not yet published; not GA.** Tag and npm publication remain human-authorized release gates.
