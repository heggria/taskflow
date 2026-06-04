---
name: taskflow
description: Orchestrate multi-phase subagent workflows with pi-taskflow. Use when a task needs several coordinated subagent steps, fan-out over many items (files, endpoints, modules), cross-checked/adversarial review, or a repeatable orchestration you want to save and rerun. Not for a single delegated task — use the subagent tool for that.
---

# Taskflow

Build and run **declarative, multi-phase workflows** of subagents. The runtime
holds intermediate results and the phase DAG, so your main context only receives
the final answer — not every step's transcript.

## When to use

- A task needs **several coordinated steps** (discover → work → review → report).
- You need to **fan out over many items** (audit every endpoint, summarize every file).
- You want **cross-checked / adversarial review** before reporting.
- You want a **repeatable** orchestration saved as a `/tf:<name>` command.

For a single delegated task, use the `subagent` tool instead.

## How to author a taskflow

Call the `taskflow` tool. To run a brand-new flow you write inline, pass
`action: "run"` with a `define` object. To run a saved flow, pass `name`.

### DSL shape

```jsonc
{
  "name": "audit-endpoints",
  "description": "Audit API endpoints for missing auth",
  "args": { "dir": { "default": "src/routes" } },
  "concurrency": 8,
  "agentScope": "user",            // user | project | both
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout",
      "task": "List endpoints under {args.dir}. Output ONLY a JSON array [{\"route\":\"\",\"file\":\"\"}].",
      "output": "json" },
    { "id": "audit", "type": "map", "over": "{steps.discover.json}", "as": "item",
      "agent": "analyst", "task": "Audit {item.route} ({item.file}) for missing auth.",
      "dependsOn": ["discover"] },
    { "id": "review", "type": "gate", "agent": "reviewer",
      "task": "Remove false positives from:\n{steps.audit.output}", "dependsOn": ["audit"] },
    { "id": "report", "type": "reduce", "from": ["review"], "agent": "writer",
      "task": "Write a final report:\n{steps.review.output}", "dependsOn": ["review"],
      "final": true }
  ]
}
```

### Phase types

| type | meaning |
|------|---------|
| `agent` | one subagent runs `task` |
| `parallel` | run `branches[]` concurrently |
| `map` | fan out over `over` (an array) — one subagent per item, `{item}` bound |
| `gate` | quality/review step (a focused agent pass) |
| `reduce` | aggregate `from[]` phases into one output |

### Interpolation

- `{args.X}` — invocation argument
- `{steps.ID.output}` — a prior phase's text output
- `{steps.ID.json}` / `{steps.ID.json.field}` — prior output parsed as JSON
- `{item}` / `{item.field}` — current item inside a `map` phase
- `{previous.output}` — the immediately-upstream phase output

## Rules that make flows work

1. For a `map` phase, make the upstream phase **emit a JSON array** and set
   `output: "json"` on it. Tell that agent to output **only** JSON.
2. Give each phase a clear, single responsibility.
3. Reference upstream results explicitly with `{steps.ID...}` and set `dependsOn`.
4. Mark the result-bearing phase with `"final": true` (else the last phase wins).

## Actions

- `action: "run"` — run inline `define` or a saved `name` (with optional `args`).
- `action: "save"` — persist `define` (scope `project` or `user`); becomes `/tf:<name>`.
- `action: "resume"` — continue a paused/failed run by `runId` (completed phases are cached).
- `action: "list"` — list saved flows.

## User commands

- `/tf list` · `/tf run <name> [args]` · `/tf show <name>` · `/tf runs` · `/tf resume <runId>`
- `/tf:<name> [args]` — shortcut for each saved flow
