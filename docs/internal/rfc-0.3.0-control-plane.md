# RFC: taskflow 0.3.0 — Coding-Agent Control Plane

> **Document version:** **v6 (self-contained normative)**  
> **Branch:** `feat/0.3.0`  
> **Date:** 2026-07-22  
>
> | Layer | Status |
> |-------|--------|
> | Architecture | **Approved** |
> | Protocol model | **Approved with v6 pins** (ControlDomain lifecycle, Command batch, dual hashes, Artifact/Secret, D21 public surface) |
> | Wire / schema freeze | **Not frozen** until P-ADR set + TypeBox review |
> | Implementation allowed now | **§22 steps 1–2.5 only** |
>
> **This document is self-contained.** Implementers must not require Git history of v1–v5. Prior drafts are historical only.
>
> **Supersession (normative):** Where this RFC conflicts with older docs, **this RFC wins for 0.3+ clients**:
>
> | Older doc | Still true | **Superseded for 0.3 clients** |
> |-----------|------------|--------------------------------|
> | [`rfc-local-daemon.md`](./rfc-local-daemon.md) | Disk authority; UDS+auth; version handshake; one admission authority when claimed; no network by default | “Default off”; “stdio always remains full-power alternative”; graceful **silent** degrade to full in-process on outage |
> | [`competitive-map-2026-h2.md`](./competitive-map-2026-h2.md) | Category wedge; disk authority; local auth | “Default-off / degrade without daemon” as non-negotiable for 0.3 |
>
> Older docs remain valid for **0.2.x process-less** product line and historical intent. They are **not** non-negotiable constraints on 0.3 ControlHost behavior.
>
> **Related (normative dependencies, not copy-paste):**
> [`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md), [`rfc-background-run.md`](./rfc-background-run.md), [`../rfc-0.2.0-architecture.md`](../rfc-0.2.0-architecture.md), [`../0.2.0-north-star.md`](../0.2.0-north-star.md).

---

## §0. TL;DR

1. **Product:** Coding-Agent Control Plane (CACP).  
   Story: `Program → BoundPlan → Run → Receipt`.

2. **Soul:** (1) single execution semantics, (2) immutable BoundPlan/BoundFragment after Link, (3) durable journal as authority.

3. **0.3 clients default `controlMode: auto`** (on-demand user-level control).  
   Failure to start/reach control → **error** (no silent full-power standalone).  
   `standalone` is **explicit** 0.2-compat mode using the **same** ControlHost semantics in-process.

4. **ControlDomain** is a **persistent** ledger identity (not per process). One `projectId` binds to **one** domain at a time. Mode changes require **DomainTransfer**, not silent moves.

5. **CommandRecord** + multi-event **atomic commit batches** per command; `commandId` unique on commands only.

6. **D21:** all **publicly supported** 0.2.4 semantics stay compatible at GA; fail-at-link is dev-only.

7. **Toolchain (0.3 engineering baseline):** Node **≥22.19** production; **TypeScript 6** unified; **pnpm 11** stable.

8. **Start now:** green trunk, public-surface goldens, toolchain ADR, single scheduler, P-ADRs.  
   **Hold:** wire freeze, multi-package daemon/RPC race.

---

## §1. Product sentence & non-goals

> Taskflow links programs under policy and capabilities into immutable BoundPlans/BoundFragments, executes them with one semantic kernel on heterogeneous providers, and records a durable journal (per ControlDomain) from which runs, receipts, and replays are derived.

**Non-goals:** multi-cluster k8s; Temporal exactly-once marketing; Squad session TUI; Paperclip org OS; Conductor feature race; silent dual runtimes; laundering 0.2 traces into complete proofs; GA capability regression by fail-at-link.

---

## §2. Architecture decisions (complete ADR table)

| ID | Decision | Normative choice |
|----|----------|------------------|
| **D1** | Role | CACP — programs for real coding agents |
| **D2** | Kernel | Single scheduler/state machine; legacy phase code only as executors |
| **D3** | Planes | Intent · Compile · Link · Control · Exec · Ledger (+ diagnostic Trace) |
| **D4** | Durable entities | ControlDomain, CommandRecord, Program/FlowIR, BoundPlan, BoundFragment, SpawnTemplate, Run, NodeInstance, Attempt, ProviderJobHandle, ControlEvent, ArtifactRef, SecretRef, Receipt |
| **D5** | controlMode | **`auto` default** for 0.3 clients; `coordinated` fail-closed; `standalone` explicit |
| **D6** | Authority | Control journal (in ControlDomain) is authority; RunState/index projections; Receipt derived; Trace diagnostic |
| **D7** | Project | `projectId` (UUID) + `directoryBinding` (path+device+inode); explicit rebind |
| **D8** | Northbound | Thin MCP + CLI over Taskflow RPC; tool **names** stable |
| **D9** | Southbound | Async ExecutionProvider lifecycle; control mints Receipts |
| **D10** | Policy ops | deny \| substitute \| attenuate only |
| **D11** | Sandbox honesty | Unsupported enforcement → fail closed |
| **D12** | Store migration | read-old/write-new; backup; tiered rollback (§20) |
| **D13** | 0.3 scope | ControlHost + BoundPlan/Fragment v1 + journal v1 + Receipt v1 + CLI; WebUI 0.3.1 |
| **D14** | Resources | [`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md) **normative** |
| **D15** | Caller | OS principal + optional adapter credential; `mcp:*` label non-authoritative alone |
| **D16** | Delivery | at-least-once + idempotent submit + reconcile; unknown/dirty-unknown allowed |
| **D17** | Dynamic plan | Immutable template BoundPlan + BoundFragment hash chains |
| **D18** | ControlHost unity | auto/coordinated/standalone share **same** ControlHost semantics |
| **D19** | Plan authority | Grant refs + epochs; revalidate; plan ≠ bearer token |
| **D20** | Dual write | 0.3 stops **itself** on conflict; cannot preempt foreign 0.2 binaries |
| **D21** | Parity | **Public 0.2.4 surface** compatible at GA; tests prove, not bound, compatibility |
| **D22** | Journal | One physical log **per ControlDomain**; logical streams; domain-global `commitSeq` |
| **D23** | Enforcement | Orthogonal capabilities (resolution / mutationMediation / processIsolation / revocation) |
| **D24** | Commands | CommandRecord unique; events N:1; atomic command batch |
| **D25** | Cache | `boundFragmentHash` (audit) + `executionSemanticHash` (reuse) |
| **D26** | Blobs | ArtifactRef for content; **SecretRef** (no content digest) for credentials |
| **D27** | Domain lifecycle | Persistent ControlDomainId; one project→domain binding; explicit DomainTransfer |
| **D28** | Toolchain | Node ≥22.19; TypeScript 6; pnpm 11 |

