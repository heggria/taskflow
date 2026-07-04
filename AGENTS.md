# AGENTS.md

> Instructions for AI coding agents working on taskflow.

## Project Overview

taskflow is a **declarative DAG orchestration runtime** for coding agents — it runs on the [Pi coding agent](https://pi.dev), on [OpenAI Codex](https://github.com/openai/codex), on [Claude Code](https://claude.com/product/claude-code), and on [OpenCode](https://opencode.ai). It lets users define multi-phase workflows (fan-out, gate, loop, tournament, approval, sub-flow composition) as JSON DSL, executes them via isolated subagent processes, and returns only the final result — intermediate transcripts never enter the host context window.

**Language:** TypeScript (ES2022, ESM, `--experimental-strip-types` for direct execution in dev)\
**Runtime:** Node.js ≥ 22.19 (uses `fs.globSync`, `Atomics.wait`)\
**Dependencies:** Zero runtime deps. The Pi adapter (`pi-taskflow`) peer-depends on `@earendil-works/pi-{agent-core,ai,coding-agent,tui}`; the host-neutral MCP server (`taskflow-mcp`) and the three MCP host adapters (`codex-taskflow`, `claude-taskflow`, `opencode-taskflow`) all depend on `taskflow-core` (the adapters also depend on `taskflow-mcp`). Everything depends on `typebox`.\
**Layout:** pnpm-workspace monorepo of six published packages — `taskflow-core` (host-neutral engine), `taskflow-mcp` (the host-neutral MCP server + DAG renderer, depends on core), `pi-taskflow` (Pi extension adapter, installed via `pi install npm:pi-taskflow`), `codex-taskflow` (Codex runner + MCP bin + a `plugin/` scaffold installable via `codex plugin add`), `claude-taskflow` (Claude Code runner + MCP bin + a `plugin/` scaffold installable via `claude plugin install`), and `opencode-taskflow` (OpenCode runner + MCP bin + an `opencode.json` config scaffold).\
**Build:** each package compiles to `dist/*.js` + `.d.ts` (`tsc`); published packages ship `dist` (Node refuses to type-strip `.ts` under `node_modules`). Dev resolves the TypeScript sources directly via a `development` export condition — no build needed to typecheck or test.

## Architecture

```
packages/
├─ taskflow-core/          ← host-neutral engine (zero host-SDK deps; only typebox)
│  ├─ src/
│  │  ├─ index.ts          ← barrel: re-exports the engine's public surface
│  │  ├─ schema.ts         ← Taskflow DSL TypeBox schema, validation, desugar, topo sort
│  │  ├─ runtime.ts        ← orchestration engine: DAG resolution, phase execution, caching
│  │  ├─ runner-core.ts    ← host-neutral helpers: failure classification, NDJSON accumulator,
│  │  │                       sanitize, mapWithConcurrencyLimit (the pure half of the old runner)
│  │  ├─ interpolate.ts    ← template interpolation ({steps.X.output}), condition parser (when/eval)
│  │  ├─ agents.ts         ← agent discovery (~/.pi/agent/agents/*.md + .pi/agents/*.md)
│  │  ├─ store.ts          ← persistence: flow definitions + run state + file locks + index
│  │  ├─ cache.ts          ← cross-run memoization: fingerprint resolution + CacheStore
│  │  ├─ verify.ts         ← static DAG verification (zero-token structural analysis)
│  │  ├─ compile.ts        ← Mermaid diagram + verify report renderer
│  │  ├─ context-store.ts  ← Shared Context Tree: blackboard + supervision (ctx_read/write/report/spawn)
│  │  ├─ detached-runner.ts← spawn-only entry for background runs (NOT in the barrel)
│  │  ├─ usage.ts          ← token/cost accounting (UsageStats type + aggregation)
│  │  ├─ stale.ts / workspace.ts / flowir/  ← staleness, worktrees, FlowIR compile seam
│  │  ├─ host/runner-types.ts ← the host-neutral SubagentRunner contract + vendored CoreMessage
│  │  ├─ runner-core.ts  ← ALSO hosts the shared `runSubagentProcess` (spawn/idle/abort/classify) +
│  │  │                     `SubagentAccumulator` + `unknownAgentResult` reused by every host runner
│  │  ├─ typebox-helpers.ts / frontmatter.ts / paths.ts  ← vendored pi-SDK helpers (zero-dep)
│  │  └─ agents/           ← 18 built-in agent definitions (*.md with YAML frontmatter; copied to dist)
│  └─ test/              ← engine unit tests
├─ taskflow-mcp/           ← host-neutral MCP server (depends on taskflow-core)
│  ├─ src/mcp/            ← jsonrpc.ts (stdio JSON-RPC), server.ts (taskflow_* tools; parameterized by
│  │                        a SubagentRunner), svg.ts (DAG SVG/outline renderer)
│  └─ test/              ← (covered by the host adapters' MCP tests)
├─ pi-taskflow/            ← Pi extension adapter (depends on taskflow-core)
│  ├─ src/
│  │  ├─ index.ts          ← entry: registers `taskflow` tool + `/tf` commands + events with Pi
│  │  ├─ runner.ts         ← pi subagent spawn (child_process `pi --mode json`); re-exports core helpers
│  │  ├─ render.ts / runs-view.ts / approval-view.ts  ← pi-tui rendering + interactive views
│  │  └─ init.ts           ← /tf init command: scaffolds a taskflow / model roles interactively
│  ├─ test/              ← pi-adapter unit tests + .mts e2e scripts
│  └─ skills/            ← GENERATED per-host skill files (do not edit; see skills-src/)
└─ codex-taskflow/         ← Codex adapter (depends on taskflow-core)
   ├─ src/
   │  ├─ codex-runner.ts   ← codex subagent runner (`codex exec --json`) + CodexSubagentRunner
   │  └─ mcp/              ← thin bind: server.ts re-exports core's MCP server bound to codexSubagentRunner; bin.ts
   ├─ plugin/            ← Codex plugin scaffold (`codex plugin add taskflow@taskflow`)
   │  ├─ .codex-plugin/plugin.json  ← plugin manifest (skills + mcpServers pointers)
   │  ├─ .mcp.json         ← declares the taskflow MCP server via `npx codex-taskflow`
   │  ├─ skills/taskflow/  ← GENERATED per-host skill files (do not edit; see skills-src/)
   │  └─ assets/           ← plugin icons (taskflow.svg, taskflow-small.svg)
   └─ test/              ← codex-adapter unit tests + .mts e2e scripts
└─ claude-taskflow/        ← Claude Code adapter (depends on taskflow-core)
   ├─ src/
   │  ├─ claude-runner.ts  ← claude subagent runner (`claude -p --output-format stream-json`) + ClaudeSubagentRunner
   │  └─ mcp/              ← thin bind: server.ts re-exports core's MCP server bound to claudeSubagentRunner; bin.ts
   ├─ plugin/            ← Claude Code plugin scaffold (`claude plugin install claude-taskflow@taskflow`)
   │  ├─ .claude-plugin/plugin.json ← plugin manifest
   │  ├─ .mcp.json         ← declares the taskflow MCP server via `npx claude-taskflow`
   │  ├─ skills/taskflow/  ← GENERATED per-host skill files (do not edit; see skills-src/)
   │  └─ assets/           ← plugin icons (taskflow.svg, taskflow-small.svg)
   └─ test/              ← claude-adapter unit tests + .mts e2e scripts
└─ opencode-taskflow/      ← OpenCode adapter (depends on taskflow-core)
   ├─ src/
   │  ├─ opencode-runner.ts← opencode subagent runner (`opencode run --format json`) + OpencodeSubagentRunner
   │  └─ mcp/              ← thin bind: server.ts re-exports core's MCP server bound to opencodeSubagentRunner; bin.ts
   ├─ plugin/            ← OpenCode config scaffold (no marketplace; users add the mcp entry)
   │  ├─ opencode.json     ← ready-to-copy config: mcp.taskflow (npx opencode-taskflow) + skills.paths
   │  ├─ skills/taskflow/  ← GENERATED per-host skill files (do not edit; see skills-src/)
   │  └─ assets/           ← icons (taskflow.svg, taskflow-small.svg)
   └─ test/              ← opencode-adapter unit tests + .mts e2e scripts

.claude-plugin/           ← marketplace.json (repo-root; shared by both `codex plugin marketplace add`
                            and `claude plugin marketplace add heggria/taskflow`; lists the
                            `taskflow` [codex] and `claude-taskflow` [claude] plugins. OpenCode has
                            no marketplace — it registers the MCP server via opencode.json)

skills-src/taskflow/      ← SINGLE SOURCE for all hosts' skills: entry.pi.md + entry.codex.md +
                            entry.claude.md + entry.opencode.md (frontmatter + host binding) +
                            core.md/patterns.md/advanced.md/configuration.md (shared body with
                            <!-- host:pi/codex/claude/opencode --> blocks; the host field is a
                            comma-list, e.g. <!-- host:codex,claude,opencode -->). Compiled by
                            scripts/build-skills.mjs (npm run build:skills); drift-guarded by
                            packages/pi-taskflow/test/skills-build.test.ts.
scripts/                  ← build helpers (copy-agents.mjs, build-skills.mjs)
examples/                 ← runnable flow definitions (.json)
docs/                     ← design docs, RFCs, dogfooding reports, codex-mcp guide
tsconfig.base.json        ← shared compiler options; per-package tsconfig.build.json emits dist
```

## Key Concepts

### Phase Types (10 total)
| Type | Purpose |
|------|---------|
| `agent` | Single subagent call |
| `parallel` | Static concurrent branches |
| `map` | Dynamic fan-out over an array (one subagent per item) |
| `gate` | Quality gate — can halt the flow on `VERDICT: BLOCK` |
| `reduce` | Aggregate multiple upstream outputs into one |
| `approval` | Human-in-the-loop pause (approve/reject/edit) |
| `flow` | Run a saved sub-taskflow as a single phase |
| `loop` | Repeat body until condition, convergence, or max iterations |
| `tournament` | N competing variants + judge picks best or aggregates |
| `script` | Run a shell command (no LLM, zero tokens) — captures stdout; fields `run`/`input`/`timeout` |

### Control Flow Fields
- `when` — conditional guard (expression must be truthy)
- `join` — `"all"` (default) or `"any"` (OR-join)
- `retry` — `{max, backoffMs, factor}` with exponential backoff
- `timeout` — per-subagent-call ms cap (agent-running phases); expiry aborts + fails with `timedOut`, never retried
- `expect` — output contract for `output:"json"` phases (`{type, properties, required, items, enum}`); violation fails the phase, retryable via `retry`
- `dependsOn` — DAG edges
- `budget` — `{maxUSD, maxTokens}` run-wide cost ceiling

### Interpolation Placeholders
- `{args.X}` — invocation argument
- `{steps.ID.output}` — phase text output
- `{steps.ID.json}` / `{steps.ID.json.field}` — parsed JSON
- `{item}` / `{item.field}` — map loop variable
- `{previous.output}` — immediately upstream phase output

## Development Commands

```bash
pnpm install           # links the six workspace packages
pnpm run typecheck     # tsc --noEmit across all packages (resolves taskflow-core to src via the dev condition)
pnpm test              # full unit suite (node --experimental-strip-types --test)
pnpm run test:core     # engine tests only
pnpm run test:pi       # pi-adapter tests only
pnpm run test:codex    # codex-adapter tests only
pnpm run test:claude   # claude-adapter tests only
pnpm run test:opencode # opencode-adapter tests only
pnpm run build         # emit dist/*.js + .d.ts for all six packages
pnpm run test:e2e-codex          # codex executor e2e (needs live codex + model access)
pnpm run test:e2e-codex-mcp       # codex MCP stdio e2e (src)
pnpm run test:e2e-codex-mcp-full  # codex MCP comprehensive e2e against the built dist (runs build first)
pnpm run test:e2e-claude          # claude executor e2e (needs live claude + model access)
pnpm run test:e2e-claude-mcp      # claude MCP stdio e2e (src; no live claude needed)
pnpm run test:e2e-opencode        # opencode executor e2e (needs live opencode; uses a free model by default)
pnpm run test:e2e-opencode-mcp    # opencode MCP stdio e2e (src; no live opencode needed)
# pi e2e suites are run directly (they use .mts so the unit glob skips them):
#   node --conditions=development --experimental-strip-types packages/pi-taskflow/test/e2e.mts
```

## Coding Conventions

### Git
- **Commit messages must be in English** using [Conventional Commits](https://www.conventionalcommits.org/) format: `type(scope): description`.
- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`.
- Scope is optional (e.g. `feat(runtime):`, `fix(schema):`, `docs:`).
- Keep the subject line under 72 characters. Add a body for non-trivial changes.
- Examples:
  ```
  feat(runtime): add loop phase convergence detection
  fix(runner): sanitize HTML error messages from upstream providers
  test: add coverage for transient error retry heuristic
  docs: add AGENTS.md project guide for AI coding agents
  ```

### TypeScript
- **ESM only** (`"type": "module"` in package.json). Use `import`/`export`, never `require`.
- **Import extensions required**: `import { foo } from "./bar.ts"` (TypeScript verbatim module syntax).
- **Strict mode** enabled. `noUnusedLocals: true` — remove unused imports.
- **No `any`** without justification. Use `unknown` and narrow.
- **TypeBox** for runtime schema validation (`Type.Object(...)`, `Static<typeof Schema>`).

### Naming
- **Agent names use hyphens**: `executor-code`, `risk-reviewer` (never `executor_code`).
- **Phase IDs use hyphens**: `audit-each`, `final-report` (interpolation: `{steps.audit-each.output}`).
- **Files**: `kebab-case.ts`.

### Error Handling
- **Fail-open for guards**: `when` parse errors → phase still runs (never silently drop).
- **Fail-open for gates**: ambiguous gate output → `PASS` (never accidentally halt).
- **Fail-open for tournament**: unparseable winner → variant 1 (never lose work).
- **Safe emit**: user callbacks (`persist`, `onProgress`) are wrapped in try/catch — a throwing callback must never replace the runtime's outcome.
- **Transient retry**: rate limits, 5xx, timeouts are auto-retried up to 3 times with backoff.

### Storage
- **Atomic writes**: `writeFileAtomic()` — write to temp file, then `renameSync` (atomic on POSIX/NTFS).
- **File locks**: `O_CREAT|O_EXCL` (`wx` flag) with stale-lock steal via atomic rename.
- **Path traversal guards**: `validateRunId()`, `safeFlowDirName()`, symlink resolution + containment check.

### Testing
- **Framework**: Node.js built-in `node:test` + `node:assert/strict`.
- **Pattern**: Each test file focuses on one module. Use `test("description: scenario", () => {})`.
- **Mock runner**: Create a `RuntimeDeps["runTask"]` function that returns canned `RunResult` objects.
- **Temp dirs**: `fs.promises.mkdtemp(path.join(os.tmpdir(), "prefix-"))` — always clean up in finally/after.
- **Environment**: `PI_TASKFLOW_BUILTIN_AGENTS_DIR=` (empty) disables built-in agent loading in tests.
- **New test files**: name them `<name>.test.ts` in the owning package's `test/` dir — each `test:*` script globs `packages/<pkg>/test/*.test.ts`, so they're picked up automatically (no manual list to update). E2E scripts use the `.mts` extension specifically so the glob excludes them (they need a live `pi`/`codex`).

### File Structure Rules
- **Source**: `.ts` source lives in `packages/<pkg>/src/`. Host-neutral logic goes in `taskflow-core`; host-specific code (spawn, TUI) goes in the `pi-taskflow` / `codex-taskflow` adapters. `taskflow-core` must never import a host SDK (`@earendil-works/*`).
- **Imports**: adapters import the engine via the bare specifier `taskflow-core` (never a relative path into `../taskflow-core/src`). The MCP server lives in the separate `taskflow-mcp` package — host adapters import it via `taskflow-mcp/server` / `taskflow-mcp/jsonrpc`. `detached-runner.ts` is spawn-only — reference it by `taskflow-core/detached-runner.js`, never via the barrel. `runSubagentProcess` (in `runner-core.ts`, re-exported from the `taskflow-core` barrel) is the shared spawn+classify helper every host runner delegates to.
- **Tests**: `.test.ts` in the owning package's `test/`. Named `<module>.test.ts` or `<feature>.test.ts`.
- **Agents**: built-in agent `.md` files in `packages/taskflow-core/src/agents/` (copied to `dist/agents` at build).
- **Examples**: flow definitions as `.json` in `examples/`.

## Common Tasks

### Adding a New Phase Type
1. Add the type string to `PHASE_TYPES` in `schema.ts`.
2. Add per-type validation in `validateTaskflow()`.
3. Add the execution branch in `executePhase()` in `runtime.ts`.
4. Add tests in `packages/taskflow-core/test/runtime-branches.test.ts` (or a new file).
5. Update the skill sources in `skills-src/taskflow/` (never the generated files) and run `node scripts/build-skills.mjs`.

### Adding a New Condition Operator
1. Add the token to `OPS` in `interpolate.ts`.
2. Handle it in `tokenize()`, `CondParser.parseComparison()`, or `compare()`.
3. Add tests in `packages/taskflow-core/test/interpolate-extended.test.ts`.

### Adding a Cache Fingerprint Prefix
1. Add the prefix string to `CACHE_FINGERPRINT_PREFIXES` in `schema.ts`.
2. Implement resolution in `resolveOne()` in `cache.ts`.
3. Add validation in `validateTaskflow()`.
4. Add tests in `packages/taskflow-core/test/store-extended.test.ts`.

### Modifying the DSL Schema
1. Edit the TypeBox schema in `schema.ts` (PhaseSchema / TaskflowSchema).
2. Update `validateTaskflow()` if new constraints are needed.
3. Update `desugar()` if the shorthand needs to emit the new field.
4. Update `interpolate.ts` if new placeholder paths are introduced.
5. Update the skill sources in `skills-src/taskflow/` and `README.md`, then run `node scripts/build-skills.mjs`.

> All of `schema.ts`, `runtime.ts`, `interpolate.ts`, `cache.ts`, `agents.ts` live in `packages/taskflow-core/src/`.

## Critical Invariants

1. **Never leak intermediate results to the host context.** Only `finalOutput` is returned.
2. **Never let a throwing callback crash the runtime.** `safeEmit`/`safeProgress` swallow errors.
3. **Never silently drop a phase.** Parse errors in `when` → fail-open (phase runs).
4. **Never lose work.** Tournament judge failure → fallback to best variant. Gate ambiguity → PASS.
5. **Never hang forever.** Idle watchdog kills stalled subagents. Loops have hard iteration caps.
6. **Never break on resume.** Re-running a phase clears stale `endedAt`/`error` before starting.
7. **File operations must be atomic.** `writeFileAtomic` + file locks for all persistence.

## Key Files Reference

All engine files live in `packages/taskflow-core/src/`; the pi entry lives in `packages/pi-taskflow/src/`.

| File | Responsibility |
|------|----------------|
| `runtime.ts` | Core orchestration: `executeTaskflow()`, `executePhase()`, all 10 phase types |
| `schema.ts` | DSL types, validation, desugar, topo sort, cycle detection |
| `runner-core.ts` | Host-neutral runner helpers: failure classification, NDJSON accumulator, error sanitization, `mapWithConcurrencyLimit`, AND `runSubagentProcess` (the shared spawn/idle/abort/classify block every host runner delegates to) + `unknownAgentResult` |
| `taskflow-mcp/src/mcp/server.ts` | Host-neutral MCP server: the `taskflow_*` tool schemas + handlers, parameterized by a `SubagentRunner` (codex/claude/opencode adapters bind their runner + a thin bin) |
| `pi-taskflow/src/runner.ts` | Pi subagent spawn (`pi --mode json`), idle watchdog; re-exports the core helpers |
| `codex-taskflow/src/codex-runner.ts` | Codex subagent spawn (`codex exec --json`); `codexSubagentRunner` |
| `claude-taskflow/src/claude-runner.ts` | Claude Code subagent spawn (`claude -p --output-format stream-json`); `claudeSubagentRunner` + permission mapping |
| `opencode-taskflow/src/opencode-runner.ts` | OpenCode subagent spawn (`opencode run --format json`); `opencodeSubagentRunner` + model resolution + permission mapping |
| `store.ts` | Persistence, file locks, index, cleanup, atomic writes |
| `interpolate.ts` | Template resolution, condition parser, safeParse, coerceArray |
| `cache.ts` | Fingerprint resolution (git/glob/file/env), CacheStore |
| `verify.ts` | Static DAG analysis (dead-end, unreachable, gate-exhaustion, budget) |
| `agents.ts` | Agent discovery, settings overrides, model role resolution |
| `pi-taskflow/src/index.ts` | Pi extension entry: `taskflow` tool + `/tf` command registration, init |
| `render.ts` (pi) | TUI phase rendering, progress bars, timing |
