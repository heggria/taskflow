# P16-1R: versioned admission and first-dispatch-owner saga

> Status: **Proposed implementation gate** — not accepted, not a GA claim, and
> not permission to add a generic retry.
>
> Parent: [P16 coordinator concurrency + release](./P16-coordinator-concurrency.md)
> and [P15 approval protocol](./P15-approval-protocol.md).
>
> Git baseline requested for release evidence: branch **feat/0.3.0**, tip
> **e11b82109e04f69e56a37aceb3f78934f822ad14**.
>
> Observed implementation baseline: the **dirty shared working tree** recorded
> by the Round-58/59 SCRATCH manifests, not the e11b8210 commit. The
> AdmissionIntent/prepare/finalize/dispatch facts below describe that observed
> tree and must be re-audited on every checkout before implementation.
>
> The observed implementation remains intentionally fail-closed for A3/A4;
> this document specifies the minimum protocol required before that result may
> change.

## Decision in one minute

Two independent durable stores cannot make a provider side effect exactly once
by swapping write order. A recovery writer may create the first durable
dispatch intent only after all of these are true:

1. immutable project evidence and immutable coordinator evidence bind the same
   command, admission, project, run, continuation, plan, reservation and
   authority fence;
2. one capability-bound writer owns a durable, monotonic FirstDispatchOwner;
3. an old owner fails a fencing check immediately before every project mutation
   and provider boundary; and
4. at the first provider boundary in this ADR's scope, recovery invokes the
   provider's atomic `getOrCreate` contract with the exact durable idempotency
   tuple; it never infers a new submit from RunStage.

Both stores must receive a new durable schema. Legacy ownerless admissions are
quarantined. A native approval resume uses this same saga or is rejected before
it changes a parked Run to queued/admitted. Attach and same-command retry
clients are disclosures only; they never acquire the owner.

This can at most turn defined **local admission-saga** cells from FAIL to
PARTIAL. It does not solve P13 stale-authority handover, P14's in-scope local
durability cells, P16 capability/release authority or retention/pressure, remote provider
fencing, all entrypoint parity, or GA.

## 1. Observed baseline and invariants

The current project journal is schema 1 and coordinator state is schema 2.
The generic admission path currently reserves, writes project-side admission
evidence, commits coordinator state using a caller-provided sequence, writes
SlotCommitted, then lets the scheduler create the first dispatch intent.
That leaves the following non-negotiable gaps.

| ID | Durable observation after crash | Why current state is insufficient | Required result |
|---|---|---|---|
| A1 | project-prepared plus elapsed reservation | a retry cannot prove it owns a current slot | one owner explicitly rebinds or stops |
| A2 | admission-bound reservation | public coordinator mutation is not a capability boundary | no public release/mutation of admission slot |
| A3 | C committed; P SlotCommitted; no intent | no owner proves who may make first scheduler action | current successor creates one owner/intent or stops |
| A4 | executing with no active attempt or only prepared | neither proves a provider call/owner | never return success; resume only by owner |
| A5 | P/C evidence disagree | coordinator accepts caller-supplied binding/sequence | broker verifies immutable proof/readback |
| A6 | schema-1 or partial upgrade | no migration/quarantine contract | explicit migration or quarantine |

The following invariants are implementation requirements:

| ID | Requirement |
|---|---|
| I0 | Before E0, the linker must prove a single, fully bound first provider attempt in P16-1R scope; an unclassified, zero-provider, multi-provider, or pre-provider-side-effect plan is rejected with no P/C/provider side effect. |
| I1 | One live admissionId maps to one command identity, runId, continuationId and at most one capacity-occupying reservation. |
| I2 | ProjectRunPrepared is immutable pre-admission evidence; it is never named or reused as RunAdmitted. |
| I3 | Coordinator conditional commit binds the complete evidence tuple, not a caller Boolean, epoch or guessed sequence. |
| I4 | A schema-2 Run never reaches executing for its first provider attempt without a current durable FirstDispatchOwner and DispatchIntentRecorded. |
| I5 | The one first provider call in P16-1R scope has a durable SubmitStarted record and an `(admissionId, attemptId)`-scoped idempotency key. |
| I6 | After that attempt's SubmitStarted, recovery invokes only the exact provider `getOrCreate`/readback contract or reconciliation; blind submit is forbidden. |
| I7 | Attach/retry callers cannot claim, replace, release, submit, terminalize or issue a Receipt. |
| I8 | Unknown/future/mixed/partial schema cannot initialize a store, reserve, submit, release or issue a Receipt. |
| I9 | Every transition emits command/admission/run/reservation/evidence references, the owner binding when one exists, and a typed outcome. |

P16-1R deliberately covers **one logical first provider attempt only**: the
attempt that creates or obtains the initial provider job for this admission.
It does not establish an owner for later phase calls, retries with a new logical
attempt, or a resumed continuation. Those calls are forbidden by this protocol
until a follow-on per-attempt owner ADR defines them. This scoping is necessary:
a run can have several provider calls, but one global owner field cannot safely
represent their independent ambiguity boundaries.

### Current non-compliance map (observed dirty working tree only)

This is a design-to-code map, not a claim that the listed files already meet
the protocol or that they exist at e11b8210. The base SHA, dirty list and
source hashes that make this map reproducible belong in the Round-59 SCRATCH
manifest. A future agent must first regenerate the map against its own tree.

| Current location | Present behavior | Required P16-1R replacement |
|---|---|---|
| taskflow-control/src/types.ts | control schema 1; AdmissionIntent has queued/project-prepared/slot-committed only; RunAdmitted lacks admissionId | V2 state/event types, owner/commitment/provenance fields and strict wire validators |
| taskflow-control/src/store/project-store.ts | prepare path emits RunAdmitted before C commit; evidence lookup is runId plus reservationId | immutable ProjectRunPrepared evidence and V2 cross-record rebuild checks |
| taskflow-control/src/store/coordinator.ts | schema-2 mutable state; reserve accepts caller coordinatorEpoch; commit accepts caller binding/sequence | capability-gated C3 commitment ledger, broker verification and monotonic admission revision |
| taskflow-control/src/control-host.ts | finalize leaves an admitted/no-intent gap; scheduler later creates intent | owner claim/fence and intent transition before executing; no ownerless disclosure |
| taskflow-control/src/control-host.ts native approval path | bare reserve then project admission then C commit | ApprovalResumeAdmissionV2 or pre-admission fail-close |

## 2. Lower bounds

### Two-store lower bound

Let P be the project journal and C the coordinator journal/state. A crash may
occur after either independent write. No write order is an atomic transaction.
A retry that mints a reservation can duplicate capacity; a retry that calls an
admitted/executing Run successful can conceal an unowned provider action.

The sufficient local strategy is a durable saga: immutable cross-store
evidence, one recovery owner per nonterminal state, authoritative readback at
each advance, retained evidence on ambiguity, and no action outside a
capability-bound owner.

### Authority-transfer lower bound

At A3/A4 a new process cannot distinguish a dead old writer from a writer that
will submit immediately from project bytes alone. An elapsed clock is not
authority transfer. A successor may take the owner only after P13 supplies an
authorized, holder-authenticated capability with a higher fence. Without that,
the production result remains TF_RECONCILE_REQUIRED/operator/unknown.

### Provider lower bound

After SubmitStarted, a crash may precede, overlap, or follow the provider
operation. A local journal cannot identify the case. The successor must use the
same key and the provider's atomic `getOrCreate` contract binding provider,
admission, run, continuation, attempt, phase, route, request digest and returned
handle. Unsupported/ambiguous capability means reconcile/operator, never a
replacement submit.

## 3. Terms and authority model

