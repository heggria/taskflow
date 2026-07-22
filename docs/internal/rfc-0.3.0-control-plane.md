# RFC: taskflow 0.3.0 — Coding-Agent Control Plane

> **Status:** Draft for multi-agent review  
> **Date:** 2026-07-22  
> **Branch:** `feat/0.3.0`  
> **Authors:** architecture synthesis from 0.2.x kernel + 2026 H2 competitive map  
> **Review ask:** approve / request-changes on **§1 decisions**, **§6 0.3 scope**, **§9 risks**  
> **Related:**
>
> | Doc | Role |
> |-----|------|
> | [`competitive-map-2026-h2.md`](./competitive-map-2026-h2.md) | Why this category, not Squad/Paperclip/Conductor-shaped |
> | [`rfc-local-daemon.md`](./rfc-local-daemon.md) | Prior daemon deferral; **this RFC reopens** under its non-negotiables |
> | [`rfc-background-run.md`](./rfc-background-run.md) | Detached runs remain a data-plane mechanism |
> | [`../rfc-0.2.0-architecture.md`](../rfc-0.2.0-architecture.md) | FlowIR / event kernel / strangler — **kernel stays**; 0.3 lifts *around* it |
> | [`../0.2.0-north-star.md`](../0.2.0-north-star.md) | compiled · resumable · incremental · replayable-for-what-if |

---

## TL;DR

1. **0.3 is not a new orchestration engine.** `taskflow-core` (FlowIR, cache, trace, resume, replay) remains the program kernel. 0.3 **lifts a Control Plane** around it so multi-host coding agents share one admission path, one policy, and one observation bus.
2. **Long-term shape = five planes + four primitives** (Intent · Compile · Control · Exec · Memory/Proof; Program/IR · Contract · Backend · Receipt). 0.3 implements Control + northbound adapters + Backend *boundary*; it does not implement Spec compilers, cloud farms, or A2A markets.
3. **`taskflowd` is optional** (default-off). Disk remains authority. In-process / stdio fallback must preserve 0.2.x semantics for users without a daemon.
4. **One Taskflow MCP surface** for all hosts; host packages shrink to **thin clients + Backend drivers + skills**. Tool names stay stable; add `taskflow_capabilities`.
5. **Policy is a link-time pass**, not a settings page: Catalog · Exposure · Caps; resolve modes `strict` | `remap` | `downgrade`, all traced.
6. **Success metric:** portable DAG programs under enforceable policy, with visible incremental/replay economics — **not** “faster multi-session TUI” or “AI company OS”.

**Reviewers:** see **§12 Review checklist** and open questions **§11**.

---

## §0. Motivation

### 0.1 Why reopen the daemon decision

[`rfc-local-daemon.md`](./rfc-local-daemon.md) correctly deferred a resident service after 0.2.3 detached lifecycle. Triggers to reopen are now met **product-wise**, not only by “long runs exist”:

| Trigger (local-daemon RFC) | 2026-07 evidence |
|----------------------------|------------------|
| MCP cold-start / process churn | Host MCP via `npx` / stale paths; multi-package server duplication |
| Cross-host concurrency / budget admission | Only advisory active-count; no single admission authority |
| Live UI / event subscription | Polling-only; WebUI/CLI control plane needs push |
| Multi-session claim of work | Multiple hosts write the same project store without a coordinator |

Additionally: **policy cannot be true** while each host embeds its own MCP server and spawns workers independently.

### 0.2 What 0.3 is *not* reacting to

| Wrong reaction | Why reject |
|----------------|------------|
| Clone Claude Squad / Composio AO | Session multiplex is a different category (competitive map L-session) |
| Clone Paperclip org-chart OS | Governance theater without FlowIR economics |
| Feature-race Microsoft Conductor on “YAML DAG” | Red ocean; our wedge is compile + incremental + multi-coding-backend |
| Rewrite runtime / force event kernel ON | Orthogonal to control-plane lift; keep S5 separate |
| Mandate cloud multi-tenant SaaS | Violates local-first; federation is later |

### 0.3 Product sentence (stable for multiple releases)