---

## §3. Planes

```text
INTENT → COMPILE → LINK → CONTROL → EXEC → LEDGER
                      │                │
                      │                └── ArtifactStore / SecretStore
                      └── BoundFragment under parent authority
```

Northbound (MCP/CLI/Web) → Control only.  
Exec workers are untrusted relative to Control.  
Ledger is durable; daemon memory is not authority.

---

## §4. controlMode (normative product behavior)

| Mode | Behavior |
|------|----------|
| **`auto` (default 0.3 client)** | Connect to user-level control service; **start on demand** if configured; share domain admission. If control cannot start or handshake fails → **return error**. **No** silent fallback to full standalone power. |
| **`coordinated`** | Control required; fail closed if unavailable. |
| **`standalone`** | Explicit opt-in. Same ControlHost **in-process**, typically **single-project ControlDomain** after exclusive ownership. **Must not claim** cross-project domain admission or multi-client coordination. |

**Durability on outage:** control crash must **not corrupt or hide** already-journaled runs (disk authority). New work under `auto`/`coordinated` fails closed until control returns; projections rebuild from journal.

**0.2.x clients** remain process-less until upgraded; they are not “0.3 auto”.

---

## §5. ControlDomain lifecycle (D27)

### 5.1 Identity

```text
ControlDomainId    // persistent UUID (or content-stable id), NOT process pid/boot id
projectId          // persistent UUID in user-private store
directoryBinding   // { canonicalPath, device, inode, … }
projectDomainBinding { projectId, controlDomainId, fencingEpoch, boundAt }
```

- **ControlDomainId survives daemon restart.** A new process opens the **same** domain store.  
- **A projectId binds to at most one ControlDomainId at a time.**  
- Daemon **hosts one default user ControlDomain** and may host additional domains only via explicit config; it does **not** mint a new domain id per boot.

### 5.2 Mode defaults