| Term | Definition |
|---|---|
| admission | one durable command-to-run saga, identified by admissionId |
| admission generation | monotonic project generation for an explicit pre-commit reservation rebound; not a lease epoch |
| pre-commit recovery authorization | P13-issued, holder-authenticated capability scoped to one admission/generation/reservation and no-later-evidence proof; it is not a FirstDispatchOwner |
| admission saga projection | the derived state of immutable admission records; it has one first attempt, but does not itself prove an owner |
| prepared evidence | ProjectRunPrepared eventId, commitSeq and containing journal segment hash |
| coordinator commitment | immutable C record binding one reservation to one prepared evidence tuple |
| owner claim | immutable record binding one writer authority/fence to the first attempt; the current claim is derived, never overwritten |
| owner generation | positive monotonic integer in an owner claim, changed only by an authorized claim/supersede chain |
| authority fence | P13-issued writer fence, not a caller option |
| owner capability | unforgeable daemon/standalone authority object; never reconstructed from JSON |
| dispatch attempt | immutable logical request record identified by attemptId; P16-1R permits exactly `first` per admission |
| dispatch intent | stable provider request identity for an attempt; not proof provider was called |
| SubmitStarted | durable provider-boundary marker; later state is ambiguous until exact provider readback |
| quarantine | readable/reportable state in which no ordinary mutation, release, submit, terminalization or Receipt is permitted |

Every immutable **admission-saga** record has this `AdmissionIdentity`; no
event may infer any field from a mutable current Run projection:

~~~text
AdmissionIdentityTuple {
  commandId, callerPrincipalDigest, requestHash,
  admissionId, admissionGeneration,
  projectId, projectControlDomainId, runId, continuationId, boundPlanHash
}
AdmissionIdentity {
  schemaVersion, eventId, recordedAt, ...AdmissionIdentityTuple
}
ParentAdmissionIdentity = AdmissionIdentityTuple
ChildAdmissionIdentity = AdmissionIdentityTuple
~~~

`ParentAdmissionIdentity` and `ChildAdmissionIdentity` are serialized tuples,
not aliases or pointers. A dual-identity record has its own event metadata plus
one complete `parent` tuple and one complete `child` tuple; validators compare
every field, not just an admissionId.

The only exceptions are the global migration envelopes/records in §9: they
operate before an admission is selected, carry their own project-set identity,
and must never be used as admission evidence. There are no other implicit
exceptions.

`OwnerBinding` is deliberately **not** part of `AdmissionIdentity`:

~~~text
null                                      // required on pre-claim records
| { claimId, ownerId, ownerGeneration,
    authorityId, authorityFence }          // required after a claim
~~~

`AdmissionIntentRecordedV2`, `ReservationObserved`, `ProjectRunPrepared`, the
C commitment, and parked-readmit release records require `ownerBinding: null`.
`FirstDispatchOwnerClaimed` creates the first non-null binding. Every record
that changes, uses, or closes the first attempt thereafter must carry the exact
current binding. Thus no pre-owner record falsely promises a positive owner
generation, and every post-owner record can be fenced.

FirstDispatchOwner is a projection over an immutable chain, not a mutable
field. The records are:

~~~text
OwnerClaim extends AdmissionIdentity {
  claimId, predecessorClaimId?: null | string,
  ownerId, ownerGeneration, authorityId, authorityFence,
  firstAttemptId, plannedEventId, plannedAttemptHash,
  reason: initial | takeover | approval-resume,
  expectedAdmissionRevision, expectedProjectHeadHash,
  expectedCommitmentHash, expectedCommitmentRevision, recordedAt
}
OwnerSuperseded extends AdmissionIdentity {
  supersedeId, priorClaimId, successorClaimId,
  transferAuthorizationId, expectedPriorClaimHash,
  expectedProjectHeadHash, expectedCommitmentHash,
  recordedAt
}
OwnerClosed extends AdmissionIdentity {
  claimId, disposition: acknowledged | reconciled | terminal | quarantined,
  expectedProjectHeadHash, recordedAt
}
PreCommitAuthorizationRef {
  kind: initial | transfer,
  authorizationId, admissionId,
  authorityId, authorityFence, issuedAt, expiresAt?
}
PreCommitRecoveryCapability {
  ref: PreCommitAuthorizationRef,
  admissionGeneration, reservationId,
  expectedProjectHeadHash, expectedAdmissionProjectionRevision,
  expectedCoordinatorHeadHash, expectedReservationHash, expectedReservationRevision,
  reason
}
~~~

E0 emits the public `PreCommitAuthorizationRef(kind:initial)` with
AdmissionIntentRecordedV2. P13 may issue a higher-fenced
`PreCommitAuthorizationRef(kind:transfer)`. The live
`PreCommitRecoveryCapability` is never journaled; the immutable expiry/rebound
and P-observation records serialize the complete public ref plus their own
expected CAS facts. Thus both initial and transferred writers have one auditable
authorization reference, but no secret is persisted.

The one live owner is the latest valid `OwnerClaim` for `firstAttemptId` that
has no valid `OwnerSuperseded` or `OwnerClosed` record. An `OwnerSuperseded`
record and its successor claim are appended in the same P transaction; a
replacement without both records is invalid. A claim never changes in place.
OwnerClaim/OwnerSuperseded/OwnerClosed and DispatchAttempt records live in the
P journal; C never infers or mutates a current owner. C stores only commitment,
disposition and parked-release evidence.
The capability secret is never journaled. P records only public authority/fence
identity; the broker validates the live private capability before accepting
every expected ownerGeneration/fence mutation.

Production surfaces are distinct:

| Surface | May read | May mutate | Acquisition |
|---|---|---|---|
| observer | snapshots/audit | no | attach, status, MCP read tool |
| admission writer | only bound P/C admission transitions | named saga edges | current daemon/standalone writer |
| operator repair | explicit quarantine/repair only | approved repair edges | future P16-0/P16-2 path |

A public store method, caller-supplied coordinatorEpoch, raw principal string,
or Boolean ReleaseContext is not authority. The writer capability is
closure/private-symbol/IPC-authenticated state verified on every C mutation.
Test bypasses use a distinct type and cannot reach shipped entrypoints.

## 4. Durable schema and evidence

The implementation pins **project control schema 2** and **coordinator state
schema 3**. They are not placeholders. Changing either number, its wire
meaning, or the legal compatibility combinations requires a new revision of
this ADR, an updated migration table, validators, downgrade tests and SCRATCH
evidence before code changes. Adding optional owner fields while retaining
schema 1/2 is forbidden.

### Project AdmissionSagaProjectionV2 (AdmissionIntentV2)

~~~text
{
  schemaVersion: 2,
  admissionId, commandId, requestHash, callerPrincipalDigest,
  runId, continuationId, boundPlanHash,
  admissionProjectionRevision, projectHeadHash,
  state:
    queued | prepared | admitted-owned | intent-recorded |
    submit-started | acknowledged | reconciling | terminal | quarantined,
  admissionGeneration,
  reservation?: ReservationEvidence,
  prepared?: PreparedAdmissionEvidence,
  commitment?: CoordinatorCommitmentEvidence,
  firstAttempt?: DispatchAttempt,
  derivedActiveOwnerClaimId?: string, // rebuild must equal immutable claim chain
  migration?: MigrationProvenance,
  createdAt, updatedAt
}
~~~

`reservation-observed`, `coordinator-committed`, and `slot-committed` are
immutable **event milestones**, not additional projection states. Their effect
is represented as follows: `prepared` means P has both ReservationObserved and
ProjectRunPrepared; C may then have an unobserved commitment. `admitted-owned`
means one P batch observed C's exact commitment and appended SlotCommitted,
RunAdmitted, and the initial OwnerClaim. This removes the previous ambiguous
"owner after slot batch" gap.

`firstAttempt` is a rebuild-checked projection of immutable attempt records;
the underlying `DispatchAttempt` identity is immutable once created:

