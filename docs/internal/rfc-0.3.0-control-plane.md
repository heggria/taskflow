# RFC: taskflow 0.3.0 — Coding-Agent Control Plane

> **Status (split):**
>
> | Layer | Verdict |
> |-------|---------|
> | **Architecture** | **Approved** |
> | **Protocol model** | **Approved with clarifications (v5)** — ControlDomain, CommandRecord, dual fragment hashes, ArtifactRef, D21 public surface |
> | **Wire / schema freeze** | **Not yet** — freeze after P-ADRs encode v5 pins |
> | **Implementation allowed now** | **§19 steps 1–2.5 only** |
>
> **Date:** 2026-07-22 · **v5** closes remaining protocol Blockers B1–B3 from fourth review  
> **Branch:** `feat/0.3.0`  
> **Watershed (v5):** Physical journal scope = **user-level ControlDomain by default** (project is logical partition).  
> **Watershed (v4 retained):** 0.3 GA must not fail-at-link publicly supported 0.2.4 semantics.

**Related**

| Doc | Role |
|-----|------|
| [`competitive-map-2026-h2.md`](./competitive-map-2026-h2.md) | Category |
| [`rfc-local-daemon.md`](./rfc-local-daemon.md) | Daemon non-negotiables |
| [`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md) | Normative resource model |
| [`rfc-background-run.md`](./rfc-background-run.md) | Detached provider strategy |
| [`../rfc-0.2.0-architecture.md`](../rfc-0.2.0-architecture.md) | Kernel strangler |
| [`../0.2.0-north-star.md`](../0.2.0-north-star.md) | North star |
| `packages/taskflow-core/src/exec/kernel-policy.ts` | Gap rows ⊂ P5 matrix only |
| `packages/taskflow-core/src/exec/step.ts` | `EVENT_KERNEL_PHASE_TYPES` (excludes race/expand — P5 must cover) |
| `packages/taskflow-core/src/resources/backend.ts` | PreparedSandboxPlan / enforcer |

---

## TL;DR

1. **Architecture remains Approved.** Triad, `controlMode: auto`, one ControlHost, BoundPlan template + BoundFragment, D21 parity direction.

2. **Protocol model v5 pins (for freeze ADRs):**
   - **ControlDomain** (default: user-level daemon domain; projectId partitions);
   - **CommandRecord** ledger — `commandId` unique on commands, **not** on every ControlEvent;
   - **`boundFragmentHash` vs `executionSemanticHash`** for cache;
   - first-class **`ArtifactRef`** + ArtifactStore port;
   - D21 covers **publicly supported** 0.2.4 surface (docs/schema/examples/exports/tests/promised errors), not “only what already has tests”;
   - P5 = full **PHASE_TYPES × cross-cutting features** matrix.

3. **Wire schema freeze still blocked** until P-ADRs land these pins.  
   **May start:** green trunk, toolchain, golden corpus from public surface, single scheduler, P-ADRs.

4. **Journal scope vote (accepted):** user-level ControlDomain for daemon; global `commitSeq` is **per ControlDomain**; cross-domain admission is **not** atomic.

**Re-review for wire freeze:** §23.

---

## §0. Motivation (stable)

Coding-Agent Control Plane around the 0.2 kernel wedge.  
Not Squad / Paperclip / Conductor clone.  
Not a metamorphosis that deletes publicly supported 0.2.4 capabilities at GA.

---

## §1. Architecture decisions (ADR)

| ID | Decision | Choice | Layer |
|----|----------|--------|-------|
| **D1** | Role | CACP | Arch ✓ |
| **D2** | Kernel | Single scheduler | Arch ✓ |
| **D3** | Planes | Intent·Compile·Link·Control·Exec·Ledger (+Trace) | Arch ✓ |
| **D4** | Entities | + **CommandRecord**, **ArtifactRef**, **ControlDomain** | Model ✓ |
| **D5** | controlMode | auto default | Arch ✓ |
| **D6** | Journal | Single physical log **per ControlDomain**; logical streams; global **commitSeq within domain** | Model ✓ |
| **D7** | Project | projectId UUID + directoryBinding | Model ✓ |
| **D8–D11** | Northbound / provider / policy / sandbox | As v4 | Arch ✓ |
| **D12** | Migration | Tiered rollback | Model ✓ |
| **D13–D18** | Scope / resources / caller / delivery / dynamic / ControlHost | As v4 | Arch ✓ |
| **D19–D20** | Grant revalidation / exclusive write (0.3 stops self) | As v4 | Model ✓ |
| **D21** | Parity | **Public 0.2.4 surface** → golden corpus in step 1; no GA fail-at-link without breaking ADR | Model ✓ |
| **D22** | Journal topology | One physical log + commitSeq **scoped to ControlDomain** | Model ✓ |
| **D23** | Enforcement | Orthogonal **assurance capabilities** (not only exclusive enum) | Model ✓ |
| **D24** | Commands | **CommandRecord** unique; events reference commandId N:1 | Model ✓ |
| **D25** | Cache identity | **executionSemanticHash** for reuse; **boundFragmentHash** for audit | Model ✓ |
| **D26** | Artifacts | **ArtifactRef** out-of-band storage; journal holds refs | Model ✓ |

---

## §2. Planes (approved)

```text
INTENT → COMPILE → LINK → CONTROL → EXEC → LEDGER
                      ↑
                      BoundFragment + Artifacts
```

---

## §3. ControlDomain & journal scope (B1 scope — accepted)

### 3.1 Definitions

```text
ControlDomainId    identity of one authority ledger + admission domain
projectId          stable UUID (logical partition inside a domain)
directoryBinding   path + device + inode evidence for a projectId
```

### 3.2 Default topology

| Mode | ControlDomain |
|------|----------------|
| **User-level daemon (`auto` / `coordinated`)** | **One ControlDomain per user daemon instance** (or per configured domain). Projects are **partitions** (`projectId` on events/commands). `commitSeq` totally orders **the whole domain** → cross-project admission/budget **within that domain** can be atomic. |
| **`standalone`** | After exclusive project ownership, open a **single-project ControlDomain** (domain may equal that project’s ledger). No claim of atomic admission with other projects or with a concurrent user daemon on the same projects without ownership rules. |

### 3.3 Non-claims

- No atomic admission **across** ControlDomains.  
- Backup/corruption blast radius = **one ControlDomain**.  
- Ownership lease is per project (or per domain policy); dual domains writing same projectId → fail closed / legacy-conflict as before.

---

## §4. Domain entities

```text
ControlDomain
CommandRecord
Program / FlowIR
BoundPlan / BoundFragment / SpawnTemplate
Run / NodeInstance / Attempt / ProviderJobHandle
ControlEvent
ArtifactRef
Receipt
```

---

## §5. Commands vs events (B1 commandId — accepted: scheme A)

### 5.1 Problem

One RPC command often appends **many** ControlEvents (`BudgetClaimGranted`, `RunAdmitted`, `OwnershipLeaseAcquired`, …).  
A unique index on `ControlEvent.commandId` is wrong.

### 5.2 CommandRecord (unique)

```text
CommandRecord {
  commandId              // UNIQUE in ControlDomain
  requestHash            // canonical hash of accepted request body
  status                 // accepted | rejected | failed | …
  firstCommitSeq
  lastCommitSeq
  responseArtifactRef?   // ArtifactRef to durable response payload
  recordedAt
}
```

### 5.3 ControlEvent envelope

```text
ControlEvent {
  eventId
  schemaVersion
  controlDomainId
  streamId                 // logical: "control" | "run:<runId>" | …
  streamSeq
  commitSeq                // global within ControlDomain
  commandId?               // NON-UNIQUE FK → CommandRecord
  commandEventIndex?       // optional 0..n within command
  causationId
  correlationId
  projectId?
  recordedAt
  payload                  // small; large blobs → ArtifactRef inside payload
}
```

### 5.4 Idempotent RPC rules

| Case | Behavior |
|------|----------|
| Same `commandId` + same `requestHash` | Return **original** durable response (from CommandRecord / responseArtifactRef). **Do not** re-execute side effects. |
| Same `commandId` + different `requestHash` | **Idempotency conflict** — reject |
| Command failed with **no** durable ControlEvent / no CommandRecord accept | May retry with **same** commandId only if protocol marks command as safe-retry; else new commandId |
| Response durability | RPC `accepted` only after CommandRecord + its events are **durably committed** (domain fsync policy) |

Optional unique `(commandId, commandEventIndex)` on events for ordering within a command — **not** a substitute for CommandRecord dedup.

### 5.5 Fragment source pointers

Replace ambiguous `sourceEventSeq` with:

```text
sourceEventId
sourceCommitSeq
```

---

## §6. Dynamic plan (v4 inventory + cache hashes)

### 6.1 Paths (retained)

saved `use` pin at root Link; flat spawn + SpawnTemplate; flow{def}; expand nested/graft; ctx_spawn subflow; map/loop NodeInstance rules — as v4.

### 6.2 Two hashes (B2 — accepted)

```text
boundFragmentHash
  = audit identity of full link decision
    (IR + policy + capability snapshot + authority epoch/refs
     + provider/model/tool bindings as linked + resource baseline pins …)

executionSemanticHash
  = identity of factors that determine computational outputs
    (task/inputs/contracts, provider class, model class, tools/effects,
     relevant resource-read versions / content digests, fragment IR
     semantic body — NOT raw authority epoch alone)
```

### 6.3 Cache reuse predicate

```text
reuse_allowed iff
  current authority valid for required grants
  AND current lease / workspace version valid
  AND executionSemanticHash equal to cached
  AND source ArtifactRef integrity verified
  AND output contract still compatible
  AND re-Link/validate under current policy does not deny
```

**Do not** require full `boundFragmentHash` equality for reuse (epoch churn would false-miss).  
**Do** store both hashes on cache entries and journal fragment-link events.

### 6.4 Cached dynamic fragments

Store PlanFragment **ArtifactRef**, prior hashes, source Receipt/event range (`sourceEventId`/`sourceCommitSeq`…`endCommitSeq`), output ArtifactRefs.  
Never blind-restore promoted phase state as authority.

---

## §7. ArtifactRef (B2 — accepted, D26)

### 7.1 Type

```text
ArtifactRef {
  digest                 // content hash
  size
  mediaType
  storageClass           // e.g. local-blob | ephemeral | external
  redactionClass         // none | redact-on-export | secret-never-journal
}
```

### 7.2 Rules

- ControlEvent / CommandRecord payloads stay **small**; large outputs, PlanFragments, transcripts → **ArtifactStore** via ArtifactRef.  
- Secrets: never place raw secrets in journal payload; use redactionClass + external secret stores as needed.  
- Receipt references ArtifactRefs; retention policy must define when digests remain verifiable vs `artifactIntegrity: unknown`.  
- ArtifactStore is a **port** (local dir, sqlite blob, …) beside ControlStore.

---

## §8. D21 parity & P5 matrix (B3 — accepted amendment)

### 8.1 D21 wording (normative)

> **All documented or publicly supported 0.2.4 semantics must remain compatible at 0.3 GA** on the single scheduler.  
> Step 1 **first** converts that public surface into a **comprehensive golden corpus**.  
> Test coverage is the **proof mechanism**, not the boundary of what users may rely on.  
> Removal requires explicit breaking-change ADR + migration + version policy.  
> Fail-at-link is **dev-only** for unfinished ports, not a GA exit.

### 8.2 Public surface sources (minimum)

- TypeBox / public schema  
- README, skills, host docs  
- `examples/`  
- public package exports  
- existing tests  
- explicitly promised error/handling behavior in released docs

### 8.3 P5 matrix (2D)

```text
rows:    all PHASE_TYPES (including race, expand — not only kernelUnsupportedReason rows)
columns: cross-cutting features, at least:
         retry | timeout | expect | budget | cache
         cwd | workspace | shareContext | dynamic def | saved use
         resume | recompute | replay | approval
         foreground | detached
         map/loop/tournament instantiation
         score gates | onBlock:retry | reflexion | tree reduce
```

Each cell: `port | n/a | breaking-ADR`.  
`kernelUnsupportedReason` and `EVENT_KERNEL_PHASE_TYPES` exclusions are **inputs** to the matrix, not the whole matrix.

---

## §9. Enforcement as capabilities (M1 — preferred)

Prefer orthogonal **assurance capabilities** over a single exclusive ladder:

```text
resolution:          contained | unbound
mutationMediation:   none | brokered
processIsolation:    none | sandboxed
revocation:          admission-only | per-mutation | bounded-latency
```

**Receipt / BoundPlan** record the capability set actually claimed.  
Legacy names map as profiles:

| Profile | Typical capabilities |
|---------|----------------------|
| resolve-only | resolution=contained; mutationMediation=none; processIsolation=none; revocation=admission-only |
| brokered-write | + mutationMediation=brokered; revocation=per-mutation |
| sandboxed-session | + processIsolation=sandboxed; revocation=bounded-latency; may **also** use brokered writes |

Cancel after revocation remains **best-effort** for live processes; do not over-claim.

Wire to PreparedSandboxPlan / ResourceEnforcer as before.

---

## §10. Intent / observe dispatch (retained)

```text
DispatchIntentRecorded → submit → DispatchAcknowledged | ambiguous
→ observations → collect/reconcile → terminal
```

Idempotency key from stable Attempt identity. Provider caps: idempotencyLevel / reconcileLevel.

---

## §11. Receipt assurance (multi-dim, retained)

```text
assurance {
  journalContinuity: complete | partial | unknown
  providerOutcome:   confirmed | ambiguous | unknown
  artifactIntegrity: verified | partial | unknown
  provenance:        native-v1 | legacy-trace
  enforcement:       { resolution, mutationMediation, processIsolation, revocation }
}
```

---

## §12. ControlHost modes (approved)

auto / coordinated / standalone share one ControlHost semantics.  
auto cannot start control → error.  
Legacy writer → `legacy-conflict`; 0.3 stops **itself**.

---

## §13. Approval (deterministic, retained)

CancelRequested first → later ApprovalDecision CAS fails.  
Approval first → later cancel may still cancel Run.  
Timeout → **reject**. Edit plan → re-Link.

---

## §14. ExecutionProvider (async sketch, retained)

probe / prepare / submit / watch / poll / cancel / collect / reconcile with discriminated unions.

---

## §15. Protocol negotiation (retained + errors)

```text
protocolMajor
supportedReadSchemas[]
supportedWriteSchemas[]
requiredFeatures[]
offeredFeatures[]
buildInfo
```

### 15.1 Error taxonomy (M2 — minimum)

Stable codes (adapters map, do not invent strings):

| Code | Retryable? | Side effects possible? |
|------|------------|-------------------------|
| `TF_PROTOCOL_INCOMPATIBLE` | no | no |
| `TF_SCHEMA_READ_UNSUPPORTED` | no | no |
| `TF_SCHEMA_WRITE_UNSUPPORTED` | no | no |
| `TF_FEATURE_REQUIRED` | no | no |
| `TF_POLICY_DENIED` | no | no |
| `TF_AUTHORITY_REVOKED` | no | maybe (prior work) |
| `TF_STALE_VERSION` | yes (refresh) | no if pure CAS miss |
| `TF_IDEMPOTENCY_CONFLICT` | no | no |
| `TF_LEGACY_CONFLICT` | no until reconcile | prior legacy yes |
| `TF_PROVIDER_AMBIGUOUS` | reconcile path | **yes** |
| `TF_PROVIDER_REJECTED` | depends | no if rejected pre-accept |
| `TF_JOURNAL_UNAVAILABLE` | maybe | no if pre-intent |
| `TF_DURABILITY_FAILED` | maybe | **unknown** |
| `TF_COMMAND_FAILED` | if no durable accept | no |

Every RPC error includes: `code`, `message`, `retryable`, `sideEffects: none|possible|unknown`, optional `commandId` / `commitSeq`.

---

## §16. Compaction & checkpoints (M3 — ControlStore constraints)

Before ControlStore schema freeze, ADR must define:

| Topic | Requirement |
|-------|-------------|
| Projection checkpoint | snapshot of projections + covered `commitSeq` |
| Rebuild | checkpoint + tail, or genesis + full log |
| Compaction preconditions | no live cursor behind drop line; Receipts that need dropped events must embed **event digests** or copied decision artifacts |
| Artifact retention | independent TTL; missing blob → `artifactIntegrity: unknown` not silent success |
| Receipt durability | must remain meaningful after compaction via digests / retained decision artifacts |
| Delete vs integrity failure | distinct error/assurance states |

Does not block architecture; **blocks ControlStore wire freeze**.

---

## §17. Policy algebra (retained)

```text
effectiveAuthority = host ∩ user ∩ project ∩ invocation
```

deny ∪; capability ∩; substitution conflict → deny; catalog ≠ authority.

---

## §18. Pre-freeze checklist (wire freeze)

| ID | Content | Status after v5 |
|----|---------|-----------------|
| P1 | Policy overlay | Direction closed |
| P2 | Empty-policy Exposure | Direction closed |
| P3 | ControlDomain + single log + commitSeq + CommandRecord | **Closed in model** |
| P4 | Negotiation + error taxonomy | **Closed in model** |
| P5 | PHASE_TYPES × features matrix + D21 public surface | **Closed in principle** — matrix doc still to write |
| P6 | Canonical hash + ArtifactRef digests | **Closed in model** |
| P7 | Dynamic paths + dual hashes + cache predicate | **Closed in model** |
| P8 | Enforcement capabilities | **Closed in model** |
| P9 | legacy-conflict | Closed |
| P10 | Rollback tiers | Closed |
| P11 | Compaction/checkpoint | **Must write ControlStore ADR** |

**Wire freeze** when P5 matrix document exists and P11 ADR exists (plus TypeBox sketches reviewed).

---

## §19. Implementation order

```text
1.   Green trunk
1.a  Inventory public 0.2.4 surface → golden corpus plan (D21)
1.5  Toolchain ADR + clean matrix
2.   Single scheduler convergence (ports from P5 matrix)
2.5  P-ADRs encoding v5 (CommandRecord, ControlDomain, hashes, ArtifactRef, P5 matrix, P11)
3.   Wire freeze re-review → TypeBox schemas
4.   Extract ControlHost
5.   ControlStore + ArtifactStore + journal
6.   Daemon + RPC
7.   Linker + admission
8.   ExecutionProviders
9.   Thin MCP + CLI
10.  WebUI 0.3.1
```

**Allowed now:** 1–2.5 only.

---

## §20. Compatibility & rollback (retained tiers)

Pre-migration backup full restore; no-0.3-writes full rollback; after 0.3 writes read-only / lossy 0.2 export without execute promise.

---

## §21. GA acceptance (additions on top of v4)

- [ ] CommandRecord dedup: same id+hash → same response; hash mismatch → conflict  
- [ ] Multi-event single command shares commandId  
- [ ] commitSeq order across logical streams within ControlDomain  
- [ ] Cross-project admit atomic only within same ControlDomain  
- [ ] executionSemanticHash cache hit after authority epoch change when predicate holds  
- [ ] ArtifactRef retention / missing blob behavior  
- [ ] P5 matrix cells all ported or breaking-ADR  
- [ ] Public-surface goldens pass (not only pre-existing tests)  
- [ ] Error codes stable across MCP/CLI  
- [ ] Compaction preserves Receipt verifiability rules  

(Include full v4 dynamic/authority/approval/legacy matrices.)

---

## §22. Product success (stable)

auto admission; dynamic + incremental wedges; D21 no silent capability loss; honest unknown/legacy-conflict; CLI-first.

---

## §23. Structured re-review (wire freeze)

```text
Verdict: Approve-wire-freeze | Request-changes | Reject

Model pins:
  ControlDomain user-level default: Agree | Disagree
  CommandRecord scheme A: Agree | Disagree
  executionSemanticHash + ArtifactRef: Agree | Disagree
  D21 public surface: Agree | Disagree
  Enforcement capabilities (orthogonal): Agree | Disagree

P5 matrix document ready: Yes | No
P11 compaction ADR ready: Yes | No

May implement wire schemas: Yes only if both Yes above + Approve-wire-freeze

Residual risks (≤3)
Nits
```

---

## §24. Review disposition

| Version | Result |
|---------|--------|
| v1–v3 | Architecture strengthened |
| v4 | Architecture Approved; protocol almost frozen |
| **v5** | **Protocol model Approved with clarifications**; wire freeze pending P5 doc + P11 ADR + TypeBox review |

### v5 closes

| Item | Disposition |
|------|-------------|
| commandId unique on events | **CommandRecord**; events N:1 FK |
| Journal scope | **User-level ControlDomain** default; project partition; commitSeq per domain |
| sourceEventSeq | **sourceEventId + sourceCommitSeq** |
| Cache equality | **executionSemanticHash** + auth/lease/artifact checks |
| Artifact | **ArtifactRef** + store port |
| D21 scope | **Public surface**, then goldens |
| P5 | **Full phase × feature matrix** |
| guaranteeTier | **Orthogonal enforcement capabilities** |
| Errors | Stable **TF_*** taxonomy |
| Compaction | Required **before** ControlStore freeze |

---

## Appendix A — Vocabulary

| Term | Meaning |
|------|---------|
| ControlDomain | One physical journal + admission total order |
| CommandRecord | Idempotent command ledger row |
| commitSeq | Domain-global event order / cursor |
| boundFragmentHash | Full link audit identity |
| executionSemanticHash | Output-determining semantic identity |
| ArtifactRef | Content-addressed blob reference |
| Public surface | Docs/schema/examples/exports/tests/promised behavior |

## Appendix B — Refusals

No unique commandId on every event; no undefined “semantic equality”; no journal-as-blob-dump; no GA parity limited to pre-existing tests; no cross-ControlDomain atomic admission claim; no over-claim of live process revocation.

---

*End RFC v5. Architecture Approved. Protocol model Approved with clarifications. Wire freeze after P5 matrix document + P11 ControlStore ADR. Execute §19.1–2.5 now.*
