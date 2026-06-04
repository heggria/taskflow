---
name: taskflow
description: Orchestrate multi-phase subagent workflows with pi-taskflow. Use whenever a request spans a whole project or many items — deeply exploring / 探索 / auditing / 审计 / analyzing a codebase, reviewing or migrating many files or modules in parallel, cross-checked/adversarial review, codebase-wide research, or any repeatable orchestration you want to save and rerun. Prefer this over ad-hoc parallel subagents when the work has multiple phases or dynamic fan-out over a discovered list. Also supports subagent-style shorthand (single / parallel / chain) for simple non-DAG delegations you want tracked, resumable, or saveable.
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

For a single quick delegation you can use the **shorthand modes** below (no DSL),
or the plain `subagent` tool. Use the shorthand when you want the run tracked,
resumable, or saveable as a `/tf` command.

## Shorthand (non-DAG) — like the subagent tool

Skip the DSL entirely for simple delegations. The runtime desugars these into a
proper flow, so you still get progress, persistence, resume, and `save`.

```jsonc
// single  — one agent, one task
{ "task": "Summarize the architecture of src/", "agent": "explorer" }

// parallel — run several tasks at once, outputs merged
{ "tasks": [
  { "task": "Audit auth in src/api", "agent": "analyst" },
  { "task": "Audit input validation in src/api", "agent": "analyst" }
] }

// chain — run sequentially; reference the prior step with {previous.output}
{ "chain": [
  { "task": "List the public API of src/lib", "agent": "scout" },
  { "task": "Write docs for:\n{previous.output}", "agent": "writer" }
] }
```

- `agent` is optional (defaults to the first available agent).
- Add `name` to label the run (and to `save` it as a `/tf:<name>` command).
- Precedence if several are given: `chain` > `tasks` > `task`.
- You can pass these as top-level tool params **or** inside `define`.

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
| `gate` | quality/review step that can **halt the flow** (see below) |
| `reduce` | aggregate `from[]` phases into one output |

### Gate phases (quality control)

A `gate` phase runs an agent to review upstream output and can **block the rest
of the workflow**. End the gate task's instructions by asking the agent to emit a
verdict the runtime can read:

- a final line `VERDICT: PASS` or `VERDICT: BLOCK` (also accepts OK/FAIL/STOP/REJECT/HALT), or
- JSON like `{"continue": false, "reason": "missing auth checks"}` / `{"verdict": "block", "reason": "..."}`

On **BLOCK**, downstream phases are skipped and the run ends as `blocked` with the
reason surfaced. Ambiguous output **fails open** (treated as PASS) so a gate never
halts the flow by accident. Example gate task:

```
Review the audit results below. If any endpoint is missing auth, end with
"VERDICT: BLOCK" and a one-line reason; otherwise end with "VERDICT: PASS".

{steps.audit.output}
```

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

## Configuration

For the full set of knobs — per-phase `model`/`thinking`/`tools`/`cwd`, the
two-level concurrency model, model/thinking/tools resolution precedence,
`agentScope` & agent discovery, `settings.json` overrides, environment
variables, and storage paths — read `configuration.md` (next to this file).

Quick reference:

- **Flow:** `name`, `description`, `concurrency` (default 8), `agentScope` (user|project|both), `args`.
- **Phase:** `model`, `thinking`, `tools` (whitelist), `cwd`, `output:"json"`, `concurrency` (map/parallel fan-out), `final`.
- **Precedence (model/thinking/tools):** phase value → `settings.subagents.agentOverrides[agent]` → agent frontmatter → global/default.
- **Concurrency:** same-layer phases use `flow.concurrency`; a `map`/`parallel` phase uses `phase.concurrency ?? flow.concurrency ?? 8`.

## Actions

- `action: "run"` — run inline `define` or a saved `name` (with optional `args`).
- `action: "save"` — persist `define` (scope `project` or `user`); becomes `/tf:<name>`.
- `action: "resume"` — continue a paused/failed run by `runId` (completed phases are cached).
- `action: "list"` — list saved flows.

## User commands

- `/tf list` · `/tf run <name> [args]` · `/tf show <name>` · `/tf runs` · `/tf resume <runId>`
- `/tf:<name> [args]` — shortcut for each saved flow