| Mode | Domain |
|------|--------|
| auto / coordinated | Default **user ControlDomain**; projects partitioned by `projectId` on records |
| standalone | Obtain exclusive ownership → attach project to a **single-project domain** **or** to the user domain under exclusive project lease (implementation picks one in ControlStore ADR; must not fork history) |

### 5.3 DomainTransfer (mode change / move)

Silent migration of a project between domains is **forbidden**.

Required protocol:

```text
DomainTransfer {
  projectId
  sourceControlDomainId
  targetControlDomainId
  fencingEpoch++ on source binding
  sourceCheckpoint { commitSeq, projectionDigest }
  sourceReceiptRange / export ArtifactRefs
  status: prepared | committed | aborted
}
```

Rules:

1. Fence source: no new Attempts on source after prepare.  
2. Export checkpoint + required artifacts to target.  
3. Commit target binding; source marks project **transferred**.  
4. Failure → abort; project remains on source or `transfer-failed` requiring operator reconcile.  
5. Receipts remain valid via digests/ArtifactRefs; `commitSeq` is **per-domain** (cite `controlDomainId` + `commitSeq` in cross-domain references).

### 5.4 commitSeq scope

`commitSeq` is totally ordered **within one ControlDomain only**.  
No atomic cross-domain admission.

---

## §6. Durable entities (normative)

### 6.1 Program / FlowIR

Portable program. Sources: JSON Taskflow, `.tf.ts`.  
`OutputContract` / `expect` keep existing names (no rival top-level “Contract” type).

### 6.2 BoundPlan (immutable template)

Link(Program, PolicySnapshot, CapabilitySnapshot, AuthorityGrantRefs) → BoundPlan.

Never mutated after mint. Execution uses only BoundPlan + BoundFragments + NodeInstances.

**Minimum fields:**

```text
sourceHash, irHash, policyHash, capabilitySetHash, boundPlanHash
template node bindings (provider/model/tools/effects ceilings)
SpawnTemplate? (flat spawn ceilings)
savedFlowPins[] { name, irHash, boundPlanHash, contentAddress }
grantRefs[] { issuer, grantId, version/epoch, scope, expiry? }
workspaceBaselineRequirements
budgetClaims, concurrencyClaims
redactionProfile
enforcementCapabilities
dynamicPolicy { allowFragmentKinds, maxFragmentDepth, maxFragmentNodes }
```

**Normative:** BoundPlan is **decision evidence**, not an irrevocable authority bearer. Revalidate grants at admit and per enforcement capability (§14).

### 6.3 BoundFragment

Dynamic IR after Compile+Link under **attenuated** parent authority.

```text
parentBoundPlanHash
parentBoundFragmentHash?
sourceEventId
sourceCommitSeq
fragmentIRHash
fragmentPolicyHash
capabilitySetHash
authorityEpoch
boundFragmentHash          // full audit identity
executionSemanticHash      // output-determining identity (§11)
```

### 6.4 Run / NodeInstance / Attempt / ProviderJobHandle

| Entity | Meaning |
|--------|---------|
| **Run** | One execution of a root BoundPlan (first-class; maps to today’s run grain) |
| **NodeInstance** | Concrete node (phase, map item, loop iter, graft node, flat-spawn child, …) |
| **Attempt** | One provider invocation for a NodeInstance |
| **ProviderJobHandle** | External provider id |

**Run states:**  
`Received → Compiled → Linked → Queued → Admitted → Running ⇄ FragmentLinked* → Terminal`  
Terminal: success | failed | cancelled | blocked | budget-blocked | unknown.

**Attempt dispatch (intent vs observation):**

```text
AttemptPrepared
  → DispatchIntentRecorded   // durable intent BEFORE provider side effect
  → provider.submit(idempotencyKey)
  → DispatchAcknowledged | rejected | ambiguous
  → ProviderProgress*        // observations only
  → collect/reconcile
  → AttemptTerminal
```

| Crash window | Recovery |
|--------------|----------|
| After intent, before call | Retry submit with **same** idempotency key |
| After accept, before local ack | reconcile(handle \| key) |
| No idempotency/query | `unknown`; workspace may be `dirty-unknown` |
| Handle known, terminal unknown | watch/poll/reconcile then unknown |

**Idempotency key** = stable function of  
`(controlDomainId, runId, nodeInstanceId, attemptNo, boundPlanHash|boundFragmentHash)` — never regenerated on retry.