~~~text
{
  attemptId: "first", admissionId, admissionGenerationAtPlan,
  phaseId, continuationVersion, boundPlanHash,
  providerName, providerContractVersion, providerRouteDigest,
  requestDigest, idempotencyKey, plannedEventId, plannedAttemptHash,
  intentEventId?, submitStartedEventId?, providerHandle?,
  state: planned | intent-recorded | submit-started |
         acknowledged | reconciling | quarantined
}
~~~

The V2 validator permits one `attemptId: "first"` only. E0 atomically appends
`DispatchAttemptPlanned` with the full tuple (including
`admissionGenerationAtPlan`) before a reservation exists; E4's
OwnerClaim references that exact plannedEventId/attemptId, and E5 may only add
the intent to the same immutable tuple. Any change to phase, route, request
digest, plan, or continuation is a new logical attempt and therefore a schema
error until its independent owner/fencing protocol exists. Provider uniqueness
and test markers are asserted per `(admissionId, attemptId)`, never as one
marker for an entire multi-phase Run. `plannedAttemptHash` covers
`admissionGenerationAtPlan`; E2R never rewrites it and instead proves its
historical generation through the rebound chain.

ReservationEvidence includes reservationId, reservationHash, coordinatorId,
reservationRevision, coordinatorHeadHash, admissionId, admissionGeneration,
reservationAuthorityId, reservationAuthorityFence, reservedExpiresAt and
observedAt. It is valid only if authoritative C readback says exactly reserved
and unexpired.

PreparedAdmissionEvidence includes eventId, streamId, commitSeq, segmentHash,
project/domain, admission/generation, reservation, run, continuation,
boundPlanHash, plannedEventId, plannedAttemptHash and event schema. The
referenced event is ProjectRunPrepared.

CoordinatorCommitmentEvidence includes coordinatorId, commitmentId,
commitmentRevision, commitmentHash, coordinatorHeadHash, reservationId,
reservationHash, admissionId, preparedEvidenceDigest, project/domain, run, continuation,
command/request/principal/plan/planned-attempt tuple, reservationAuthority identity/fence and
recordedAt. It is valid only if C returns the exact immutable commitment and
its current disposition is `committed`.

### Coordinator state schema 3

C persists an append-only or equivalently immutable, hash-addressable admission
ledger. A mutable reservation row alone is not cross-store evidence. In the
pseudo-schemas below, `extends AdmissionIdentity` means the record serializes
every field in §3 (not a pointer to a mutable projection). For a parent release,
that identity is the parent admission identity.

~~~text
CoordinatorAdmissionReservation extends AdmissionIdentity {
  schemaVersion: 3, coordinatorId,
  reservationId, reservationRevision, reservationHash,
  previousReservationId?: null | string, previousReservationHash?: null | string,
  expectedCoordinatorHeadHash,
  reservationAuthorityId, reservationAuthorityFence,
  preCommitAuthorizationRef: PreCommitAuthorizationRef,
  ownerBinding: null, state: reserved, reservedAt, reservedExpiresAt
}
CoordinatorReservationExpired extends AdmissionIdentity {
  schemaVersion: 3, expiryId, reservationId, reservationHash, reservationRevision,
  expectedCoordinatorHeadHash, preCommitAuthorizationRef: PreCommitAuthorizationRef,
  observedAt, ownerBinding: null, state: expired-awaiting-capacity
}
CoordinatorReservationRebound extends AdmissionIdentity {
  schemaVersion: 3, reboundId,
  oldReservationId, oldReservationHash, oldReservationRevision,
  oldAdmissionGeneration, newReservationId, newReservationHash,
  newReservationRevision, newAdmissionGeneration,
  expectedCoordinatorHeadHash, preCommitAuthorizationRef: PreCommitAuthorizationRef,
  reservationAuthorityId, reservationAuthorityFence,
  ownerBinding: null, recordedAt
}
CoordinatorAdmissionCommitment extends AdmissionIdentity {
  schemaVersion: 3, coordinatorId, commitmentId,
  commitmentRevision, commitmentHash, previousCommitmentHash,
  reservationId, reservationHash, expectedReservationRevision, expectedCoordinatorHeadHash,
  preparedEvidenceDigest, preparedEventId, preparedCommitSeq, preparedSegmentHash,
  plannedEventId, plannedAttemptHash,
  reservationAuthorityId, reservationAuthorityFence,
  ownerBinding: null,
  state: committed, recordedAt
}
CoordinatorCommitmentDisposition extends AdmissionIdentity {
  schemaVersion: 3, dispositionId, commitmentId, commitmentHash,
  priorCommitmentRevision, dispositionRevision, previousDispositionHash,
  state: revoked-for-operator-repair | quarantined,
  operatorAuthorizationId, reason, recordedAt
}
CoordinatorParkedReleaseRecord extends AdmissionIdentity {
  schemaVersion: 3, releaseId, releaseHash, releaseRevision,
  parentAdmissionId, parentCommitmentId, parentCommitmentHash,
  expectedCoordinatorHeadHash, expectedParentCommitmentRevision,
  parkedEvidenceDigest, parkedEventId, parkedSegmentHash,
  ownerBinding: null,
  state: released-for-readmit, recordedAt
}
~~~

Every C3 admission record above serializes the complete
command/request/principal/plan identity; it cannot be reconstructed from a
caller parameter. C reservation/commitment/release records are intentionally
pre-owner and therefore require `ownerBinding: null`.
`reservationAuthority*` proves who performed the reservation/commit operation;
it is not a substitute for a FirstDispatchOwner.
For CoordinatorParkedReleaseRecord, `parentAdmissionId` must equal the inherited
`admissionId`; all inherited project/run/continuation/plan fields are the parent
tuple. The duplicate label exists only to make the release direction explicit.
For `CoordinatorReservationRebound`, the inherited AdmissionIdentity carries
the new generation; the old generation is retained explicitly and must equal
the prior reservation record. This makes the chain directional and prevents a
rebound record from being replayed as its predecessor.

C creates a commitment only when the exact reservation is reserved, unexpired,
owned by the same admission, and a broker independently verifies immutable P
prepared evidence. The conditional request contains `expectedCoordinatorHeadHash`,
`expectedReservationRevision`, and the full prepared/identity tuple. Exact
repetition returns the same commitment; any changed field returns a typed
mismatch and changes nothing. Every admission-affecting C mutation has a
monotonic revision, not only coordinator commands.

The implementation must either retain commitments in an append-only ledger
with previousCommitmentHash and canonical commitmentHash, or provide an
equivalent immutable content-addressed record plus an anchored monotonic head.
A revocation is a later record referring to the original commitment; it must
not mutate the original proof in place. This gives local continuity only. Per
the frozen 2026-07-27 P14 scope, coherent rollback of every locally consulted
P/C authority byte to one older valid snapshot is outside the 0.3
anti-rollback contract. Partial/mixed rollback, corruption, loss and
half-commit remain GA blockers.

### Required events

