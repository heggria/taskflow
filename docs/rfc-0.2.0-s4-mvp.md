# RFC: taskflow 0.2.0 S4 MVP — `taskflow-dsl` public surface

> Status: **PROPOSED — awaiting human lock** · Design-only · 2026-07-09  
> Parent: [`rfc-0.2.0-architecture.md`](./rfc-0.2.0-architecture.md) §4.3 / §9 S4  
> Syntax authority: [`rfc-0.2.0-dsl-syntax.md`](./rfc-0.2.0-dsl-syntax.md) v2 (**FULL language goal**; ship gate is this MVP doc)  
> Route lock: north-star 决策1 + this document §0  
> Provenance: multi-agent council runs `s4-shape-council` + `s4-shape-council-v2` + `s4-shape-finalize` (inventory → route tournament → surface → adversary → cross-check)

This document freezes the **publishable public surface** of `packages/taskflow-dsl` for the S4 MVP ship gate. It is intentionally narrower than full DSL RFC coverage: what agents and humans import, invoke, and get wrong messages for — not the full transform implementation plan.

### Authority amendment (council B1 — must land with S4)

| Layer | Meaning |
|-------|---------|
| **DSL RFC v2 FULL** | Long-horizon language goal: every JSON field eventually has a DSL expression (§A). |
| **S4 MVP ship gate (this doc)** | Finite Y-rows + demo `hashFlowIR` equality — **not** every `PhaseSchema` field on day 1. |

DSL v2 hard constraint “100% 功能覆盖” is **not** the S4 acceptance bar. Implementers must not expand S4 scope to FULL §A.

### Shape in one screen

| Decision | Value |
|----------|--------|
| **What S4 is** | New package `taskflow-dsl`: compile-time TypeScript frontend that **erases** `.tf.ts` → Taskflow JSON → (via core only) FlowIR |
| **What S4 is not** | A second runtime, kernel flip (S5), in-file JSON hybrid, or agent-default authoring path |
| **Primary model** | **Svelte-style** compile-time runes (AST erase; no interpret) |
| **Escape** | **Whole-file JSON** only (zero migration; dual frontend at file boundary) |
| **Toolchain** | **ts-morph** (+ pinned `typescript`) → Taskflow → `compileTaskflowToFlowIR` |
| **Package / bin** | `taskflow-dsl` / `taskflow-dsl {build,check,decompile,new}` |
| **Import** | `from "taskflow-dsl"` (not `"taskflow"` in S4) |
| **Hosts** | **CLI-first**; no new MCP / no auto-build on `taskflow_run` |
| **Ship bar** | Golden demos: DSL build FlowIR hash **==** hand JSON FlowIR hash (must include map + `json<T>` + templates, not only hello) |
| **Default author for agents** | Still **JSON** + existing MCP; DSL for humans / large typed flows |

---

## §0. Route lock (non-negotiable for S4)

| Pick | Value |
|------|--------|
| **Primary** | **Svelte-style compile-time erase** (runes are AST directives; runtime does not execute them) |
| **Escape** | **JSON-only** whole-file (existing Taskflow JSON remains first-class; zero migration) |
| **Build toolchain** | **ts-morph** (TypeScript Program + AST read → Taskflow JSON → core `compileTaskflowToFlowIR`) |

### Why (≤5)

- Architecture S4 is fixed as `.tf.ts → build → Taskflow → FlowIR` with demo FlowIR ≡ hand JSON; runtime runes would be a third executor and blow MVP scope.
- Solid Proxy dies on physics, not taste: no `currentObserver`, phase-not-yet-run, `.toString`/coercion/method chains break templates and deps (DSL v2 §0.3; north-star 决策1).
- Headline features (`json<T>()`, map templates, parallel destructure, `.output` → placeholders) need AST sight; a “correct Proxy” becomes an ad-hoc compiler worse than one intentional erase.
- Progressive migration is already dual-frontend at the **file** boundary (`.json` *or* `.tf.ts`); in-file hybrid (Vapor) adds a second grammar, handle↔id seams, and dilutes the S4 equality gate without tightening it.
- JSON stays zero-change and first-class whole-file escape; compensators are `check` / `build` / `verify` / `compile` / `peek`, not REPL-on-runes or degraded interpret mode.

### S4 MVP is NOT

- Solid runtime runes / Proxy / `currentObserver` graph building  
- Runnable unbuilt `.tf.ts` or “degraded interpret” next to JSON  
- In-file JSON phase literals (Vapor hybrid)  
- Breakpoint-on-`agent()` as a product promise  
- S5 kernel flip or any change to existing JSON Taskflow execution  

