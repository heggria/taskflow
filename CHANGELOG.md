# Changelog

All notable changes to pi-taskflow are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [0.0.27] — 2026-06-25

> Evidence release: **the incremental-recompute cost win is now proven, not
> asserted.** v0.0.25 made `/tf recompute` trustworthy and v0.0.26 made the
> dependency contract under it real — but the only cascade test re-ran *every*
> phase, so "rerun only what changed" had no regression proof. This release pins
> the two ways recompute actually saves money, closing the flagship's open
> acceptance criterion (the prerequisite for ever flipping recompute on by
> default).

### Added
- **Flagship cost-win tests** (`test/recompute.test.ts`):
  - **Partial cascade — `rerun < full`.** A diamond where one branch shares no
    edge with the changed seed proves the unrelated phase is *reused* (0 tokens),
    never re-run, and the rerun set is strictly smaller than the full flow.
  - **Early-cutoff propagation.** Re-seeding a phase whose output is unchanged
    cuts off its entire transitive downstream — only the seed spends a token,
    every descendant hits its cache. This is the "changed a file that didn't
    actually affect the result ⇒ near-zero rerun" guarantee.
- Tests: 802 → 804 (+2).

### Changed
- **README test count and feature line refreshed** (was stale at 702/34 files):
  now 804 tests across 42 files, with `incremental recompute` and
  `FlowIR compile seam` listed among the headline capabilities.

### Notes
- **Scope held deliberately.** Two further H2 ideas — flipping `run` to
  auto-recompute by default, and precise `ir-changed` / map item-level reuse —
  are *not* in this release. The first changes every user's `run` behavior
  (a kernel-level, post-M5 decision); the latter two are scoped-out in the
  roadmap (§6) as later RFCs. Shipping the proof first keeps each step
  independently releasable.

## [0.0.26] — 2026-06-25

> Foundation release: **the convergence roadmap's H1 lands** — a real FlowIR
> compile seam (M1), a declared dependency plane (M2), and a
> backward-compatible cache-key migration. v0.0.25 made incremental recompute
> *trustworthy*; this release makes the contract underneath it *real*: the
> recompute frontier now reasons over **observed ∪ declared** dependencies, the
> flow definition compiles through a typed IR surface instead of an inlined
> hash, and folding the definition into the cache key no longer evicts every
> pre-existing cross-run entry.

### Added
- **FlowIR compile seam (M1).** New `extensions/flowir/{index,translate,meta}.ts`
  exposes `compileTaskflowToIR(def) → { ir, meta, hash, usedFallbackHash,
  warnings, errors }` — a typed, never-throwing projection of a desugared flow
  into a content-addressed IR. The runtime now routes `flowDefHash` through this
  seam instead of inlining it. `translate` is currently a 1:1 stub projection
  (so `usedFallbackHash` is `true` and the hash equals the vendored
  `flowDefHash`); it becomes the genuine overstory compiler once that kernel is
  vendored, at which point the cache-key version advances `v2: → v3:`.
- **`/tf ir <flow>` command + `ir` tool action.** Renders the compiled IR plus
  its hash and any structured `CompileError[]` — zero tokens, no LLM.
- **Declared dependency plane (M2).** `compileTaskflowToIR` synthesizes per-phase
  `DeclaredDeps { reads, writes }` from interpolation refs
  (`task`/`over`/`when`/`until`/`eval`/`branches`/`with`/`context`) and
  `dependsOn`, attaches them to `ir.meta.declaredDeps`, and persists them to
  `RunState`. `/tf recompute` now computes its stale frontier over
  **union(observed ∪ declared)** rather than observed-only — a dependency that
  was declared but never interpolated at runtime is no longer missed.
- **Tests: 753 → 802** (+49) across new suites: `flowir.test.ts`,
  `flowir-declared.test.ts`, `stale-union.test.ts` (incl. a 500-iteration
  property test proving the union frontier is never narrower than observed-only),
  `recompute-union.test.ts`, `cache-migration.test.ts`, plus `e2e-flowir.mts`
  and `e2e-cache-migration.mts`.

### Fixed
- **Cache-key migration no longer evicts existing cross-run entries.** Folding
  `flowdef:` into the key previously invalidated every pre-existing cross-run
  cache entry on upgrade (a one-time miss-storm). `cacheKey` is now versioned
  (`v2:flowdef:`) with a **3-tier lookup**: new key → bare `flowdef:` key →
  legacy (no-flowdef) key. Old entries still hit for one release cycle; there is
  no write-through on a fallback hit (legacy entries age out naturally), and
  every tier still includes `flow:${name}` so two different flows can never
  collide.
