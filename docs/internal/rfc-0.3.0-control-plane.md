# RFC: taskflow 0.3.0 — Coding-Agent Control Plane

> **Status:** **Draft v2 — Request-changes incorporated** (pending multi-agent re-review)  
> **Date:** 2026-07-22 (v1) · **Revised:** 2026-07-22 (v2)  
> **Branch:** `feat/0.3.0`  
> **v1 → v2:** Incorporates structured review (*Request changes*). Soul of 0.3 is **not** daemon/WebUI; it is **`BoundPlan` + durable journal + single execution semantics**.  
> **Related:**
>
> | Doc | Role |
> |-----|------|
> | [`competitive-map-2026-h2.md`](./competitive-map-2026-h2.md) | Category: control plane, not Squad/Paperclip/Conductor clone |
> | [`rfc-local-daemon.md`](./rfc-local-daemon.md) | Prior deferral; **reopened** — non-negotiables retained, default path amended |
> | [`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md) | **Normative** 0.3 security / resource model (not a side doc) |
> | [`rfc-background-run.md`](./rfc-background-run.md) | Detached remains one Exec mechanism under Job lifecycle |
> | [`../rfc-0.2.0-architecture.md`](../rfc-0.2.0-architecture.md) | FlowIR / event kernel strangler — **converged** into 0.3 GA gate |
> | [`../0.2.0-north-star.md`](../0.2.0-north-star.md) | compiled · resumable · incremental · replayable-for-what-if |
> | `packages/taskflow-core/src/exec/kernel-policy.ts` | Current dual-path gap inventory |
> | `packages/taskflow-core/src/resources/backend.ts` | Existing `WorkspaceExecutionBackend` seam |

---

## TL;DR

1. **External narrative stays simple:**  
   `Program → BoundPlan → Run → Receipt`  
   under a Coding-Agent Control Plane (CACP).

2. **Internal soul of 0.3 (non-negotiable triad):**
   1. **Single execution semantics** — one scheduler / state machine / cancel / resume path (no silent imperative↔kernel fork at run time);
   2. **Immutable BoundPlan** after policy + capability link;
   3. **Durable control journal** as authority (RunState/index/trace/receipt are views or derivatives).

3. **Daemon is the default admission path for 0.3 clients** (`controlMode: auto`), not a default-off spectator.  
   `standalone` is **explicit 0.2 compatibility**. Coordinated mode **fails closed** if control is unavailable.

4. **Do not invent a second resource model.** Policy linker **must** call existing authority / claim / lease / permit / sandbox seams ([`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md)). Names: **`ExecutionProvider`** (host/cloud runner) vs **`ResourceEnforcer`** (workspace backend).

5. **Trace ≠ ledger.** Today’s best-effort `FileTraceSink` cannot be Receipt authority. Split **Control Journal / materialized views / diagnostics Trace / derived Receipt**.

6. **Provider protocol** is `probe → prepare → submit → watch/poll → cancel → collect → reconcile`, not a single fulfill-stream.  
   Delivery: **at-least-once dispatch + idempotent submit + reconciliation** — never claim exactly-once.

7. **MCP stays a thin adapter.** Versioned Taskflow RPC (UDS/named pipe) is the internal control protocol.

**Re-review ask:** Approve / Request-changes on **§1 (D\*)**, **§6 journal**, **§8 controlMode**, **§12 GA gates**. Structured form in **§15**.

---

## §0. Motivation

### 0.1 Why 0.3 exists

0.2 delivered a strong **kernel wedge** (FlowIR, cache, why-stale, recompute, decision trace, multi-host runners) still packaged as **per-host MCP monoliths** with:

- dual execution paths (imperative vs event kernel) selected at runtime;
- best-effort traces that cannot prove completeness after crash;
- advisory concurrency only;
- policy that cannot be true without a single admission owner;
- a resource control scaffold that is **stronger** than a naive “allowRoots in YAML” rewrite would be — and must be **adopted**, not duplicated.

### 0.2 Failure mode this RFC forbids

```text
daemon × hosts × imperative|kernel × fg|detached × policy profiles
```