**WINNER_RATIONALE:** Svelte-style compile-time erase with whole-file JSON escape is the only path that satisfies architecture S4 (`.tf.ts→build→Taskflow→FlowIR`, JSON zero-change) without reopening rejected Proxy physics or hybrid grammar cost.

### Pipeline S4 owns

```
.tf.ts  ──build(AST / ts-morph)──▶  Taskflow JSON  ──compileTaskflowToFlowIR──▶  FlowIR (+ ir:<64-hex>)
.flow.json ──validate / desugar──▶  Taskflow JSON  ──same core entry only──▶  FlowIR
```

- **S4 stop line:** DSL package produces **Taskflow** (and may *call* core to emit FlowIR for CLI convenience).  
- **Single FlowIR entry:** only `taskflow-core`’s `compileTaskflowToFlowIR` / `hashFlowIR` (arch §4.2).  
- **Acceptance gate:** DSL demo FlowIR == hand-written JSON FlowIR (byte-stable `ir:<64-hex>`).

---

## §1. Package identity — `package.json`

### 1.1 Name, version, role

| Field | MVP value |
|-------|-----------|
| **name** | `taskflow-dsl` |
| **version** | tracks monorepo release line (`0.2.0` when shipped with 0.2.0) |
| **description** | Compile-time TypeScript DSL frontend for taskflow: erase `.tf.ts` runes to Taskflow JSON, then FlowIR via core |
| **type** | `"module"` |
| **engines** | `node: ">=22.19.0"` (same floor as monorepo) |
| **license / author / repository.directory** | match sibling packages; `directory: "packages/taskflow-dsl"` |

**Not** named `taskflow`. That umbrella name stays free for a future unified CLI/meta-package. Authoring imports use the package name (see §3).

### 1.2 Dependencies

| Dep | Kind | Why |
|-----|------|-----|
| `taskflow-core` | **dependency** (workspace pin, same version as siblings) | Taskflow types, `validateTaskflow` / `desugar`, `compileTaskflowToFlowIR`, `hashFlowIR`, `verifyTaskflow` |
| `ts-morph` | **dependency** | Project/SourceFile AST for build + check |
| `typescript` | **dependency** (or peer + dep) | Program host under ts-morph; pin compatible with monorepo devDependency |
| `typebox` | **peerDependency** `*` | Align with core; only if public types re-export expect shapes that mention TypeBox |

**Forbidden in this package:** host SDKs (`@earendil-works/*`), `taskflow-hosts`, `taskflow-mcp-core`, any process-spawning runner.

**Why not in core:** AST toolchain violates core’s zero-runtime-deps iron rule (arch §4.3). Core must never import `taskflow-dsl`.

### 1.3 `exports` map

```jsonc
{
  "name": "taskflow-dsl",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./build": {
      "development": "./src/build.ts",
      "types": "./dist/build.d.ts",
      "default": "./dist/build.js"
    },
    "./check": {
      "development": "./src/check.ts",
      "types": "./dist/check.d.ts",
      "default": "./dist/check.js"
    },
    "./decompile": {
      "development": "./src/decompile.ts",
      "types": "./dist/decompile.d.ts",
      "default": "./dist/decompile.js"
    },
    "./diagnostics": {
      "development": "./src/diagnostics.ts",
      "types": "./dist/diagnostics.d.ts",
      "default": "./dist/diagnostics.js"
    }
  },
  "bin": {
    "taskflow-dsl": "./dist/cli.js"
  },
  "files": ["dist"],
  "publishConfig": { "access": "public" }
}
```

| Export | Audience | Contents |
|--------|----------|----------|
| **`.`** | Authors of `*.tf.ts` | Runes + types only (`flow`, `agent`, `map`, …, `json`, `Phase`, …). **Compile stubs** — safe to typecheck under tsc; must not “run” a flow. |
| **`./build`** | Tooling / tests / optional host glue | `buildFile`, `buildSource`, `BuildOptions`, `BuildResult` |
| **`./check`** | Tooling / agents | `checkFile`, `checkSource` → diagnostics only |
| **`./decompile`** | Tooling / migration | `decompileTaskflow`, `decompileFlowIR` → source string |
| **`./diagnostics`** | Shared types | `Diagnostic`, severity, codes, formatters |

**MVP does not export:** `./experimental`, `./vapor`, `./runtime`, MCP server bindings, host runners.

**Development condition:** same monorepo pattern as siblings (`development` → `src/*.ts`) so tests run without a prior `tsc` emit.

### 1.4 `bin`

| Binary | Path | Role |
|--------|------|------|
| **`taskflow-dsl`** | `./dist/cli.js` | Only published bin for S4 MVP |

