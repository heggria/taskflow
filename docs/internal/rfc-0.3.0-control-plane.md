# RFC: taskflow 0.3.0 — Coding-Agent Control Plane

> **Status (split):**
>
> | Layer | Verdict |
> |-------|---------|
> | **Top-level architecture (planes, triad, controlMode, ControlHost, D17 template+fragment)** | **Approved** |
> | **Protocol freeze (ControlEvent / RPC / BoundPlan wire schema)** | **Not frozen** — Draft v4 closes remaining protocol Blockers; re-review for freeze |
>
> **Date:** 2026-07-22 · **v4** after third review  
> **Branch:** `feat/0.3.0`  
> **May start now:** §18 steps **1, 1.5, 2** (green trunk, toolchain, single-scheduler convergence) + write P-ADRs.  
> **Must wait for protocol freeze:** journal schema impl, daemon/provider RPC, multi-package parallel feature work.  
> **v4 watershed:** **0.3 GA must not fail-at-link any 0.2.4-supported, test-covered semantic** solely because a kernel port is unfinished. Fail-at-link is a **dev-only** bridge, not a GA exit.

**Related**

| Doc | Role |
|-----|------|
| [`competitive-map-2026-h2.md`](./competitive-map-2026-h2.md) | Category positioning |
| [`rfc-local-daemon.md`](./rfc-local-daemon.md) | Daemon non-negotiables |
| [`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md) | Normative resource/security model |
| [`rfc-background-run.md`](./rfc-background-run.md) | Detached = provider strategy |
| [`../rfc-0.2.0-architecture.md`](../rfc-0.2.0-architecture.md) | Kernel strangler context |
| [`../0.2.0-north-star.md`](../0.2.0-north-star.md) | compiled · resumable · incremental · replayable-for-what-if |
| `packages/taskflow-core/src/exec/kernel-policy.ts` | Gap inventory (must become parity matrix, not GA delete list) |
| `packages/taskflow-core/src/resources/backend.ts` | PreparedSandboxPlan / ResourceEnforcer |

---

## TL;DR

1. **Architecture is approved.** Soul remains: single execution semantics + BoundPlan/BoundFragment + durable journal. Default `controlMode: auto`. One ControlHost for auto/coordinated/standalone.

2. **BoundPlan** is an immutable **instantiable template**; dynamic topology uses **BoundFragment hash chains** (D17 accepted).

3. **Protocol not frozen until** this v4 set is accepted:
   - complete dynamic-path inventory (saved `use`, flat spawn, cache re-link, expand nested/graft);
   - **single physical journal** with global `commitSeq`;
   - authority enforcement **tiers** (not only attempt-start checks);
   - **0.2.4 parity contract** (no GA fail-at-link for supported features).

4. **Safe work now:** green trunk, toolchain ADR, golden corpus, scheduler convergence, P-ADRs.  
   **Unsafe work now:** ControlEvent schema freeze, journal importer as authority, multi-package daemon/provider race.

5. **Receipt assurance** is multi-dimensional (journal / provider / artifacts / provenance / guaranteeTier), not a single enum.

**Re-review form:** §22. Focus: protocol freeze readiness.

---

## §0. Motivation (stable, approved)

0.3 is a Coding-Agent Control Plane around the 0.2 kernel wedge — not a session multiplexer, org-chart OS, or Conductor clone.

**Product sentence:**

> Taskflow links programs under policy and capabilities into immutable BoundPlans/BoundFragments, executes them with one semantic kernel on heterogeneous providers, and records a durable journal from which runs, receipts, and replays are derived.

**Forbidden:** dual silent runtimes; spectator-only daemon defaults; laundering incomplete 0.2 traces into complete proofs; shipping a “metamorphosis” that **removes** tested 0.2.4 user capabilities at GA.

---

## §1. Architecture decisions (ADR)

| ID | Decision | Choice | Freeze? |
|----|----------|--------|---------|
| **D1** | Role | CACP | Arch ✓ |
| **D2** | Kernel | Single scheduler; legacy as executors only | Arch ✓ |
| **D3** | Planes | Intent · Compile · Link · Control · Exec · Ledger (+ Trace diagnostics) | Arch ✓ |
| **D4** | Entities | Program, BoundPlan, BoundFragment, Run, NodeInstance, Attempt, ProviderJobHandle, ControlEvent, Receipt (+ SpawnTemplate) | Protocol open |
| **D5** | controlMode | `auto` default; coordinated fail-closed; standalone explicit | Arch ✓ |
| **D6** | Authority store | Single physical journal; projections/receipts derived; Trace diagnostic | Protocol open |
| **D7** | Project identity | **`projectId` (stable UUID)** + **`directoryBinding`** (path+device+inode) | Protocol open |
| **D8** | Northbound | Thin MCP + CLI over Taskflow RPC | Arch ✓ |
| **D9** | Southbound | Async ExecutionProvider lifecycle; control mints Receipt | Protocol open |
| **D10** | Policy ops | deny / substitute / attenuate | Arch ✓ |
| **D11** | Sandbox honesty | Fail closed | Arch ✓ |
| **D12** | Migration | read-old/write-new; backup; tiered rollback (§19) | Protocol open |
| **D13** | Scope | L1–L2 + BoundPlan/Fragment v1 + journal v1 + Receipt v1 | Arch ✓ |
| **D14** | Resources | Workspace capability RFC normative | Arch ✓ |
| **D15** | Caller | OS principal; labels non-authoritative alone | Arch ✓ |
| **D16** | Delivery | at-least-once + idempotent submit + reconcile | Arch ✓ |
| **D17** | Dynamic plan | Template + BoundFragment chain | Arch ✓ |
| **D18** | ControlHost | Same 0.3 host in all modes | Arch ✓ |
| **D19** | Plan authority | Grant refs + revalidation; not bearer tokens | Protocol open |
| **D20** | Exclusive write | 0.3 stops self on conflict; cannot kill legacy writers | Protocol open |
| **D21** | 0.2.4 parity | **GA must preserve tested 0.2.4 semantics**; fail-at-link dev-only | **Arch + GA ✓** |
| **D22** | Journal topology | **One physical log, global `commitSeq`;** run/control are logical streams | Protocol open |
| **D23** | Enforcement tier | resolve-only / brokered-write / sandboxed-session | Protocol open |

---

## §2. Planes (approved)

```text
INTENT → COMPILE → LINK → CONTROL → EXEC → LEDGER
                      ↑                │
                      └── BoundFragment (dynamic generation)
```

---

## §3. Domain model (protocol — v4)

### 3.1 Entities

```text
Program / FlowIR
BoundPlan              immutable template (+ embedded SpawnTemplates, saved-flow pins)
Run                    first-class execution (projectId-scoped)
NodeInstance           phase | map item | loop iter | graft node | flat-spawn child …
BoundFragment          linked dynamic subgraph
Attempt                one provider invocation
ProviderJobHandle      external id
ControlEvent           journal record
Receipt                derived evidence package
```

Do not overload durable **Job**; use ProviderJobHandle for remote ids.

### 3.2 BoundPlan = immutable instantiable template (approved)

Parent plan bytes never mutate. Execution is either:

- deterministic **NodeInstance** of a template node, or  
- a **BoundFragment** after Compile+Link under attenuated parent authority.

#### 3.2.1 Dynamic / delayed-binding inventory (complete for freeze)

| Path | Rule |
|------|------|
| `flow { def }` (inline model IR) | PlanFragment → BoundFragment chain |
| `expand` **nested** | Same — runtime IR must Link (not only graft) |
| `expand:graft` | BoundFragment then promote NodeInstances under prefix |
| `ctx_spawn({ subflow })` | Child Run and/or BoundFragment; attenuate only |
| **Saved `flow` `use`** | **Pin at root Link** (default): resolve loader → store child `irHash` + `boundPlanHash` (or equivalent pin) on BoundPlan. **Admit/execute must not re-resolve a mutable same-name flow.** Optional late-bind is **only** via explicit BoundFragment path, never silent re-load |
| **Flat `ctx_spawn({ task, agent, … })`** | Constrained by BoundPlan **`SpawnTemplate`** (below). In-ceiling → NodeInstance; out-of-ceiling → BoundFragment or **deny** |
| `map` / `loop` / `tournament` items | Deterministic `nodeInstanceId` when obligations already bound; else fragment or deny |

#### 3.2.2 SpawnTemplate (flat spawn)

BoundPlan may include:

```text
SpawnTemplate {
  allowedAgentClasses
  allowedProviderClasses
  toolCeiling / effectCeiling
  maxChildren
  maxDepth
  budgetShare
}
```

Flat spawn that changes agent/model/provider/tools/effects beyond the template **must not** execute as a bare NodeInstance.

#### 3.2.3 Cached / resumed dynamic fragments

**Forbidden:** restore grafted/dynamic **NodeInstance state** from cache without re-validation (today’s “restore promotedPhases on cache hit” is not 0.3-legal as authority).

Cache **may** store:

- original PlanFragment artifact;  
- original `boundFragmentHash`;  
- source Receipt / event range;  
- output artifacts.

**Reuse path:**

```text
Load fragment artifact
  → re-Link / validate under current policy + authorityEpoch + resource baseline
  → new BoundFragment
  → only if new boundFragmentHash is equivalent (defined semantic equality) to allowed cache key,
     instantiate outputs without new provider work
  → else re-execute or deny
```

#### 3.2.4 Hash chain (fragments)

```text
parentBoundPlanHash
parentBoundFragmentHash?
sourceEventSeq
fragmentIRHash
fragmentPolicyHash
capabilitySetHash
authorityEpoch
boundFragmentHash
```

Saved-flow pins:

```text
savedFlowRef { name, irHash, boundPlanHash, contentAddress }
```

### 3.3 Run / Attempt machines (approved shape)

Run: `Received → Compiled → Linked → Queued → Admitted → Running ⇄ FragmentLinked* → Terminal`

Attempt dispatch (intent vs observe):

```text
AttemptPrepared
  → DispatchIntentRecorded  (+ durability)
  → provider.submit(idempotencyKey)
  → DispatchAcknowledged | rejected | ambiguous
  → ProviderProgress*       (observation only)
  → terminal after collect/reconcile
```

Crash windows and `idempotencyLevel` / `reconcileLevel` as in v3 (retained).

**Idempotency key** is derived from **stable Attempt identity** (runId, nodeInstanceId, attemptNo, boundPlan/Fragment hash) — **never** regenerated on retry.

### 3.4 Receipt assurance (multi-dimensional)

Replace single `completeness` enum with:

```text
assurance {
  journalContinuity: complete | partial | unknown
  providerOutcome:   confirmed | ambiguous | unknown
  artifactIntegrity: verified | partial | unknown
  provenance:        native-v1 | legacy-trace
  guaranteeTier:     resolve-only | brokered-write | sandboxed-session | …
}
```

A run can have `journalContinuity: complete` and still `providerOutcome: unknown`.

---

## §4. Single execution semantics + **0.2.4 parity** (D21)

### 4.1 One scheduler

No silent imperative↔kernel fork at GA. Dev may use temporary bridges; GA ships one semantic path.

### 4.2 Parity contract (watershed — **accepted: no GA fail-at-link for 0.2.4**)

> **All 0.2.4-supported semantics that have test coverage must remain behavior-compatible on the single scheduler at 0.3 GA.**  
> Removal requires an **explicit breaking-change ADR**, migration note, and version policy.  
> **Fail-at-link** is allowed **only in development** for features not yet ported — **not** as a GA exit for product features.

Implications:

- P5 parity matrix is a **port checklist**, not a delete list.  
- ControlEvent schema must reserve kinds for score, cache, ctx_spawn, workspace, approval, etc., **before** freeze.  
- “Incremental / dynamic wedge” cannot be sacrificed to ship daemon chrome.

### 4.3 Kernel gap inventory

Current `kernelUnsupportedReason` rows become **owned port tasks** with owners and GA blockers. None of the 0.2.4 product features in that list are eligible for “just fail-at-link at GA” without breaking-change process.

---

## §5. Resource model (normative workspace RFC)

Unchanged: attenuate-only nesting; intent before mutation; dirty-unknown; cache cannot skip auth/lease/version; sandbox fail-closed.

---

## §6. Journal architecture (protocol — B2)

### 6.1 Topology — **single physical journal** (D22 preferred)

**Normative choice for freeze:**

> **One physical append log** with global monotonic **`commitSeq`**.  
> `streamId` (e.g. `control`, `run:<runId>`) is a **logical** partition; records still share one commit order.

Rejected as default: dual independent streams without atomic cross-stream commit (creates “quota taken / run not admitted” splits).

**Minimum envelope:**

```text
eventId
schemaVersion
streamId
streamSeq              // per logical stream
commitSeq              // global, subscription cursor
commandId              // unique → command idempotency
causationId
correlationId
recordedAt
payload
```

Rules:

- unique index on `commandId`;  
- CAS via `expectedStreamSeq` / fencing as needed;  
- RPC returns **accepted only after durable commit** (fsync policy for the class of event);  
- subscription cursors use **`commitSeq`**;  
- alternative (same-txn multi-record or single-authority-stream) only with ADR — default is global commitSeq.

### 6.2 Layers

| Layer | Name |
|-------|------|
| Authority | ControlEvent journal |
| Projections | RunState, indexes |
| Diagnostics | ExecutionTraceEvent |
| Derived | Receipt |

### 6.3 Legacy import

`LegacyEvidenceImported` only; `assurance.provenance: legacy-trace`; never synthesize missing lifecycle facts. Max Receipt tier: legacy-unverified-equivalent under multi-dim assurance.

### 6.4 ControlStore

Port abstraction; sqlite-or-files behind it; not on network FS if WAL; fault injection required before freeze of storage ADR.

---

## §7. Authority revalidation & enforcement tiers (B3)

### 7.1 Plan is evidence, not bearer

Grant refs + epochs; revalidate at admit; revocation blocks **new** Attempts.

### 7.2 Enforcement granularity (D23)

| `guaranteeTier` | Meaning | Revocation / check granularity |
|-----------------|---------|--------------------------------|
| **resolve-only** | Path containment at resolve; **no** FS containment claim | Admission-time checks; **no** claim of mid-attempt containment |
| **brokered-write** | Every Taskflow-brokered mutation checks permit/fence/version | Per mutation via ResourceEnforcer |
| **sandboxed-session** | Sealed plan / PreparedSandboxPlan activates for Attempt; process constrained | Attempt lifetime under sealed plan; **revocation latency / expiry recorded**; cancel of live process is **best-effort**, not proof all side effects stopped |

**Normative:** “Before each mutating Attempt” is **necessary but not sufficient** for brokered-write and sandboxed tiers. Wire to existing PreparedSandboxPlan / WorkspaceExecutionBackend concepts.

Cache/resume/recompute: never skip auth, lease, version, restore (workspace inv. 8).

---

## §8. Policy linker (approved algebra)

```text
effectiveAuthority =
  hostGrants ∩ userConstraints ∩ projectConstraints ∩ invocationConstraints
```

Denies union; capabilities intersection; substitution conflict → deny; catalog ≠ authority; project cannot enlarge user/host grants.

Ops: deny / substitute / attenuate.

Unknown security fields: fail closed. Canonical hash: single library + versioned domain tags (Protocol ADR).

---

## §9. ControlHost modes (approved)

```text
auto         = ControlHost in taskflowd (on-demand); fail if cannot start
coordinated  = same; daemon required
standalone   = same ControlHost in-process
```

Same compiler, linker, scheduler, journal schema, plans, receipts, enforcer.

### 9.1 Dual-writer / legacy 0.2 process (M4 — honest fail-closed)

0.3 **cannot stop** an old binary from writing disks it still knows about.

**Required 0.3 behavior:**

1. New authority store **isolated** from 0.2 paths where possible;  
2. Monitor legacy generation / mtime / hash after import;  
3. If legacy writes after import → project state **`legacy-conflict`**;  
4. **0.3 control stops new Attempts** and demands explicit reconcile/re-import;  
5. Do not claim “we prevented the old client from writing.”

---

## §10. Project identity (M1)

```text
projectId          // stable random UUID in user-private store
directoryBinding   // { canonicalPath, device, inode, … }
```

- **projectId** is the long-term namespace.  
- **directoryBinding** detects path swap / move / reclone.  
- **Explicit rebind** attaches a new directoryBinding to the same projectId after verification.

---

## §11. ExecutionProvider (async sketch)

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

type SubmitResult =
  | { status: "accepted"; handle: ProviderJobHandle }
  | { status: "rejected"; reason: string }
  | { status: "ambiguous"; idempotencyKey: string; hint?: string };
```

---

## §12. Approval state machine (M2 — deterministic)

```text
ApprovalRequest {
  approvalRequestId, runId, nodeInstanceId,
  boundPlanHash | boundFragmentHash,
  expectedRunVersion, allowedDecisions,
  owner/audience, deadline, timeoutPolicy
}
```

**Rules:**

1. Journal serializes all decisions (CAS on `expectedRunVersion`).  
2. If **`CancelRequested` commits first** → later `ApprovalDecision` CAS **fails**.  
3. If **`ApprovalDecision` commits first** → pause clears; a **later** `CancelRequested` may still cancel the Run.  
4. Concurrent decisions at same version → first commit wins; loser fails.  
5. **Timeout default = reject** (never default approve).  
6. **`edit` output** → no re-link; **`edit` plan/obligations** → re-Link required.  
7. Survive control restart; dual-client tests required.

---

## §13. Replay & cache

- What-if replay consumes **DecisionProjection** from ControlEvents (not diagnostics-as-authority).  
- Cache stores fragment artifacts + hashes + source Receipt/event range; re-Link/validate on hit (§3.2.3).  
- Cache-hit Receipt: `providerOutcome` reflects reuse; no new Attempt when valid.

---

## §14. Protocol negotiation (M3)

Not only `version + minCompatible`:

```text
protocolMajor
supportedReadSchemas[]
supportedWriteSchemas[]
requiredFeatures[]
offeredFeatures[]
buildInfo
```

Reject when required features missing or write schema unsupported. Asymmetric read/write supported explicitly.

---

## §15. Packages (approved direction)

```text
taskflow-core / taskflow-control / taskflow-daemon
taskflow-mcp-core (thin) / taskflow-hosts / taskflow-cli
taskflow-web (0.3.1+)
```

MCP ≠ internal protocol. Tools freeze names; add `taskflow_capabilities`.

---

## §16. Toolchain (informative + ordered)

Step **1.5** after green corpus:

- Node LTS baseline + Current CI  
- TS7 CLI / isolate TS6 compiler-API (DSL)  
- pnpm current + frozen lockfile  
- single formatter; avoid CI-breaking hard-break noise if `git diff --check` enforced  
- clean install / typecheck / test / build / pack  

---

## §17. Pre-freeze gate (schema freeze checklist)

Protocol freeze requires **all** of:

| Gate | Content |
|------|---------|
| P1 | Policy overlay algebra (§8) |
| P2 | Empty-policy Exposure |
| P3 | **Single physical journal + commitSeq** (§6) |
| P4 | Negotiation fields (§14) |
| P5 | **Parity matrix** as port list under **D21** (no GA delete-by-link) |
| P6 | Canonical hash library |
| P7 | Saved flow pin + SpawnTemplate + cache re-link semantics (§3.2) |
| P8 | Enforcement tiers (§7) |
| P9 | Legacy-conflict detection (§9.1) |
| P10 | Rollback tiers (§19) |

Until then: **no** ControlEvent schema freeze, **no** multi-package daemon/provider implementation race.

---

## §18. Implementation order

```text
1.   Green trunk + freeze 0.2.4 golden corpus (parity oracle)
1.5  Toolchain ADR + clean matrix
2.   Single scheduler convergence (ports driven by P5/D21)
2.5  Write P1–P10 ADRs (thin, normative)
3.   Protocol freeze re-review → then TypeBox ControlEvent + BoundPlan wire types
4.   Extract ControlHost from MCP monolith
5.   ControlStore + journal + legacy evidence importer
6.   Daemon + RPC + ownership + subscribe(commitSeq)
7.   Linker (BoundPlan/Fragment, SpawnTemplate, saved pins) + admission
8.   ExecutionProvider on all hosts + detached
9.   Thin MCP + CLI
10.  WebUI 0.3.1
```

**Allowed in parallel today:** 1, 1.5, 2, 2.5 only.

---

## §19. Compatibility, migration, rollback (M5)

| Mode | Promise |
|------|---------|
| Pre-migration backup restore | Full restore to pre-0.3 bits |
| Rollback with **no** 0.3 authority writes yet | Full rollback OK |
| After 0.3 runs exist | **Read-only export** of 0.3 data; **lossy** 0.2-shaped export **without** continue-execution promise |
| BoundFragment / ControlEvent → 0.2 RunState | **Not** lossless; do not claim round-trip execute |

Importer: legacy evidence only (§6.3).

---

## §20. GA acceptance (expanded; tests live here)

### Architecture / triad

- [ ] Single scheduler; no silent dual path  
- [ ] controlMode auto/coordinated/standalone = one ControlHost  
- [ ] Journal rebuild ≡ projection  

### Dynamic / delayed bind

- [ ] flow{def}, expand nested, expand graft, ctx_spawn subflow  
- [ ] **saved use pinned at link; no mutable re-resolve**  
- [ ] **flat spawn within SpawnTemplate / fragment / deny**  
- [ ] **cache hit re-Links fragment; no blind promotedPhases restore**  

### Journal

- [ ] Global commitSeq; RPC accept after durable commit  
- [ ] Cross-claim admit (budget+run) atomic w.r.t. commitSeq  
- [ ] Kill windows: intent / post-submit pre-ack / pre-receipt  
- [ ] disk-full, fsync fail, torn tail  

### Authority

- [ ] revoke between link and admit  
- [ ] brokered mutation checks; sandboxed sealed plan tests  
- [ ] revocation does not over-claim live process stop  

### Parity

- [ ] **Every 0.2.4 golden still passes under 0.3 ControlHost**  
- [ ] No GA fail-at-link for covered features without breaking ADR  

### Approval / multi-writer / legacy

- [ ] Approval CAS / cancel-first / timeout=reject  
- [ ] legacy-conflict stops 0.3 Attempts  
- [ ] dual daemon fail closed  

### Receipt / cache / replay

- [ ] Multi-dim assurance correctness  
- [ ] DecisionProjection what-if goldens  
- [ ] Cache provenance + revalidation  

### Negotiation / identity

- [ ] Feature/schema negotiation rejects skew  
- [ ] projectId stable across rebind; binding swap detected  

---

## §21. Product success

- Default auto admission path when control can run.  
- Dynamic + incremental wedges intact at GA (D21).  
- CLI acceptance without WebUI.  
- Honest unknown/dirty-unknown and legacy-conflict.  
- Competitive story: compile · link · admit · journal · recompute/replay.

---

## §22. Structured re-review (protocol freeze)

```text
Verdict: Approve-architecture (already) | Approve-protocol-freeze | Request-changes | Reject

Protocol freeze sections:
  §3.2 dynamic inventory (saved use, flat spawn, cache): Ready | Not ready
  §6 journal commitSeq model: Ready | Not ready
  §7 enforcement tiers: Ready | Not ready
  §4 / D21 parity contract: Ready | Not ready

May start:
  steps 1–2.5: Yes (architecture approved)
  journal schema + daemon RPC: only if protocol freeze Approved

D21 no GA fail-at-link for 0.2.4: Agree | Disagree
D22 single physical journal: Agree | Disagree
D23 enforcement tiers: Agree | Disagree

Residual risks (≤3)
Nits
```

---

## §23. Review disposition log

| Version | Outcome |
|---------|---------|
| v1 | Request changes (soul = daemon risk) |
| v2 | Request changes (triad strong; protocol weak) |
| v3 | Architecture line crossed; protocol still open |
| **v4** | **Architecture Approved**; protocol Blockers B1–B4 addressed for freeze review |

### v4 closes (protocol draft)

| Item | Disposition |
|------|-------------|
| Saved `flow use` | Pin at root Link; no mutable re-resolve |
| Flat ctx_spawn | SpawnTemplate ceiling |
| Cached dynamic fragment | Re-Link/validate; no blind phase restore |
| expand:nested | Explicit dynamic path |
| Dual stream atomicity | Single physical journal + commitSeq |
| Receipt completeness | Multi-dim assurance |
| Authority mid-attempt | Enforcement tiers + sealed plan |
| P5 fail-at-link at GA | **Forbidden for 0.2.4 covered features (D21)** |
| projectId | UUID + directoryBinding |
| Approval cancel | Deterministic state machine |
| Negotiation | schemas + features |
| Dual-writer | 0.3 stops self; legacy-conflict |
| Rollback | Tiered promises |

---

## Appendix A — Vocabulary

| Term | Meaning |
|------|---------|
| ControlHost | Shared 0.3 control application |
| BoundPlan | Immutable template |
| BoundFragment | Linked dynamic subgraph |
| SpawnTemplate | Ceiling for flat ctx_spawn |
| commitSeq | Global journal order / cursor |
| projectId | Stable UUID namespace |
| directoryBinding | Path+device+inode evidence |
| guaranteeTier | resolve-only / brokered-write / sandboxed-session |
| legacy-conflict | Post-import legacy write detected |
| D21 | 0.2.4 parity at GA |

## Appendix B — Refusals

No GA capability regression by fail-at-link; no trace laundering; no dual silent runtimes; no silent standalone fallback; no claim to preempt foreign 0.2 writers; no lossless 0.3→0.2 execute rollback fiction; no fully static BoundPlan that deletes dynamic Taskflow.

---

*End RFC v4. Architecture approved. Protocol freeze pending §22. Execute §18.1–2.5 immediately; hold schema/RPC multi-package work.*