| Event | Required property |
|---|---|
| AdmissionIntentRecordedV2 | `AdmissionIdentity`, `ownerBinding:null`, initial PreCommitAuthorizationRef; no Run/slot/provider effect |
| DispatchAttemptPlanned | same E0 batch; complete immutable first-attempt tuple, `ownerBinding:null` |
| ReservationObserved | exact C reservation proof observed by P; `ownerBinding:null` |
| AdmissionReservationReboundObserved | exact C old-expired/new-reservation chain plus full PreCommitAuthorizationRef; `ownerBinding:null` |
| ProjectRunPrepared | immutable non-admitted P evidence and provider route-contract selection; `ownerBinding:null` |
| CoordinatorCommittedObserved | exact C commitment readback observed by P; `ownerBinding:null` |
| SlotCommitted | P records verified capacity commitment; `ownerBinding:null` |
| RunAdmitted | same P batch as SlotCommitted; includes admission and commitment evidence; `ownerBinding:null` |
| FirstDispatchOwnerClaimed | an OwnerClaim with generation/fence and firstAttemptId |
| FirstDispatchOwnerSuperseded | links prior and successor claims in the same P transaction |
| FirstDispatchOwnerClosed | closes a claim only after acknowledgement/reconcile/terminal/quarantine disposition |
| DispatchIntentRecorded | exact current OwnerBinding/current generation, plannedEventId/hash, attempt identity and `(admissionId,attemptId)` key |
| SubmitStarted | exact current OwnerBinding; mandatory before provider operation |
| DispatchAcknowledged | exact provider-owned tuple/handle and current OwnerBinding |
| AdmissionQuarantined | stop reason, evidence and required repair authority |
| AdmissionTerminalized | terminal admission evidence; Receipt remains separate |

CoordinatorCommittedObserved, SlotCommitted, RunAdmitted and
FirstDispatchOwnerClaimed are one P journal batch after C readback. A schema-2
Run is admitted after that batch. It becomes executing only in the same batch
as a valid current-owner DispatchIntentRecorded for `attemptId:"first"`.

Every rebuild rejects/quarantines, rather than silently selecting a projection,
for mismatched IDs/hash/principal, missing ReservationObserved chain, missing C
commitment, two live owner claims, invalid claim/supersede chain, stale-owner
intents, more than one first attempt, mismatched `(admissionId,attemptId)`
provider key, or ownerless executing.

## 5. Lock discipline, broker linearization, and complete saga edges

P `commit.lock` and C `state.lock` must never be nested or held while blocking
on the other store or a provider. The protocol is deliberately a sequence of
CAS-protected observations, not a hidden distributed transaction.

### 5.1 Exact cross-store linearization

For `conditionalCommitAdmission`, the broker performs this exact sequence:

1. **P snapshot, no C lock.** Open the registered P reader, validate the
   P2 header/project/domain/directory binding, and read the immutable
   ProjectRunPrepared event. Capture `{preparedEventId, preparedSegmentHash,
   preparedDigest, admissionProjectionRevision, projectHeadHash}` and release
   P. The reader never accepts a caller path.
2. **C compare-and-commit, no P lock.** Under only C `state.lock`, compare
   `expectedCoordinatorHeadHash`, `expectedReservationRevision`, reservation
   identity, full AdmissionIdentity, and the captured prepared digest. Append
   the immutable C commitment or return the exact prior identical commitment.
   A changed field is `TF_IDEMPOTENCY_CONFLICT`/`none`; no P read occurs while
   holding C lock.
3. **C readback, no P lock.** Read the exact C commitment and current
   disposition outside P lock. Its `{commitmentHash, commitmentRevision,
   coordinatorHeadHash, disposition}` becomes the only input to P finalization.
4. **P compare-and-finalize, no C lock.** Under only P `commit.lock`, compare
   `expectedAdmissionProjectionRevision`, prepared event/digest, and the C
   commitment hash/revision. In one P batch append
   CoordinatorCommittedObserved + SlotCommitted + RunAdmitted + initial
   OwnerClaim. Any P CAS failure writes nothing and returns to readback; it
   never reserves a replacement slot.
5. **Side-effect boundary recheck.** Before intent and again before provider
   invocation, read P's current claim/attempt and C's current commitment
   disposition without nesting locks. A disposition other than `committed`, a
   different hash, migration mode, or a missing fence stops/quarantines before
   provider work.

If C is already revoked/quarantined at step 3, P remains `prepared` or appends
AdmissionQuarantined; no owner is created. If C changes after step 3 but before
P finalization, P may only record an observation of the immutable commitment;
the mandatory next C recheck prevents intent/provider work and appends
quarantine. This residual C-repair race is not solved by P16-1R: P16-2 must
make revocation and writer capability a real production boundary.

The broker rejects a detected registry, header, directory, segment hash,
commitment-anchor, or migration-envelope failure before C commit. An
**undetectable coherent rollback** of both local stores and all matching local
authority evidence is different: the frozen P14 scope explicitly makes no 0.3
anti-rollback guarantee for that event, so it is not a conditional-commit
predicate and cannot be declared detected locally. This does not relax any
partial/mixed rollback or one-sided crash predicate above.

~~~mermaid
flowchart LR
  A["AdmissionIntentRecordedV2\nP queued"] --> B["C reserveAdmission\nadmissionId + reservation fence"]
  B -. "exact C readback" .-> C["ReservationObserved + ProjectRunPrepared\nP prepared batch"]
  C --> D["C conditionalCommit\nP proof digest + C CAS"]
  D -. "exact C readback" .-> E["CObserved + SlotCommitted + RunAdmitted +\nOwnerClaim P batch"]
  E --> F["DispatchIntentRecorded\ncurrent claim only"]
  F --> G["SubmitStarted\ncurrent claim only"]
  G --> H["atomic provider getOrCreate\nexact tuple"]
  H --> I["acknowledged / reconciling / quarantine"]
~~~

### 5.2 Transition table

`P@h/r` below means the exact P journal head hash and admission projection
revision; `C@h/r` means the exact C head hash and reservation/commitment
revision captured before the mutation. A failed expected value has no external
side effect and returns a typed readback/reconcile result.

| Edge | Pre-state and expected evidence | Authorized actor and CAS | Same-batch durable records / next state | External side effect / slot | Failure or successor action |
|---|---|---|---|---|---|
| E−1 link eligibility | no admission/reservation; canonical BoundPlan available | pure linker, no writer authority | validates exactly one fully-bound first provider tuple; no durable admission state | none / none | zero/multiple provider boundary, pre-provider side effect, or dynamic tuple → `TF_FEATURE_REQUIRED / none / none` |
| E0 create | no command mapping; P2 active; E−1 tuple | admission capability; expected command absent | AdmissionIntentRecordedV2(initial PreCommitAuthorizationRef) + DispatchAttemptPlanned → `queued` | none / none | same identity/tuple returns same admission; changed identity/tuple conflict |
| E1 reserve | P `queued`; valid initial PreCommitAuthorizationRef; no live reservation for admission | C capability; C@h + absent/same reservation | C CoordinatorAdmissionReservation(g0, initial ref) only; P remains `queued` | none / reserved TTL | same r1 readback only; no r2 while r1 live |
| E2 prepare | P `queued`; exact C r1 reserved/unexpired; E0 planned tuple | admission writer; P@h/r | ReservationObserved + ProjectRunPrepared (binding the preselected provider contract/route) → `prepared` | none / reserved | stale/expired C proof: E2R or typed no-dispatch stop; never an intent |
| E2R rebound | P `prepared(g)` has r(g) and no commitment/Run/owner/intent/SubmitStarted; C r(g) effectively expired or expired-awaiting-capacity | valid initial or P13-transfer PreCommitRecoveryCapability; C@h/r + old r hash/rev + P@h/r | C Expired + Reservation(g+1) + Rebound, then P AdmissionReservationReboundObserved + ReservationObserved + new ProjectRunPrepared → `prepared(g+1)` | none / expired r(g), reserved r(g+1) | exact retry returns same r(g+1); capacity-full state is idempotent retry-same-command/none; any later evidence or stale CAS stops/quarantines |
| E3 commit | P `prepared`; immutable prepared digest; exact C r1 | broker; C@h/r + expected reservation revision | C CoordinatorAdmissionCommitment; P remains `prepared` | none / committed | exact repeat same commitment; mismatch no mutation |
| E4 finalize | P `prepared`; exact E0 planned attempt/rebound chain; C commitment currently `committed` | current admission writer; P@h/r + exact commitment hash/rev | CoordinatorCommittedObserved + SlotCommitted + RunAdmitted + OwnerClaim(initial, plannedEventId/hash) → `admitted-owned` | none / committed | C not committed: quarantine/stop; P CAS fail: reread, never reserve |
| E5 first intent | P `admitted-owned`; exact E0 planned attempt; no intent/SubmitStarted for `first`; C commitment current | current claim, or P13 transfer claimant; P@h/r + current claim hash + plannedEventId + C commitment readback | if transfer: OwnerSuperseded + successor OwnerClaim; then DispatchIntentRecorded + executing → `intent-recorded` | none / committed | stale claim/C/planned tuple mismatch: no write, authority-revoked or reconcile; attach only reports |
| E6 submit marker | P `intent-recorded`; no SubmitStarted; exact `first` tuple; C current | current claim, or P13 transfer claimant; P@h/r + claim hash + C readback | if transfer: supersede + claim; SubmitStarted → `submit-started` | none at record / committed | no provider contract or C inactive: feature-required/reconcile, no provider call |
| E7 provider reconcile | P `submit-started`; exact tuple/key and current/authorized recovery claim | current claim or P13 transfer claimant; exact P/C readback before call | no optimistic P terminal record | `getOrCreate` may be possible / committed | unavailable/ambiguous: `reconciling`; never new key/blind submit |
| E8 acknowledge | P `submit-started` or `reconciling`; returned tuple exactly matches | current/authorized recovery claim; P@h/r + handle tuple | DispatchAcknowledged + OwnerClosed → `acknowledged` | observation only / retained | foreign/mismatched handle: quarantine; no terminal/release/Receipt |
| E9 terminal/release | acknowledged/reconciled has separately proven terminal state | P15/P16-2 only, outside this ADR | terminal/release records defined by those ADRs | governed separately | P16-1R does not authorize this edge |

