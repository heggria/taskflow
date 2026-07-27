# RFC: Hierarchical Adaptive Taskflow

> **Document version:** v4
> **Status:** Architecture closed; H1–H6 accepted; P-ADR and implementation not started
> **Branch:** `feat/0.3.0`
> **Date:** 2026-07-24
> **Last updated:** 2026-07-25
> **Target:** Post-0.3 architecture; version assignment is intentionally deferred
> **Origin:** Product co-design discussion
> **Closure Goal:**
> [`hierarchical-adaptive-taskflow-rfc-closure-goal.md`](./hierarchical-adaptive-taskflow-rfc-closure-goal.md)
>
> This RFC does not enter or alter the 0.3 wire-freeze scope. It defines the
> adaptive hierarchy that may be built above the 0.3 Control Plane after
> separate protocol, storage, migration, and executable-schema review.

**Normative foundations:**

- [`rfc-0.3.0-control-plane.md`](./rfc-0.3.0-control-plane.md)
- [`rfc-workspace-capabilities.md`](./rfc-workspace-capabilities.md)

**Contextual design history, not whole-document normative dependencies:**

- [`rfc-flowir-compilation.md`](./rfc-flowir-compilation.md) is superseded in
  part; its historical shadow/vendor plan does not override the shipped
  self-owned FlowIR compiler.
- [`design-dynamic-dag-expansion.md`](./design-dynamic-dag-expansion.md)
  explains the original nested `flow{def}` safety decision; it predates current
  `expand` graft behavior and does not define the post-0.3 Segment protocol.

Current implementation claims in this RFC must cite current source/tests or be
labelled **specified**, **target**, or **open**. Architectural TypeScript shapes
are illustrative until their follow-up P-ADR and executable schema freeze.

---

## §0. Executive summary

Taskflow must evolve beyond a collection of static workflows without becoming
an ungoverned self-modifying Agent.

The target product is:

> **A hierarchical, project-aware AI work execution system. A long-lived
> Project Taskflow accepts Goals, forks isolated Goal Branches, dynamically
> composes versioned Component Taskflows, adapts while working, and promotes
> only verified experience into future project behavior.**

The hierarchy is:

```text
Stable Control Kernel
└── User Taskflow
    ├── Project Taskflow A · Main vN
    │   ├── Goal Branch A1
    │   ├── Goal Branch A2
    │   └── Project-local Components
    ├── Project Taskflow B · Main vM
    │   └── Goal Branch B1
    └── User-scoped Component Registry
```

The central distinction is:

```text
Goal              = what the user wants
Project Taskflow   = how this project reliably gets work done
Goal Branch        = isolated, online-adaptive work toward one Goal
Plan Segment       = one immutable, executable portion of a changing plan
Component Taskflow = one reusable capability
Run / Attempt      = actual execution
Receipt            = evidence of what happened and what was verified
```

A Project Taskflow Main is **not** a permanently growing DAG. It is a
versioned project execution model that generates, constrains, and evaluates
Goal-specific plans.

Goal-local learning is immediate. Project-wide learning is promoted only after
tests, replay, risk classification, and evidence. User-wide or cross-project
learning has a higher bar and never merges project journals.

The execution seam is:

```text
Goal Branch revision
→ immutable Planning Segment from the pinned Planner Component
→ controlled Planning Run
→ Receipt + Branch Proposal Artifact
→ kernel validation + Branch Revision CAS
→ immutable Work Segment
→ controlled Work Run
→ Receipt-backed Workflow Outcome
→ next Goal Branch revision
```

A Run may still instantiate immutable BoundFragments at dynamic expansion
points authorized by its BoundPlan. It may not become an open-ended mutable
container for later Goal replanning.

Every model or external-effect invocation—including routing, clarification,
planning, review, evidence synthesis, completion verification, and Candidate
extraction—executes through the same Run/Attempt/provider/Receipt kernel.
Supervisors and stores never call a model or effect provider directly. Pure,
deterministic folding, validation, projection, and Link operations may execute
inside the Control Kernel without creating a Run.

In this RFC, an **external effect** means an execution-provider, tool, script,
network, workspace, or other domain action outside the kernel's own
Command-authorized journal and Artifact persistence. Internal durable commits
are Commands, not Runs.

A narrowly audited **Control Kernel platform primitive** is not a general
external-effect escape hatch. It may initiate an OS process only when its
executable and arguments are fixed by kernel code, no user/model/project
payload influences them, and it performs authority plumbing such as process
birth observation, file locking, atomic persistence, or fencing. It must not
call a model, access arbitrary network services, execute project scripts, or
mutate project-domain resources. Every such primitive is named in a repo-wide
allowlist and covered by conformance tests; all other process creation belongs
behind a controlled `ExecutionProvider`.

This RFC deliberately makes no AGI claim. It defines a route toward increasingly
general, long-lived task execution while preserving authority, isolation,
replay, rollback, and honest uncertainty.

---

## §1. Problem

The current Taskflow product model is centered on:

```text
Program → BoundPlan → Run → Receipt
```

This is a sound control-plane foundation, but it does not express the intended
long-term product:

1. A user thinks in **Goals**, not Program names or Run ids.
2. One Goal may require multiple Runs, retries, providers, or Workflows.
3. One project should accumulate a durable way of working across many Goals.
4. A Goal must be able to revise its future plan as new evidence arrives.
5. Useful project experience should improve later Goals without allowing one
   bad Run to contaminate the project.
6. Similar projects should reuse versioned Components without sharing raw
   project state or authority.
7. A user-level system should route arbitrary Goals to an existing project or
   bootstrap a new Project Taskflow without becoming a merged user-level Run
   ledger.

Treating each Run as a user-visible Task cannot satisfy these requirements.
Treating one enormous DAG as the project is also incorrect: it grows without a
stable abstraction boundary, mixes unrelated Goals, and makes hot adaptation
unsafe.

The missing layer is a hierarchy of durable execution models and isolated
adaptive branches.

---

## §2. Product positioning

### 2.1 Product sentence

> Taskflow receives Goals from users or supported Hosts, organizes reliable
> execution across Agents, scripts, humans, and tools, preserves continuity
> across time, and turns verified outcomes into scoped future capability.

### 2.2 Taskflow owns

- Project-level execution continuity.
- Goal-to-Run and Goal-to-evidence lineage.
- Dynamic planning within explicit authority.
- Component selection and version pinning.
- Isolation between concurrent Goals.
- Durable events, Artifacts, Receipts, replay, and rollback.
- Verified project-level promotion.
- Explicitly authorized user-level or cross-project capability promotion.

### 2.3 Taskflow does not own

- The user's ultimate intent or values.
- An unrestricted claim that every Goal is solvable.
- A replacement for Codex, Claude, Pi, OpenCode, Grok, or another reasoning
  Runtime.
- A Jira/Linear-style project-management database.
- A merged user-level journal containing all project Runs.
- Silent authority expansion.
- Raw self-modifying executable code.
- Automatic promotion of unverified model output or raw trajectories.

### 2.4 “Any Goal” means capability discovery, not guaranteed success

A User or Project Taskflow may accept an open-ended Goal. Acceptance means it
will:

1. bind the Goal to an authority and project scope;
2. determine whether current capabilities are sufficient;
3. ask for missing constraints when necessary;
4. create or select a safe plan;
5. attempt execution with bounded adaptation;
6. verify completion honestly; and
7. refuse, pause, or report uncertainty when the Goal cannot be safely
   completed.

“Accept any Goal” must never be marketed as “guarantee any outcome.”

---

## §3. Architecture decisions

| ID | Decision |
|----|----------|
| **A1** | One registered project has one logical **Project Taskflow Main** lineage. |
| **A2** | Project Taskflow Main is a versioned execution model, not one giant DAG or one mutable process. |
| **A3** | Every unit of user work is a durable **Goal**. One Goal may own multiple Branches and Runs. |
| **A4** | Each Goal executes in one or more isolated, append-only **Goal Branches**. |
| **A5** | Goal Branches may adapt online: update working context, hypotheses, future plan, and Component selection. |
| **A6** | Goal-local adaptation does not mutate Project Main and does not require promotion. |
| **A7** | A change that should affect future Goals becomes an **Experience Candidate** and requires validation and promotion. |
| **A8** | Low-risk, project-local candidates may auto-promote only after executable tests, replay, and risk gates pass. |
| **A9** | Project constitution, authority, permission ceilings, and minimum verification requirements never auto-promote. |
| **A10** | Project Main promotion uses immutable versions and an atomic current-version pointer. No in-place mutation. |
| **A11** | Existing Goals remain pinned by default. They may adopt a promoted version only at a safe planning/checkpoint boundary. |
| **A12** | An in-flight Attempt is never hot-swapped. Side effects are reconciled before retry, migration, or reuse. |
| **A13** | Plans are emitted as immutable **Plan Segments**, represented by BoundPlans/BoundFragments or a compatible successor. |
| **A14** | Reuse is correctness-preserving and evidence-based; “maximize reuse” never overrides semantic invalidation. |
| **A15** | Static Taskflow definitions become Component Taskflows or Goal-specific Plan inputs, not the Project Main identity. |
| **A16** | A **User Taskflow** may route Goals and bootstrap Project Taskflows, but it does not own merged project Run history. |
| **A17** | Project experience is private by default. Cross-project promotion requires abstraction, redaction, authorization, and broader replay. |
| **A18** | Stable Control Kernel and adaptive strategy are separate. The kernel does not self-modify. |
| **A19** | Simple UI presents Goals and outcomes; Branch, version, hash, Run, Attempt, and promotion mechanics are Pro detail. |
| **A20** | This architecture may increase system generality but is not, by itself, evidence of AGI. |
| **A21** | A Goal Branch's mutable “current understanding” is a projection obtained by folding immutable, append-only Branch Revisions. |
| **A22** | One Plan Segment execution maps to one Run. Retry and reconcile remain Attempts inside that Run; replan, fork, or Main adoption creates a new Segment and Run. |
| **A23** | Run-local dynamic Taskflow remains supported only through pre-authorized expansion points that Link immutable BoundFragments under the parent BoundPlan. |
| **A24** | A Workflow never mutates a Goal Branch directly. It produces durable evidence; a Branch Supervisor validates and CAS-commits the next Revision. |
| **A25** | Agents are configurable planners, executors, synthesizers, and verifiers. They propose or execute; they do not become journal, permission, completion, or promotion authority. |
| **A26** | A Goal states what the user wants. Agent selection belongs to User/Project Taskflow policy and Component Taskflows, then becomes version-pinned at Link. |
| **A27** | Pure event replay is effect-free. Planner shadow, fixture execution, and live canary are distinct controlled Run modes with explicit domain-effect limits and attenuated authority. |
| **A28** | `unknown` is non-terminal for Goals and Branches whenever work or external side effects may still exist. Status and control stage are modeled separately. |
| **A29** | Every model or external-effect invocation, including Goal routing, planning, review, synthesis, verification, and Candidate extraction, occurs inside exactly one controlled Run and its Attempt/provider lifecycle. One Run may contain multiple phase Attempts. |
| **A30** | Goal Supervisors, Branch Supervisors, stores, reducers, and projections never call a model SDK, Host runner, script provider, or other effect provider directly. There is one execution runtime. |
| **A31** | Pure deterministic folding, validation, hashing, projection, policy evaluation, and Link may execute inside the Control Kernel without a Run, but must not perform model calls or external effects. |
| **A32** | A model-based pre-project router or bootstrapper requires a future user-scoped ControlDomain owned by UserTaskflowStore or equivalent. It never runs through UserCoordinatorStore and never becomes a merged project Run ledger. |

---

## §4. Human model

| Concept | Plain language |
|---------|----------------|
| **User Taskflow** | The user's long-lived router and Project Taskflow bootstrapper. |
| **Project Taskflow Main** | The current trusted way this project gets work done. |
| **Project Taskflow Version** | One immutable revision of the project's execution model. |
| **Goal** | A durable statement of what the user wants to accomplish. |
| **Goal Branch** | An isolated line of work that may learn and revise its plan while pursuing a Goal. |
| **Branch Revision** | One append-only change to branch context, assumptions, or future plan. |
| **Branch Snapshot** | The current projection obtained by folding immutable Branch Revisions and their evidence. |
| **Plan Segment** | One immutable portion of a Goal's executable plan. |
| **Control Segment** | A Plan Segment whose pinned Component performs routing, planning, synthesis, verification, Candidate extraction, or another governed control activity. |
| **Planning Run** | A normal controlled Run for a Planning Segment; its Agent output is a Proposal Artifact, not a committed Branch Revision. |
| **Workflow Outcome** | A Receipt-backed summary of verified facts, hypotheses, unknowns, Artifacts, and remaining obligations from one Work Run and any supporting Control Runs. |
| **Component Taskflow** | A reusable capability such as analysis, implementation, testing, review, or release. |
| **Agent Role Binding** | A versioned mapping from a governed role such as planner or verifier to an Agent definition and model policy. |
| **Experience Candidate** | A proposed change that may be useful beyond the current Goal. |
| **Promotion** | Verified adoption of a Candidate into Project Main or a wider scope. |
| **Constitution** | Human-governed project rules, authority ceilings, and minimum completion requirements. |

### 4.1 Authority classification and minimal ontology

The product vocabulary is intentionally larger than the authority model. A
name shown in the UI or exchanged as an Artifact does not automatically become
an independently writable aggregate.

| Object | Classification | Unique responsibility | Authority and write rule |
|--------|----------------|-----------------------|--------------------------|
| Project Taskflow Main lineage | authority aggregate | Select the current trusted project execution model | Project ControlStore; only an authorized promotion or rollback Command may CAS the current-version pointer |
| ProjectTaskflowVersion | immutable record | Pin one complete manifest of project execution-model references | Project ControlStore; create once, never add promotion state in place |
| Goal | authority aggregate | Preserve user intent, provenance, revisions, and terminal disposition | Project ControlStore after project acceptance; append Goal events only |
| GoalRecord | immutable record | Capture the original accepted Goal and source | Created once by Goal acceptance; later clarification is a Goal revision, not an overwrite |
| GoalBranch | authority aggregate | Order one isolated approach's Revisions and lifecycle decisions | Project ControlStore; one fenced writer advances it by CAS |
| GoalBranchRecord | immutable record | Identify the Branch, fork point, base Main version, and workspace binding | Created once when the Branch is forked |
| GoalBranchRevision | immutable record | Interpret evidence and bind the next immutable Segments at one revision number | Appended only by a validated Branch commit Command with `expectedRevision` |
| PlanSegmentBinding | immutable record | Bind one Segment definition and provenance to at most one execution Run identity | A Control Segment is linked on the existing Revision by Branch-scoped `LinkControlSegment`; a Work Segment may be linked by `CommitBranchRevision`; admission binds the stable Segment identity idempotently |
| Run / Receipt | existing 0.3 authority records | Execute one immutable bound plan and attest its observed outcome | Existing 0.3 ControlStore, event, provider, and Receipt rules |
| ExperienceCandidate / Promotion | immutable lifecycle records | Propose, validate, widen, adopt, or roll back scoped experience | Project ControlStore for project scope; wider scopes require their own authority and Promotion record |

The following are deliberately not independent authority aggregates:

| Object | Classification | May contain | Must not do |
|--------|----------------|-------------|-------------|
| BranchSnapshot | rebuildable projection/cache | Folded Branch head, effective context, pending obligations | Advance a Branch, overwrite a Revision, or survive a contradictory journal as truth |
| WorkflowOutcome | Receipt-backed Artifact | Typed facts, hypotheses, unknowns, evidence references, remaining obligations | Replace Run events/Receipt or independently settle a Branch |
| Observation | typed evidence claim in an Artifact or Branch Revision | Claim, classification, source reference, validity state | Become objective truth without reachable Evidence |
| CompletionAssessment | Artifact/projection | Contract evaluation and supporting evidence references | Make Goal or Branch terminal; only a completion Command can do that |
| AgentInvocation | Run event/provenance | Resolved Agent, model, prompt, tool, input, output, and causation pins | Form a second scheduler or invocation ledger outside the Run stream |
| UI progress | projection | User-facing current state and uncertainty | Mutate or reconstruct authority |

This classification is normative at the architecture level. Exact schemas,
event names, and Command batches remain follow-up P-ADR work.

The minimal-ontology audit closes the eight responsibility questions:

| First-class entity | Stable identity / immutable content | Create or advance Command | Lifecycle / recovery | Why it is not only a projection |
|--------------------|-------------------------------------|---------------------------|----------------------|---------------------------------|
| ProjectTaskflowVersion + Main lineage | version id; full manifest and digest immutable; current pointer is separate | candidate creation; `PromoteProjectMain` / `RollbackProjectMain` CAS pointer | versions are retained, never terminalized; pointer recovery folds Promotion records | exact historical policy/component pins must survive later Main changes |
| Goal | `goalId`; original GoalRecord/source immutable | `AcceptGoalAndForkInitialBranch`, `ReviseGoalDisplay`, `ReviseGoalSemantics`, `DecideGoalTerminal` | append-only display/semantic revisions; one terminal Command; stale writers fail CAS | user intent and authorized terminal decision cannot be reconstructed from Runs alone |
| GoalBranchRevision | `(goalBranchId, revision)`; evidence interpretation and Segment links immutable | `CommitBranchRevision`; fork creates child Revision 0 | contiguous CAS sequence; losing proposal remains evidence | it records which evidence and future plan the project authority accepted |
| PlanSegmentBinding | `segmentId`; purpose, BoundPlan, pins, input snapshot, authority, admission key immutable | `LinkControlSegment` or `CommitBranchRevision`; `BindSegmentRun` once | admission retries recover one Run identity; validity changes are events/projections | exact execution intent and provenance precede and constrain the Run |
| Run / Receipt | existing 0.3 ids and immutable bound execution/proof records | existing ControlHost admission, provider, terminal, and Receipt Commands | 0.3 Attempt/reconcile/fencing rules | they are the authority for what execution was attempted and observed |
| ExperienceCandidate / Promotion | candidate/promotion ids; delta, source Evidence, validation and scope transition records immutable | record/validate Candidate; promote/rollback under scope writer | lifecycle is an event fold; promotion pointer CAS is recoverable | widening scope is an authorization decision, not derivable from successful output |