RFC prose that says `taskflow build` / `taskflow check` is the **conceptual** command surface. Implementation name is `taskflow-dsl <subcommand>` to avoid claiming a future umbrella `taskflow` CLI. Docs and skills for 0.2.0 should teach:

```bash
npx taskflow-dsl build ./audit.tf.ts
# or, after install:
taskflow-dsl check ./audit.tf.ts
```

Optional monorepo convenience (not published): root script `"dsl": "node --conditions=development … packages/taskflow-dsl/src/cli.ts"`.

---

## §2. CLI surface

Entry: `taskflow-dsl <command> [options] [path…]`  
Global flags (all commands):

| Flag | Meaning |
|------|---------|
| `--cwd <dir>` | Project root for path resolution / tsconfig discovery (default: `process.cwd()`) |
| `--json` | Machine-readable stdout (diagnostics + results as JSON) |
| `--no-color` | Disable ANSI (also respects `NO_COLOR`) |
| `-h` / `--help` | Command help |
| `-V` / `--version` | Package version |

Exit codes (stable for agents):

| Code | Meaning |
|------|---------|
| `0` | Success (check/build clean; decompile/new wrote output) |
| `1` | Diagnostics present at **error** severity (or validation failed) |
| `2` | Usage / I/O / unexpected internal failure |

Warnings alone → exit `0` (match common compiler UX); `--strict-warnings` (optional MVP-nice) promotes warnings to exit `1`.

### 2.1 `build`

```text
taskflow-dsl build <input> [options]
```

| Input | Behavior |
|-------|----------|
| `*.tf.ts` | AST erase → Taskflow → (optional) FlowIR via core |
| `*.json` / `*.jsonc` | **JSON escape path:** parse → `validateTaskflow` / `desugar` → same emit options (no ts-morph) |
| other extension | Error `TFDSL_INPUT_KIND` |

| Flag | Default | IO |
|------|---------|-----|
| `-o` / `--out <path>` | derived (see below) | Write primary artifact |
| `--emit taskflow\|flowir\|both` | `both` | What to write / print |
| `--stdout` | off | Print primary artifact to stdout (single emit mode); conflicts with multi-file unless `--emit` is one of taskflow\|flowir |
| `--pretty` | on for Taskflow JSON | Indent JSON |
| `--ir-hash` | on when emitting flowir | Include `hash` (`ir:<64-hex>`) in envelope or sidecar line |
| `--verify` | off | After emit, run `verifyTaskflow` on Taskflow; failures → diagnostics + exit 1 |
| `--tsconfig <path>` | walk-up `tsconfig.json` | For `.tf.ts` only |

**Default output paths** (when `-o` omitted, write next to input):

| Emit | Default file |
|------|----------------|
| taskflow | `<stem>.taskflow.json` |
| flowir | `<stem>.flowir.json` |
| both | both files |

**Stdout human mode (no `--json`):** short summary — name, phase count, `ir:<hash>` if computed, output paths.  
**Stdout `--json`:** `BuildResult` (§3.2).

**MVP non-goals for `build`:** watch mode, multi-file project graph beyond one entry `export default`, bundling imports of other `.tf.ts` (S4.1: `import` of subflow modules).

### 2.2 `check`

```text
taskflow-dsl check <input> [options]
```

Lightweight validation **without requiring artifact write**.

| Input | Checks |
|-------|--------|
| `*.tf.ts` | (1) tsc diagnostics for the file in a Program (2) rune shape / signature rules (3) static dep completeness warnings (4) `when` predicate subset (DSL v2 §5.1) (5) optional: lower to Taskflow in memory + `validateTaskflow` |
| `*.json` | `validateTaskflow` only |

| Flag | Default | Meaning |
|------|---------|---------|
| `--tsconfig <path>` | walk-up | `.tf.ts` only |
| `--no-typecheck` | off | Skip tsc; rune/static rules only (faster agent loop) |
| `--emit-taskflow` | off | Also build in-memory Taskflow and validate (closer to `build`, still no write) |

Does **not** write FlowIR. Does **not** call the runtime.

Stdout: human diagnostic list, or `--json` → `{ diagnostics: Diagnostic[] }`.

### 2.3 `decompile`

```text
taskflow-dsl decompile <input> [options]
```

| Input | Behavior |
|-------|----------|
| Taskflow JSON (`.json`) | Preferred MVP path: Taskflow → `.tf.ts` codegen |
| FlowIR JSON | Optional MVP if cheap: require sidecar-complete IR **or** reject with “pass Taskflow JSON” |
| `.tf.ts` | Error (already DSL) |

| Flag | Default | Meaning |
|------|---------|---------|
| `-o` / `--out <path>` | `<stem>.tf.ts` or stdout if `-o -` | Output path |
| `--name <id>` | from `def.name` | Override `flow("…")` name |
| `--style compact\|readable` | `readable` | Formatting only (semantic equivalence unchanged) |