### 5.3 E2R: pre-commit reservation rebound

E2R is the **only** automatic pre-commit rebound. It is not a generic retry and
it has no FirstDispatchOwner because the protocol proves that first dispatch
cannot yet exist. Its preconditions are all mandatory:

~~~text
P: AdmissionSagaProjection is prepared at generation g and references r(g);
   its immutable event chain has no CoordinatorCommittedObserved, SlotCommitted,
   RunAdmitted, OwnerClaim, DispatchIntentRecorded, SubmitStarted, provider handle,
   acknowledgement, terminalization, or Receipt.
C: r(g) has the exact immutable reservation hash/revision, has no commitment,
   and is effectively expired at C's authoritative clock/readback, or has one
   immutable `expired-awaiting-capacity` record.
Auth: a live PreCommitRecoveryCapability validates either the E0 initial ref or
   a P13 transfer ref, binding admissionId, g, r(g), expected P head/revision,
   expected C head/revision, authority/fence, and reason.
~~~

The recovery writer first reads and releases P, capturing its exact no-later-
evidence proof. Under only C lock it CASes C head + r(g) hash/revision +
generation. If r(g) is still `reserved` but elapsed, it first appends exactly
one `CoordinatorReservationExpired(r(g), authorizationRef)` with effective
state `expired-awaiting-capacity`. It then either appends
`CoordinatorAdmissionReservation(r(g+1), previous=r(g), authorizationRef)` and
`CoordinatorReservationRebound(r(g), r(g+1), authorizationRef)` in the same C
transaction, or (when capacity is full) persists only that immutable expired
state and returns `TF_CAPACITY_EXCEEDED / retry-same-command / none`. A later
authorized retry CASes the exact expired record/head and may append the one new
reservation + rebound; it never appends a second expiry record. The new
reservation has the same complete AdmissionIdentity except
`admissionGeneration:g+1`; it gets a new reservationId/expiry and consumes one
slot. Exact replay of a completed rebound returns the same r(g+1); exact replay
of `expired-awaiting-capacity` returns the same capacity result until capacity
changes.

E2R and E3 compete on the same r(g) C CAS: E3 can commit only while r(g) is
current/unexpired, while E2R can expire/rebind only when it is current/expired
and uncommitted. Exactly one can win; the loser reads the resulting immutable
record and may not mint a new reservation from a stale P snapshot.

After C lock is released, the writer exact-readbacks r(g+1) and its rebound
record. Under only P lock it CASes the old prepared projection/head and appends
`AdmissionReservationReboundObserved`, `ReservationObserved(r(g+1))`, and a
new `ProjectRunPrepared(g+1)` in one P batch. The planned first attempt remains
byte-identical and no Run is admitted. It retains its factual
`admissionGenerationAtPlan:g`; post-rebound OwnerClaim/Intent records carry the
current generation plus `plannedEventId`/`plannedAttemptHash`. The validator
permits that older plan reference only through a contiguous validated rebound
chain and rejects any changed attempt tuple. A P CAS failure writes no
provider/C replacement; recovery rereads C and either observes the same r(g+1)
or stops.

| Crash/reopen point | Only legal continuation | Prohibited result |
|---|---|---|
| r(g) expired; no C rebound | same authorized E2R CAS | r(g+2), intent, provider call |
| C rebound chain exists; P still `prepared(g)` | exact readback then P rebound observation batch | fresh reservation or old-r(g) commit |
| P `prepared(g+1)`; C r(g+1) reserved | E3 only with new prepared digest | use r(g), new planned attempt, provider call |
| C `expired-awaiting-capacity` | same valid authorization CASes that exact expiry after capacity changes | a second expiry, new generation, or operator/unknown claim when no provider boundary exists |
| old writer resumes after a successful rebound | expected C/P generation CAS fails; reread only | overwrite r(g+1), another rebound, P/C/provider mutation |
| any commitment/owner/intent/SubmitStarted evidence appears | quarantine/operator | E2R, release, submit, Receipt |

P never trusts a passed reservation snapshot. C never trusts a raw
`projectAdmitCommitSeq`: its broker validates the independently opened immutable
ProjectRunPrepared evidence. P never trusts a raw commitment object: it requires
exact C readback. A readback failure becomes no side effect/reconcile/quarantine,
never a fresh reservation, success disclosure, release, or provider call.

## 6. First-dispatch owner and provider micro-protocol

### 6.1 Claim and successor rules

The initial OwnerClaim is in E4's P batch. It proves only assignment of the
first scheduler action. A replacement needs a P13-issued
`TransferAuthorization` bound to `{admissionId, firstAttemptId, priorClaimId,
newAuthorityId, newAuthorityFence, reason, authorizationId}`. Wall-clock expiry
is telemetry, never authorization.

For **admitted-owned/no intent**, a successor reads exact P/C evidence, proves
P13 transfer, and CASes the active claim. It appends OwnerSuperseded + successor
OwnerClaim + DispatchIntentRecorded in one P batch. For
**intent/no SubmitStarted**, the successor must bind the same existing attempt
and key; it appends OwnerSuperseded + successor OwnerClaim + SubmitStarted in
one P batch before any provider invocation. For
**SubmitStarted/no acknowledgement**, it similarly transfers the claim in a P
batch (or uses the current claim), retains `submit-started`/`reconciling`, and
uses the exact provider contract. It never creates another attempt or key.

If P13 cannot prove the successor, the result is
`TF_RECONCILE_REQUIRED / operator / unknown` and all evidence/slot are retained.
Attach/retry callers cannot acquire, replace, close, release, terminalize, or
issue a Receipt. A `skipSingleton` fixture may exercise local CAS mechanics but
is not production handover evidence.

### 6.2 Plan eligibility before admission

