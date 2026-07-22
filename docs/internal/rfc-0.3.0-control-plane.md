# RFC: taskflow 0.3.0 — Coding-Agent Control Plane

> **Status:** **Draft v3 — protocol-hardening after second Request-changes**  
> **Date:** 2026-07-22 (v1) · **v2:** triad + controlMode · **v3:** dynamic plan model, journal intent/observe, authority revalidation, legacy evidence, unified ControlHost  
> **Branch:** `feat/0.3.0`  
> **v3 watershed:** BoundPlan is an **immutable instantiable template**, not a fully static DAG. Dynamic topology produces **BoundFragment** hash chains under parent authority.  
> **Related:**
>
> | Doc | Role |
> |-----|------|
> | [`competitive-map-2026-h2.md`](./competitive-map-2026-h2.md) | Category positioning |
> | [`rfc-local-daemon.md`](./rfc-local-daemon.md) | Daemon non-negotiables; default path amended by this RFC |
> | [`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md) | **Normative** resource/security model |
> | [`rfc-background-run.md`](./rfc-background-run.md) | Detached = one ExecutionProvider strategy |
> | [`../rfc-0.2.0-architecture.md`](../rfc-0.2.0-architecture.md) | FlowIR / kernel strangler → single semantics GA gate |
> | [`../0.2.0-north-star.md`](../0.2.0-north-star.md) | compiled · resumable · incremental · replayable-for-what-if |
> | `packages/taskflow-core/src/exec/events.ts` | Today’s `Event ≈ TraceEvent` — **not** Control Journal |
> | `packages/taskflow-core/src/resources/backend.ts` | `WorkspaceExecutionBackend` / ResourceEnforcer seam |

---

## TL;DR

1. **Product shape:** Coding-Agent Control Plane.  
   External story: `Program → BoundPlan → Run → Receipt`.

2. **Soul (triad) — unchanged and Strong:**
   1. **Single execution semantics** (one scheduler/state machine);
   2. **Link-time BoundPlan / BoundFragment** (immutable decisions, not silent dual paths);
   3. **Durable control journal** as authority (projections / diagnostics / receipts derived).

3. **BoundPlan model (v3 watershed — accepted):**  
   BoundPlan is an **immutable executable template**.  
   Runtime topology (`flow{def}`, `expand:graft`, `ctx_spawn({subflow})`, …) does **not** mutate the parent plan and does **not** bypass Link.  
   It emits **PlanFragment → BoundFragment** under **attenuated parent authority**, with an explicit **hash chain**.  
   Deterministic `map`/`loop`/`tournament` item expansion uses **NodeInstance** ids without full re-link when the template already bound the item shape.

4. **`controlMode: auto` default** (accepted).  
   `auto` | `coordinated` | `standalone` share **one ControlHost** (same compiler, linker, scheduler, journal schema, BoundPlan, Receipt, ResourceEnforcer).  
   Difference = **ownership scope**, not semantics.  
   `auto` that cannot start control → **error** (no silent standalone).

5. **Journal rule (corrected):**  
   Persist **command/intent** before external side effect; persist **acknowledged observation** after provider response; **reconcile** ambiguous windows with stable idempotency identity.  
   Not “every FSM edge is a pre-claimed fact.”

6. **BoundPlan is decision evidence, not an irrevocable authority bearer.**  
   Grants are references + versions; revalidate at admit and before mutation; revocation blocks new Attempts.

7. **Legacy 0.2 trace ≠ journal.** Import as `LegacyEvidenceImported` with `completeness: unknown`; at most `legacy-unverified` Receipts.

8. **Do not freeze domain schema / implement journal importer / multi-package parallel build** until §3–§11 protocol pins below are accepted. Safe to start: **green trunk, toolchain ADR, kernel convergence**.

**Re-review ask:** Approve protocol freeze on **§3 (dynamic plan)**, **§6 (journal intent/observe)**, **§7 (authority)**, **§8 (ControlHost modes)**, **§10 (legacy evidence)** — then schema freeze. Form in **§20**.

---

## §0. Motivation (stable)

0.3 metamorphoses packaging and durability around the 0.2 kernel wedge — it does **not** invent another DAG brand, session multiplexer, or org-chart OS.

**Forbidden failure mode:** daemon × hosts × dual kernel × dual store × weak policy = console on 0.2.

**Product sentence:**

> Taskflow links programs under policy and capabilities into immutable BoundPlans/BoundFragments, executes them with one semantic kernel on heterogeneous providers, and records a durable journal from which runs, receipts, and replays are derived.

---

## §1. Architecture decisions (ADR) — v3

| ID | Decision | Choice |
|----|----------|--------|
| **D1** | Role | CACP — programs for coding agents |
| **D2** | Kernel | Keep semantic assets + public facade; **single** internal state machine (GA gate) |
| **D3** | Planes | Intent · Compile · Link · Control · Exec · Ledger (+ diagnostics Trace) |
| **D4** | Durable entities | **Program, BoundPlan, BoundFragment, Run, NodeInstance, Attempt, ProviderJobHandle, JournalEvent (ControlEvent), Receipt** |
| **D5** | Control access | `controlMode: auto` default; on-demand daemon; idle exit OK |
| **D6** | Authority store | **Control journal**; RunState/index projections; Receipt derived; Trace diagnostic |
| **D7** | Project identity | path + device/inode; user-private binding; **explicit rebind** |
| **D8** | Northbound | Thin MCP + CLI; tools map to Taskflow RPC |
| **D9** | Southbound | Async **ExecutionProvider** lifecycle; control issues Receipts |
| **D10** | Policy ops | **deny / substitute / attenuate** only |
| **D11** | Sandbox honesty | Unsupported → fail closed |
| **D12** | Store migration | read-old / write-new; backup; export; rollback |
| **D13** | Scope | L1–L2 + minimal L3: BoundPlan/Fragment v1, journal v1, Receipt v1 |
| **D14** | Resources | Normative workspace capability RFC; **ExecutionProvider** ≠ **ResourceEnforcer** |
| **D15** | Caller | OS principal (+ optional adapter credential); `mcp:*` is routing label unless bound |
| **D16** | Delivery | at-least-once + idempotent submit + reconcile; `unknown` / `dirty-unknown` |
| **D17** | Dynamic topology | **Template BoundPlan + BoundFragment hash chain** (not fully static DAG; not mutate-in-place) |
| **D18** | ControlHost unity | auto/coordinated/standalone = **same 0.3 ControlHost**; no legacy dual stack in standalone |
| **D19** | Authority on plans | Plans hold **grant refs + epochs**, not bearer secrets; revalidate at admit/mutate |
| **D20** | Exclusive write | One control owner per project store; dual-writer **fail closed** (not warn-only) |

---

## §2. Planes

```text
INTENT → COMPILE → LINK → CONTROL → EXEC → LEDGER
                      ↑                │
                      └── BoundFragment from dynamic generation
```

- **Link** produces BoundPlan / BoundFragment.  
- **Control** admits, leases, commands, approvals.  
- **Exec** runs ExecutionProviders under ResourceEnforcer.  
- **Ledger** appends ControlEvents; projections rebuild RunState.

---

## §3. Domain model (v3 — protocol core)

### 3.1 Entity graph

```text
Program / FlowIR
    │ link
BoundPlan                    (immutable template for a submit)
    │ admit
Run                          (one execution of a root BoundPlan)
    │ expand template
NodeInstance                 (phase | map item | loop iter | grafted node | …)
    │ optional dynamic IR
PlanFragment → BoundFragment (re-linked under parent authority)
    │
Attempt                      (one provider invocation)
    └── ProviderJobHandle    (external id, if any)
JournalEvent (ControlEvent)
Receipt                      (derived terminal package for Run and/or NodeInstance)
```

**Naming rules:**

| Term | Means | Does **not** mean |
|------|--------|-------------------|
| **Run** | First-class execution of a root plan (today’s RunState grain) | A single phase |
| **NodeInstance** | Concrete node in the run DAG (incl. map items) | Remote provider job |
| **Attempt** | One try to fulfill a NodeInstance via a provider | The logical phase |
| **ProviderJobHandle** | Opaque id from ExecutionProvider | Taskflow run id |
| **BoundPlan** | Immutable linked **template** | Fully static closed world of all future nodes |
| **BoundFragment** | Linked dynamic subgraph | Free-form unlinked `def` |

Avoid overloaded **Job** in durable schema. RPC may use `providerJob` only for external handles.

### 3.2 BoundPlan = immutable instantiable template (watershed)

**Accepted:** BoundPlan is **not** required to enumerate every runtime node of a dynamic Taskflow.

It **is** required that:

1. Everything that executes is either:
   - an instantiation of a template node already present in some BoundPlan/BoundFragment, or  
   - a **newly linked BoundFragment** under parent authority;
2. Nothing executes that bypassed Compile + Link + Admit (for fragments) or deterministic instance rules (for map/loop items);
3. Parent BoundPlan bytes are **never mutated** after minting.

#### 3.2.1 PlanInstance / fragments

| Concept | Definition |
|---------|------------|
| **BoundPlan** | Link result for a root (or saved subflow template) submit |
| **PlanInstance** | Runtime binding of BoundPlan → Run (ids, seeds, claim set) |
| **PlanFragment** | Generated IR (`flow{def}`, expand body, spawned subflow def, …) before link |
| **BoundFragment** | Fragment after Compile + Link under **attenuated** parent authority |
| **NodeInstance** | Concrete work item id, stable and deterministic where inputs are |

#### 3.2.2 Dynamic path (must re-Link)

Applies to at least:

- `flow` phase with runtime `def` (model-authored subgraph);
- `expand` with `graft` (promote phases onto parent under prefixes);
- `ctx_spawn({ subflow })` creating a child run/subflow from dynamic def;
- any future “generate IR mid-run” feature.

```text
Generated PlanFragment
  → Compile (FragmentIR + fragmentIRHash)
  → Link under parent authority (attenuate only)
  → BoundFragment + boundFragmentHash
  → Admit (fragment claims)
  → Execute (NodeInstances / Attempts)
```

**Hash chain (normative fields on BoundFragment + journal):**

```text
parentBoundPlanHash
parentBoundFragmentHash?     // if nested fragment
sourceEventSeq               // journal seq that justified generation
fragmentIRHash
fragmentPolicyHash           // effective policy slice used at fragment link
capabilitySetHash
authorityEpoch               // see §7
boundFragmentHash
```

#### 3.2.3 Deterministic instantiation (no full re-Link)

`map` / `loop` / `tournament` **item** expansion when:

- item agent/tools/model/effects were already bound in the parent BoundPlan template, and  
- only data (`{item}`, iteration index) changes,

may create **NodeInstance** records with deterministic ids:

```text
nodeInstanceId = hash(
  runId,
  templateNodeId,
  instanceKey,           // index | loop n | tournament k
  parentBoundPlanHash
)
```

without a new BoundFragment — **provided** no new IR, tools, roots, or provider class appears.

If an item would need new tools/roots/provider → **must** elevate to BoundFragment path or **deny**.

#### 3.2.4 Forbidden

- Mutating BoundPlan in place to “add phases”;  
- Executing model-authored JSON without Link;  
- Child runs that **expand** authority beyond parent attenuation;  
- Journal gaps where dynamic nodes appear without `FragmentLinked` / `NodeInstanceCreated` events.

### 3.3 Run state machine

```text
Received → Compiled → Linked → Queued → Admitted
  → Running ⇄ (FragmentLinked)* → Terminal
```

Terminal includes success, failed, cancelled, blocked (gate/approval), budget-blocked, **unknown** (when required).

### 3.4 Attempt protocol — intent vs observation (Blocker B2)

**Normative wording (replaces “every transition journal-first”):**

> Persist **command/intent** before external side effect;  
> persist **acknowledged outcome** after observation;  
> **reconcile** ambiguous windows using stable idempotency identity.

#### 3.4.1 Dispatch sequence

```text
AttemptPrepared
  → DispatchIntentRecorded (+ durability boundary / fsync policy)
  → ExecutionProvider.submit(idempotencyKey)
  → DispatchAcknowledged(ProviderJobHandle)   // or reject / ambiguous
  → (ProviderProgress observed)*              // not auto-authoritative
  → AttemptTerminal journaled after collect/reconcile
```

#### 3.4.2 Crash windows

| Crash point | Recovery |
|-------------|----------|
| After intent, before provider call | Safe retry `submit` with same idempotency key |
| After provider accept, before local ack | `reconcile(idempotencyKey \| handle)` |
| Provider lacks idempotency/query | Leave **`unknown`**; workspace may be **`dirty-unknown`** |
| Handle known, terminal unknown | `watch` / `poll` / `reconcile` until deadline then unknown |

#### 3.4.3 Provider capability levels

```text
ProviderCaps.idempotencyLevel:
  none | best-effort | strong

ProviderCaps.reconcileLevel:
  none | handle-only | idempotency-key | full
```

- `idempotencyLevel: none` → control **must not** auto-resubmit after ambiguous crash; escalate to unknown / human.  
- Progress events are **observations**; only control upgrades Attempt state after validation rules.

#### 3.4.4 Ordering

- Control-domain journal seq is authoritative for control decisions.  
- Resource-domain (lease/permit) mutations follow workspace RFC: intent before side effect, fence tokens on writers.  
- Fence / lease tokens must be available to ResourceEnforcer at mutation; providers receive only what policy allows.

### 3.5 BoundPlan / BoundFragment fields (decision evidence)

Minimum BoundPlan:

```text
sourceHash, irHash, policyHash, capabilitySetHash, boundPlanHash
resolved provider classes / model classes / tool sets (template nodes)
grantRefs[] { issuer, grantId, version/epoch, scope, expiry? }
workspaceBaselineRequirements
budgetClaims, concurrencyClaims
redactionProfile, guaranteeTier, compatibilityTier
dynamicPolicy { allowFragmentKinds[], maxFragmentDepth, maxFragmentNodes }
```

**Not stored as bearer secrets:** raw capability tokens that alone unlock FS roots.

### 3.6 Receipt

Control-issued only:

```text
Receipt = f(journal slice, artifact hashes, boundPlanHash|boundFragmentHash, buildInfo)
completeness: complete | partial | legacy-unverified | unknown
```

Claim strength unchanged: proves **recorded and confirmed** facts under that plan snapshot — not omniscient external truth.

---

## §4. Single execution semantics

Unchanged intent from v2: **GA gate**. One scheduler; legacy phase code as executors only; no silent dual universe.

Dynamic fragments use the **same** scheduler after BoundFragment admit.

---

## §5. Resource model

[`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md) remains **normative** (invariants 1–10).