- **Declared plane and recompute guard now see `loop.until` and `gate.eval`.**
  `collectRefs` skipped `until` (loop convergence) and `eval[]` (gate zero-token
  checks), so a dependency expressed only in those fields was absent from the
  declared plane and from the `dryRun:false` unobserved-dependency guard. Both
  are now scanned. (Closes the two MEDIUM findings from the H1 risk review.)

### Compatibility
- **Backward compatible.** `RunState.flowDefHash` and `RunState.declaredDeps`
  are optional — pre-0.0.26 run states load unchanged. A compile/hash failure
  fails open: `usedFallbackHash` stays set, cross-run cache is disabled for that
  run, and the key degrades to a flow-scoped (collision-free) form. The one
  observable change on upgrade is a single re-execution of in-flight phases
  whose stored `inputHash` predates the `v2:` prefix.

## [0.0.25] — 2026-06-24

> Correctness release: **incremental recompute is now trustworthy.** `/tf
> recompute` shipped in the prior line as a promising idea — force-rerun a seed,
> walk its stale frontier, let the cache cut off untouched downstreams. But the
> dependency graph it walked was a half-truth: reads observed only inside a
> `when` guard or an `eval` gate were never recorded, a loop that read its own
> output **deadlocked the scheduler**, and a `{previous.output}` chain could be
> silently skipped — each one a path where "only rerun what changed" quietly
> reused **stale** upstream state and returned a wrong answer that *looked*
> incrementally correct. This release closes all of them: the observed readSet
> is now complete, the recompute order unions declared **and** observed edges,
> and real (`dryRun:false`) recomputation refuses to run when it cannot prove
> the frontier is sound. The headline feature finally earns its safety claim —
> the difference between *looks* incremental and *provably* incremental.

### Added
- **Safety guard for real recomputation.** `recomputeTaskflow` with `dryRun:false`
  now refuses to run flows whose dependencies cannot be fully observed through
  the captured readSet: Shared Context Tree (`shareContext` / `contextSharing`),
  `flow` phases, `context:` file pre-reads, and interpolation placeholders such
  as `{previous.output}`, `{args.X}`, or `{item.X}`. This prevents silently
  reusing stale upstream state.
- **Regression tests** in `test/recompute.test.ts`:
  - observed-read edges still order recomputation even without an explicit
    `dependsOn` declaration;
  - `{previous.output}` chains are rejected for real recomputation;
  - `recomputeTaskflow` returns a fresh `RunState` and does not mutate the
    caller's state.

### Fixed
- **Loop self-read no longer deadlocks recompute.** A loop whose `until`
  condition references its own prior output (e.g. `{steps.refine.output}`)
  produced a self-edge in the observed-dependency graph, causing `topoLayers` to
  schedule the phase with a permanently non-zero indegree. `observedDeps()` now
  filters self-references so scheduling remains sound.
- **`when` condition upstream reads are captured.** Conditions are now evaluated
  inside `executePhaseInner` with the same `onRead` hook used by the phase task,
  so upstream refs observed only in a `when` guard are recorded in
  `PhaseState.reads`.
- **Gate `eval` upstream reads are captured.** The machine-check `eval` branch
  now receives the shared `onRead` hook, and the resulting readSet is persisted
  when an eval-only gate skips the LLM call.
- **Recompute topo-order now unions declared and observed edges.** Previously
  the recompute order only respected declared `dependsOn`, which could place a
  downstream phase before its observed-but-not-declared upstream refreshed and
  cause false early-cutoff. The scheduling graph now merges both edge sets.
- **Recompute no longer mutates the caller's RunState.** `recomputeTaskflow`
  clones the input state via `structuredClone` before modifying it.
- **Help text accuracy.** `/tf` command and tool-action descriptions updated to
  match the new `recompute` and provenance behavior.

## [0.0.24] — 2026-06-23

> Feature release: **`/tf compile`** — turn the declared DAG into a Mermaid
> diagram plus a verification overlay for 0 tokens. A picture of the plan, a
> structural audit of the plan, and a GitHub-pastable artifact — all from the
> same JSON.

