<div align="center">

<img src="./assets/hero.png" alt="pi-taskflow — declarative, multi-phase subagent workflows" width="880">

<p>
  <a href="https://www.npmjs.com/package/pi-taskflow"><img src="https://img.shields.io/npm/v/pi-taskflow?style=flat-square&color=B692FF&label=npm" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-43D9AD?style=flat-square" alt="MIT license"></a>
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/for-Pi%20coding%20agent-6E8BFF?style=flat-square" alt="for the Pi coding agent"></a>
</p>

</div>

> Lightweight workflow orchestration for the [Pi coding agent](https://pi.dev).

**Orchestrate your Pi subagents. Not by prompting — by declaring.**

If you've used the built-in subagent tool's `task` / `tasks` / `chain`, you
already know the shorthand — your runs just get tracked, resumable, and
saveable as a one-word `/tf:<name>` command.

```bash
pi install npm:pi-taskflow
```

Fan out one subagent per item, gate the results with an adversarial review, and
get back only the final report — none of the intermediate transcripts ever touch
your conversation.

## Why

The built-in subagent tool is great for a single delegated task. But when a job
needs many coordinated steps, fan-out over dozens of items, cross-checked review,
or a repeatable pipeline, you want orchestration — without the intermediate
transcripts eating your context window.

`pi-taskflow` moves the plan into a small declarative definition. The runtime
holds the DAG, the loops, and the intermediate results; your context receives
only the final phase's output.

| | `subagent` tool | `pi-taskflow` |
|---|---|---|
| Who drives | the model, turn by turn | the runtime, from a definition |
| Intermediate results | in your context window | in the runtime (not your context) |
| Reusable | re-described each time | saved as `/tf:<name>` |
| Scale | a few tasks | dynamic `map` fan-out |
| Resumable | no | yes (cross-session, cached phases skip) |
| Quality gates | no | `gate` phases with `VERDICT: BLOCK / PASS` |
| Progress visibility | opaque while running | live DAG render with timing + cost |
| Ergonomics | inline JSON each time | shorthand (`task`/`tasks`/`chain`) or DSL |

## Show me

Describe a pipeline once, then run it from a pi session by name:

> `/tf:summarize-files dir=src`

The runtime fans out one subagent per file, merges the summaries in a `reduce`
phase, and returns only the final overview. Every intermediate transcript stays
in the runtime — never in your context window. (Full definition in
[Quickstart](#then-go-declarative) below.)

## Quickstart

### Shorthand: same effort as `subagent`, but tracked & resumable

**Single task** — one agent, one job:

```jsonc
{ "task": "Summarize the architecture of src/", "agent": "explorer" }
```

**Parallel tasks** — fire several at once, outputs merge:

```jsonc
{ "tasks": [
  { "task": "Audit auth in src/api",   "agent": "analyst" },
  { "task": "Audit input validation in src/api", "agent": "analyst" }
] }
```

**Chain** — sequential, each step sees the previous one's output:

```jsonc
{ "chain": [
  { "task": "List the public API of src/lib", "agent": "scout" },
  { "task": "Write docs for:\n{previous.output}", "agent": "writer" }
] }
```

`agent` is optional (defaults to the first available agent). Add `name` to label
the run and enable saving it as a reusable command.

Try it inline — tell the model something like:

> Run a chain: first explore the auth flow, then summarize findings.

The model calls the `taskflow` tool; you get live progress, per-step timing,
token cost, and a run record. Ask to `save` it and you get `/tf:<name>`.

### Then go declarative

When your pipeline outgrows the shorthand — when you need dynamic fan-out,
intermediate JSON routing, or quality gates — graduate to the full DSL:

```jsonc
{
  "name": "summarize-files",
  "description": "Discover files, summarize each, produce a report",
  "args": { "dir": { "default": "." } },
  "concurrency": 8,
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout",
      "task": "List source files under {args.dir} (non-recursive).\nOutput ONLY a JSON array [{\"file\":\"\"}]. No prose.",
      "output": "json" },
    { "id": "summarize", "type": "map",
      "over": "{steps.discover.json}", "as": "item",
      "agent": "scout",
      "task": "Read {item.file} and give a one-sentence summary.",
      "dependsOn": ["discover"] },
    { "id": "report", "type": "reduce", "from": ["summarize"],
      "agent": "writer",
      "task": "Combine into a short overview:\n{steps.summarize.output}",
      "dependsOn": ["summarize"], "final": true }
  ]
}
```

What this does:

1. **`discover`** — an agent lists every file in the directory and outputs a JSON array.
2. **`summarize`** — a `map` fans out, spawning one subagent per file in parallel
   (throttled to 8 concurrent). Each gets `{item.file}` bound to its file path.
3. **`report`** — a `reduce` merges all summaries into one clean overview.

Intermediate outputs never enter your context. The runtime owns them. You get
only the final report back.

Save it once → `/tf:summarize-files` forever.

## Watch it run

This is the live progress render for a real run — the `self-improve` flow that
writes and verifies its own test suites, caught here mid-block by a quality gate:

```
⊗ taskflow self-improve  6/7 · blocked · $0.095
    ✓ discover            agent   deepseek-v4-flash  10t ↑38k ↓6.7k $0.011
  ┌ ✓ write-runner-tests  agent   claude-sonnet-4-6  10t ↑13 ↓6.6k $0.020
  ├ ✓ write-store-tests   agent   claude-sonnet-4-6  10t ↑11 ↓10k $0.018
  ├ ✓ write-agents-tests  agent   claude-sonnet-4-6  10t ↑28 ↓13k $0.030
  └ ✓ fix-stability       agent   claude-sonnet-4-6  10t ↑13 ↓3.9k $0.012
    ✓ verify              gate    BLOCK 3 type errors in test files  deepseek-v4-flash
    ⊘ report              reduce  skipped · Gate blocked  ↳ fix-stability
```

**How to read it — the layout *is* the DAG:**

- **Header** — `⊗` means the flow is blocked (a gate halted it); `6/7` phases
  processed, aggregate cost `$0.095`.
- **Status icons** — `✓` done, `◐` running, `✗` failed, `⊘` skipped, `○` pending.
- **Rail `┌ ├ └`** — phases in the same DAG layer, running concurrently. The four
  `write-*`/`fix-stability` tasks all fan out from `discover`. A blank gutter is
  a single-phase layer.
- **`↳`** — a long (layer-skipping) dependency. `report` depends on `verify` (the
  adjacent layer, implied by position) *and* `fix-stability` two layers back, so
  only that skip edge is annotated.
- **Gate** — `verify` emitted `VERDICT: BLOCK`, so the runtime skipped `report`
  and ended the run as `blocked`, surfacing the reason.
- **Detail** — per phase: model, token counts (`↑`in `↓`out), cost, and timing.
  Fan-out phases also show sub-task progress.

## Phase types

| type | meaning | required fields |
|------|---------|-----------------|
| `agent` | one subagent runs a single task | `task` |
| `parallel` | run `branches[]` concurrently | `branches` (array of `{task, agent?}`) |
| `map` | fan out over an array — one subagent per item, `{item}` bound | `over`, `task` |
| `gate` | quality/review step that can **halt the flow** | `task` |
| `reduce` | aggregate `from[]` phase outputs into one | `from`, `task` |
| `approval` | **human-in-the-loop** pause — approve / reject / edit before continuing | — |
| `flow` | run a **saved sub-flow** as one phase (composition/reuse) | `use` |

Every phase needs `id`. Optional fields: `agent`, `dependsOn`, `output`,
`model`, `thinking`, `tools`, `cwd`, `concurrency`, `final`, `optional`,
`when` (conditional guard), `join` (`all`\|`any` dependency join), `retry`
(`{max, backoffMs, factor}`), and `with` (args for a `flow` phase).
Run-wide: `budget: {maxUSD, maxTokens}` halts the flow when exceeded.

### Control flow & reliability

- **`when`** — skip a phase unless an expression is truthy. Supports `{refs}`,
  `== != < > <= >=`, `&& || !`, parentheses, and quoted strings/numbers, e.g.
  `"when": "{steps.triage.json.route} == deep"`. Pair with `join: "any"` on the
  merge phase to build real if/else routing. Parse errors **fail open**.
- **`join: "any"`** — an OR-join: the phase runs as soon as *one* dependency
  completes (default `"all"` waits for every dep).
- **`retry`** — `{ "max": 2, "backoffMs": 500, "factor": 2 }` retries a failing
  subagent with fixed (`factor:1`) or exponential backoff; usage is summed and
  the attempt count shows as `↻N` in the TUI.
- **`approval`** — pause for a human (`select`: Approve / Reject / Edit). Reject
  halts the flow; Edit injects the typed note as the phase output for downstream
  steps. Non-interactive runs auto-approve.
- **`flow`** — `{ "type": "flow", "use": "deep-research", "with": { "topic": "{item}" } }`
  runs a saved flow as a phase (recursion is detected and rejected).
- **`budget`** — a run-wide `{maxUSD, maxTokens}` ceiling; once exceeded, pending
  phases are skipped (and in-flight fan-out stops spawning) and the run is
  `blocked`.

### `output` format

- `output: "text"` (default) — the raw subagent output.
- `output: "json"` — the subagent output is parsed as JSON and exposed via
  `{steps.ID.json}` / `{steps.ID.json.field}`. Set this on phases whose output
  a downstream `map` or `reduce` needs to consume as structured data.

There is no `output: "file"`. For file-based output, have the agent write to
disk with a `write` tool call.

### Gate phases (quality control)

A `gate` runs an agent to review upstream output and can **block the rest
of the workflow**. End the gate task's instructions by asking the agent to
emit a verdict the runtime can read:

- a final line `VERDICT: PASS` or `VERDICT: BLOCK` (also accepts `OK`, `FAIL`,
  `STOP`, `REJECT`, `HALT` — last occurrence wins), or
- JSON like `{"continue": false, "reason": "missing auth checks"}` /
  `{"verdict": "block", "reason": "..."}`.

On **BLOCK**, downstream phases are skipped and the run ends as `blocked` with
the reason surfaced. **Ambiguous output fails open** (treated as PASS) — a gate
never halts the flow by accident.

```
Review the audit results below. If any endpoint is missing auth, end with
"VERDICT: BLOCK" and a one-line reason; otherwise end with "VERDICT: PASS".

{steps.audit.output}
```

## Interpolation

| placeholder | resolves to |
|---|---|
| `{args.X}` | invocation argument |
| `{steps.ID.output}` | a prior phase's text output |
| `{steps.ID.json}` | prior output parsed as JSON (or `{steps.ID.json.field}`) |
| `{item}` / `{item.field}` | current item inside a `map` phase |
| `{previous.output}` | the immediately-upstream phase output |

## Commands

Saved flows become CLI shortcuts. All commands work in the pi session:

| Command | What it does |
|---|---|
| `/tf list` | List all saved flows |
| `/tf run <name> [args]` | Run a saved flow (e.g. `/tf run summarize-files dir=src`) |
| `/tf show <name>` | Print a flow's definition |
| `/tf runs` | Browse recent run history (interactive TUI) |
| `/tf resume <runId>` | Continue a paused/failed run — cached phases skip automatically |
| `/tf:<name> [args]` | Shortcut — runs the flow in one tap |

Tool actions (used by the model): `run` (inline `define` or saved `name`),
`save`, `resume`, `list`.

## Storage

```
.pi/taskflows/<name>.json          # project-scoped definitions (commit to share)
~/.pi/agent/taskflows/<name>.json  # user-scoped definitions
.pi/taskflows/runs/<runId>.json    # run state (resume); gitignore this
```

Agent discovery scope (set via `agentScope` in the flow definition):

| value | discovers agents from |
|---|---|
| `"user"` (default) | `~/.pi/agent/agents/*.md` |
| `"project"` | `.pi/agents/*.md` (walks up the tree) |
| `"both"` | user + project; project wins on name collision |

## Agents

Taskflow reuses your existing pi agent files (`~/.pi/agent/agents/*.md`,
`.pi/agents/*.md`). Reference agents by `name` in a phase or shorthand.

When running a phase, the runtime extracts the agent's `systemPrompt` from its
`.md` frontmatter and passes it via `--append-system-prompt` (written to a temp
file). Phase-level overrides for `model`, `thinking`, and `tools` are passed as
`--model` / `--thinking` / `--tools` flags to the subagent invocation.

Settings from `~/.pi/agent/settings.json` (the `subagents.agentOverrides` map)
are honored, letting you tweak model, thinking, or tools per agent across all flows.

## Status & limits

- **v0.0.6** — control flow & reliability: conditional `when` guards, `join: any`
  OR-joins, declarative `retry`/backoff, `approval` (human-in-the-loop) phases,
  `flow` (saved sub-flow composition), and run-wide `budget` caps — on top of the
  DSL + DAG runtime (`agent`/`parallel`/`map`/`gate`/`reduce`),
  inline + saved flows, cross-session resume, live progress, isolated context.
  Default `concurrency` is 8 (set on the flow; per-phase `concurrency` overrides
  for that phase).
- A run executes as one streaming tool call (live progress while it runs).
- `map` requires the upstream phase to emit a JSON array (`output: "json"`).
- Gate verdicts are **fail-open**: if the agent output contains no recognizable
  verdict marker (`VERDICT: BLOCK/PASS/OK/FAIL/STOP/REJECT/HALT` or
  `{continue: false}` / `{verdict: "block"}`), the gate passes. This prevents
  an accidental missing verdict from blocking your workflow.

### What it doesn't do (yet)

- **No detached background execution.** A run needs the pi session to stay open.
  True background execution (and event/cron triggers on top of it) is on the
  roadmap.
- **No `output: "file"`.** Outputs are text/JSON only. Write files via agent
  tool calls if needed.
- **`map` requires a JSON array.** The `over` field must resolve to
  `{steps.ID.json}` where the upstream phase emitted `output: "json"`. If the
  source is a plain text list, wrap it in a single-agent phase that outputs JSON.
- **Cycles are rejected at validation.** The DAG must be acyclic.

## Development

```bash
npm install
npm run typecheck
node --experimental-strip-types --test test/interpolate.test.ts \
  test/condition.test.ts test/schema.test.ts test/usage.test.ts \
  test/runtime.test.ts test/features.test.ts test/runner.test.ts \
  test/store.test.ts test/agents.test.ts test/render.test.ts test/desugar.test.ts

# real end-to-end (spawns live subagents; needs model access)
PI_TASKFLOW_PI_BIN=pi node --experimental-strip-types test/e2e.mts
```

## Contributing

Contributions welcome! This is a young project — open an issue or PR on
[GitHub](https://github.com/heggria/pi-taskflow). Tests live in `test/`, the
runtime in `extensions/`.

## License

MIT
