# Claim vs implementation — verification log (`release/0.2.0`)

> Last updated: 2026-07-10 · Local closure gates pass on the merged tree;
> do not publish until the release PR/CI passes and the tag job owns all names.
> Purpose: single ledger so marketing/RFCs/skills do not outrun the code.

## Verified true (hard claims OK)

| Claim | Evidence |
|-------|----------|
| S0 FlowIR + content hash | `flowir/compile.ts`, `hashFlowIR`; race/expand compile smoke |
| S1 events + fold + trace | `exec/{events,fold}`, `FileTraceSink` mkdir-on-flush |
| S2 event kernel default OFF, 10 kernel kinds | `EVENT_KERNEL_PHASE_TYPES` = PHASE_TYPES − race − expand; env/flag |
| S3 offline replay | `replay.ts`, MCP `taskflow_replay`, pi `/tf replay` |
| S4 package `taskflow-dsl` | erase kinds registry, CLI build/check/decompile/new, tests |
| 12 `PHASE_TYPES` | `schema.ts`; imperative runtime executes all 12 |
| MCP 12 tools | `taskflow-mcp-core` server tool list |
| Five host delivery packages | pi/codex/claude/opencode/grok |
| Toolchain = TypeScript AST (not ts-morph) | `taskflow-dsl` depends on `typescript` only |
| MCP request cancellation | concurrent stdio dispatch; `notifications/cancelled` → `AbortSignal` → runtime/host child |
| Grok sandbox policy | read-only and mutating/default phases both require independent operator-configured custom profiles because built-ins may fail open; read-only also has a narrow allowlist + mutator denies; live Grok 0.2.93 E2E probes both profiles |
| Existing npm version verification | trusted owner + SLSA/GitHub provenance + tag/commit + exact tarball integrity before skip |

## Honest / qualified

| Topic | Truth |
|-------|--------|
| Version | Package manifests and plugin pins are bumped to **0.2.0**; npm is not published until the `v0.2.0` release job succeeds |
| S5 | Kernel default ON **not** done; flagship $6→$0.40 is **acceptance target**, not certified number |
| `cancelLosers` | **Implemented**: first-**success** wins; abort losers after success; parent abort wakes + grace-bounds wait; cooperative losers in usage |
| Event kernel “complete” | Complete for **kernel-eligible** kinds/features; not race/expand; not score/retry/expect/reflexion/cross-run cache/shareContext; **nested** `flow` re-runs `canUseEventKernel` (fail-closed) |
| Multi-host DSL | Hosts run **Taskflow JSON**; `.tf.ts` requires prior `taskflow-dsl build` |
| Decompile | Semantic, not literal round-trip |
| Test count | **1500+** unit tests in **100** `*.test.ts` files (regenerate the exact count on release) |
| Package count | **9** under `packages/` + `website` |
| Grok budgets | Grok 0.2.93 reports no usage; Grok MCP explicitly rejects any flow declaring `budget` |

## Explicitly not shipped

loop multi-body · route · compensate/saga · watch · experimental C-track runes · host auto-build of `.tf.ts` · S5 default kernel ON

## Alignment actions taken

### Pass 1 (claim ledger)
1. Schema + skills: `cancelLosers` documented (later upgraded to real abort + first-success).
2. S4 RFCs: ts-morph → TypeScript compiler API.
3. FlowIR/step/runtime comments: 12 kinds / kernel-10.
4. README / AGENTS / workspace / architecture counts.
5. North-star: DSL ✅; flagship $ = S5 gate.

### Pass 2 (website + CHANGELOG + examples)
6. Website homepage: **12** phases / **5** hosts (en+zh).
7. Website phase-types + concepts: `race` / `expand` sections (en+zh).
8. Website reference: **TypeScript DSL** page (en+zh) + nav.
9. CHANGELOG Unreleased: S4 + race/expand + alignment; kernel wording fixed.
10. Examples: `race-first-win.json`, `expand-nested-fragment.json`.
11. Skills advanced: `flow{def}` vs `expand`; configuration caveats (kernel/decompile).

### Pass 3 (multi-agent review P0/P1 fixes)
12. Race **first-success** (not first-settled); cooperative loser usage aggregates.
13. Graft: rewrite `{steps.*}` after id prefix; zero expand usage after promote (no double-count).
14. DSL `register()` unions explicit `dependsOn`; unknown runes / non-agent branches error.
15. Decompile: import race/expand; fail-closed non-string `def`.
16. Kernel policy: `incremental` + workspace cwd keywords force imperative.
17. README phase table + taskflow-dsl README preview note.