### Added
- **`compile` action** for the `taskflow` tool and the `/tf compile <name>`
  command. Renders the flow as a Mermaid `flowchart`, overlays verification
  issues onto the nodes (red = error, amber = warning, green border = final),
  and emits a markdown document suitable for READMEs / issues / PRs.
- Distinct shapes for every phase kind: agent ▭, parallel/map/flow ⊐, reduce ▽,
  gate ◇, approval ⏸, loop ↻, tournament ⬡. Guards become edge labels;
  `join: "any"` becomes dotted edges.
- Reuses the existing `verifyTaskflow` graph analysis, so every dead-end,
  unreachable node, gate-exhaustion, budget overflow, concurrency warning, and
  guard contradiction is painted directly on the diagram.
- Zero runtime dependencies; the compiler is a pure function with no LLM calls.
- Tests: 670 → 702 (+32) in `test/compile.test.ts` — structural assertions on
  the emitted Mermaid tokens (no third-party parser dependency; render-
  correctness is validated by shape/edge/class assertions).

### Fixed
- **Id collisions no longer merge nodes.** Two distinct phase ids that
  sanitize to the same Mermaid token (e.g. `audit-each` and `audit_each`) are
  now disambiguated with a `_2` suffix instead of collapsing into one node with
  an accidental self-loop.
- **Markdown-injection hardening.** Free-form strings (flow name, description,
  verification messages) are neutralized before interpolation, so a
  multi-line / bracket-laden name can no longer break out of the H1 heading or
  spawn a second blockquote.
- **`/tf compile <name>` now schema-validates first**, matching the tool action
  — a malformed saved flow yields a clean error instead of a half-rendered
  diagram. An optional `lr`/`td` suffix selects diagram direction.
- Backslashes are now escaped inside Mermaid labels.

## [0.0.23] — 2026-06-11

> Feature release: the **Shared Context Tree** — an opt-in mechanism that gives
> subagents a horizontal blackboard and a vertical supervision tree, so fan-out
> items can reuse expensive context instead of re-reading it, and a node can
> delegate work at runtime and have its children report back. Validated with six
> real end-to-end runs (real `pi`, real models) including a recursive org tree
> and a large 5-way audit that converges through a loop + gate.

### Added
- **Shared Context Tree (opt-in).** Set `shareContext: true` on a phase (or
  `contextSharing: true` at the flow level) to give its subagent four extra
  tools backed by a per-run, file-based blackboard:
  - `ctx_write(key, value)` / `ctx_read(key?)` — a **horizontal blackboard**: a
    node publishes a finding; siblings/descendants reuse it (own > ancestors >
    completed-others on key conflict; a running sibling's half-written findings
    stay hidden). Stops fan-out items from re-reading the same files.
  - `ctx_report(summary, structured?)` / `ctx_spawn(assignments[])` — a
    **vertical supervision tree**: a node reports up, and delegates child work at
    runtime; the runtime runs each child (isolated) after the node finishes and
    folds their reports into the phase output.
  - New module `extensions/context-store.ts` reuses the run store's atomic-write
    + file-lock primitives (per-node findings files — no global lock contention).
  - All bookkeeping is **fail-open** (it can never sink a phase); the blackboard
    is size-bounded (256 KB/value, 256 keys/node), depth-capped (5), and cleaned
    up with the run. Fully backward-compatible: flows that don't opt in are
    byte-for-byte unaffected.
- **`ctx_spawn` accepts a sub-graph, not just flat tasks.** An assignment is now
  either `{task, agent?}` **or** `{subflow, defaultAgent?}` where `subflow` is an
  inline Taskflow (a dependency-bearing DAG with `map`/`gate`/`reduce`). The
  spawned subflow reuses the same `validateTaskflow` + `verifyTaskflow` +
  nested-`executeTaskflow` machinery as `flow{def}`; spawn-subflows and `flow{def}`
  share **one** `MAX_DYNAMIC_NESTING` counter (a `def:spawn-*` `_stack` frame), and
  spawned child token/cost usage is folded into the parent phase for honest budget
  accounting. A bad subflow fails open with a diagnostic.
- **Tests: 608 → 670** (+62) across 33 files, incl. `context-store`,
  `context-tree`, `spawn-xor`, `spawn-subflow`, `spawn-subflow-nesting`,
  `workspace`, `workspace-isolation`.