`GoalBranchRecord` is the immutable identity/fork anchor for the
`GoalBranchRevision` stream, not an additional mutable head. Other names in the
human model remain projections, Artifacts, events, or policy manifests as
classified above.

The intended user story is:

```text
Connect project
→ submit or observe Goal
→ Project Taskflow forks Goal Branch
→ Branch plans and adapts while executing
→ user intervenes only when needed
→ result is verified and evidenced
→ useful experience may improve future Goals
```

---

## §5. Target hierarchy

```text
Stable Control Kernel
│
├── authority / policy enforcement
├── scoped stores and journals
├── scheduler and isolation
├── provider lifecycle and reconcile
├── Artifact / Receipt / replay / rollback
└── version switching and promotion enforcement

User Taskflow Main
│
├── user preferences and non-project constraints
├── project registry projection
├── project bootstrap templates
├── user-scoped Component Registry
└── Goal router / project binder

Project Taskflow Main
│
├── Constitution
├── Adaptive Strategy
├── Component Registry and pins
├── Completion Contracts
├── Verified Project Experience
└── Promotion Policy

Goal
│
├── Goal Branch A
│   ├── Working Context
│   ├── Branch Revisions
│   ├── Plan Segments
│   ├── Runs / Attempts
│   ├── Artifacts / Receipts
│   └── Experience Candidates
└── Goal Branch B
    └── alternative or forked strategy
```

The hierarchy is recursive only above a stable root. A Taskflow may generate
another Taskflow, but generation, linking, authority attenuation, persistence,
and promotion remain enforced by the non-self-modifying Control Kernel.

---

## §6. Project Taskflow Main

### 6.1 Main is a generator, constraint, and evaluator

Project Main answers five questions:

1. What rules and authority govern work in this project?
2. What capabilities are available?
3. How should a Goal be interpreted and planned?
4. What evidence is required before completion can be claimed?
5. What verified experience should influence future Goals?

It does not contain all future Goals or all future DAG nodes.

### 6.2 Main composition

```ts
interface ProjectTaskflowVersion {
  projectTaskflowVersionId: string;
  projectId: string;
  parentVersionId?: string;

  constitutionRef: string;
  adaptiveStrategyRef: string;
  componentRegistryRef: string;
  completionContractRef: string;
  verifiedExperienceRef: string;
  promotionPolicyRef: string;
  agentRoleBindingsRef: string;

  contentDigest: string;
  createdAt: number;
}
```

This is an architectural shape, not a frozen wire schema.

Promotion time, actor, validation Evidence, and pointer movement belong to an
immutable Promotion record and the Main lineage projection. They are not fields
later patched onto `ProjectTaskflowVersion`.

### 6.3 Stable constitution

The Constitution contains human-governed invariants:

- project identity and binding;
- workspace and secret boundaries;
- tool and provider ceilings;
- effects requiring approval;
- forbidden actions;
- minimum validation;
- completion and evidence requirements;
- retention, privacy, and export rules;
- which classes of change may auto-promote.

The Constitution may be revised through an explicit authorized command. It is
not updated by ordinary Goal learning.

### 6.4 Adaptive strategy

The adaptive portion may contain:

- Goal classification heuristics;
- decomposition and planning strategies;
- preferred Component selection;
- ordering rules;
- project-specific failure patterns;
- verified diagnostic shortcuts;
- reuse heuristics bounded by semantic predicates;
- project terminology and structural knowledge;
- escalation and clarification heuristics.

Adaptive strategy is versioned and promotable. It is not authoritative for
permissions or objective provider state.

### 6.5 Agent role configuration

Agents participate through versioned roles rather than becoming fields on the
authoritative Goal:

```ts
interface AgentRoleBindings {
  goalPlanner: ControlledAgentRoleBinding;
  planReviewer?: ControlledAgentRoleBinding;
  evidenceSynthesizer?: ControlledAgentRoleBinding;
  completionVerifier?: ControlledAgentRoleBinding;
  candidateExtractor?: ControlledAgentRoleBinding;
}

interface ControlledAgentRoleBinding {
  componentRef: string;
  componentVersion: string;
  agentBindingRef: string;
  modelPolicyRef: string;
  toolPolicyRef: string;
  outputContractRef: string;
}
```

This is an architectural shape, not a frozen wire schema.

The effective binding is attenuated:

```text
effective Agent capability
= Host ceiling
∩ User defaults
∩ Project Constitution and Main pins
∩ Component requirements
∩ Goal or Segment invocation override
```

A Goal invocation may request a governed execution profile or Agent preference.
It may not enlarge the effective capability or silently replace a pinned Agent
definition. The resolved Agent definition digest, model identity, prompt digest,
tool schema, Component version, Project Main version, and Branch revision are
recorded in Link and invocation provenance.

A role binding always resolves to a versioned Component Taskflow. That
Component contains the existing phase-level `agent` configuration and is Linked
into a Control Segment before invocation. Project Main does not hold a callable
model object, and the Branch Supervisor does not call the resolved Agent
directly.

For example:

```text
Branch needs a new plan
→ deterministically Link Planning Segment from goalPlanner Component pin
→ admit Planning Run through ControlHost
→ execute planner Agent as one or more ordinary Component phases
→ persist Proposal Artifact + Receipt
→ validate Proposal
→ CAS-commit next Branch Revision and Work Segment links
```

Routing, clarification, plan review, evidence synthesis, completion
verification, and Candidate extraction follow the same rule whenever they use a
model or external effect. Pure deterministic implementations of those roles may
run inside the kernel without a Run only if their inputs and outputs are fully
defined and they perform no model or external-effect call.

#### 6.5.1 Role resolution and pinning

Role resolution is deterministic control logic:

1. read the exact Project Main version and required governed role;
2. resolve its pinned Component reference/version and Agent-role policy;
3. apply Host ceiling, user defaults, Constitution, Component requirements,
   and invocation request by intersection;
4. resolve one allowed Agent definition and model/tool policy from the scoped
   registry;
5. validate Component input/output contract, required provider capabilities,
   effect policy, budget, and context limits;
6. persist the resolved identities/digests in the immutable Segment Link; and
7. recheck those pins before provider dispatch.

Minimum provenance is:

```text
role and purpose
Project Main and Component version/digest
Agent definition identity/digest
model provider, model id/version when observable, and model policy digest
prompt template/system policy/rendered-input digest
tool schema and tool-policy digest
Branch Snapshot and input Artifact digests
Host runner/provider implementation version
substitution/request provenance
output contract and validation version
```

Raw prompt content is retained only under explicit privacy policy; its digest
and any required encrypted/controlled Artifact reference preserve auditability.
Hidden chain-of-thought is neither required provenance nor Promotion Evidence.
If the provider does not expose an exact model version, provenance records
`unavailable`; the system must not claim bitwise replay or use that absence as
equivalence proof.

A user may request a concrete Agent only when Project Main explicitly exposes
that binding as selectable. Otherwise the user selects a governed execution
profile. In both cases the request can only narrow the allowed set, and the
resolved binding is pinned at Link. This preserves configurable Agents without
turning invocation input into authority expansion.

#### 6.5.2 Substitution and failure behavior

Substitution is forbidden by default. It is allowed only when a versioned role
policy explicitly names a compatible substitute and proves:

```text
same role/output contract
no broader tools, secrets, effects, or authority
compatible context and provider capabilities
budget acceptance
recorded model/Agent identity change
required revalidation/replay class
```

Substitution before Link produces a Segment with the substitute pin.
Substitution after Link requires a new Segment and Run; an existing or
in-flight Segment is never silently rebound.

| Failure | Required behavior |
|---------|-------------------|
| role/Component/Agent definition missing | fail Link or wait for explicit configuration; no default-Agent drift |
| pinned definition digest changed before dispatch | deny dispatch; re-resolve and Link a new Segment |
| requested concrete Agent is outside allowed set | reject request with effective policy explanation |
| primary model/provider unavailable | use only an explicit compatible substitute before Link; otherwise wait/blocked |
| provider reports a different model identity | mark provenance mismatch and fail/unknown according to observability; never attest the requested pin |
| required tool/provider capability absent | fail Link; do not drop the tool or weaken the contract |
| prompt/context exceeds governed limit | apply only a pinned deterministic compaction policy with digest/provenance, or reject/request narrower input |
| Agent output is malformed or violates output contract | reject Proposal/output; retry as another Attempt only when Run policy permits, otherwise settle Run and create a new planning decision |
| Agent output requests unauthorized Segment/effect | reject before Link; record policy violation; never partially commit allowed fields |
| Agent claims completion without sufficient Evidence | Completion Assessment remains unsatisfied/unknown |
| cancellation cannot prove provider stopped | keep Run and Branch reconciling; no substitute Run for conflicting work |

### 6.6 Completion contracts

A Goal cannot be marked complete only because an Agent says it is done.

Completion contracts define:

- required outputs;
- required tests or verifiers;
- allowed unavailable states;
- required human decisions;
- side-effect settlement requirements;
- Receipt assurance requirements;
- project-specific Definition of Done.

An adaptive Candidate may strengthen a completion contract automatically if
the Constitution permits it. Weakening a required contract is never low risk.

---

## §7. Goal and Goal Envelope

### 7.1 Goal is the unit of user work

A Goal persists independently of any one Workflow or Run:

```ts
interface GoalRecord {
  goalId: string;
  projectId: string;
  title: string;
  description?: string;
  source: GoalSource;
  createdAt: number;
}

interface GoalProjection {
  goalId: string;
  effectiveTitle: string;
  effectiveDescription?: string;
  status: GoalStatus;
  stage: GoalStage;
  currentDisplayRevision: number;
  currentSemanticRevision: number;
  completionContractDigest: string;
  updatedAt: number;
}

interface GoalSource {
  kind: "pi" | "codex" | "claude" | "opencode" | "grok" | "taskflow-cli" | "web";
  externalGoalId?: string;
  principalId: string;
  capturedAt: number;
}
```

An unbound pre-project request is a `GoalEnvelope` in the future user
ControlDomain, not a partially authoritative project Goal. Direct project-bound
submission may skip durable user routing. Project Goal identity begins only
when `AcceptGoalAndForkInitialBranch` commits the Goal, initial Branch, and
Revision 0 under Project ControlStore authority.

The Goal title is supplied by the user or initiating Host. Taskflow may propose
a clearer display title, but it must preserve source and revision provenance.
Agent prose is never silently promoted into the authoritative original Goal.
`GoalProjection` is rebuilt from `GoalRecorded`, ordered Goal revisions,
Branch lifecycle events, the Completion Contract, and completion Commands. It
is not independently writable.

Goal revisions have two non-interchangeable classes:

| Class | May change | Planning/effect consequence |
|-------|------------|-----------------------------|
| `display` | title, summary, user-facing wording that preserves the accepted semantic intent | updates `currentDisplayRevision`; does not invalidate a Segment |
| `semantic` | intent, constraints, required outputs, authority-relevant choices, or Completion Contract | increments `currentSemanticRevision`; changes the Completion Contract digest when applicable and stales every unsubmitted plan pinned to the prior semantic revision |

Under accepted H2, a Host title change is a proposed display revision unless an
explicit trusted-source policy accepts it. Any ambiguity about whether wording
changes meaning is semantic and requires project-authority validation; it never
defaults to display-only.

### 7.2 Goal is not a project-management ticket

Taskflow stores only what is required to execute and explain work:

- user-readable intent;
- provenance;
- current execution disposition;
- Branch and Run lineage;
- result and verification lineage.

Assignees, sprints, roadmaps, arbitrary labels, and organization workflows are
out of scope unless a future integration references an external system.

### 7.3 One Goal, many Runs

```text
Goal: Fix cursor pagination continuity
├── Run 1 · Project Main v12 · failed verification
├── Run 2 · Project Main v12 · resumed with new plan
└── Run 3 · Project Main v13 · reused valid artifacts · completed
```

Prior Runs remain immutable evidence. Later success does not erase failed or
uncertain history.

---

## §8. Goal Branch

### 8.1 Purpose

A Goal Branch is the online-adaptive scope for one approach to one Goal.

It allows Taskflow to “learn while working” without mutating Project Main or
contaminating concurrent Goals.

### 8.2 Branch contents

```ts
interface GoalBranchRecord {
  goalBranchId: string;
  goalId: string;
  projectId: string;
  parentGoalBranchId?: string;
  forkedFromRevision?: number;

  baseProjectTaskflowVersionId: string;
  initialWorkspaceBindingRef: string;
  createdAt: number;
}

interface GoalBranchProjection {
  goalBranchId: string;
  currentRevision: number;
  status:
    | "active"
    | "waiting-for-input"
    | "completed"
    | "failed"
    | "blocked"
    | "cancelled"
    | "superseded"
    | "unknown";
  stage:
    | "planning"
    | "queued"
    | "executing"
    | "reconciling"
    | "terminal";

  updatedAt: number;
}
```

`GoalBranchRecord` is immutable. `GoalBranchProjection` is rebuilt from the
Branch event stream and may be cached with its folded-through event position;
it is never a separately writable Branch head.

### 8.3 Branch-local adaptation is immediately eligible for the next Revision

Without waiting for Project Promotion, a validated Branch commit may append:

- Working context.
- Observations and hypotheses.
- Goal-local memory.
- Future Plan Segments.
- Component selection and configuration.
- Local Component candidates.
- Verification additions.
- Expected affected-set and reuse decisions.

“Immediately” means the next fenced, append-only Branch Revision after
validation. It never means an Agent or projection mutates the current Snapshot
in place.

### 8.4 Branch may not

- Rewrite committed events.
- Delete or mutate immutable Artifacts or Receipts.
- Change the original Goal without a recorded Goal revision.
- Expand authority, tools, providers, secret access, or effects.
- Weaken Constitution-required verification.
- Mutate Project Main directly.
- Publish project-private experience to user or shared scope.
- Treat an unverified Agent conclusion as objective truth.

### 8.5 Branch revisions are append-only

Each online change records:

```text
goalBranchId
revision
causationEventId
evidenceClaimRefs
invalidationRefs
priorPlanSegmentRefs
newPlanSegmentRefs
reasonProjection
goalSemanticRevision
completionContractDigest
projectTaskflowVersionId
componentPins
workspaceBindingRef
createdAt
```

The user-facing reason is a deterministic presentation projection. Raw model
reasoning is not required and must not be treated as authority.

### 8.6 Mutable head, immutable revisions

The Git branch analogy is useful if its authority boundary is preserved:

```text
Git branch ref                 Goal Branch
current commit pointer         currentRevision
immutable commit chain         immutable Branch Revision chain
worktree                       workspace binding + working context
merge decision                 explicit Branch selection / adoption decision
```

A Goal Branch is a logical execution branch, not necessarily a Git branch. A
coding Goal may bind it to an isolated worktree, but research, operations, and
other Goals use the same Branch model without Git.

Only the current head projection changes. Previously committed Revisions,
Segments, Runs, Attempts, Artifacts, and Receipts never change.

### 8.7 Branch Revision proposal and commit

An Agent does not write a Branch directly. It returns a structured proposal
against an exact Revision:

```ts
interface GoalBranchProposal {
  goalBranchId: string;
  expectedRevision: number;
  expectedGoalSemanticRevision: number;
  completionContractDigest: string;
  evidenceClaimRefs: string[];
  userInputRefs: string[];
  invalidateSegmentRefs: string[];
  nextSegmentDefs: unknown[];
  componentPins: Record<string, string>;
  completionAssessmentRef: string;
  reasonProjection: string;
}
```

The Branch Supervisor:

1. reads one coherent Branch Snapshot at Revision `N`;
2. deterministically Links a Planning Segment from the pinned planner Component
   and that exact Snapshot;
3. admits and executes the Planning Run through the ordinary ControlHost;
4. retrieves its Receipt and structured Proposal Artifact;
5. validates the proposal schema and evidence reachability;
6. verifies that the semantic Goal revision and Completion Contract digest still
   match the Planning Run input;
7. enforces Constitution, authority, budget, effect, and completion constraints;
8. Compiles and Links every proposed Segment;
9. commits Revision `N+1` and its Segment links using
   `expectedRevision: N` plus the expected semantic Goal revision; and
10. rejects a loser with `TF_STALE_VERSION`, which must reload and replan.

A crash before commit changes nothing. A crash after commit is recovered by the
same idempotent command and journal projection; it must not create a second
Revision or duplicate Segment.

The Planning Run itself is durable work bound to Revision `N`. If its provider
outcome is ambiguous, the Branch remains non-terminal and reconciling; the
Supervisor cannot bypass it by directly calling the planner again.

---

## §9. Plan Segments and online adaptation

### 9.1 Rolling plan

Taskflow should not require a complete immutable DAG for the entire Goal.
Instead:

```text
Goal Branch
├── Segment 1 · completed · immutable
├── Segment 2 · executing · immutable
└── future plan · revisable
```

When new evidence arrives:

```text
observe
→ update Goal-local context
→ validate authority and constraints
→ preserve settled Segments
→ invalidate only affected pending work
→ emit and Link the next immutable Segment
→ continue
```

### 9.2 Segment execution boundary

The normative mapping is:

```text
one Plan Segment execution
→ one immutable BoundPlan
→ one Run
→ zero or more Run-local BoundFragments
→ one terminal Receipt, or an honest non-terminal unknown/reconcile state
```

The Goal-level Segment binding classifies purpose without changing the 0.3 Run
wire:

```text
work
control:route
control:clarify
control:plan
control:review
control:synthesize-evidence
control:verify-completion
control:extract-candidate
control:replay
```