Policy linker and fragment linker both call ResourceEnforcer; nested fragments **attenuate only**.

---

## §6. Ledger layers

| Layer | Type name (normative) | Role |
|-------|----------------------|------|
| Authority log | **`ControlEvent`** / JournalEvent | Strict, ordered, durable |
| Projections | RunState, indexes, cursors | Rebuildable |
| Diagnostics | **`ExecutionTraceEvent`** (today’s TraceEvent lineage) | Best-effort OK |
| Evidence package | **Receipt** | Derived |

### 6.1 Do not reuse today’s `Event = TraceEvent & { v }` as journal

Current `packages/taskflow-core/src/exec/events.ts` upgrades/fills defaults and maps unknown kinds — acceptable for **legacy replay corpora**, **forbidden** as Control Journal write path or “wash” importer.

### 6.2 Journal minimums

Monotonic seq, cursors, idempotent commands, CAS/fencing, defined fsync points (intent, ack, terminal, cancel, lease), projection rebuild tests, retention/redaction, artifact hashes, backup/export/rollback, **ControlStore** port (sqlite-or-files behind interface).

### 6.3 Fsync points (minimum)

| Point | Required durability |
|-------|---------------------|
| DispatchIntentRecorded | Yes before `submit` |
| DispatchAcknowledged | Yes before treating handle as owned |
| Attempt/Run terminal | Yes before Receipt |
| Cancel requested | Yes before provider cancel best-effort |
| Lease/permit grant for mutation | Yes before side effect (workspace RFC) |