**Honest contract (DSL v2 §6.2):** semantic equivalence under re-`build`, **not** literal round-trip. Variable names, template vs string placeholders, and formatting may change.

**MVP decompile coverage:** kinds and fields in the S4 MVP coverage slice only; advanced fields (`gate.scored`, multi-scorer, etc.) emit explicit options objects or `// TFDSL: unsupported-field` comments + warning diagnostics — never silent drop of execution-critical fields. If a field cannot be expressed in MVP runes, decompile **fails closed** with `TFDSL_DECOMPILE_UNSUPPORTED` (prefer fail over lying JSON↔DSL parity).

### 2.4 `new`

```text
taskflow-dsl new [name] [options]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `-o` / `--out <path>` | `./<name>.tf.ts` or `./hello.tf.ts` | Destination (refuse overwrite unless `--force`) |
| `--force` | off | Overwrite existing file |
| `--json-escape` | off | Emit a minimal **JSON** flow instead (escape hatch skeleton) |

**Default skeleton** (DSL v2 §8, ≤5 lines of substance):

```ts
import { flow, agent } from "taskflow-dsl";

export default flow("hello", () => agent("Say hello to {args.name}"));
```

If `name` provided, substitute `flow("<name>", …)` and default out file.

### 2.5 Commands explicitly **out of** `taskflow-dsl` MVP CLI

These stay on **core + host / MCP** (already shipped):

| Command / tool | Owner |
|----------------|--------|
| `verify` / `taskflow_verify` | core + mcp-core |
| `compile` (Mermaid/SVG) / `taskflow_compile` | core + mcp-core |
| `peek` / `taskflow_peek` | core + mcp-core |
| `run` / `taskflow_run` | mcp-core + host runners |
| `replay` / `taskflow_replay` | core + mcp-core (S3) |

S4 docs tell agents: **`check`/`build` here → `verify`/`run` there**. Optional `--verify` on `build` is a thin CLI convenience, not a second verify implementation.

---

## §3. Library API

### 3.1 Authoring surface (`import from "taskflow-dsl"`)

Rune functions are **type-level + compile-time directives**. At Node runtime they are stubs:

- Calling them outside `taskflow-dsl build` throws `TFDSL_ERASE_ONLY` (or returns a branded phantom used only in type positions — pick one implementation; **public contract:** “do not execute `.tf.ts` as a program”).
- tsc sees full typings for IDE / agent typecheck.

#### MVP exports (authoring)

```ts
// --- entry ---
export function flow(
  name: string,
  fn: (ctx: FlowCtx) => PhaseRef | void,
): TaskflowModuleDefault;
export function flow(
  name: string,
  opts: FlowOptions,
  fn: (ctx: FlowCtx) => PhaseRef | void,
): TaskflowModuleDefault;

// --- phase runes (MVP kinds) ---
export function agent(task: TemplateInput, opts?: PhaseOptions): PhaseRef;
export function parallel(
  branches: PhaseRef[],
  opts?: PhaseOptions,
): PhaseRef[] & PhaseRef; // compile-time destructure; type as tuple-friendly
export function map<TItem>(
  source: PhaseRef | Placeholder,
  fn: (item: ItemSymbol<TItem>) => PhaseRef,
  opts?: PhaseOptions,
): PhaseRef;
export function gate(
  upstream: PhaseRef,
  opts?: GateOptions,
  task?: (input: PhaseRef) => TemplateInput,
): PhaseRef;
export function reduce(
  from: PhaseRef[],
  fn: (parts: Record<string, PhaseRef>) => PhaseRef,
  opts?: PhaseOptions,
): PhaseRef;
export function approval(opts: { request: TemplateInput } & PhaseOptions): PhaseRef;
export function subflow(
  use: string,
  withArgs?: Record<string, unknown>,
  opts?: PhaseOptions,
): PhaseRef;
export function loop(opts: LoopOptions): PhaseRef;
export function tournament(opts: TournamentOptions): PhaseRef;
export function script(
  run: string | string[],
  opts?: ScriptOptions,
): PhaseRef;

// --- expect sugar ---
export function json<T>(): JsonExpectMarker<T>;