Provider caps: `idempotencyLevel: none|best-effort|strong`, `reconcileLevel: none|handle-only|idempotency-key|full`.  
`none` → no auto-resubmit after ambiguous crash.

### 6.5 Receipt

Control-issued only:

```text
Receipt {
  controlDomainId, runId, …
  boundPlanHash | boundFragmentHash
  eventRange { startCommitSeq, endCommitSeq } or embedded decision digests
  artifactRefs[]
  assurance { … §12 }
  buildInfo
}
```

Proves **recorded and confirmed** facts under plan snapshot — not omniscient external truth.

---

## §7. Dynamic / delayed-binding inventory (complete)

| Path | Rule |
|------|------|
| `flow { def }` | PlanFragment → BoundFragment chain |
| `expand` **nested** | Must Link (not only graft) |
| `expand:graft` | BoundFragment then promote NodeInstances under prefix |
| `ctx_spawn({ subflow })` | Child Run and/or BoundFragment; attenuate only |
| **Saved `flow` `use`** | **Pin at root Link**: child `irHash` + `boundPlanHash` (content address). Admit/execute **must not** re-resolve a mutable same-name flow. Late-bind only via explicit BoundFragment |
| **Flat `ctx_spawn({ task, agent, … })`** | Within BoundPlan **SpawnTemplate** → NodeInstance; else BoundFragment or **deny** |
| map / loop / tournament items | Deterministic `nodeInstanceId` if obligations already bound; else fragment or deny |

**SpawnTemplate:**

```text
allowedAgentClasses, allowedProviderClasses
toolCeiling / effectCeiling
maxChildren, maxDepth, budgetShare
```

**Cache of dynamic fragments:** store PlanFragment ArtifactRef, both hashes, source event range, output ArtifactRefs.  
**Forbidden:** blind restore of promoted phase maps as authority.  
**Reuse:** §11 predicate after re-Link/validate under current policy/authority/baseline.

---

## §8. CommandRecord & atomic batches (D24)

### 8.1 CommandRecord (authority ledger component)

CommandRecord lives **in the same ControlDomain store as ControlEvents**. It is part of the **authority ledger**, not a disposable cache. Projections may index it; rebuild must restore command idempotency.

```text
CommandRecord {
  commandId                 // UNIQUE per ControlDomain
  requestHash
  callerPrincipal           // OS uid / adapter credential id
  authorizationContextHash  // policy/capability/grant epoch snapshot used
  projectId?
  controlDomainId
  status                    // accepted | rejected | failed | …
  firstCommitSeq
  lastCommitSeq
  responseArtifactRef?      // ArtifactRef only after durable blob
  recordedAt
}
```

### 8.2 ControlEvent envelope

```text
ControlEvent {
  eventId, schemaVersion
  controlDomainId
  streamId, streamSeq
  commitSeq                 // domain-global
  commandId?                // NON-UNIQUE FK
  commandEventIndex?        // 0..n within command batch
  causationId, correlationId
  projectId?
  recordedAt
  payload                   // small; refs for large data
}
```

### 8.3 Atomic commit batch

One accepted command that produces multiple events **must**:

1. Write/fsync **response Artifact** (if any) via rename-durable protocol **before** commit references it;  
2. In **one atomic transaction**: insert/update CommandRecord + append all ControlEvents with contiguous `commitSeq` allocation;  
3. Only then return RPC `accepted` with `commandId` + `lastCommitSeq`.

**Orphan Artifacts** (blob written, txn aborted) → GC-eligible; **must never** appear as accepted CommandRecord refs.

### 8.4 Idempotent RPC

| Case | Result |
|------|--------|
| Same commandId + same requestHash + **same callerPrincipal** (or equivalent delegated auth) | Return original response |
| Same commandId + same requestHash + **different principal** | **Authorize deny** (no cross-principal replay) |
| Same commandId + different requestHash | `TF_IDEMPOTENCY_CONFLICT` |
| Failed with no durable accept | Retry rules per error `recoveryAction` |

---

## §9. Journal, cursor, compaction

### 9.1 Topology

One physical append log per ControlDomain. Logical `streamId` (`control`, `run:<id>`, …). Domain-global `commitSeq`.

### 9.2 Layers

