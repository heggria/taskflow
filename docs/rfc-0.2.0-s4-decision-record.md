# S4 Shape Decision Record (`taskflow-dsl`)

> Status: **IMPLEMENTED (package live)** — route/surface frozen; coverage extended beyond original MVP ship bar (see §“Landed beyond MVP”)
> Date: 2026-07-09 · Last kinds sync: 2026-07-09
> Full surface: [`rfc-0.2.0-s4-mvp.md`](./rfc-0.2.0-s4-mvp.md)
> Council runs: `s4-shape-council` → `s4-shape-council-v2` → `s4-shape-finalize`

## One-sentence definition

**S4 is a new package `taskflow-dsl` that compile-erases `.tf.ts` into Taskflow JSON (then FlowIR only via `taskflow-core`), with whole-file JSON as the zero-migration escape hatch — not a second runtime and not S5.**

## Execution model (locked)

| | |
|--|--|
| **Primary** | **Svelte-style** compile-time runes (AST erase; cannot run unbuilt `.tf.ts`) |
| **Escape** | **JSON-only** whole-file (dual frontend at **file** boundary) |
| **Toolchain** | **TypeScript compiler API** (`typescript` package) → Taskflow → `compileTaskflowToFlowIR` |
| **Rejected** | Solid Proxy runtime runes · in-file Vapor hybrid · interpret / auto-build-on-run · S5 prerequisite |

## Package & CLI

- **Package:** `taskflow-dsl`
- **Import:** `from "taskflow-dsl"`
- **Bin:** `taskflow-dsl {build,check,decompile,new}`
- **Hosts:** CLI-first; **no** new MCP tools in S4; run via existing `taskflow_run` + emitted `.taskflow.json`
- **Core:** allow schema/validate/desugar/FlowIR compile+hash/verify; **deny** runtime/exec/runner/store/hosts/mcp

## MVP scope (in) — original ship bar

1. `flow` + args/budget/concurrency/description
2. Core phase kinds basic runes (ship bar was **10**; engine now **12** with `race`/`expand` — see Landed beyond MVP)
3. Template → `{steps.*}` / `{item.*}` erase
4. Auto `dependsOn` from `.output` / `.json` reads + explicit `dependsOn`
5. `when` **string** form (+ TS subset in `check` if cheap)
6. Basic `json<T>()` → `output:"json"` + `expect` (fail-closed on complex types)
7. `check` / `build` / `new` / decompile (Taskflow→`.tf.ts` on Y-slice)
8. Golden **FlowIR hash equality** demos (must include map + templates + `json<T>`, not only hello)
9. Import-lint: DSL must not drag core runtime

## Landed beyond original MVP (kinds sync)

Engine `PHASE_TYPES` is now **12** (`race`, `expand` added). DSL erase registry
(`packages/taskflow-dsl/src/build/erase/kinds/*`) covers:

| Kind / sugar | Status |
|--------------|--------|
| Core 10 + `subflow` / `subflow.def` | ✅ |
| `gate.automated` / `gate.scored` | ✅ (A-track sugar) |
| `race` + `cancelLosers` | ✅ engine + DSL (best-effort AbortSignal abort of losers) |
| `expand` / `expand.nested` / `expand.graft` + `maxNodes` | ✅ engine + DSL |
| Parallel destructure → N agent phases | ✅ |
| Modular pipeline (no monolith grow) | ✅ see `docs/internal/modularization-0.2.0.md` |

Still **not** shipped as runes: loop multi-body, `route`, `compensate`/saga,
`watch`, experimental C-track.

## Brainstorm phases — language support

Source: `docs/internal/brainstorm-2026-07-08-0.2.0-phases.md`
Design: **`docs/rfc-0.2.0-dsl-phases-horizon.md`**

| Track | What | When |
|-------|------|------|
| **A** | `subflow.def` / `expand.nested`, `gate.scored`/`automated`, `reflexion`, `idempotent` — **DSL sugar on existing engine** | ✅ mostly landed (reflexion/idempotent via opts) |
| **B** | New/enhanced: **`expand` graft**, **`race`**, **loop multi-body**, **`route`**, **`compensate`/saga**, approval timeout, map item-incremental, **`watch` on-stale** | race + expand graft ✅; rest S4.x |
| **C** | experimental: `counterfactual`, `quorum`, `fork`, … | language stubs + fail-closed until engine |
| **D** | visual builder, true stream edges, full self-rewriting flow | never / far |

Unknown / unimplemented experimental runes must **error** (no silent drop).

## Explicitly out (S4 ship bar)

1. Solid runtime / Proxy / degraded interpret
2. In-file JSON phase hybrid
3. Multi-body loop / `flow.component` / `$store` as **MVP ship** (designed in horizon doc; implement later)
4. S5 kernel default ON
5. New MCP `taskflow_build` / host auto-build of `.tf.ts`
6. Literal decompile round-trip marketing
7. 100% PhaseSchema coverage as S4 ship bar (FULL = language goal only)
8. Shipping B-track **engines** inside S4 MVP gate (language design only)

## Minimal `.tf.ts` example

```ts
import { flow, agent, map, reduce, json } from "taskflow-dsl";

export default flow("audit", (ctx) => {
  ctx.budget({ maxUSD: 2 });
  const discover = agent("List files under {args.dir}", {
    output: json<{ path: string }[]>(),
  });
  const each = map(discover, (item) =>
    agent(`Audit ${item.path}`),
  );
  return reduce([each], () => agent("Write one summary from map outputs"));
});
```

## Acceptance gates

- [x] `packages/taskflow-dsl` in workspace; bin + exports as `rfc-0.2.0-s4-mvp.md` §1
- [x] Demo `.tf.ts` and twin `.json` → **same** `ir:<64-hex>` (parity tests)
- [x] Equality fixtures include **map + json\<T\> + templates**
- [x] Rune runtime call throws `TFDSL_ERASE_ONLY`
- [x] Import-lint denylist green
- [x] Skills/docs: JSON first-class for agents; CLI path for DSL (+ kinds table)
- [x] DSL v2 note: FULL vs S4 MVP ship gate (authority B1)

## Open questions for human (max 3)

1. **H1** Commit coverage matrix as a real doc? (recommend **yes**)
2. **H2** Decompile Taskflow-only in MVP? (recommend **yes**)
3. **H3** Throw-on-call for runes? (recommend **yes**)

## North-star alignment

| Slogan | How S4 contributes |
|--------|-------------------|
| **compiled** | First real authoring compiler (erase → Taskflow → FlowIR) |
| **resumable** | Unchanged (runs still Taskflow/events) |
| **incremental** | Unchanged (recompute on built Taskflow) |
| **replayable-for-what-if** | Unchanged (S3); DSL-produced runs replay the same |

## Council evidence

| Run | Role |
|-----|------|
| `s4-shape-council-mrd6rcyl-f77e65` | inventory-code, inventory-rfc, coverage-map |
| `s4-shape-council-v2-mrd6wdcj-e34ca3` | routes + tournament (svelte/json-only/typescript-AST) + api-surface + adversary |
| `s4-shape-finalize-mrd765gf-f14e1b` | cross-check (PASS on route; BLOCK only until B1/matrix/H2/H3 written) |

Flow defs: `/tmp/taskflow-s4/s4-shape.json`, `s4-shape-v2.json`, `s4-shape-final.json`
Saved project flow: `.pi/taskflows/s4-shape-council.json`