// --- types (erasable) ---
export type { PhaseRef, FlowCtx, FlowOptions, PhaseOptions, ItemSymbol, … };
```

#### `FlowCtx` MVP methods

| Method | JSON field | MVP |
|--------|------------|-----|
| `ctx.args.declare({…})` | `args` | **Y** — keys: `default?`, `description?`, `required?` only (**no `type`**) |
| `ctx.concurrency(n)` | `concurrency` | **Y** |
| `ctx.budget({ maxUSD?, maxTokens? })` | `budget` | **Y** |
| `ctx.scope` / `ctx.strict` / `ctx.share` / `ctx.incremental` | agentScope / strictInterpolation / contextSharing / incremental | **N** (S4.1) |

#### Explicitly **not** in MVP authoring export

| API | Reason |
|-----|--------|
| `gate.automated` / `gate.scored` | Coverage matrix N → S4.1 |
| `subflow.def(() => …)` | Dynamic inline def; engine exists, DSL compile cost high → S4.1 |
| `$store` / `$derived` / `flow.component` | post-0.2.0 (arch §12) |
| Runtime `execute*` anything | Wrong package |

Import path note: DSL RFC v2 samples use `"taskflow"`. **S4 MVP ships `"taskflow-dsl"`** only. A later `taskflow` meta-package may re-export; do not publish a second package name in MVP.

### 3.2 Compiler API (`taskflow-dsl/build`)

```ts
import type { Taskflow } from "taskflow-core";
import type { FlowIR } from "taskflow-core"; // or flowir schema type from core
import type { Diagnostic } from "taskflow-dsl/diagnostics";

export interface BuildOptions {
  cwd?: string;
  tsconfigPath?: string;
  /** default: true when caller wants IR equality gate */
  emitFlowIR?: boolean;
  verify?: boolean;
  /** Source path for diagnostic file field */
  fileName?: string;
}

export interface BuildResult {
  ok: boolean;
  taskflow?: Taskflow;
  flowir?: FlowIR;
  /** Present when flowir emitted and well-formed */
  hash?: `ir:${string}`;
  diagnostics: Diagnostic[];
}

/** Build from a filesystem path (.tf.ts | .json). */
export function buildFile(path: string, opts?: BuildOptions): Promise<BuildResult>;
// Sync variant allowed if ts-morph usage is sync-only:
export function buildFileSync(path: string, opts?: BuildOptions): BuildResult;

/** Build from source text (tests / MCP-later). `fileName` required for positions. */
export function buildSource(
  source: string,
  opts: BuildOptions & { fileName: string; kind?: "tf.ts" | "json" },
): BuildResult;
```

**Contract:**

1. On `ok: true`, `taskflow` is present and has passed `validateTaskflow` (post-desugar shape).  
2. When `emitFlowIR: true` and ok, `flowir` + `hash` come **only** from `compileTaskflowToFlowIR` + `hashFlowIR`.  
3. DSL package never reimplements IR lowering.

### 3.3 Check API (`taskflow-dsl/check`)

```ts
export interface CheckOptions {
  cwd?: string;
  tsconfigPath?: string;
  typecheck?: boolean; // default true for .tf.ts
  /** Lower + validateTaskflow without writing */
  emitTaskflow?: boolean; // default false
}

export interface CheckResult {
  ok: boolean; // no error-severity diagnostics
  diagnostics: Diagnostic[];
}

export function checkFile(path: string, opts?: CheckOptions): CheckResult;
export function checkSource(
  source: string,
  opts: CheckOptions & { fileName: string; kind?: "tf.ts" | "json" },
): CheckResult;
```

### 3.4 Decompile API (`taskflow-dsl/decompile`)

```ts
export interface DecompileOptions {
  name?: string;
  style?: "compact" | "readable";
}

export interface DecompileResult {
  ok: boolean;
  source?: string; // .tf.ts text
  diagnostics: Diagnostic[];
}

export function decompileTaskflow(def: Taskflow, opts?: DecompileOptions): DecompileResult;
/** MVP: may return not-ok with TFDSL_DECOMPILE_USE_TASKFLOW if IR incomplete. */
export function decompileFlowIR(ir: FlowIR, opts?: DecompileOptions): DecompileResult;
```

### 3.5 Scaffold API (used by CLI `new`)

```ts
export function skeletonTfTs(name?: string): string;
export function skeletonJson(name?: string): string;
```

### 3.6 What the library must **not** expose in MVP

- `interpretTfTs()` / `runUnbuilt()`  
- Proxy helpers, `currentObserver`, reactive graph APIs  
- Direct `executeTaskflow` wrappers (hosts already own run)

---

## §4. File convention — `*.tf.ts`

### 4.1 Recognition rules

| Rule | MVP |
|------|-----|
| Extension | **`*.tf.ts` only** (not `.tf.js`, not bare `.ts`) |
| Module shape | Exactly one **`export default flow(…)`** (or `export default` of the value returned by `flow`) |
| Side exports | **Forbidden** for build entry (`export const helpers` → error `TFDSL_ENTRY_SHAPE`) |
| Imports from `taskflow-dsl` | Runes/types only |
| Imports from other local modules | **N** in MVP (single-file flows); S4.1 may allow type-only or pure const imports |
| Top-level statements | Only imports + `export default flow(…)` |
| Executable as `node file.tf.ts` | **Unsupported**; stubs throw if runes invoked |

### 4.2 Discovery (for future host glue; CLI is path-explicit in MVP)

MVP CLI always takes an explicit path. Recommended project layout (non-normative):

```text
flows/
  audit.tf.ts          # DSL source
  audit.taskflow.json  # build emit (optional commit)
  audit.flowir.json    # build emit (optional; usually gitignored)
  legacy-audit.json    # JSON escape (hand-written)
