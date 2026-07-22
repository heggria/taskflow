# RFC: taskflow 0.3.0 — Coding-Agent Control Plane

> **Document version:** **v7.1** (doc-alignment + global budget stats, RunStatus/Stage, P-ADR gate, P15)
> **Branch:** `feat/0.3.0`
> **Date:** 2026-07-22
> **Approver action:** Architecture + 0.3 protocol model **approved** for Steps 1–2.5.
> **Wire/schema freeze:** still **not** approved until P-ADRs land concrete TypeBox.
>
> | Layer | Status |
> |-------|--------|
> | Architecture | **Approved** |
> | 0.3 protocol model (domains, commands, modes, parity) | **Approved** (this version) |
> | Wire / TypeBox freeze | **Not yet** |
> | Implementation now | **§22 steps 1–2.5** |
> | DomainTransfer / merged user journal | **Out of 0.3** (deferred) |
>
> **Self-contained:** implementers need not read v1–v6 history.
> **Supersession:** for 0.3+ ControlHost clients this RFC wins over conflicting bullets in
> [`rfc-local-daemon.md`](./rfc-local-daemon.md) and [`competitive-map-2026-h2.md`](./competitive-map-2026-h2.md)
> (see §25). Those files’ 0.2.x history is labeled **Historical**.

