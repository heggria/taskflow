<!-- GENERATED FILE — do not edit. Source: skills-src/taskflow/configuration.md (npm run build:skills) -->

# Taskflow Configuration Reference

Every knob you can set on a taskflow, where it lives, and how the values are
resolved. Read this when you need fine control over models, concurrency, agent
discovery, working directories, tool restrictions, or storage.

> Companion files: `SKILL.md` (core DSL + actions), `patterns.md` (flow
> archetypes + production checklist), `advanced.md` (context sharing, dynamic
> sub-flows, workspace isolation, incremental recompute).

Configuration lives in **five layers**, from most local to most global:

| Layer | Where | Sets |
|-------|-------|------|
| Phase | a phase object in the DSL | per-step model/thinking/tools/cwd/output/concurrency |
| Flow | the top-level DSL object | name, args, default concurrency, agent scope |
| Agent | `~/.pi/agent/agents/*.md`, `.pi/agents/*.md` frontmatter | per-agent default model/thinking/tools + system prompt |
| Settings | `~/.pi/agent/settings.json` | `modelRoles`, global thinking |
| Environment | shell env | `PI_TASKFLOW_PI_BIN` |

---

## 1. Flow-level options

Top-level keys of the taskflow definition object.

```jsonc
{
  "name": "audit-endpoints",        // required — also becomes /tf:<name> when saved
  "description": "Audit API auth",  // shown in /tf list and the command palette
  "concurrency": 8,                 // default max concurrent subagents (default: 8)
  "agentScope": "user",             // user | project | both (default: user)
  "args": { /* see §3 */ },
  "phases": [ /* see §2 */ ]        // required, at least one phase
}
```

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `name` | string | — | **Required.** Saved as `/tf:<name>`. |
| `description` | string | — | Surfaced in `/tf list` and the slash-command. |
| `concurrency` | number | `8` | Default fan-out / same-layer parallelism cap. See §4. |
| `agentScope` | `user`\|`project`\|`both` | `user` | Which agent dirs to load. See §6. |
| `args` | record | `{}` | Declared invocation arguments. See §3. |
| `phases` | array | — | **Required.** The phase DAG. See §2. |
| `version` | number | `1` | Informational metadata in 0.2.0; it does not select runtime semantics or migrate a flow. |

---

## 2. Phase-level options

Keys of each object in `phases[]`. Some only apply to specific `type`s.

```jsonc
{
  "id": "audit",            // required, unique — referenced via {steps.audit.output}
  "type": "map",            // agent | parallel | map | gate | reduce | approval | flow | loop | tournament | script | race | expand (default: agent)
  "agent": "analyst",       // agent name to run this phase
  "task": "Audit {item.route}…",
  "dependsOn": ["discover"],// DAG edges
  "over": "{steps.discover.json}",  // [map] array to fan out over
  "as": "item",             // [map] loop var name (default: item)
  "branches": [ /* … */ ],  // [parallel|race] static task list
  "from": ["audit"],        // [reduce] phase ids to aggregate
  "def": "{steps.plan.json}", // [expand|flow] inline fragment / dynamic sub-flow
  "expandMode": "nested",   // [expand] nested | graft
  "output": "json",         // text | json (default: text)
  "model": "claude-sonnet-4-5",   // per-phase model override
  "thinking": "high",       // per-phase thinking override
  "tools": ["read","bash"], // restrict tools for this phase's subagent
  "cwd": "packages/api",    // working directory for this phase's subagent
  "concurrency": 4,         // [map/parallel] fan-out cap for THIS phase
  "final": true             // mark this phase's output as the workflow result
}
```