```

Saved-flow library (`.pi/taskflows/*.json` etc.) remains **JSON** as today; S4 does not require hosts to load `.tf.ts` at run time. Author workflow: `build` → save/run JSON.

### 4.3 Naming

- Flow `name` (string arg to `flow`) = taskflow `name` field (library identity).  
- Phase ids = **const binding names** where possible (`const discover = agent(…)` → id `discover`); anonymous runes get synthetic ids (`agent_0`, …) with stable ordering rules documented in implementer notes.  
- IDs remain kebab-or-camel as bound; core already accepts phase ids used in `{steps.ID…}` — **prefer valid JS identifiers** that match existing JSON id style in demos (kebab via explicit `opts.id` if needed).

MVP option: `agent("…", { id: "audit-each" })` maps to JSON `id` when binding name differs — **Y** if `id` already exists on PhaseSchema; else use binding name only.

### 4.4 JSON escape file convention

- Any `*.json` / `*.jsonc` Taskflow document accepted by today’s `validateTaskflow`.  
- No `.tf.json` hybrid.  
- `build`/`check` treat JSON as the escape frontend; output FlowIR must match DSL-built FlowIR for the equality demos.

---

## §5. Diagnostics shape

### 5.1 Type

```ts
export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Position {
  /** 1-based */
  line: number;
  /** 1-based, code unit columns (tsc-compatible) */
  column: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  /** Stable machine code, e.g. "TFDSL0001" or "TFDSL_ERASE_ONLY" */
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  /** Absolute or cwd-relative path */
  file?: string;
  range?: Range;
  /** Optional agent-facing hint (how to fix) */
  hint?: string;
  /** Related spans (e.g. missing dependsOn target) */
  related?: Array<{ file?: string; range?: Range; message: string }>;
}
```

### 5.2 Code families (MVP reserved prefixes)

| Prefix | Domain |
|--------|--------|
| `TFDSL_ENTRY_*` | Module shape / export default / multi-flow |
| `TFDSL_RUNE_*` | Unknown rune, bad arity, disallowed call position |
| `TFDSL_TMPL_*` | Template → placeholder erase failures |
| `TFDSL_WHEN_*` | Predicate subset violations |
| `TFDSL_JSON_T_*` | `json<T>()` unrepresentable types |
| `TFDSL_DEP_*` | Dependency auto-edge warnings / cycles at DSL layer |
| `TFDSL_IMPORT_*` | Illegal imports (see §6) |
| `TFDSL_DECOMPILE_*` | Codegen unsupported / incomplete |
| `TFDSL_IO_*` | CLI filesystem / tsconfig |
| `TFDSL_CORE_*` | Wrapped `validateTaskflow` / verify messages (preserve core text in `message`, code maps or nests) |

Human formatter example:

```text
audit.tf.ts:12:5 - error TFDSL_WHEN_METHOD: when-predicates cannot call methods (.includes).
  hint: Use a string when: "{steps.x.output} contains 'ok'" instead.