- **Workspace isolation (`cwd` keywords).** A phase's `cwd` now accepts three
  reserved keywords that make the runtime allocate an isolated working directory
  for the phase's subagent and tear it down afterwards:
  - `"temp"` — an ephemeral dir under the OS tmpdir, removed when the phase ends.
  - `"dedicated"` — a persistent dir under the run state
    (`runs/ws/<runId>/<phaseId>`), kept for inspection and deterministic per
    phase so a **resume reuses the same dir**.
  - `"worktree"` — a real `git worktree` on a throwaway branch off `HEAD`,
    removed (`git worktree remove --force` + branch delete) when the phase ends;
    for changes you want to diff / commit / discard in isolation.
  - New module `extensions/workspace.ts` (zero deps: `fs.mkdtemp` + `git` via
    `child_process`). **Fail-open**: a failed allocation degrades to the base
    cwd (`worktree`→`temp` when not a git repo) and records a `warnings`
    diagnostic — a phase never fails to run because of isolation. **Security**:
    the keywords are rejected at validation in LLM-authored sub-flows
    (`flow{def}` / `ctx_spawn` subflow) so generated plans cannot allocate
    worktrees or temp dirs that mutate the repo. A literal path is passed
    through unchanged (fully backward-compatible).

### Fixed
- **`map` / `parallel` fan-out items that call `ctx_spawn` were silently
  orphaned.** The post-run spawn-drain only covered single-agent/`gate`/`reduce`
  phases (keyed on the base phase id), but fan-out items run with suffixed node
  ids (`audit-0`…`audit-4`) and were never drained — their queued children never
  ran (5 orphaned intents, 0 children, in a real e2e). Each fan-out item now
  drains its own node and runs + folds its spawned children (reports + usage),
  fail-open. Regression test added.
