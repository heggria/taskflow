# RFC — optional local daemon (`taskflowd`) for multi-host sharing

> Status: **IDEA / backlog** · 2026-07-10  
> **Not in 0.2.0.** 0.2.0 stays library + stdio MCP + on-disk store.  
> Parent positioning: [`0.2.0-north-star.md`](../0.2.0-north-star.md)  
> Related: [`rfc-background-run.md`](./rfc-background-run.md), claim ledger (shared runs/cache already multi-host)

---

## One-liner

**Default remains process-less.** An optional local daemon is a *future* way for multiple agent hosts to share one long-lived engine process — never required for correctness.

---

## Motivation (when pain appears)

Today, multi-host sharing is **already real at the data layer**:

| Shared today | How |
|--------------|-----|
| Runs / resume | `runs/` under project flows dir |
| Cross-run cache | sibling `cache/` |
| Library flows | saved JSON + sidecars |
| Detached jobs | one-shot child, state on disk |

What is **not** shared: a single long-lived process, global in-memory queue, or live fan-out of events to every host.

Daemon becomes worth it only if users repeatedly hit:

1. **MCP cold start** (npx / process churn) across many sessions  
2. **Cross-host resource fights** (no global concurrency / budget)  
3. **Need for a live status surface** (UI / CLI subscribe) without polling files  

Until those are measured, disk + stdio is the right default (zero install surface, host-owned lifecycle).

---

## Non-goals

- Not a cloud orchestrator or multi-machine cluster  
- Not required for Pi / Codex / Claude / OpenCode / Grok to work  
- Not replacing `detach: true` (one-shot background stays)  
- Not putting authoritative run state **only** in daemon memory  
- Not opening a public network listener without explicit opt-in + auth  

---

## Design sketch (if built in 0.2.x+)

```
  Pi / Codex / Claude / OpenCode / Grok
           │  MCP stdio (unchanged UX)
           ▼
    thin MCP adapter  ──optional──►  taskflowd (Unix socket / 127.0.0.1 + token)
                                           │
                                           ▼
                                    taskflow-core (in-process)
                                           │
                                           ▼
                              project store (runs / cache / library)
                              = source of truth (daemon crash → resume)
```

| Rule | Why |
|------|-----|
| **Default OFF** | `stdio` path always works with zero daemon |
| **Per project root** | One daemon (or one namespace) per worktree; no global muddle |
| **Disk is authority** | Same resume / stale-PID model as today |
| **Version handshake** | Client rejects daemon major mismatch (avoid pin hell) |
| **Fail-open degrade** | Daemon down → adapter falls back to in-process engine |

### Minimal protocol (sketch)

- `status` — list running / recent runs (optional live watch)  
- `run` / `resume` / `abort` — same semantics as MCP tools  
- `health` + `version` — for handshake  

Transport: **Unix domain socket** preferred; TCP loopback only if needed for Windows later.

---

## Decision for 0.2.0

| Question | Answer |
|----------|--------|
| Ship daemon in 0.2.0? | **No** |
| Multi-agent share one service? | **Share store, not process** |
| Next trigger | Documented user pain on cold start / global budget / live UI |

When reopening: promote this RFC to draft, add threat model + upgrade story, then a thin `taskflowd` MVP behind an explicit flag — still default OFF.