Retry, timeout, provider reconcile, and approval continuation remain inside that
Run. Replanning, Goal Branch fork, Project Main adoption, or a changed Segment
contract creates a new Segment and Run.

Every Segment records its producing Goal Branch revision, semantic Goal
revision, Completion Contract digest, Project Taskflow version, Component pins,
authority epoch, context snapshot, completion obligations, and causation.

### 9.3 Run-local dynamic Taskflow

A Run remains dynamically expressive without becoming mutable:

```text
Segment S1
└── Run R1
    └── BoundPlan P1
        └── declared expansion point
            └── immutable BoundFragment F1
```

The BoundPlan must authorize the expansion point, Agent/provider classes,
effects, maximum children, depth, concurrency, budget, and Component range.
Runtime definitions are Compiled, validated, Linked under attenuated parent
authority, content-addressed, and journaled before execution.

The current `taskflow-core` imperative runtime implements `map`, `loop`,
`tournament`, `race`, `flow{def}`, `expand`, and bounded `ctx_spawn` paths.
This is a local source audit of
`packages/taskflow-core/src/schema.ts`,
`packages/taskflow-core/src/runtime.ts`, and
`packages/taskflow-core/src/exec/step.ts`, with behavior covered by the owning
`packages/taskflow-core/test/runtime-branches.test.ts`,
`packages/taskflow-core/test/tournament.test.ts`,
`packages/taskflow-core/test/race-expand.test.ts`,
`packages/taskflow-core/test/context-tree.test.ts`, and
`packages/taskflow-core/test/exec-kernel-s2-complete.test.ts` suites; the
follow-up P-ADR must replace this source audit with an executable phase/feature
matrix.
This statement does not claim 0.3 ControlHost or event-kernel parity:
`race`/`expand` remain excluded from `EVENT_KERNEL_PHASE_TYPES`, and future
public support still depends on the 0.3 phase-feature gates. None of these paths
permits an arbitrary planner to append a later Goal plan to the Run or replace
completed nodes.

The Plan Segment record owns Goal-level provenance. Existing BoundPlan and
BoundFragment wire identities remain execution-level objects; Goal metadata is
not smuggled into the 0.3 wire through an untyped payload.

### 9.4 Cross-Run evidence loop

One Goal Branch advances through durable checkpoints:

```text
Branch Snapshot at Revision N
→ Planning Segment → Planning Run
→ Proposal Artifact + Planning Receipt
→ kernel validates and commits Revision N+1 + Work Segment S
→ execute S as Work Run R
→ issue Work Receipt
→ optional controlled synthesis / verification Runs
→ derive Workflow Outcome and source-backed Evidence Claims
→ evaluate Completion Contract through deterministic rules and/or controlled Run
→ CAS-commit Branch Revision N+2
→ stop, wait, fork, or plan the next Segment
```

An implementation may coalesce checkpoints only when one atomic command has all
required durable inputs and no intermediate decision was externally visible.
It must never overwrite a Revision or hide a Planning or Work Run.

A Workflow Outcome is a structured evidence projection:

```ts
interface WorkflowOutcome {
  workRunId: string;
  workReceiptRef: string;
  supportingControlRuns: Array<{
    purpose: string;
    runId: string;
    receiptRef: string;
    outputArtifactRef: string;
  }>;
  evidenceClaimRefs: string[];
  invalidationRefs: string[];
  artifactRefs: string[];
  affectedResourceRefs: string[];
  completionAssessmentRef: string;
}
```

Agent prose may propose the projection, but verified facts remain anchored to
reachable Receipts, Artifacts, verifier outputs, or authoritative external
observations. Raw transcripts and hidden model reasoning are not Branch facts.

The reduced shape above is deliberate: obligation status lives in one
Completion Assessment Artifact, and fact/hypothesis/unknown content lives in
typed Evidence Claims. `WorkflowOutcome` indexes those records; it does not
repeat their statements or dispositions.

#### 9.4.1 Evidence Claim classes

“Evidence” is not synonymous with “model output” or “a successful Run.”

| Claim class | Meaning | Minimum support | Authority effect |
|-------------|---------|-----------------|------------------|
| `verified-fact` | a proposition satisfied the named verification policy for a bounded subject, scope, and observation time | reachable Receipt/Artifact, verifier result, authorized human decision, or authoritative external observation; required integrity/assurance must be available | may satisfy a matching Completion Contract requirement while valid |
| `hypothesis` | a plausible proposition retained to guide future investigation | source Artifact and provenance; support may be incomplete or model-proposed | may guide planning but cannot satisfy a fact requirement or Promotion gate |
| `unknown` | a material proposition cannot currently be established safely | exact question/subject, reason evidence is unavailable/ambiguous/contradictory, and the evidence needed to resolve it | blocks only decisions whose contract depends on it; never coerces to false or zero |
| `invalidated` | a later evidenced relation says a prior Claim is no longer usable for a stated scope/time/predicate | target Claim id, invalidating Evidence, reason, and effective boundary | affects future reductions; never deletes or rewrites the original Claim |

Every Evidence Claim must identify:

```text
claim identity and immutable statement digest
classification
subject/resource scope
observation time and validity predicate
source Evidence references
verification policy or designated authority, when applicable
producing Run/Receipt/Artifact or human Command
Branch Revision that first adopted the Claim
```

This is an architectural contract, not a frozen schema. A Receipt proves only
what its assurance fields and provider observations actually establish.
Provider completion does not prove semantic correctness; Artifact integrity
does not prove the truth of its contents; a verifier's output proves only the
named verifier contract under its recorded inputs and version.

#### 9.4.2 Completion Assessment

A Completion Assessment is an immutable Artifact containing:

```text
semantic Goal revision and Branch revision
Completion Contract identity and digest
one result per required obligation:
  satisfied | not-satisfied | unknown
  Evidence Claim references
effect-settlement and Approval references
proposed terminal disposition
assessment producer and Receipt provenance
```

An Agent may produce this Artifact in a controlled verification Run. The
kernel validates reachability, contract coverage, status legality, effect
settlement, and CAS again. Only `DecideBranchTerminal` or
`DecideGoalTerminal` establishes terminal authority.

#### 9.4.3 Contradiction and staleness

Two Claims conflict when their normalized subject, predicate, scope, and
overlapping validity window require incompatible values. The reducer must:

1. preserve both immutable Claims and their provenance;
2. append a contradiction relation and expose the affected proposition as
   `unknown`;
3. prevent the disputed Claim from satisfying completion, reuse, Candidate
   validation, or Promotion;
4. plan a controlled verification/clarification Segment or apply a
   Constitution-defined source-precedence rule;
5. append an evidenced invalidation/supersession relation when resolved; and
6. retain the losing Claim for audit.

Source precedence may select which Claim is current only when the Completion
Contract or Constitution names that authority class in advance. “The newer
Agent said so,” model confidence, majority vote, or a later timestamp alone is
not precedence.

A previously verified Claim becomes non-reusable when its validity predicate
fails, its subject changes, required assurance becomes unavailable, or later
Evidence creates an unresolved contradiction. The historical Claim remains
verified for its original bounded observation; the current proposition becomes
`unknown` until refreshed.

| Conflict case | Required reduction |
|---------------|--------------------|
| unit test Artifact says pass; later live probe says fail for the same version/environment | preserve both; live state is `unknown` or failed according to the predeclared environment authority, never “majority pass” |
| provider reports completed; required output Artifact is absent or digest-invalid | execution may be terminal, but the semantic obligation is `unknown`/not-satisfied and completion is denied |
| two authoritative external sources disagree | record contradiction; apply only predeclared source precedence or request human resolution |
| Claim verified against workspace digest A; Branch now uses digest B | original Claim remains historical but is stale and cannot be reused for B |
| human approves an effect; verifier says result is incorrect | Approval authorizes the effect but does not establish correctness; completion remains unsatisfied |

### 9.5 Continuation decisions

After each Workflow Outcome, the Branch Supervisor chooses one evidenced action:

| Condition | Action |
|-----------|--------|
| Completion Contract is satisfied and side effects are settled | complete the Goal/Branch |
| Evidence is insufficient | plan an investigation Segment |
| A hypothesis is supported | plan a narrower implementation or verification Segment |
| Context or workspace snapshot is stale | refresh, rebase, merge, or replan before effects |
| A high-risk effect is required | create an Approval and wait |
| Independent approaches remain useful | fork a Goal Branch |
| Provider or effect state is ambiguous | remain `unknown` + `reconciling`; do not advance unsafely |
| No-progress or budget bound is reached | stop as blocked/failed/unknown with evidence |

The next Workflow should normally become more targeted, not merely larger.
Dynamic depth, Segment count, fork count, time, tokens, cost, and no-progress
iterations are bounded.

### 9.6 Agent participation in the Goal loop

Agents may participate as:

- user-level project router or Goal clarifier;
- Project Main Goal planner and plan reviewer;
- Component Taskflow phase executors using the existing `agent` field;
- evidence synthesizer;
- completion verifier;
- Experience Candidate extractor or reviewer.

Every Agent role is executed as a controlled Component Run:

```text
role trigger
→ resolve pinned Component + Agent binding
→ Link immutable Control Segment
→ admit Run
→ Attempt/provider lifecycle
→ output Artifact + Receipt
→ deterministic validation
→ optional Command mutation
```

The configured planner receives a bounded Branch Snapshot, not the entire raw
history. Its Planning Run returns a Proposal Artifact, not a committed Revision.
Component Agents produce Work Run outputs, not authoritative Branch mutations.
Evidence and completion Agents run through the same kernel and produce
source-backed projection Artifacts, not objective truth by speech.

The Run events and Receipt record the resolved Agent/model/tool identities,
input snapshot reference, output Artifact reference, Branch revision, Segment,
and causation. `AgentInvocationRecorded`, if retained as a diagnostic event, is
part of that Run stream and never an independent authority aggregate.

The following direct paths are forbidden:

```text
Goal Supervisor → model SDK
Branch Supervisor → Host SubagentRunner
Store / reducer → script or effect provider
Projection / Web server → planner Agent
```

An implementation that needs a model or external effect must construct and
admit a Segment/Run. This prevents a second invisible scheduler, separate retry
rules, unjournaled cost, missing cancellation, and Receipt-free decisions.

#### 9.6.1 Current checkout bypass inventory

The single-runtime rule is a **target architecture constraint**, not a claim
that the current `feat/0.3.0` checkout already conforms. The following
reproducible local audit was performed on 2026-07-25 at
`e11b82109e04f69e56a37aceb3f78934f822ad14`. Relevant source differed from that
HEAD in `packages/taskflow-control/src/host-llm-provider.ts` and
`packages/taskflow-control/src/phase-scheduler.ts` and
`packages/taskflow-control/src/script-provider.ts`; every other process-call
source listed below was clean relative to that HEAD. The claims therefore
describe the inspected working tree, not an immutable released build.

| Current entry path | Observed implementation | Conformance status |
|--------------------|-------------------------|--------------------|
| MCP foreground `taskflow_run`, control plane enabled | `taskflow-mcp-core/src/mcp/server.ts` builds `createHostLlmExecutionProvider` and calls `tryControlPlaneRun`; `taskflow-control/src/mcp-route.ts` admits through `ControlHost` | Conforming direction for supported phases; still subject to provider and phase-coverage tests |
| MCP foreground with `TASKFLOW_CONTROL_PLANE=0` | Falls through to `taskflow-core.executeTaskflow` with direct `RuntimeDeps.runTask` | Explicit legacy compatibility bypass; not conforming and must not host future Goal/Planner semantics |
| MCP background `taskflow_run` | Always launches the 0.2 detached runner; source marks shared ControlStore background as partial | Known bypass; post-0.3 Goal work must remain unavailable here until daemon-backed ControlHost admission exists |
| MCP `taskflow_resume` | Forks a legacy Run and calls `executeTaskflow` directly | Known bypass; cannot be presented as controlled Segment continuation |
| Pi normal run, resume, and apply-recompute paths | Inject `createPiSubagentRunner(...).runTask` into `executeTaskflow` | Known bypass; Pi has not yet been migrated to the ControlHost provider path |
| ControlHost agent phases | `taskflow-control/src/phase-scheduler.ts` routes phase Attempts to the injected LLM `ExecutionProvider`; `host-llm-provider.ts` delegates to Host `runTask` | Correct layering shape, but current cancellation only changes adapter-local job state and does not prove child execution stopped |
| Legacy script phases | `taskflow-core/src/runtime/phases/script.ts` spawns directly | Legal only inside the explicitly selected legacy runtime; not sufficient for future controlled effect semantics |
| ControlHost script phases | `taskflow-control/src/script-provider.ts` owns process submission, observation, cancellation, and reconcile | Conforming provider boundary, subject to the provider's stated descendant-process uncertainty |
| Scorer/compiler execution | `taskflow-core/src/scorer-runtime.ts` creates a compiler subprocess | Legacy-only bypass; migrate behind a controlled provider or disable for future Goal features |
| Cache fingerprint Git calls | `taskflow-core/src/cache.ts` executes Git | Legacy deterministic helper today, but it is neither a general kernel primitive nor a future effect path; migrate to an audited capability/provider before future authority consumes it |
| Workspace Git/worktree operations | `taskflow-core/src/workspace.ts` spawns Git and mutates workspace topology | Legacy workspace manager; future mutable workspace operations require P-A6 policy plus controlled provider mediation |
| Process-birth observation | `taskflow-core/src/resources/persistence.ts` invokes fixed PowerShell process inspection | Candidate narrow Control Kernel platform primitive only if its executable/arguments and output parser satisfy the fixed allowlist contract above |
| Detached/background lifecycle | `taskflow-mcp-core/src/mcp/background.ts`, `pi-taskflow/src/index.ts`, and `taskflow-core/src/detached-control.ts` create or manage detached processes | Legacy-only lifecycle paths; future background admission/cancellation must be owned by ControlHost, with process termination treated as intent until reconciled |
| Shared Host process runner | `taskflow-core/src/runner-core.ts` spawns Host CLIs; Host adapters delegate to it | Legal adapter mechanism only when reached from a ControlHost `ExecutionProvider`; direct legacy callers remain bypasses |

Therefore the RFC does not claim there is currently one production execution
path. It requires convergence before any post-0.3 Goal, Control Segment, or
Planner feature is enabled. An emergency legacy opt-out may remain for existing
0.2 programs only if it is explicit, observable, incapable of writing future
Goal authority, and excluded from conformance claims.

#### 9.6.2 Required conformance gate

The single-runtime P-ADR and implementation gate must include:

1. an entrypoint matrix proving foreground, background, resume, recompute,
   approval continuation, Pi, and every MCP Host admit through ControlHost;
2. a layer/import check that Supervisor, Store, reducer, projection, Web, and
   Goal modules cannot import Host runners, model SDKs, `child_process`, or
   provider submit APIs;
3. a repo-wide process/effect inventory and allowlist that classifies every
   initiation site as: controlled provider; legacy-only isolated path;
   migration-required path; or named narrow Control Kernel platform primitive;
4. an allowlist limiting domain external-effect initiation to audited
   `ExecutionProvider` adapters behind a durable dispatch fence, and limiting
   kernel process creation to the fixed primitive contract above;
5. route tests showing unsupported phases fail closed rather than fall through;
6. cancellation and reconciliation tests proving that adapter-local
   “cancelled” state is not mistaken for provider quiescence;
7. Receipt/provenance tests for every Agent role and effect class;
8. a compatibility test proving an explicit legacy run cannot read or mutate
   Goal, Branch, Candidate, or Promotion authority; and
9. a release check that rejects any unclassified or newly discovered
   process/effect initiation site across the repository.

Until the implementation gate passes, every corresponding Goal/Control Segment
feature flag remains disabled. RFC-level single-runtime closure means the
future specification contains no bypass, current legacy bypasses are
explicitly inventoried, and none can read or mutate future authority. It does
not claim that the current checkout has completed the migration.

### 9.7 Online adaptation is not promotion

```text
Goal-local change
→ may affect the current Goal immediately
→ remains private to its Goal Branch

Project-level change
→ must become Experience Candidate
→ must pass promotion gates
→ affects future Goals only after promotion
```

This distinction prevents every useful observation from triggering a
project-wide version churn.

### 9.8 Cardinality and operation boundaries

The following cardinalities are normative architecture constraints:

| Relationship | Cardinality | Consequence |
|--------------|-------------|-------------|
| accepted Goal → Goal Branch | `1 → 1..n` | Goal acceptance atomically creates the initial Branch and Revision 0; later Branches require an explicit fork Command |
| Goal Branch → Branch Revision | `1 → 1..n` | Revision numbers are contiguous; exactly one CAS winner may append `N+1` |
| Branch Revision → Plan Segment link | `1 → 0..n` | A Revision may settle, wait, or link several independent future Segments |
| Plan Segment → immutable BoundPlan | `1 → 1` | The executable meaning is fixed before the Segment is linked |
| Plan Segment → Run identity | `1 → 0..1` | Zero before admission; exactly one stable Run identity after binding; a Segment is never rebound |
| Run → Attempt | `1 → 0..n` | Retry, provider resubmission when proven safe, and approval continuation remain Attempts of the same Run |
| Run → terminal Receipt | `1 → 0..1` | Zero while admitted/running/unknown; exactly one after an authorized terminal transition |
| Run → BoundFragment | `1 → 0..n` | Every Fragment is linked at a pre-authorized BoundPlan expansion point |
| Planning Run → designated Proposal Artifact | `1 → 0..1` | Supporting Artifacts may be many; only the output-contract-designated Proposal can be considered for commit |

Several operations that are casually called “resume” are not the same:

| Operation | Identity rule | Effect rule |
|-----------|---------------|-------------|
| Attempt retry | same Segment, BoundPlan, Run; new Attempt | allowed only under the Run's retry and idempotency policy |
| approval continuation | same Segment and Run from a durable cursor | no replay of already settled effects |
| provider reconcile | same Run and provider handle/intent | observe first; never infer “not found” means safe resubmit without provider contract |
| Goal replan | new Planning Segment and new Run | consumes committed evidence from the prior Branch Revision |
| changed Work plan | new Work Segment and new Run | old Segment remains immutable |
| Branch fork | new Branch identity, Revision 0, and future Segments/Runs | shares only immutable references; effects are never copied |
| Main adoption | new Branch Revision and future Segments/Runs | no mutation of prior Segment or in-flight Attempt |
| offline event replay | no execution Run when purely folding existing events | external effects and model calls forbidden |
| planner shadow / fixture / live canary | new `control:replay` Segment and controlled Run | authority depends on replay mode; model invocation is still an external-effect call |
| legacy 0.2 resume/recompute | compatibility behavior outside future Goal semantics | must not be relabeled as continuing the same Goal Segment |

### 9.9 Segment invalidation

Invalidation changes future eligibility, not history:

| Segment condition | Allowed action |
|-------------------|----------------|
| linked, no Run identity | atomically mark invalidated; admission must fail closed |
| Run bound, no provider dispatch intent | request cancellation; terminalize only after the admission owner proves no dispatch occurred |
| provider may be running | record supersession requested, retain reservation, and settle/cancel/reconcile the same Run |
| provider outcome ambiguous | keep Branch `unknown` + `reconciling`; do not admit a conflicting replacement |
| Run terminal and Receipt issued | never invalidate history; a later Revision may mark outputs non-reusable or hypotheses invalidated |

“Invalidate Segment” must therefore never be implemented as deleting the
Segment, cancelling an unproven child process, or making its Receipt disappear.

### 9.10 Crash and ambiguity matrix

| Boundary | Durable state after crash | Recovery rule |
|----------|---------------------------|---------------|
| before Control Segment Link commit | no Segment exists | retry the same idempotent Link Command |
| after Link, before Run admission | one unstarted Segment with stable admission key | retry admission; create or recover the same Run identity |
| after provider accepts, before dispatch acknowledgement | dispatch intent exists; effect is possible | enter reconcile under the authoritative owner; never blind-resubmit |
| after Planning Receipt, before Proposal validation | immutable Run/Receipt/Artifacts exist; Branch head unchanged | rerun deterministic validation without a model call |
| after validation, before Branch CAS | validated Proposal exists; Branch head unchanged | retry the same commit Command against `expectedRevision` |
| two valid Proposals race on Revision `N` | both Planning Runs remain evidence; only one CAS may append `N+1` | loser records stale rejection and replans from winner; no loser Work Segment becomes active |
| during Revision + Work Segment Link | neither or the entire journal batch is visible | one atomic project-journal batch; partial visibility is forbidden |
| after Work Segment Link, before admission | one recoverable unstarted Work Segment | retry idempotent admission with the stable binding |
| after Work Receipt, before WorkflowOutcome reference | Run truth is complete; Branch head unchanged | rebuild/validate the Outcome Artifact from Receipt-backed inputs, then retry Branch commit |
| after Approval request checkpoint, before or after human response | same Run is parked at one durable cursor; decision is an immutable input | recover the same cursor and decision; continue the same Run without repeating settled phases |
| during Synthesis or Verification | its own Control Segment/Run lifecycle is authoritative | settle or reconcile that Run; Work Receipt is not rewritten |
| after Main-adoption validation, before Branch CAS | old Main pin and Branch head remain authoritative | retry against the same expected Revision; if stale, re-evaluate compatibility |
| during adoption Revision + replacement Segment links | neither or the entire adoption batch is visible | atomically pin the new version for future Segments; never mutate or relink an existing Run |
| after completion validation, before terminal Command | Assessment Artifact exists; Goal/Branch remain non-terminal | retry the terminal Command and re-check CAS, contract, and effect settlement |
| after terminal event, before projection refresh | journal is terminal; cache may be stale | rebuild projection; never emit a second terminal decision |

No crash window is repaired by rewriting a Revision, reusing a Segment for a
different BoundPlan, or starting a replacement while an effect remains
possible.

---

## §10. Fork semantics

### 10.1 Goal Branch fork

A Goal Branch may fork to explore an alternative:

```text
Goal
├── Branch A · continue current approach
└── Branch B · alternative plan
```

Fork requirements:

- exact parent Branch and revision;
- immutable Artifact references may be shared;
- mutable workspace state must be isolated or explicitly serialized;
- budget and concurrency are independent;
- effects are not duplicated merely because Artifacts are shared;
- each Branch has independent Runs, Attempts, and Receipts;
- winner selection or merge is an explicit, evidenced decision.

### 10.2 Main fork

Project Main may fork a Candidate version:

```text
Main v12
├── candidate v13-a · shadow planner
└── candidate v13-b · Component selection change
```

Candidates do not receive production authority merely because they derive from
Main. They execute replay or shadow work under attenuated capability.

### 10.3 Merge does not merge journals

Merging a Branch means selecting verified strategy, Component, or knowledge
deltas. It never physically combines or rewrites historical event streams.

---

## §11. Hot update and rolling adoption

### 11.1 Immutable promotion

Project Main promotion is:

```text
build v13 Candidate
→ validate
→ replay
→ risk gate
→ persist immutable v13
→ CAS currentProjectTaskflowVersion: v12 → v13
```

No current version is modified in place.

### 11.2 RCU/MVCC-style behavior

- New Goals fork from v13 after the pointer switch.
- Existing Goal Branches remain valid on v12.
- A Branch may adopt v13 at a Plan Segment boundary.
- Existing Segments retain their original version provenance.
- Rollback changes the pointer for new work; it does not falsify v13 history.

### 11.3 Adoption modes

| Mode | Behavior |
|------|----------|
| `pinned` | Goal Branch finishes on its base version. |
| `next-segment` | New version applies when the current Segment settles. |
| `affected-only` | Compare semantics; replace only affected pending Segments. |
| `security-required` | Reach safe checkpoint, then migrate or block. |
| `manual` | Present impact and wait for user decision. |

`next-segment` is the default candidate for low-risk rolling adoption.

### 11.4 In-flight Attempt rule

An Attempt that has been submitted to a provider is not hot-swapped.

The system may:

- wait for a settled result;
- cancel when cancellation is supported and proven;
- checkpoint a cooperative executor;
- reconcile an ambiguous provider state;
- mark the Branch waiting or unknown.

It may not pretend the Attempt never existed or blindly submit a replacement
while the old provider may still mutate the workspace.

### 11.5 Correctness-preserving reuse

A prior result is reusable only when the implementation proves equivalence
across all required dimensions:

```text
execution semantics
resolved inputs
relevant project/context snapshot
Component version and configuration
authority and policy obligations
side-effect disposition
required verification contract
Artifact integrity and provenance
```

If any required dimension is unavailable, reuse is unavailable rather than
assumed.

---

## §12. Component Taskflows

### 12.1 Component role

Existing saved Workflows naturally become Component Taskflows:

```text
analyze-change
implement-change
run-targeted-tests
protocol-review
release-candidate
```

A Component is a versioned capability with:

- declared input and output contract;
- effect and tool requirements;
- authority ceiling;
- verification contract;
- compatibility range;
- deterministic content identity;
- provenance and promotion scope.

### 12.2 Project-local by default

A Component created or improved inside a Goal Branch remains:

```text
Goal-local candidate
→ optionally Project-local Component
→ optionally User-scoped Component
→ optionally published/shared Component
```

Every widening step requires a stronger evidence and privacy gate.

### 12.3 Cross-project promotion

Cross-project promotion requires:

- no raw project paths, secrets, private code, or private Artifact payloads;
- an explicit generalized contract;
- provenance back to source Candidates without disclosing private content;
- replay on representative projects or synthetic fixtures;
- compatibility and regression evidence;
- explicit authorization for the target scope;
- version pinning and rollback.

Project A never mutates Project B's pinned Component version.

### 12.4 Compatibility

Hot adoption of a Component requires compatible:

- input schema;
- output schema;
- state/checkpoint schema;
- effect class;
- authority obligations;
- completion contract.

An incompatible Component upgrade creates a new Plan Segment or migration path;
it is not silently substituted.

---

## §13. Experience Candidates and promotion

### 13.1 Candidate sources

A Goal Branch may propose:

- a planning heuristic;
- a Component selection rule;
- a diagnostic rule;
- a new or modified Component;
- stronger verification;
- project structural knowledge;
- a safe reuse rule;
- a clarification or escalation rule.

### 13.2 Candidate record

```ts
interface ExperienceCandidate {
  candidateId: string;
  ownerScope: {
    kind: "project" | "user" | "shared";
    scopeId: string;
  };
  sourceRefs: Array<{
    kind: "goal-branch-revision" | "candidate" | "promotion";
    ref: string;
  }>;
  kind:
    | "strategy"
    | "component"
    | "knowledge"
    | "verification"
    | "reuse-rule";
  deltaArtifactRef: string;
  evidenceRefs: string[];
  createdAt: number;
}

interface ExperienceCandidateProjection {
  candidateId: string;
  status: "candidate" | "validating" | "promoted" | "rejected" | "rolled-back";
  currentValidationRef?: string;
  effectiveRiskClass?: "low" | "medium" | "high" | "forbidden";
  promotionRecordId?: string;
  updatedAt: number;
}
```

The Candidate record is immutable. Validation, rejection, Promotion, and
rollback append lifecycle events and immutable result records; the projection
above is only their fold. A Promotion record, not the Candidate projection,
attests the scope transition and Project Main pointer CAS.

Risk class is a validation result, not a proposer-controlled Candidate field.
The projection may expose the latest effective class, while every prior
classification and its Evidence remain immutable.

Goal-local adaptation is already represented by Branch Revision/Artifact
history and is not an ExperienceCandidate. The first Candidate created from it
is owned by the project scope. A user/shared Candidate may reference several
lower-scope Candidate/Promotion records after abstraction and redaction; it
does not pretend to originate from one Goal.

### 13.3 Project-local promotion pipeline

```text
Candidate
→ structural and schema validation
→ capability and authority validation
→ replay source Goal
→ replay representative historical Goals
→ deterministic regression tests
→ risk classification
→ shadow planning or canary when required
→ immutable Project Main candidate
→ atomic promotion
→ post-promotion observation
→ retain rollback target
```

Replay in this pipeline is not one undifferentiated operation:

| Mode | Execution identity | Allowed domain effects | Authority of result |
|------|--------------------|------------------------|---------------------|
| `event-replay` | pure Kernel fold; no Run | none; no model/provider call | diagnostic evaluation only |
| `planner-shadow` | new `control:replay` Segment/Run | model provider only; no project workspace/network/tool effect | Proposal/score Artifact only |
| `fixture-execution` | new controlled Run | synthetic or technically enforced ephemeral sandbox effects | validation Evidence for named fixtures only |
| `live-canary` | new controlled Run with explicit canary authority | predeclared reversible, read-only, or proven-idempotent bounded effects only | canary Evidence; never direct Promotion authority |

`event-replay` and `planner-shadow` are the default evaluation modes. Neither
may repeat deployments, writes, payments, messages, or other domain effects.
Fixture execution requires an enforcement mode that actually provides the
claimed isolation. Live canary is a separate authorized command with effect
reservations, idempotency, reconciliation, and its own Receipt.

The term “none” applies only to domain effects. A planner-shadow model call is
itself an external-effect invocation and therefore always runs through
ControlHost; it is never a pure reducer shortcut.

Live canary is default-deny. Its architecture safety floor permits only
read-only production observation, isolated non-user-visible shadow traffic, or
writes to a dedicated canary namespace with proven idempotency and cleanup.
Deployment, payment, external messaging, permission/secret changes, mutation of
real user data, and other irreversible or user-visible effects are excluded
from automatic canary authority. A Constitution may narrow this set; widening
it requires explicit human Promotion/Approval and ordinary effect policy.

### 13.4 Scope lattice

```text
Goal-local Revision
        │ propose
        ▼
Project Candidate ──Promotion──> Project Main version
        │ abstract + redact + authorize + revalidate
        ▼
User Candidate ─────Promotion──> user preference / Component version
        │ package + disclose + authorize + broader replay
        ▼
Shared Candidate ───Promotion──> shared signed/reviewed version
```

Rules:

1. Goal-local change is immediate Branch history, not a Promotion.
2. Every upward edge is itself a cross-scope Promotion/export. Only after its
   source-side record and package are durable may the target-scope writer create
   a new Candidate that references that Promotion; records never move between
   stores.
3. A project Candidate cannot directly mutate another project. Project B may
   later Link a user/shared Component only after its own Constitution,
   compatibility, authority, and completion-policy checks.
4. Target-scope Evidence must independently prove abstraction, redaction,
   authorization, representative replay, and rollback. Source-scope success is
   necessary at most, never sufficient.
5. User and shared Promotions are never automatic.
6. Raw transcripts, secrets, project paths/code, unbounded identifiers, and
   unresolved/contradictory Claims cannot cross a scope edge.
7. Rollback at one scope changes that scope's future pointer/eligibility; it
   does not erase lower-scope history or silently rewrite already pinned work.

#### 13.4.1 Cross-scope Promotion/export saga

Creating a target-scope Candidate is already scope widening. It requires:

```text
source-scope Candidate/Promotion Evidence
→ source writer creates an immutable content-agnostic export envelope that
  references a redacted, content-addressed, kind-specific payload
→ authorized source writer records CrossScopePromotionIntent
→ target-scope writer validates envelope, authorization, provenance, policy,
  redaction attestation, the registered kind-specific payload validator, and
  replay requirements
→ target writer records CrossScopePromotionAccepted and creates exactly one
  target-owned Candidate referencing the source Promotion/package
→ source writer records acknowledgement projection
```

The source writer cannot write the target store, and the target writer cannot
invent source authorization. A stable `crossScopePromotionId` deduplicates the
saga in both stores.

| Crash point | Recovery |
|-------------|----------|
| package written, no source Promotion intent | package has no wider authority and may be retained/garbage-collected by policy |
| source intent committed, target not accepted | retry target validation with the same id; no target Candidate yet |
| target accepted, source acknowledgement missing | target Candidate remains authoritative; repair source projection from the same id |
| target rejects package | append target rejection; a changed package/authorization requires a new Promotion id |
| either store or package integrity unavailable | remain pending/needs-reconciliation; never reconstruct wider data from Registry or prose |

P-A7 owns widening eligibility, authorization, risk, lifecycle, the
content-agnostic export-envelope schema, and the idempotent two-store saga. Its
envelope records source Promotion, target scope, payload kind/digest, redaction
attestation, authorization, and withdrawal reference, but does not define a
kind-specific payload.

P-A8 extends that already-frozen envelope with the Component payload,
Component-specific redaction profile, compatibility rules, migration, and
withdrawal behavior. Other Candidate kinds require their own downstream
payload P-ADR before widening. Thus P-A7 can prove the generic saga with an
opaque validated test payload and has no completion dependency on P-A8; P-A8
depends one-way on P-A7 and cannot redefine Promotion authority.

### 13.5 Automatic promotion

Automatic promotion is allowed only when all are true:

- `ownerScope.kind` is `project`;
- Constitution permits auto-promotion for the Candidate kind;
- executable tests pass;
- required replay corpus passes;
- no required evidence is unavailable;
- the Candidate does not expand authority or effects;
- the Candidate does not weaken verification;
- compatibility is proven;
- rollback is available;
- promotion budget and anti-thrashing gates pass.

Only `low` risk project Candidates are eligible:

| Risk class | Minimum disposition |
|------------|---------------------|
| `low` | project-only; no authority/effect expansion, no weaker verification, compatible, deterministic tests and required replay green; may auto-promote if Constitution opts in |
| `medium` | explicit human Promotion; planner-shadow and fixture evidence required; canary only when policy requires and permits it |
| `high` | explicit security/product owner approval, migration and rollback plan, isolated validation; no background auto-promotion |
| `forbidden` | reject as learning Promotion; changes to Kernel, authority ceiling, irreversible effect class, or prohibited data require ordinary software/policy governance |

The required replay corpus is selected from the Candidate's semantic
affected-set, not from a fixed count:

- the source Goal and its known failure/recovery path;
- every retained historical Goal whose Components, strategy predicates,
  schemas, effect class, or Completion Contract intersect the affected-set;
- at least one negative/edge fixture for each changed decision boundary; and
- the currently supported Project Main/Component compatibility range.

If required history is unavailable, corrupted, non-replayable, or too sparse to
cover an affected boundary, automatic Promotion is unavailable rather than
treated as a pass.

### 13.6 Never automatic

- Permission, secret, sandbox, or provider authority expansion.
- New irreversible effect class.
- Weakening completion or verification requirements.
- Retention, privacy, redaction, or disclosure changes.
- Cross-project or shared promotion.
- Migration with unknown live side effects.
- Changes to the Stable Control Kernel.

### 13.7 Rollback semantics

| Case | Required behavior |
|------|-------------------|
| project Main regression before new Goal admission | CAS pointer back to retained version; record rollback Evidence; disable the Candidate class's auto-promotion |
| regression discovered by an in-flight pinned Goal | Goal remains historically pinned; reach safe boundary, then explicit adoption/mitigation; do not rewrite its Segments |
| user Component/preference regression | move future user pointer/eligibility back; projects already pinned retain provenance and apply their own adoption policy |
| shared version withdrawn | stop new Links and publish withdrawal/revocation metadata; existing local pins are not silently deleted |
| Promotion caused an external effect | rollback changes future behavior only; reconcile/compensate the effect through a separate controlled Run |
| rollback target unavailable or incompatible | mark Promotion/affected scope `unknown` or blocked, stop auto-promotion, require explicit recovery |

Rollback never changes Evidence or pretends the promoted version did not run.
A rollback-triggered Candidate class remains quarantined until new independent
validation and an explicit re-enable Command satisfy the scope policy.

### 13.8 Anti-thrashing

To prevent `v12 → v13 → v14 → …` loops during one Goal:

