# RFC: optional local daemon (`taskflowd`)

> Status: **Partially superseded for 0.3+**
> Updated: **2026-07-18** · **Supersession note: 2026-07-22**
> Related: [`rfc-background-run.md`](./rfc-background-run.md), [`rfc-0.3.0-control-plane.md`](./rfc-0.3.0-control-plane.md)
>
> ### 0.3 supersession
>
> For **0.3 ControlHost clients**, product defaults and outage behavior are defined by
> [`rfc-0.3.0-control-plane.md`](./rfc-0.3.0-control-plane.md) (**§5, §25**). In particular:
>
> - 0.3 clients default to **`controlMode: auto`** (on-demand control), not “daemon default-off”;
> - control unavailable under `auto`/`coordinated` → **fail closed** (no silent full-power in-process);
> - `standalone` is explicit; same ControlHost semantics;
> - **0.3 keeps one authoritative ControlStore per project**; the user-level **ControlRegistry** only
>   mounts and aggregates them (not a user-level journal with projects as partitions).
>
> **Still non-negotiable (retained by 0.3 RFC):** disk is authority; UDS + auth; version handshake;
> one admission authority when claimed; no default network listener; daemon memory is never the only
> copy of run state.
>
> This document remains the historical decision record for **deferring** a daemon in 0.2.3 and the
> process-less detached lifecycle. Do not treat its “Default off” bullet as binding on 0.3 clients.

## Historical 0.2.x decision

> **Label:** Historical requirements for the **0.2.3 process-less** line.
> **Not binding on 0.3 ControlHost clients** — see [`rfc-0.3.0-control-plane.md`](./rfc-0.3.0-control-plane.md) §5 and §25.

Taskflow **0.2.x** remains process-less by default. The project store is authoritative;
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

## Historical 0.2.3 boundary

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

## Historical note: when a daemon became justified (pre-0.3)

Reopen / supersede via [`rfc-0.3.0-control-plane.md`](./rfc-0.3.0-control-plane.md). Original triggers were:

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

### Historical 0.2.x requirements (if a daemon were added under 0.2 assumptions)

- **Default off (0.2.x).** The stdio/in-process path remains usable for 0.2 clients.
- **Disk is authority.** Daemon memory may cache or schedule, never become the
  only copy of run state. (**Retained in 0.3.**)
- **Per-project namespace.** Worktrees do not silently share a global queue.
  (**0.3 retains per-project ControlStore; user Registry is non-authoritative.**)
- **Version handshake.** Client and daemon reject incompatible protocol/schema
  versions before dispatch. (**Retained in 0.3.**)
- **Authenticated local transport.** Prefer a Unix-domain socket; any loopback
  TCP fallback requires an explicit token and threat model. (**Retained in 0.3.**)
- **Graceful degradation (0.2.x wording).** A daemon outage must not corrupt or
  hide persisted runs. *0.3 clarifies:* durability yes; **new work under
  `controlMode: auto|coordinated` fails closed** — no silent full-power standalone
  (see 0.3 control-plane RFC §5).
- **One admission authority.** If global concurrency or budgets are claimed,
  every participating client must use the control path; mixed hidden bypasses
  falsify the claim. (**Retained in 0.3.**)

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

**Historical closing line (0.2.3):** until daemon triggers were productized, the
process-less lifecycle was the smaller path. **0.3** productizes control via the
control-plane RFC (per-project ControlStore + Registry multi-mount), not this deferred design.