| Key | Applies to | Default | Notes |
|-----|-----------|---------|-------|
| `id` | all | — | **Required, unique.** Used in `{steps.<id>…}`. |
| `type` | all | `agent` | One of the **12** phase types (agent, parallel, map, gate, reduce, approval, flow, loop, tournament, script, **race**, **expand**). |
| `agent` | all | first available | Agent name; resolved from the scoped pool. |
| `task` | agent, gate, map, reduce | — | Prompt; supports interpolation. Required for these types. |
| `over` | map | — | **Required for map.** Must resolve to an array. |
| `as` | map | `item` | Loop variable bound per item. |
| `branches` | parallel, race | — | **Required** (≥1 for parallel; ≥2 for race). `[{task, agent?}]`. |
| `cancelLosers` | race | `true` | Abort in-flight losers after first **success** (best-effort AbortSignal). |
| `from` | reduce | — | **Required for reduce.** Phase ids whose outputs are aggregated. |
| `def` | expand, flow | — | **Required for expand.** Fragment Taskflow / phases array / `{steps.X.json}`. |
| `expandMode` | expand | `nested` | `nested` = isolated sub-flow; `graft` = promote children as `<expandId>-<childId>`. |
| `maxNodes` | expand | `50` | Cap fragment phase count (1..100). |
| `run` | script | — | **Required for script.** Shell command: a string (runs in a shell) or an array (direct exec, no shell). A string with an interpolation placeholder is rejected (injection guard). |
| `input` | script | — | Text piped to the command's stdin; supports interpolation. |
| `timeout` | script | `60000` | Max run time in ms (1000–300000). On timeout: SIGTERM → SIGKILL, phase fails. |
| `dependsOn` | all | `[]` | DAG edges. `from` also implies a dependency. |
| `output` | all | `text` | `json` parses output so `{steps.id.json}` / map `over` work. |
| `model` | all | agent/global | Per-phase model override. See §5. |
| `thinking` | all | agent/global | Per-phase thinking level. See §5. |
| `tools` | all | agent default | Whitelist of tools for the subagent. See §5. |
| `cwd` | all | flow cwd | Run this phase's subagent in a different directory. |
| `concurrency` | map, parallel | flow concurrency | Fan-out cap for this phase only. See §4. |
| `context` | all | — | File paths / `{steps.X}` refs to **pre-read and inject** before the task. See §2.1. |
| `contextLimit` | all | `8000` | Max characters read **per file** in `context`. See §2.1. |
| `cache` | all | `run-only` | Per-phase cache policy (`scope`/`ttl`/`fingerprint`). See §11. |
| `final` | all | last phase | Exactly one phase may be `final`; its output is returned. |

> Gate-only control fields (`eval`, `onBlock`, score), the loop/tournament control
> fields (`until`/`maxIterations`/`convergence`, `variants`/`judge`/`judgeAgent`/`mode`),
> the script fields (`run`/`input`/`timeout`), race/expand fields above, and the
> cross-phase contract fields (`expect`, `timeout`, `optional`, `strictInterpolation`)
> are documented in `SKILL.md` next to their phase types. `shareContext` and the
> workspace `cwd` keywords (`temp`/`dedicated`/`worktree`) are in `advanced.md`.

---

## 2.1 Context pre-reading (`context` / `contextLimit`)

Instead of making a subagent *discover* files by exploring (an O(N²) turn-cost
spiral), you can **pre-read** known files and inject their contents ahead of the
task prompt. List file paths and/or `{steps.X}` refs in `context`; the runtime
resolves interpolated refs first, then reads each file and prepends labeled
blocks to the task.

```jsonc
{
  "id": "review",
  "type": "agent",
  "agent": "reviewer",
  "context": ["src/auth.ts", "src/middleware.ts", "{steps.spec.output}"],
  "contextLimit": 12000,
  "task": "Review the auth flow against the spec above. VERDICT: PASS or BLOCK.",
  "dependsOn": ["spec"]
}
```

**Behavior & limits (all enforced in the runtime):**

| Aspect | Rule |
|--------|------|
| Resolution order | interpolate `{steps.X}` / `{args.X}` refs **first**, then read file paths. |
| Per-file cap | `contextLimit` characters per file (default **8000**); longer files are truncated with a marker. |
| Total cap | the combined injected block is hard-capped at **200,000 chars**; overflow is truncated with a notice. |
| Unreadable file | skipped with a `console.warn` (never aborts the phase). |
| JSON-looking entry | a value that looks like a JSON blob (not a path) is diagnosed and skipped, not read as a file. |