---

## §7. Authority revalidation (BoundPlan is not a bearer)

**Normative:**

> BoundPlan / BoundFragment are immutable **decision evidence**.  
> They are **not** irrevocable authorization credentials.

### 7.1 Grant references

Plans store `grantRefs` + `authorityEpoch` / versions, not sole bearer tokens.

### 7.2 When to revalidate

| Moment | Action |
|--------|--------|
| Admission (run or fragment) | Re-check grantRefs still valid |
| Before each mutating Attempt | Authority + lease + fence |
| On revocation signal | Block **new** Attempts; cancel in-flight; if cancel unconfirmed → unknown / dirty-unknown |
| Cache hit / resume / recompute | **Never** skip auth, lease, version, restore checks (workspace inv. 8) |

### 7.3 TOCTOU

Link-time grant validity does **not** imply admit-time or mutate-time validity. Tests in §17 must include revoke-between-link-and-admit.

---

## §8. Policy linker

### 8.1 Effective authority (closed formula)

```text
effectiveAuthority =
    hostGrants
  ∩ userConstraints
  ∩ projectConstraints
  ∩ invocationConstraints
```

| Algebra | Rule |
|---------|------|
| Denies | **Union** (any layer deny wins) |
| Capabilities / allows | **Intersection** |
| Substitutions | Explicit tables only; **conflict → deny** |
| Catalog discovery | **≠** authority (discovery never auto-grants) |

