# Changelog

All notable changes to taskflow are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [0.2.1] — 2026-07-13

### Added

- **Typed invocation arguments.** Flows may declare `string`, `relative-path`,
  `number`, `boolean`, and `enum` args. Defaults and invocation values are
  validated, and typed `required: true` is enforced at invocation boundaries.
  Legacy untyped `required` declarations remain advisory for compatibility.
- **Experimental, default-disabled dynamic-cwd compatibility bridge for #70.** An author-written phase
  may use an exact `cwd: "{args.package}"` when `package` is declared as a typed
  `relative-path`. Values are portable relative paths, resolved from the
  invocation root, must name an existing directory, and are checked after
  `realpath` so `..` and symlink escapes fail closed at bind time. Concatenation,
  `{steps.*}`, undeclared/legacy args, absolute paths, and generated sub-flows
  remain rejected. Canonical FlowIR records a logical read-write,
  existing-directory `cwdUse`, never the machine path.
- **Partial Workspace Capability control-plane scaffold.** Internal host-neutral
  authority, path-resolution, lease, journal, mutation-permit, sandbox-policy,
  and exact conformance-baseline contracts support the future native backend
  without becoming public root-package API in this patch release.
  This does not ship a native `WorkspaceExecutionBackend` or race-free
  `FileBroker`; 0.2.1 execution remains explicitly `resolve-only`.

### Changed

- The cwd bridge is **disabled by default** until a sandbox backend passes the
  Workspace Capability RFC's host conformance gates. A host operator can opt
  into the explicitly weaker resolver-only mode with
  `TASKFLOW_CWD_BRIDGE_MODE=resolve-only`; every affected phase reports that
  the directory is not a filesystem sandbox.
- Argument-selected cwd phases reject `retry.max > 0`. A failed resolve-only
  writer may already have mutated files, so Taskflow records `dirty-unknown`
  and requires explicit workspace reconciliation instead of replaying side
  effects automatically.
- Pi (`action: "reconcile-workspace"`, `/tf reconcile-workspace --ack`) and all
  MCP hosts (`taskflow_reconcile_workspace`) expose that deliberate recovery
  operation. It takes an exclusive whole-root lease, writes a durable reconcile
  record, and advances generation; it never restores or silently approves files.
  Model-callable recovery also requires the host-only
  `TASKFLOW_WORKSPACE_RECONCILE_MODE=explicit` switch, which is stripped from
  subagent environments. The Pi slash command is a direct user control-plane
  action and does not require the switch.
- Cwd-bridge flows disable output-only cache/resume reuse across their reachable
  nested flow tree. This prevents a cache hit from skipping workspace mutations
  before workspace-state restoration exists.
- Saved-flow definitions are snapshotted once per top-level execution, and
  bridge runs persist the invocation root's canonical path/device/inode identity.
  Resume fails closed if the root is rebound or a child gains cwd authority.
- A bridge-selected sub-flow inherits a non-expanding canonical cwd boundary:
  nested literal cwd and context pre-reads may narrow it but cannot escape it
  lexically or through symlinks; allocating a workspace provider is rejected.
- Relative literal phase cwd values and phase context files are now anchored to
  the Taskflow invocation cwd rather than the parent Node process cwd.
- MCP execution now applies declared defaults and invocation validation before
  creating `RunState`, matching Pi, detached, and direct Core execution.
- OpenCode now forwards phase → agent → global `thinking` through the native
  provider-specific `--variant` argument, normalizing `off → none` and
  `ultra → max`. Other levels remain best-effort because each provider/model
  exposes a different variant set.
- Runtime-generated sub-flows now reject every `cwd` and `context` file
  pre-read. Without a sandbox/FileBroker, lexical path checks cannot safely
  contain symlinks or dynamically produced file paths.

### Fixed