### Pass 4 (multi-agent P0/P1 code fixes)
18. Race **first-success** (not first-settled); non-cooperative loser wait is bounded.
19. Graft: rewrite `{steps.*}` after id prefix; zero expand usage after promote.
20. DSL `register()` unions dependsOn; unknown runes / non-agent branches error.
21. Decompile: import race/expand; fail-closed non-string `def`.
22. Kernel policy: incremental + workspace cwd keywords force imperative.

### Pass 5 (adversarial re-review closure)
23. Race parent-abort wakes gate + grace; all-fail unit test; cancelLosers grace retained.
24. Nested event-kernel re-admission (`canUseEventKernel` on child) fail-closed.
25. DSL bare unknown callees error; P0 regression tests (dependsOn union, branch kind, decompile).
26. Decompile expand keeps `dependsOn`/`final`/`maxNodes`; race emits `cancelLosers: false`.
27. Docs honesty: EN/zh README monorepo-vs-npm banner; zh phase/package parity; website race first-success; example description; publish.yml nine packages; CONTRIBUTING/DECISIONS counts.
28. CI includes `test:e2e-grok-mcp` (already wired).

### Pass 6 (release-closure hardening)
29. Grok 0.2.93 read-only execution no longer includes unmappable web ids; mutator deny rules remain even if allowlist handling regresses.
30. Grok thinking maps to `--reasoning-effort`; its unavailable usage accounting rejects budgeted MCP runs fail-closed.
31. MCP stdio dispatch is concurrent and propagates `notifications/cancelled` through a per-request `AbortSignal`.
32. Existing npm versions are never blindly skipped: owner, provenance repository/workflow/ref/commit, and local tarball integrity must match.
33. Added a live Grok executor E2E (`pnpm run test:e2e-grok`) in addition to the network-free Grok MCP E2E.
34. Corrected detached-run documentation: detach is Pi-only; MCP cancellation aborts rather than creating hidden background work.

### Pass 7 (cross-adversarial terminal closure)
35. Runtime/kernel/replay/cache/trace/graft/resume semantics were challenged with executable counterexamples; nested and supervision-tree budgets now use remaining caps, replay fails safe on incomplete/legacy graph evidence, and graft ownership/usage survives definition evolution and collisions.
36. DSL compiler/decompiler/CLI is fail-closed for unsupported dynamic syntax, round-trips all 12 phase kinds, defaults `check` to TypeScript diagnostics, and passes clean tarball/install E2E.
37. MCP cancellation tears down the full host process tree; stdio disconnect/error paths are bounded and suppress late work/responses.
38. Grok read-only and custom-profile mutating policies have live 0.2.93 enforcement probes; unavailable usage accounting rejects every nested budget path before spawn; max-turn exhaustion is fatal.
39. All GitHub Actions are pinned to verified full SHAs; npm publish and GitHub Release use separate least-privilege jobs; published-version reruns verify provenance and exact tarball integrity.
40. Root typecheck, full unit suite, all package builds, website static export, DSL install E2E, four host MCP E2Es, built-dist comprehensive MCP E2E, and live Codex/OpenCode/Grok executors pass locally.

## Still open (not claimed as done)

- Formal **0.2.0 npm publish** after merge + `v0.2.0` tag; pins already match.
- S5 kernel default ON + flagship $ demo seal → plan: `docs/internal/s5-kernel-default-on-plan.md`.
- Live Claude executor E2E is still an external release-environment gate: the current local Claude route returns HTTP 403 from `api.ohmyrouter.com`. Codex, OpenCode, and Grok live executors pass; all four MCP adapters pass without live model access.

## Re-verify commands

```bash
pnpm run test:dsl
pnpm run test:hosts
node --conditions=development --experimental-strip-types --test \
  'packages/taskflow-mcp-core/test/*.test.ts'
pnpm run test:e2e-grok
node --conditions=development --experimental-strip-types --test \
  packages/taskflow-core/test/race-expand.test.ts \
  packages/taskflow-core/test/script.test.ts
node scripts/build-skills.mjs && \
  node --conditions=development --experimental-strip-types --test \
  packages/pi-taskflow/test/skills-build.test.ts
# Optional full: pnpm test
```
