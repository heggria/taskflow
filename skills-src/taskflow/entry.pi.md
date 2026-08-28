---
name: taskflow
description: Use Taskflow to delegate or orchestrate bounded work with isolated subagents: use cheaper or specialized agents, preserve your context, apply specialized skills or narrower tools, run independent work in parallel, coordinate dependent steps, review or verify results, process many discovered items, and keep long-running work tracked, resumable, or reusable. Common uses include research, engineering, software development, audits, migrations, data or document analysis, and repeatable workflows.
---

# Taskflow

**Host binding (pi):** use the `taskflow` tool for Taskflow operations such as `agents`, `verify`, `plan`, and `run`. Prefer `plan` before a non-trivial `run`.

Taskflow runs bounded subagent work as a tracked, verifiable graph.

Use it to delegate work efficiently, preserve your context, isolate capabilities, run independent work concurrently, connect real dependencies, verify results, and keep long-running or reusable execution tracked.

Taskflow scales from one delegated subagent to larger graphs with parallel work, dependencies, verification, repeated items, and runtime-discovered structure.