User/host authority **cannot** be enlarged by project policy (attenuate only).

### 8.2 Ops

`deny` | `substitute` | `attenuate` only (v2).

### 8.3 Empty policy

Still mints BoundPlan with empty-policy snapshot hash.  
Exposure defaults to discovered catalog **filtered by host/user grants**, not “everything goes.”  
Exact default Exposure table: **pin in Policy ADR before linker implementation** (was open; now **pre-impl closed** — see §16).

### 8.4 Unknown fields

Security schemas: **fail closed**. Legacy RunState read: may tolerate unknowns.

### 8.5 Canonicalization

Single canonical JSON + hash (e.g. RFC 8785 JCS) with domain/version prefix — **chosen in Protocol ADR before schema freeze**.

---

## §9. controlMode & ControlHost unity (B5)

```text
auto         = 0.3 ControlHost in taskflowd (start on demand)
coordinated  = same ControlHost; daemon required; fail closed if down
standalone   = same 0.3 ControlHost in-process
```

**Shared by all three:** Compiler, Linker, single scheduler, journal schema, BoundPlan/Fragment, Receipt rules, ResourceEnforcer.

**Only differ:** process boundary + whether multi-client admission lock is cross-process.

### 9.1 auto failure

If daemon cannot be started or reached → **return error**.  
Transition to standalone **only** via explicit user/config request — never implicit.