| Layer | Type |
|-------|------|
| Authority | ControlEvent + CommandRecord |
| Projections | RunState, indexes, live UI |
| Diagnostics | ExecutionTraceEvent (today’s TraceEvent lineage) |
| Derived | Receipt |

**Do not** use `Event = TraceEvent & {v}` upgrade path as Control Journal write or laundering importer.  
0.2 import → `LegacyEvidenceImported` only; `assurance.provenance: legacy-trace`.

### 9.3 Cursor protocol

```text
minAvailableCommitSeq     // domain watermark after compaction
cursorLease { cursorId, holder, ttl, commitSeq }
```

- Subscribe uses `commitSeq`.  
- Cursor behind `minAvailableCommitSeq` → `TF_CURSOR_EXPIRED`; client must **resync** from checkpoint/snapshot.  
- Live cursor lease/TTL; expired lease does not block compaction past leased seq if lease dead.  
- Offline clients **must** handle `TF_CURSOR_EXPIRED` (v5 gap closed).

### 9.4 Compaction (before ControlStore freeze)

ADR must define: projection checkpoint; rebuild = checkpoint+tail or genesis; compaction preconditions; Receipt embeds digests for compacted spans; artifact TTL independent; missing blob → `artifactIntegrity: unknown`; distinct unavailable vs integrity-failure.

### 9.5 Fsync points (minimum)

DispatchIntentRecorded; DispatchAcknowledged; Attempt/Run terminal; CancelRequested; lease/permit before mutation; **Command batch commit**.

---

## §10. ArtifactRef & SecretRef

### 10.1 ArtifactRef

```text
ArtifactRef {
  digest, size, mediaType
  storageClass        // local-blob | …
  redactionClass      // none | redact-on-export
}
```

Large outputs, PlanFragments, command responses → ArtifactStore.  
Journal holds refs, not megabyte payloads.

### 10.2 SecretRef (not content-hash artifacts)

```text
SecretRef {
  secretId            // opaque
  issuer / keyring
  // NO content digest of the secret material
}
```

**Forbidden:** storing raw credentials in journal or general ArtifactStore under `secret-never-journal` with a **content digest** (equality/oracle leak).  
Low-entropy secrets must not be digests for equality checks.

---

## §11. executionSemanticHash (precise)

### 11.1 boundFragmentHash

Full link **audit** identity: IR + policy + capabilities + authority epoch/refs + all link decisions + resource baseline pins + …

### 11.2 executionSemanticHash

Identity of factors that determine **computational outputs**. Must include **resolved execution descriptor**, not mere “class” labels unless an explicit equivalence contract says class is enough:

```text
resolved model id + revision/digest when available
sampling / reasoning effort / temperature / seed policy
system prompt / rules digest (agent body)
tool schema versions + allow/deny set
runner + event-parser buildInfo (host runner version)
task/input digests + OutputContract
fragment IR semantic body
resource-read versions / content digests declared as inputs
// authority epoch alone does NOT enter executionSemanticHash
```

**Class folding** only when a published **equivalence contract** states that two concrete descriptors are interchangeable for cache (rare; default is concrete descriptor).

### 11.3 Cache reuse predicate

```text
reuse_allowed iff
  authority valid for required grants
  AND lease / workspace version valid
  AND executionSemanticHash equal
  AND source ArtifactRef integrity verified
  AND output contract compatible
  AND re-Link/validate under current policy does not deny
```

---

## §12. Receipt assurance

```text
assurance {
  journalContinuity: complete | partial | unknown
  providerOutcome:   confirmed | ambiguous | unknown
  artifactIntegrity: verified | partial | unknown
  provenance:        native-v1 | legacy-trace
  enforcement: {
    resolution: contained | unbound
    mutationMediation: none | brokered
    processIsolation: none | sandboxed
    revocation: admission-only | per-mutation | bounded-latency
  }
}
```

---

## §13. Policy linker

```text
effectiveAuthority =
  hostGrants ∩ userConstraints ∩ projectConstraints ∩ invocationConstraints
```

- Denies: **union**  
- Capabilities: **intersection**  
- Substitution conflict: **deny**  
- Catalog discovery **≠** authority  
- Project cannot enlarge user/host grants  
- Ops: **deny | substitute | attenuate** only  
- Security schemas: unknown fields **fail closed**  
- Canonical JSON hash (e.g. JCS) with domain/version prefix — single library  