- a Branch may adapt locally without promoting every revision;
- promotion Candidates are coalesced by semantic area;
- a Goal Branch adopts at most one promoted Project Main generation by default;
- a Candidate created after adoption waits for a later promotion window;
- minimum evidence and cooldown policies apply;
- repeated rollback disables auto-promotion for that Candidate class;
- promotion work has a bounded budget.

---

## §14. User Taskflow

### 14.1 Role

The User Taskflow is a long-lived meta-controller:

- receives an open Goal from a supported Host;
- identifies an existing project when possible;
- asks for a project binding when ambiguous;
- bootstraps a Project Taskflow Candidate for a new project;
- applies user-level preferences and authority ceilings;
- selects user-scoped Component versions;
- routes execution to the project authority.

User-level routing and clarification Agents return project candidates, missing
constraints, bootstrap proposals, or governed execution-profile suggestions.
They do not establish project identity, create authority, or rewrite the
source Goal. When these roles use a model, User Taskflow invokes their pinned
Components as controlled Runs through an already selected authority scope or a
separately specified bootstrap control domain; it never calls them directly.
Ambiguous project binding remains an explicit user or policy decision.

### 14.2 Existing project

```text
Goal
→ resolve Project
→ load current Project Main
→ fork Goal Branch
```

The User Taskflow does not regenerate Project Main for every Goal.

### 14.3 New project

```text
Goal
→ create or bind project workspace
→ inspect project under bounded authority
→ select bootstrap template and Components
→ generate Project Main Candidate
→ validate Constitution and completion contracts
→ authorize registration
→ fork first Goal Branch
```

Generation does not grant authority. The new Project Main must pass Link,
policy, capability, and storage bootstrap rules.

### 14.4 User-level learning

The User Taskflow may eventually learn:

- preferred communication style;
- recurring clarification preferences;
- user-approved defaults;
- reusable Component preferences;
- general workflow patterns proven across projects.

It may not absorb raw project trajectories, secrets, private code, or unverified
project conclusions into user-wide state.

### 14.5 No merged user ledger

The User Taskflow may maintain:

- project registry references;
- user preference versions;
- user-scoped Component registry;
- cross-project Candidate and Promotion records;
- bounded aggregate projections;
- user-scoped Control Runs and Receipts only for routing, clarification,
  execution-profile selection, and project-bootstrap proposals.

Project-scoped Runs, Goal Branch events, Artifacts, Approvals, and Receipts
remain authoritative in each Project ControlStore.

The existing `UserCoordinatorStore` must not be overloaded for this purpose.
A future `UserTaskflowStore` or equivalent requires its own P-ADR and authority
model.

---

## §15. Authority and storage

### 15.1 Project authority

Project ControlStore is the authority for:

- Project Taskflow versions and current-version pointer;
- Goals and Goal revisions;
- Goal Branches and Branch revisions;
- Plan Segment and BoundFragment lineage;
- Runs, Attempts, Approvals, Artifacts, and Receipts;
- project Experience Candidates and Promotions;
- project-local Component pins and versions.

### 15.2 Future UserTaskflowStore authority

A future UserTaskflowStore may be authoritative only for:

- User Taskflow versions;
- user preferences and explicit defaults;
- user-scoped Component versions;
- user-scope Candidate and Promotion records;
- project bootstrap templates;
- project references, not project event bodies;
- pre-project Goal envelopes and user-scoped routing/clarification/bootstrap
  Control Runs, Attempts, Artifacts, and Receipts.

These user-scoped Runs have attenuated effects and may produce only routing,
clarification, profile-selection, and bootstrap Proposal Artifacts. They cannot
execute project work, mutate a Project ControlStore, or aggregate copies of
project Run history. The exact user ControlDomain, retention, admission, and
handoff protocol requires its own P-ADR.

The architecture-level minimum for that P-ADR is:

- one user-private ControlDomain and append-only ledger distinct from every
  Project ControlStore and from UserCoordinatorStore;
- one fenced UserTaskflowStore writer for Envelope, user Control Run, binding
  intent, user Candidate, and acknowledgement Commands;
- ControlHost admission for every model/external-effect call;
- in coordinated mode, an ordinary `slots ≡ 1` UserCoordinatorStore
  reservation held until the user Run is terminal or authoritatively
  reconciled; the reservation carries no Goal or Artifact content;
- effects limited to read-only discovery/inspection plus explicitly approved
  project-bootstrap reservations; no project code mutation or production
  effect before project-side acceptance;
- recovery from the user ledger and provider handles, never from Registry
  projections;
- no raw chain-of-thought retention; Proposal Artifacts and Receipts remain
  while a binding/reconciliation/Promotion depends on them and are then subject
  to explicit user retention/disclosure policy; and
- deletion/expiry cannot erase an unacknowledged binding intent, live/ambiguous
  effect record, required Receipt, or project-side acceptance reference.

The retention duration and user-facing disclosure copy remain product-policy
decisions, but the safety floor above is not optional.

### 15.3 UserCoordinatorStore remains narrow

The existing `UserCoordinatorStore` remains authoritative only for the 0.3
user singleton, coordinator epoch/lease, global Run concurrency reservations,
orphan-suspect handling, and narrow Coordinator Commands such as capacity
configuration or operator release.

A future user-scoped routing/bootstrap Run may consume a concurrency
reservation, identified by opaque ControlDomain and Run references. That does
not authorize UserCoordinatorStore to retain its Program, Goal Envelope,
events, Artifacts, Receipt, routing result, or project-binding saga. It is a
capacity authority, not the User Taskflow journal.

### 15.4 Registry

ControlRegistry remains non-authoritative discovery and aggregate projection.
It may project:

- active Goal counts;
- Goals needing input;
- current Project Main version;
- project health and mount state;
- recent Promotion summaries.

It cannot mutate or reconstruct authoritative Goal history from an aggregate
view.

### 15.5 Authority matrix and negative permissions

| Domain/object | Project ControlStore | Future UserTaskflowStore | UserCoordinatorStore | ControlRegistry |
|---------------|----------------------|--------------------------|----------------------|-----------------|
| project Goal/Branch/Revision | **authority** | external reference after accepted handoff | forbidden | rebuildable summary/reference only |
| project Segment/Run/Attempt/Receipt/Approval | **authority** | forbidden to copy as user history | opaque concurrency reservation only | forbidden |
| Project Main version/pointer/Promotion | **authority** | project reference or user-approved template ref only | forbidden | current pointer projection only |
| pre-project GoalEnvelope | forbidden until accepted as a new project GoalRecord | **authority** | forbidden | optional discovery hint, never content authority |
| routing/clarification/bootstrap Control Run | forbidden before project binding | **authority** | capacity reservation only | optional liveness projection |
| user preference/Component/Candidate/Promotion | project pin/reference only | **authority** | forbidden | optional version summary |
| singleton/coordinator epoch/global Run slots | consumes/observes reservation | consumes/observes reservation | **authority** | optional health projection |
| project path/mount/discovery | validates its own root/identity | project reference | forbidden | non-authoritative directory/projection |
| cross-store binding intent | accepted/rejected project-side record | **saga authority** for intent and acknowledgement | forbidden | forbidden |

Additional negative permissions are normative:

- UserTaskflowStore cannot directly write a Project ControlStore; it submits a
  Command to the fenced project writer.
- Project ControlStore cannot mutate user preferences or mark a user binding
  acknowledged.
- UserCoordinatorStore cannot route Goals, execute Components, retain
  Receipts, or decide a binding.
- ControlRegistry cannot originate Commands, recover missing history by
  invention, or be the only copy of an accepted binding.
- Loss of any projection never authorizes recreation with new identities.

### 15.6 One writer and fencing

Project Main promotion, Goal Branch revision, Plan Segment Link, and current
version pointer changes use the same exclusive project authority and fencing
discipline as other Project ControlStore writes.

No Goal Branch process becomes an independent project writer.

### 15.7 Atomic command boundaries

Follow-up P-ADRs must freeze executable schemas for this minimum inventory:

| Command | Authoritative writer | Idempotency and precondition | Atomic result | Crash/retry rule |
|---------|----------------------|------------------------------|---------------|------------------|
| `InitializeProjectTaskflow` | fenced Project ControlStore writer | project identity anchor exists; no Main pointer; authorized initial manifest validated | immutable initial ProjectTaskflowVersion + initialization record + current pointer | retry returns the same version; conflicting manifest/identity fails |
| `AcceptGoalAndForkInitialBranch` | Project ControlStore writer | caller command id; project binding accepted; Goal id absent | GoalRecord + BranchRecord + Branch Revision 0 | replay returns the original identities; conflicting payload fails |
| `ReviseGoalDisplay` | Project writer | command id + expected display revision; semantic intent digest unchanged | display revision event | stale writer reloads; no Segment invalidation |
| `ReviseGoalSemantics` | Project writer | command id + expected semantic revision + new intent/Completion Contract digest | semantic revision event + stale marker for prior unsubmitted plans | stale writer reloads; dispatched Runs reconcile under original pins |
| `LinkControlSegment` | Project writer | command id + Branch revision + role/component pins + input digest | immutable Segment binding with admission key | replay returns the same Segment; changed inputs require a new Command |
| `BindSegmentRun` | ControlHost under the same project authority | Segment admission key; Segment active; no existing binding | Segment→Run binding plus Run admission identity, or recoverable saga records if the 0.3 Run batch cannot be co-located | retry recovers the same Run; never allocate a second identity |
| `RecordProposalDisposition` | Project writer | Planning Receipt and Proposal Artifact reachable | accepted-for-validation or rejected disposition | does not advance Branch; deterministic validation may be repeated |
| `CommitBranchRevision` | Project writer | command id + `expectedRevision` + expected semantic Goal revision + Completion Contract digest + validated Evidence + active Segment set | Branch Revision `N+1` and all new/invalidation Segment links in one journal batch | one CAS winner; changed Goal semantics or stale proposal cannot activate work |
| `ReferenceWorkflowOutcome` | Project writer | Work Receipt and supporting Control Receipts reachable | Outcome Artifact reference available to the next Revision | execution facts remain in Run records; reference can be reconstructed |
| `ForkGoalBranch` | Project writer | exact parent Revision + unique fork command | child BranchRecord + child Revision 0 | same fork command returns same child; artifacts shared by reference only |
| `RequestBranchSupersession` | Project writer | successor/reason present | supersession intent only | Branch becomes terminal `superseded` only after live/ambiguous effects settle |
| `DecideBranchTerminal` | Project writer | expected Branch revision + completion/failure basis + effect settlement proof | one terminal Branch event | conflicting terminal Command fails; projection is rebuildable |
| `DecideGoalTerminal` | Project writer | expected semantic Goal revision + Completion Contract digest + validated reduction over every owned terminal Branch | one terminal Goal event + selected/non-selected dispositions and result references | retry returns same decision; no terminal event while any owned Branch, Run, provider, cost, or reservation is unsettled |
| `AdoptProjectMainVersion` | Project writer | expected Branch revision + compatible target version + safe Segment boundary | new Branch Revision and future Segment policy | prior Segments remain pinned; stale adoption replans |
| `RecordExperienceCandidate` | scope-owning writer | source Evidence digest + target owner scope | immutable Candidate record | duplicate content may deduplicate by policy but never merges provenance silently |
| `RecordCandidateValidation` | scope-owning writer | Candidate id + validation run/fixture evidence | immutable validation result event/record | latest projection folds all results; prior failures are retained |
| `BeginCrossScopePromotion` | source-scope writer | stable Promotion id + validated source Candidate/Promotion + generic export envelope + payload digest + explicit authorization | immutable source intent referencing envelope/payload; no target Candidate | retry returns the same intent; changed envelope, payload, or authorization requires a new id |
| `AcceptCrossScopePromotion` | target-scope writer | same Promotion id + reachable envelope/payload + target policy + registered kind-specific validation | acceptance record and exactly one target-owned Candidate in one target-store batch | retry returns the same Candidate; rejection records no Candidate |
| `AcknowledgeCrossScopePromotion` | source-scope writer | target acceptance/rejection proof + same Promotion id | source-side acknowledgement projection | missing acknowledgement is repairable from the target proof and cannot duplicate target state |
| `PromoteProjectMain` | fenced Project writer | candidate version immutable; expected Main pointer; all required gates passed | Promotion record + current-version pointer CAS in one batch | loser revalidates against new Main; no overwrite |
| `RollbackProjectMain` | fenced Project writer | expected current pointer + retained target + rollback evidence | rollback record + pointer CAS | Promotion history and affected Goal provenance remain |

Branch Revision and its Segment links are one project-journal commit. Run
admission is a subsequent idempotent saga using stable Segment and command
identity; a crash between Link and admission leaves a recoverable unstarted
Segment, not a synthetic Run.

The P-ADR may co-locate Segment binding and Run admission in one project-store
batch only if it reuses the 0.3 ControlHost admission invariants and one fenced
writer. It may not invent a second Run store transaction protocol.

### 15.8 User-to-project binding saga

User Taskflow routing or bootstrap spans a future user store and a Project
ControlStore. It is never one cross-store atomic write.

The minimum command sequence is:

| Step | Store and Command | Durable result |
|------|-------------------|----------------|
| 1 | UserTaskflowStore `CaptureGoalEnvelope` | immutable source intent/provenance and stable `goalEnvelopeId` |
| 2 | UserTaskflowStore admits routing/clarification/bootstrap Control Segment/Run | user-scoped Run, Receipt, and Proposal Artifact under attenuated effects |
| 3 | UserTaskflowStore `ProposeProjectBinding` | immutable `bindingIntentId`, exact target project reference or reserved new `projectId`, workspace identity, Proposal Evidence, and requester authority |
| 4a | existing Project ControlStore `AcceptGoalAndForkInitialBranch` | unique acceptance indexed by `bindingIntentId`, Project Goal, Branch, Revision 0 |
| 4b | new-project bootstrap Command(s) under the target project writer | idempotent project identity anchor, initial immutable Main version/pointer, then the same unique Goal acceptance |
| 5 | UserTaskflowStore `AcknowledgeProjectBinding` | accepted project/Goal references and handoff status |
| 6 | ControlRegistry rebuild/update | non-authoritative discovery projection only |

The project writer must enforce uniqueness of `bindingIntentId`. A retry with
the same intent returns the existing Project Goal identity; a retry with
different payload or workspace identity fails closed. Project execution may
continue once project-side acceptance commits even if the user acknowledgement
is delayed.

Crash recovery is:

| Crash point | Authoritative observation | Recovery |
|-------------|---------------------------|----------|
| before GoalEnvelope commit | no durable request | caller may retry with the same command/external identity |
| after Envelope, before routing Run | Envelope exists, no Proposal | admit or recover the same user Control Segment/Run |
| provider may have accepted routing/bootstrap work | user Run dispatch intent is possible | reconcile in user ControlDomain; never call the model directly or start a duplicate Run |
| after Proposal, before binding intent | Proposal is non-authoritative | validate again and create one intent; no project mutation yet |
| after binding intent, before project acceptance | user intent is pending | retry the project Command with the same `bindingIntentId` |
| new project anchored, initial Main/Goal not fully accepted | target project identity is fixed | recover under that project's fenced writer; never allocate a second `projectId` for the same intent |
| after project acceptance, before user acknowledgement | Project Goal is authoritative; user view is stale | query/submit by `bindingIntentId`, then acknowledge the existing identities |
| user store unavailable after project acceptance | project work remains valid | continue project execution; retain retryable project acceptance reference and repair user projection later |
| project rejects intent | no Project Goal created | append rejection in user saga; re-route only through a new explicit binding intent |
| Registry update lost or corrupt | authority stores remain intact | rebuild Registry from store references; never recreate Goal/project identities |

The saga may expose `pending`, `accepted`, `rejected`, or
`needs-reconciliation` as a user projection. `needs-reconciliation` is
non-terminal whenever either store may have committed a step that the other has
not acknowledged. UserCoordinatorStore does not own or execute this saga.

---

## §16. Concurrent Goals and isolation

### 16.1 Logical model

One Project Taskflow Main may serve many concurrent Goals:

```text
Project Main v13
├── Goal A · Branch A1
├── Goal B · Branch B1
└── Goal C · Branch C1
```

Each Branch has logically distinct authority for:

- working context and local memory;
- plan and revision stream;
- workspace binding or overlay;
- budget and cancellation scope;
- Runs and Attempts;
- temporary Candidate state.

This list describes ownership and intended topology. It does not claim ambient
filesystem/network/tool confinement; the enforcement level is defined in
§16.4.

### 16.2 Shared project reality

Isolation does not eliminate conflicts in shared reality:

- two Branches may modify the same file;
- both may target the same deployment;
- both may update the same database or service;
- one Branch may invalidate another's context snapshot.

The scheduler therefore needs:

- resource/effect declarations;
- workspace isolation or explicit shared-workspace mode;
- conflict detection before irreversible effects;
- stale-context detection;
- merge/rebase or replan paths;
- project-level effect reservations where necessary;
- honest `unknown` when external state cannot be proven.

### 16.3 Shared caches

Branches may share immutable, content-addressed Artifacts and verified cache
entries. They may not share mutable working memory or treat another Branch's
unverified output as truth.

### 16.4 Workspace topology and enforcement

Every Branch declares both a logical workspace topology and an enforcement
level before a mutable Segment is linked:

| Topology | Allowed use | Conflict rule |
|----------|-------------|---------------|
| `isolated-copy` | worktree, copy-on-write overlay, or separate filesystem root | logical separation only; merge/rebase is an explicit later Segment |
| `read-only-snapshot` | analysis against a pinned root/generation/digest | no declared mutation; dispatch fails stale when required inputs change |
| `shared-serialized` | explicitly selected shared workspace with one mutation owner | project resource reservation serializes writers; readers pin and revalidate generation |
| `external-only` | Goal has no mutable local workspace | external resource/effect declarations still apply |