`linkFirstDispatchPlan()` runs before E0 and produces the immutable tuple used
by DispatchAttemptPlanned. P16-1R accepts only a plan whose **first executable
phase** is exactly one provider-bound external call and whose phase, route,
continuation, canonical request digest and BoundPlan hash are resolvable from
the command plus immutable bound inputs at link time. A preceding script/agent
phase, a dynamic map/loop/condition that can change the first call, zero
provider calls, multiple provider phases, or any later provider call is outside
this narrow protocol. It returns `TF_FEATURE_REQUIRED / none / none` before E0;
it does not reserve capacity and it cannot defer that discovery until E5.

This is intentionally restrictive rather than pretending a single owner covers
a general multi-phase DAG. A future per-attempt protocol may widen eligibility
only by defining its own attempt identities, claims, submission contract,
migration and crash matrix.

### 6.3 Provider capability and idempotency contract

As part of E−1, before E0/E1 (and therefore before reservation or C commit),
route selection must bind a provider contract version that exposes this
capability:

~~~text
getOrCreate({
  providerName, providerRouteDigest,
  admissionId, runId, continuationId, attemptId: "first", phaseId,
  idempotencyKey, requestDigest
}) ->
  { kind: "created" | "found", handle, echoedExactTuple }
| { kind: "conflict", existingTupleOrDigest }
| { kind: "unavailable", reason }
~~~

The provider must atomically bind one stable handle to the exact tuple. The
same key with a different request/route/identity tuple is `conflict` and has no
new provider effect. If this capability is absent at initial route selection,
the command fails `TF_FEATURE_REQUIRED / none` before reservation, prepared
evidence, C commit, owner claim, intent, or provider boundary. A mere
`lookupByIdempotency` plus separate `submit` is insufficient.

`DispatchIntentRecorded` includes the full tuple and

~~~text
idempotencyKey = deterministic(admissionId, continuationId, "first", phaseId)
~~~

The key never includes owner generation. After SubmitStarted, the owner invokes
only `getOrCreate` with that exact tuple. `created` and `found` are accepted only
if the echoed tuple matches byte-for-byte after canonicalization; otherwise P
quarantines. If the provider contract disappears or becomes unavailable after
SubmitStarted, return `TF_RECONCILE_REQUIRED / reconcile-or-operator / possible`,
retain the slot, and do not issue terminal/release/Receipt. This is a provider
contract requirement, not a claim that every existing provider has it.

### 6.3 Crash and recovery matrix

| Reopened state | Required P/C/owner precondition | Only allowed action | sideEffects / slot | Required result |
|---|---|---|---|---|
| C r1 reserved, P queued | r1 current, no P prepared | current admission writer E2 or wait expiry | none / reserved | no r2, Run, marker or Receipt while r1 live |
| P prepared, C r1 reserved | exact P prepared/C r1 | E3 C conditional commit | none / reserved | no provider action |
| P prepared, C r1 expired | no attempt/intent/SubmitStarted proof | defined rebound only with monotonic generation, else stop | none / expired or new reserved | typed result; no dispatch |
| C committed, P prepared | exact C commitment active | E4 finalization only | none / committed | no replacement reservation |
| C committed, P missing/mismatch | immutable C proof cannot be linked to P | quarantine/operator | unknown / retained-or-orphan | no release/submit/Receipt |
| admitted-owned, no intent | P13 transfer or current claim; C active | E5 CAS claim + one intent | none / committed | positive A3 only with production P13 handover |
| intent, no SubmitStarted | current/P13 successor, same attempt/key; C active | E6 marker then exact getOrCreate | none until boundary / committed | no new key or false success |
| SubmitStarted, no acknowledgement | current/P13 successor, exact tuple | E7 getOrCreate/reconcile only | possible / committed | never blind submit/new attempt |
| acknowledged, foreign/missing handle | tuple cannot be proven | quarantine | unknown / retained | no poll terminal/release/Receipt |
| old owner resumes | claim superseded/closed | reject on claim/fence CAS | none before boundary / retained | no P/C/provider mutation |
| C commitment revoked/repair | disposition not committed | ordinary writer quarantine/stop | unknown / repair-governed | no scheduler/provider action |
| schema/migration mismatch | not a listed legal combination | report/quarantine only | unknown if legacy active / retained | no initialization/mutation |

## 7. Native approval decision

Native durable approval is re-admission of an existing run, not an exception.
It has a separate, immutable **parent release** before it enters E0 for a new
child admission. The release is deliberately not represented by changing the
old C commitment in place.

### 7.1 Exact parked-readmit release sequence

The approving writer first validates the P15/D37 predicate: the parent
admission is parked, provider quiescence is evidenced, no ambiguous attempt is
live, and the parent C commitment is still current. Both release events extend
`AdmissionIdentity` for that parent; their additional required fields are:

~~~text
ParkedForReadmission extends AdmissionIdentity {
  schemaVersion: 2, eventId, recordedAt,
  parentAdmissionId (= admissionId), parentAdmissionGeneration (= admissionGeneration),
  approvalRequestId, approvalDecisionId, approvalDecisionDigest,
  providerQuiescenceEvidenceDigest,
  parentCommitmentId, parentCommitmentHash, expectedParentCommitmentRevision,
  expectedProjectHeadHash, ownerBinding: null
}
AdmissionParkedReleased extends AdmissionIdentity {
  schemaVersion: 2, eventId, recordedAt,
  parentAdmissionId (= admissionId),
  parkedForReadmissionEventId, parkedForReadmissionHash,
  releaseId, releaseHash, releaseRevision, parentCommitmentHash,
  expectedProjectHeadHash, ownerBinding: null
}
~~~

1. **P release intent.** Under P lock, append `ParkedForReadmission` with the
   complete parent AdmissionIdentity, `ownerBinding:null`, approval
   request/decision digest, provider-quiescence evidence, `parkedEventId`,
   `parkedSegmentHash`, and `{parentCommitmentId, parentCommitmentHash,
   expectedCommitmentRevision}`. The Run remains `paused/parked`.
2. **C immutable release.** With no P lock, C conditionally appends
   `CoordinatorParkedReleaseRecord` only if its expected parent commitment and
   D37 predicate still match. Capacity derives `released-for-readmit` from this
   record; the original commitment remains immutable. The operation is exact
   repeat-or-conflict, never TTL release.
3. **P release observed.** With no C lock, read the exact C release record.
   Under P lock append `AdmissionParkedReleased`, binding `releaseId`,
   `releaseHash`, `releaseRevision`, parent commitment hash, and the P release
   intent hash. The Run remains `paused/parked`.
4. **Child E0.** Only after step 3 may one P batch append
   `ApprovalResumeAdmissionV2` and the child `AdmissionIntentRecordedV2`.
   The child starts `queued`, while the Run projection stays parked until the
   child reaches E4 and then E5. E1--E8 apply unchanged to that child.

The C reader exposes the release as an immutable effective disposition; an
ordinary writer cannot use it as a generic release authority. The real release
capability remains a P16-2 prerequisite, so this is a proposed protocol, not a
claim that current P15 release behavior is safe.

### 7.2 ApprovalResumeAdmissionV2 schema

~~~text
ApprovalResumeAdmissionV2 extends AdmissionIdentity { // inherited identity = child
  schemaVersion: 2, eventId, recordedAt,
  approvalResumeId,
  parent: ParentAdmissionIdentity,
  child: ChildAdmissionIdentity (= inherited AdmissionIdentityTuple),
  approvalRequestId, approvalDecisionId, approvalDecisionDigest,
  parentCommitmentId, parentCommitmentHash,
  parkedEventId, parkedSegmentHash,
  parkedReleaseIntentHash, releaseId, releaseHash, releaseRevision,
  providerName, providerContractVersion, providerRouteDigest,
  expectedProjectHeadHash, ownerBinding: null
}
~~~