Empty policy still mints BoundPlan hash; Exposure = discovered catalog **∩** host/user grants.

---

## §14. Authority revalidation & enforcement

**Revalidate:** admit (run/fragment); per enforcement capability during execution; on revocation block **new** Attempts; cancel in-flight best-effort; cache/resume/recompute never skip auth/lease/version/restore ([workspace RFC](./rfc-workspace-capabilities.md) inv. 8).

| Capability | Meaning |
|------------|---------|
| resolution=contained | Canonical path within authorized roots |
| mutationMediation=brokered | Every Taskflow-brokered mutation checks permit/fence/version |
| processIsolation=sandboxed | Sealed plan / PreparedSandboxPlan for Attempt |
| revocation=… | admission-only \| per-mutation \| bounded-latency (record latency; no over-claim) |

Profiles (resolve-only / brokered-write / sandboxed-session) are **aliases** of capability sets; sandboxed may **also** use brokered writes.

---

## §15. ExecutionProvider

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

`BackendResult` is evidence; **not** a Receipt.

---

## §16. Approval state machine

```text
ApprovalRequest {
  approvalRequestId, runId, nodeInstanceId
  boundPlanHash | boundFragmentHash
  expectedRunVersion
  allowedDecisions: approve | reject | edit
  owner/audience, deadline, timeoutPolicy
}
```

1. Journal serializes; CAS on `expectedRunVersion`.  
2. **CancelRequested first** → later ApprovalDecision fails CAS.  
3. **Approval first** → pause clears; later CancelRequested may still cancel Run.  
4. Same version race → first commit wins.  
5. **Timeout → reject** (never default approve).  
6. edit **output** → no re-link; edit **plan** → re-Link required.  
7. Survive control restart; dual-client tests required.

---

## §17. Protocol negotiation & errors

```text
protocolMajor
supportedReadSchemas[]
supportedWriteSchemas[]
requiredFeatures[]
offeredFeatures[]
buildInfo
```

### Error object

```text
{
  code: "TF_…",
  message: string,
  recoveryAction: retry-same-command | retry-new-command | refresh
                | reconcile | operator | none,
  sideEffects: none | possible | unknown,
  commandId?, commitSeq?, controlDomainId?
}
```

| Code | recoveryAction (typical) | sideEffects |
|------|--------------------------|-------------|
| TF_PROTOCOL_INCOMPATIBLE | none | none |
| TF_SCHEMA_READ_UNSUPPORTED | none | none |
| TF_SCHEMA_WRITE_UNSUPPORTED | none | none |
| TF_FEATURE_REQUIRED | none | none |
| TF_POLICY_DENIED | none | none |
| TF_AUTHORITY_REVOKED | operator / refresh | possible |
| TF_STALE_VERSION | refresh | none if pure CAS |
| TF_IDEMPOTENCY_CONFLICT | none | none |
| TF_LEGACY_CONFLICT | operator | prior legacy possible |
| TF_PROVIDER_AMBIGUOUS | reconcile | possible |
| TF_PROVIDER_REJECTED | retry-new-command or none | none if pre-accept |
| TF_JOURNAL_UNAVAILABLE | retry-same-command | none if pre-intent |
| TF_DURABILITY_FAILED | operator / reconcile | unknown |
| TF_CURSOR_EXPIRED | refresh (checkpoint resync) | none |
| TF_COMMAND_FAILED | retry-new-command if no accept | none if no accept |
| TF_DOMAIN_TRANSFER_REQUIRED | operator | none |
| TF_CROSS_PRINCIPAL_COMMAND | none | none |

Boolean `retryable` alone is **insufficient**; clients use **`recoveryAction`**.

---

## §18. Single execution semantics & D21 parity

### 18.1 One scheduler

No silent imperative↔event-kernel fork at GA. Dev bridges allowed; GA one semantic path.

### 18.2 D21 (public surface)

> All **documented or publicly supported** 0.2.4 semantics remain compatible at 0.3 GA.  
> Step 1 converts public surface → comprehensive golden corpus.  
> Sources: TypeBox/schema, README/skills/docs, examples, public exports, tests, promised error behavior.  
> Removal requires breaking-change ADR + migration + version policy.  
> Fail-at-link = **dev-only**, not GA exit.

### 18.3 P5 matrix