### 9.2 Dual-writer

0.2 store is **read-only import source** for migration.  
Live authoritative writes require **exclusive project ownership lease**.  
Two writers (old client + daemon, or two daemons) → **fail closed**, not warn-and-continue.  
Optional: isolated new-store path with explicit migration, never mixed dual-active authority.

---

## §10. Legacy evidence import (B4)

| Rule | Requirement |
|------|-------------|
| Type split | `ControlEvent` vs `ExecutionTraceEvent` |
| 0.2 importer | Emits **`LegacyEvidenceImported`** envelopes only |
| Completeness | `completeness: unknown`, `provenance: legacy-trace` |
| Receipts | At most **`legacy-unverified`**; never claim full journal completeness |
| Forbidden | Synthesizing lifecycle facts not present in source; upgrading unknown kinds to real phase-start as authority |

§14 “Importer into journal” means **import as legacy evidence**, not laundering into first-class ControlEvents that look like live 0.3 runs.

---

## §11. ExecutionProvider (compilable sketch)

```ts
interface ExecutionProvider {
  probe(ctx: ProbeContext): Promise<ProviderCapabilities>;
  prepare(req: PrepareRequest): Promise<FulfillmentPlan>;
  submit(req: SubmitRequest): Promise<SubmitResult>;
  watch(req: WatchRequest): AsyncIterable<ProviderEvent>;
  poll(req: PollRequest): Promise<PollResult>;
  cancel(req: CancelRequest): Promise<CancelResult>;
  collect(req: CollectRequest): Promise<BackendResult>;
  reconcile(req: ReconcileRequest): Promise<ReconcileResult>;
}

// All *Result types are discriminated unions, e.g.:
type SubmitResult =
  | { status: "accepted"; handle: ProviderJobHandle }
  | { status: "rejected"; reason: string }
  | { status: "ambiguous"; idempotencyKey: string; hint?: string };
```

