# CharterArc North-Star Goal

Status: active product mandate. The prior thin-loop experiment remains useful
infrastructure evidence, but it is not the CharterArc product promised here.

## Source and authority

This Goal is authorized by the user and is grounded in three source documents:

- [Taskflow 的下一代：从 Agent 工作流到会维护项目的声明式框架](https://vrfi1sk8a0.feishu.cn/docx/FGwbd3AQOoL9yOxa9MHc0P57nbg),
  revision 23, defines the product and near-term architecture.
- [Taskflow 终极哲学](https://vrfi1sk8a0.feishu.cn/docx/Bdk1dBvDXotj6hxb5JScJ5fTnWg),
  revision 98, supplies long-term judgment, authorization, and revocation
  disciplines; it does not require exposing its ontology in the first product.
- [第二轮推演记录](https://vrfi1sk8a0.feishu.cn/wiki/PhHLw88qQi68E8kN28tcUIxYnub),
  revision 4, records rejected routes and candidate mechanisms. Nothing in it
  becomes a kernel invariant merely because it is philosophically attractive.

The user owns this Goal. Model output may propose a revision, but cannot reduce,
replace, retire, or reinterpret the promise without explicit user authority.

## Goal

Build and validate the smallest declarative framework that lets an author
maintain a software project by declaring what must stay true, how reality is
observed, and which reusable Taskflows may reconcile different observed gaps.

> Authors maintain a Project, optional Modules, and reusable Flows. CharterArc
> observes a project snapshot, selects and binds the next ordinary Taskflow,
> Taskflow executes one bounded Run, and CharterArc observes reality again.

CharterArc succeeds only if this authoring model removes repeated orchestration
and human judgment from real project maintenance. It does not succeed because
the package exists, the repository is green, a release workflow is ready, or a
fixed maintenance Taskflow can be wrapped in `observe -> run -> observe`.

The short product promise remains:

> Define what must stay true. CharterArc runs the agent work that keeps it true.

## The product difference that must exist

Taskflow already answers:

> Given a bounded Flow, how is its phase/DAG/FlowIR verified, executed,
> recovered, resumed, replayed, and observed?

CharterArc must answer a different question:

> Given a long-lived declaration, a current project snapshot, and an optional
> Goal or event, which bounded Flow should exist now, with what bindings and
> authority?

The intended composition is:

```text
Project Template vN + Snapshot t + Goal/Event
                  |
                  v
       deterministic-first Reconciler
                  |
                  v
       selected or proposed Taskflow
                  |
                  v
       bind inputs / scope / authority
                  |
                  v
       verify existing DAG / FlowIR
                  |
                  v
            one Taskflow Run
                  |
                  v
       Outcome + observe Snapshot t+1
```

A CharterArc Run may look identical to an ordinary Taskflow Run. The qualitative
difference must be visible before the Run: authors do not hand-write the
imperative observation, branching, Flow selection, argument binding, execution,
and re-observation glue for every maintenance case.

## Minimal authoring surface

The default vocabulary is deliberately limited to:

- **Project** — the long-lived declaration and global boundary;
- **Module** — an optional scoped declaration used only when a real project is
  too large for one responsibility boundary;
- **Flow** — an existing Taskflow used as a reusable maintenance component.

`desired`, `observe`, and `maintain` describe those concepts. Their exact
TypeScript helper shape is an implementation question, not an excuse to add a
second ontology. The first slice must keep the following semantics visible:

- desired promises are identifiable and checkable enough to explain a gap;
- observations produce an explicit snapshot or an explicit `unknown`, not only
  free-form narration;
- a Project can retain more than one existing Taskflow and state when each is
  applicable;
- a Module narrows scope and context; it does not create another runtime;
- the Reconciler returns zero or one bound Flow in the first slice;
- the selected Flow remains a normal Taskflow and can still run independently.

Snapshot, selection, bound Flow, Run, and Outcome are runtime records. They are
not additional concepts the ordinary author must manage.

## Formal boundary

For template version `T_v`, observed project state `S_t`, event or Goal `E_t`,
and optional model capability `M`:

```text
S_t = Observe(T_v, reality)
G_t = Reconcile(T_v, S_t, E_t, M)
O_t = Execute(Verify(Bind(G_t)))
S_t+1 = Observe(T_v, reality after O_t)
```

For the first product slice, `Reconcile` is deterministic. A model-planning
seam is admitted only after a real case cannot be expressed as deterministic
selection of existing Flows. Even then, the model may propose `G_t`; it cannot
authorize or execute an unverified graph.

`T_v` is not rewritten by ordinary `O_t`. Template or policy changes are
separate proposals and require the authority appropriate to their effect.

## Delegated authority

The primary agent is the user's product and engineering proxy for reversible
work in this repository and isolated consumer branches. It may choose the next
contradiction, bind immutable acceptance, refactor or delete code, reject a
Grok attempt, and decide whether observed evidence justifies the next small
capability.

All model-driven CharterArc self-evolution implementation and model review use
Grok Build through the existing `grokSubagentRunner`. No Codex, Claude,
OpenCode, Pi, or ad-hoc model-agent fallback is allowed. The primary owns
product judgment, acceptance, independent verification, and final retention.

Delegation does not authorize:

- changing this Goal, Project Policy, user preference, permission, or stable
  compatibility promise;
- publishing, tagging, pushing, or merging without the separately required
  execution-time approval;
- destructive external operations, production changes, paid-service changes,
  credential expansion, or hidden effects;
- accepting a modified or weakened acceptance boundary merely because a model
  produced it.

## Non-negotiable runtime boundaries

1. **Reality outranks narration.** External state and real consumer behavior
   outrank fixtures; mechanical checks outrank source inspection; source
   inspection outranks model reports.
2. **Healthy means zero Run.** A satisfied snapshot starts no Taskflow and no
   model.
3. **Unknown grants no authority.** Missing, malformed, timed-out, ambiguous,
   or infrastructure-dependent observations cannot select a Flow or mutate
   reality.
4. **One selection, one bounded Run.** The first slice selects at most one Flow.
   Retry, resume, and approval continuation may stay in that Run; a changed
   plan, authority, major input, or completion condition creates a new Run.
5. **Verify before execute.** Every selected or model-proposed Taskflow is
   statically verified after bindings and before a phase starts.
6. **Taskflow remains the execution substrate.** CharterArc adds no phase kind,
   DAG engine, FlowIR, scheduler, host runner, cache, replay engine, or control
   plane.
7. **Outcome is not authorization.** A successful Run cannot silently modify
   desired promises, Policy, permissions, the Goal, or future compatibility.
8. **Acceptance precedes repair.** A concrete red product contract is bound
   before Grok may edit implementation. Grok cannot edit that contract during
   the attempt.
9. **Prefer reversible scope.** Work stays local, observable, bounded, and easy
   to reject. Rare cases are ignored unless they risk loss, security, wrong
   authority, hidden effects, or irreversible compatibility debt.
10. **Optimize judgment, not activity.** Runs, agents, tokens, generated code,
    approvals, reports, and concepts are costs unless they reduce the human
    judgment needed for a verified accepted change.

## Philosophy that constrains later stages

The following three boundaries apply when the corresponding capability exists:

1. a conclusion promoted into long-lived belief retains scoped, invalidatable
   support and loses standing when its complete support sets fail;
2. Goal, preference, Policy, permission, and commitment survive only through an
   authorized write; model output is never authorization;
3. any claim of tamper-evident history must be relative to an independent trust
   anchor; a self-written hash chain alone is not absolute integrity.

The following are strong engineering policies, not natural laws: judgment is
the dominant scarce resource, criteria deserve more reuse than vague intent,
negative results can carry information value, and reversible actions deserve a
larger autonomy envelope.

The proposed rule "a non-responsible actor's effects must be observable" stays
candidate only. Persistent claim records, foreclosure debt, exposure views, liquidation,
owner credit limits, and bandit allocation are forbidden in the current slice.
They may be reconsidered only after "skipping a route must cite a persistent
claim" exists as a mechanically auditable edge and real consumers need it.

## Explicitly out of scope now

- automatic learning or template self-modification;
- general Knowledge, Claim, Evidence, Receipt, Decision, or Promotion systems;
- Goal Graphs, Project State DAGs, preference models, semantic conflict
  detection, markets, voting systems, or Agent incentive economies;
- daemons, watchers, always-on schedulers, registries, generic repository
  adapters, and cross-project memory propagation;
- model-generated Flow as the default path;
- support for many simultaneous selected Flows in one reconcile cycle;
- new Taskflow execution semantics added merely to make CharterArc look new.

## Immediate falsifiable vertical slice

The next implementation target is one self-dogfooded Project declaration with
at least two reusable existing Taskflows and, only if the scope is real, one
Module. Immutable acceptance must prove all of the following:

1. the same Project declaration observes a healthy state and starts no Run;
2. an ambiguous or failed observation returns `unknown` and starts no Run;
3. observed gap A deterministically selects Flow A;
4. observed gap B deterministically selects Flow B;
5. each selected Flow is bound with the snapshot and relevant desired promise,
   passes existing Taskflow verification, and executes as exactly one ordinary
   Taskflow Run;
6. post-Run observation, not model narration, determines the latest state;
7. the author writes no imperative dispatcher that calls `executeTaskflow` for
   each branch;
8. both component Taskflows remain independently valid and executable;
9. no new phase, scheduler, IR, daemon, persistent record system, or automatic
   learning appears;
10. the root CharterArc project uses this path to evolve CharterArc with one
    Grok repair and one read-only Grok review inside the selected Taskflow.

The slice is not accepted merely because two callbacks are wrapped in a helper.
The declaration must own selection semantics and remove a real bespoke
dispatcher or equivalent orchestration glue.

## Autonomous evolution loop

Repeat without asking the user to choose an ordinary implementation step:

1. **Observe the product gap.** Compare source and real consumer declarations
   with this Goal, not with the current API.
2. **Choose one contradiction.** Prefer the earliest unmet vertical-slice
   criterion or a safety failure blocking it.
3. **Bind immutable acceptance.** Make the product difference fail before
   implementation changes.
4. **Verify the maintenance Flow.** Static verification is mandatory and costs
   no model tokens.
5. **Run CharterArc once.** Confirmed drift may launch one ordinary
   Grok-repair -> read-only-review Taskflow. Healthy and unknown launch none.
6. **Re-observe and verify independently.** Require both observed satisfaction
   and a non-failed, non-blocked Run, then run the authoritative repository or
   consumer command.
7. **Retain, narrow, or reject.** Model PASS is not acceptance. Remove any
   concept not required by the bound case.
8. **Record only durable evidence.** Prefer a regression test and a concise
   correction over a new runtime object or permanent report.
9. **Continue from fresh reality.** Do not manufacture work to keep the loop
   active.

### Work-selection order

Use this lexicographic order:

1. wrong authority, hidden effects, data loss, security, or irreversible
   compatibility risk;
2. the earliest failing criterion of the immediate vertical slice;
3. a real consumer blocker preventing migration to Project/Module/multi-Flow
   selection;
4. repeated authoring or recovery glue observed in at least two consumers;
5. deletion or simplification preserving the demonstrated product difference;
6. model planning requested by a case deterministic selection cannot express;
7. long-term learning and governance machinery: do not implement now.

## Milestones

Milestones are evidence gates, not feature quotas.

### M0 — Safe thin loop, retained as substrate evidence

The existing `observe -> fixed Taskflow -> observe` loop, fail-closed unknown,
Grok-only self-evolution, packed consumption, and governance-digest checks are
useful substrate evidence. M0 does not prove the CharterArc product and does
not justify publication by itself.

### M1 — Declarative product difference

The immediate vertical slice passes all ten criteria above. One declaration
routes at least two real observed gaps to two independent existing Taskflows,
with no handwritten execution dispatcher and no Taskflow runtime duplication.

### M2 — External authoring value

At least three independent, real repositories choose to keep a Project
declaration because the new surface is clearer and smaller than their exact
plain-Taskflow or manual-dispatch baseline.
Each must exercise at least two observed routes or one route plus a meaningful
Module boundary. Local ignored dependencies and frozen integration branches do
not count as adoption.

The three existing consumer branches remain pending activation candidates.
They must migrate from the thin fixed-Flow wrapper and pass a clean registry
install before any merge can count.

### M3 — Adaptive planning seam

Only if retained consumers present an open maintenance need that deterministic
selection cannot express, allow Grok to propose a bounded Taskflow at an
explicit planning seam. The proposed graph must satisfy a declared schema,
security caps, static verification, authority binding, and one-Run semantics.
Failure returns `unknown` or a non-authorizing planning failure, never an
unverified execution.

### M4 — Comparative value proof

Run at least 20 natural maintenance cycles across at least three retained
projects and observe them for at least four weeks. Compare the same completion
standard against plain Taskflow or the prior manual/single-Agent path. Pass only
if:

- median human judgment minutes per accepted change falls by at least 50%;
- median time to verified change improves;
- rework and rollback are no worse than the baseline;
- no mutation came from `unknown`, undeclared authority, or rewritten
  acceptance;
- the default authoring surface remains Project, optional Module, and Flow.

All cycles collected before M1 are engineering evidence, not M4 product cycles.
They may reveal safety or operational lessons but cannot validate the missing
declarative selection layer.

### M5 — Learning and stable product decision

After M4, decide separately whether repeated work justifies scoped, revocable
knowledge or Component improvement. Add no learning mechanism without a real
repeated dead end and a mechanically testable invalidation path.

Before M4, npm `experimental` dist-tag publication remains permitted in
principle under the user's earlier authorization, but is currently paused until
M1 passes and a fresh execution-time publish checklist is explicitly approved.
It must not set or move `latest`, enter the stable Taskflow release, promise
stable compatibility, or count as adoption evidence.

Only after M4 may the `latest` dist-tag or a stable compatibility promise be
proposed. A stable release remains a distinct user-authorized decision.

## Measurement

Longitudinal evidence lives in [cycle metrics](./charterarc-cycle-metrics.md).
That file is experiment evidence, not runtime state or mutation authority.

For every real post-M1 cycle, record only decision-relevant measures:

- human judgment minutes and substantive user interventions;
- selected-to-verified elapsed time;
- accepted, narrowed, rejected, reworked, and rolled-back outcomes;
- authoritative verification and observation result;
- plain-Taskflow/manual baseline for the same class of work;
- model turns, tokens, reported cost, and unavailable fields as `—`;
- authoring concepts and bespoke dispatcher/glue added or removed;
- any hidden effect, unknown-authorized mutation, acceptance rewrite, or
  repeated previously rejected route.

The North Star metric is:

> Verified, accepted, non-reverted change per unit of human judgment.

Activity volume, package downloads, test count, local branches, and model spend
are not substitutes for this metric.

## Stop, fold-back, and rejection rules

Reject an iteration even when tests and Grok say PASS if the real consumer
contradicts it, acceptance moved during the attempt, unrelated work changed,
effects escaped scope, a selected Flow bypassed verification, or the change
adds ontology without removing observed judgment or glue.

Pause and reconsider CharterArc if the M1 declaration is not materially clearer
than a small plain-Taskflow dispatcher. Fold CharterArc back into Taskflow if
three retained consumers do not remove real orchestration glue or if the
Project/Module/Flow layer increases review burden. The Goal is better project
maintenance, not CharterArc's survival.

Do not use experimental publication, more consumers, or more autonomous cycles
to evade a failed product-difference test.
