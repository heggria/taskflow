# Taskflow commands

This sidecar covers human/operator use of Taskflow in Pi. Load it when you need to inspect saved flows or runs, continue a run, or use the `/tf` control surface.

## Saved flows

- `/tf list` — list saved flows.
- `/tf show <name>` — show a saved flow definition.
- `/tf run <name> [args]` — run a saved flow with optional arguments.
- `/tf:<name> [args]` — run a saved flow through its shortcut.

The equivalent tool operation uses `action: "run"` with `name` and optional `args`. A saved flow's shortcut is available after the flow is registered.

## Check and inspect a flow

- `/tf verify <name>` — run zero-token structural checks.
- `/tf plan <name> [args]` — bind arguments, inspect projected phase order and dynamic bindings, and estimate the static agent-call bound without executing subagents.
- `/tf compile <name> [lr|td]` — render the flow and its verification report.
- `/tf ir <name>` — inspect the content-addressed FlowIR representation.

Use these controls before a consequential run; they do not execute provider-backed phases.

## Inspect runs

- `/tf runs` — list recent runs.
- `/tf peek <runId>` — list stored phase statuses and output sizes.
- `/tf peek <runId> <phaseId>` — inspect one stored phase output.
- Add `--json` for parsed JSON, `--item <n>` for one fan-out item, or `--limit <chars>` to bound displayed output.
- `/tf provenance <runId>` — inspect observed upstream reads.
- `/tf trace <runId> [--json]` — inspect the recorded event trace when one exists.
- `/tf replay <runId> [options]` — perform an offline what-if replay without model calls.

## Continue or recompute

- `/tf resume <runId>` — fork a failed or paused run and continue its unfinished work.
- `/tf why-stale <runId> [phaseId]` — inspect the stale frontier from a changed phase.
- `/tf recompute <runId> <phaseId> [--apply]` — preview the stale frontier, or apply the recompute with `--apply`.
- `/tf reconcile-workspace --ack` — acknowledge the current state of a dirty resolve-only workspace after inspection or repair.

Resume preserves the original run. Recompute is for changed inputs and is dry-run by default.

## Background and setup

- A background run returns a `runId`; use `/tf runs` to monitor it.
- `/tf version` — show package, build, schema, and host identity.
- `/tf init` — interactively configure model roles.

These commands operate on Taskflow's control surface; use the main skill for flow authoring guidance.