The validator requires all links to be exact, `child.admissionId !=
parent.admissionId`, `child` to equal every inherited child tuple field, and
one child per `{approvalRequestId, approvalDecisionId, parent.admissionId}`.
It requires parent/child projectId, controlDomainId, runId, continuationId and
boundPlanHash equality unless a future, separately approved continuation
migration changes them. The child uses the approving command/principal/request
tuple and starts `admissionGeneration:0`; the parent retains its original tuple.
It cannot borrow the parent reservation, owner claim, attempt, key, provider
handle, or Receipt.

### 7.3 Approval crash/reopen matrix

| Reopened evidence | Allowed action | Forbidden result |
|---|---|---|
| parent parked; no ParkedForReadmission | validate predicate then step 1 | reserve/queue/admit child |
| P release intent; C parent still committed | exact step 2 retry/readback | release by TTL or create child |
| C release record; no P release observation | exact C readback then step 3 | child E0, bare Run queue, new reservation |
| P release observed; no child E0 | idempotently append same V2 resume + child intent | second child, parent reuse |
| child E0/E1 interrupted | resume only the child's normal E1--E8 saga | parent slot/owner/attempt reuse |
| missing/mismatched P/C/approval/provider evidence | quarantine/operator | release, submit, terminal, Receipt |
| expired/rejected/cancelled approval | existing P15 non-resume disposition | any parked-readmit release |

Until this route and its P16-2 release authority exist, production durable
approval fails before it changes parked state with
`TF_FEATURE_REQUIRED / none / none` (or a P4-approved equivalent). It must not
reserve without admissionId, write RunAdmitted before C commit, or disclose an
ownerless admitted continuation as success. Existing schema-1 approval
admissions are migration/quarantine cases.

## 8. Typed results

| Condition | Code / recoveryAction / sideEffects |
|---|---|
| capacity before P prepare | TF_CAPACITY_EXCEEDED / retry-same-command / none |
| old owner before intent/SubmitStarted | TF_AUTHORITY_REVOKED / retry-same-command / none |
| P prepared and exact C reservation expired | TF_RECONCILE_REQUIRED / retry-same-command / none |
| C commitment non-committed before intent/provider boundary | TF_RECONCILE_REQUIRED / operator / unknown |
| P/C evidence missing or mismatched | TF_RECONCILE_REQUIRED / operator / unknown |
| legacy/mixed/partial schema | TF_SCHEMA_UNSUPPORTED / operator / unknown |
| plan/provider lacks E−1 eligibility or atomic `getOrCreate` | TF_FEATURE_REQUIRED / none / none |
| provider conflict or foreign/mismatched echoed tuple | TF_RECONCILE_REQUIRED / operator / unknown |
| SubmitStarted and provider unavailable/ambiguous | TF_RECONCILE_REQUIRED / reconcile-or-operator / possible |
| owner cannot be proven at pre-submit boundary | TF_RECONCILE_REQUIRED / operator / unknown |
| parked-readmit release evidence incomplete | TF_RECONCILE_REQUIRED / operator / unknown |

The structured error/snapshot must include admissionId, reservationId, attemptId,
owner generation and evidence references. Message matching is forbidden.

## 9. Global migration, downgrade and quarantine

Schema 2/3 is not an optional-field rollout. C is a user/global coordinator,
not a project-private companion file: a C2 → C3 cutover therefore cannot safely
migrate one project while other registered P1 projects continue normal writes.
It requires a P13 holder-authenticated **global migration capability** plus a
P16-0 operator authorization. Neither exists as a proven production authority
today, so the following is an implementation contract and current data remains
fail-closed.

### 9.1 Migration envelopes and readers

Before changing a header, the migration owner atomically creates these
hash-addressed, append-only envelopes:

~~~text
CoordinatorMigrationEnvelopeV1 {
  migrationId, ownerAuthorityId, ownerFence, operatorAuthorizationId,
  sourceCoordinatorSchema: 2, sourceCoordinatorHeadHash,
  registrySnapshotDigest,
  projects: [{ projectId, controlDomainId, sourceProjectHeadHash }],
  status: preparing-c2 | c3-pending-projects | activating | active | quarantined,
  previousEnvelopeHash, recordedAt
}
ProjectMigrationEnvelopeV1 {
  migrationId, ownerAuthorityId, ownerFence,
  projectId, controlDomainId,
  sourceProjectSchema: 1, sourceProjectHeadHash,
  expectedCoordinatorEnvelopeHash, expectedCoordinatorHeadHash,
  status: preparing-p2 | p2-active | quarantined,
  previousEnvelopeHash, recordedAt
}
MigrationRecord {
  recordId, migrationId, step: M0 | M1 | M2 | M3 | M4 | M5 | blocked | quarantined,
  projectId?, controlDomainId?,
  sourceProjectSchema?, sourceProjectHeadHash?, resultProjectHeadHash?,
  sourceCoordinatorSchema?, sourceCoordinatorHeadHash?, resultCoordinatorHeadHash?,
  expectedCoordinatorEnvelopeHash, expectedProjectEnvelopeHash?,
  buildIdentity, ownerAuthorityId, ownerFence, operatorAuthorizationId,
  previousRecordHash, recordedAt
}
~~~

P2 headers carry `{schemaVersion:2, migrationId, migrationMode:
"preparing"|"active", sourceProjectHeadHash, coordinatorEnvelopeHash}`. C3
headers carry `{schemaVersion:3, migrationId, migrationMode:
"pending-projects"|"active", sourceCoordinatorHeadHash,
registrySnapshotDigest, coordinatorEnvelopeHash}`. New readers must read the
envelope before any normal mutation. An old reader that sees P2/C3 returns
`TF_SCHEMA_UNSUPPORTED` and writes nothing. A pre-existing old binary that does
not understand the envelope cannot be stopped by a file marker alone; P13 global
fencing/quiescence is a mandatory start condition, not a best-effort warning.

### 9.2 Preflight and write order

The migration owner uses one global migration lock/capability, but never nests
P and C data locks:

1. **M0 snapshot.** Read C2 under C lock, release it, and capture exact C2
   head plus the complete registered-project set. Acquire P13 proof that all
   normal writers are quiesced/fenced. If any registered project is missing,
   inaccessible, has a different identity, or has a legacy active/ambiguous
   admission, append a MigrationBlocked/Quarantine envelope and stop. Slots and
   ambiguity are retained; no automatic legacy rebind, dispatch, release, or
   Receipt occurs.
2. **M1 begin global mode.** CAS-create CoordinatorMigrationEnvelopeV1 with
   `status:preparing-c2`, exact C2 head, project-set digest, owner fence, build
   identity and operator authorization. From this point every new reader denies
   normal C mutations and new project registration.
3. **M2 prepare every project.** For each project in the frozen set, under only
   P lock compare source P1 head/header to the envelope, append
   MigrationStarted/Validated evidence, atomically write its ProjectMigration
   Envelope, then atomically replace the header with P2 `preparing`. Record the
   source P segment/head hash and exact C envelope hash. A crash leaves P2
   `preparing`; no normal P mutation is permitted.
4. **M3 cut C2 to C3.** Only after *every* frozen project has matching P2
   `preparing`, acquire C lock, compare the original C2 head and the full
   project-preparation set, then atomically write C3
   `pending-projects` with a `CoordinatorMigrationCommitted` ledger record.
   It contains migrationId, source C2 digest, C3 head, project-set digest,
   every P2 envelope hash, owner fence and build identity. C3 remains
   migration-only.
5. **M4 activate projects.** For each P2 `preparing`, without C lock read the
   exact C3 pending ledger, then under P lock compare P head/envelope/C3 hash,
   rebuild the V2 projection, append MigrationValidated + MigrationCommitted,
   and change only that P header to P2 `active`. C3 pending still blocks normal
   work even after an individual P becomes active.
