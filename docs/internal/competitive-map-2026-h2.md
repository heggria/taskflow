# Competitive map — 2026 H2 → taskflow 0.3.0

> **Status:** working map for 0.3 planning (not marketing)
> **Date:** 2026-07-22
> **Supersedes for 0.3 narrative:** partial updates to [`market-positioning-2026-07.md`](../market-positioning-2026-07.md), [`COMPETITORS.md`](./COMPETITORS.md), [`rfc-local-daemon.md`](./rfc-local-daemon.md)
> **Scope:** where taskflow competes, where it must not, and what 0.3 must ship to stay differentiated.

---

## 1. One-line position

> **taskflow is the coding-agent control plane that compiles, admits, incrementally executes, and replay-audits DAGs across real coding CLIs — not another session multiplexer, org-chart OS, or app multi-agent SDK.**

Do **not** lead with “declarative DAG” alone (Microsoft Conductor already owns that headline).
Lead with: **compiled + incremental + multi-coding-backend + single MCP + enforceable policy**.

---

## 2. Category map (do compete / do not)

| Layer | Who (2026 H2 examples) | They optimize | Taskflow stance |
|-------|------------------------|---------------|-----------------|
| **Session parallelizers** | Claude Squad, Composio AO, Emdash, Vibe Kanban, Crystal/Nimbalyst | Many CLI sessions + worktrees + TUI/Kanban | **Do not compete** on “open 5 Claudes fast”. Overlap on attention only. |
| **Org / agent workforce** | Paperclip | Org chart, budgets, heartbeats, “hire agents” | **Do not compete** on company metaphor. Policy/budget yes; org-chart no. |
| **App multi-agent SDKs** | MS Agent Framework 1.0, LangGraph, CrewAI, Mastra, OpenAI/Claude Agent SDKs | Product agents, handoffs, cloud telemetry | **Do not compete** as app framework. Different runtime object (coding CLI vs in-process LLM). |
| **Declarative agent DAG** | **Microsoft Conductor**, Bernstein, tutti… | YAML/zero-token routing, validate, dashboard | **Compete here on wedge**, not feature parity. |
| **Deterministic coding pipeline** | Bernstein | Plan→graph, zero-token schedule, janitor | **Closest OSS cousin** — differentiate on DSL+IR, cross-run cache, host MCP, replay. |
| **Host-native teams** | Claude Agent Teams/View, Codex App multi-agent, VS Code multi-agent | Zero-install inside one host | **Complement / bypass risk** — portability + policy is our answer. |
| **Cloud async coders** | Devin, Jules, Codex cloud, Copilot coding agent | Ticket→VM→PR, walk away | **Must absorb as backends**, not ignore. Local-only CP is incomplete. |
| **Spec-driven products** | Intent et al. | Living spec → implement/verify | **Aspire upward** (spec→FlowIR); don’t pretend we own living-spec UX yet. |
| **Skills / swarm packs** | Metaswarm, OMC, skill-swarms | Prefab roles + SDLC rituals | **Catalog source**, not competitors for runtime guarantees. |
| **Protocol / mesh** | MCP (tools), A2A / AG-UI (agent peer) | Interop standards | **Integrate** — MCP northbound; A2A later for peer workers. |
| **Industrial durable exec** | Temporal, Inngest | Exactly-once, multi-machine | **Do not compete**. Phase-level resume is enough. |

---

## 3. Proof points vs threats (keep honest)

| Claim we can own | Evidence today (0.2.x) | 0.3 must make *user-visible* | Who can kill it |
|------------------|------------------------|------------------------------|-----------------|
| **Compile / verify before spend** | FlowIR, `verify`, `compile` | CP surfaces capabilities + preflight deny | Conductor validate; still weak on coding hosts |
| **Cross-run incremental** | cache, why-stale, recompute | $ / token saved on every re-run UX | Nobody strong yet — **narrow moat** |
| **What-if replay (0 tokens)** | trace + `replayRun` | WebUI/CLI “change gate, re-fold” | Temporal has different replay semantics |
| **Real coding agents as workers** | pi/codex/claude/opencode/grok runners | Worker pool + optional cloud backends | Host vendors, Devin/Jules |
| **Context isolation** | finalOutput-only host contract | Unchanged invariant | Host-native subagents partial |
| **Single admission / policy** | fragmented per-host MCP | **taskflowd + policy plane** | Paperclip governance, enterprise IDEs |

**Non-claims (never market these as wins):** Temporal-class durability; fastest parallel UX; Microsoft-scale distribution; “AI company” narrative.

---

## 4. Frontier ladder (where 0.3 sits)

| Level | Idea | 0.3? |
|-------|------|------|
| **L0** | Multi-host plugins + local DAG | Shipped |
| **L1** | Resident **taskflowd** + thin MCP/CLI + events | **In scope** |
| **L2** | **Policy plane** (agents/models/tools/budget/workspace/caller) + `taskflow_capabilities` | **In scope** |
| **L3** | Spec→FlowIR, env-addressed cache, proof-carrying runs | **One spike or design only** — narrative anchor |
| **L4** | Market clearing, portfolio routing, A2A federation | Out of 0.3 |

> Daemon + “WebUI allowlist agents/models” alone is **L1–L2 engineering**, not thought leadership.
> 0.3 **shipping** is L1–L2; 0.3 **story** must still point at L3 (compiler + incremental + proof), or we sound like Squad/Paperclip.

