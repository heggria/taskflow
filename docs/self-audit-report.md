# pi-taskflow v0.0.6 — Self-Audit Report

**Scope:** 9 extension modules (~3,185 LOC), 182 tests passing, typecheck clean
**Date:** 2026-06-04
**Verdict:** PASS — the codebase is well-layered, testable, and structurally sound. The issues are concentrated and actionable.

---

## 1. Overall Health Score: **B+**

A compact, well-factored library with a clean acyclic dependency graph, a
correct injectable seam, and a genuinely pure core. The headline architectural
decisions (desugar-to-one-engine, intermediate-result isolation by construction,
content-addressed resume) are sound and well-executed. The real debt is
concentrated in three areas: (a) the phase dispatch in `runtime.ts` is a
7-branch `if`-chain with ~120 lines of duplicated boilerplate; (b) the
spawn/parse layer in `runner.ts` is unit-untested; and (c) there are four
confirmed high-severity bugs that crash or corrupt state at runtime. Fix those
four bugs (each is small and isolated), extract `processLine` for coverage, and
dispatch-table the phase types — the result is a solid **A** project.

---

## 2. Architecture Assessment

### What's well-factored

**Module dependency graph (acyclic, clean layering).** Imports flow one direction
only — schema → interpolate → agents → runner → store → runtime → render →
index — with no cycles. The pure core (`schema.ts`, `interpolate.ts`) has zero
internal imports. `index.ts` is genuine wiring with no orchestration logic.

**Desugar-to-one-engine.** Shorthand (`task`/`tasks`/`chain`) and full DSL
converge onto a single `validateTaskflow` + `executeTaskflow` code path. No
parallel execution engines. The `desugar()` function in `schema.ts` is small,
tested, and correct.

**Intermediate-result isolation.** Outputs live in `RunState.phases` inside the
runtime; only `finalOutput` reaches the tool `content`. The architecture makes
the headline feature true by construction.

**Injectable seam at the right boundary.** `RuntimeDeps.runTask` (`runtime.ts:42`)
is the only side-effecting dependency. 100+ tests drive the entire runtime with
a mock runner — zero process spawning.

**Resume via content-addressed caching.** `hashInput` of resolved task+inputs
produces a stable 16-char hex digest. Cached phases short-circuit in
`executePhase` — simple, correct, cross-session.

### What's strained

**`runtime.ts` (715 lines) graduated from engine to monolith.** It owns
scheduling, phase execution, retry, budget, approval glue, sub-flow recursion,
gate parsing (exported!), and interpolation glue. The `executePhase` function
alone is a 7-branch `if`-chain where three branches (`agent`/`gate`, `reduce`,
`flow`) redeclare an identical live-update closure, and all 7 repeat the same
cache-check pattern. Concrete extraction candidates:
- `parseGateVerdict` (~25 LoC, pure, already exported) → belongs in `gate.ts`
- Budget logic smeared across 4 sites (`:136`, `:247`, `:225`, `:660`) → `budget.ts`
- `runOne` retry wrapper (`:218–:235`) → extract as a self-contained function

**Dual progress mechanism is accidental redundancy.** `runtime.ts` threads
`onProgress` through dozens of call sites and `emitProgress()` closures. The
`flow` branch (:457) carefully rewires it to bubble sub-flow progress up.
But `index.ts` does **not** pass `onProgress` — the TUI is driven entirely by
a 120ms heartbeat polling shared-mutable `RunState`. So all that callback
plumbing is a no-op in production, **except** the flow-branch bridge which is
load-bearing for sub-flow live progress. This is the clearest case of
over-engineering in the codebase.

**Spawn/parse layer is unit-untested.** The injectable `runTask` seam gives
excellent runtime coverage without spawning, but everything below it — NDJSON
parsing, usage accumulation, `SIGTERM`→`SIGKILL` abort, temp-file lifecycle —
is exercised only by the e2e suite (not in `npm test`). This is the single
biggest coverage gap.

---

## 3. Top Issues Table