```text
rows:    all PHASE_TYPES (incl. race, expand)
columns: when | join:any | retry | timeout | expect | budget | cache
         cwd | workspace | shareContext | dynamic def | saved use
         resume | recompute | replay | approval | cancel/abort
         foreground | detached | idempotent:false
         final-output attribution
         score | onBlock:retry | reflexion | tree reduce
         map/loop/tournament instantiation
```

**High-risk ternary suites (minimum):**  
`expand × cache × authority epoch`  
`detached × approval × resume`  
(+ add as matrix risk rows)

Cell values: `port | n/a | breaking-ADR`.

---

## §19. Replay & cache

- What-if replay: **DecisionProjection** from ControlEvents (not diagnostics-as-authority).  
- Cache entries store both hashes, ArtifactRefs, event range.  
- Cache-hit Receipt: providerOutcome reflects reuse; no new Attempt when valid.  
- Legacy 0.2 pure-trace replay: compat tool with legacy provenance only.

---

## §20. Compatibility, dual-writer, rollback

| Topic | Rule |
|-------|------|
| 0.2 traces/runs | LegacyEvidenceImported only |
| 0.2 live writer | Detect generation/mtime/hash; **`legacy-conflict`**; 0.3 stops new Attempts; **cannot** stop old binary |
| Dual 0.3 writers | Exclusive ownership lease; fail closed |
| Rollback pre-0.3 writes | Full from backup |
| Rollback after 0.3 runs | Read-only export; **lossy** 0.2-shaped export **without** continue-execute promise |
| DomainTransfer | §5.3 |

---

## §21. Packages & toolchain (D28)

### 21.1 Packages

```text
taskflow-core          # kernel, resources, journal ports, single scheduler
taskflow-control       # ControlHost application (preferred split)
taskflow-daemon        # process + RPC
taskflow-mcp-core      # thin MCP adapter only
taskflow-hosts         # ExecutionProviders
taskflow-cli           # 0.3.0 acceptance
taskflow-web           # 0.3.1+
{host}-taskflow        # skills + thin bins
```

`core ↛ daemon/mcp/web`.

### 21.2 Toolchain baseline (engineering, ordered in step 1.5)

| Item | Baseline |
|------|----------|
| **Node** | **`>=22.19.0`** production engines; CI may also run newer Current for early warning — **production baseline remains 22 LTS line** until a separate ADR raises it |
| **TypeScript** | **Unify on TypeScript 6** for CLI typecheck **and** compiler-API consumers (DSL). Do not leave root on TS 7 while DSL needs TS 6 API without isolation — **prefer one TS 6 monorepo** for 0.3 |
| **pnpm** | **Upgrade `packageManager` from 9.15.0 to pnpm 11.x stable**; frozen lockfile; script allowlist |
| Format | Single formatter; avoid CI-breaking hard-break trailing spaces if `git diff --check` enforced |
| Matrix | clean install · typecheck · test · build · pack |

---

## §22. Implementation order

```text
1.   Green trunk
1.a  Public 0.2.4 surface inventory → golden corpus
1.5  Toolchain: Node 22 baseline confirmed, TS 6 unify, pnpm 11
2.   Single scheduler convergence (P5-driven ports)
2.5  P-ADRs (P1–P12) encoding this RFC
3.   Wire freeze review → TypeBox
4.   Extract ControlHost from MCP monolith
5.   ControlStore + ArtifactStore + SecretStore + journal
6.   Daemon + RPC + domain open/transfer
7.   Linker + admission + SpawnTemplate + saved pins
8.   ExecutionProviders all hosts + detached
9.   Thin MCP + CLI
10.  WebUI 0.3.1
```

**Allowed now: 1–2.5 only.**

---

## §23. Pre-wire-freeze checklist

| ID | Content |
|----|---------|
| P1 | Policy overlay algebra |
| P2 | Empty-policy Exposure |
| P3 | ControlDomain + persistent id + project binding + DomainTransfer |
| P4 | Negotiation + error taxonomy + recoveryAction |
| P5 | Full phase × feature matrix + ternary suites |
| P6 | Canonical hash + ArtifactRef + SecretRef |
| P7 | Dynamic paths + dual hashes + cache predicate |
| P8 | Enforcement capabilities |
| P9 | legacy-conflict |
| P10 | Rollback tiers |
| P11 | Compaction, minAvailableCommitSeq, cursor lease |
| P12 | Command batch atomicity + principal-scoped idempotency |

---