| Enforcement | Meaning | Concurrency consequence |
|-------------|---------|-------------------------|
| `resolve-only` | Taskflow resolves a different root and checks declared resources, but the Host does not prove filesystem/network/tool confinement | not a security boundary; mutable Segments sharing an ambient authority root are serialized or denied when strong isolation is required |
| `sandboxed` | an exact Host capability probe proves the declared filesystem, network, process, and tool-effect confinement contract | concurrency is allowed only within the probed capability and declared resource/effect bounds |

A worktree, copy, overlay, different current directory, or `workspaceBindingRef`
is logical topology, not proof that an Agent or tool cannot reach sibling
paths, the network, or ambient credentials. The architecture therefore makes
no generic `isolated` security claim. A Branch may advertise strong concurrent
mutable isolation only when the exact Host/provider capability probe establishes
`sandboxed`; otherwise `resolve-only` policy serializes or denies conflicting
mutable work.

The effective `workspaceBindingRef` pinned by each Branch Revision must resolve
to project identity, mode, root/resource
identity, base generation/digest, isolation identity, and cleanup/retention
policy. “Same path” is not proof of same workspace, and different worktrees do
not eliminate conflicts in deployments, databases, services, or later merges.

### 16.5 Resource and effect declarations

Before Link, each effect-capable Segment declares:

```text
read resource keys and required generations
write/effect resource keys
effect class and user visibility
shared or exclusive reservation mode
idempotency/deduplication identity
provider observation and reconcile contract
required Approval and compensation, if any
```

The project scheduler checks again immediately before dispatch. A known request
for an undeclared effect is denied at Link or dispatch. Runtime prevention of
an Agent's undeclared ambient action may be claimed only for a probed
`sandboxed` Host or a provider-mediated effect surface; under `resolve-only`,
the action is a contract violation that must be observed, reconciled, and
reported honestly, not a falsely guaranteed fail-closed boundary. Dynamic
BoundFragments may only attenuate or instantiate resource patterns already
authorized by their BoundPlan; they cannot introduce an arbitrary resource key
or effect class.

| Concurrent case | Admission decision |
|-----------------|--------------------|
| read A + read A at compatible pinned generation | allow |
| read A + write A | serialize or invalidate/replan the reader before its dependent effect |
| write A + write A | one exclusive reservation; loser queues or replans |
| isolated workspace writes, same later merge target | allow isolated work; reserve/serialize merge target and revalidate base |
| two deploys to the same environment/service | exclusive effect reservation; second waits |
| database migration versus any dependent database operation | exclusive migration reservation plus required Approval |
| payment/message/external create with same business identity | stable provider idempotency key or deny concurrency |
| one effect owner is `unknown/reconciling` | retain conflicting reservation; allow only provably disjoint work |
| resource key or generation cannot be resolved | fail closed for effects; read-only investigation may proceed in a separate Segment |

### 16.6 Cancellation, unknown, and capacity

Branch or Goal cancellation is a Command intent, not proof that execution
stopped. For each admitted Segment the system must:

1. request cancellation through its existing Run/provider lifecycle;
2. retain workspace/effect reservations while provider outcome is live or
   ambiguous;
3. reconcile provider and external resource state;
4. terminalize the Run, then the Branch, then the Goal; and
5. release or explicitly transfer reservations only after the authoritative
   settlement predicate holds.

An `unknown/reconciling` Run continues to consume its 0.3 concurrency
reservation according to the existing orphan-suspect rules. A project-specific
effect reservation likewise has no TTL-based safety release while an external
effect may still exist. Operators may force release only through an audited
Command that records the guarantee as overridden; the system must not then
claim safe exactly-once behavior.

Other Branches may continue only on resource/effect sets proven disjoint from
the unknown owner. Capacity pressure is not evidence that the unknown effect
stopped.

An Approval parked before effect dispatch must not monopolize an exclusive
effect reservation when the provider is proven quiescent. The system releases
or downgrades that reservation and retains a non-exclusive pending intent tied
to the Approval, Segment, resource key, and input generations. Approval permits
an attempt; it does not guarantee immediate dispatch. On continuation, the Run
must reacquire its global capacity slot and required effect reservation, then
revalidate Goal/Branch revisions, workspace/resource generations, Main and
Component pins, and the Approval. It may queue or return to planning if those
preconditions changed.

If dispatch may already have begun, the Run becomes `unknown/reconciling` and
retains the conflicting reservation until authoritative settlement. It must
not downgrade the reservation merely because the UI is waiting for input.

### 16.7 Stale-context gate

Immediately before an effect dispatch, the kernel rechecks every declared
input generation, semantic Goal revision, Completion Contract digest, workspace
base, relevant Main/Component pin, Approval, and resource reservation. A
mismatch:

- prevents provider submit;
- records which predicate became stale;
- invalidates only not-yet-dispatched dependent work;
- creates a new planning/rebase/merge Segment when continuation is safe; and
- never changes already submitted Attempt history.

A display-only Goal revision does not stale work. A semantic Goal revision
invalidates every prior unsubmitted Segment or forces an explicit revalidation
and new Branch Revision. A submitted or ambiguous Attempt retains its original
Goal/Contract pins and must settle/reconcile before conflicting replacement
work; the new semantic intent governs all later continuation.

### 16.8 Measurable no-progress

Every Branch Revision records a deterministic semantic-state digest over:

```text
unsatisfied Completion Contract obligations
verified/unknown/contradicted Claim identities and validity
active hypotheses and eliminated alternatives
pending user decisions
resource/effect settlement state
active future Segment semantic hashes
```

A Revision counts as progress only when reachable Evidence establishes at least
one material delta: an obligation is newly satisfied, an unknown/contradiction
is resolved, a hypothesis is evidenced or eliminated, required user input is
obtained, an effect moves toward authoritative settlement, or the executable
affected-set is safely reduced. New prose, renamed nodes, another model vote,
or a different plan with the same semantic state does not count.

The Constitution/Goal policy pins:

- maximum consecutive no-progress Revisions;
- total Revisions, Segments, Runs, Attempts, forks, and dynamic depth;
- elapsed time, tokens, cost, and concurrent capacity;
- effect attempts per business identity; and
- Candidate/Promotion frequency.

When a bound is reached, deterministic policy chooses:

- `waiting-for-input` when an exact recoverable decision is pending;
- `unknown/reconciling` when an effect fact is unresolved;
- terminal `blocked` when no safe continuation is available without new
  authority/capability/prerequisite; or
- terminal `failed` when settled execution exhausted the allowed approaches.

An Agent's assertion that progress occurred or that more iterations may help
does not reset the counter.

---

## §17. State and event model

This section names the required semantics. Exact events and TypeBox schemas
belong in follow-up P-ADRs.

### 17.1 Goal lifecycle

```text
GoalStatus = active | waiting-for-input
           | completed | failed | cancelled | blocked | unknown

GoalStage  = planning | executing | reconciling | terminal
```

Terminal GoalStatus is `completed | failed | cancelled | blocked` and requires
`GoalStage = terminal`. `unknown` is non-terminal and pairs with
`GoalStage = reconciling` whenever work or side effects may still exist.

A Goal may remain `active` while one Branch fails and another continues. Goal
completion is a durable reduction over Branch outcomes and its Completion
Contract; no Agent statement alone is a terminal transition.

Legal Goal status/stage pairs are:

| Status | Legal stage | Meaning |
|--------|-------------|---------|
| `active` | `planning`, `executing`, or `reconciling` | at least one safe continuation remains |
| `waiting-for-input` | `planning`, `executing`, or `reconciling` | a recorded human/external decision is required; stage identifies the suspended boundary |
| `unknown` | `reconciling` only | an execution/effect fact required for a safe decision is unresolved |
| `completed`, `failed`, `cancelled`, `blocked` | `terminal` only | an authorized terminal decision has been committed |

`unknown` must not be normalized to `failed`, and `waiting-for-input` must not
be used when the system is actually uncertain whether an effect is still live.

### 17.2 Branch lifecycle

```text
BranchStatus = active | waiting-for-input
             | completed | failed | blocked | cancelled | superseded | unknown

BranchStage  = planning | queued | executing | reconciling | terminal
```

Terminal BranchStatus is
`completed | failed | blocked | cancelled | superseded`. `unknown` is
non-terminal and pairs with `BranchStage = reconciling`. A Branch head may
advance only through a committed Branch Revision or an explicit terminal
command.

Legal Branch status/stage pairs are:

| Status | Legal stage | Meaning |
|--------|-------------|---------|
| `active` | `planning`, `queued`, `executing`, or `reconciling` | Branch retains a safe executable or recovery continuation |
| `waiting-for-input` | `planning`, `executing`, or `reconciling` | exact pending input/Approval is durable |
| `unknown` | `reconciling` only | provider/effect/workspace truth is unresolved |
| `completed`, `failed`, `blocked`, `cancelled`, `superseded` | `terminal` only | terminal Command committed after effect settlement |

Terminal Branches are never reopened. New user evidence or policy creates a
Goal revision, a new Branch fork, or a new Goal; it does not mutate the terminal
Branch history.

The minimum transition rules are:

| Trigger | From | To | Required proof |
|---------|------|----|----------------|
| accept Goal and initial Branch | no project Goal | Goal `active/planning`; Branch `active/planning` | authorized project binding and atomic initial records |
| admit active Segment | Branch `active/planning|queued` | `active/executing` | stable Segment→Run binding |
| request input/Approval | non-terminal active | `waiting-for-input/<current-stage>` | durable request, options, consequences, and resume cursor |
| supply accepted input | `waiting-for-input/*` | `active/<derived-stage>` | input provenance and still-valid preconditions |
| detect possible unsettled effect | any non-terminal | `unknown/reconciling` | dispatch intent, stale lease, observation fault, or ambiguous provider state |
| reconcile effect | `unknown/reconciling` | `active/<derived-stage>` or validated terminal pair | authoritative observation and reservation disposition |
| commit new Branch Revision | non-terminal Branch at Revision `N` | same status or a validated next status at Revision `N+1` | `expectedRevision: N`, reachable Evidence, atomic Segment links |
| terminalize Branch | non-terminal | terminal pair | exact terminal basis and no relevant live/ambiguous effect |
| supersede Branch | non-terminal | `superseded/terminal` | successor or selection reason plus settled effects |
| terminalize Goal | non-terminal | terminal pair | multi-Branch reduction below and Completion Contract validation |

### 17.3 Multi-Branch Goal reduction

Goal status is not a free-form mirror of the “best-looking” Branch. A
`DecideGoalTerminal` Command must satisfy all common preconditions:

1. every Branch owned by the Goal is terminal;
2. no Branch Run or provider may still execute, incur model/tool cost, produce
   a Proposal, or create an external effect;
3. every required reservation is released or transferred by an authoritative
   record;
4. the Goal revision and Completion Contract used by the decision are pinned;
5. selected result and Evidence references are reachable; and
6. the Command names every non-selected terminal Branch and its disposition.

Then exactly one terminal basis applies:

| Goal terminal status | Additional required basis |
|----------------------|---------------------------|
| `completed` | at least one selected `completed` Branch; the Goal Completion Contract is satisfied by its referenced Evidence; all non-selected Branch effects are settled |
| `cancelled` | authorized cancellation intent covers the Goal and all Branches; cancellation/reconcile completed |
| `blocked` | no selected completed Branch; continuation requires unavailable authority, capability, prerequisite, or decision that is not merely a pending input; the blocker is evidenced |
| `failed` | no selected completed Branch; all admitted approaches settled without satisfying the contract; no recoverable continuation remains under the current Goal constraints |

If user input can still unblock work, the Goal is
`waiting-for-input`, not terminal `blocked`. If an effect may still be live, the
Goal is `unknown/reconciling`, not `cancelled`, `failed`, or `blocked`.

A completed Branch does not automatically complete the Goal while any other
Branch remains non-terminal—even if it is model-only or appears
domain-effect-free. Winner selection first terminalizes every non-selected
Branch as superseded/cancelled/failed/blocked/completed after all of its Runs,
providers, costs, and reservations settle. Only the later Goal terminal Command
makes the result authoritative.

This RFC defines no detached Branch ownership transfer. If a future design
needs work to outlive its Goal, it requires a new authority aggregate and
explicit transfer Command; “non-relevant Branch” is not an implicit escape.

### 17.4 Fork and supersession semantics

`ForkGoalBranch(parentBranchId, parentRevision, forkCommandId)` creates exactly
one child Branch and its Revision 0. The child:

- references the exact parent Revision and immutable reusable Artifacts;
- receives an independent workspace binding, budget, cancellation scope, and
  Segment namespace;
- does not inherit live provider handles, effect reservations, Approvals, or
  mutable context by reference; and
- starts from the parent's Main version unless an explicit compatible adoption
  is committed as part of the child Revision.

Fork does not imply parent cancellation. Supersession is a separate Command.
If the parent has a live or ambiguous effect, supersession remains requested
until that effect settles; the child may not execute a conflicting effect in
the meantime.

Branch “merge” is an evidenced selection that writes a new Revision on a target
Branch or selects a completed Branch for Goal completion. It imports immutable
Artifact/Evidence references and explicit strategy deltas; it never merges
journals, revision numbers, provider handles, or mutable workspaces.

### 17.5 Candidate lifecycle

```text
candidate
→ validating
→ promoted | rejected
promoted
→ rolled-back
```

Rollback does not delete the Promotion record or affected Goal provenance.

### 17.6 Minimum event families

```text
GoalRecorded
GoalDisplayRevised
GoalSemanticsRevised
GoalTerminalDecided

GoalBranchForked
GoalBranchRevisionRecorded
GoalBranchInputRequested
GoalBranchInputProvided
GoalBranchReconcileStarted
GoalBranchReconcileResolved
GoalBranchTerminalDecided
GoalBranchEvidenceClaimReferenced

PlanSegmentProposed
PlanSegmentLinked
PlanSegmentInvalidated
PlanSegmentAdopted
PlanSegmentRunBound
WorkflowOutcomeRecorded

AgentProposalRejected

ExperienceCandidateRecorded
ExperienceCandidateValidated
ExperienceCandidateRejected
ExperienceCandidatePromotionRecorded
ExperienceCandidateRollbackRecorded
CrossScopePromotionIntentRecorded
CrossScopePromotionAccepted

GoalBranchVersionAdoptionProposed
GoalBranchVersionAdopted
GoalBranchVersionAdoptionRejected
```

Events contain exact identity and causal references. User-facing explanations
are projections, not substitutes for domain facts.

Generic `GoalStatusChanged` and `GoalBranchStatusChanged` events are forbidden:
status and stage are projections of semantic Commands/events, not independently
writable truth. Project Taskflow and Component changes use the single
`ExperienceCandidate*` / Promotion stream with a typed candidate kind and
target pointer; they do not create parallel candidate or promotion lifecycles.

`GoalBranchEvidenceClaimReferenced` records a typed Claim and its Evidence
references inside the Branch stream; it does not establish a separate
Observation aggregate. `WorkflowOutcomeRecorded` points to a Receipt-backed
Outcome Artifact; it does not duplicate the Receipt's provider or execution
facts. `AgentInvocationRecorded`, if retained as optional diagnostics, belongs
only to the Run stream and is not part of this minimum domain event set or a
second invocation ledger.

A Branch Snapshot checkpoint may be persisted as a rebuildable optimization,
but it is deliberately absent from the minimum authoritative event families.
It must carry the folded-through event position and digest, be discarded on
mismatch, and never override the journal.

### 17.7 Canonical truth chain

There is exactly one authoritative direction:

```text
Run events
→ Receipt + immutable Artifacts
→ typed evidence claims referenced by GoalBranchRevision
→ BranchSnapshot folds immutable Revisions
→ GoalProjection reduces Branches + Completion Contract + completion Commands
```

Conflicts are appended, not overwritten. A later Revision may classify an
earlier hypothesis as invalidated, but cannot alter the earlier Artifact,
Receipt, claim, or Revision. No Snapshot, Outcome Artifact, Assessment,
AgentInvocation event, Registry entry, or UI projection can move a Branch head,
settle a Run, or mark a Goal terminal.

---

## §18. WebUI product model

### 18.1 User-level entry

The User Taskflow surface is project-first:

```text
Projects
├── work in progress
├── needs your input
├── recent verified results
└── project health
```

It is not a global metric wall or a merged Run ledger.

### 18.2 Project home

The first five seconds answer:

1. Is work currently happening in this project?
2. How far has it progressed?
3. Does the user need to act?

Simple reading order:

```text
Project summary sentence
→ Needs your input
→ Active Goals
→ Recent results
→ Recent verified improvements
```

### 18.3 Goal detail

Simple presents:

1. Goal title and user-readable intent.
2. What is happening now.
3. Current progress and next meaningful step.
4. Why the plan changed, when relevant.
5. Whether user action is required and its consequences.
6. Result and verification.

Simple does not present `Goal Branch`, `Run`, `Attempt`, `BoundFragment`,
provider, hash, or promotion epoch as primary language.

### 18.4 Pro detail

Pro may expose:

- Goal Branch graph and revisions;
- forks and alternative Branches;
- Project Main version lineage;
- Plan Segment and BoundFragment provenance;
- Component pins;
- reuse and invalidation decisions;
- Experience Candidates;
- replay, Promotion, rollback, and adoption evidence;
- Runs, Attempts, providers, events, Artifacts, and Receipts.

### 18.5 Copy principle

Simple says:

> Taskflow adjusted the next steps after the tests exposed an additional
> compatibility issue. Completed work that is still valid will not be repeated.

Pro may additionally say:

```text
Goal Branch revision 4
Project Main v12
Plan Segment ps:…
3 nodes reused, 2 invalidated
candidate exp:…
```

### 18.6 Projection contract