| Sev | File:Line(s) | Issue | Recommended Fix | Effort |
|-----|-------------|-------|-----------------|--------|
| **HIGH** | schema.ts:318 | `validateTaskflow` throws TypeError on `phases:[null]` — `filter(p=>p.final)` unguarded | Guard `p && p.final` or early-return on phase-shape error | S |
| **HIGH** | runtime.ts:218–235 | Abort-after-entry crash: `last` undefined → `_attempts` write to undefined, uncaught; also hits non-fanout layers wider than concurrency | Guard `last` before write; wrap entry in try/catch | S |
| **HIGH** | agents.ts:58 (parseFrontmatter) | Unguarded YAML parse throws on bad frontmatter; `discoverAgents` runs outside `runFlow`'s try block → one bad `.md` breaks every run | try/catch in `parseFrontmatter` call; move `discoverAgents` inside try | S |
| **HIGH** | store.ts:127,147 | Non-atomic `writeFileSync` for `saveFlow`/`saveRun` corrupts persisted state on crash/concurrent write | Write to tmp file + `renameSync` | S |
| **MED** | runtime.ts:572–715 | `executeTaskflow` has no try/catch; thrown phase leaves `status:"running"`, no terminal persist → resume broken | Wrap body in try/catch that writes terminal state | M |
| **MED** | runtime.ts:93,235 | `_attempts` smuggled via cast onto `RunResult` — also the crash vector | Add typed optional `attempts` field to `RunResult` | S |
| **MED** | runtime.ts:54 | Internal `_stack` recursion state leaks into public `RuntimeDeps` | Pass as separate parameter: `executeTaskflow(state, deps, stack=[])` | S |
| **MED** | runtime.ts:328 | `map` rebuilds full interpolation context per item → O(items×phases) object churn | Build `steps` base once, spread per-item locals | S |
| **MED** | runtime.ts:42/457 + index.ts:~181 | Top-level `onProgress` unused in prod; **but** flow-branch callback is load-bearing for sub-flow live progress | Keep flow bridge; remove top-level `onProgress` plumbing; document "poll RunState" | M |
| **MED** | runner.ts:262–265 | SIGKILL dead code (`proc.killed` is true post-SIGTERM per Node docs) | Track real exit via `close`/`exitCode` | S |
| **MED** | runner.ts:268 | Abort listener leaks on the shared signal across normal completions | Remove listener in `close` handler | S |
| **MED** | runner.ts:257 | Spawn error swallowed | Capture `err.message` into `stderr`/`errorMessage` | S |
| **MED** | index.ts:261,327 | `onUpdate as any` defeats type-checking at main seam | Align `runFlow` param type to match `onUpdate` from pi API | S |
| **MED** | index.ts:307–313 | Saved `/tf:<name>` shortcut silently no-ops when busy (no notify) | Add `else notify` matching the `run` path | S |
| **MED** | index.ts:203–217 vs 305–316 | Duplicated shortcut registration + run-prompt string (recurves ~4×) | Extract `sendRunMessage(name, args)` helper | S |
| **MED** | interpolate.ts:379–381 (callsite runtime.ts:624) | `evaluateCondition` discards parse `error`; malformed `when` fails open AND silently | Surface the error (even if fail-open) via `_conditionErrors` or log | S |
| **MED** | schema.ts:118 vs 233 | `TaskflowSchema` never enforced at runtime; `define` is `Type.Unknown` → retry bounds, `additionalProperties:false` live only in code | Run `Value.Check` or document "schema is documentation only" | M |
| **MED** | schema.ts:233–322 | `validateTaskflow` high cyclomatic complexity (single monolithic function) | Extract per-type + retry validation helpers | M |
| **MED** | store.ts:171,176 | Unvalidated `JSON.parse` pushes into runs array; `updatedAt` may be NaN → nondeterministic sort | Validate shape; guard sort comparator | M |
| **MED** | store.ts:82,153,171 | On-disk JSON cast to typed interfaces with no runtime validation | Add structural validation or schema version stamping | M |
| **MED** | store.ts:85-87,102-104,154-156,172-174 | Error swallowing conflates ENOENT with corrupt/parse failures; `loadRun` null on corrupt → silent resume failure | Separate catch branches | S |
| **MED** | store.ts:146 | `saveRun` mutates caller's object via `state.updatedAt =` as hidden side-effect | Clone or return new object | S |
| **MED** | render.ts:26 | `i.color as any` defeats theme-color type-check | Type ICON values as `ThemeColor` | S |
| **MED** | render.ts:114–200 | `phaseDetail` high cyclomatic complexity | Split per-status into helpers | M |
| **MED** | runs-view.ts:65,76,80 | Empty `runs[]` → `%0`=NaN / `undefined.status` crash | Guard empty array at top of `render()` | S |
| LOW† | Various | Magic numbers, `as any` / unchecked casts, duplication, dead code, correctness-adjacent nits | See validated master list in audit gate | S–M |

