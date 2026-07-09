# Claim vs implementation — verification log (`release/0.2.0`)

> Last full pass: 2026-07-09 · Adversarial closure pass (PR-ready)
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

## Honest / qualified

| Topic | Truth |
|-------|--------|
| Version | Package manifests and plugin pins are bumped to **0.2.0**; npm is not published until the `v0.2.0` release job succeeds |
| S5 | Kernel default ON **not** done; flagship $6→$0.40 is **acceptance target**, not certified number |
| `cancelLosers` | **Implemented**: first-**success** wins; abort losers after success; parent abort wakes + grace-bounds wait; cooperative losers in usage |
| Event kernel “complete” | Complete for **kernel-eligible** kinds/features; not race/expand; not score/retry/expect/reflexion/cross-run cache/shareContext; **nested** `flow` re-runs `canUseEventKernel` (fail-closed) |
| Multi-host DSL | Hosts run **Taskflow JSON**; `.tf.ts` requires prior `taskflow-dsl build` |
| Decompile | Semantic, not literal round-trip |
| Test count | ~**1400+** unit tests in ~**95** `*.test.ts` files (regenerate badge on release) |
| Package count | **9** under `packages/` + `website` |

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

## Still open (not claimed as done)

- Formal **0.2.0 npm publish** after merge + `v0.2.0` tag; pins already match.
- S5 kernel default ON + flagship $ demo seal → plan: `docs/internal/s5-kernel-default-on-plan.md`.
- Live host **executor** e2e as release gate (MCP e2e is CI; live model stays manual).

## Re-verify commands

```bash
pnpm run test:dsl
node --conditions=development --experimental-strip-types --test \
  packages/taskflow-core/test/race-expand.test.ts \
  packages/taskflow-core/test/script.test.ts
node scripts/build-skills.mjs && \
  node --conditions=development --experimental-strip-types --test \
  packages/pi-taskflow/test/skills-build.test.ts
# Optional full: pnpm test
```