| Simple field | Authoritative source | Pro expansion |
|--------------|----------------------|---------------|
| Goal title/intent | GoalProjection from GoalRecord + revisions | source Goal, revision provenance |
| current state | Goal/Branch status-stage fold | Branch graph, Segment/Run/Attempt states |
| progress/next step | Completion Contract obligations + active Segment projection | obligation Evidence, Segment semantic hash, budgets |
| why plan changed | committed Branch Revision reason projection + Evidence Claims | Proposal/Planning Receipt, invalidations, CAS event |
| needs your input | durable input request/Approval | Approval id, effect class, timeout, resume cursor |
| live-effect warning | Run/provider status + effect reservations | provider handle provenance, reconcile state |
| result/verification | terminal Command + Completion Assessment | selected Branches, Claims, Receipts, verifier versions |
| verified improvement | Promotion record + pointer projection | Candidate, replay corpus, risk gate, rollback target |

Simple copy can summarize these sources but cannot infer a more optimistic
state. If any required source is unavailable or contradictory, Simple displays
that uncertainty rather than a fabricated percentage or zero.

### 18.7 Static Simple/Pro fixtures

#### Fixture A — active replan

```text
Simple
Goal: Fix cursor pagination continuity
Working · Verification found another compatibility issue
Taskflow adjusted the next steps. Completed checks that remain valid will be reused.
Next: update the cursor parser, then rerun 2 affected checks
Live external effects: none
Needs you: no

Pro
Goal active/executing · Branch br:A Revision 4
Planning Run rp:4 settled · Proposal pr:4 accepted by CAS
Work Segment ws:5 · Main v12 · Component cursor-fix@3
3 Evidence Claims reusable · 2 obligations unsatisfied
```

#### Fixture B — Approval before effect

```text
Simple
Goal: Release pagination fix
Needs your decision · Deploy to staging?
No deployment has started.
Approve: authorize the recorded staging deployment; it may wait for capacity
Reject: keep the verified build without deploying
Edit: change the target or verification requirement
Live external effects: none

Pro
Branch waiting-for-input/executing
Approval ap:7 · Segment ws:deploy · Run r:19 parked at cursor c:3
Exclusive effect reservation released; pending intent deploy:staging:pagination retained
Continuation must reacquire capacity + reservation and revalidate all pins
```

#### Fixture C — ambiguous live effect

```text
Simple
Goal: Release pagination fix
Checking external state · The staging provider accepted the deployment, but
Taskflow cannot yet prove whether it finished.
Taskflow will not start a replacement while the first deployment may still be active.
Live external effects: possible
Needs you: no, unless reconciliation requests operator evidence

Pro
Goal/Branch unknown/reconciling
Run r:19 · DispatchIntent + provider handle · terminal observation unavailable
Reservation deploy:staging:pagination retained
Replacement admission denied
```

#### Fixture D — verification failed

```text
Simple
Goal: Fix cursor pagination continuity
Not complete · 2 required compatibility checks failed
Implementation finished, but the result does not meet the completion requirements.
Next: investigate the two failed checks
Live external effects: none

Pro
Work Receipt settled · Completion Assessment not-satisfied
Claims test:a failed, test:b failed · Branch active/planning
No DecideGoalTerminal command
```

#### Fixture E — Branch selected, losing effect settling

```text
Simple
Goal: Choose and release the safest pagination fix
Finishing safely · One verified approach was selected
Another approach may still be stopping, so the Goal is not complete yet.
Live external effects: possible on the non-selected approach
Next: reconcile and settle the non-selected approach

Pro
Branch B completed and selected
Branch A supersession-requested · Run r:A unknown/reconciling
Goal active/reconciling · terminal Command forbidden
```

#### Fixture F — verified completion

```text
Simple
Goal: Fix cursor pagination continuity
Completed · All required checks passed
Result: pagination continuity fixed for the supported cursor formats
Verification: 5 required checks passed; external effects settled
Needs you: no

Pro
Goal completed/terminal · selected Branch B Revision 6
Completion Contract cc:2 · Assessment ca:6
DecideGoalTerminal command dg:1 · Receipt/Claim lineage available
```

#### Fixture G — one Goal across three Runs

```text
Simple
Goal: Fix and verify pagination continuity
Working · The implementation is done; independent verification is running
Progress: plan accepted → fix produced → verification pending
Live external effects: none

Pro
Planning Run rp:1 settled → Work Run rw:2 settled → Verification Run rv:3 active
One Goal · Branch br:A Revisions 1–3 · three immutable Segment→Run bindings
No terminal Command
```

#### Fixture H — ambiguous Planning Run

```text
Simple
Goal: Fix pagination continuity
Checking the planner · Taskflow cannot yet prove whether the planning request stopped.
No code or deployment was changed by this planning attempt.
Taskflow will not start a replacement planner while the first request may still incur work or cost.

Pro
Control Segment control:plan · Run rp:4 unknown/reconciling
Model provider handle exists; no domain-effect authority was granted
Replacement planning admission denied until provider/cost settlement
```

#### Fixture I — Main promoted, old Branch remains pinned

```text
Simple
Goal: Finish the current pagination fix
Working · Taskflow learned a verified improvement for future work
This Goal continues with the version it started with; no active work was hot-swapped.

Pro
Project Main pointer v12 → v13 by Promotion pm:13
Branch br:A remains pinned to Main v12
Adoption status: not proposed; safe checkpoint required
```

#### Fixture J — Candidate replay rejected

```text
Simple
Goal: Fix pagination continuity
Completed · The Goal result remains verified
A proposed reusable improvement failed replay and will not change future project behavior.

Pro
Goal terminal completed under Main v12
Candidate exp:9 rejected · affected-set replay failed
Project Main pointer unchanged; Goal Evidence/Receipts retained
```

#### Fixture K — user router unavailable, accepted project Goal continues

```text
Simple
Goal: Fix pagination continuity
Working in the bound project · New Goal routing is temporarily unavailable
This accepted Goal continues safely; no project history was moved to the user router.

Pro
Binding intent accepted; Project Goal created and acknowledged
Project Goal active/executing
User router ControlDomain unavailable; no authority over the accepted project Run
```

### 18.8 Comprehension and projection acceptance

For every critical fixture, a Simple-only reader must be able to answer without
knowing Branch/Run terminology:

1. Is the Goal complete?
2. What is happening or what happens next?
3. Do I need to decide anything?
4. Is an external effect live or possibly live?
5. What evidence supports a claimed result?

Release acceptance requires:

- deterministic projection tests mapping the same authority fixture to Simple
  and Pro without contradictory status, action, effect, or verification;
- deterministic fixtures cover a Goal spanning three Runs, ambiguous
  model-only planning, Main promotion with an old Branch pin, rejected
  Candidate replay, and router outage after project acceptance;
- no Simple `completed` copy without a terminal Command and satisfied
  Assessment;
- no Simple `failed/cancelled` copy while effect state is ambiguous;
- every Approval shows action, consequences, and whether the effect started;
- every failed verification distinguishes “execution finished” from “Goal
  complete”;
- every `unknown` fixture avoids false progress percentages and exposes the
  retained safety action;
- a moderated comprehension check covering Fixtures A–K where each
  participant answers all five questions; any safety-critical wrong answer
  blocks the copy/layout, regardless of aggregate score; and
- terminology tests ensure Simple does not require `Branch`, `Revision`,
  `Segment`, `Run`, `Attempt`, `Receipt`, hash, or provider vocabulary.

---

## §19. Compatibility with current Taskflow

### 19.1 Existing Taskflow definitions

Existing saved JSON or TypeScript DSL definitions remain valid. They map to:

- Component Taskflows;
- Project bootstrap templates; or
- Goal-specific initial Programs.

They do not automatically become Project Main.

### 19.2 BoundPlan and BoundFragment

Existing immutable plan semantics remain foundational:

- each Plan Segment execution binds one immutable BoundPlan and Run;
- Run-local dynamic paths emit immutable BoundFragments at authorized expansion
  points;
- Goal-level future planning emits a new Plan Segment and Run;
- version adoption does not mutate prior plans;
- both audit identity and execution-semantic identity remain required.

### 19.3 Existing Runs

Historical Runs without Goal identity must not be presented as known user Goals.

Migration may create a compatibility work record:

```text
kind: legacy-run
displayTitle: sanitized Program name
goalAuthority: unavailable
runIds: [historicalRunId]
```

The UI may say “Imported historical run.” It must not claim the Program name
was the user's original Goal.

### 19.4 Current 0.3 RFC

The 0.3 Control Plane remains the Stable Control Kernel foundation. This RFC
does not add its Goal, Branch, Agent-role, or Promotion objects to the 0.3
wire-freeze set:

- scoped project authority;
- immutable BoundPlans/BoundFragments;
- one semantic scheduler;
- provider lifecycle and reconcile;
- ControlStore, Receipt, replay, and rollback;
- no merged user journal.

This RFC requires new P-ADRs before implementation changes:

1. Goal / Goal Branch schemas and events.
2. Branch Proposal, Revision CAS, Workflow Outcome, and completion reduction.
3. Project Taskflow version storage and promotion CAS.
4. Plan Segment / one-Run binding / rolling adoption protocol.
5. single-runtime Control Segment binding, Agent role resolution, invocation
   provenance, structured output contracts, and direct-provider-call
   conformance.
6. Experience Candidate, replay-mode, and risk-gate model.
7. Component registry and compatibility contract.
8. UserTaskflowStore user ControlDomain authority, pre-project Run admission,
   and cross-store bootstrap saga.
9. Web protocol and migration.

### 19.5 Compatibility matrix

| Existing/new state | Reader or caller | Required behavior |
|--------------------|------------------|-------------------|
| saved 0.2 JSON/TypeScript Taskflow | current or future Host | remains a valid Program/Component input; no invented Goal/Main identity |
| historical 0.2 Run store | future UI/reader | read as `legacy-run` compatibility projection; no write-back Goal migration |
| 0.3 Project ControlStore with no Goal feature | future runtime | continue to admit ordinary 0.3 Runs; Goal feature may be initialized only by an explicit migration/enable Command |
| 0.3 Run later referenced by a Goal | future runtime | store the link in future Segment/Goal records; never patch the historical Run wire |
| future Goal-enabled store | old 0.3 writer | reject mutation before opening writer authority; report upgrade required |
| future Goal-enabled store | old read-only tooling | only permitted if the negotiated schema explicitly guarantees projection-safe reading; otherwise fail closed |
| future client requiring Goal capability | old daemon | handshake rejects as unsupported; never silently run as a legacy ungoverned flow |
| old client using existing `taskflow_run` | future daemon | may admit an ordinary 0.3 legacy Program when policy permits; it does not silently create Goal authority |
| future daemon with Goal capability disabled | future Goal client | reject Goal Commands explicitly while continuing compatible ordinary 0.3 Runs |
| UserTaskflowStore unavailable | already accepted project Goal | project execution continues from Project ControlStore; user projection is repaired later |

### 19.6 Schema and feature negotiation

The future protocol must negotiate before mutation:

```text
store schema version
client/daemon protocol version
supported feature ids
required feature ids for this Command
minimum safe reader/writer generation
ControlDomain kind: project | user
```

Rules:

1. unknown authority, permission, effect, state, Command, or lifecycle fields
   fail closed;
2. only fields explicitly classified as projection-only and extension-safe may
   be ignored by an older reader;
3. a writer acquires the same store/singleton fence only after schema and
   feature compatibility succeeds;
4. unsupported Goal, Branch, Segment, Candidate, or Promotion features never
   fall through to a 0.2 runtime;
5. client/daemon skew follows the 0.3 matching-package restart/upgrade model;
6. capability absence is observable in version/health/UI output; and
7. enabling one future feature does not imply User Taskflow, learning,
   auto-promotion, or live canary are also enabled.

Recommended independently gated feature ids are:

```text
goal-identity
goal-branch
rolling-segment
controlled-agent-roles
experience-candidate
project-promotion
user-taskflow
cross-scope-promotion
live-canary
```

Exact ids and wire fields remain P-ADR work.

### 19.7 Migration and downgrade safety

Migration is an authorized, fenced, restartable operation:

1. stop or attach to the sole compatible writer;
2. reconcile live/ambiguous 0.3 Runs before any migration that changes their
   indexing or admission policy;
3. validate store identity, binding evidence, schema, and journal integrity;
4. create a recoverable backup/checkpoint according to the storage P-ADR;
5. append a migration-start record with source/target schema and command id;
6. create additive indexes/projections or future records without renumbering,
   rewriting, or fabricating historical events;
7. validate the migrated fold against the original Run/Receipt set;
8. atomically mark the new schema/feature generation active; and
9. retain a migration result and recovery instructions.

A crash before activation resumes or rolls back incomplete derived structures.
A crash after activation reopens with the new compatible writer. It never lets
an old writer mutate a partially upgraded store.

Binary downgrade is not a storage rollback once future authority events exist.
The supported rollback is:

- use a binary that understands the new schema;
- disable new admissions/features;
- settle or reconcile active future Runs/Segments;
- roll back Project Main/user pointers where applicable; and
- keep future history readable and immutable.

Restoring an older storage snapshot is disaster recovery only and must
reconcile every provider/effect that may have occurred after the snapshot. It
cannot be marketed as ordinary feature rollback.

### 19.8 Graceful degradation

Each layer can be disabled independently:

| Disabled capability | Remaining valid behavior |
|---------------------|--------------------------|
| Goal learning | fixed Project Main; Goal/Branch may execute pinned Segments without creating Candidates |
| auto-promotion | Candidates remain reviewable; no automatic pointer CAS |
| Component registry | use project-pinned local Components only |
| User Taskflow | caller supplies explicit project binding; Project ControlStore remains authoritative |
| Goal identity/Branch feature entirely | ordinary 0.3 `Program → BoundPlan → Run → Receipt` only |

Degradation never rewrites future records into older ones, invents missing Goal
provenance, or enables the legacy runtime for a Command that declared a future
required feature.

---

## §20. Security and safety invariants

1. **No authority from learning.** Adaptation cannot create capabilities not
   already granted by Constitution and current policy.
2. **No history rewrite.** Events, Artifacts, Receipts, and prior versions are
   immutable.
3. **No fake completion.** Completion requires the bound contract and objective
   evidence.
4. **No blind reuse.** Missing equivalence evidence means unavailable reuse.
5. **No in-flight hot swap.** Provider-submitted Attempts settle, cancel, or
   reconcile before replacement.
6. **No raw cross-project learning.** Private project data stays project scoped.
7. **No self-modifying kernel.** The authority and evidence kernel changes only
   through ordinary software release governance.
8. **No LLM authority.** Model output proposes plans and Candidates; it does not
   establish durable truth by speech.
9. **No recursive runaway.** Dynamic generation, Branch forks, Candidate count,
   promotion frequency, depth, time, tokens, cost, and effects are bounded.
10. **No silent version drift.** Every Goal Branch, Plan Segment, Component,
    Attempt, Artifact, and Receipt carries sufficient version provenance.
11. **No split-brain Project Main.** One fenced project authority commits
    versions and promotions.
12. **No scope widening by success.** A successful Goal does not authorize
    project, user, or shared promotion without its own gate.
13. **No mutable Run planning container.** A new Goal-level plan is a new
    Segment and Run; only pre-authorized Run-local expansion may create
    BoundFragments inside an existing Run.
14. **No direct Agent commit.** Agents return proposals, outputs, and
    source-backed projections. Only the fenced Project ControlStore writer
    commits Branch Revisions, completion, and Promotion.
15. **No hidden replay effects.** Pure event replay invokes no provider or
    domain effect. Planner shadowing invokes a model only through a controlled
    Run and cannot invoke project domain effects. Fixture/canary effects require
    their explicit mode and authority.
16. **No shadow Agent runtime.** Every model or external-effect call occurs
    inside a controlled Run and its Attempt/provider lifecycle. Supervisors,
    stores, reducers, projections, and Web handlers cannot call Agent runners
    or providers directly.
17. **No duplicate truth source.** Snapshots, Outcome Artifacts, Observations,
    Completion Assessments, AgentInvocation diagnostics, Registries, and UI
    projections cannot override Run events, Receipts, immutable records, or
    authorized Commands.

---

## §21. Failure modes

| Failure | Required behavior |
|---------|-------------------|
| Goal cannot be mapped to a project | Ask for binding or create an explicitly authorized new workspace. |
| Project Main cannot plan safely | Explain missing capability or constraint; do not fabricate a plan. |
| Supervisor attempts a direct model/provider call | Fail closed as an architecture violation; do not execute or commit its output. |
| Planning Run is ambiguous or still live | Keep the Branch reconciling and retain required capacity; do not invoke a replacement planner directly. |
| Planner Agent emits malformed or unauthorized Proposal | Reject it before Branch commit; retry within bounds or request input. |
| Branch Revision CAS loses a race | Reload the winning Revision and durable evidence, then replan; never overwrite. |
| Branch planner emits invalid Segment | Reject Segment, preserve prior work, retry or request input within bounds. |
| Crash occurs after Segment Link but before Run admission | Preserve the unstarted Segment and resume the same idempotent admission saga. |
| Workflow Outcome contradicts an earlier Claim | Preserve both, append contradiction, expose the proposition as `unknown`, and verify/replan; invalidate only with resolving Evidence. |
| Agent or configured model is unavailable | Apply only an explicitly compatible binding or pause; never silently drift Agent identity. |
| Goal loop makes no measurable progress | Stop at the configured bound and choose waiting/unknown/blocked/failed only from the evidenced predicate in §16.8. |
| Candidate replay regresses | Reject Candidate; Goal result remains valid if independently verified. |
| Pure event replay requests a provider/domain effect | Deny the effect and fail replay; never reinterpret it as planner shadow or canary. |
| Promotion CAS loses race | Reload current Main and re-evaluate Candidate; never overwrite. |
| New Main causes post-promotion regression | Roll back current pointer; preserve evidence and disable repeated auto-promotion. |
| In-flight Goal sees new Main | Stay pinned unless an adoption policy explicitly succeeds. |
| Component upgrade is incompatible | Keep old pin or create explicit migration Segment. |
| Shared workspace changed by another Goal | Mark context stale; merge, rebase, or replan before effects. |
| Provider state is ambiguous | Preserve `unknown`, reconcile, hold required authority/capacity. |
| User-level store is unavailable | Project execution may continue under already-bound project authority; no invented global state. |
| User-to-project bootstrap loses acknowledgement | Recover the durable cross-store saga; do not create a second project authority. |