**Normative dependencies:**
[`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md) ·
[`rfc-background-run.md`](./rfc-background-run.md) ·
[`../rfc-0.2.0-architecture.md`](../rfc-0.2.0-architecture.md) ·
[`../0.2.0-north-star.md`](../0.2.0-north-star.md)

---

## §0. TL;DR (approved)

1. **Product:** Coding-Agent Control Plane.
   `Program → BoundPlan → Run → Receipt`.

2. **Soul:** single execution semantics · immutable BoundPlan/BoundFragment · durable per-project journal.

3. **Ledger model for 0.3 (product decision — accepted):**
   - **One ControlDomain + ControlStore per project** (project-local authority ledger).
   - **User-level ControlRegistry** (non-authoritative): maps `projectId → domain location`, mount status, optional aggregates.
   - **taskflowd mounts many project domains**; it does **not** merge project histories into one user journal in 0.3.
   - **No DomainTransfer in 0.3 GA.** First registration fixes the project’s ControlDomain; mode changes **change the process (clerk), not the ledger**.

4. **`controlMode: auto` default** for 0.3 clients with a **fresh-install bootstrap contract** (§5). No silent full-power fallback.

5. **D21:** publicly supported 0.2.4 semantics stay compatible at GA.

6. **Toolchain (D28):** Node **≥22.19** production; **TypeScript 7** monorepo CLI; **taskflow-dsl** isolated on **TS 6 compiler API**; **pnpm 11**.

7. **Start now:** green trunk, public-surface goldens, toolchain, single scheduler, P-ADRs.
   **Hold:** wire freeze, DomainTransfer, multi-package RPC feature race.

---

## §1. Product sentence & non-goals

> Taskflow links programs under policy and capabilities into immutable BoundPlans/BoundFragments, executes them with one semantic kernel on heterogeneous providers, and records a durable **per-project** journal from which runs, receipts, and replays are derived. A user-level daemon **mounts** many project ledgers and provides a unified console—not a merged total ledger.

**Non-goals (0.3):** DomainTransfer; physical merge of project journals; multi-cluster; exactly-once marketing; Squad/Paperclip clones; silent dual runtimes; GA capability regression; ControlStore on `node:sqlite` without dedicated P-ADR.

---

## §2. Human model (normative narrative)

| Concept | Plain language |
|---------|----------------|
| **ControlDomain** | The **jurisdiction**: one project’s sole authority for command order, Run state, approvals, recovery. |
| **ControlStore** | The **official ledger** on disk for that domain (commands, events, projections, idempotency, receipt refs). Memory and process speech are not truth. |
| **ControlRegistry** (user-level) | A **directory of ledgers**: where each project’s domain lives, mount health, rebuildable indexes. **Not** a second authority for run mutations. |
| **taskflowd / standalone** | The **clerk**: process that opens ledgers and schedules work. Swap clerks freely; **do not swap ledgers** in 0.3. |
| **Receipt** | Signed evidence package derived from the ledger. |

```text
Codex / Pi / CLI / Claude
        │ commands
        ▼
standalone clerk  OR  taskflowd (multi-mount clerk)
        │
        ▼
ControlRegistry (user) ──► open project ControlStore (authority)
        │
        ▼
ExecutionProvider (agent / script)
```

**Daily multi-project needs** (list runs, search, approval inbox, global concurrency, budget totals) are solved by **registry + aggregation + scheduler leases**, not by merging Git-style histories into one repo.

---

## §3. Architecture decisions (complete)

| ID | Choice |
|----|--------|
| **D1** | CACP |
| **D2** | Single scheduler; legacy phase code as executors only |
| **D3** | Planes: Intent · Compile · Link · Control · Exec · Ledger (+ diagnostic Trace) |
| **D4** | Entities: ControlDomain, ControlRegistry, CommandRecord, Program/FlowIR, BoundPlan, BoundFragment, SpawnTemplate, Run, NodeInstance, Attempt, ProviderJobHandle, ControlEvent, ArtifactRef, SecretRef, Receipt |
| **D5** | `controlMode`: **auto** default; coordinated fail-closed; standalone explicit |
| **D6** | Authority = **project ControlStore journal**; registry non-authoritative |
| **D7** | `projectId` UUID + `directoryBinding`; rebind binding only, not domain id (0.3) |
| **D8** | Thin MCP + CLI; stable tool names |
| **D9** | Async ExecutionProvider; control mints Receipts |
| **D10** | Policy: deny \| substitute \| attenuate |
| **D11** | Unsupported sandbox fail closed |
| **D12** | Migration: read-old/write-new; tiered rollback; **no DomainTransfer** |
| **D13** | 0.3 ships ControlHost + journal + BoundPlan/Fragment + CLI; WebUI 0.3.1 |
| **D14** | Workspace capability RFC normative |
| **D15** | OS principal + optional adapter credential; `mcp:*` label alone weak |
| **D16** | at-least-once + idempotent submit + reconcile |
| **D17** | BoundPlan template + BoundFragment chains |
| **D18** | One ControlHost semantics in all modes |
| **D19** | Grant refs + revalidation; plan ≠ bearer |
| **D20** | Dual-write: 0.3 stops self; cannot kill foreign 0.2 writers |
| **D21** | Public 0.2.4 surface compatible at GA |
| **D22** | One physical journal **per project ControlDomain**; `commitSeq` per domain |
| **D23** | Orthogonal enforcement capabilities |
| **D24** | CommandRecord in same atomic batch as events; principal-scoped replay **with re-auth** |
| **D25** | boundFragmentHash (audit) + executionSemanticHash (reuse) |
| **D26** | ArtifactRef content digests; SecretRef **no** content digest |
| **D27** | **Per-project domain fixed at first registration; no DomainTransfer in 0.3** |
| **D28** | Node ≥22.19; **TS 7** workspace; **DSL TS 6 API isolated**; pnpm 11 |
| **D29** | User **ControlRegistry** for multi-project mount/aggregate |
| **D30** | **Global concurrency (0.3):** strong only under the user-level **singleton coordinator** (daemon/embedded). **Global budget (0.3):** Receipt **aggregation / statistics only** — not a hard cross-project admission gate. Cross-project hard budget deferred. |
| **D31** | **RunStatus** vs **RunStage** are distinct fields (§8) |
| **D32** | Embedded multi-mount supervisor must use the **same user singleton lock + endpoint** as taskflowd |

---

## §4. ControlDomain, ControlStore, ControlRegistry

### 4.1 Per-project ControlDomain (0.3 default — frozen)

- First successful project control registration creates:
  - `projectId` (stable UUID in user-private store)
  - `ControlDomainId` (stable UUID, **equals or 1:1 with project’s ledger identity**)
  - on-disk **ControlStore** under the project control path (exact path in ControlStore ADR)
  - `directoryBinding` for swap/move detection
- **ControlDomainId does not change** on daemon restart, standalone↔daemon, or client upgrade.
- **No second domain** for the same projectId in 0.3.

### 4.2 ControlStore (authority)

Records at least: CommandRecords, ControlEvents, Run projections, approval state, idempotency, receipt metadata, artifact/secret refs, recovery cursors.

**Process speech is not truth; committed ControlStore records are.**

Storage engine: **port only**. **Do not** default to `node:sqlite` without a dedicated P-ADR covering stability, txn, concurrency, upgrade (Node API stability note). File/log backend is acceptable for 0.3.

### 4.3 ControlRegistry (user-level, non-authoritative for project Runs)

```text
ControlRegistry
├── projectId → { controlDomainId, storePath, directoryBinding, mountState, summary? }
└── rebuildable indexes (run list, open approvals) — derived, not project-run authority
```

- taskflowd **mounts** each project store listed in the registry.
- Mutating project commands always commit to the **project** ControlStore.
- Global run list / search / approval inbox = **aggregate views**.

#### 4.3.1 Registry loss / rebuild (P3 must implement)

- Every **ControlStore header** persists `{ projectId, controlDomainId, schemaVersion, directoryBinding evidence }`.
- If Registry is lost: **on next open** of a project path, re-register from store header (no invention of run state).
- Optional full-disk discovery only if **explicit discovery roots** are configured (not implicit whole home crawl by default).
- **clone / copy / worktree / move** policy (P3):
  - **move** same inode evidence after rebind → same projectId when rebind succeeds;
  - **copy/clone** → **new projectId** (new domain) unless explicit “adopt identity” operator command;
  - **git worktree** → new binding; default **new projectId** (avoid two worktrees sharing one live journal without exclusive lease).

#### 4.3.2 UserCoordinatorStore (narrow authority — not a project total ledger)

For **global concurrency** under multi-mount control only:

```text
UserCoordinatorStore (user-private, small)
├── daemon / embedded supervisor lease + fencing epoch
├── concurrency reservations (lease records)
└── optional budget *reservations* only if a future ADR enables hard global budget
```

- Does **not** store project Run history, CommandRecords, or Receipts for projects.
- **0.3 global budget:** aggregate Receipts for **statistics/UI only**; project-level `budget` on BoundPlan remains enforced **inside that project’s ControlStore**.
- Strong cross-project budget gate = **post-0.3**.

### 4.4 DomainTransfer — **out of 0.3**

**Deferred to 0.3.1+** (or never, if registry model suffices).

Rationale: daily multi-project needs do not require merging ledgers; transfer has dual-commit crash windows and is a cross-store transaction.
**0.3 rule:** change the clerk (standalone ↔ daemon), **keep the same project ControlStore**.

If a future product requires “two projects, one atomic admission Receipt,” design a **separate coordinator domain** later—do not swallow project histories.

### 4.5 Cross-project features without merge

| Need | 0.3 mechanism |
|------|----------------|
| Unified dashboard | Registry + aggregate index |
| Global concurrency | **UserCoordinatorStore** leases under singleton multi-mount control; strong only when that coordinator is active |
| Global budget | **Statistics only** (aggregate Receipts); not hard admission across projects |
| Cross-project workflow | Coordinator Run with **references** to child run ids (best-effort; not one atomic dual-ledger txn in 0.3) |
| Unified approvals | Inbox of **refs**; decisions write back to home project store |

---

## §5. controlMode & fresh-install bootstrap

| Mode | Behavior |
|------|----------|
| **auto (default)** | Ensure user registry + project ControlStore; start or attach the **user singleton multi-mount control** (taskflowd **or** embedded supervisor that competes for the **same** lock/endpoint — D32); fail closed if control cannot run |
| **coordinated** | External control required; fail closed if down |
| **standalone** | Explicit. In-process ControlHost opens **the same project ControlStore**; single-owner lease; **no** global concurrency claims across projects |

**Silent fallback from auto → full standalone is forbidden.** Only explicit `controlMode: standalone`.

### 5.1 Embedded multi-mount supervisor (not a forked auto)

If a host package embeds a multi-mount supervisor instead of spawning an external `taskflowd` binary:

1. It **must** compete for the **same user-level singleton lock** and **same coordination endpoint** (UDS path / pipe name) as the standalone `taskflowd`.
2. Losers **attach as clients** to the winner — they must **not** each become an independent multi-mount authority.
3. Wire protocol, fencing epoch, and UserCoordinatorStore path are **identical** to external daemon.
4. Failing the lock and then running “local multi-mount alone” is **forbidden** (that is silent fork).

### 5.2 Fresh-install / upgrade contract (GA must pass)

1. **Bundled control binary** path documented (`taskflowd` / host package bin).
2. First `taskflow_run` (or CLI equivalent) with defaults: creates registry entry + project ControlStore if missing, starts/attaches singleton control, completes one run **without manual daemon config**.
3. **Concurrent client start:** single-instance lock / socket acquire; losers attach to winner (no dual writers).
4. **Stale socket:** detect dead peer (pid/lock), remove socket, restart.
5. **Version skew:** handshake rejects incompatible client/daemon; upgrade path documented (restart daemon from matching package).
6. **Platforms:** Unix UDS required for 0.3 GA; **Windows named pipe** supported **or** Windows explicitly **non-GA** in release notes (choose in bootstrap P-ADR; default proposal: UDS primary, Windows pipe in same ADR before GA).
7. Outage must not corrupt journal; new admits fail until control returns.

---

## §6. Planes

```text
INTENT → COMPILE → LINK → CONTROL → EXEC → LEDGER (per-project ControlStore)
                      │                │
                      │                └── ArtifactStore / SecretStore (scoped)
                      └── BoundFragment
```

---

## §7. BoundPlan, BoundFragment, dynamic paths

### 7.1 BoundPlan (immutable template)

Link → BoundPlan. Never mutated. Holds template bindings, SpawnTemplate, savedFlowPins, grantRefs, claims, enforcement capabilities, dynamicPolicy.

**Evidence not bearer:** revalidate grants at admit and per enforcement rules.

### 7.2 BoundFragment

Dynamic IR after Compile+Link under attenuated parent authority.

```text
parentBoundPlanHash, parentBoundFragmentHash?
sourceEventId, sourceCommitSeq
fragmentIRHash, fragmentPolicyHash, capabilitySetHash, authorityEpoch
boundFragmentHash, executionSemanticHash
```

### 7.3 Dynamic inventory

| Path | Rule |
|------|------|
| flow{def}, expand nested, expand graft, ctx_spawn subflow | BoundFragment chain |
| saved flow use | Pin irHash/boundPlanHash at root Link; no mutable re-resolve |
| flat ctx_spawn | SpawnTemplate ceiling → NodeInstance; else fragment or deny |
| map/loop/tournament items | Deterministic nodeInstanceId if obligations bound |

**Cache:** store fragment ArtifactRef, both hashes, event range, outputs. Re-Link/validate; reuse only if §11 predicate holds. No blind promotedPhases restore.

### 7.4 SpawnTemplate

allowedAgentClasses, allowedProviderClasses, tool/effect ceilings, maxChildren, maxDepth, budgetShare.

---

## §8. RunStatus, RunStage, Attempt machines

### 8.1 Two orthogonal fields (D31 — frozen)

```text
RunStatus = running | completed | failed | paused | blocked | cancelled | unknown
RunStage  = received | compiled | linked | queued | admitted | executing | terminal
```

| Field | Meaning |
|-------|---------|
| **RunStatus** | User-visible / API lifecycle (maps to 0.2.4 `RunState.status` + extensions) |
| **RunStage** | Internal control pipeline progress (link/admit pipeline); may advance while status stays `running` or `paused` |

### 8.2 RunStatus ↔ 0.2.4 mapping (frozen for goldens)

| 0.3 RunStatus | 0.2.4 | Notes |
|---------------|-------|--------|
| running | running | Active work or between stages while not terminal |
| completed | completed | Successful terminal (do **not** rename wire to `success`) |
| failed | failed | |
| paused | paused | Waiting approval / human; RunStage may be `executing` |
| blocked | blocked | Gate / **project** budget block |
| cancelled | *(new)* | Explicit cancel terminal; **import:** 0.2 runs without cancel → never map to cancelled; legacy failed-with-cancel-message stays failed unless importer proves cancel |
| unknown | *(new)* | Unclean provider/journal uncertainty |

### 8.3 RunStage progression

```text
received → compiled → linked → queued → admitted → executing → terminal
```

- Fragment link mid-run keeps status `running` (or `paused` if waiting approval) while stage may re-enter `executing` after `FragmentLinked`.
- Terminal stage pairs with a terminal RunStatus (`completed|failed|blocked|cancelled|unknown`).

**Attempt:**

```text
AttemptPrepared
  → DispatchIntentRecorded
  → submit(idempotencyKey)
  → DispatchAcknowledged | rejected | ambiguous
  → progress observations
  → collect/reconcile → terminal
```

Idempotency key from stable Attempt identity. Crash windows as prior (intent retry / reconcile / unknown).

---

## §9. CommandRecord (authority, atomic, re-auth)

### 9.1 Placement

CommandRecord is an **immutable authority record inside the same atomic commit batch** as its ControlEvents (log-structured or equivalent).
Unique index `(controlDomainId, commandId)` **rebuildable from the journal**.
Not a mutable side table that can drift from the log.

### 9.2 Fields

```text
commandId, requestHash
callerPrincipal, authorizationContextHash
projectId, controlDomainId
status, firstCommitSeq, lastCommitSeq
responseArtifactRef?
recordedAt
```

### 9.3 Atomic batch

1. Durable-write response Artifact (rename/fsync) if any.
2. Atomic commit: CommandRecord + all events; assign contiguous commitSeq.
3. Then RPC accepted.
Orphan blobs GC; never accept with dangling refs.

### 9.4 Idempotent **execution** vs **disclosure**

| Case | Behavior |
|------|----------|
| Same commandId + requestHash | **Do not re-execute** side effects |
| Return prior response body | **Only after re-checking** current principal authorization for that project/command class (revocation → deny even if command already ran) |
| Same id, different hash | TF_IDEMPOTENCY_CONFLICT |
| Different principal, same id | TF_CROSS_PRINCIPAL_COMMAND |

`authorizationContextHash` is **audit metadata** recorded at accept; disclosure still uses **live** authz.

### 9.5 Artifact access

`ArtifactRef.digest` is **not a bearer token**. Read requires current principal + project scope + **ledger reachability** (artifact referenced by authorized run/command).

---

## §10. ControlEvent envelope

```text
eventId, schemaVersion, controlDomainId
streamId, streamSeq, commitSeq
commandId? (FK, non-unique), commandEventIndex?
causationId, correlationId, projectId, recordedAt
payload (small; ArtifactRef/SecretRef for bulk)
```

`commitSeq` never renumbered by compaction.

---

## §11. executionSemanticHash & cache

**boundFragmentHash:** full link audit identity.

**executionSemanticHash** includes resolved execution descriptor:

- model id + revision/digest when available
- sampling / reasoning / seed policy
- system prompt / agent body digest
- tool schema versions + allow/deny
- runner + parser buildInfo
- task/input digests + OutputContract
- fragment IR semantic body
- declared resource-read versions/digests

Authority epoch alone does **not** enter executionSemanticHash.
Class folding only under published equivalence contracts.

**Reuse iff:** authority valid ∧ lease/version valid ∧ executionSemanticHash equal ∧ artifact integrity ∧ output contract OK ∧ re-Link/validate allows.

---

## §12. ArtifactRef & SecretRef

```text
ArtifactRef { digest, size, mediaType, storageClass, redactionClass }
SecretRef { secretId, issuer }  // NO content digest
```

Secrets never in general ArtifactStore as content-addressed blobs.

---

## §13. Receipt & compaction

### 13.1 Receipt (issued once, immutable)

At issue time must include:

```text
controlDomainId, runId, boundPlanHash|boundFragmentHash
eventManifest[] | merkle/hash-chain root over included ControlEvent ids
startCommitSeq, endCommitSeq   // bounds only; not sole proof
artifactRefs[]
assurance { … }
buildInfo
```

**Compaction must not renumber commitSeq.**
Compaction must not require mutating old Receipts; manifests/roots issued at receipt time remain valid, or Receipt embeds sufficient digests.
Missing blob after retention → `artifactIntegrity: unknown`, not silent verify.

### 13.2 assurance

```text
journalContinuity, providerOutcome, artifactIntegrity, provenance
enforcement: {
  resolution, mutationMediation, processIsolation,
  revocation: admission-only | per-mutation
             | { mode: "bounded-latency", maxLatencyMs }  // promised
}
// observedRevocationLatencyMs optional on Receipt when applicable
```

---

## §14. Policy

```text
effectiveAuthority = host ∩ user ∩ project ∩ invocation
```

deny∪ · capability∩ · substitution conflict→deny · catalog≠authority · project cannot enlarge user/host.
Ops: deny | substitute | attenuate. Security unknown fields fail closed. Single canonical hash library.

---

## §15. Enforcement

| Capability | Meaning |
|------------|---------|
| resolution | contained \| unbound |
| mutationMediation | none \| brokered (per mutation) |
| processIsolation | none \| sandboxed (sealed plan) |
| revocation | admission-only \| per-mutation \| `{mode:"bounded-latency", maxLatencyMs}` |

Live process kill after revoke remains best-effort; Receipt records promise vs observation when latency mode used.

Wire to workspace PreparedSandboxPlan / ResourceEnforcer.

---

## §16. ExecutionProvider

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
```

Discriminated unions for accepted | rejected | ambiguous.

---

## §17. Approval (outline; full wire in **P15**)

0.2.4 `ApprovalRequest` is minimal (`phaseId/message/upstream`). 0.3 is a protocol upgrade.

### 17.1 Objects

```text
ApprovalRequest {
  approvalRequestId
  runId, nodeInstanceId
  boundPlanHash | boundFragmentHash
  expectedRunVersion
  allowedDecisions: approve | reject | edit
  owner / audience / requiredPrincipals?
  deadline, timeoutPolicy
  status: pending | approved | rejected | edited | expired | cancelled
  createdAt, decidedAt?
  decisionCommandId?     // CommandRecord of the decision
  editArtifactRef?       // when edit
}
```

### 17.2 Rules (normative minimum)

- RunStatus **`paused`** while request `pending`.
- Decision is a **CommandRecord** (idempotent; re-auth on disclosure).
- **CancelRequested first** → later ApprovalDecision CAS fails; request → `cancelled`.
- **ApprovalDecision first** → clears pause; later CancelRequested may still cancel Run.
- Same `expectedRunVersion` race → first commit wins.
- **Timeout → reject** (status `expired` or rejected-by-timeout); **never** default approve.
- **edit output** → validate against OutputContract; no re-link.
- **edit plan/obligations** → re-Link required before continue.
- Decider must match **principal / audience** rules (P15).
- Survive control restart; dual-client decide tests required.

**P15** freezes TypeBox + full CAS table before wire freeze.

---

## §18. Negotiation & errors

```text
protocolMajor, supportedReadSchemas[], supportedWriteSchemas[]
requiredFeatures[], offeredFeatures[], buildInfo
```

```text
{
  code, message,
  recoveryAction: retry-same-command | retry-new-command | refresh
                | reconcile | operator | none,
  sideEffects: none | possible | unknown,
  commandId?, commitSeq?, controlDomainId?, projectId?
}
```

Codes include: TF_PROTOCOL_INCOMPATIBLE, TF_SCHEMA_*, TF_FEATURE_REQUIRED, TF_POLICY_DENIED, TF_AUTHORITY_REVOKED, TF_STALE_VERSION, TF_IDEMPOTENCY_CONFLICT, TF_CROSS_PRINCIPAL_COMMAND, TF_LEGACY_CONFLICT, TF_PROVIDER_AMBIGUOUS, TF_JOURNAL_UNAVAILABLE, TF_DURABILITY_FAILED, TF_CURSOR_EXPIRED, TF_COMMAND_FAILED, TF_BOOTSTRAP_FAILED.

Cursor: `minAvailableCommitSeq`, cursor lease/TTL, TF_CURSOR_EXPIRED → checkpoint resync.

---

## §19. D21 parity & P5

Public surface sources: schema, docs/skills, examples, exports, tests, promised errors.
Step 1 converts surface → goldens.

P5 matrix:

```text
PHASE_TYPES (all, incl. race/expand)
× when | join:any | retry | timeout | expect | budget | cache
  | cwd | workspace | shareContext | dynamic def | saved use
  | resume | recompute | replay | approval | cancel/abort
  | foreground | detached | idempotent:false
  | final-output attribution
  | score | onBlock:retry | reflexion | tree reduce
  | Run status mapping (completed/paused/blocked/unknown)
```

Ternary suites: expand×cache×authority epoch; detached×approval×resume.

Fail-at-link: **dev-only**.

---

## §20. Compatibility & rollback

- 0.2 import: LegacyEvidenceImported only.
- legacy-conflict: 0.3 stops new Attempts.
- Rollback: full before 0.3 writes; after 0.3 writes read-only / lossy export without execute promise.
- **No DomainTransfer.**

---

## §21. Packages & toolchain (D28)

```text
taskflow-core / taskflow-control / taskflow-daemon
taskflow-mcp-core (thin) / taskflow-hosts / taskflow-cli
taskflow-web (0.3.1+) / host delivery packages
```

| Item | Baseline |
|------|----------|
| Node engines | ≥22.19; **@types/node aligned to 22** for package typecheck **and** CI matrix **22 + 24 LTS (+ 26 Current optional)** — not “types 22 *or* multi-version CI” |
| TypeScript | **Root TS 7** CLI/typecheck; **taskflow-dsl** isolated **TS 6** compiler API; resolution guard test against drift |
| pnpm | **11.x** stable (`packageManager` field) |
| SQLite | only behind ControlStore port + explicit P-ADR |

---

## §22. Implementation order

```text
1.   Green trunk
1.a  Public 0.2.4 surface → golden plan
1.5  Toolchain: pnpm 11, TS7 root, DSL TS6 isolation, @types/node 22 + CI 22/24/26
2.   Single scheduler convergence
2.5  P-ADRs (gate below)
3.   Wire freeze + TypeBox
4.   ControlHost extract
5.   Per-project ControlStore + user Registry + UserCoordinatorStore (concurrency only)
6.   Bootstrap + singleton multi-mount (taskflowd / embedded)
7.   Linker + admission
8.   ExecutionProviders
9.   Thin MCP + CLI
10. WebUI 0.3.1
```

**Allowed now: 1–2.5.**

### P-ADR wire-freeze gate (unified)

> **P1–P13 and P15 required before wire freeze.**
> **P14** (ControlStore engine) **required unless** P3 freezes a **files-only** engine with no sqlite/other port.

| ID | Topic |
|----|--------|
| P1 | Policy overlay |
| P2 | Empty-policy Exposure |
| P3 | Domain + Registry rebuild + clone/worktree identity (no DomainTransfer) |
| P4 | Negotiation + errors + recoveryAction |
| P5 | Phase × feature matrix + RunStatus mapping + ternary suites |
| P6 | Canonical hash + ArtifactRef + SecretRef |
| P7 | Dynamic paths + dual hashes + cache |
| P8 | Enforcement capabilities |
| P9 | legacy-conflict |
| P10 | Rollback tiers |
| P11 | Compaction + cursor + minAvailableCommitSeq |
| P12 | Command batch + re-auth disclosure |
| P13 | Bootstrap / fresh-install / singleton lock / platforms |
| P14 | ControlStore engine (skip only if files-only frozen in P3) |
| P15 | **Approval protocol** (full state machine + principal rules) |
| P16 | UserCoordinatorStore concurrency leases (optional if folded into P13) |

---

## §23. GA acceptance (minimum)

- [ ] Fresh install, default auto, one run, no manual daemon config
- [ ] Concurrent client start → single writer
- [ ] Stale socket recovery
- [ ] Per-project store; registry multi-mount
- [ ] standalone and daemon open **same** store
- [ ] No DomainTransfer code path in GA
- [ ] Command re-exec suppressed; disclosure re-authed
- [ ] Artifact read authz
- [ ] Public-surface goldens + Run status mapping
- [ ] Receipt event manifest survives compaction rules
- [ ] bounded-latency maxLatencyMs when used
- [ ] All §22 P-ADRs present for shipped wire types

---

## §24. Structured status

```text
Architecture: Approved
Protocol model (0.3): Approved (v7.1 doc-alignment patch)
Wire freeze: Not approved (needs P1–P13+P15, P14 if not files-only)
Steps 1–2.5: Approved to start
DomainTransfer: Rejected for 0.3
User merged journal: Rejected for 0.3
User Registry + multi-mount: Approved
Global concurrency: strong under singleton coordinator only
Global budget: statistics only in 0.3
```

---

## §25. Supersession

**0.3+ clients:** this RFC supersedes local-daemon / competitive-map bullets that require daemon default-off or silent in-process full-power degrade.

**Retained:** disk authority; UDS/auth; handshake; one admission authority when claimed; no default network listener.

**Historical 0.2.x:** process-less detached lifecycle remains valid for unupgraded clients.

---

## Appendix A — Vocabulary

ControlDomain · ControlStore · ControlRegistry · CommandRecord · BoundPlan · BoundFragment · executionSemanticHash · ArtifactRef · SecretRef · ControlHost · recoveryAction · public surface

## Appendix B — Explicitly cut from 0.3

DomainTransfer · user-level merged authority journal · silent auto→standalone · GA fail-at-link for public 0.2.4 features · node:sqlite without P-ADR · commitSeq renumbering

---

*End RFC v7. Approved product model: per-project ledger + user registry multi-mount; no DomainTransfer. Proceed with Steps 1–2.5.*