> **Taskflow compiles programs for coding agents, admits them under policy, executes them on heterogeneous backends, and leaves receipts you can recompute and replay.**

Hosts are **terminals** (submit / observe). They are not the system of record.

---

## §1. Architecture decisions (ADR table)

Reviewers: **challenge these first**. Changing them rewrites the RFC.

| ID | Decision | Choice | Rationale |
|----|----------|--------|-----------|
| **D1** | System role | **Coding-Agent Control Plane** (CACP), not app multi-agent SDK | Workers are real coding CLIs; intermediate transcripts stay out of host context |
| **D2** | Kernel ownership | **Keep `taskflow-core`**; no greenfield runtime | 0.2 already has FlowIR / cache / replay; 0.3 is OS around the kernel |
| **D3** | Plane split | **Five planes** (§2); Control ≠ Exec | Enables backend swap, optional remote workers, safe untrusted data plane |
| **D4** | Core primitives | **Program (FlowIR) · Contract · Backend · Receipt** (§3) | Stable vocabulary for policy, cache keys, cloud adapters |
| **D5** | Daemon default | **Optional / default-off** | Preserve process-less 0.2 path; no forced installer |
| **D6** | Authority | **Disk is authority** (runs, traces, flows, policy snapshots) | Daemon crash must not lose or rewrite history |
| **D7** | Namespace | **Per-project (canonical path / identity) admission by default** | Worktrees must not silently share a global queue |
| **D8** | Northbound | **Stable MCP tool surface + CLI**; WebUI is an adapter | MCP is first adapter, not the protocol universe |
| **D9** | Southbound | **`Backend` job protocol** wrapping today’s `SubagentRunner` | One receipt shape for local CLI and future cloud agents |
| **D10** | Policy semantics | **Link-time resolve**: strict / remap / downgrade + trace | UI checkboxes alone are not architecture |
| **D11** | Admission | **If global/project concurrency or budget queue is claimed, all participating clients must use the daemon** | No mixed bypass that falsifies the claim |
| **D12** | Compatibility | **Tool names & store layout backward compatible**; additive fields only | 0.2 flows/runs continue to load |
| **D13** | 0.3 ambition ceiling | **L1–L2 ship; L3 nails only** (§6) | Avoid building Paperclip+Squad+Conductor in one release |

---

## §2. Long-term architecture: five planes

```text
┌─────────────────────────────────────────────────────────────┐
│ INTENT PLANE                                                 │
│   Goals, human approvals, (future) specs / ADRs / invariants │
└────────────────────────────┬────────────────────────────────┘
                             │ compile
┌────────────────────────────▼────────────────────────────────┐
│ COMPILE PLANE          (largely 0.2)                         │
│   Taskflow / .tf.ts → FlowIR · verify · content hash         │
└────────────────────────────┬────────────────────────────────┘
                             │ link (policy) + admit
┌────────────────────────────▼────────────────────────────────┐
│ CONTROL PLANE          (0.3 primary)                         │
│   taskflowd: policy · admission · catalog · events · caps    │
└────────────────────────────┬────────────────────────────────┘
                             │ dispatch jobs
┌────────────────────────────▼────────────────────────────────┐
│ EXEC / DATA PLANE      (drivers today; pool/cloud later)     │
│   Backends: pi · codex · claude · opencode · grok · script   │
│   Isolation: cwd / worktree / (future) container·VM          │
└────────────────────────────┬────────────────────────────────┘
                             │ receipts
┌────────────────────────────▼────────────────────────────────┐
│ MEMORY / PROOF PLANE   (0.2 store+trace; 0.3 observe+)       │
│   runs · cache · traces · policy snapshots · proof export    │
└─────────────────────────────────────────────────────────────┘
```

**Rules:**

- **Northbound adapters** (MCP, CLI, WebUI, future CI/A2A) talk only to **Control** (or Compile read-only for verify).
- **Exec workers are untrusted** relative to Control: tools, network, and FS effects are constrained by Contract + Policy, not by worker honesty.
- **Memory is durable and forkable**; Control may cache indexes but must rehydrate from disk.

