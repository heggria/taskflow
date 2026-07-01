---
name: taskflow
description: Orchestrate multi-phase subagent workflows with Taskflow. Use whenever a request spans a whole project or many items — deeply exploring / 探索 / auditing / 审计 / analyzing a codebase, reviewing or migrating many files or modules in parallel, cross-checked/adversarial review, codebase-wide research, or any repeatable orchestration you want to save and rerun. Prefer this over ad-hoc parallel work when the task has multiple phases (discover → work → review → report) or dynamic fan-out over a discovered list. Drives the taskflow_* MCP tools.
---

# Taskflow (Codex)

Build and run **declarative, multi-phase workflows** of subagents. The runtime
holds intermediate results and the phase DAG, so your main context only receives
the **final answer** — not every step's transcript.

In Codex you drive Taskflow through its **MCP tools**:

| Tool | What it does |
|------|--------------|
| `taskflow_run` | Run a saved flow (`name`) or an inline `define` (full DAG, or shorthand `{task}` / `{tasks}` / `{chain}`). Returns only the final phase output. |
| `taskflow_list` | List saved flows discoverable from the current working directory. |
| `taskflow_show` | Show a saved flow's full definition as JSON. |
| `taskflow_verify` | Statically verify a flow (cycles, missing deps, undefined refs) — no execution. |
| `taskflow_compile` | Render a flow's DAG as a diagram (an inline SVG image) + a verification report — no execution. |

## When to use

- A task needs **several coordinated steps** (discover → work → review → report).
- You need to **fan out over many items** (audit every endpoint, summarize every file).
- You want **cross-checked / adversarial review** before reporting.
- You want a **repeatable** orchestration you can save and rerun by name.

For a single quick delegation, use the **shorthand** `taskflow_run` forms below —
you still get progress, persistence, resume, and save.

## Shorthand (non-DAG)

Pass one of these as the `define` argument to `taskflow_run` — the runtime
desugars them into a proper flow:

```jsonc
// single  — one agent, one task
{ "task": "Summarize the architecture of src/", "agent": "explorer" }

// parallel — run tasks concurrently, merge results
{ "tasks": [ { "task": "Audit auth" }, { "task": "Audit billing" } ] }

// chain   — sequential; reference the prior step with {previous.output}
{ "chain": [ { "task": "Draft release notes" },
             { "task": "Tighten this copy: {previous.output}" } ] }
```

## Full DAG

When you outgrow the shorthand, define a DAG of phases. Phase types:
`agent`, `parallel`, `map` (dynamic fan-out over an array), `gate`
(VERDICT: PASS/BLOCK), `reduce`, `approval` (human-in-the-loop), `flow`
(run a saved sub-flow), `loop` (iterate until a condition/convergence/cap),
`tournament` (N variants, a judge picks best / aggregates).

```jsonc
{
  "name": "audit-endpoints",
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout",
      "task": "List every HTTP endpoint in src/. Return a JSON array of paths." },
    { "id": "audit", "type": "map", "over": "{steps.discover.json}",
      "agent": "security-reviewer",
      "task": "Audit endpoint {item} for authz/injection issues." },
    { "id": "gate", "type": "gate", "agent": "critic", "dependsOn": ["audit"],
      "task": "If any HIGH severity finding exists, VERDICT: BLOCK, else PASS." },
    { "id": "report", "type": "reduce", "agent": "doc-writer", "dependsOn": ["gate"],
      "task": "Write a prioritized remediation report from {steps.audit.output}." }
  ]
}
```

**Always `taskflow_verify` (or `taskflow_compile`) a non-trivial flow before
`taskflow_run`** — it catches cycles, missing deps, and undefined refs for zero
tokens.

## Interpolation

`{args.X}`, `{steps.ID.output}`, `{steps.ID.json}`, `{item}` (in `map`),
`{previous.output}` (in shorthand `chain`).

## Agents

Taskflow ships built-in agents (executor, scout, planner, analyst, critic,
reviewer, risk-reviewer, security-reviewer, test-engineer, doc-writer,
verifier, and more). Do not invent agent names — omit `agent` to use the
default executor, or use one of the built-ins.