`BackendResult` is **evidence for control**, not a Receipt.

---

## §12. Approval protocol (M2)

Replace single-process `requestApproval` as the *only* model with durable requests:

```text
ApprovalRequest {
  approvalRequestId
  runId, nodeInstanceId
  boundPlanHash | boundFragmentHash
  expectedRunVersion          // CAS
  allowedDecisions: approve | reject | edit
  owner / audience
  deadline + timeoutPolicy
}
```

Rules:

- First-writer-wins CAS on decision;  
- Stale `expectedRunVersion` → reject decision;  
- Cancel vs approval: **cancel wins** if both committed (document order: higher seq wins with cancel priority test);  
- **`edit`:**  
  - edit **node output** → no re-link;  
  - edit **plan / obligations** → **must re-Link** (new BoundPlan or BoundFragment) before continue;  
- Survive daemon restart; dual-client concurrent decide tests required.

---

## §13. Replay & cache under ledger (M3)

| Concern | Rule |
|---------|------|
| Offline what-if replay | Consumes **DecisionProjection** derived from **ControlEvent** journal (or explicit decision stream), not raw diagnostics trace as authority |
| Diagnostics trace | Optional aid; not replay authority |
| Cache artifacts | Store **source Receipt id / event range / boundPlan semantic slice** |
| Cache key | Includes BoundPlan/Fragment semantic slice that affects result + inputs |
| Cache hit path | Re-check authority, lease, workspace version; Receipt states **artifact reused, no new Attempt** |
| Legacy | Replay of pure 0.2 trace corpora remains a **compat tool** with legacy-unverified semantics |

---

## §14. Protocol & packages

Unchanged direction: Taskflow RPC core; MCP thin; `taskflow-control` preferred split; hosts = providers.

Tools freeze names; add `taskflow_capabilities`.

---

## §15. Toolchain (informative + ordered)

After green corpus freeze, **step 1.5 Toolchain ADR + green matrix** is mandatory before multi-package control work:

```text
Node LTS baseline + Current in CI
TS7 CLI typecheck / isolate TS6 compiler-API consumers (DSL)
pnpm current major + frozen lockfile
single formatter (no CI-breaking hard-break noise if git diff --check enforced)
clean: install · typecheck · test · build · pack
```

Current trunk debt (Node ≥22.19, pnpm 9, TS7 root vs TS6 DSL) makes step 1 real, not ceremonial.

---

## §16. Pre-implementation closed decisions (were “open”)

Must be pinned in short ADRs **before** schema freeze / parallel implementation:

| ID | Topic | Decision direction |
|----|-------|-------------------|
| **P1** | Policy overlay | Formula in §8.1; deny∪, cap∩, sub conflict→deny |
| **P2** | Empty-policy Exposure | Catalog ∩ host/user grants; still hash BoundPlan |
| **P3** | Journal streams | Per-run stream + control-domain stream; total order per stream; cross-ref by id |
| **P4** | Protocol negotiate | `protocolVersion` + `minCompatible`; reject skew |
| **P5** | Kernel GA feature set | Own **parity matrix** doc: port vs fail-at-link per `kernelUnsupportedReason` row — **block schema freeze until matrix owner assigned** |
| **P6** | Canonical hash | One library, JCS or documented equivalent, versioned domain tags |