---

## §3. Four primitives

### 3.1 Program (`FlowIR` + Taskflow source)

- Portable, content-addressable, host-neutral.
- Source forms (JSON Taskflow, `.tf.ts`) remain; IR is the compile artifact.
- 0.3 does **not** require default execution path to flip to event kernel (S5 remains separate).

### 3.2 Contract (normalized phase obligations)

Unify today’s scattered fields into a conceptual contract (implementation may start as a resolved view, not a schema break):

| Dimension | Examples (existing → target) |
|-----------|------------------------------|
| Inputs | interpolation deps, `dependsOn`, map items |
| Outputs | `expect`, final flags, artifact paths |
| Effects | tools allow/deny, `cwd` / workspace keywords |
| Resources | `timeout`, phase/run `budget`, concurrency |
| Quality | gate / score / tournament judge |

**Forward nail:** every Backend advertises which contract classes it can fulfill.

### 3.3 Backend

```text
BackendId = "script" | "pi" | "codex" | "claude" | "opencode" | "grok" | …future
Backend.fulfill(Contract, Job) → Stream(Progress) → Receipt
```

- Today: `SubagentRunner` + host runners in `taskflow-hosts`.
- 0.3: explicit **registry** in Control; bind by policy + phase hints.
- Post-0.3: cloud coding agents implement the same interface.

### 3.4 Receipt

A Receipt is the durable unit of “what happened”:

```text
Receipt ⊆ {
  runId, phaseId,
  irHash, contractHash, policyHash,
  inputFingerprint,   // existing cache lineage
  envFingerprint?,    // reserved: lockfile / image / nix (L3)
  backendId, modelClass?, modelId?,
  outputs + content hashes,
  decisions[],        // gate / when / cache / budget / policy-remap
  usage, timing,
  replayHandle        // trace location / event offsets
}
```

Trace JSONL remains the append-only log; **product language** should shift toward Receipts and proof bundles over “chat transcripts”.

---

## §4. Design principles (P1–P10)

| # | Principle | Operational meaning |
|---|-----------|---------------------|
| **P1** | Program over session | System of record is IR + Receipts, not host chat |
| **P2** | Compile → spend → remember → replay | verify/capabilities before run; cache/replay after |
| **P3** | Policy is a compiler/link pass | bind / rewrite / reject with traced decisions |
| **P4** | Control ≠ Data | module boundaries even in single-process `taskflowd` |
| **P5** | Capability negotiation | callers discover allowed agents/models/backends |
| **P6** | Addressable memory | fingerprints are tagged & extensible (env later) |
| **P7** | Heterogeneous backends, homogeneous receipts | cloud/local look the same above Exec |
| **P8** | Graceful degradation | no daemon ⇒ 0.2 semantics; documented |
| **P9** | Human-on-the-loop is typed | approval outcomes + reasons are protocol, not vibes |
| **P10** | Local-first, federation-ready | per-project identity; no silent global coupling |

---

## §5. Control plane: `taskflowd`

### 5.1 Process model

```text
┌──────────────┐   unix socket (+ token)   ┌──────────────────────────┐
│ MCP thin     │ ─────────────────────────►│ taskflowd                │
│ CLI / WebUI  │                           │  gateway · policy · adm  │
└──────────────┘                           │  event hub · run index   │
                                           └────────────┬─────────────┘
                                                        │ in-proc call
                                           ┌────────────▼─────────────┐
                                           │ taskflow-core            │
                                           │ + Backend drivers        │
                                           └────────────┬─────────────┘
                                                        │
                                           disk: .pi/taskflows, ~/, traces
```

- **Transport:** Unix domain socket by default. Loopback TCP only with explicit token + threat note (from local-daemon RFC).
- **Lifecycle of a phase worker:** may remain one-shot process (0.3); warm pools are post-0.3 optimizations behind the Backend interface.
- **Detached runs:** remain valid Exec mechanism; daemon may *supervise* them rather than replace them.

### 5.2 Northbound API (logical; MCP is an adapter)