† Low items are grouped in §4 (Code-Smell Themes). All are genuine nits, not
  hallucinations — every `file:line` was verified against source.

---

## 4. Code-Smell Themes

### Unsafe casts (`as any`, non-null `!`, unchecked `as`)

| Location | Pattern |
|----------|---------|
| runner.ts:79,224,233-235 | `as any` / cast to `RunResult & {_attempts}` |
| index.ts:261,327,290,308-313,333-354 | `onUpdate as any`, unchecked `as` on parsed JSON |
| render.ts:26,177 | `as any` on theme color |
| schema.ts:165-318,385,400 | Unchecked `as` casts, non-null `!` assertions |
| store.ts:82,153,171 | `JSON.parse(raw) as Taskflow` / `as RunState` — no validation |

**Fix:** Narrow types or add union discriminators rather than escaping the type
system. At minimum, a `satisfies` guard on the external-to-internal boundaries.

### Magic numbers (no named constants)

| File | Values |
|------|--------|
| runtime.ts | 8 (concurrency), 60000 (backoff cap) |
| runner.ts | 5000 (SIGKILL timeout), 48 (tool arg truncation) |
| index.ts | 1000 (persist throttle), 120 (heartbeat), 280 (approval truncation) |
| store.ts | 24 (runId name length), 3 (randomBytes) |
| render.ts | 52, 56, 44, 88 (various truncation widths) |
| runs-view.ts | `width - 18` (inline layout math) |

**Fix:** Extract `DEFAULT_CONCURRENCY`, `MAX_BACKOFF_MS`, `PERSIST_THROTTLE_MS`,
`HEARTBEAT_MS`, etc. into a `constants.ts` or top-of-module `const` block.

### Duplicated logic (same algorithm, multiple copies)

| Algorithm | Locations |
|-----------|-----------|
| `resolveArgs` / `resolveDeclaredArgs` | index.ts:89 vs runtime.ts:125 |
| `sanitizeName` (safe-name regex) | store.ts:125,139 + runner.ts:88 + runsDir |
| `compactUsage` / `liveUsageStr` | render.ts:65–82 (two very similar functions) |
| Status-count iteration | render.ts:101–108 vs 203–207 |
| Fan-out progress rendering | render.ts:132–168 (three branches of same pattern) |
| Resume block in runs-view | runs-view.ts:65–67 vs 87–89 |
| Shortcut registration + run-prompt | index.ts:203–217 vs 305–316 |

**Fix:** One shared helper per algorithm. Most are pure functions with no
module-specific deps.

### Dead or over-engineered code

| Item | Evidence |
|------|----------|
| `formatUsage` (runner.ts:328) | Exported, 8 tests, **zero** non-test callers. `render.ts` uses its own `compactUsage`/`liveUsageStr` |
| `UsageStats` owned by runner.ts | Persistence (store.ts) and TUI (render.ts) import it from the I/O module — inverted ownership |
| `aggregateUsage` omits `contextTokens` | Always 0 in aggregate (no justification in comments) |
| `withFileMutationQueue` on unique tmp path | runner.ts:113–118 — queue adds no value for one-off temp files |
| Dead `??` fallback (store.ts:123) + `!` (store.ts:134) | Behind boolean-trap `findProjectFlowsDir(..., true)` |
| `listRuns` parses every file regardless of `limit` | Reads N files, only returns limit — wasteful for large run dirs |
| `onProgress` / `emitProgress` callback chain | Plumbed through dozens of sites; unused in production (heartbeat polls mutated state) |

**Fix:** Delete `formatUsage` (+ its tests), move `UsageStats` to `usage.ts`,
remove the dead `??`/`!`, and consolidate progress to one mechanism.

### Correctness-adjacent lows