Use `context` for **known, bounded** inputs (a handful of source files, an
upstream phase's output). For large/unknown exploration, let the agent use its
`read`/`grep` tools instead — pre-reading hundreds of files just hits the total
cap.

---

## 3. Declaring & passing arguments

Declare arguments on the flow, then reference them with `{args.X}`.

```jsonc
"args": {
  "dir":   { "default": "src", "description": "Directory to scan" },
  "depth": { "default": 2 },
  "token": { "required": true, "description": "API token" }
}
```

| Field | Notes |
|-------|-------|
| `default` | Used when the caller omits the arg. |
| `description` | Documentation only. |
| `required` | ⚠️ Declared but **not enforced** at runtime — treat as documentation for now. |

**Resolution:** for each declared arg, the provided value wins, else its
`default`. Any extra provided keys are also passed through (so undeclared args
still reach `{args.X}`).

**Passing args:**

Via the MCP tool: `taskflow_run` with `{ "name": "audit-endpoints", "args": { "dir": "packages/api" } }`.

---

## 4. Concurrency model

There are **two independent concurrency limits**:

1. **Same-layer parallelism** — phases with no dependency between them sit in the
   same topological layer and run concurrently, bounded by **`flow.concurrency`**
   (default `8`).
2. **Fan-out within a `map`/`parallel` phase** — bounded by
   **`phase.concurrency ?? flow.concurrency ?? 8`**.

```jsonc
{
  "concurrency": 6,                 // ≤6 sibling phases run at once
  "phases": [
    { "id": "scan", "type": "map", "over": "{steps.list.json}",
      "concurrency": 3,             // …but this map only fans out 3 at a time
      "task": "…", "dependsOn": ["list"] }
  ]
}
```

Set a low `phase.concurrency` to protect rate-limited models or heavy bash work;
keep `flow.concurrency` higher to let independent phases overlap.

---

## 5. Model, thinking & tools resolution

For any phase, the effective value is resolved in this **precedence order**
(first defined wins):

| Setting | Precedence (high → low) |
|---------|-------------------------|
| **model** | `phase.model` → agent frontmatter `model` (resolved via `modelRoles`) → pi default |
| **thinking** | `phase.thinking` → agent frontmatter `thinking` → `settings` global thinking → pi default |
| **tools** | `phase.tools` → agent frontmatter `tools` → host default capability policy |

Notes:
- `tools` expresses the requested capability set, but enforcement is
  host-specific. It is a literal whitelist on Pi; Codex maps it to an OS
  sandbox profile, while the other hosts use their own permission contracts.
  Omit it to request the host's default capability policy.
- Each phase runs as an isolated `claude -p --output-format stream-json`
  session (Claude Code 2.1.169 or newer is required for `--safe-mode`). A model
  id that still looks like a pi-provider path (contains `/`)
  or an unresolved `{{placeholder}}` is dropped so claude falls back to its
  configured default. Known read-only requests — including an omitted tool
  list — get matching `--tools` and `--allowedTools` lists, and an explicit
  request stays narrow. `--safe-mode` disables non-managed project/user
  customizations; disk setting sources and non-managed hooks are disabled as
  defense in depth. Administrator-managed policy hooks may still run. Known
  mutating tools are rejected by default because headless Claude has no OS
  sandbox; trusted operators must explicitly set
  `PI_TASKFLOW_CLAUDE_UNSAFE_BYPASS=1` to allow `bypassPermissions` while
  keeping the requested built-in set narrow. Unknown tools always fail closed.
  Prefer an isolated `cwd: "worktree"` even after opting
  in. The Claude child inherits only platform/runtime, proxy/CA, and supported
  Claude-provider environment variables; unrelated application secrets are
  removed from the child environment.
- The agent's markdown body becomes the subagent's appended system prompt.

---

## 6. Agent discovery & scope

`flow.agentScope` controls which agent directories are loaded:

| Scope | Loads from |
|-------|-----------|
| `user` (default) | `~/.pi/agent/agents/*.md` |
| `project` | nearest `.pi/agents/*.md` found walking up from cwd |
| `both` | user **then** project (project overrides on name collision) |

- Agents are `.md` files with frontmatter `name` + `description` (required), plus
  optional `model`, `thinking`, `tools`. The body is the system prompt.
- Reference agents in phases by their `name`. An unknown name fails that phase
  with the list of available agents.
- If a phase omits `agent`, the **first discovered agent** is used.

---

## 7. settings.json

Taskflow shares the subagent settings file at `~/.pi/agent/settings.json`:

```jsonc
{
  "modelRoles": {
    "fast": "openrouter/deepseek/deepseek-v4-flash",
    "strong": "openrouter/xiaomi/mimo-v2.5-pro"
  },
  "subagents": {
    "globalThinking": "medium"              // fallback thinking for all subagents
  },
  "defaultThinkingLevel": "low"          // used if subagents.globalThinking is absent
}
```

- `modelRoles` — maps `{{role}}` references in agent frontmatter to actual model identifiers.
- `subagents.globalThinking` (or top-level `defaultThinkingLevel`) — global
  thinking fallback.

---

## 8. Cross-run caching (`cache`)

By default every phase is **`run-only`**: completed phases are reused only when
you *resume the same run* (the historical behavior). Opt a phase into the
persistent **cross-run** memoization store to reuse an identical-input result
from *any prior run* — instant, zero tokens. See `docs/rfc-cross-run-memoization.md`
for the design.

```jsonc
{
  "id": "summarize-deps",
  "type": "agent",
  "agent": "writer",
  "task": "Summarize the dependency tree of this repo.",
  "cache": {
    "scope": "cross-run",
    "ttl": "6h",
    "fingerprint": ["git:HEAD", "file:package-lock.json"]
  }
}
```

### `scope`

| Value | Meaning |
|-------|---------|
| `run-only` (default) | Reuse only within a resumed run — exactly the historical behavior. |
| `cross-run` | Reuse an identical-input result from **any** prior run (the persistent store). |
| `off` | Never reuse, even within a run (force re-execution every time). |

### Flow-wide opt-in: `incremental`

Rather than annotating every phase with `cache: { "scope": "cross-run" }`, set
`incremental: true` at the **flow** level (or pass `incremental: true` as the
`run` tool argument) to default *every* phase to cross-run reuse:

```jsonc
{
  "name": "audit",
  "incremental": true,          // ← every phase defaults to scope:"cross-run"
  "phases": [ /* ... */ ]
}
```

Precedence: the invocation `incremental` argument wins over the flow's
`incremental` field, which is in turn overridden by any **per-phase** `cache`
setting. The cross-run-blocked phase types (`gate`/`approval`/`loop`/
`tournament`/`script`/`race`/`expand`) and all per-phase soundness fallbacks still apply. The default
remains `run-only` (each run starts fresh unless something opts in), because
cross-run reuse silently persists outputs and can serve stale results for phases
whose agents read files at runtime.

### `ttl` (cross-run only)

Max age before a cross-run hit is treated as a miss: e.g. `"30m"`, `"6h"`, `"7d"`.
Omit for no time bound. A hit older than the TTL re-executes the phase. Cross-run cache entries are hard-evicted after 90 days regardless of per-entry TTL. This ceiling is not configurable.

### `fingerprint` (cross-run only)

The cache key is normally `phaseId + agent + model + interpolated-task`. A
fingerprint folds **“did the world change?”** signals into that key, so an
external change becomes a cache **miss** even when the task text is identical.
Each entry is one of:

| Entry | Becomes a miss when… | Resolves to |
|-------|----------------------|-------------|
| `git:HEAD` / `git:<ref>` | the commit moves | the resolved SHA (30s timeout → `<timeout>`; no git → `<no-git>`) |
| `glob:<pattern>` | the **set of matching paths** or their metadata changes | sorted path list with size + mtime (content-hashed globs use `glob!:` instead, which is mtime-independent) |
| `glob!:<pattern>` | the **contents** of matching files change | content hashes (capped at 5000 matches) |
| `file:<path>` | that file's content changes | sha256 of the file (>10 MB or missing → `<skip>`/`<missing>`) |
| `env:<NAME>` | the env var changes | the env value |

### What is cached, and when

- Only phases whose **`status` is `done`** and that **were not themselves a cache
  hit** are written to the store (no re-storing a value just read).
- The store is keyed by the full input hash + fingerprint, tagged with
  `flowName`/`phaseId`/`runId`/`model` for inspection and LRU eviction.
- Cross-run reuse is **safe by construction**: a different agent, model, task, or
  fingerprint produces a different key, so stale results are never served.

> **When to use it:** expensive, deterministic phases whose inputs rarely change
> (dependency summaries, doc generation, repeated audits of the same tree). For
> phases that *should* re-run every time (anything reading live external state
> without a fingerprint), leave the default `run-only` or set `off`.

---

## 9. Environment variables

| Variable | Effect |
|----------|--------|
| `PI_TASKFLOW_PI_BIN` | Override the `pi` binary used to spawn subagents. Used by tests and unusual launch setups (e.g. `PI_TASKFLOW_PI_BIN=pi`). Normally auto-detected. |
| `PI_TASKFLOW_CODEX_BIN` | Override the `codex` binary used to spawn Codex subagents. |
| `PI_TASKFLOW_CLAUDE_BIN` | Override the `claude` binary used to spawn Claude Code subagents. |
| `PI_TASKFLOW_CLAUDE_UNSAFE_BYPASS=1` | Explicitly allow trusted Claude phases requesting known mutating tools to use narrow `--tools` + `bypassPermissions`; unknown names always fail closed. |
| `PI_TASKFLOW_OPENCODE_BIN` | Override the `opencode` binary used to spawn OpenCode subagents. |
| `PI_TASKFLOW_OPENCODE_MODEL` | Override the default OpenCode model for OpenCode executor e2e tests (e.g. `opencode/deepseek-v4-flash-free`). |
| `PI_TASKFLOW_OPENCODE_UNSAFE_AUTO=1` | Explicitly permit trusted OpenCode mutating/default phases to use unsandboxed `--auto`; otherwise they fail before spawn. All OpenCode children still use `--pure`. |
| `PI_TASKFLOW_GROK_BIN` | Override the `grok` binary used to spawn Grok Build subagents. |
| `PI_TASKFLOW_GROK_MUTATING_SANDBOX_PROFILE` | Required for Grok mutating/no-whitelist phases. Must name a custom profile from `~/.grok/sandbox.toml`; built-in profiles are rejected because they may fail open on unsupported hosts. |
| `PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE` | Required for Grok read-only phases. Must name a custom profile extending `read-only`; built-in names are rejected so hooks/plugins remain kernel-contained if the host cannot enforce a built-in profile. |

---

## 10. Storage & file locations

| What | Path | Commit? |
|------|------|---------|
| User-scoped flow | `~/.pi/agent/taskflows/<name>.json` | personal |
| Project-scoped flow | `<nearest .pi>/taskflows/<name>.json` | ✅ commit to share |
| Run state (resume) | `<project .pi>/taskflows/runs/<flowName>/<runId>.json` | ❌ gitignore |

- `action: "save"` takes `scope: "project"` (default) or `"user"`.
- Project flows override user flows on a name collision.
- Add `.pi/taskflows/runs/` to `.gitignore`.

---

## 11. Quick recipes

**Pin a strong model only for the review gate:**
```jsonc
{ "id": "review", "type": "gate", "agent": "reviewer",
  "model": "claude-opus-4", "thinking": "high",
  "task": "…\nVERDICT:", "dependsOn": ["audit"] }
```

**Sandbox a phase to read-only in a subdirectory:**
```jsonc
{ "id": "scan", "type": "agent", "agent": "scout",
  "cwd": "packages/api", "tools": ["read", "grep", "ls"],
  "task": "List route files. Output ONLY a JSON array.", "output": "json" }
```

**Throttle a rate-limited fan-out:**
```jsonc
{ "id": "summarize", "type": "map", "over": "{steps.scan.json}",
  "concurrency": 2, "agent": "writer",
  "task": "Summarize {item.file}.", "dependsOn": ["scan"] }
```

**Project-only agents:**
```jsonc
{ "name": "ci-audit", "agentScope": "project", "phases": [ /* … */ ] }
```

---

## 9. TypeScript DSL CLI (`taskflow-dsl` / S4)

Author flows as **`.tf.ts`** (compile-time runes), then run the emitted JSON
through existing `taskflow_*` tools. JSON remains first-class (escape hatch).

```bash
# From a monorepo checkout (dev):
node --conditions=development --experimental-strip-types \
  packages/taskflow-dsl/src/cli.ts new audit
# edit audit.tf.ts
node --conditions=development --experimental-strip-types \
  packages/taskflow-dsl/src/cli.ts check audit.tf.ts
# Fast rune/static-only pass (skip the default full tsc Program check):
node --conditions=development --experimental-strip-types \
  packages/taskflow-dsl/src/cli.ts check audit.tf.ts --no-typecheck
node --conditions=development --experimental-strip-types \
  packages/taskflow-dsl/src/cli.ts build audit.tf.ts --emit both
# → audit.taskflow.json (+ audit.flowir.json)
# Then: taskflow_verify / taskflow_run with defineFile=audit.taskflow.json
```

| Command | Purpose |
|---------|---------|
| `new [name]` | ≤5-line hello skeleton (`.tf.ts` or `--json-escape` JSON) |
| `check <file>` | Erase + `validateTaskflow` + tsc (use `--no-typecheck` for a faster static-only pass) |
| `build <file>` | Erase → Taskflow JSON; optional FlowIR hash (`--emit taskflow\|flowir\|both`) |
| `decompile <file>` | Taskflow JSON → readable `.tf.ts` (semantic, not literal) |

Output commands are create-only by default: pass `--force` to replace an
existing regular file. Outputs are `--cwd`-contained, reject destination
symlinks, and commit atomically; `--emit both` preflights both destinations.

**Authoring notes (kinds ↔ runes)**

Import: `import { flow, agent, map, … } from "taskflow-dsl"`. Runes erase to Taskflow
JSON kinds (single source: `PHASE_TYPES` in core + `erase/kinds/*` registry).

| JSON `type` | DSL rune(s) | Notes |
|-------------|-------------|--------|
| `agent` | `agent(task, opts?)` | templates → `{steps.*}` / `{item.*}` |
| `parallel` | `parallel([agent…])` | waits for all branches |
| `map` | `map(source, item => agent…)` | `over` + `as` |
| `gate` | `gate(up, opts?, task?)` · `gate.automated` · `gate.scored` | sugar → `eval` / `score` |
| `reduce` | `reduce([…], () => agent…)` | `from` |
| `approval` | `approval({ request })` | |
| `flow` | `subflow("name")` · `subflow.def(plan)` | use vs def |
| `loop` | `loop({ task, until?, … })` | |
| `tournament` | `tournament({ branches/variants, judge, … })` | |
| `script` | `script(run, opts?)` | string or argv array |
| `race` | `race([agent…], { cancelLosers? })` | first **success** wins; cooperative loser usage is counted |
| `expand` | `expand` / `expand.nested` / `expand.graft` | `def` + `expandMode` |

- `const [a,b] = parallel([agent(...), agent(...)])` desugars to **two real agent phases** (`a`, `b`) that run concurrently (no `dependsOn` between them). Prefer this when you need `{steps.a.output}`.
- `race([...])` does **not** support array destructure — bind as one phase: `const winner = race([...])`.
- Unbuilt `.tf.ts` must **not** be executed as a Node program (runes throw `TFDSL_ERASE_ONLY`).
- Modular erase: new kind → `packages/taskflow-dsl/src/build/erase/kinds/<kind>.ts` + registry entry (see `docs/internal/modularization-0.2.0.md`).

Design docs: `docs/rfc-0.2.0-s4-mvp.md`, `docs/rfc-0.2.0-dsl-phases-horizon.md`.

---

## Caveats (declared but not yet enforced / partial)

These keys validate but the runtime does **not** fully act on them yet — don't
rely on them for behavior:

- `arg.required` — documents intent for tooling, but missing required args are
  not rejected at run time in 0.2.0. Use strict interpolation and verify/run
  argument validation at your integration boundary when absence must block.
- `flow.version` — informational only; it does not select runtime semantics.
- **Event kernel** (`eventKernel` / `PI_TASKFLOW_EVENT_KERNEL=1`) — opt-in; does
  **not** run `race`/`expand`; score gates, `retry`, `expect`, reflexion,
  cross-run cache, and Shared Context Tree force the **imperative** path.
- **`taskflow-dsl decompile`** — generates safe, readable TypeScript whose
  rebuilt Taskflow/FlowIR is semantically equivalent for supported constructs;
  dependencies are emitted before consumers even when input JSON is out of
  order;
  it does **not** reproduce original variable names, formatting, comments, or
  source spelling. Unsupported/lossy constructs fail rather than silently
  promising a literal round-trip.