| Verb | Purpose | MCP mapping (illustrative) |
|------|---------|----------------------------|
| `health` / `version` | Handshake | `taskflow_version` |
| `capabilities` | Policy projection for caller | **`taskflow_capabilities` (new)** |
| `verify` / `compile` | 0-token preflight | existing tools |
| `submit` / `run` / `resume` | Lifecycle | `taskflow_run`, `taskflow_resume` |
| `cancel` / `list` / `status` / `wait` | Roster | `taskflow_runs` / peek |
| `subscribe` | Event stream | new MCP resource or SSE-over-socket; CLI watch |
| `replay` / `recompute` / `why_stale` | Memory ops | existing tools |
| `policy.get` / `policy.put` | Control config | CLI/WebUI first; MCP optional admin |

**Invariant:** business logic lives **once** (daemon service module). Thin MCP and in-process fallback **call the same module**.

### 5.3 Caller identity

Every northbound connection presents a **caller id**, e.g.:

```text
mcp:claude | mcp:codex | mcp:pi | mcp:opencode | mcp:grok | cli:local | webui:local
```

Policy Exposure is keyed by caller (+ optional project). Capabilities responses are **caller-specific projections**.

### 5.4 Version handshake

Reject mismatched:

- `protocolVersion` (socket/RPC)
- `schemaVersion` / `packageVersion` (from `getBuildInfo()`)
- optional `minCoreVersion`

Never silently mix client 0.2 semantics with daemon 0.3 admission claims.

---

## §6. Policy plane

### 6.1 Three objects (do not collapse)

| Object | Meaning | Editor |
|--------|---------|--------|
| **Catalog** | What exists: agents, model endpoints, backends | files + discovery |
| **Exposure** | What a **caller** may use from the catalog | WebUI/CLI policy |
| **Caps** | How far: tools, budget, concurrency, allowRoots, resolve mode | same |

### 6.2 Resolve modes

When a flow requests agent/model/backend outside exposure:

| Mode | Behavior | Use |
|------|----------|-----|
| `strict` | fail at verify/submit | teams / CI |
| `remap` | map to allowed equivalent; emit `decision: policy-remap` | personal ergonomics |
| `downgrade` | reduce tools / reasoning class; trace | cost control |

### 6.3 Policy snapshot

On submit, bind `policyHash` (and optional full snapshot path) into run metadata.  
**Changing policy must not rewrite historical receipts.** New policy applies to new submits only (unless explicit recompute under new policy — future).

### 6.4 MVP file shape (illustrative, not final schema)

```yaml
# .pi/taskflows/policy.yaml  (or user-level with project overlay)
version: 1
resolveMode: strict
callers:
  mcp:grok:
    agents: { allow: [explorer, executor, executor-fast] }
    models: { allow: ["grok-4.5", "grok-build"] }
    backends: { allow: [grok, script] }
    caps:
      maxConcurrentPhases: 4
      maxUSDPerRun: 5
      allowRoots: ["${projectRoot}"]
      defaultEffects: read-write  # refined per agent later
```

Exact schema is an open review item (§11 Q3); semantics above are normative.

---

## §7. Package / module boundary (proposed)

```text
packages/
  taskflow-core/           # kernel: unchanged public orchestration contract
  taskflow-daemon/         # NEW: taskflowd bin, socket, admission, policy, events
  taskflow-service/        # NEW or inside daemon: shared handlers (run/verify/…)
                           #   used by daemon AND in-process fallback
  taskflow-mcp-core/       # becomes thin transport OR re-exports service handlers
  taskflow-hosts/          # Backend drivers only (runners)
  taskflow-cli/            # NEW: tf health|run|status|policy|watch
  taskflow-web/            # OPTIONAL 0.3.x: observe + policy + approval
  {pi,codex,claude,opencode,grok}-taskflow/  # thin: plugin, skills, mcp bin → daemon
```

**Dependency direction:**

```text
adapters (mcp/cli/web) → service → core
daemon → service → core
daemon → hosts (drivers)
core ↛ daemon, ↛ mcp, ↛ web
```

---

## §8. Compatibility & degradation matrix

