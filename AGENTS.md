# AGENTS.md

> Instructions for AI coding agents working on pi-taskflow.

## Project Overview

pi-taskflow is a **declarative DAG orchestration runtime** for the [Pi coding agent](https://pi.dev). It lets users define multi-phase workflows (fan-out, gate, loop, tournament, approval, sub-flow composition) as JSON DSL, executes them via isolated subagent processes, and returns only the final result — intermediate transcripts never enter the host context window.

**Language:** TypeScript (ES2022, ESM, `--experimental-strip-types` for direct execution)  
**Runtime:** Node.js ≥ 22 (uses `fs.globSync`, `Atomics.wait`)  
**Dependencies:** Zero runtime deps. Peer deps on `@earendil-works/pi-{agent-core,ai,coding-agent,tui}` and `typebox`.  
**Package type:** Pi extension (`pi-package` keyword) — installed via `pi install npm:pi-taskflow`

## Architecture

```
extensions/           ← All source code lives here (no src/ directory)
├── index.ts          ← Entry point: registers tool + commands + events with Pi
├── schema.ts         ← Taskflow DSL TypeBox schema, validation, desugar, topo sort
├── runtime.ts        ← Orchestration engine: DAG resolution, phase execution, caching
├── runner.ts         ← Subagent spawn (child_process), NDJSON event parsing, idle watchdog
├── interpolate.ts    ← Template interpolation ({steps.X.output}), condition parser (when/eval)
├── agents.ts         ← Agent discovery (~/.pi/agent/agents/*.md + .pi/agents/*.md)
├── store.ts          ← Persistence: flow definitions + run state + file locks + index
├── cache.ts          ← Cross-run memoization: fingerprint resolution + CacheStore
├── verify.ts         ← Static DAG verification (zero-token structural analysis)
├── usage.ts          ← Token/cost accounting (UsageStats type + aggregation)
├── render.ts         ← TUI rendering for phase progress and run views
├── runs-view.ts      ← Interactive run history TUI
├── init.ts           ← /tf init command: scaffolds a new taskflow interactively
└── agents/           ← 18 built-in agent definitions (*.md with YAML frontmatter)

test/                 ← Unit tests (Node.js built-in test runner)
skills/               ← SKILL.md files that teach the LLM how to write taskflows
examples/             ← Runnable flow definitions (.json)
docs/                 ← Design docs, RFCs, dogfooding reports
```

## Key Concepts

### Phase Types (9 total)
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

### Control Flow Fields
- `when` — conditional guard (expression must be truthy)
- `join` — `"all"` (default) or `"any"` (OR-join)
- `retry` — `{max, backoffMs, factor}` with exponential backoff
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
npm run typecheck     # tsc --noEmit (type-check only, no emit)
npm test              # 519 unit tests via node --experimental-strip-types --test
npm run test:e2e      # End-to-end tests (needs live pi + model access)
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
- **New test files**: Add to the `test` script in `package.json`.

### File Structure Rules
- **Source**: All `.ts` source in `extensions/`. No `src/` directory.
- **Tests**: All `.test.ts` in `test/`. Named `<module>.test.ts` or `<feature>.test.ts`.
- **Agents**: Built-in agent `.md` files in `extensions/agents/`.
- **Examples**: Flow definitions as `.json` in `examples/`.

## Common Tasks

### Adding a New Phase Type
1. Add the type string to `PHASE_TYPES` in `schema.ts`.
2. Add per-type validation in `validateTaskflow()`.
3. Add the execution branch in `executePhase()` in `runtime.ts`.
4. Add tests in `test/runtime-branches.test.ts` (or a new file).
5. Update `SKILL.md` with usage guidance.

### Adding a New Condition Operator
1. Add the token to `OPS` in `interpolate.ts`.
2. Handle it in `tokenize()`, `CondParser.parseComparison()`, or `compare()`.
3. Add tests in `test/interpolate-extended.test.ts`.

### Adding a Cache Fingerprint Prefix
1. Add the prefix string to `CACHE_FINGERPRINT_PREFIXES` in `schema.ts`.
2. Implement resolution in `resolveOne()` in `cache.ts`.
3. Add validation in `validateTaskflow()`.
4. Add tests in `test/store-extended.test.ts`.

### Modifying the DSL Schema
1. Edit the TypeBox schema in `schema.ts` (PhaseSchema / TaskflowSchema).
2. Update `validateTaskflow()` if new constraints are needed.
3. Update `desugar()` if the shorthand needs to emit the new field.
4. Update `interpolate.ts` if new placeholder paths are introduced.
5. Update `SKILL.md` and `README.md`.

## Critical Invariants

1. **Never leak intermediate results to the host context.** Only `finalOutput` is returned.
2. **Never let a throwing callback crash the runtime.** `safeEmit`/`safeProgress` swallow errors.
3. **Never silently drop a phase.** Parse errors in `when` → fail-open (phase runs).
4. **Never lose work.** Tournament judge failure → fallback to best variant. Gate ambiguity → PASS.
5. **Never hang forever.** Idle watchdog kills stalled subagents. Loops have hard iteration caps.
6. **Never break on resume.** Re-running a phase clears stale `endedAt`/`error` before starting.
7. **File operations must be atomic.** `writeFileAtomic` + file locks for all persistence.

## Key Files Reference

| File | Lines | Responsibility |
|------|-------|----------------|
| `runtime.ts` | ~1340 | Core orchestration: `executeTaskflow()`, `executePhase()`, all 9 phase types |
| `schema.ts` | ~550 | DSL types, validation, desugar, topo sort, cycle detection |
| `runner.ts` | ~420 | Subagent spawn, NDJSON parsing, error sanitization, idle watchdog |
| `store.ts` | ~650 | Persistence, file locks, index, cleanup, atomic writes |
| `interpolate.ts` | ~350 | Template resolution, condition parser, safeParse, coerceArray |
| `cache.ts` | ~220 | Fingerprint resolution (git/glob/file/env), CacheStore |
| `verify.ts` | ~260 | Static DAG analysis (dead-end, unreachable, gate-exhaustion, budget) |
| `agents.ts` | ~230 | Agent discovery, settings overrides, model role resolution |
| `index.ts` | ~400 | Extension entry: tool registration, command registration, init |
| `render.ts` | ~250 | TUI phase rendering, progress bars, timing |