That is a **test-matrix bomb**, not a control plane. UI/daemon chrome on top of dual semantics is a **console for 0.2**, not a metamorphosis.

### 0.3 Product sentence

> **Taskflow links programs under policy and capabilities into an immutable BoundPlan, executes them with one semantic kernel on heterogeneous providers, and records a durable journal from which runs, receipts, and replays are derived.**

### 0.4 Explicit non-reactions

| Wrong reaction | Reject |
|----------------|--------|
| Session multiplex (Squad/AO) | Different category |
| Org-chart OS (Paperclip) | Different category |
| “YAML DAG race” with Conductor | Wrong wedge |
| Optional spectator daemon + in-process “full power” | Falsifies admission/policy |
| Exactly-once / multi-cluster k8s | Out of scope |
| Ignoring workspace capability RFC | Creates weaker parallel security model |

---

## §1. Architecture decisions (ADR) — v2

| ID | Decision | v2 Choice | Notes vs v1 |
|----|----------|-----------|-------------|
| **D1** | System role | **CACP** — programs for coding agents | Unchanged |
| **D2** | Kernel ownership | **Keep semantic assets + public facade** of `taskflow-core`; **must** refactor internal execution to **one** state machine | **Amended** — not “leave dual path alone” |
| **D3** | Plane split | Intent · **Compile** · **Link** · **Control** · **Exec** · **Ledger** (+ diagnostics) | **Amended** — Link + Ledger explicit |
| **D4** | Durable domain entities | **Program / BoundPlan / Job·Attempt / Event / Receipt** | **Amended** — drop top-level “Contract/Backend as peers of Receipt” |
| **D5** | Control process | **`controlMode: auto` default** for 0.3 clients; on-demand `taskflowd`; idle exit OK | **Amended** — not default-off |
| **D6** | Authority | **Control journal is authority**; RunState/index are projections; Receipt is derived; Trace is diagnostics | **Amended** |
| **D7** | Namespace | Per-project identity (canonical path + device/inode); bindings in user-private dir; **explicit rebind** on move/reclone | **Amended** |
| **D8** | Northbound | Stable MCP tools + CLI; MCP = thin adapter over Taskflow RPC | Unchanged intent, stronger thinness |
| **D9** | Southbound | **`ExecutionProvider` lifecycle** (§9); Receipt **only** issued by control from journal | **Amended** |
| **D10** | Policy ops | **`deny` / `substitute` / `attenuate`** + BoundPlan; no free-form `downgrade` | **Amended** |
| **D11** | Sandbox honesty | Unsupported sandbox **fail closed**; no stronger label than enforced | Aligns workspace RFC inv. 10 |
| **D12** | Store evolution | **read-old / write-new** migrator, backup, export, rollback — not forever freeze of 0.2 layout | **Amended** |
| **D13** | Scope ceiling | L1–L2 **plus minimal L3**: BoundPlan v1 + Receipt v1 + journal v1 are **GA gates** | **Amended** |
| **D14** | Resource model | **Normative dependency** on workspace capability model; no second authority system | **New** |
| **D15** | Caller identity | OS principal + optional adapter credential; self-reported `mcp:…` is **routing label**, not high-value authz alone | **New** |
| **D16** | Delivery semantics | at-least-once dispatch + idempotent submit + reconcile; terminal `unknown` / `dirty-unknown` allowed | **New** |

---

## §2. Planes (v2)

```text
┌─────────────────────────────────────────────────────────────┐
│ INTENT         goals, typed approvals, (future) specs       │
└────────────────────────┬────────────────────────────────────┘
                         │ compile
┌────────────────────────▼────────────────────────────────────┐
│ COMPILE        Taskflow / .tf.ts → FlowIR · verify · hash   │
└────────────────────────┬────────────────────────────────────┘
                         │ link(policy, capabilities, authority)
┌────────────────────────▼────────────────────────────────────┐
│ LINK           → immutable BoundPlan (+ hashes)             │
└────────────────────────┬────────────────────────────────────┘
                         │ admit / enqueue
┌────────────────────────▼────────────────────────────────────┐
│ CONTROL        taskflowd: admission, leases, commands, RPC  │
└────────────────────────┬────────────────────────────────────┘
                         │ Job / Attempt
┌────────────────────────▼────────────────────────────────────┐
│ EXEC           ExecutionProviders + ResourceEnforcer        │
└────────────────────────┬────────────────────────────────────┘
                         │ append facts
┌────────────────────────▼────────────────────────────────────┐
│ LEDGER         Control Journal (authority)                  │
│                projections: RunState, index, cursors        │
│                derived: Receipt                             │
│                diagnostics: Trace (best-effort OK)          │
└─────────────────────────────────────────────────────────────┘
```

