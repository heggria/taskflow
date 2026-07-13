# Multi-agent review — S4 + Horizon B + alignment (`release/0.2.0`)

> Date: 2026-07-09 · HEAD: `4da6f33`
> Scope: S4 `taskflow-dsl`, race/expand/cancelLosers, claim alignment, S5 plan
> Agents: architecture · race/expand concurrency · DSL erase · docs honesty
> Raw notes: `/tmp/grok-ma-review-{arch,race,dsl,docs}-c1d88a29.md`

## Council verdict

**Do not market “0.2.0 complete / race first-success / graft multi-phase ready” without fixes.**
Engineering depth is real (12 kinds, DSL package, tests green), but several **correctness and honesty** gaps remain above nits.

| Track | Verdict |
|-------|---------|
| Architecture S0–S4 shape | **Conditionally OK** — types align; dual-path + FlowIR field gaps |
| Race / expand runtime | **Blockers** — first-settled ≠ first-success; graft prefix + usage |
| DSL erase | **Blockers** — dependsOn overwrite; silent drops; decompile lies |
| Docs / publish surface | **Blockers for release narrative** — 0.1.7 vs 0.2.0 dual story |

---

## P0 — fix before calling Horizon B “done”

### 1. Race: first-settled vs first-success  *(race agent · bug)*

- **Code:** `Promise.race` → first **settle** (fail or ok) wins.
- **Skills:** “first branch that finishes **successfully**”.
- **Impact:** Fast hard-fail kills the race while a slower branch would succeed.
- **Fix:** (A) first-success loop, or (B) rewrite all author docs to first-settled. Prefer **A**.

### 2. Graft: template refs not rewritten  *(race agent · bug)*

- **Code:** `prefixGraftFragment` rewrites ids + `dependsOn`/`from` only.
- **Impact:** Multi-phase fragments with `{steps.a…}` break after prefix; validate-after-prefix can fail-open via `defError`. Single-phase graft works by accident.
- **Fix:** Rewrite collectible template surfaces with `idMap`; test two-phase graft chain.

### 3. Graft usage double-count  *(race agent · bug)*

- Expand phase `usage` = sub total **and** promoted children keep usage → run rollup **2×**.
- **Fix:** Zero expand usage after promote **or** zero promoted children usage for aggregation.

### 4. DSL `register()` drops explicit `dependsOn`  *(dsl agent · bug)*

- When auto-deps non-empty, `raw.dependsOn = [...auto]` overwrites opts.dependsOn for kinds that don’t union into `draft.dependsOn`.
- **Fix:** Union auto + explicit in `register()`; regression test.

### 5. DSL silent phase/branch drops  *(dsl agent · bug)*

- Unknown callees in flow body: no error.
- parallel/race/tournament non-`agent()` branches: silent skip.
- **Fix:** Diagnostics `TFDSL_RUNE_UNKNOWN` / `TFDSL_BRANCH_KIND`.

### 6. Decompile race/expand  *(dsl agent · bug)*

- Emits `race`/`expand` without importing them.
- Object `def` → fabricated `"{steps.plan.json}"` placeholder (shape lie).
- **Fix:** Import list; fail-closed non-string `def`.

---

## P1 — before kernel default ON / public 0.2.0

### 7. Race usage / budget undercount  *(race agent · bug)*

- Winner-only final usage; concurrent live usage last-writer-wins.
- Loser spend (pre-abort) invisible to budget.
- **Fix:** Aggregate all branch usages after `allSettled`; shared live accumulator.

### 8. Dual-path kernel admits flows that ignore features  *(arch agent · bug)*

- Kernel path may miss `cacheScopeDefault` incremental / workspace cwd keywords.
- **Fix:** Extend `kernelUnsupportedReason` or implement in driver.

### 9. FlowIR sidecar incomplete for Horizon B  *(arch agent · bug)*

- `cancelLosers`, `expandMode`, `maxNodes` not fully in IR field model.
- **Fix:** FlowIR node payload parity or documented non-goals.

### 10. Version dual narrative  *(docs agent · bug)*

- README / website teach 0.2.0 surfaces; packages **0.1.7**; plugins pin `@0.1.7`; `taskflow-dsl` may 404.
- **Fix:** Publish banner “preview branch” **or** bump 0.2.0 + publish.

### 11. README phase table vs “12 phase types”  *(docs agent · bug)*

- Marketing line says 12; some tables still 10 without race/expand.
- **Fix:** Table sync.

---

## P2 — hygiene

| Item | Source |
|------|--------|
| gate sugar always TFDSL_RUNE_OPTS_UNKNOWN for pass/scorers | dsl |
| import-lint string-only vs full core barrel | dsl |
| S5 plan couples default ON to $ demo while kernel lacks cross-run cache | arch |
| claim ledger residual cancelLosers row | arch/docs |
| retry delay ignores race extraSignal | race |
| deterministic tests over wall-clock delays | race |

---

## What the council agreed is solid

- 12 `PHASE_TYPES` ↔ DSL erase registry ↔ FlowIR kind enum (post test fix).
- Event kernel excludes race/expand intentionally.
- `TFDSL_ERASE_ONLY` on runes.
- Parallel destructure → N agents; race destructure rejected.
- cancelLosers **wiring** (controllers + `extraSignal`) is directionally correct for happy path.
- Unit suite **1402/1402** after FlowIR length fix.
- Internal claim ledger + S5 plan exist and are mostly honest.

---

## Recommended action order

1. **P0.1–P0.3** race/expand runtime (semantics + graft + usage).
2. **P0.4–P0.6** DSL register/silent drop/decompile.
3. **P1.10** version/publish honesty banner.
4. **S5.0** parity harness only after P0 runtime dual-path inventory (arch).
5. Defer kernel default ON until P1.7–P1.8 closed.

## Agent artifacts

| Dimension | File |
|-----------|------|
| Architecture | `/tmp/grok-ma-review-arch-c1d88a29.md` |
| Race/expand | `/tmp/grok-ma-review-race-c1d88a29.md` |
| DSL erase | `/tmp/grok-ma-review-dsl-c1d88a29.md` |
| Docs honesty | `/tmp/grok-ma-review-docs-c1d88a29.md` |