---

## 5. 0.3 product shape (implementation target)

```text
Host agents (Claude/Codex/Pi/Grok/OpenCode/…)
        │  one Taskflow MCP (thin client)
        ▼
   taskflowd (multi-mount clerk)  ── CLI / WebUI
        │
   ControlRegistry (user, non-authoritative)
        │ mounts
   per-project ControlStore (authority journal)
        │
   orchestrator + ExecutionProviders
```

**Non-negotiables** (source of truth: [`rfc-0.3.0-control-plane.md`](./rfc-0.3.0-control-plane.md) v7+):

- Per-project ControlStore is authority; user Registry aggregates only
- Disk/journal authority; clerk process is not the sole state copy
- 0.3 clients default **`controlMode: auto`**; control unavailable → **fail closed**
- **`standalone` only when user sets it explicitly** — never silent auto fallback
- Version handshake; local auth (socket + token)
- One admission path when multi-client coordination is claimed
- **No DomainTransfer / merged user journal in 0.3**



**Policy is 3-D (not just agent/model checkboxes):**

1. **Catalog** — what agents/models/backends exist
2. **Exposure** — what a *caller* may use
3. **Caps** — tools, budget, concurrency, workspace roots, remap/strict mode

---

## 6. Per-rival cheat sheet

| Rival | Compete? | Our line | Their win condition against us |
|-------|----------|----------|--------------------------------|
| **MS Conductor** | Yes (DAG class) | Incremental + coding-host MCP + replay | Dashboard + brand + “good enough YAML” |
| **Bernstein** | Yes (coding pipeline) | Portable DSL/IR, cross-run cache, multi-host | Simpler “goal→merge” path |
| **Paperclip** | Partial (gov) | Workflow semantics > org chart | Stars, governance UX |
| **Squad / AO / Emdash** | No (category) | Graph + cache + gate vs parallel sessions | Instant multi-session dopamine |
| **Claude Teams / Codex App** | Bypass risk | Portable assets + central policy | Zero install, default path |
| **Devin / Jules / cloud agents** | Backend opportunity | Orchestrate them under FlowIR | “Just assign the ticket” |
| **MAF / LangGraph / Crew** | No | Coding CLI DAG ≠ app agent graph | Ecosystem lock-in |
| **Temporal** | No | Agent decision replay ≠ workflow code replay | Enterprise durability RFPs |
| **Intent / spec products** | Aspirational | Open control plane + IR | Living-spec UX lead |

---

## 7. Gaps we previously under-weighted

1. **Cloud async coders** as default mental model for “long work”
2. **IDE/vendor multi-agent shells** (VS Code, Codex App) as distribution
3. **A2A / peer protocols** beyond MCP tools
4. **Spec layer** above FlowIR
5. **Security policy-as-code** + proof bundles (2026 breach narratives)
6. **Event-driven triggers** (Issue/CI/Slack → run), not only host `taskflow_run`
7. **Environment-addressed** fingerprints (image/nix/lockfile), not only git/glob
8. **Semantic merge / stronger isolation** than worktree alone

---

## 8. 0.3.0 outcome checklist (planning gate)

Ship when these are true:

- [ ] Thin MCP clients use default `controlMode: auto` (connect to or bootstrap taskflowd); in-process ControlHost only under explicit `controlMode: standalone` (never silent fallback)
- [ ] Per-project ControlStore authority; user ControlRegistry mounts/aggregates only
- [ ] `taskflow_capabilities` reflects live policy for the caller
- [ ] Policy: agent + model + tools + budget + roots; deny/substitute/attenuate traced
- [ ] WebUI or CLI: run observe + cancel/resume + policy edit (observe first)
- [ ] At least one **visible** incremental win (re-run cost / why-stale in UI)
- [ ] Docs: this map + control-plane RFC v7+ (“control plane”, not “another DAG”)
- [ ] Explicit non-goal list published (no Temporal, no org-chart OS, no Squad clone, no DomainTransfer in 0.3)

**Later (post-0.3 spikes):** cloud worker adapter, env-addressed cache, proof-carrying PR artifact, A2A worker advertisement, approval→policy learning.

---

## 9. Taglines (pick one for 0.3)

1. **One Taskflow MCP. One policy. Many coding backends.**
2. **Verify before spend. Remember what you spent. Replay what you decided.**
3. **The control plane for coding agents — compiled, incremental, portable.**

Avoid: “declarative multi-agent workflows” (Conductor-shaped); “run agents in parallel” (Squad-shaped); “AI company OS” (Paperclip-shaped).

---

## 10. Related docs

| Doc | Role |
|-----|------|
| [`rfc-local-daemon.md`](./rfc-local-daemon.md) | Daemon triggers + non-negotiables |
| [`0.2.0-north-star.md`](../0.2.0-north-star.md) | Compiler / incremental / replay story |
| [`market-positioning-2026-07.md`](../market-positioning-2026-07.md) | Conductor red-ocean detail |
| [`COMPETITORS.md`](./COMPETITORS.md) | Older full matrix (pre–H2 cloud wave) |
| [`taskflow-0.2.0-frontier-assessment.zh-CN.md`](../taskflow-0.2.0-frontier-assessment.zh-CN.md) | Honest maturity scores |

---

*Update when a rival ships content-addressed cross-run cache, host-neutral MCP control plane, or proof-carrying coding runs — those are the events that force a map revision.*