Implementation of linker/journal/daemon **blocked** on P3–P5 written down (can be thin ADRs).

---

## §17. Implementation order (normative)

```text
1.  Green trunk + freeze 0.2 golden corpus
1.5 Toolchain ADR + clean matrix (install/typecheck/test/build/pack)
2.  Single execution semantics strangler (+ dynamic fragment hooks designed)
3.  Domain/protocol ADRs (P1–P6) + TypeBox sketches; ControlEvent ≠ TraceEvent
4.  Control application extracted from MCP monolith
5.  Durable journal + ControlStore + legacy evidence importer (not laundering)
6.  On-demand daemon + RPC + ownership lease + cursor subscribe
7.  Linker → BoundPlan/BoundFragment + authority revalidation + admission
8.  ExecutionProvider lifecycle on all hosts + detached
9.  Thin MCP + CLI acceptance
10. WebUI 0.3.1
```

**Parallel multi-package feature work before step 3 is forbidden.**

---

## §18. Compatibility & migration

| Topic | Rule |
|-------|------|
| 0.2 runs/traces | Legacy evidence import only |
| Write path | New authority layout under exclusive lease |
| standalone | Same 0.3 semantics in-process; labeled single-owner |
| Old 0.2 writer + 0.3 daemon | Fail closed on authority conflict |
| Export/rollback | Required |

---

## §19. Open vs closed questions

| # | Topic | Status |
|---|-------|--------|
| Q1 | Five vs six plane teaching | **Closed** — internal six; external Program/Plan/Run/Receipt |
| Q2 | taskflow-control package split | **Lean split**; final at extract time |
| Q3 | Policy file paths | **Open detail**; algebra **closed** (§8.1) |
| Q4 | Empty policy | **Closed direction** (§8.3 / P2) |
| Q5 | Subscribe transport | **Closed** — RPC primary |
| Q6 | Daemon down | **Closed** — fail closed for auto/coordinated |
| Q7 | WebUI | **Closed** — 0.3.1 |
| Q8 | Tool names | **Closed** — freeze |
| Q9 | Project identity | **Closed** |
| Q10 | Single kernel | **Closed** — GA gate |
| Q11 | Journal engine | **Open** behind ControlStore |
| Q12 | Kernel parity set | **Must close before schema freeze** (P5) |
| **Q13** | BoundPlan static vs template+fragment | **Closed — template + BoundFragment chain** |

---

## §20. 0.3 GA acceptance matrix (expanded)

### Core triad

- [ ] No runtime silent dual execution path  
- [ ] BoundPlan immutable; fragments via BoundFragment chain only  
- [ ] Journal rebuild ≡ live projection  

### Dynamic topology

- [ ] `flow{def}` → fragment link + hash chain  
- [ ] `expand:graft` → fragment link + prefix NodeInstances  
- [ ] `ctx_spawn({subflow})` → child Run or BoundFragment under attenuation  
- [ ] map/loop deterministic `nodeInstanceId` without illegal re-link  

### Journal / crash

- [ ] Kill at: intent, post-submit pre-ack, pre-receipt; restart + reconcile  
- [ ] disk-full / fsync failure / torn tail recovery  
- [ ] Non-idempotent provider → unknown, no blind resubmit  

### Authority

- [ ] Revoke grant between link and admit → deny  
- [ ] Revoke mid-run → no new Attempts; cancel / unknown  
- [ ] Cache hit still checks authority/lease/version  

### Policy

- [ ] Project cannot enlarge user authority  
- [ ] Unknown security fields rejected  
- [ ] Substitution conflict denies  

### Approval

- [ ] Dual client decide; stale version; timeout; restart; cancel-vs-approve  

### Multi-writer / modes

- [ ] 0.2 client vs 0.3 daemon same project → fail closed  
- [ ] Dual daemon → fail closed  
- [ ] auto cannot start daemon → error (no silent standalone)  
- [ ] standalone uses same ControlHost semantics  

