# pi-taskflow

> Lightweight workflow orchestration for the [Pi coding agent](https://pi.dev).

Describe a multi-phase workflow once; let a deterministic runtime orchestrate
isolated subagents to execute it. Intermediate results stay **out of your main
context** — only the final answer comes back. Inspired by Claude Code's Dynamic
Workflows, rebuilt as a lightweight, declarative pi extension.

```bash
pi install npm:pi-taskflow
```

## Why

`subagent` is great for a single delegated task. But when a job needs **many
coordinated steps**, **fan-out over dozens of items**, **cross-checked review**,
or a **repeatable** pipeline, you want orchestration — without bloating your
conversation with every step's transcript.

`pi-taskflow` moves the plan into a small declarative definition. The runtime
holds the DAG, the loops, and the intermediate results; your context receives
only the final phase's output.

| | `subagent` | `pi-taskflow` |
|---|---|---|
| Who drives | the model, turn by turn | the runtime, from a definition |
| Intermediate results | in your context window | in the runtime (not your context) |
| Reusable | re-described each time | saved as `/tf:<name>` |
| Scale | a few tasks | dynamic `map` fan-out |
| Resumable | no | yes (cross-session) |

## Concepts

A **taskflow** is a set of **phases** forming a DAG via `dependsOn`. Each phase
delegates to a subagent (an isolated `pi` process). Phases in the same DAG layer
run concurrently (bounded by `concurrency`).

### Phase types

| type | meaning |
|------|---------|
| `agent` | one subagent runs `task` |
| `parallel` | run `branches[]` concurrently |
| `map` | fan out over an array — one subagent per item, `{item}` bound |
| `gate` | quality/adversarial-review step |
| `reduce` | aggregate several phases' outputs into one |

### Interpolation

- `{args.X}` — invocation argument
- `{steps.ID.output}` — a prior phase's text output
- `{steps.ID.json}` / `{steps.ID.json.field}` — prior output parsed as JSON
- `{item}` / `{item.field}` — current item inside a `map` phase
- `{previous.output}` — the immediately-upstream phase output

## Example

```jsonc
{
  "name": "summarize-files",
  "args": { "dir": { "default": "." } },
  "concurrency": 4,
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout",
      "task": "List source files under {args.dir}. Output ONLY a JSON array [{\"file\":\"\"}].",
      "output": "json" },
    { "id": "summarize", "type": "map", "over": "{steps.discover.json}", "as": "item",
      "agent": "scout", "task": "Read {item.file} and summarize it in one sentence.",
      "dependsOn": ["discover"] },
    { "id": "report", "type": "reduce", "from": ["summarize"], "agent": "writer",
      "task": "Combine into a short overview:\n{steps.summarize.output}",
      "dependsOn": ["summarize"], "final": true }
  ]
}
```

## Usage

The model calls the `taskflow` tool; you can also drive it directly:

```
/tf list                 # saved flows
/tf run <name> [args]     # run a saved flow
/tf show <name>           # print a definition
/tf runs                  # recent run history
/tf resume <runId>        # continue a paused/failed run (cached phases skipped)
/tf:<name> [args]         # shortcut per saved flow
```

Tool actions: `run` (inline `define` or saved `name`), `save`, `resume`, `list`.

## Storage

```
.pi/taskflows/<name>.json          # project-scoped definitions (commit to share)
~/.pi/agent/taskflows/<name>.json  # user-scoped definitions
.pi/taskflows/runs/<runId>.json    # run state (resume); gitignore this
```

## Agents

Taskflow reuses your existing pi agents (`~/.pi/agent/agents/*.md`,
`.pi/agents/*.md`) and honors `subagents.agentOverrides` in settings. Reference
agents by `name`.

## Development

```bash
npm install
npm run typecheck
node --experimental-strip-types --test test/interpolate.test.ts test/schema.test.ts test/runtime.test.ts

# real end-to-end (spawns live subagents; needs model access)
PI_TASKFLOW_PI_BIN=pi node --experimental-strip-types test/e2e.mts
```

## Status & limits

- **v0.1** — DSL + DAG runtime (`agent`/`parallel`/`map`/`gate`/`reduce`),
  inline + saved flows, cross-session resume, live progress, isolated context.
- A run executes as one streaming tool call (live progress while it runs). True
  detached background execution is on the roadmap.
- `map` requires the upstream phase to emit a JSON array (`output: "json"`).

## License

MIT