**Rule:** Northbound adapters never write Exec side effects without going through Control commands that journal first (workspace inv. 5: intent before mutation).

---

## §3. Domain model

### 3.1 Program / FlowIR

Unchanged role: portable, content-addressable program. Sources: JSON Taskflow, `.tf.ts`.  
Phase-level **output contracts** keep the existing name **`OutputContract` / `expect`** — do **not** introduce a competing top-level type named `Contract`.

Phase obligations (inputs, effects class, tools, budget class) live as **fields of Program/BoundPlan**, not a peer primitive named Contract.

### 3.2 BoundPlan (new durable artifact)

Produced only by Link:

```text
Program + PolicySnapshot + CapabilitySnapshot + AuthorityGrants
    → BoundPlan
```

**Minimum fields:**

| Field | Purpose |
|-------|---------|
| `sourceHash` | Authoring artifact |
| `irHash` | FlowIR content address |
| `policyHash` | Normalized policy document |
| `capabilitySetHash` | Effective capability set after attenuation |
| `boundPlanHash` | Hash of the fully resolved plan (JCS or single canonicalizer) |
| resolved providers / model classes / tool sets | No unresolved `{{role}}` left |
| resolved workspace permits / roots | From ResourceEnforcer / authority |
| budget & concurrency **claims** | What admission must grant |
| redaction profile | Secrets in logs/receipts |
| `guaranteeTier` | e.g. resolve-only vs sandboxed honesty |
| `compatibilityTier` | which Program features required single-kernel support |

**Immutability:** After admit, execution uses **only** this BoundPlan. If policy/capability/authority changes, old plans are **not** silently reused; require re-link.

### 3.3 Job / Attempt

| Entity | Meaning |
|--------|---------|
| **Job** | One phase (or unit of work) under a run, may have many attempts |
| **Attempt** | One provider invocation with idempotency key |

Run state machine (control):

```text
Received → Compiled → Linked → Queued → Admitted
  → Dispatched → Running → Terminal
```

Attempt state machine:

```text
prepared → submitted → accepted → running
  → succeeded | failed | cancelled | unknown
```

Every transition: **journal append first** (monotonic sequence, expected version / fencing token).

### 3.4 Event (journal record)

Authoritative, totally ordered per run (and per control-domain as needed):

- command accepted / rejected  
- plan linked / admitted  
- attempt prepared / submitted / progress / terminal  
- lease acquired / fenced / released  
- policy decision (deny/substitute/attenuate)  
- budget hit, cancel requested, reconcile result  

### 3.5 Receipt (derived)

Issued **only by Control** after terminal facts are journaled:

```text
Receipt = f(journal slice, artifact hashes, boundPlanHash, buildInfo)
```

**Claim strength (normative):**

> Receipt proves that Taskflow, at a given build, BoundPlan, and policy/capability snapshot, **recorded and confirmed** the listed facts.  
> It does **not** prove absolute external-world completeness beyond what was journaled (providers may have unreaped side effects → `unknown` / `dirty-unknown`).

### 3.6 Naming: ExecutionProvider vs ResourceEnforcer