### Legacy

- [ ] Trace import → LegacyEvidenceImported; legacy-unverified Receipt only  

### Providers / hosts

- [ ] 5 hosts × fg/bg × cancel/resume  
- [ ] RPC version skew rejected  
- [ ] Slow consumer / backpressure on subscribe  

### Cache / replay

- [ ] Artifact tamper detected via hash  
- [ ] DecisionProjection replay matches goldens for gate/budget what-if  
- [ ] Cache hit Receipt documents reuse  

### Property tests

- [ ] Model-based tests for run/attempt state machine vs journal  

---

## §21. Success criteria (product)

- Default client: `controlMode: auto` with shared admission when control runs.  
- Dynamic Taskflow features remain first-class under BoundFragment chains.  
- Visible incremental wedge (why-stale/cache) under plan hashes.  
- CLI proves semantics without WebUI.  
- No laundering of incomplete 0.2 traces into “complete” 0.3 proofs.

---

## §22. Review disposition log

### v1 → v2

Seven blockers absorbed: dual kernel, workspace normative, journal split, auto mode, policy ops, provider lifecycle, caller honesty.

### v2 → v3

| Item | Disposition |
|------|-------------|
| B1 Immutable vs dynamic topology | **Accepted template + BoundFragment chain** (D17, §3.2) |
| B2 Journal before external submit | **Intent/observe/reconcile** (§3.4) |
| B3 Plan as authority bearer | **Grant refs + revalidation** (D19, §7) |
| B4 Trace laundering | **LegacyEvidenceImported only** (§10) |
| B5 standalone dual semantics / dual-writer | **One ControlHost; fail closed** (D18, D20, §9) |
| M1 Run / Job naming | **Run + NodeInstance + Attempt + ProviderJobHandle** (D4) |
| M2 Approval | **Durable approval protocol** (§12) |
| M3 Replay/cache | **DecisionProjection + cache provenance** (§13) |
| M4 Provider TS | **Async interface sketch** (§11) |
| M5 Open-before-impl | **§16 P1–P6 pre-freeze pins** |
| Watershed BoundPlan | **Vote: template + fragment hash chain** (not static DAG; not drop dynamic features) |

---

## §23. Structured re-review template

```text
Verdict: Approve | Approve-with-nits | Request-changes | Reject

Protocol freeze readiness:
  §3 dynamic plan: Ready | Not ready
  §3.4 intent/observe: Ready | Not ready
  §7 authority revalidation: Ready | Not ready
  §9 ControlHost unity: Ready | Not ready
  §10 legacy evidence: Ready | Not ready

May implement now:
  green trunk / toolchain / kernel convergence: Yes | No
  journal schema freeze: Yes | No
  daemon/provider RPC: Yes | No

D17 BoundPlan template+fragment: Agree | Disagree
D18/D20 ControlHost + exclusive write: Agree | Disagree

Top residual risks (≤3)
Nits (section refs, naming)
```

---

## Appendix A — Vocabulary

| Term | Meaning |
|------|---------|
| BoundPlan | Immutable linked **template** |
| BoundFragment | Linked dynamic subgraph + hash chain |
| ControlHost | Shared 0.3 control application (daemon or in-process) |
| ControlEvent | Authoritative journal record |
| ExecutionTraceEvent | Diagnostics / legacy lineage |
| NodeInstance | Concrete node in a Run |
| Attempt | One provider invocation |
| ProviderJobHandle | External provider id |
| PlanFragment | Unlinked generated IR |
| legacy-unverified | Max Receipt tier from 0.2 traces |

## Appendix B — Refusals (stable)

No spectator-only daemon defaults; no dual silent runtimes; no backend-minted Receipts; no project privilege escalation; no trace-as-proof laundering; no exactly-once marketing; no dropping dynamic topology to fake static BoundPlans.

---

*End RFC v3. Safe work now: §17 steps 1–1.5–2 and write P5 parity matrix. Do not freeze ControlEvent schema or multi-package daemon/provider work until re-review marks protocol sections Ready.*