| Scenario | Behavior |
|----------|----------|
| No daemon installed | In-process service path = 0.2.x semantics; no global admission |
| Daemon up; thin MCP | All tools via socket; admission + policy enforced |
| Daemon dies mid-run | Run state on disk; workers may be detached; reconcile like 0.2.3; new submits fail or fallback per config |
| Old host plugin + new daemon | Handshake fail with actionable error |
| New client + old store | Additive read; unknown fields ignored |
| Policy missing | Catalog = discovered defaults; resolveMode defaults to **permissive for 0.3 migration** or **strict** — **reviewers pick (§11 Q4)** |

**Store:** keep `runs/`, `*.trace.jsonl`, flow library paths. Additive sidecars only (e.g. `policy.yaml`, daemon registry under user agent dir).

---

## §9. 0.3 scope vs non-goals

### 9.1 In scope (ship)

| Slice | Deliverable | Plane |
|-------|-------------|-------|
| S0 | This RFC + competitive map | — |
| S1 | `taskflowd` health/version/run/list/status | Control |
| S2 | Thin MCP + in-process fallback sharing handlers | Northbound |
| S3 | Policy MVP + `taskflow_capabilities` + traced resolve | Control |
| S4 | Project-level admission (concurrency; budget queue optional) | Control |
| S5 | CLI observe/watch (+ optional minimal WebUI) | Northbound |
| S6 | Backend registry boundary (local drivers only) | Exec |

**Must make 0.2 wedge user-visible:** at least one UX path shows **why-stale / cache hit / recompute savings** (Control → Memory).

### 9.2 Explicit non-goals (0.3)

- Mandatory daemon for any host  
- Multi-machine / cloud control plane HA  
- Org-chart / “AI company” product  
- Session multiplex TUI competing with Claude Squad  
- Temporal-class distributed exactly-once  
- A2A federation, agent marketplaces, bidding  
- Full Spec→FlowIR compiler  
- Environment-addressed cache v3 implementation (design nails only)  
- Event kernel default-ON (belongs to S5 kernel track)  
- Replacing detached one-shot workers with only in-daemon threads  

### 9.3 Forward nails (design only in 0.3, implement later)

1. Receipt fields: `policyHash`, `backendId`, `modelClass`, extensible fingerprint tags  
2. Backend interface stable for cloud adapters  
3. Northbound logical API ≠ MCP tool list (mapping table)  
4. Contract effects enum (`read` / `workspace-write` / `network` / `secret`)  
5. Approval reason codes for future policy learning  

---

## §10. Threat model (local 0.3)

| Threat | Mitigation in 0.3 |
|--------|-------------------|
| Malicious project content | Existing path guards; policy `allowRoots` |
| Worker prompt injection | Effects caps; no trust of model output for policy |
| Local socket hijack | Socket mode `0600`, token, per-user path |
| Policy bypass via old MCP | Document: admission claims require all clients on daemon; optional detect dual-writers |
| Cross-project data bleed | Per-project namespace; canonical directory identity |
| Daemon as root god process | No elevation; same user as client |

Remote exposure of WebUI/TCP is **out of default**; if enabled later, requires auth RFC addendum.

---

## §11. Open questions for reviewers

| # | Question | Options / notes |
|---|----------|-----------------|
| **Q1** | Is five-plane vocabulary worth teaching users, or keep “daemon + policy” externally? | Internal RFC yes; user docs may stay simpler |
| **Q2** | Single package `taskflow-daemon` vs split `taskflow-service`? | Split improves fallback purity; more packages |
| **Q3** | Policy schema: YAML in project, user overlay, or both? Merge rules? | Need deterministic overlay |
| **Q4** | Default `resolveMode` when no policy file? | `permissive` (migration) vs `strict` (safe) |
| **Q5** | Subscribe transport: JSONL on socket vs MCP notifications vs SSE? | Prefer one primary |
| **Q6** | Should `taskflow_run` **fail closed** if daemon configured but down, or auto fallback? | Product trust vs availability |
| **Q7** | WebUI in 0.3.0 vs 0.3.1? | RFC allows CLI-first acceptance |
| **Q8** | Rename northbound tools or freeze 0.2 names forever? | Freeze recommended |
| **Q9** | Project identity: path only vs path+inode digest (existing detached control)? | Prefer existing identity helpers |
| **Q10** | Any 0.3 need to touch event kernel / S5? | Author vote: **no** |