| Name | Responsibility |
|------|----------------|
| **ExecutionProvider** | Run coding CLI / script / future cloud agent (`prepare/submit/…`) |
| **ResourceEnforcer** | Today’s workspace control seam (`WorkspaceExecutionBackend` and resources/*): authority, leases, permits, sandbox fail-closed |

Providers **do not** mint trustworthy Receipts. Enforcers **do not** pick models.

---

## §4. Single execution semantics (Blocker 1 — GA gate)

### 4.1 Problem

`executeTaskflow` may take event kernel **or** imperative path; `kernelUnsupportedReason` lists large feature sets that force imperative ([`kernel-policy.ts`](../../packages/taskflow-core/src/exec/kernel-policy.ts)). That is an implementation reality **forbidden as a long-term dual semantic**.

### 4.2 Normative rule

- **One** scheduler, phase lifecycle, cancel/abort, resume, and event-emission contract.
- Legacy phase bodies may remain as **executors** plugged into that scheduler (strangler), but **must not** own a second scheduling/status model.
- Runtime **must not** silently select “another universe” based on feature flags without recording a **compatibility tier** and, for 0.3 GA, without a **parity matrix** that treats dual path as **bug**.

### 4.3 0.3 GA requirement

**Single-semantics convergence is a 0.3 GA gate**, not a post-GA optimization (answers **Q10 = Yes**).

Order:

1. Freeze 0.2 golden fixtures (all phase types + critical features).  
2. Make event-driven (or unified) scheduler the **only** state machine.  
3. Port or re-express unsupported features as executors on that machine; until ported, **fail closed at link** with clear “unsupported on 0.3 kernel” rather than silent fallback — **or** complete parity before GA.  
4. Remove runtime dual dispatch.

*Implementation may stage behind a flag during development; GA ships with dual path gone.*

---

## §5. Resource / security model (Blocker 2)

[`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md) is **normative** for 0.3.

Re-affirmed invariants (abbrev.):

1. Flow cannot self-grant physical roots.  
2. Nested/generated flows **attenuate only**.  
3. Distinct claims for resolve vs sandbox vs Taskflow file I/O.  
4. Shared lease/version domain for overlapping writers.  
5. **Persist mutation intent before side effects.**  
6. Uncertain cancel → `dirty-unknown`, never silent clean.  
7. Reconcile is explicit human acknowledgement, not magic restore.  
8. Cache hits skip model work, **not** auth/version/lease/restore.  
9. Nested attenuation only.  
10. Unsupported sandbox **fail closed**.

**Policy linker** must:

- resolve Exposure against Catalog;
- call authority/resource seams for permits;
- refuse plans that need enforcement Taskflow cannot provide at claimed `guaranteeTier`.

**User policy vs project policy:** user (or host) grants **authority**; project policy may only **attenuate**. Project YAML **cannot** enlarge roots, tools, or budgets beyond user/host grants.

---

## §6. Ledger vs Trace vs Receipt (Blocker 3)

### 6.1 Four layers

| Layer | Semantics | Lossiness |
|-------|-----------|-----------|
| **Control Journal** | Authoritative ordered facts | Must not be best-effort for control-critical events |
| **Projections** | RunState, index, live UI | Rebuildable from journal |
| **Trace** | Debug/observe stream | May sample / degrade / Noop for non-critical detail |
| **Receipt** | Terminal evidence package | Derived; integrity = journal + artifact hashes |

### 6.2 Today’s `FileTraceSink`

Documented as best-effort, buffered, fail-open ([`trace.ts`](../../packages/taskflow-core/src/trace.ts)). **Must not** be used as journal implementation.

### 6.3 Journal requirements (v1 minimum)

- Monotonic `seq` per stream (run and/or control domain)  
- Cursor-based subscribe / resume  
- Idempotent command application  
- Conditional write / expected version (CAS) where races exist  
- Defined **fsync / durability boundary** for: admit, attempt submit, terminal, cancel, lease  
- Projection rebuild + equality tests vs live materialization  
- Retention, redaction, secret handling  
- Artifact content hashes referenced by Receipt  
- Backup / export / import / rollback tooling (with 0.2 importer)

### 6.4 ControlStore port

Abstract **`ControlStore`** so local implementation can be:

- SQLite (e.g. `node:sqlite` + WAL) **behind a port**, or  
- append-only files with careful locking  

Nails: fault injection, not-on-network-FS for WAL, single-writer assumptions documented, replaceable backend.

---

## §7. Policy as linker (Blocker 5)

### 7.1 Pipeline

```text
Program → FlowIR → Link(PolicySnapshot, CapabilitySnapshot, Authority)
        → BoundPlan → Admission → Execution
```

### 7.2 Operations (only three)

| Op | Meaning |
|----|---------|
| **deny** | Reject link/submit |
| **substitute** | Replace agent/model/provider **only** via **explicit** substitution rules whose target still satisfies phase obligations |
| **attenuate** | Remove capabilities the Program marked **optional**, or reduce to a declared subset; never silently strip required effects |

**Removed:** free-form `remap` / `downgrade` without formal equivalence.

### 7.3 Schema & hash

- YAML/JSON inputs allowed; **execute only after** validate → overlay merge → **normalized JSON** → hash.  
- Prefer one canonicalization (e.g. **RFC 8785 JCS**) with domain/version prefix on hashes.  
- **Security-critical schemas: unknown fields → fail closed.**  
- Legacy RunState projections may tolerate unknown fields when reading old files.

### 7.4 Default when no policy file

**v2 default:** `resolveMode` effective behavior = **attenuate-nothing + deny-nothing** at Exposure layer **only in `controlMode: standalone`**.  

For **`auto` / `coordinated`**: if no policy file, use **discovered catalog with host/user authority defaults**, still producing a BoundPlan hash (empty-policy snapshot is still a snapshot). Broad “permissive” must not skip BoundPlan minting.

*(Pin exact empty-policy Exposure in implementation ADR if needed.)*

---

## §8. controlMode (Blocker 4) — **watershed accepted**

| Mode | Behavior |
|------|----------|
| **`auto` (default for 0.3 clients)** | Connect to user-level control service; **start on demand** if missing; share admission/journal; idle exit allowed |
| **`coordinated`** | Must use control service; **fail closed** if unavailable |
| **`standalone`** | Explicit 0.2-compatible in-process path; **no** claim of global admission/cross-host budget/single approver; docs must say so |

**Normative:** New 0.3 MCP/CLI **default `auto`**.  
Silent fallback from `auto`/`coordinated` to full standalone power is **forbidden** when control is configured/required.

On-demand daemon ≠ optional spectator: **default clients still share one admission path** when control can run.

---

## §9. ExecutionProvider lifecycle (Blocker 6)

```ts
// Conceptual interface — names illustrative
interface ExecutionProvider {
  probe(): ProviderCaps;
  prepare(boundSlice, caps): FulfillmentPlan;
  submit(plan, idempotencyKey): JobHandle;
  watch(handle, cursor) | poll(handle): ProviderEvent[];
  cancel(handle): void;
  collect(handle): BackendResult;      // evidence, not Receipt
  reconcile(handle | idempotencyKey): ReconcileResult;
}
```

Covers: disconnect after accept, daemon restart, webhook/poll, remote cancel, late usage, artifact fetch, duplicate submit, unknown terminal.

**Receipt issuance:** Control only, after journalized terminal + collect/reconcile.

Detached runners become **one provider strategy**, not a parallel control plane.

---

## §10. Identity & threat model (Blocker 7)

| Principal | Use |
|-----------|-----|
| **OS user** | Socket `0600`, same-uid; baseline local trust |
| **Adapter credential** (optional scoped token) | Bind CLI/MCP install to a caller class when available |
| **Self-reported caller label** (`mcp:codex`) | Routing, UX, **non-authoritative** Exposure key unless bound to credential |

**Honest threat model for 0.3 local:** same-uid malicious process is largely in-scope as “can act as user”; we mitigate path/symlink, policy attenuation, journal integrity, not full multi-tenant isolation on one uid.

High-value deployments later: stronger adapter auth, remote TCP only with explicit auth RFC.

---

## §11. Protocol & package boundary

### 11.1 Protocols

| Layer | Choice |
|-------|--------|
| Internal control | Versioned **Taskflow RPC** over UDS (Win: named pipe) |
| Edge | MCP tools map 1:1 onto commands; SDK churn isolated in adapter |
| Schema | TypeBox (+ single hash/canonicalize helper) |

### 11.2 Packages (proposed)

```text
taskflow-core/          kernel + resources + journal ports + single scheduler
taskflow-control/       control application (commands, link, admit) — reusable
taskflow-daemon/        process: RPC server, on-demand lifecycle
taskflow-mcp-core/      thin MCP adapter only
taskflow-hosts/         ExecutionProviders
taskflow-cli/           tf … (0.3.0 acceptance surface)
taskflow-web/           0.3.1+ local UI (not second permanent Next server in 0.3.0)
*-taskflow/             skills + thin bins
```

`core ↛ daemon/mcp/web`.  
Extract logic out of `makeToolHandlers` monolith in `taskflow-mcp-core` **before** feature growth.

### 11.3 Tool stability

Freeze 0.2 tool **names** where possible; add `taskflow_capabilities`; map to RPC commands via table (tools ≠ protocol).

---

## §12. Toolchain stance (informative, not the soul)

Prefer modern-and-recoverable over “install every beta”:

| Layer | Guidance |
|-------|----------|
| Node | Prefer **LTS baseline** (e.g. 24 LTS) in CI; Current in matrix optional; drop experimental type-strip flags when stable |
| TypeScript | CLI typecheck on current TS; **isolate** packages that need older programmatic compiler API (DSL) |
| pnpm | Current major + frozen lockfile + script allowlist |
| Format | Single formatter (e.g. Biome) for repo; `tsc` for types |
| OTel | Optional exporter; **not** hard-coded into Receipt schema |
| MCP SDK | Adapter only; don’t make beta SDK the control core |

Exact version pins land in a separate tooling ADR after green trunk.

---

## §13. Implementation order (normative sequencing)

1. **Green trunk + freeze 0.2 golden corpus** (12 phases, cache/resume/replay, critical kernel-unsupported features).  
2. **Single execution semantics** strangler complete enough for GA gate.  
3. **Domain/protocol layer:** BoundPlan, Job, Attempt, Event, Receipt, error taxonomy, hash.  
4. **Control application** extracted from MCP monolith.  
5. **Durable journal + ControlStore + 0.2 importer** (rebuild, backup, export, rollback).  
6. **On-demand daemon + RPC + negotiation + cursor subscribe.**  
7. **Policy linker → BoundPlan**, wired to **existing** resource authority; admission leases, fencing, idempotency, budget claims.  
8. **ExecutionProvider lifecycle** for all hosts + detached.  
9. **Thin MCP + CLI**; WebUI **0.3.1**.

---

## §14. Compatibility & migration

| Topic | Rule |
|-------|------|
| 0.2 runs/traces/cache | **Importer** into journal/projections; do not require perfect in-place rewrite |
| Write path | New layout after migration; keep export/rollback |
| `standalone` | Supported for compatibility; degraded guarantees labeled |
| Host plugins | Thin client; handshake on protocol/schema versions |
| Dual-writer | Detect/warn if standalone and coordinated both write same project without lease |

---

## §15. Open questions (remaining) & closed votes

| # | Topic | Status |
|---|-------|--------|
| Q2 | `taskflow-control` vs fold into daemon package | **Open** — prefer split for testability |
| Q3 | Policy file locations / overlay algebra | **Open** — must obey user⊇project attenuation |
| Q4 | Empty-policy defaults | **Partially closed** in §7.4 |
| Q5 | Subscribe: RPC stream vs MCP notifications | **Open** — prefer RPC primary, MCP maps |
| **Q6** | Daemon down | **Closed: fail closed** for auto/coordinated when control required; no silent full standalone |
| **Q7** | WebUI | **Closed: 0.3.1**; CLI semantic acceptance in 0.3.0 |
| Q8 | Tool renames | **Closed: freeze names** |
| **Q9** | Project identity | **Closed:** path+device/inode; user-private binding; explicit rebind |
| **Q10** | Single kernel | **Closed: Yes — 0.3 GA gate** |
| Q11 | Journal first impl (sqlite vs files) | **Open** — behind ControlStore |
| Q12 | Which kernel-unsupported features block GA vs fail-at-link | **Open** — need parity matrix ownership |

---

## §16. 0.3 GA “no dead angle” acceptance

Minimum matrix:

- [ ] Kill control at: pre-admit, post-submit, pre-receipt; restart + reconcile  
- [ ] 100 concurrent submits; duplicate idempotency keys; dual-daemon race; expired lease; PID reuse  
- [ ] Project policy cannot enlarge user authority; unknown security fields rejected  
- [ ] Post-link policy/capability change invalidates old BoundPlan reuse  
- [ ] Caller label spoof cannot escalate beyond OS principal grants  
- [ ] Symlink/path swap tests for roots  
- [ ] Secret redaction in journal projections / receipts  
- [ ] All frozen 0.2 fixtures import; export/rollback works  
- [ ] 5 hosts × fg/bg × cancel/resume × usage path  
- [ ] Journal rebuild ≡ live RunState projection  
- [ ] Every Receipt fact traces to journal event + artifact hash  
- [ ] **No runtime silent dual execution path**  
- [ ] Workspace invariants 1–10 enforced on mutating paths  
- [ ] `controlMode: standalone` docs + tests prove degraded claims  
- [ ] Visible incremental wedge (why-stale / cache) still works under BoundPlan  

---

## §17. Success criteria (product)

- Default 0.3 client uses **shared admission** (`auto`).  
- BoundPlan hash stable under canonicalization; appears on run/receipt.  
- Policy ops only deny/substitute/attenuate; decisions journaled.  
- Providers implement reconcile; crashes leave `unknown`/`dirty-unknown` honestly.  
- One MCP surface, thin adapters, CLI proves semantics without WebUI.  
- Competitive story remains: **compile · link · admit · journal · recompute/replay** — not session tiles.

---

## §18. Review response summary (v1 → v2)

| Blocker | Disposition |
|---------|-------------|
| B1 Dual kernel | **Accepted** — single semantics is GA gate (D2, §4, Q10) |
| B2 Parallel resource model | **Accepted** — workspace RFC normative; ExecutionProvider vs ResourceEnforcer (D14, §5) |
| B3 Trace as ledger | **Accepted** — journal/projection/trace/receipt split (D6, §6) |
| B4 Default-off daemon | **Accepted** — `controlMode: auto` default (D5, §8) |
| B5 Weak policy | **Accepted** — BoundPlan + deny/substitute/attenuate (D10, §7) |
| B6 Fulfill-stream only | **Accepted** — full provider lifecycle (D9, §9) |
| B7 Forgable caller | **Accepted** — labels vs principals (D15, §10) |

**Watershed decision:** **Accept** — new 0.3 clients default `controlMode: auto`; `standalone` is explicit compatibility. This is what makes 0.3 a control plane rather than an optional sidecar.

---

## §19. Structured re-review template

```text
Verdict: Approve | Approve-with-nits | Request-changes | Reject
Summary: ≤5 lines

Triad check:
  single semantics / BoundPlan / durable journal — each: Strong | Weak | Missing

Decisions D1–D16: Agree | Disagree | Amend

controlMode: auto default — Agree | Disagree

GA matrix §16 — gaps

Residual risks (top 3)

Nits
```

---

## Appendix A — Vocabulary

| Term | Meaning |
|------|---------|
| BoundPlan | Immutable link result; execution input |
| Control Journal | Authoritative event log |
| ExecutionProvider | Host/cloud/script runner API |
| ResourceEnforcer | Workspace authority/lease/sandbox seam |
| Receipt | Derived terminal evidence |
| controlMode | auto \| coordinated \| standalone |
| guaranteeTier | Honest isolation claim (resolve-only / sandboxed / …) |

## Appendix B — What we still refuse

| Look-alike | Refusal |
|------------|---------|
| Spectator daemon | Default clients share admission |
| Dual silent runtimes | GA forbids |
| Backend-minted Receipt | Control only |
| Project policy privilege escalation | Attenuate only |
| Trace-as-proof | Diagnostics only |
| Exactly-once marketing | At-least-once + idempotency + reconcile |

---

*End RFC v2. Implementation must not start on daemon UI until §13 steps 1–3 have an owned plan and green golden corpus.*