- **Workspace override no longer leaks across isolation boundaries** (found by
  the pre-release adversarial review). `runInlineSubflow` and the gate
  `onBlock:retry` upstream re-execution both spread `...deps` without clearing
  the parent's `_cwdOverride`, so a spawned subflow / re-run upstream dep could
  be force-pinned to the parent phase's isolated dir. Both now strip the
  override (a spawned subflow still inherits the parent's dir as its *base* cwd,
  consistent with `flow{def}`, but no longer ignores an inner phase's own cwd).
  The triplicated `effCwd` formula was extracted into one `resolveEffCwd()`
  helper (the divergence was the root cause). `runs/ws/` dedicated-workspace
  dirs are now reclaimed by the terminal-run cleanup, and `rmrf()` gained a
  path-containment guard (defense-in-depth).

## [0.0.22] — 2026-06-10

> Dogfooding release. The `dogfood-full` self-audit taskflow (which itself
> exercises all 9 phase types + when/join/retry/budget/cache/eval/flow-def/
> loop/tournament/approval) ran against the codebase and surfaced these fixes.

### Added
- **Live auto-refresh for the `/tf runs` panel.** The run-history panel was a static snapshot taken when opened, so a background (detached) run's progress never updated while watching. It now polls run state on a 1s interval and re-renders only when a run's status/`updatedAt` actually changes — phase progress (including `map`/`parallel` `subProgress` like `24/24`) updates live. The user's selection follows the same `runId` across refreshes, a green `● live` tag shows while any run is running, and the refresh timer is cleared on close (`dispose()`) and `unref`'d so it never keeps the event loop alive. Fully backward-compatible: without live hooks the panel renders statically as before.
  - 5 new tests (`test/runs-view.test.ts`): refresh-on-change, no-render-when-unchanged, dispose-stops-timer, selection-follows-runId, back-compat-no-hooks.

### Fixed
- **`safeParse` now prefers a `json`-tagged fence in multi-fence output.** When an LLM phase emitted an evidence block (e.g. ```` ```typescript ````) *before* the ```` ```json ```` payload, the old single-match regex grabbed the first fence, failed to parse, and the balanced-bracket fallback was misled by braces in the prose — `safeParse` returned `undefined` and any downstream `map` phase failed with `'over' did not resolve to an array`. It now scans every fenced block and tries `json`-tagged ones first, then untagged. (3 new multi-fence tests.)
- **Unresolved interpolation refs are surfaced as phase warnings.** `interpolate()` returns `missing[]` (placeholders with no source), but the runtime discarded it on the main task path — so `{args.typo}` or a `{steps.x.output}` without `dependsOn` was silently left intact in the dispatched task. The `interpolate.ts` doc comment promised "a recorded warning" that no code produced. The runtime now logs `[taskflow] phase X: unresolved refs ...` and attaches the message to `PhaseState.warnings` (persisted in the run record, visible in `/tf runs`). Doc comment corrected to match.

## [0.0.21] — 2026-06-10

### Added
- **Per-step context pre-read in shorthand modes.** Single, chain, and tasks shorthand steps now accept `context` (file paths) and `contextLimit`, desugared directly onto the generated phases. This eliminates `O(N²)` file exploration without writing the full DSL. In parallel `tasks` mode all branches share the deduped union of step contexts; chain steps each carry their own context. A top-level `context` in chain mode produces a warning (no unsupported flow-level default). Context-file changes automatically invalidate phase caches.

### Fixed
- **Headless approval safety.** Approval phases now auto-reject (not auto-approve) when running in detached/background/CI mode, preventing silent bypass of human gates.
- **Step-reference validator accepts transitive ancestors.** The step-reference checker previously raised false positives on valid DAGs where dependencies span multiple levels of ancestry. Ancestor transitive closure is now fully resolved.

## [0.0.20] — 2026-06-10

### Added
- **Background (detached) execution — `detach: true`.** Run a taskflow in a detached child process without blocking the current session. Pass `detach: true` and get a `runId` back immediately; the flow executes in the background, persisting state to the store. Status polled via `/tf runs` and `resume` works as normal.
  - `extensions/detached-runner.ts` (new): lightweight child-process entry script — reads serialized context, calls `executeTaskflow`, persists terminal state.
  - `extensions/index.ts`: `detach: Boolean` parameter on the taskflow tool + child-process spawn logic (records PID in `RunState`).
  - `extensions/store.ts`: `RunState` gains `pid?: number` + `detached?: boolean` fields; `isProcessAlive(pid)` stale-PID helper.
  - Design: entry-point spawn wrapper — zero changes to the 1340-line `runtime.ts` core, no new phase type, no DSL version bump, fully backward-compatible.
  - Approval phases auto-reject in background mode. Idle watchdog kills stalled children. Stale PID detection via signal-0 probe.
  - 8 new tests (`test/detached.test.ts`): process-alive, PID persistence, end-to-end detached, crash→failed, resume after failure, stale PID, backward compat.

### Fixed
- `approvalView` initialization robustness: throws a clear error when the approval view module is unavailable, preventing silent failures in detached/background mode.

## [0.0.19] — 2026-06-10

### Documentation
- **Closed the SKILL coverage gap — the LLM can now author every shipped feature.** A schema-vs-SKILL.md audit (`docs/internal/skill-coverage-audit.md`, machine-checked + cross-adversarial reviewed) found several implemented + tested features that were undocumented in the LLM-facing skill, so the model never generated them. All ~46 user-facing schema fields are now documented across SKILL.md + configuration.md.
  - **SKILL.md**: phase-type table now lists all 9 types (added `loop`, `tournament`) with a “details” column pointing each to its section; new **Loop phases** (`until`/`maxIterations`/`convergence`) and **Tournament phases** (`variants`/`judge`/`mode`/`judgeAgent`) sections; `eval` (zero-token machine gate) and `onBlock: "retry"` (self-healing rework loop) folded into the Gate section; cross-run `cache` pointer + `optional` + static `branches` notes.
  - **SKILL.md**: new **Operating a run** section — run lifecycle (`running → completed/blocked/failed/paused`), cache-aware resume, when to resume vs. re-run, budget-mid-run behavior, and run inspection. Clarified action semantics (`define` vs `name`, save scope/collision, `verify`/`agents` actions).
  - **configuration.md**: new **§2.1 Context pre-reading** (`context`/`contextLimit` — resolution order, per-file 8000-char cap, 200k total cap) and **§8 Cross-run caching** (`cache.scope`, `ttl`, full `fingerprint` prefix table for git/glob/glob!/file/env). Fixed a stale “5 phase types” → 9 cross-file drift.
- Every documented JSON example validates against the live schema; all run-status/resume claims verified against the runtime (`blocked` is terminal; `paused`/`failed` are resumable). 560 tests pass, zero regression.

### CI
- GitHub Packages publish is now best-effort (`continue-on-error`) so an unscoped-package 404 there can never block the npm publish or the GitHub Release.

## [0.0.18] — 2026-06-09

### Added
- **Runtime dynamic sub-flows — `flow { def }`.** A `flow` phase may now carry an inline `def` (mutually exclusive with `use`) that is resolved at runtime — typically from an upstream phase's JSON output (`"def": "{steps.plan.json}"`) — validated, verified, and executed as a nested sub-flow. This is the declarative answer to code-mode `for`/`if`: a planner decides *at runtime* what work to spawn, and every generated plan is structurally checked (cycles / dangling refs / duplicate ids / dead-ends) before it spends a token.
  - Accepts a full Taskflow `{name,phases}`, a bare `phases` array, or `{phases:[...]}` (markdown ```json fences tolerated). Pure data — no `eval`.
  - **Iterative replanning**: pair with `loop` so round N's plan depends on round N-1's *result* (not a one-shot fan-out).
  - **Fail-open**: a malformed/invalid/unverifiable def never aborts the run — the phase resolves as a no-op with a `defError` diagnostic and upstream output is preserved. An empty `phases` array is a valid no-op.
  - New examples: `examples/dynamic-plan-execute.json`, `examples/iterative-replan.json`.

### Security
- **Hardening for runtime-generated (untrusted) sub-flows**, enforced only when content is LLM-authored:
  - Breadth caps: `MAX_DYNAMIC_PHASES` (100), `MAX_DYNAMIC_CONCURRENCY` (16, flow- and phase-level), `MAX_DYNAMIC_MAP_ITEMS` (200, fan-out truncated not blocked).
  - `cwd` containment: a generated phase cannot escape the run directory.
  - Budget clamp: a generated def's budget is clamped to `min(child, parent)` per dimension — it can only ever be tighter, never looser.
  - Nesting cap: `MAX_DYNAMIC_NESTING` (5) bounds inline self-spawning depth.
  - Prototype-pollution defense: inline defs are deep-cloned and `__proto__`/`constructor`/`prototype` own-keys are stripped.
- Authored/saved flows (`use`) are unchanged and not subject to these dynamic caps.

### Notes
- 25 new tests (`test/flow-def.test.ts`); 560 total, zero regression. Design + two-round cross-adversarial review (engineering-risk / design-critic / architecture / security) recorded under `docs/internal/`.

## [0.0.17] — 2026-06-09

### Fixed
- **28 fixes from 3-round adversarial dogfooding across 11 files.**
- **store.ts**: validateRunId path-traversal guard in saveRun, cleanupTerminalRuns race condition mtime guard, saveFlow file locking (prevents concurrent write loss), saveFlow unified sanitization via safeFlowDirName, SharedArrayBuffer hoisted to module scope, empty flow name rejection, conditional .pi/ creation hint.
- **runner.ts**: signal kill detection (killedBySignal), idle timeout excluded from transient error retry, message cap (500) with truncation notice, stderr cap (64KB) with truncation notice.
- **runtime.ts**: loop abort semantics (stop: "aborted"), failed phase interpolation (sensible placeholder instead of raw template), tournament judge budget/abort guard, retry factor asymmetry documentation.
- **interpolate.ts**: tokenizer escaped quote handling (character-by-character loop), graceful dig() trailing path segment resolution.
- **index.ts**: /tf save and /tf verify tab completion, JSON string define parsing in renderCall label, escaped quote handling in parseArgsString.
- **agents.ts**: YAML tools type validation (reject non-string/array), atomic writeFileAtomic in syncBuiltinAgentsToProject.
- **cache.ts**: 30s timeout on execFileSync git calls.
- **verify.ts**: budget maxUSD overflow detection.
- **render.ts**: consistent numerator/denominator in summarizeRun.
- **runs-view.ts**: timeAgo negative timestamp guard, blocked status removed from isResumable.

## [0.0.16] — 2026-06-09

### Added
- Built-in agents configurable via `/tf init` — customize model role, thinking level, and tools per agent.
- Community PR support: `feat/configurable-builtin-agents` (thanks @yolonir).
- Multi-language READMEs: 简体中文, हिन्दी, Español, العربية, বাংলা, Português, Русский.
- `AGENTS.md` project guide — agent pipeline rules, review routing, executor selection, escalation paths.
- GitHub issue templates (bug report + feature request) and PR template.

### Changed
- Social preview OG image for npm/ GitHub card.
- Internal docs reorganized under `docs/internal/` for clean project root.
- Run cleanup made configurable with `.pi/` creation notification.
- npm tarball slimmed — only essential files shipped.

### Tests
- 10 previously uncovered critical code paths covered (runtime branches, interpolate edge cases, transient error heuristics, store concurrency).
- Total: **524 tests** (was 394).

## [0.0.15] — 2026-06-09

### Added
- Built-in agent auto-sync to project `.pi/agents/` — first-class community collaboration.
- Tool description updated: `taskflow` now replaces `subagent` as the recommended delegation API.

### Changed
- Multi-language READMEs completed with >2% native-speaker coverage (7 languages).

## [0.0.14] — 2026-06-08

### Added
- Static DAG verification (`verify.ts`) — dead-end detection, gate exhaustion, ref integrity, concurrency warnings, guard contradictions — all computed at 0 tokens before a single agent runs.
- `onBlock: "retry"` — retry upstream phases when a gate blocks, instead of halting the run.
- Declarative eval gates — machine-checkable criteria that run *before* the LLM gate.
- Budget and idle-watchdog guards on `onBlock:retry` loops + nested recursion depth cap.

## [0.0.13] — 2026-06-07

### Added
- `loop` phase — iterate a task until a condition, convergence, or cap.
- `tournament` phase — best-of-N with a judge (or aggregate mode).
- Cross-run memoization (`cache: { scope: "cross-run" }`) with git/file/glob/env fingerprints, TTL, and LRU eviction.
- Interactive `/tf init` with action menu, role-aware model pickers, diff preview, and atomic merge-write.
- 18 built-in agents with 6 model roles (`{{fast}}`, `{{strong}}`, `{{thinker}}`, `{{arbiter}}`, `{{vision}}`, `{{reasoner}}`).

### Fixed
- P0 cache-key correctness after adversarial cross-review.
- `/tf init` compile error and custom model registry validation.
- Multi-agent review must-fixes (F1 label parse, F5 missing modelRoles).

## [0.0.12] — 2026-06-05

### Added
- Model role system with `/tf init` interactive setup.
- Per-phase `model`, `thinking`, `tools` overrides.

## [0.0.11] — 2026-06-04

### Added
- Full control-flow & reliability layer: `when` guards, `join: any` OR-joins, `retry` with backoff, `approval` human-in-the-loop, `flow` sub-flow composition, `budget` caps.
- Idle watchdog (kills wedged subagents after 5 minutes of silence).
- Transient error auto-retry (rate-limit / 5xx / timeout).

### Changed
- README rewritten as flagship landing page with hero flow diagram and competitive comparison.

## [0.0.10] — 2026-06-03

### Added
- Live DAG render with timing, cost, and sub-task progress in the TUI.
- `approval` phase type (approve / reject / edit).
- Cross-session resume with per-phase input-hash caching.

## [0.0.9] — 2026-06-02

### Added
- `map` phase dynamic fan-out over JSON arrays.
- `reduce` phase aggregation.
- `gate` phase with `VERDICT: PASS / BLOCK` parsing.
- `/tf:<name>` command shortcuts for saved flows.

## [0.0.8] — 2026-06-01

### Added
- 13 dogfooding fixes + 6 meta-bug hardening.
- Run state storage: per-flow subdirectories, index, file lock, TTL cleanup.
- Agent availability query command + unknown-agent runtime degradation.

### Fixed
- Stalled subagent kill and negative-timer freeze.
- Index concurrency lock + stale-lock atomic preemption + flowName path-escape hardening.

## [0.0.7] — 2026-05-31

### Fixed
- 11 critical defects from adversarial review batch fix.

## [0.0.6] — 2026-05-30

### Added
- Structural refactor of control flow and reliability features.
- Self-audit and repair loop.

## [0.0.5] — 2026-05-29

### Added
- Shorthand modes (`task`, `tasks`, `chain`) — same shape as the built-in subagent tool.
- `/tf save`, `/tf list`, `/tf show` commands.

## [0.0.4] — 2026-05-28

### Added
- Initial DSL: `agent`, `parallel` phases.
- `{args.X}`, `{steps.ID.output}`, `{previous.output}` interpolation.
- DAG validation: cycle detection, reference soundness.

## [0.0.3] — 2026-05-27

### Added
- Inline flow execution via `taskflow` tool.
- Run state persistence for resume.

## [0.0.2] — 2026-05-26

### Added
- Extension scaffolding: tool registration, command registration, agent discovery.

## [0.0.1] — 2026-05-25

### Added
- Initial release. Declarative DAG orchestration for Pi subagents.
