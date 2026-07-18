# RFC: optional local daemon (`taskflowd`)

> Status: **Deferred after the 0.2.3 background lifecycle**
> Updated: **2026-07-18**
> Related: [`rfc-background-run.md`](./rfc-background-run.md)

## Decision

Taskflow remains process-less by default. The project store is authoritative;
hosts start ordinary stdio MCP servers and long runs execute in isolated,
one-shot detached processes.

0.2.3 closes the main usability gap that originally motivated a daemon:

- `taskflow_run` with `mode: "background"` returns a durable `runId`
  immediately;
- `taskflow_runs` lists and filters the project roster, reports active
  concurrency, waits in bounded/repeatable calls, and requests cancellation;
- final output, traces, process metadata, and cancellation intent live on disk,
  so they survive MCP request and server boundaries;
- orphaned detached processes are reconciled into a terminal run state.

This gives users a controllable long-run lifecycle without introducing a
resident service, socket, installer, upgrade protocol, or second source of
truth.

## Current boundary

| Capability | 0.2.3 mechanism |
|---|---|
| Long DAG outlives one tool call | Detached runner process |
| Cross-session status | Project-backed run store |
| Wait without losing the run | Bounded `taskflow_runs wait` |
| Cross-request cancellation | Durable control marker |
| Multi-host discovery | Shared project store |
| Resource-contention awareness | Active count plus warning above five runs |
| Global admission/budget queue | **Not implemented** |
| Push/live event subscription | **Not implemented** |

The active-run warning is deliberately advisory. A hidden scheduler would
change execution semantics and introduce policy questions that cannot be
answered safely by a patch release.

## When a daemon becomes justified

Reopen this RFC only when measured usage repeatedly shows at least one of:

1. MCP cold-start/process churn materially dominates short runs;
2. users need one cross-host concurrency or budget admission policy rather than
   per-run ceilings and explicit warnings;
3. a live UI needs event subscription instead of bounded polling;
4. multiple host sessions must atomically claim queued work.

The existence of detached runs alone is no longer sufficient justification.

## Required design if reopened

```text
Pi / Codex / Claude / OpenCode / Grok
                 │
          thin host adapter
                 │ optional local transport
                 ▼
             taskflowd
                 │
          taskflow-core + store
```

The following rules are non-negotiable:

- **Default off.** The stdio/in-process path always remains usable.
- **Disk is authority.** Daemon memory may cache or schedule, never become the
  only copy of run state.
- **Per-project namespace.** Worktrees do not silently share a global queue.
- **Version handshake.** Client and daemon reject incompatible protocol/schema
  versions before dispatch.
- **Authenticated local transport.** Prefer a Unix-domain socket; any loopback
  TCP fallback requires an explicit token and threat model.
- **Graceful degradation.** A daemon outage must not corrupt or hide persisted
  runs. Whether new work falls back or fails closed must be an explicit policy.
- **One admission authority.** If the daemon claims global concurrency or
  budgets, every participating host must dispatch through it; mixed hidden
  bypasses would make the claim false.

## Non-goals

- cloud or multi-machine orchestration;
- making a daemon mandatory for any supported host;
- replacing detached one-shot execution;
- storing authoritative state only in memory;
- opening a network listener by default.

## Minimal future protocol

- `health` / `version` — compatibility and schema handshake;
- `run` / `resume` / `cancel` — durable lifecycle commands;
- `list` / `status` / `wait` / `subscribe` — observation surfaces;
- `admission` — explicit concurrency/budget policy and queue position.

Until the trigger evidence exists, the 0.2.3 process-less lifecycle is the
smaller and more reliable product.