- **Pi post-terminal hangs (#73).** Pi children now default to
  `--no-extensions`, with Host-only `isolated` / `allowlist` / `inherit`
  resource profiles. A validated final assistant answer plus `agent_settled`, or
  `agent_end` with `willRetry: false`, enters a bounded and revocable terminal-
  candidate grace period. Legacy `agent_end` events without retry metadata remain
  clean-exit evidence only and are never sufficient for forced reap.
  Later lifecycle activity revokes the candidate, while a leaked handle is
  reaped as a successful `terminal-reap`. Pi now uses the shared strict-NDJSON,
  process-group, abort/idle and SIGTERM→SIGKILL supervisor. Completion metadata
  is recorded in traces, and phase-timeout races are linearized consistently in
  imperative and event-kernel execution.
- **Terminal/process supervision closure.** Ignored Pi metadata no longer
  cancels terminal grace, stdout/stderr decoding preserves UTF-8 across pipe
  chunk boundaries, malformed close tails cannot schedule signals after a run
  settles, and TERM/INT/HUP synchronously reap both agent and script process
  groups before preserving native Host signal exit semantics.
- **Published Shared Context Tree path.** The Pi adapter now resolves the
  executing sibling entry (`src/index.ts` in development, `dist/index.js` in a
  packed install), so default extension isolation does not remove `ctx_*` tools.
- **Reproducible release tarballs.** Release packaging canonicalizes pnpm's
  publish-ready dependency maps without reordering semantic conditional exports,
  proves repeat-pack SHA512 stability, and reuses one immutable tarball set for
  consumer smoke, npm publish, provenance and registry verification.
- **Resolve-only fan-out coordination.** Potential writers in one invocation
  are safely serialized before durable lease acquisition; parallel/map/race/
  tournament work no longer self-times out while cross-process writers remain
  protected by persistent leases. Retry warnings are emitted only after a
  durable mutation intent actually existed.

### Security

- Pi CLI typed-argument parsing now uses bounded linear scanners for decimal
  coercion and `key=value` tokenization, eliminating worst-case polynomial
  regular-expression backtracking on user-controlled invocation text.
- Native sandbox policy construction is fail-closed behind a checked-in exact
  Host/OS/binary evidence cell. Evidence uses a strict versioned schema with
  complete named boolean checks, one no-follow file snapshot for hashing and
  parsing, an owner decision, and a process-local approval token. The factory
  also binds the independently observed live target and the canonical digest of
  the complete backend capabilities. The 0.2.1 native allowlist is empty.
- Resolve-only writers use cross-process leases, durable intents, one-shot
  mutation permits, and explicit dirty-state reconciliation. A cancelled
  non-cooperative writer's late success is recorded `dirty-unknown`, root
  replacement is rechecked after asynchronous resolution, and subsequent
  writers remain blocked until deliberate reconciliation.
- Persistent mutex and lease cleanup records now carry durable terminal release
  evidence. A cleanup fault cannot reverse a completed callback, let a live
  worker steal another worker's lock, or leave a same-PID worker/session blocked
  solely because the originating JavaScript isolate disappeared.

## [0.2.0] — 2026-07-13

### ⚠️ Breaking — migration required

- **`reduce.from` + `{previous.output}` now aggregates all sources.** A `reduce` phase's `{previous.output}` previously resolved to only the *last completed dependency*. It now resolves to **all completed `from[]` outputs** in from-array order: one completed input → its raw output; multiple → `### <id>\n\n<output>` sections joined by `\n\n---\n\n`. `join: "any"` includes only completed branches (skipped/failed omitted). Explicit `{steps.ID.output}` refs are unchanged. **If your reduce task used `{previous.output}` expecting only the last dep, it now receives every `from[]` output** — switch to explicit `{steps.ID.output}` refs to address individual sources. This fixes a long-standing dogfood issue where reducers silently lost inputs.

### Added

- **Configurable idle watchdog (`idleTimeout`).** New flow-level and phase-level DSL field `idleTimeout` (ms). A positive value (≥ 1000) overrides the host default (300000 ms): if a subagent produces no output for this long it is killed as stalled. `idleTimeout: 0` **disables** the watchdog — but validation then requires a finite wall `timeout` (≥ 1000) on every agent-running phase that can use it, so a flow can never hang forever (critical invariant). Per-phase overrides flow-level. Threaded into `RunOptions.idleTimeoutMs` on both the imperative and event-kernel paths; included in cache identity/fingerprints automatically via the FlowIR definition hash (so changing it invalidates cross-run cache).
- **Prompt-size diagnostics.** Every agent call's resolved prompt now records durable `PhaseState.promptStats`: exact UTF-8 byte count, character count, and a conservative approximate token estimate (`ceil(chars/4)`, not a real tokenizer). A warning is appended when a prompt crosses a conservative threshold (~32K est. tokens). `reduce` phases also record `reduceInputs` aggregate stats (count + total bytes/chars/estTokens over the `from[]` inputs). Mirrored on the event-kernel path.
- **Hierarchical (tree) reduce.** Opt-in via `reduceStrategy: "tree"` + `batchSize` (integer ≥ 2) on a `reduce` phase. Tree reduction batches the aggregated `from[]` inputs, runs intermediate reducer calls using the same agent/model/options/timeout/idleTimeout, and reduces round outputs until one remains — useful when the aggregated input would exceed a single prompt. Failures/usage/retry/budget behavior is preserved (each intermediate call reuses the phase's `runOne` wrapper). Default remains one-shot. `reduceStrategy: "tree"` forces the imperative runtime (the event kernel falls back via `kernelUnsupportedReason`); the corrected `{previous.output}` aggregation always applies regardless of strategy.
- **README and launch-visual refresh:** English and Simplified Chinese landing pages now share one concise, conversion-focused structure built around the 0.2 compiler/runtime story, with validated JSON and TypeScript DSL examples, five-host installation paths, runtime guarantees, and package topology. The hero and social-preview assets now visualize the Author → Verify → Compile → Run → Reuse pipeline and have matching localized artwork.
- **S4 TypeScript DSL (`taskflow-dsl`):** compile-time `.tf.ts` runes erase to Taskflow JSON via TypeScript AST (`typescript` package, not ts-morph); CLI `new` / `check` / `build` / `decompile`; modular `erase/kinds/*` registry; parity tests (map + `json` + templates). Hosts still run JSON only (no MCP auto-build of `.tf.ts`).
- **Horizon B engine kinds (`race`, `expand`):** `PHASE_TYPES` is **12**. Imperative runtime + FlowIR 1:1; `race` = **first-success** wins (failed settles do not win); cooperative loser usage is aggregated; non-cooperative losers and **parent abort** are bounded by a cancellation grace (gate is woken on parent abort so the race cannot hang forever); `expand` = nested or graft-promote (`def`, `expandMode`, `maxNodes`) with template rewrite on graft. DSL runes + skills + website phase docs + examples. **`cancelLosers` (default true)** aborts losers via best-effort `AbortSignal` after the first **success**. Event kernel still covers the original **10** kinds (excludes `race`/`expand`); advanced features continue to force imperative fallback; **nested** `flow{def}/use` re-checks kernel admission (fail-closed if child has race/expand or unsupported features).
- **S5 plan:** `docs/internal/s5-kernel-default-on-plan.md` — parity harness first, then feature gaps, then default ON + flagship recompute metric.
- **Claim-vs-impl alignment:** `docs/internal/claim-vs-impl-0.2.0.md` ledger; S4 RFCs toolchain corrected; architecture S4 ✅ / S5 next; skills + README phase/test/package counts; website homepage **12** phases / **5** hosts; reference page **TypeScript DSL** (en/zh).
- **Docs complete for Phase 2 surfaces:** website FlowIR docs (`ir:<64-hex>`, `usedFallbackHash: false`); new concepts **Deterministic Replay** (en/zh) + resume disambiguation; host MCP guides + Grok website + `reference/commands` list all 12 tools including `taskflow_replay`; README en/zh Commands tables; skills `advanced.md` trace/replay vs recompute; `AGENTS.md` exec/trace/replay + kernel flag; architecture RFC status table S0–S5 + internal FlowIR RFC superseded note.
- **Grok Build host.** New `grok-taskflow` delivery package + `taskflow-hosts` `grokSubagentRunner` (`grok -p --output-format streaming-json`). Plugin scaffold (`.grok-plugin/plugin.json` + `.mcp.json` + skills), repo marketplace index (`.grok-plugin/marketplace.json`), docs (`docs/grok-mcp.md`, website en/zh guides). Install: `grok plugin install … --trust` or local bin for dogfood.
- **0.2.0 Phase 2 / S0–S3 foundations (event-sourced kernel path):**
  - `flowir/compile.ts` (`compileTaskflowToFlowIR`) — genuine Taskflow→canonical FlowIR compiler; `compileTaskflowToIR` now content-addresses with `hashFlowIR` (`ir:<64-hex>`) and sets `usedFallbackHash: false`.
  - `exec/fold.ts` — pure `foldEvents(log) →` per-phase snapshot (S1 differential building block).
  - `replay.ts` — implements `replayRun(log, overrides)` (threshold / budget / model / args knobs; zero tokens; no import of runtime/driver).
  - **S1 decision coverage:** runtime emits `gate-score` / `gate-verdict`, `when-guard`, `cache-hit`, `tournament-winner`, `budget-hit`, plus synthetic phase lifecycle for budget/dep skips. Fold differential tests pin fold ↔ RunState agreement.
  - **S2 event kernel (strangler, default OFF, kernel-eligible kinds = PHASE_TYPES minus `race`/`expand`):** `exec/step.ts` + `step-kinds.ts` + `exec/driver.ts` when `RuntimeDeps.eventKernel` or `PI_TASKFLOW_EVENT_KERNEL=1`. Imperative remains default. Hardening: budget enforcement + `budget-hit` events; deps/`join`/`optional` parity; gate eval fail-safe; `steps.*.json` population; agent timeout; script stdout cap; `flow{def}` dynamic validation + nesting cap + recursion stack; feature fall-back for score/retry/expect/reflexion/onBlock/cross-run cache/shareContext.
  - **S1 hard gate + import lint:** fold(log) rebuilds phase statuses matching RunState after a captured run (kill-9 oracle); `replay-import-lint` keeps `replay.ts` off the runtime/driver/step import graph.
  - **North-star slogan:** `compiled · resumable · incremental · replayable-for-what-if` (drops Qwik "not replayable" collision with deterministic replay).
  - **S3 replay surface:** `taskflow_replay` MCP tool; pi `action=replay` and `/tf replay <runId> [--threshold phase=n] [--budget-usd n]`; golden trace fixture under `test/fixtures/`.

### Fixed
- **Budget wording now matches the runtime contract.** User-facing docs, skills,
  and FlowIR comments describe `budget` as an observed-usage stop-loss: after a
  threshold is observed, no new call starts, while calls already in flight may
  overshoot. Ordinary DAG layers and map/parallel/tournament fan-out use serial
  admission, limiting new-call overshoot to one call; `race` necessarily admits
  its competing branches together, so its already-active branches may all
  contribute overshoot. Host limits are explicit: Codex rejects `maxUSD` but
  accepts `maxTokens`; Grok rejects every budget because it reports no usage.
- **DSL erase closes remaining dynamic-field gaps.** `map` callback aliases must
  match explicit `as`, tournament task/branch templates contribute DAG edges,
  and templated `approval.request` / `script.input` preserve placeholders and
  dependencies. Invalid or malformed `tsconfig.json` now fails `check` instead
  of being silently ignored; decompile topology preserves implicit final output.
- **TypeScript DSL decompile now orders dependencies before consumers.** Valid
  Taskflow JSON may list phases in any order; generated rune bindings now use a
  stable topological order, so forward-reference gates/reducers rebuild instead
  of producing unusable source with a successful CLI exit.
- **MCP cancellation is now real and end-to-end.** The dependency-free stdio
  transport dispatches requests concurrently, handles
  `notifications/cancelled`, and propagates a per-request `AbortSignal` through
  `taskflow_run` into the runtime and active host subprocess. A cancelled tool
  call returns JSON-RPC `-32800` instead of leaving hidden background work.
  Input disconnect aborts active requests and notifications; duplicate request
  ids abort the original controller instead of overwriting it. Completed host
  subprocesses remove their abort listeners, avoiding long-DAG listener leaks.
  Transport shutdown is grace-bounded and suppresses late writes; explicit
  cancellation also races non-cooperative handlers and observes any late
  rejection, so neither a hung promise nor an unhandled rejection can wedge the
  MCP process. Asynchronous stdio `error` events (including output `EPIPE`) use
  the same bounded teardown, abort active work, suppress late responses, and
  remove their transport listeners after settling.
- **Grok thinking overrides now work.** Phase → agent → global thinking is
  mapped to `grok --reasoning-effort` (`off` → `none`).
- **Grok budgets no longer fail open.** Grok 0.2.93 streaming JSON contains no
  token/cost usage, so the Grok MCP adapter explicitly rejects flows declaring
  `budget` rather than silently reporting zero and ignoring the ceiling. The
  runtime capability check applies at every execution boundary, including
  inline object/string flows, saved flows, and nested/graft `expand` fragments.
- **Script phases without `input` now close stdin immediately.** Commands that
  read until EOF (for example `cat`) no longer wait for the phase timeout when
  no input payload was configured.
- **Codex thinking overrides now reach the host CLI.** Phase → agent → global
  thinking is mapped to Codex `model_reasoning_effort`, including the supported
  aliases, instead of silently inheriting an unrelated user-level setting.
- **Thinking configuration is validated instead of silently ignored.** Invalid
  values are rejected at the Taskflow boundary so a typo cannot fall back to a
  host's global reasoning configuration.

### Security
- **Host children no longer inherit ambient authority.** Codex subagents are
  ephemeral, ignore parent user config/rules, and clear unrelated MCP servers;
  OpenCode read-only phases use a default-deny policy covering custom/MCP tools;
  Codex, OpenCode, and Grok receive filtered provider/runtime environments.
  Operators can explicitly pass named task variables with
  `PI_TASKFLOW_CHILD_ENV_ALLOW`.
- **Published surfaces are verified as consumers receive them.** Packed
  manifests strip source-only `development` exports, declaration imports are
  typechecked, internal dependencies are exact, and the OpenCode tarball now
  includes its config/skill/assets scaffold. Publish reruns verify all nine
  registry artifacts after mutation, not only versions that existed before it.
- **MCP trace responses are bounded.** Human and JSON trace views cap event
  counts and oversized strings; JSON reports total/returned/truncated instead
  of flooding the host context with an unbounded transcript.
- **DSL output writes are contained, no-clobber, and atomic.** `build`,
  `decompile`, and `new` reject symlink escapes, preserve existing files unless
  `--force` is explicit, and commit fsynced same-directory temporary files
  atomically. `--emit both` preflights both destinations before writing either.
- **Grok read-only phases are kernel-enforced and defence-in-depth.** They now
  require `PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE` to name a custom profile
  extending `read-only`, plus a known-good file-read allowlist, independent
  mutator/MCP deny rules, and disabled subagents. `web_search` / `web_fetch` are
  omitted from the Grok 0.2.93 allowlist because that CLI version can label
  them unmappable and restore the full toolset. A live executor E2E verifies a
  write attempt is blocked even when the workspace is under `/tmp`.
- **Grok mutating/default phases require a fail-closed custom sandbox.** Built-in
  profiles can warn and continue unsandboxed when kernel enforcement is
  unavailable, which is unsafe with `--always-approve`. Mutating phases now
  require `PI_TASKFLOW_GROK_MUTATING_SANDBOX_PROFILE` to name a configured
  custom profile; built-in names are rejected. `max_turns_reached` also fails
  the phase instead of accepting a partial answer.
- **OpenCode subprocess permissions fail closed.** Every OpenCode child now
  uses `--pure` so external plugins cannot bypass the tool permission policy.
  Mutating/default-capable phases are rejected unless the operator explicitly
  sets `PI_TASKFLOW_OPENCODE_UNSAFE_AUTO=1`; only then is `--auto` added.
- **Release reruns no longer blindly trust an existing npm version.** Before
  skipping, the publish workflow verifies a trusted npm owner, SLSA provenance
  from this repository/workflow/tag/commit, and exact locally-packed tarball
  integrity. A preclaimed `name@version` now fails the release. Every
  third-party action across CI, Pages, and publish/release workflows is pinned
  to the official major tag's full commit SHA; npm publish has only
  `contents: read` and `id-token: write`, while GitHub Release creation is
  isolated in a dependent job with only `contents: write`.
- **Claude permission handling no longer defaults to an unsandboxed permission
  bypass.** Host policy now uses explicit least-privilege execution modes and
  fails closed when the requested tool capability cannot be represented
  safely. Claude Code >=2.1.169 `--safe-mode` disables non-managed
  customizations, `--tools` restricts built-ins, only that same set is
  pre-approved, and disk settings/non-managed hooks are disabled (managed
  policy hooks may still run). Explicit lists remain narrow even after the
  unsafe opt-in; unknown tool names always fail closed.
  The Claude child also receives a filtered environment that retains
  platform/proxy/CA and supported provider settings while dropping unrelated
  application secrets.
- **Published artifacts are consumer-tested before npm is mutated.** CI and
  the tag workflow pack all nine packages with pnpm, install the exact local
  tarballs into a clean npm project, reject leaked `workspace:*` ranges, import
  every explicit public entry point, and exercise all five shipped bins. The
  same gate therefore protects first publication as well as release reruns.

## [0.1.8] — 2026-07-09

### Fixed
- **`cwd` no longer accepts interpolation placeholders.** A phase's `cwd` field
  is a literal path / reserved workspace keyword (`temp` / `dedicated` /
  `worktree`), not an interpolated one — but the validator silently accepted
  values like `cwd: "{args.workspace}"`, which would then resolve to a literal
  directory named `{args.workspace}` at run time (or, worse, be exploitable as
  a path-injection vector). `validateTaskflow()` now rejects any `cwd` value
  matching a `{placeholder}` pattern with a clear error pointing at the
  reserved keywords. (#65)

### Changed
- **Dependency sweep** (no runtime-API changes — these are CI / dev / website
  dependencies; the published packages' runtime surface is unchanged):
  - `pnpm/action-setup` 4 → 6 (#57).
  - Batched the remaining Dependabot PRs that were stuck behind CI /
    workflow-scope gates (#66): GitHub Actions `actions/checkout` v4 → v7,
    `actions/upload-pages-artifact` v3 → v5, `actions/deploy-pages` v4 → v5;
    dev deps `typescript` ^6 → ^7, `@types/node` ^22 → ^26, `typebox` ^1.3.3 →
    ^1.3.6, `@biomejs/biome` 2.5.2 → 2.5.3; website deps `fumadocs-core/ui`
    16.10.7 → 16.11.1, `fumadocs-mdx` 15.0.13 → 15.1.0. Local typecheck + the
    full 1160-test unit suite remain green.

## [0.1.7] — 2026-07-07

### Added
- **Deterministic-replay trace foundation.** Every run may now record an
  **append-only event trace** (`runs/<flow>/<runId>.trace.jsonl`) capturing
  each subagent call's resolved input + full output and the runtime's own
  decisions (gate verdicts, `unreplayable` markers for context-sharing / inner
  `flow` / context-file phases). This is the foundation for **deterministic
  replay** — re-evaluating a recorded run against changed decision knobs (gate
  thresholds, budget, model route) **without calling the model**, zero tokens
  offline — which lands in 0.2.0. The schema is already complete enough that 0.2.0
  replay won't need a breaking migration.
  - New `trace.ts` (`TraceEvent`, `TraceSink`, buffered `FileTraceSink`,
    partial-line-tolerant `readTrace`) and `replay.ts` (`ReplayDecision` type
    contract) modules in `taskflow-core`; re-exported from the barrel.
  - New optional `RuntimeDeps.trace?: TraceSink` hook — **fail-open** (a missing
    or throwing sink never crashes a run) and **host-agnostic** (no host SDK in
    core; runs with no trace sink behave identically to before). Wired into all
    four `RuntimeDeps` construction sites in the pi adapter and the MCP server.
  - New `trace` action / `/tf trace <runId> [--json]` command (pi) and
    `taskflow_trace` MCP tool: read-only inspection of a run's event timeline.
    Human form truncates subagent outputs (like `peek`); `--json` returns the
    complete machine-readable record.
  - Backfilled the MCP server with `taskflow_why_stale` and `taskflow_recompute`
    (dry-run only) — the MCP host previously lacked 5 analysis actions pi had.
  - Trace files are cleaned up alongside their runs by `cleanupTerminalRuns`
    (no unbounded disk accumulation).
  - Extracted the pure `parseGateVerdict` + a decoupled `overBudget` into
    `deterministic.ts`, so a future `replay.ts` can import them without dragging
    in the process-spawning runner. (Design came from a 3-reviewer cross-
    adversarial plan review: risk-reviewer + critic + reviewer → plan-arbiter,
    which scoped this to trace-only in 0.1.7 and deferred replay logic to 0.2.0.)

### Fixed
- **Release-prep fixes from a deep cross-adversarial release-readiness review**
  (scout → risk/security/quality reviewers → critic cross-exam → final-arbiter):
  - **Bumped the stale `@0.1.6` plugin pins** in `codex-taskflow/plugin/.mcp.json`
    and `claude-taskflow/plugin/.mcp.json` to `@0.1.7`. Without this,
    `codex plugin add taskflow@taskflow` / `claude plugin install` would install a
    server lacking `taskflow_trace`, `taskflow_why_stale`, `taskflow_recompute`,
    `taskflow_save`, and `taskflow_search` — the 0.1.7 features silently absent.
    (`opencode-taskflow/plugin/opencode.json` was already at 0.1.7.)
  - **Taught the `trace` action in the skills** (the actions table + Pi/MCP
    surface in README) so agents can discover and invoke it — an engine feature
    the skill doesn't teach effectively doesn't exist.
  - Added trace **decision-event** tests (gate-verdict, unreplayable marker).
- **File loaders now report *why* a file failed, with the parse position —
  instead of a merged "not found or unparseable" message.** Four user-facing
  loaders (`readDefineFile`, `readFlowFile`/`listFlows`, `tryReadRunFile`, and
  the library sidecar `readMeta`/`readMetaNextTo`) used to collapse two
  distinct failures — *file missing* and *file malformed* — into a single
  `null` / `"… not found or unparseable"` result. The underlying `JSON.parse`
  `SyntaxError` (which carries the offending byte offset and, on Node ≥17, a
  line/column) was swallowed by the lenient `safeParse` and never reached the
  user. A hand-authored `defineFile` with a stray bare newline inside a string
  literal therefore reported "defineFile not found or unparseable" and sent
  authors chasing a phantom path/cwd problem. The loaders now return a
  discriminated `LoadResult<T>` (`{ ok: true, value } | { ok: false, reason:
  "missing" | "unparseable", path, detail }`); `detail` carries the original
  parse error (e.g. `Bad control character in string literal in JSON at
  position 3979 (line 30 column 801)`), surfaced via a shared
  `describeLoadFailure(r, what)` helper. New strict `parseStrict(text,
  { allowFence })` (in `interpolate.ts`) preserves the `SyntaxError`; the
  lenient `safeParse` is unchanged, so all ~25 LLM/subagent output paths keep
  their fail-open fence/balanced-bracket recovery. `listFlows` now `console.warn`s
  on a corrupt saved flow instead of silently dropping it (so `getFlow(name)`
  no longer reports "not found" for a file that clearly exists); new
  `getFlowDiagnosed` / `loadRunDiagnosed` distinguish corrupt-vs-missing for
  by-name/by-runId resolution. **Breaking** (pre-1.0): `readDefineFile`,
  `readMeta`, and `readMetaNextTo` return `LoadResult<T>` instead of `T | null`.
  The opaquely-fail-open paths (index-rebuild scans, `cache.ts` file hashing,
  path-traversal rejections) are intentionally unchanged.
- **The pi-taskflow "built-in agents upgrade" hint is now truly one-time.** It
  previously re-printed every session while `settings.json` lacked a `taskflow`
  key and the project had `.pi/agents/*.md`. A marker file
  (`~/.pi/agent/.taskflow-upgrade-hint-shown`) is now written atomically (`wx`
  flag) after the first print, so subsequent sessions skip it. Best-effort: an
  unwritable agent dir only means the hint may show once more; it never blocks
  session startup.
- **Gate verdict parsing hardened — a genuine BLOCK is no longer silently
  downgraded to PASS (issue #54).** Models routinely wrap decision tokens in
  Markdown emphasis (`VERDICT: **BLOCK**`, `### WINNER: __3__`, `SCORE: `0.8``),
  which the bare-token regexes (`/VERDICT\s*[:=]\s*(…)/`, `/WINNER…(\d+)/`,
  `/SCORE…([01]…)/`) missed — the match fell through to the default verdict,
  so a genuine BLOCK was silently recorded as `pass` and a judge's actual pick
  silently reverted to variant 1. Three layered fixes: (1) a shared `markerRe()`
  factory in `scorers.ts` now emits emphasis-tolerant regexes for **all three**
  decision markers — `VERDICT_TOKEN_RE`, `SCORE_TOKEN_RE`, `WINNER_TOKEN_RE` —
  tolerating `*`/`_`/`` ` ``/`~` runs on either side of the captured value (used
  by `parseGateVerdict`, `parseJudgeOutput`, and `parseTournamentWinner`);
  (2) **gate *model output* that cannot be parsed now fails closed (BLOCK)**
  instead of PASS — a gate that cannot reach a verdict cannot be trusted to
  pass, while *config* slips (unresolved `score.target`, malformed `scorers`)
  remain fail-open with a warning (they are authoring errors that degrade, not a
  judge that couldn't decide); tournament winner stays fail-open (variant 1 —
  never lose work, since the variants are already computed); (3) a free-text
  gate whose task omits a `VERDICT:` instruction now gets the exact format
  suffix **auto-appended**.
  For maximum robustness, prefer `output: "json"` + `expect` enum
  (`{ verdict: { enum: ["pass","block"] } }`) which machine-validates the verdict.
  Regression tests added for every Markdown variant and the fail-closed default.
  **Breaking** (pre-1.0): a gate whose model output contains *no* parseable
  verdict (no `VERDICT:` marker and no JSON verdict object) now **blocks** the
  flow instead of silently passing. Previously such gates rubber-stamped PASS.
  Migration: any custom gate `task` that relied on prose-only output should
  either emit `VERDICT: PASS|BLOCK` (auto-appended if omitted), adopt the
  `output:"json"` + `expect` enum contract, or be marked `optional: true` with a
  downstream fallback. Note that an *explicit* non-blocking JSON verdict (e.g.
  `{"verdict":"No issues found"}`) still resolves to PASS — only truly
  unparseable model output is affected. *Config* slips (unresolved `score.target`,
  malformed `scorers`) remain fail-open with a warning.

### Security
- **PostCSS bumped to 8.5.16 (GHSA-qx2m-qp2m-jg93 / CVE-2026-41305, medium).**
  PostCSS < 8.5.10 did not escape `</style>` when stringifying CSS ASTs, an XSS
  vector when user-submitted CSS is parsed and re-embedded in HTML `<style>`
  tags. `next@16.2.10` (a `website/` transitive dep) pinned the vulnerable
  `postcss@8.4.31`. A root `pnpm.overrides` now forces `postcss@^8.5.10`
  workspace-wide, hoisting the single `8.4.31` resolution to `8.5.16` (the
  version `@tailwindcss/postcss` already resolved). The website build (Next.js +
  Tailwind CSS pipeline) was verified unaffected.

## [0.1.6] — 2026-07-06

### Changed
- **Extracted the MCP server into its own `taskflow-mcp-core` package** (sixth
  package). The stdio JSON-RPC server + `taskflow_*` tool handlers + DAG
  SVG/outline renderer moved out of `taskflow-core` into `taskflow-mcp-core`, so
  core is again purely the portable engine (DSL/runtime/cache/verify) and the
  MCP presentation layer is an independently-publishable unit. The host
  adapters (codex/claude/opencode) now depend on `taskflow-mcp-core` and import it
  via `taskflow-mcp-core/server` / `taskflow-mcp-core/jsonrpc`. `pi-taskflow` is
  unaffected (it never used the MCP server).
- **De-duplicated the three host runners.** The codex/claude/opencode runners
  each copy-pasted ~82 lines of identical process-handling boilerplate
  (spawn / idle watchdog / abort / signal-kill detection / stderr cap / post-exit
  classification), which had already caused one divergence bug. The shared
  block — plus `unknownAgentResult` and a centralized `activeChildren` set —
  is now a single `runSubagentProcess` in `taskflow-core`'s `runner-core.ts`,
  parameterized by a per-host `SubagentAccumulator` + `foldLine`. Each host
  runner shrank to just its host-specific bits (argv, model-id rule,
  permission mapping, event parser): codex 366→217, claude 417→266, opencode
  397→247 lines. Behavior is identical (1140/1140 tests pass); adding a new
  host can no longer drift the process/classify contract.

- **Renamed the MCP server package from `taskflow-mcp` to `taskflow-mcp-core`**
  at release time: `taskflow-mcp` (and `taskflow-mcp-server`) had been squatted
  on npm by an unrelated package, so the host-neutral MCP server ships as
  `taskflow-mcp-core`. The directory (`packages/taskflow-mcp-core`), the host
  adapters dependency pins, and all `taskflow-mcp/server` / `taskflow-mcp/jsonrpc`
  imports were updated accordingly. The adapters own bin names
  (`codex-taskflow-mcp` / `claude-taskflow-mcp` / `opencode-taskflow-mcp`) are unchanged.

### Added
- **Library Phase 1: search-before-author + reusable-flow assets.** A new
  reusable-flow asset layer with sidecar `.meta.json` metadata
  (`purpose`, `tags`, `phaseSignature`, `generality`, `agentUsage`, `reuseCount`).
  Save reusable flows with `action=save` (Pi) or `taskflow_save` (MCP) and search
  them before authoring a new flow with `action=search` / `taskflow_search`.
  Search combines structural similarity (`agent→map→reduce` signature + phase
  count) and CJK-aware keyword matching, and degrades gracefully to purely
  structural/keyword scoring when no embedder is configured (Phase 2). The
  `reusedFromSearch` flag on `taskflow_run` / `action=run` increments
  `reuseCount`, so high-quality reusable flows surface higher over time. See
  `docs/rfc-library-reuse.md` for the full design and `skills-src/taskflow/library.md`
  for the agent-facing workflow.

- **OpenCode as a fourth host.** New `opencode-taskflow` package: an OpenCode
  subagent runner (`opencode run --format json`) plus an `opencode.json` MCP
  config scaffold, mirroring the Codex/Claude adapters. A flow's subagents can
  now execute as isolated `opencode run` sessions, and taskflow is exposed to
  OpenCode via the same `taskflow_*` MCP tools. Register with
  `opencode mcp add taskflow -- npx -y -p opencode-taskflow opencode-taskflow-mcp-core`
  (or an `opencode.json` `mcp` entry). See `docs/opencode-mcp.md`.
  - Read-only phases inject a deny-mutations permission policy via
    `OPENCODE_CONFIG_CONTENT` (genuinely enforced); mutating phases run with
    `--auto`.
  - OpenCode model ids are `provider/model`, so the runner uses a different
    drop rule than codex/claude (drops only `{{placeholder}}`, `:thinking`
    suffixes, and multi-segment openrouter paths).
  - Verified end-to-end: a 2-phase flow with real `opencode run` subagents
    (data flows A→B) on a free `opencode/` model.

- **Claude Code as a third host.** New `claude-taskflow` package: a Claude Code
  subagent runner (`claude -p --output-format stream-json`) plus a
  plug-and-play Claude Code plugin, mirroring the Codex adapter. The engine and
  DSL are unchanged — a flow's subagents can now execute as isolated `claude -p`
  sessions, and taskflow is exposed to Claude Code users via the same
  `taskflow_*` MCP tools (`run`/`list`/`show`/`verify`/`compile`/`peek`).
  Install: `claude plugin marketplace add heggria/taskflow && claude plugin
  install claude-taskflow@taskflow`. See `docs/claude-mcp.md`.
  - Read-only phases map to a `--allowedTools` whitelist; mutating phases run
    under `--permission-mode bypassPermissions` (the codex workspace-write
    analogue, no OS sandbox — documented).
  - The MCP server (JSON-RPC stdio transport, `taskflow_*` tool schemas +
    handlers, DAG SVG/outline renderer) moved into host-neutral
    `taskflow-core/src/mcp/`, parameterized by a `SubagentRunner`; the codex and
    claude adapters are now thin bindings. No behavior change for Codex.
  - Skills are single-sourced for all hosts (`skills-src/taskflow/` with
    comma-list host blocks, e.g. `<!-- host:codex,claude,opencode -->`).

- **`defineFile`: verify/compile/run a flow from a path on disk.** `action=run`
  (Pi) and `taskflow_run` / `taskflow_verify` / `taskflow_compile` (MCP) accept
  a `defineFile` (string) or `{defineFile, name}` in place of an inline
  `define`. The engine resolves the path, reads it once, and substitutes it as
  the flow definition — so a flow can live in a `.json` file (e.g.
  `examples/review-changes.json`) and be invoked by reference without pasting
  the JSON into the tool call. Pairs naturally with the JSONC support below.
  See `skills-src/taskflow/core.md`.

- **JSONC comments and trailing commas in flow definition files.** Flow
  definitions are hand-authored `.json` files; authors can now annotate them
  with `//` and `/* */` comments and leave trailing commas (JSONC/JSON5
  style). A new zero-dependency `parseJsonc()` (in `taskflow-core`'s `jsonc.ts`)
  strips comments only outside string literals and tolerates trailing commas
  before `}` / `]`, used by `readFlowFile()` when loading `defineFile` flows
  and saved flows from the library. `safeParse()` for LLM output remains
  strict. Re-exported from the `taskflow-core` barrel as `parseJsonc`.

### Fixed
- **The pi-taskflow "built-in agents upgrade" hint is now truly one-time.** It
  previously re-printed every session while `settings.json` lacked a `taskflow`
  key and the project had `.pi/agents/*.md`. A marker file
  (`~/.pi/agent/.taskflow-upgrade-hint-shown`) is now written atomically (`wx`
  flag) after the first print, so subsequent sessions skip it. Best-effort: an
  unwritable agent dir only means the hint may show once more; it never blocks
  session startup.

## [0.1.5] — 2026-07-03

### Added
- **Scoring gates (`score` on `gate` phases).** Deterministic, composable,
  auditable quality checks: six pure scorers (`exact-match`, `contains`,
  `regex`, `json-schema`, `length-range`, `code-compiles`) run against a target
  string at **zero tokens** and combine via `all` / `any` / `weighted`
  (+ `threshold`). When the deterministic combination passes and the judge
  cannot veto it, the gate auto-passes with **no LLM call** (mirrors the `eval`
  fast-path). When it fails, an optional `judge` (LLM-as-judge) decides, or the
  gate `task` runs with the scorer report appended, or — with no fallback — the
  gate blocks explicitly. The structured result is the gate's `.json`
  (`{steps.<gate>.json.combined}`, `.json.results`), so downstream phases can
  route on quality, not just pass/fail.
- **Reflexion memory in loops (`reflexion: true`).** Each iteration after the
  first receives a structured failure summary of the prior one via the
  `{reflexion}` placeholder (auto-appended when absent, capped at 2000 chars):
  `expect`-contract diagnostics, the (sanitized) error, or the unmet `until`,
  plus a truncated output snippet. Body failures become **feedback instead of
  termination** — timeout/abort/over-budget still hard-stop, and exhausting
  `maxIterations` on a failure still fails the phase. `PhaseState.loop.failures`
  records every failed iteration for audit. Default off = byte-for-byte the
  historical behavior.
- **Side-effect classification (`idempotent: false`).** Marks a phase with
  irreversible side effects (webhook POSTs, deploys, DB writes): transient
  provider errors are **not** auto-retried (explicit `retry{}` is still
  honored) and the result is **never cached** in any scope (within-run resume,
  cross-run, `incremental`). The phase state records `sideEffect: true`
  (rendered as ⚡), and a re-execution on resume surfaces a warning.
- **Single-source skills.** The pi and codex skill docs are now authored once
  in `skills-src/taskflow/` and compiled per host by `scripts/build-skills.mjs`
  (`pnpm run build:skills`); a drift guard (`skills-build.test.ts`) fails CI if a
  generated file is edited directly. Codex reaches feature parity with pi
  automatically.

### Security
- **Scoring-gate hardening for LLM-generated dynamic sub-flows.**
  `validateTaskflow` rejects `code-compiles` scorers (compiler execution — the
  `npx tsc` path could resolve a repo-planted `node_modules/.bin/tsc`) and
  `regex` scorers (catastrophic-backtracking ReDoS) inside `flow{def}`
  definitions produced at runtime — the same hardening class as the existing
  `script`-phase block. Author-written flows keep both (a human reviewed them).
- **`code-compiles` runs in an isolated temp directory.** `mkdtempSync` closes
  the predictable-temp-name symlink/TOCTOU race, and running the compiler with
  that dir as its cwd stops `npx` resolving a repo-planted `tsc` even in
  author-written flows (defense-in-depth).
- **Judge-prompt injection guard.** A scoring gate's judge embeds the
  model-produced target in a fenced evidence block; fences in the target are
  now neutralized so crafted output cannot close the block and inject
  instructions at prompt level.
- **Reflexion prompt-injection surface reduced.** Provider error noise is run
  through `sanitizeErrorMessage` before it is injected into the next
  iteration's prompt (HTML gateway pages no longer leak in verbatim).
- **ReDoS fixes in `safeParse`.** The fenced-block extractor and the stray-key
  diagnostic regexes are now linear-time (removed ambiguous adjacent whitespace
  quantifiers) — closes two `js/polynomial-redos` code-scanning alerts.

### Fixed
- **Detached (background) runs load the host runner correctly.** The host now
  self-reports its runner module path via `import.meta.url` instead of
  resolving a relative `.ts` specifier that `rewriteRelativeImportExtensions`
  left pointing at a non-existent `dist/runner.ts` — every detached phase
  previously failed with "No subagent runner injected" in the published build
  while dev checkouts worked. The detached runner now also fails fast (exits
  non-zero, persisting the real import error on a `__detach__` phase) instead
  of burying the cause under N no-runner stubs.
- **Loop `until` self-references no longer error.** `{steps.<thisId>.json.done}`
  in a loop's `until` (the documented stop-condition pattern) was flagged as a
  self-reference bug; loop phases are now exempt.
- **Per-scorer field validation.** Fields not applicable to a scorer's type
  (e.g. `negate` on `contains`) are rejected instead of silently ignored.
- **Loop-only fields on non-loop phases warn.** `until` / `maxIterations` /
  `convergence` on a non-loop phase now surface a warning instead of being
  silently dropped.

### Docs
- The interpolation reference now documents `{reflexion}`, `{loop.iteration}`,
  `{loop.lastOutput}`, `{loop.maxIterations}`, and the `score.target` /
  `score.judge.task` interpolation sites.
- `examples/quality-pipeline.json` composes all three new features (scoring
  gate → reflexion loop → non-idempotent notify).

## [0.1.4] — 2026-07-02

### Security
- **Dynamic sub-flows can no longer smuggle `script` phases (RCE guard).**
  `validateTaskflow` rejects `script` phases in LLM-authored dynamic flow
  definitions (`flow` phases with an inline definition produced at runtime),
  closing the path where a subagent's output could inject arbitrary shell
  commands into the host.
- **Dependency audit clean.** `npm audit fix` bumps transitive `protobufjs`
  to 7.6.4 (GHSA schema-derived name shadowing, moderate) — 0 open alerts.

### Fixed (adversarial review of the features below)
- **Peek `--item` now keys by positional label, not section order.** A
  budget-skipped map item has no section in the merged output, so section-order
  indexing silently returned the WRONG item's content for every position after
  the gap. `splitItems` now parses each `### [k/N]` label and keys by `k`; a
  missing item returns "not found (budget-skipped items have no section)" with
  the available indices.
- **`/tf peek` rejects non-numeric `--item`/`--limit`** with a usage message
  instead of passing `NaN` through ("Item NaN out of range").
- **Contract `enum` comparison is now key-order-insensitive** for object
  literals (structural `deepEqual` instead of `JSON.stringify` equality).
- **Tournament phases propagate `timedOut`** when all variants fail by
  phase-timeout (the custom all-failed return path missed the marker).
- **Codex MCP `taskflow_run` persists terminal run state even if the runtime
  throws** (`finally`-wrapped saveRun), and both `taskflow_run` /
  `taskflow_peek` descriptions cross-reference the runId so LLM callers chain
  them.
- **`verifyTaskflow`'s contract pass scans more ref sources** — `context`,
  `input`, `judge`, `with` values, and array-form `run` — closing false-negative
  gaps for `{steps.X.json.field}` typos.

### Added
- **Peek — post-hoc inspection of intermediate phase outputs.** `/tf peek
  <runId> [phaseId]` (pi) and the `taskflow_peek` MCP tool (Codex) read one
  phase's output from a stored run: omit `phaseId` for a phase listing
  (status + output size), `--json` for the parsed JSON, `--item <n>` for one
  section of a map/parallel fan-out, `--limit <chars>` to adjust truncation.
  Output is hard-truncated (default 4000 chars, ceiling 32000) and the
  operation is read-only + explicitly human/tool-invoked, so the
  context-isolation contract (only the final output enters the conversation)
  is preserved — peek is the debugging escape hatch for "phase 4 of 12
  produced garbage" without re-running the whole flow. The Codex MCP
  `taskflow_run` now persists run state (throttled + terminal, same contract
  as the pi adapter) and reports the runId, so MCP runs are peekable too.
- **Per-phase `timeout` for agent-running phases.** Previously only `script`
  phases had a time cap; every other phase type could run unboundedly (the
  idle watchdog only catches silent stalls, not busy-but-never-finishing
  subagents). `timeout` (ms, >= 1000) now caps EACH subagent call of an
  agent/gate/reduce/map/parallel/loop/tournament phase: on expiry the
  subagent is aborted, the phase fails with a `timedOut: true` marker
  (rendered as ⏱ in the pi TUI), and the failure is deterministic — never
  retried (neither explicit `retry` nor the transient fallback), so a capped
  call can't double-spend. Not valid on approval/flow phases (validation
  error). Script phases keep their existing child-process semantics and now
  also record `timedOut` on the phase state.
- **Output schema contracts (`expect`).** A JSON-emitting phase
  (agent/gate/reduce/loop with `output: "json"`) can declare the shape its
  output must satisfy — a small JSON-Schema-like contract (`type`,
  `properties`, `required`, `items`, `enum`, nested). The runtime validates
  the parsed output the moment the subagent finishes; a violation fails the
  phase with per-path diagnostics (e.g. `$.score: required key is missing`)
  and is retryable under the phase's explicit `retry` policy — turning
  "phase completed but the shape is wrong and downstream silently
  mis-parses" into an immediate, precise failure at the source. Statically,
  `validateTaskflow` rejects malformed contracts and `verifyTaskflow` gains a
  `contract` pass that warns when a `{steps.X.json.field}` ref names a field
  absent from X's declared contract — catching ref typos before a single
  token is spent. Zero new dependencies (hand-rolled total validator in
  `taskflow-core/src/contract.ts`).
- **Script phase test coverage** — validation, execution, security, and
  robustness suites for the `script` phase type (952 tests total).

### Changed
- **Each published package now ships its README** (`scripts/copy-readme.mjs`),
  fixing the empty npm package pages.
- **Docs sync:** README/README.zh-CN/AGENTS/CONTRIBUTING/SECURITY refreshed for
  the script phase, brand/version drift fixed; CI actions bumped
  (checkout v7, setup-node v6) and dev-dependencies updated.

## [0.1.3] — 2026-07-02

### Added
- **Codex MCP `taskflow_compile` renders an inline SVG diagram.** It now emits a
  hand-rendered SVG of the flow DAG so the Codex desktop app shows a real diagram
  instead of a bare `<image content>` placeholder; a layered text outline rides
  along as the caption/fallback for the CLI/TUI and vision-less models. Oversized
  graphs skip the image and fall back to text. Injection-safe: all rendered text
  is XML-escaped and the renderer is total (never throws on malformed input).
  Isolated to the `codex-taskflow` adapter — core's Mermaid `compile` artifact is
  unchanged (`taskflow_run` / `taskflow_verify` return text only).

### Fixed
- **Eval gates could silently auto-PASS on an unresolved ref or parse error.** A
  `contains` check with a missing `{steps.*}` LHS, or any eval with a parse
  error, used to skip the LLM gate (`evaluateCondition` fails open with `true`).
  Both now fail-safe — a missing ref or unparseable eval falls through to the LLM
  gate instead of bypassing the safety check.
- **A `map` phase with a literal-array `over` crashed the whole run** with
  `over.match is not a function`. The map runtime assumed `over` was always a
  string interpolation ref (e.g. `{steps.scan.json}`) and called `.match()` on
  it. Two-layer fix: `validateTaskflow` now rejects a non-string `over` up front
  with an actionable message (emit the list from an upstream phase and reference
  its `.json`), and `directRef` guards against non-string input so the runtime
  fails a phase gracefully instead of throwing even if validation is bypassed.
- **Codex MCP tools threw or false-passed on malformed input.** `taskflow_verify`
  crashed (`phases is not iterable`) on a missing `phases`; `taskflow_compile`
  false-passed an empty flow (`✓ PASS`) and crashed on a non-string `map.over` or
  a phase missing its `id`. Both tools now validate first and return a structured
  `✗ FAIL` (still rendering a diagram for a renderable-but-invalid flow so it can
  be debugged), and the SVG `truncate` helper coerces non-string fields so the
  renderer can never throw. Hardening was extended to the full class of
  JSON-valid-but-malformed inputs: non-string `id`/`task`/`agent`/`when`, `null`
  or non-object phase elements, non-string gate `eval` entries, malformed
  `cache`/`cache.fingerprint`, and non-object `branches` entries all return a
  structured validation error instead of throwing, and every diagram renderer
  (Mermaid + SVG + text outline) is total against a non-array `phases`.
- **Static verification ignored `reduce.from` edges.** `verify.ts` built its
  successor / terminal / connectivity graphs from `dependsOn` only, so a phase
  feeding a reduce solely via `from` was falsely flagged terminal/dead-end and
  the reduce falsely flagged unreachable — contradicting the runtime and the
  compile outline, which use `dependenciesOf` (`dependsOn ∪ from`). All graph
  helpers now use `dependenciesOf`.
- **Broken install contract on Node 22.0–22.18.** `engines.node` was `>=22` on
  all packages, but the locked Pi SDK requires `>=22.19.0`; with
  `engine-strict=true` that meant a hard install failure once the Pi deps were
  reached. Bumped all four `engines.node` to `>=22.19.0` to match the real floor.

### Changed
- **The Codex plugin pins the MCP package version it launches.** `.mcp.json` now
  runs `npx -y -p codex-taskflow@<version>` (was unpinned), so the installed
  plugin version binds the exact code executed. The publish workflow verifies the
  pin (and `plugin.json`'s version) equals the release tag.
- **CI matured for the multi-host monorepo.** Node `22`/`24` test matrix,
  cross-platform `pnpm install`, a `build` (dist-emit) job, the network-free Codex
  MCP e2e suites (stdio handshake + comprehensive rendering/injection), CodeQL,
  Dependabot, and least-privilege permissions.
- **Rebrand: `pi-taskflow` → taskflow.** The project is now presented as a
  host-neutral, multi-host orchestration runtime (Pi **and** Codex), not a
  Pi-only extension. GitHub repo renamed `heggria/pi-taskflow` →
  `heggria/taskflow`; all docs, badges, hero/social images, and the 6 i18n
  READMEs updated. **npm package names are unchanged** (`taskflow-core`,
  `pi-taskflow`, `codex-taskflow`) and the `pi-taskflow` package keeps its
  `pi-*` keywords + `pi` manifest field, so Pi package indexing and
  `pi install npm:pi-taskflow` are unaffected.
- MCP `serverInfo` now reports `taskflow` / `0.1.3` (was `pi-taskflow` /
  `0.0.28`).

### Added
- **Codex plugin** (`packages/codex-taskflow/plugin/`) for zero-config,
  plug-and-play install: `codex plugin marketplace add heggria/taskflow` then
  `codex plugin add taskflow@taskflow`. Ships a `.codex-plugin/plugin.json`
  manifest, a `.mcp.json` that launches the MCP server via `npx -y -p codex-taskflow@<version> codex-taskflow-mcp-core`
  (no separate global install), and a routing `SKILL.md` so Codex reaches for the
  `taskflow_*` tools on multi-phase / fan-out work automatically. A repo-root
  `.claude-plugin/marketplace.json` makes the plugin discoverable.
- **`tool_timeout_sec: 1800` in the Codex plugin's `.mcp.json`.** Codex applies a
  per-server MCP tool-call timeout; when unset the plugin inherited Codex's
  (short) default, so a long multi-phase `taskflow_run` — which returns only
  after the whole DAG finishes — could be abandoned client-side while the run
  kept executing server-side. The plugin now ships a 30-minute default so large
  flows aren't cut off. Override per machine in `~/.codex/config.toml` under
  `[mcp_servers.taskflow]` if you need more or less.

## [0.1.2] — 2026-06-30

### Fixed
- **codex-taskflow MCP server failed every phase with `Model metadata for
  {{fast}} not found`** (same refactor-omission class as issue #3). The MCP
  server called `discoverAgents(cwd, "both")` without the model-roles map, so
  the built-in agents' `{{fast}}`/`{{strong}}`/… placeholders were never
  resolved. Fixed: it now calls `readSubagentSettings()` and passes
  `modelRoles` through, exactly like the pi adapter.
- **codex-runner passed pi-provider model ids to `codex exec`, which rejected
  them.** Once the placeholders resolved, the resulting ids
  (`openrouter/deepseek/...`, `anthropic/glm-5.2:xhigh`) are pi's provider
  namespacing — Codex model ids are flat (`gpt-5.5`, `claude-sonnet-4-6`) and
  it errors with `Model metadata for <id> not found`. Fixed: `runCodexAgentTask`
  now drops a model that still looks like a pi-provider path (contains `/`) or an
  unresolved `{{placeholder}}`, so `codex exec` falls back to its own configured
  default model. A user who sets a real Codex model id (no `/`) still gets it
  passed through. Verified end-to-end: a single-agent flow now runs to
  completion on Codex and returns the model's output.

## [0.1.1] — 2026-06-29

### Fixed
- **Foreground taskflow runs silently executed no phase** (issue #3, broadest
  impact — found during the regression sweep). The same default-runner change
  that broke detached runs also broke `runFlow` (every foreground run) and both
  `recomputeTaskflow` paths in `pi-taskflow/src/index.ts`: they constructed
  `RuntimeDeps` without a `runTask`, so every phase hit the `noRunnerInjected`
  stub. Pre-refactor this worked only because the engine's default `runTask`
  was `runAgentTask` (same package). Fixed by explicitly injecting
  `piSubagentRunner.runTask` at all three call sites. Added a structural
  regression test that scans the production source and fails if any
  `executeTaskflow`/`recomputeTaskflow` deps omits `runTask`.
- **Detached (background) runs crashed on launch** (issue #3). The detached
  runner specifier resolved to `dist/detached-runner.js.js` (double `.js`) under
  taskflow-core's `"./*"` export rewrite, so the spawned child died at import
  with `Cannot find module`. Now resolved with a suffix-less specifier
  (`taskflow-core/detached-runner`) → `dist/detached-runner.js`. The stale
  `--experimental-strip-types` flag (the runner ships compiled) is dropped.
- **Detached runs could never execute any phase** (issue #3, deeper). The
  detached-runner called `executeTaskflow` with no `runTask` (see the default
  above), so every detached phase failed with "No subagent runner injected" even
  after the module loaded. Fixed: the host serializes a `runnerModule`/
  `runnerExport` (resolved from its own package, works under both workspaces and
  npm installs) into the detached context file, and the detached-runner
  dynamically imports it and injects `runTask`.
- **A crashed detached runner no longer leaves the run stuck at `running`
  forever** (issue #3, secondary). The host now pipes stderr and attaches
  `exit`/`error` handlers that, when the child dies before reaching a terminal
  state, persist `status: "failed"` with the captured stderr recorded in a
  pollable synthetic phase (`__detach__`). Race-safe: guarded by pid + status so
  a genuine terminal state the runner persisted is never clobbered.

## [0.1.0] — 2026-06-27

> **Monorepo split + first multi-host release.** pi-taskflow is now three
> independently published packages built on a host-neutral engine, and the
> taskflow engine runs on **both Pi and Codex**.

### Added
- **`taskflow-core`** — the host-neutral engine (DSL, runtime, cache, verify,
  FlowIR, shared context tree, agent discovery, persistence, the
  `SubagentRunner` contract). **Zero host-SDK dependency** (depends only on
  typebox). Vendors the three small pi helpers it used (`StringEnum`,
  `parseFrontmatter`, `getAgentDir`) so it is fully standalone.
- **`codex-taskflow`** — run taskflow on OpenAI Codex: a `codex exec`-backed
  subagent runner, plus a dependency-free MCP server (`codex-taskflow-mcp-core`) that
  exposes `taskflow_run/list/show/verify/compile` to Codex users. Register with
  `codex mcp add taskflow -- codex-taskflow-mcp-core`.
- **Host-neutral `SubagentRunner` seam** — the engine drives any host via an
  injected `runTask`; `piSubagentRunner` and `codexSubagentRunner` are the two
  implementations.

### Changed
- **`pi-taskflow` is now the Pi adapter package** (same published name — existing
  `pi install npm:pi-taskflow` users are unaffected). It depends on
  `taskflow-core`.
- Repo restructured to **npm workspaces** under `packages/*`. Each package now
  **builds to `dist/` (`tsc` → `.js` + `.d.ts`)** and publishes the compiled
  output — required because Node refuses to type-strip `.ts` under `node_modules`.
  Dev still runs the TypeScript sources directly (a `development` export
  condition + `--conditions=development` resolves `taskflow-core` to `src`, so a
  fresh clone runs `typecheck`/`test` with no build step). CI builds and
  publishes the three packages in dependency order (core → pi → codex) on a
  `v*` tag.

### Notes
- All 864 tests pass across the three packages (713 core + 135 pi + 16 codex).
- See `RELEASE.md` for the publish flow.

## [0.0.28] — 2026-06-27

> Granular-reuse release: **incremental recompute goes from whole-flow to
> per-phase and per-item.** v0.0.27 *proved* the recompute cost win; this
> release makes that win far larger and easier to opt into. Editing one phase
> now invalidates only that phase and its transitive dependents (a sibling keeps
> its cache hit), a `map` phase re-executes only the items that actually changed,
> and a single `incremental` flag flips a whole flow into cross-run reuse without
> annotating every phase.

### Added
- **Per-phase structural sub-fingerprint (`v3:phasefp`).** The cache key now
  folds a per-phase fingerprint — the phase plus its transitive `dependsOn ∪ from`
  closure — instead of the whole-flow `v2:flowdef` hash. Editing phase B
  invalidates only B and its dependents; an independent sibling A keeps its hit.
  `cacheKeys` emits a 4-tier read ladder (`v3:phasefp` write → `v2:flowdef` →
  bare flowdef → legacy, all read-only) so the upgrade is additive — no
  miss-storm for unchanged flows. Fail-open: any per-phase error degrades that
  phase to the whole-flow hash. Soundness fallback to whole-flow when per-phase
  invalidation can't be statically guaranteed (flow-wide `contextSharing`, any
  `shareContext` phase in the closure, `join: "any"`, or sub-flow inner phases).
  (`extensions/flowir/phasefp.ts`, `test/cache-phasefp.test.ts` — 11 tests.)
- **Per-item cross-run caching for `map` phases.** When one of N items changes
  between runs, only that item re-executes (N−1 cache hits) while the whole-map
  fast path and every soundness fallback stay intact. Per-item keys omit the
  structural fingerprint (which hashes the whole `over` source) so changing one
  item no longer moves every key at once; they fold `[phase.id, it.agent, model,
  it.task]` + the world-state tail, so task/agent/upstream/world changes still
  invalidate the right items. Disabled (whole-map only) under run-only/off scope,
  `shareContext`/flow-wide `contextSharing`, or inside a runtime-generated
  sub-flow. (`test/cache-peritem.test.ts` — 11 tests.)
- **`incremental` flag** — flow-level (`TaskflowSchema.incremental`) and
  invocation-level (`run` tool arg). Defaults every phase to `scope:"cross-run"`
  so re-running a flow reuses unchanged phases across runs/sessions, without
  annotating each phase. The invocation arg wins over the flow field; per-phase
  cache settings and the cross-run-blocked types (gate/approval/loop/tournament)
  still take precedence; default remains the safe `run-only` (fresh each run).
  (`resolveCacheScope` in `extensions/index.ts`, `test/incremental-flag.test.ts`.)
- **Reuse reporting.** The end-of-run cache report and `/tf recompute` now show
  reused-vs-executed counts and a per-phase "Why" trace (the explainable-
  reactivity view: `▲ rerun / ✂ cutoff / ✓ reused / ✗ failed`, with `← causedBy`).
  Dollar figures are reported only for within-run reuse, where the prior usage is
  preserved; cross-run hits are counted but never attributed an invented saving.
  (`summarizeReuse` / `RecomputeDecision` in `extensions/runtime.ts`,
  `test/reuse-summary.test.ts`.)
- Tests: 804 → 846 (+42).

### Changed
- **`phaseFingerprint` strips more policy fields** (`cache`, `retry`,
  `concurrency`, `final`): none changes a phase's subagent *output*, so a no-op
  config tweak no longer causes false cache invalidation.
- **README** test count and feature line refreshed (804 → 846 across 46 files);
  `per-item map caching` added to the headline capabilities.

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