```

`--json` CLI wraps:

```json
{
  "ok": false,
  "diagnostics": [ /* Diagnostic */ ]
}
```

### 5.3 Severity policy

| Class | Severity |
|-------|----------|
| Unerasable construct, invalid entry, validateTaskflow error | **error** |
| Phase with no auto-deps and not first (DSL v2 §5.4) | **warning** |
| Decompile pretty-print lossiness | **info** / silence |
| `json<T>()` too complex | **error** (no silent drop — DSL v2 §4.1) |

---

## §6. Core import allowlist / denylist

`taskflow-dsl` may depend on `taskflow-core` **only** through the following surfaces. Enforce with an import-lint test (mirror `replay-import-lint` spirit).

### 6.1 Allowlist (MVP)

| Core surface | Use in DSL |
|--------------|------------|
| `Taskflow`, `Phase`, `PhaseType`, `PHASE_TYPES`, arg/budget types from `schema` | Output typing + guards |
| `validateTaskflow`, `desugar`, `topoLayers` / `dependenciesOf` (if needed for warnings) | Post-erase validation |
| `compileTaskflowToFlowIR`, `CompileTaskflowToFlowIRResult` | IR emit |
| `hashFlowIR` / compile envelope hash from `compileTaskflowToIR` helper | `ir:<64-hex>` |
| `verifyTaskflow` | CLI `--verify` only |
| FlowIR types (`FlowIR`, `FlowIRNode`, …) | decompile input typing + emit typing |
| Pure helpers strictly needed for placeholder parity (e.g. cond normalize) | only if build must match runtime when-strings |

Prefer **barrel** `taskflow-core` or narrow subpaths already exported (`taskflow-core/flowir/*` if published). Do not deep-import non-exported internals.

### 6.2 Denylist (hard)

| Core / monorepo surface | Why denied |
|-------------------------|------------|
| `runtime.ts` / `executeTaskflow` / `executePhase` | S4 must not run flows |
| `exec/driver`, `exec/step`, `exec/fold` | Kernel path; S5 concern |
| `runner-core` process spawn, `detached-runner` | Side effects |
| `store.ts` persist / locks | Wrong layer |
| `agents.ts` discovery | Build is host-agnostic |
| `cache.ts` runtime memoization | Not authoring |
| `context-store.ts` SCT runtime | Not authoring |
| `replay.ts` | Orthogonal (S3) |
| Any `taskflow-hosts/*` | Host coupling |
| Any `taskflow-mcp-core/*` | MCP is separate delivery |
| Any `@earendil-works/*` | Core iron rule extended to DSL |

### 6.3 What `.tf.ts` author files may import

| Import | MVP |
|--------|-----|
| `taskflow-dsl` (runes/types) | **Y** |
| `taskflow-dsl/build` etc. | **N** inside a flow file (tooling only) |
| `taskflow-core` | **N** (keeps author surface small; avoids pulling runtime types into flows) |
| `node:*` / fs / child_process | **N** (`TFDSL_IMPORT_NODE`) |
| relative `./foo` | **N** MVP (`TFDSL_IMPORT_LOCAL`) |
| type-only imports of local types | **N** MVP (S4.1 candidate) |

---

## §7. Host integration — CLI-first (MVP)

### 7.1 Decision

| Channel | S4 MVP | Rationale |
|---------|--------|-----------|
| **CLI `taskflow-dsl`** | **Y — primary** | Agents/humans compile before run; matches “no unbuilt run”; easy CI |
| **Library `buildFile` / `checkFile`** | **Y** | Tests + scripted toolchains |
| **New MCP tools** (`taskflow_build` / `taskflow_check`) | **N** | Avoid bloating every host adapter + mcp-core in the same release as first compiler; agents shell out or use defineFile of emitted JSON |
| **Host auto-build of `.tf.ts` on `taskflow_run`** | **N** | Silent compile on run reintroduces “feels executable” and couples hosts to ts-morph |
| **pi `/tf` DSL commands** | **N** MVP | Optional S4.1 thin wrappers calling the same library |

### 7.2 Recommended agent workflow (0.2.0)

```text
1. taskflow-dsl new my-flow
2. edit my-flow.tf.ts
3. taskflow-dsl check my-flow.tf.ts      # fast loop
4. taskflow-dsl build my-flow.tf.ts      # → .taskflow.json + .flowir.json
5. taskflow_verify / taskflow_run with defineFile=my-flow.taskflow.json
   (existing MCP — unchanged)
```

JSON authors skip steps 1–4 and keep using define / defineFile as today.

### 7.3 S4.1 host follow-ups (explicitly deferred)

- `taskflow_build` / `taskflow_check` in `taskflow-mcp-core` (stdio tools wrapping library API).  
- pi `/tf build|check|new` and skills-src host blocks.  
- Optional: run path accepts `.tf.ts` **only** after explicit build cache hit (still no interpret).

### 7.4 Compatibility with S0–S3 / S5

| Stage | Interaction |
|-------|-------------|
| S0 FlowIR | DSL must use sole compile entry; equality gate is the S4 ship bar |
| S1–S2 events/driver | Irrelevant to DSL package; built Taskflow runs on existing runtime |
| S3 replay | Works on runs of DSL-produced Taskflow the same as JSON |
| S5 kernel flip | **No DSL changes required** if Taskflow IR parity holds |

---

## §8. MVP coverage vs public surface (pointer)

Public surface exposes runes for the **Y** rows of the S4 coverage matrix (full matrix lives in implementer notes / companion survey). Minimum vertical slice for the equality demo:

| Kind / feature | Surface |
|----------------|---------|
| `flow` + description + args + concurrency + budget | `flow`, `FlowCtx` |
| `agent`, `parallel`, `map`, `gate` (LLM), `reduce`, `approval`, `subflow(use)`, `loop` (single task body), `tournament`, `script` | runes above |
| `json<T>()` basic object/array | `json` |
| template → `{steps.*}` / `{item.*}` | erase in `build` |
| `when` string + TS subset | options + check rules |
| gate.automated / scored, top-level strict/share/incremental/scope | **not exported** |

FULL RFC coverage remains a post-MVP completion track; missing FULL features must not appear as stub exports that silently no-op.

---

## §9. Acceptance checklist (public surface)

- [ ] Package name `taskflow-dsl` publishable with exports/bin as §1  
- [ ] `taskflow-dsl build|check|decompile|new` flags/IO as §2  
- [ ] Author import `from "taskflow-dsl"` typechecks a hello + audit-style demo  
- [ ] `build` on demo `.tf.ts` and hand JSON → **identical** `hashFlowIR`  
- [ ] Diagnostics stable codes + positions on deliberate erase errors  
- [ ] Import-lint: no denylist modules from core/hosts  
- [ ] No MCP/schema changes required to pass S4 gate  
- [ ] README/skills teach CLI-first workflow; JSON escape documented as first-class  

---

## §10. Open implementer choices

### 10.1 Needs human lock before coding (max 3)

| # | Question | Council recommendation (default if human silent) |
|---|----------|--------------------------------------------------|
| **H1** | Commit a canonical **coverage matrix** (Y/N per field) next to this RFC? | **Yes** — add `docs/rfc-0.2.0-s4-coverage-matrix.md` from council `coverage-map` output; §8 must link a real table, not “implementer notes”. |
| **H2** | Decompile input: Taskflow-only vs FlowIR too? | **Taskflow-only in MVP**; reject FlowIR with “pass Taskflow JSON”. |
| **H3** | Rune stub at Node runtime: phantom vs throw? | **Throw `TFDSL_ERASE_ONLY`** on any runtime call (types-only for tsc). |

### 10.2 Non-blocking polish (implementer discretion)

1. Sync vs async `buildFile` (sync-friendly with ts-morph).  
2. Exact synthetic phase id algorithm for anonymous runes (must be deterministic for hash equality fixtures).  
3. Default `--emit both` vs `taskflow` only (recommend **taskflow-only** default; FlowIR via `--emit flowir|both` / CI).  
4. Optional thin facade over ts-morph `Node` so engine can be swapped later without rewriting erase.

### 10.3 Recommended PR stack (after human lock)

1. **Scaffold** `packages/taskflow-dsl` + workspace/filter + import-lint denylist test.  
2. **Author stubs + types** (closed MVP option types; throw-on-call).  
3. **`check` + `new`** (tsc/Program + rune rules + hello skeleton).  
4. **`build` erase vertical slice** — agent → map/templates → parallel → reduce → gate LLM → script; emit Taskflow; call core FlowIR.  
5. **Golden parity** — hand JSON twin fixtures; `hashFlowIR` equality (include map + `json<T>`).  
6. **`decompile` Taskflow→`.tf.ts`** on Y-slice + fail-closed unsupported.  
7. **Docs/skills** — CLI-first workflow; JSON first-class; import string `taskflow-dsl`; amend DSL v2 FULL vs MVP note.

---

## §11. Doc map

| Doc | Role after this RFC |
|-----|---------------------|
| `rfc-0.2.0-architecture.md` | System topology; S4 row points here for surface |
| `rfc-0.2.0-dsl-syntax.md` | Language semantics (full); MVP subset bound by §8 |
| `rfc-0.2.0-three-compile-routes.md` | Historical routes; **superseded for product** by §0 lock (Svelte + JSON escape) |
| **`rfc-0.2.0-s4-mvp.md` (this)** | Ship surface freeze for `packages/taskflow-dsl` |
| [`rfc-0.2.0-dsl-phases-horizon.md`](./rfc-0.2.0-dsl-phases-horizon.md) | Brainstorm phases → DSL shapes (expand/race/saga/route/watch/…); A/B/C tracks |
| [`internal/brainstorm-2026-07-08-0.2.0-phases.md`](./internal/brainstorm-2026-07-08-0.2.0-phases.md) | Original phase brainstorm (event-sourced unlocks) |

---

*One-line summary: S4 MVP publishes `taskflow-dsl` as a CLI-first, ts-morph erase frontend — `*.tf.ts` in, Taskflow (+ FlowIR via core) out — with whole-file JSON as the only escape, stable diagnostics, a hard core import allowlist, and no MCP or runtime interpret path. Extended brainstorm phases are designed in `rfc-0.2.0-dsl-phases-horizon.md` without expanding the S4 ship bar.*