| Issue | File:Line | Risk |
|-------|-----------|------|
| `getFinalOutput` returns only first text part | runner.ts:62–69 — loses later text parts in multi-part messages |
| `safeParse` not truly brace-balanced | interpolate.ts:122–138 — finds first `[`/`{`, last `]`/`}`; mismatched nesting parses wrong slice |
| Lexicographic fallback in `compare` | interpolate.ts:269–280 — `"100" < "9"` is `true` |
| Non-chainable comparison chain | interpolate.ts:322–333 — cannot write `a < b < c` |
| `lastCompletedOutput` depends on dep declaration order | runtime.ts:519–525 — walks deps in reverse; if upstream phases aren't in `dependsOn`, picks last of all completed phases |
| `finalPhase` unsound return type on empty | schema.ts:409 — returns `Phase` but can return `undefined` for `phases:[]` (caught in validation, but TS doesn't know) |
| `readStep` silent coercion | schema.ts:174,176 — non-string `task` becomes `"undefined"` or `"null"` |
| `parseArgsString` drops malformed JSON **and passes valid non-object JSON typed as Record** | index.ts:487–496 — `[1,2]`, `42`, `"x"` returned as `Record<string,unknown>` → typed but wrong |
| Name+shorthand conflict silent | index.ts:270–291 — `define` with name matching a saved flow silently overrides without warning |
| `finalResult` header/body phase mismatch | index.ts:380 — labels `--- ${fp.id} ---` but `executeTaskflow` may have fallen back to a *different* phase for `finalOutput` |
| `PLACEHOLDER` regex only matches `[A-Za-z0-9_.]` | interpolate.ts:21 — hyphenated names (e.g. `my-arg`) silently never interpolate |

---

## 5. Prioritized Action Plan

### 🔴 Do these first (the four HIGH bugs + the two MED enablers)

1. **`schema.ts:318` — Guard null phases in `validateTaskflow`**
   - Change `p.final` to `p && p.final` (or filter out non-objects before the loop)
   - Add regression test: `validateTaskflow({name:"x", phases:[null]})` must return error, not throw
   - **Effort:** 10 minutes. **Why first:** It's a TypeError on well-formed LLM output.

2. **`runtime.ts:233` — Fix abort crash in `runOne`**
   - Guard `if (!last) return { /* error result */ }` before the `_attempts` write
   - Consider wrapping `executeTaskflow` body in try/catch (see #5)
   - Add regression test: abort signal pre-set + `mapWithConcurrencyLimit` > concurrency
   - **Effort:** 15 minutes. **Why second:** Crashes the entire run on any abort.

3. **`agents.ts:58` — Guard `parseFrontmatter` + move `discoverAgents` inside try**
   - Wrap the `parseFrontmatter` call in try/catch (skip bad files)
   - Move `discoverAgents` inside `runFlow`'s try block
   - **Effort:** 10 minutes. **Why third:** One bad agent `.md` = all taskflows broken.

4. **`store.ts:127,147` — Atomic writes for `saveFlow`/`saveRun`**
   - Write to `path + ".tmp"`, then `fs.renameSync(tmp, path)` (rename is atomic on same filesystem)
   - **Effort:** 10 minutes. **Why fourth:** Corrupts the resume mechanism on crash.

5. **`runtime.ts:572–715` — Wrap `executeTaskflow` in try/catch** (MED)
   - On thrown error: mark `state.status = "failed"`, call `deps.persist?.()`, return error result
   - **Effort:** 15 minutes. **Why now:** Without this, any uncaught throw leaves `status:"running"` and resume is silently broken. Also provides a safety net for the four HIGH bugs above.

6. **`runtime.ts:93,235` — Typed `_attempts` on `RunResult`** (MED)
   - Add optional `attempts?: number` to `RunResult` interface in `runner.ts`
   - Remove the type-unsafe cast
   - **Effort:** 5 minutes. **Why now:** The crash vector for #2; also makes the retry API honest.

### 🟡 Medium-priority structural improvements

7. **Extract + test `processLine` from `runner.ts`**
   - Make event-folding a pure function: `foldEvents(lines): {messages, usage, model, stopReason}`
   - Unit-test against canned NDJSON fixtures (malformed lines, partial buffers, usage math)
   - **Effort:** 1–2 hours. **Why:** Closes the single biggest coverage gap.

8. **Refactor `executePhase` from `if`-chain to dispatch table**
   - Introduce `PhaseHandler = { prepare, run }` map keyed by phase type
   - Shared `prepare()` returns `{ctx, text, inputHash, cachedOrNull, liveSink}`, collapsing ~120 lines of duplication
   - **Effort:** 2–3 hours. **Why:** Makes "add an 8th phase type" a localized change.

9. **Consolidate progress mechanism (drop top-level `onProgress`, keep flow bridge)**
   - Remove `onProgress` from `RuntimeDeps` interface; document "poll `RunState.phases`"
   - Keep the flow-branch `onProgress` as a local callback (it's load-bearing for sub-flows)
   - Remove all `emitProgress()` and `deps.onProgress?.(state)` calls at the top level
   - **Effort:** 30 minutes. **Why:** Eliminates the clearest case of accidental redundancy.

### 🟢 Quick cleanup (Low, grouped)

10. **Delete dead `formatUsage` + its tests** | Move `UsageStats` to `usage.ts`
11. **Extract shared constants** (concurrency, timeouts, throttles)
12. **Unify duplicated helpers** (`resolveArgs`/`resolveDeclaredArgs`, `sanitizeName`)
13. **Separate catch branches in `store.ts`** (ENOENT vs parse failure)
14. **Guard empty `runs[]` in `runs-view.ts`**
15. **Fix `finalResult` header/body phase mismatch** (return resolved final phase id)

---

## 6. Explicitly Do-NOT-Do

These tempting refactors would violate the lightweight ethos or introduce risk
without commensurate benefit:

- **Do not split `runtime.ts` into 5+ files.** The request to extract gate
  parsing, budget, and retry into siblings is correct (target ~400 LoC), but
  stopping there is important. The module count (9) is already right for the
  scope. Over-splitting would make the codebase harder to navigate, not easier.

- **Do not replace the heartbeat poll with `onProgress` push.** The heartbeat
  (120ms interval, `setInterval`, `unref()`) is a simple, reliable, and
  correctly-throttled mechanism. Replacing it with a callback chain that fires
  on every sub-item event would create frame-rate problems and add complexity
  with zero user-facing benefit. Keep the poll.

- **Do not add a full runtime validation library.** Running `Value.Check` from
  TypeBox on every `saveFlow` call is worthwhile (one line), but adding Zod or
  a full validation framework "in case of schema drift" is premature. The LLM
  produces the DSL; the validation in `validateTaskflow` is sufficient.

- **Do not make `store.ts` async.** `writeFileSync` with tmp+rename is
  atomic enough for the pi extension lifecycle (one tool call per run).
  True async persistence buys nothing here.

- **Do not add a `schemaVersion` to `RunState` yet.** There is no schema-evolution
  story (no field has been renamed since v0.0.1). Stamp it in v0.1.0 before the
  first rename. For now, just note the risk.

- **Do not extract `DEFAULT_CONCURRENCY` to a shared constants file.** It would
  be imported by schema.ts and runtime.ts — fine for a value they both share —
  but the other magic numbers (truncation widths, throttle intervals) are
  single-module concerns and should stay as top-level `const` in their module.
  A shared constants file is a trap that grows unboundedly.

---

## 7. Follow-up — Resolved (post-audit refactor)

The four HIGH bugs and two MED enablers were fixed in a prior pass; this pass
landed the high-value structural refactors (all behavior-preserving, verified by
an adversarial dogfood gate + the test suite):

- **`usage.ts` leaf module (ownership inversion fixed).** `UsageStats`,
  `emptyUsage`, `aggregateUsage`, `formatTokens` moved out of `runner.ts` into a
  pure `usage.ts`. `store.ts` and `render.ts` no longer depend on the
  process-spawn layer. Dead `formatUsage` deleted.
- **`foldEventLine` extracted (coverage gap closed).** The in-spawn NDJSON
  accumulation became a pure `foldEventLine(acc, line)` + `newAccumulator(model)`
  in `runner.ts`, now unit-tested (`test/runner.test.ts`) against malformed
  lines, partial buffers, usage math, model precedence, and stop/error capture.
- **`resolveArgs` deduplicated.** The twin `resolveArgs`/`resolveDeclaredArgs`
  collapsed into one exported `resolveArgs` in `schema.ts` (tool-entry + flow
  sub-args share it), now unit-tested.
- **Single-agent branches merged.** `executePhase`'s `agent`/`gate`/`reduce`
  branches (which duplicated an identical live-update closure) collapsed into one
  path with a shared `liveSink` helper. Branch count 7 → 5.

Test count: 185 passing (was 182), typecheck clean.

### Deliberately deferred (lightweight-ethos / low ROI)

- Full `executePhase` dispatch-table/handler-map (the 3→1 merge captured most of
  the benefit at far lower risk).
- Consolidating the progress mechanism (drop top-level `onProgress`) — the flow
  bridge is load-bearing; churn outweighs benefit for now.
- Shared `constants.ts` and cross-module `safeName` — per §6, single-module
  magic numbers stay local to avoid an unbounded grab-bag module.
