---
name: taskflow
description: >-
  Use Taskflow to delegate or orchestrate bounded work with isolated subagents:
  use cheaper or specialized agents, preserve your context, apply specialized
  skills or narrower tools, run independent work in parallel, coordinate dependent
  steps, review or verify results, process many discovered items, and keep long-running
  work tracked, resumable, or reusable. Common uses include research, engineering,
  software development, audits, migrations, data or document analysis, and repeatable
  workflows. Drives the taskflow_* MCP tools.
---

# Taskflow (Grok Build)

**Host binding (Grok Build):** everything below is driven through the
`taskflow_*` MCP tools. Where an example shows a host-neutral invocation like
`verify`, use the Grok form (`taskflow_verify` via `search_tool` /
`use_tool`, or the namespaced form `taskflow__taskflow_verify` depending on
how tools are announced). Each phase's subagent runs as an isolated
`grok -p --output-format streaming-json` session.

**Sandbox prerequisites:** before `taskflow_run`, require custom profiles for
both capability modes: `PI_TASKFLOW_GROK_MUTATING_SANDBOX_PROFILE` should name
a profile extending `workspace`, and `PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE`
one extending `read-only`. If either required variable is absent, explain the
setup and do not retry with a built-in profile; built-ins may fail open when
kernel enforcement is unavailable.

| Tool | What it does |
|------|--------------|
| `taskflow_run` | Run a saved or inline flow. Optional `args`, `incremental`; `mode: "background"` returns a durable `runId` immediately. |
| `taskflow_runs` | List background runs or `status` / `wait` / `cancel` one by `runId`. |
| `taskflow_resume` | Fork a failed/paused run into a new immutable child run, optionally overriding one phase's task/model/timeouts. |
| `taskflow_version` | Report the executing package version, build commit, schema version, build time, and host identity. |
| `taskflow_list` | List saved flows discoverable from the current working directory. |
| `taskflow_show` | Show a saved flow's full definition as JSON. |
| `taskflow_plan` | Preflight plan: bind args, phase order, dynamic bindings, worst-case agent-call bound — zero tokens, no execution. |
| `taskflow_analytics` | Aggregate last-N runs for a flow (status histogram, durations, per-phase fail/cache rates). Read-only. |
| `taskflow_verify` | Statically verify a flow (cycles, missing deps, undefined refs, contract typos) — no execution, zero tokens. |
| `taskflow_compile` | Render a flow's DAG as an inline SVG **and** text outline + a verification report — no execution. |
| `taskflow_peek` | Inspect one phase's intermediate output from a stored run (post-hoc debugging). Omit `phaseId` to list phases; `json`/`item`/`limit` refine the slice. Hard-truncated, read-only. |
| `taskflow_trace` | Read a run's append-only event timeline. |
| `taskflow_replay` | Replay recorded decisions offline with optional overrides — zero model calls. |
| `taskflow_why_stale` | Explain why phases are stale from observed and declared dependencies — zero tokens. |
| `taskflow_why_effect` | Explain why a declared effect is authorized, from the durable resource-intent ledger (`runId` + `effectId`, optional `phaseId`; `json: true` for the full record). Declaration alone is not authorization — zero tokens, read-only. |
| `taskflow_recompute` | Compute the stale frontier (**dry-run only** over MCP; never executes phases). |
| `taskflow_reconcile_workspace` | After inspection/repair, accept a failed resolve-only workspace. Requires host `TASKFLOW_WORKSPACE_RECONCILE_MODE=explicit`; never restores files. |
| `taskflow_save` | Save a reusable flow and optional library metadata. |
| `taskflow_search` | Search and rank reusable flows before authoring another one. |

**Always `taskflow_plan` (or at least `taskflow_verify`) a non-trivial flow before `taskflow_run`** — free, binds args, and catches most authoring mistakes.
