---
name: taskflow
description: Orchestrate multi-phase subagent workflows with Taskflow. Use whenever a request spans a whole project or many items — deeply exploring / 探索 / auditing / 审计 / analyzing a codebase, reviewing or migrating many files or modules in parallel, cross-checked/adversarial review, codebase-wide research, or any repeatable orchestration you want to save and rerun. Prefer this over ad-hoc parallel work when the task has multiple phases (discover → work → review → report) or dynamic fan-out over a discovered list. Drives the taskflow_* MCP tools.
---

# Taskflow (OpenCode)

**Host binding (OpenCode):** everything below is driven through the `taskflow_*`
MCP tools. Where an example shows a host-neutral invocation like `verify`, use
the OpenCode form (`taskflow_verify`). Each phase's subagent runs as an isolated
`opencode run` session.

| Tool | What it does |
|------|--------------|
| `taskflow_run` | Run a saved or inline flow. Optional `args`, `incremental`; `mode: "background"` returns a durable `runId` immediately. |
| `taskflow_runs` | List background runs or `status` / `wait` / `cancel` one by `runId`. |
| `taskflow_resume` | Fork a failed/paused run into a new immutable child run, optionally overriding one phase's task/model/timeouts. |
| `taskflow_version` | Report the executing package version, build commit, schema version, build time, and host identity. |
| `taskflow_list` | List saved flows discoverable from the current working directory. |
| `taskflow_show` | Show a saved flow's full definition as JSON. |
| `taskflow_verify` | Statically verify a flow (cycles, missing deps, undefined refs, contract typos) — no execution, zero tokens. |
| `taskflow_compile` | Render a flow's DAG as an inline SVG **and** text outline + a verification report — no execution. |
| `taskflow_peek` | Inspect one phase's intermediate output from a stored run (post-hoc debugging). Omit `phaseId` to list phases; `json`/`item`/`limit` refine the slice. Hard-truncated, read-only. |
| `taskflow_trace` | Read a run's append-only event timeline. |
| `taskflow_replay` | Replay recorded decisions offline with optional overrides — zero model calls. |
| `taskflow_why_stale` | Explain why phases are stale from observed and declared dependencies — zero tokens. |
| `taskflow_recompute` | Compute the stale frontier (**dry-run only** over MCP; never executes phases). |
| `taskflow_reconcile_workspace` | After inspection/repair, accept a failed resolve-only workspace. Requires host `TASKFLOW_WORKSPACE_RECONCILE_MODE=explicit`; never restores files. |
| `taskflow_save` | Save a reusable flow and optional library metadata. |
| `taskflow_search` | Search and rank reusable flows before authoring another one. |

**Always `taskflow_verify` a non-trivial flow before `taskflow_run`** — it is
free and catches most authoring mistakes.
