---
name: taskflow
description: Orchestrate multi-phase subagent workflows with pi-taskflow. Use whenever a request spans a whole project or many items — deeply exploring / 探索 / auditing / 审计 / analyzing a codebase, reviewing or migrating many files or modules in parallel, cross-checked/adversarial review, codebase-wide research, or any repeatable orchestration you want to save and rerun. Prefer this over ad-hoc parallel subagents when the work has multiple phases or dynamic fan-out over a discovered list. Also supports subagent-style shorthand (single / parallel / chain) for simple non-DAG delegations you want tracked, resumable, or saveable.
---

# Taskflow

**Host binding (pi):** everything below is driven through the `taskflow` tool
(`action: "run" | "verify" | …`) and the `/tf` slash commands. Where an example
shows a host-neutral invocation like `verify`, use the pi form
(`action: "verify"` or `/tf verify`).