6. **M5 activate C3.** Only after the C3 ledger exact-readbacks every frozen P2
   active header/commitment, C CAS-appends CoordinatorMigrationActivated and
   changes C3 to `active`. Then and only then may a matching P2-active/C3-active
   pair process E0--E9.

Every mutation records source/destination schema, expected and resulting
P/C/envelope hashes, migrationId, build identity, authority fence and operator
authorization. A failed CAS does not synthesize a new envelope or treat a store
as fresh.

### 9.3 Legal reopen combinations

| P state | C state/envelope | Reader mode and only allowed action |
|---|---|---|
| P1 original | C2, no envelope | normal legacy behavior only; it is not P16-1R evidence |
| P1 original | C2 + `preparing-c2` envelope | migration owner only: M2 for that listed project; all normal C activity stopped |
| P2 `preparing`, matching migrationId | C2 + `preparing-c2` envelope | migration owner only: finish M2 or stop/quarantine |
| P2 `preparing`, matching migrationId | C3 `pending-projects`, matching ledger | migration owner only: M4 |
| P2 `active`, matching migrationId | C3 `pending-projects`, matching ledger | migration owner only: wait/finish M4/M5; no normal admission |
| P2 `active`, matching migrationId | C3 `active`, matching ledger/project set | normal V2/C3 operation permitted |
| any other version, missing envelope, hash/project-set mismatch, stale migrationId, or downgrade attempt | any | quarantine/report only; no init, reserve, dispatch, release, terminalization or Receipt |

This table intentionally includes global C mode. A single-project P1→P2 write
without a frozen C registry is not a supported compatibility mode.

### 9.4 Downgrade and retained legacy cases

| Reader/state | Permitted | Forbidden |
|---|---|---|
| old binary opens P2/C3 | TF_SCHEMA_UNSUPPORTED, no mutation | dropping fields/reserializing/fresh init |
| new binary opens pristine P1/C2 | M0--M5 only with the named global capability | implicit mutation on status/read |
| V1 terminal run | explicit audited migration after validation | manufacturing owner/Receipt/active state |
| V1 queued/prepared/slot-committed/ownerless executing | MigrationBlocked/Quarantine envelope | automatic rebind/dispatch/release/success |
| V1 intent/ack state | exact existing reconcile only if P13/provider independently allow; else quarantine | replacement submit/scheduler continuation |
| partial migration crash | resume only M0--M5 from exact envelope hashes, or authorized repair | rerun as a fresh store |
| partial/mixed downgrade or rollback | quarantine; future explicitly authorized repair only | normal downgrade or local-backup claim |
| coherent restore of every local authority byte | readable only under the frozen trusted-local-disk scope; no 0.3 freshness claim | representing it as detected, repaired, or anti-rollback safe |

## 10. Required test program and evidence

All crash tests reopen real P and C paths in a fresh process. Provider claims
use ScriptExecutionProvider append marker plus durable provider job. Mocks can
supplement but cannot close a recovery cell.

### Before code

1. **Schema/identity validators.** Reject V1/V2/C2/C3 future values, every
   unlisted migration pair, malformed AdmissionIdentity, pre-owner positive
   OwnerBinding, post-owner missing binding, duplicate first attempt, broken
   claim/supersede chain, stale claim CAS, mismatched C full tuple, and a marker
   or provider job not keyed by `(admissionId, attemptId)`. E−1 tests must also
   reject zero/multiple provider calls, a non-provider first phase, dynamic
   first tuple, and a missing atomic provider contract before any reservation.
2. **Real writer P/C faults.** With fresh processes and barriers at E0--E8,
   cover A1 r(g) expiry, C rebound/P old, P rebound/C new, full-capacity E2R
   retry, and stale E2R writer; A2 public release race; C committed/P prepared;
   C revoked before/after P observation; A3 owner-before-intent; A4 executing
   edge; intent-before-SubmitStarted; SubmitStarted-before-provider;
   provider-created-before-ack; expired-owner telemetry; and late old-owner
   resume. Each fixture records expected P/C head/revision, active claim hash,
   action, side-effect class and slot outcome.
3. **Provider contract faults.** Concurrent same exact tuple must return one
   stable handle and at most one marker/job per `(admissionId, attemptId)`.
   Same key/different request digest must conflict with no second marker;
   missing contract must fail before E1/reservation; provider disappearance after
   SubmitStarted must retain slot/possible; foreign or mismatched returned
   handles must never terminalize, release, or issue a Receipt.
4. **Production handover.** A3/A4 positive tests must use a real P13
   holder-authenticated transfer, not `skipSingleton`, with two live writers
   and a barrier immediately before old/new owner P CAS and provider boundary.
   Test-only bypasses must be rejected by daemon/CLI/MCP/Pi shipped entrypoints.
5. **Approval route.** Exercise every row of §7.3, including crash between
   P release intent/C release, C release/P observation, P observation/child E0,
   and child E0/E1. Retain a production fail-close test until the V2 route and
   P16-2 release capability exist.
6. **Migration matrix.** Reopen all §9.3 legal combinations plus every
   neighboring mismatch: one P2 prepared project missing, an unregistered P1,
   C3 pending with stale envelope, C3 active with P2 preparing, old binary
   reopen, and interrupted M0--M5. Assert no ordinary mutation/marker and that
   only the named migration owner can resume.

### Green acceptance

1. 32 processes contend on same/different commands with barriers at every
   transition; every round asserts one-to-one command/admission/run/
   reservation/owner/attempt links, occupancy at most max, and at most one
   provider handle/marker per `(admissionId, attemptId)`;
2. standalone, daemon, UDS attach, CLI, MCP and shipped Pi use one API;
3. cross-principal/hash mismatch has zero P/C/provider side effects;
4. record state bytes, entries, live/expired/released count, lock wait
   p50/p95/max, admission latency p50/p95/max, RSS, deadline breaches and
   typed errors; P16-3 remains open until a bounded 32 by 100 proof; and
5. retain existing negative counterexamples until a named new authority turns
   each into a safety proof.

For every round SCRATCH must bind base SHA, dirty list, **P16-1R content
SHA-256**, ADR revision, red/green commands and exits, raw P/C evidence/IDs,
per-attempt marker/handle counts, counterexample status, independent
architecture/robustness/performance review, and a SHA-256 manifest. Run focused
tests, owning suite, pnpm test, pnpm run test:control, pnpm run test:daemon,
pnpm run test:cli, typecheck, build/clean-consumer when relevant, and git diff
--check. Local green output is not GA or push/tag/publish authority.

## 11. Rejected shortcuts and completion boundary

| Shortcut | Rejection reason |
|---|---|
| retry once after SlotCommitted | cannot distinguish a dead writer from one about to submit |
| treat executing/prepared as success | neither proves a provider owner or call |
| new reservation after exception | hides split evidence and can double capacity |
| caller epoch/sequence | public/stale/forgeable, not cross-store proof |
| TTL committed release | violates D37 and may release a live/ambiguous run |
| hold both locks over provider call | deadlock/stall and still not atomic for remote provider |
| local schema-1 owner flag | mixed readers can ignore/reinterpret it |
| wall-clock takeover | elapsed time does not prove old writer stopped |
| provider key alone | does not establish P/C authority, migration or release |

This design artifact is ready for implementation only after independent review
finds no unassigned transition, missing tuple field, ambiguous side-effect
classification, undefined migration state or untestable crash cell.

Even then, P16-1R can become **local-saga PARTIAL** only after every stated
local crash/identity/migration/approval-route test is proven with a production
writer handover. P16, P15, D16, D24, D30, D34, D37, D38, §23.6, §23.7,
§23.11 and §23.12 remain FAIL until their independent P13/P14/P16-0/P16-2/
P16-3/provider/pressure/entrypoint gates close. No tag, publish or GA claim
follows from this ADR.
