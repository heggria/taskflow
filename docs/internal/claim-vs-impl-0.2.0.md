# Claim vs implementation — verification log (`release/0.2.0`)

> Last full pass: 2026-07-09 · Branch HEAD after alignment commit  
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
| Version | All packages still **0.1.7**; branch is `release/0.2.0` preview — not a published 0.2.0 npm tag until bump |
| S5 | Kernel default ON **not** done; flagship $6→$0.40 is **acceptance target**, not certified number |
| `cancelLosers` | Schema + DSL accept; **runtime ignores** (first-finish-wins; warning when default true) |
| Event kernel “complete” | Complete for **kernel-eligible** kinds/features; not race/expand; not score/retry/expect/reflexion/cross-run cache/shareContext |
| Multi-host DSL | Hosts run **Taskflow JSON**; `.tf.ts` requires prior `taskflow-dsl build` |
| Decompile | Semantic, not literal round-trip |
| Test count | ~**1400+** unit tests in ~**95** `*.test.ts` files (regenerate badge on release) |
| Package count | **9** under `packages/` + `website` |

## Explicitly not shipped

loop multi-body · route · compensate/saga · watch · experimental C-track runes · host auto-build of `.tf.ts` · S5 default kernel ON

## Alignment actions taken this pass

1. Schema + skills: `cancelLosers` documented as reserved/ignored; race emits warning.
2. S4 RFCs: ts-morph → TypeScript compiler API.
3. FlowIR/step/runtime comments: 12 kinds / kernel-10 clarified.
4. README / AGENTS / workspace / architecture topology counts refreshed.
5. North-star: DSL ✅; flagship $ as S5 gate; multi-host via JSON.

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
