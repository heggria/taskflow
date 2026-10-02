---
name: taskflow
description: Orchestrate multi-phase subagent workflows with pi-taskflow. Use whenever a request spans a whole project or many items — deeply exploring / 探索 / auditing / 审计 / analyzing a codebase, reviewing or migrating many files or modules in parallel, cross-checked/adversarial review, codebase-wide research, or any repeatable orchestration you want to save and rerun. Prefer this over ad-hoc parallel subagents when the work has multiple phases or dynamic fan-out over a discovered list. Also supports subagent-style shorthand (single / parallel / chain) for simple non-DAG delegations you want tracked, resumable, or saveable.
---

# Taskflow

**Host binding (pi):** everything below is driven through the `taskflow` tool
(`action: "run" | "plan" | "verify" | "analytics" | …`) and the `/tf` slash commands.
Where an example shows a host-neutral invocation like `verify`, use the pi form
(`action: "verify"` or `/tf verify`). Prefer **`action: "plan"` / `/tf plan`**
before spending tokens on a non-trivial flow.

Before the first tool call in a session, load this skill using Pi's `read` tool
at the `SKILL.md` path listed in the available skills. Read linked reference
files as needed. Pi's stock skill workflow uses `read`.

For shorthand calls (`task`, `tasks`, or `chain`), `action` may be omitted and
defaults to `"run"`. Other operations require their explicit `action`.
Approval phases use a review overlay in the TUI and a selector in RPC mode;
cancelling either the decision or edit guidance rejects the approval.
Print/JSON mode has no human approver and rejects approval phases.