---

## §12. Review checklist (for agent reviewers)

Please return **structured** feedback:

```text
Verdict: Approve | Approve-with-nits | Request-changes | Reject
Summary: ≤5 lines

Decisions:
  D1..D13: Agree | Disagree (reason) | Amend (text)

Scope:
  - anything in §9.1 that should drop?
  - anything in §9.2 that must enter 0.3?

Risks:
  - top 3 failure modes if we implement as written

Compatibility:
  - store / MCP / host plugin breakages you foresee

Alternatives considered:
  - better plane split? better primitive set?

Nits:
  - naming, package layout, open questions votes (Q1–Q10)
```

**Blockers (must resolve before implementation):** D5/D6/D11 agreement, Q4, Q6, package split Q2.

---

## §13. Migration narrative (user-facing)

1. **0.2 users upgrade packages** → everything keeps working (in-process).  
2. **Opt in:** install/run `taskflowd`; point MCP bins at thin client.  
3. **Add policy** when ready; `capabilities` teaches host agents what they may emit.  
4. **Observe** via CLI/WebUI; cancel/resume unchanged run ids.  
5. **Never required** to abandon detached background runs or local store inspection.

---

## §14. Success criteria (0.3 exit)

- [ ] Thin MCP against daemon passes existing MCP e2e matrix (or documented subset)  
- [ ] Fallback without daemon matches 0.2.x golden behaviors for core tools  
- [ ] Policy strict mode rejects unauthorized agent at submit/verify  
- [ ] Remap/downgrade emit trace decisions and appear in `taskflow_trace` / replay inputs  
- [ ] Project admission prevents unbounded parallel submits under a cap  
- [ ] Handshake fails loudly on version skew  
- [ ] At least one demo: second run shows cache/recompute savings in CLI/UI  
- [ ] Docs: competitive map + this RFC linked from 0.3 CHANGELOG draft  
- [ ] No regression on “intermediate transcripts not in host context”

---

## §15. Implementation sketch (non-normative order)

```text
1. docs freeze (this RFC after review)
2. taskflow-service: extract handlers from mcp-core (no behavior change)
3. taskflow-daemon: socket + health + proxy to service
4. thin mcp bin + fallback flag
5. policy load + capabilities + resolve hook at submit
6. admission counter per project identity
7. subscribe + CLI watch
8. host package wiring + skills blurb
9. optional WebUI MVP
```

Kernel strangler (event kernel default ON) stays on its own track; do not block 0.3 on S5.

---

## §16. Changelog intent (when accepted)

- Status → **Accepted** with decision date and reviewer summary link  
- Update [`rfc-local-daemon.md`](./rfc-local-daemon.md): “Reopened by rfc-0.3.0-control-plane; non-negotiables retained”  
- Seed `packages/taskflow-daemon` only after Accept  

---

## Appendix A — Vocabulary

| Term | Meaning |
|------|---------|
| CACP | Coding-Agent Control Plane |
| Caller | Northbound principal (`mcp:claude`, `cli:local`, …) |
| Catalog / Exposure / Caps | Policy triple |
| Backend | Exec driver fulfilling contracts |
| Receipt | Durable phase/run evidence bundle |
| Nail | Interface reserved for post-0.3 without full implementation |

## Appendix B — What we refuse to become

| Look-alike | Refusal |
|------------|---------|
| Claude Squad | We don’t sell session tiles as orchestration |
| Paperclip | We don’t sell org charts as correctness |
| Conductor-only story | We don’t lead with “yet another YAML DAG” |
| Temporal | We don’t claim distributed exactly-once |
| Host Teams replacement | We port programs; we don’t out-UI the host |

---

*End of RFC draft. Reviewers: prefer concrete amendments to §1 and §9 over general enthusiasm.*