## §24. GA acceptance matrix (self-contained)

### Kernel / ControlHost

- [ ] Single scheduler; no silent dual path  
- [ ] auto/coordinated/standalone = same ControlHost semantics  
- [ ] auto control failure → error (no silent standalone)  
- [ ] Journal rebuild ≡ projection  

### ControlDomain

- [ ] DomainId stable across restart  
- [ ] projectId single binding; dual binding rejected  
- [ ] DomainTransfer fencing + failure recovery  
- [ ] commitSeq not compared across domains without domain id  

### Commands

- [ ] Multi-event one commandId; unique on CommandRecord only  
- [ ] Atomic batch; no dangling Artifact refs on accept  
- [ ] Same id+hash+principal → same response  
- [ ] Cross-principal same id denied  

### Dynamic

- [ ] flow{def}, expand nested/graft, ctx_spawn subflow  
- [ ] saved use pin; no mutable re-resolve  
- [ ] flat spawn SpawnTemplate  
- [ ] cache re-Link; executionSemanticHash reuse after epoch change when predicate holds  

### Authority / enforcement

- [ ] revoke link→admit; brokered per mutation; sandboxed sealed plan  
- [ ] no over-claim of process kill  

### Parity

- [ ] Public-surface goldens pass  
- [ ] No GA fail-at-link without breaking ADR  
- [ ] Ternary suites green  

### Journal / cursor / artifacts

- [ ] Kill windows intent/ack/receipt  
- [ ] TF_CURSOR_EXPIRED + resync  
- [ ] SecretRef no content digest  
- [ ] Compaction preserves Receipt rules  

### Approval / multi-writer / legacy

- [ ] Approval CAS / cancel-first / timeout=reject  
- [ ] legacy-conflict stops 0.3  
- [ ] dual daemon fail closed  

### Providers / negotiation

- [ ] 5 hosts × fg/bg × cancel/resume  
- [ ] Feature/schema negotiate rejects skew  
- [ ] recoveryAction respected by CLI/MCP  

### Replay / cache

- [ ] DecisionProjection what-if  
- [ ] Artifact tamper detection  

---

## §25. Supersession notice (copy for related docs)

**For 0.3.0+ ControlHost clients, `rfc-0.3.0-control-plane.md` supersedes:**

- daemon “default-off” as product default;  
- silent graceful degrade to full in-process on daemon outage;  
- any reading of “per-project namespace” that forbids user-level ControlDomain partitioning of projects.

**Retained from local-daemon RFC:** disk authority; UDS+token; version handshake; one admission authority when claimed; no default network listener; daemon must not be sole copy of run state (journal on disk).

---

## §26. Structured re-review

```text
Verdict: Approve-wire-freeze | Request-changes | Reject

Self-contained: Yes | No
Supersession vs local-daemon clear: Yes | No

ControlDomain lifecycle: Ready | Not ready
Command atomic batch + principal: Ready | Not ready
executionSemanticHash specificity: Ready | Not ready
SecretRef: Ready | Not ready
recoveryAction + cursor TTL: Ready | Not ready
D21 public surface: Ready | Not ready
Toolchain D28: Ready | Not ready

Implement 1–2.5: Yes
Wire freeze: only if all Ready + P5/P11/P12 ADRs exist
```

---

## Appendix A — Vocabulary

| Term | Meaning |
|------|---------|
| ControlDomain | Persistent ledger + admission total order |
| CommandRecord | Authority command row; unique commandId |
| BoundPlan | Immutable linked template |
| BoundFragment | Linked dynamic subgraph |
| executionSemanticHash | Output-determining resolved descriptor hash |
| ArtifactRef | Content-addressed blob ref |
| SecretRef | Opaque credential ref without content digest |
| ControlHost | Shared 0.3 control application |
| DomainTransfer | Explicit project move between domains |
| recoveryAction | Client recovery enum (not bare bool) |
| Public surface | Documented/supported 0.2.4 behavior set |

## Appendix B — Refusals

No “see v4” normative references; no silent domain re-mint per boot; no silent domain migration on mode switch; no unique commandId per event; no secret content digests; no GA fail-at-link for public 0.2.4 features; no cross-domain atomic admission; no dual silent runtimes.

---

*End RFC v6 — self-contained. Architecture Approved. Protocol model pinned. Wire freeze after P-ADRs. Implement §22.1–2.5 now.*