---

## §22. Rollout horizons

Version numbers are intentionally not assigned in this RFC.

### Horizon 0 — Product and executable model

- Approve terminology and authority boundaries.
- Freeze one Segment execution → one Run and Run-local dynamic Fragment rules.
- Freeze Agent role, Proposal, invocation-provenance, and no-direct-commit
  boundaries.
- Freeze the single-runtime rule: every model/effect role is a controlled
  Segment/Run; only pure deterministic control logic is exempt.
- Add P-ADRs and TypeBox schemas.
- Build reference fixtures before production writes.
- Prototype Simple/Pro projections from static fixtures.

### Horizon 1 — Goal identity

- Persist Goal and Goal-to-Run lineage.
- Accept explicit Goal metadata from Host/CLI.
- Preserve legacy Runs as `legacy-run`, not invented Goals.
- Make WebUI project-first and Goal-first.

No online learning or auto-promotion is claimed.

### Horizon 2 — Goal Branch and rolling plans

- Append-only Branch revisions.
- Branch fork.
- Goal-local working context.
- Branch Snapshot → Planning Segment → Planning Run → Proposal Artifact →
  validated Revision CAS.
- Optional evidence synthesis and completion verification Agents also execute
  as controlled Runs.
- Plan Segment / one-Run binding.
- Run-local BoundFragment generation only at authorized expansion points.
- Receipt-backed Workflow Outcome and completion reduction.
- Affected-set invalidation and evidence-preserving reuse.

### Horizon 3 — Project-local Candidates

- Experience Candidate records.
- Replay corpus and validation.
- Project Main immutable versions.
- Manual project promotion and rollback.

### Horizon 4 — Low-risk automatic promotion

- Executable risk matrix.
- Auto-promotion budget and anti-thrashing.
- Shadow/canary evidence.
- Rolling adoption at Plan Segment boundaries.

### Horizon 5 — Component registry

- Project-local Component promotion.
- Compatibility contracts.
- User-scoped Component registry.
- Explicit cross-project promotion gates.

### Horizon 6 — User Taskflow

- Goal routing.
- Existing-project binding.
- New Project Taskflow bootstrap.
- UserTaskflowStore, user ControlDomain, pre-project controlled Runs, and
  user-level versioning.
- User-level Candidates under strict privacy and evidence gates.

---

## §23. Evidence and release gates

### 23.1 Goal identity

- One Goal spans multiple Runs without losing Run history.
- Two Goals using the same Workflow remain distinct.
- Host-provided Goal provenance survives restart.
- Legacy Run import never claims a known original Goal.

### 23.2 Branch isolation

- Controlled context-store references remain Branch-scoped; a claim that
  concurrent Agents cannot read sibling workspace/network/tool state requires
  the exact `sandboxed` capability, while `resolve-only` serializes or denies
  work that requires that guarantee.
- Shared immutable Artifacts retain exact provenance.
- Declared workspace/resource conflicts are detected before provider dispatch;
  ambient-effect prevention is tested only for sandboxed/provider-mediated
  surfaces.
- Cancel/failure in one Branch does not corrupt another.
- Concurrent planner Proposals against one Revision have exactly one CAS
  winner; losers reload rather than overwrite.

### 23.3 Online adaptation

- A Branch can revise future Segments without modifying completed Segments.
- One Segment execution binds exactly one Run; Goal replanning never appends an
  open-ended Segment to that Run.
- A Run-local dynamic Fragment executes only under a declared and bounded
  expansion point.
- A Workflow cannot mutate Branch state directly; every head change is a
  validated Revision commit.
- Cross-Run facts are traceable to Receipt, Artifact, verifier, user-input, or
  authoritative external-observation references.
- Invalid generated Segments cannot execute.
- Plan-change explanation is deterministic and source-backed.
- Iteration, fork, budget, and dynamic-depth limits terminate.

### 23.4 Agent governance

- User, Project, Component, and invocation Agent bindings resolve
  deterministically under attenuation.
- Router, clarifier, planner, reviewer, evidence synthesizer, completion
  verifier, and Candidate extractor model calls all appear as controlled Runs
  with ordinary Attempt/provider/reconcile semantics.
- A Planning Run's Proposal Artifact and Receipt are durable before any Branch
  Revision based on them can commit.
- Link and invocation provenance record the exact Agent/model/prompt/tool
  identities used.
- Malformed Agent output cannot commit a Revision, complete a Goal, widen
  authority, or promote experience.
- Agent unavailability cannot silently substitute an incompatible binding.
- A planner sees a bounded Branch Snapshot rather than requiring raw historical
  transcripts.
- Static conformance checks and adversarial tests prove that Supervisors,
  stores, reducers, projections, and Web handlers contain no direct model,
  SubagentRunner, script-provider, or effect-provider invocation path.
- A killed or ambiguous Planning Run resumes or reconciles through the same
  kernel and cannot be bypassed by a second direct planner call.

### 23.5 Promotion

- Candidate validation is reproducible from durable evidence.
- Low-risk auto-promotion cannot widen authority or weaken verification.
- Event replay invokes no provider or domain effect. Planner shadowing invokes
  a model only through a controlled Run and executes no project domain effect.
- Fixture and live-canary modes prove their isolation, attenuation,
  idempotency, and Receipt contracts separately.
- Project Main Promotion is one atomic Promotion-record + current-version CAS;
  wider scopes use the equivalent target-scope pointer/eligibility Command.
- Rollback changes future routing/eligibility without deleting promoted history.
- Anti-thrashing prevents recursive promotion loops.

### 23.6 Hot adoption

- New Goals use the new Main immediately after promotion.
- Pinned Goals remain deterministic on the old Main.
- Adopting Goals switch only at a safe boundary.
- Reuse goldens prove exact affected-set behavior.
- Provider ambiguity prevents unsafe duplicate effects.

### 23.7 User Taskflow

- User-level failure cannot corrupt project stores.
- No project event body is required in a merged user ledger.
- Model-based pre-project routing and bootstrap run in the user ControlDomain,
  never UserCoordinatorStore and never an unjournaled Host callback.
- Cross-project Candidate tests prove redaction and scope.
- New-project bootstrap cannot grant itself authority.

### 23.8 UX

- A new user can explain the current Goal, progress, required action, and plan
  change without knowing Branch, Run, BoundPlan, or Receipt.
- Pro users can recover exact Branch/version/Run/evidence lineage.
- Simple never hides uncertainty, live side effects, approval, or failed
  verification.

---

## §24. Non-goals

- Claiming AGI from architecture alone.
- Replacing the underlying foundation model.
- Autonomous modification of the Stable Control Kernel.
- Whole-home implicit project discovery.
- A user-level merged total Run journal.
- Cross-project raw memory sharing.
- Immediate promotion from one successful sample.
- Hot-swapping an active external Attempt.
- A visual node editor as the primary product.
- Making every implementation detail visible in Simple.
- Guaranteeing that every arbitrary Goal is solvable.
- Treating Component popularity as evidence of correctness.

---

## §25. Ordered P-ADR backlog and decision ledger

This RFC freezes architecture semantics, not executable wire. The following
P-ADRs are required in dependency order; their identifiers are provisional but
their boundaries are not.

| Order | P-ADR / owner boundary | Required inputs | Required output | Counterexample it must close | Acceptance |
|-------|------------------------|-----------------|-----------------|------------------------------|------------|
| P-A0 | vocabulary, feature generations, and protocol boundary / product architecture | this RFC, 0.3 P1–P16, public API compatibility | canonical protocol/UI terms; feature ids; version ownership | UI term accidentally becomes wire identity; post-0.3 field enters 0.3 freeze | term map and feature graph reviewed; no 0.3 schema change |
| P-A1 | Goal, GoalRecord, GoalBranchRecord, Revision, lifecycle, fork, terminal reduction / project domain + storage | P-A0; §4, §7–§8, §17 | TypeBox schemas, display/semantic revision classes, Completion Contract digest, events, Commands, folds, CAS and transition tables | planner based on semantic Goal rev 3 commits after the user changes semantics to rev 4; two terminal winners | exhaustive legal/illegal transitions; concurrent Branch/Goal CAS; P-A1 race proves stale semantic revision or contract digest cannot commit |
| P-A2 | Plan Segment binding, one-Run admission, approval continuation, invalidation, and Branch adoption Command / ControlHost + project domain | P-A1; 0.3 Link/Run/Attempt/Receipt P-ADRs; §9, §11 | Segment/Run schemas, Goal+Branch pins, admission key, atomic batch/saga, invalidation/adoption crash protocol | two Runs for one Segment; blind resubmit after ambiguous dispatch; semantic Goal changes between Link and effect gate | crash matrix for planning/work/approval/adoption; P-A2 race proves stale unsubmitted work invalidates and dispatched work reconciles; P-A2 alone owns adoption mutation |
| P-A3 | controlled Agent roles, Component resolution, provenance, substitution, output contracts, runtime conformance / ControlHost + Host adapters | P-A0–P-A2; current bypass inventory; §6.5, §9.6 | resolution algorithm/schema, provenance wire, provider capability contract, import/route conformance | Supervisor direct model call; default-Agent drift; cancelled adapter with live child | all entrypoints route through ControlHost; static boundary test; malformed/drift/cancel tests |
| P-A4 | Evidence Claims, WorkflowOutcome index, Completion Assessment, contradiction/staleness / evidence domain | P-A1–P-A3; Receipt/Artifact assurance | Claim/Assessment schemas, verification policies, source precedence and reducers | provider success becomes fact; two conflicting Outcomes both complete Goal | provenance and conflict fixtures reproduce §9.4; no duplicate terminal authority |
| P-A5 | UserTaskflowStore, user ControlDomain, GoalEnvelope, binding/bootstrap saga / user storage + coordinator integration | P-A0, P-A2–P-A4; 0.3 UserCoordinatorStore/Registry P-ADRs; §14–§15 | separate store header/journal, admission/capacity/retention protocol, saga Commands and recovery | Coordinator becomes total ledger; accepted-before-ack creates duplicate project | per-crash-point recovery, store authority tests, no cross-store atomic assumption |
| P-A6 | workspace/resource/effect concurrency and no-progress / scheduler + workspace policy | P-A1–P-A2; workspace capability RFC; §16 | logical topology, `resolve-only`/`sandboxed` enforcement, resource keys, reservations, stale gate, deterministic progress/bounds | worktree mistaken for sandbox; two worktrees deploy concurrently; TTL releases unknown effect | conflict matrix; Host capability probe; descendants/path-swap/network/tool-effect conformance; resolve-only serialization/denial; approval reacquisition; unknown capacity and progress-digest fixtures |
| P-A7 | Candidate, replay modes, risk, Promotion, cross-scope eligibility/authorization, generic export envelope/saga, rollout recommendation, rollback policy / project learning policy | P-A4, P-A6; §13 | Candidate/Promotion and content-agnostic envelope schemas, affected-set corpus selector, canary/risk/cooldown/quarantine policy, idempotent cross-scope Commands | one success auto-promotes; planner-shadow bypasses Run; target Candidate appears without authorized source Promotion | replay effect-safe; generic scope/risk/saga gates executable with opaque validated payload; rollback cases pass; owns neither Branch adoption (P-A2) nor Component payload (P-A8) |
| P-A8 | Component registry, compatibility, state migration, and Component-specific cross-scope payload / Component domain | P-A3–P-A4, P-A7 generic envelope/saga; §12–§13 | Component version/payload schema, redaction and content addressing, compatibility predicates, migration/withdrawal protocol | incompatible substitute silently adopted; project-private state exported; Component payload bypasses generic Promotion envelope | Component payload redaction/integrity/compatibility/migration fixtures; target writer revalidates it inside the P-A7 saga before one target Candidate |
| P-A9 | store/protocol migration, feature negotiation, version skew, downgrade / storage + daemon/client protocol | P-A0–P-A8 schema outputs; §19 | handshake, reader/writer matrix, fenced migration/recovery and downgrade guide | old writer corrupts Goal store; unsupported feature falls to 0.2 | old/new matrix automated; partial migration crash tests; old writer rejected |
| P-A10 | Web protocol and Simple/Pro projections / product UI + projection layer | P-A1, P-A4–P-A5, P-A7, P-A9; §18 fixtures | query/projection schema, copy states, retention disclosure surfaces | Simple says failed while effect may live; execution-finished shown complete | deterministic fixture tests and safety-critical comprehension check |

P-A0–P-A4 are the minimum critical path for a project-local, fixed-Main Goal
prototype. P-A5 is required before User Taskflow. P-A7 is required before any
learning Promotion. P-A9 is required before a writer enables future authority
in an existing store. P-A10 cannot define states that earlier P-ADRs do not
authoritatively expose.

### 25.1 Original open-question disposition

| Original question | Disposition |
|-------------------|-------------|
| 1. protocol/UI name | human decision H1, then P-A0 |
| 2. Host Goal title revisions | human decision H2; P-A1 enforces provenance |
| 3. workspace isolation modes | architecture answered in §16.4; executable P-A6 |
| 4. minimum replay corpus | architecture answered by semantic affected-set in §13.5; executable P-A7 |
| 5. automatic rolling-adoption Candidate kinds | project low-risk only; exact kind allowlist in P-A7 and Constitution |
| 6. Component state migration | P-A8 |
| 7. UserTaskflowStore boundary | architecture answered in §15; executable P-A5 |
| 8. bootstrap template selection | controlled Agent Proposal + deterministic validation; P-A3/P-A5 |
| 9. project→user information | scope lattice/redaction floor in §13.4; human decision H6 + P-A7/P-A8 |
| 10. product name for multi-Branch completion | human decision H3; semantics already fixed in §17.3 |
| 11. concrete Agent selection | architecture answered in §6.5.1: selectable only when Main exposes it; P-A3 |
| 12. deterministic vs Agent Outcome extraction | Agent may propose Claim/Assessment Artifacts; deterministic validation/commit; P-A4 |
| 13. multi-Branch Goal reduction | architecture answered in §17.3; executable P-A1 |
| 14. measurable no-progress | architecture answered in §16.8; executable P-A6 |
| 15. user routing Proposal/Receipt retention | safety floor in §15.2; human decision H4 + P-A5/P-A10 |

### 25.2 Human product/trust decisions

These choices cannot be derived from code. The user accepted H1–H6 on
2026-07-25. The accepted decisions preserve the safest reversible defaults:

| ID | Decision | Accepted default | Alternatives and consequence |
|----|----------|---------------------|------------------------------|
| H1 | protocol term | protocol and UI both use `ProjectTaskflowVersion`; avoid a second synonym | `ProjectExecutionModelVersion` is more precise but creates translation and migration cost |
| H2 | Host title revision | Host change becomes a proposed display revision; original intent remains; auto-accept only for same trusted source under explicit policy | universal auto-accept risks Host/model rewriting user intent; manual-only adds friction |
| H3 | multi-Branch completion copy | Simple says “Completed” and optionally “selected the verified approach”; “winner” appears only in Pro tournament context | “Winning Branch” exposes implementation language and implies other evidence was worthless |
| H4 | user routing retention/disclosure | retain structured Envelope/Proposal/Receipt while saga, reconcile, audit, or Promotion depends on it; no raw chain-of-thought; show user a purpose/scope/delete control | fixed long retention increases privacy risk; immediate deletion breaks recovery/audit |
| H5 | whole-root rollback trust | never claim automatic whole-root rollback; use provider/workspace-specific compensation and mark unavailable/unknown when proof is missing | snapshot restore without external reconciliation creates false safety |
| H6 | cross-project Promotion responsibility | explicit user approval for project→user; explicit package owner/reviewer for shared; target project revalidates | automatic widening risks private-data leakage and unowned policy change |

The live-canary decision is already resolved to a default-deny safety floor in
§13.3. A product may narrow it without another architecture decision; any
widening becomes an explicit H6-style trust decision and policy release.

---

## §26. Final model

```text
User supplies Goal
       │
       ▼
User Taskflow routes or bootstraps project
       │
       ▼
Project Taskflow Main vN
       │ fork
       ▼
Goal Branch · Revision N
       │ deterministic role resolution
       ▼
immutable Planning Segment PS1
       │
       ▼
Planning Run RP1 · ordinary Control Kernel
       ├── planner Component / Agent phases
       ├── Attempt / provider / reconcile
       └── Proposal Artifact + Receipt
                    │
                    ▼ validate + CAS
          Goal Branch · Revision N+1
                    │
                    ▼
          immutable Work Segment WS1
                    │ one Segment execution = one Run
                    ▼
          Work Run RW1 · BoundPlan
             ├── controlled dynamic BoundFragments
             ├── Component Agents execute phases
             └── Attempts / Artifacts / Receipt
                    │
                    ├── optional Synthesis / Verification Runs
                    ▼
          Workflow Outcome + Evidence Claims
                    │ CAS append
                    ▼
          Goal Branch · Revision N+2
             ├── stop / wait / fork
             ├── start next Planning Segment / Run
             └── propose Experience Candidate
                            │
                            ▼
                 pure event replay or controlled shadow
                 + tests + explicit risk gate
                            │
                            ▼
                Project Taskflow Main vN+1
```

The design principle is:

> **Mutable understanding, immutable history, scoped promotion.**

Goal Branches learn across Runs by appending immutable Revisions derived from
Receipt-backed evidence. Agents propose plans, execute Components, synthesize
evidence, and verify contracts, but the fenced Control Kernel alone commits
Branch heads, completion, and Promotion. Project Main changes only through
verified promotion. User-level generalization is possible, but it is built from
explicitly scoped, redacted, replayed capability—not from merged journals or
unverified model memory.

The execution constitution is:

```text
Every model or external-effect call occurs inside a controlled Run.
Every durable mutation is a Command.
Every trusted claim references Evidence.
Every scope widening is a Promotion.
```
