# CharterArc autonomous evolution goal

Status: active operating mandate for the pre-stable CharterArc experiment.

Source of direction: [Taskflow 的下一代：从 Agent 工作流到会维护项目的声明式框架](https://vrfi1sk8a0.feishu.cn/docx/FGwbd3AQOoL9yOxa9MHc0P57nbg), revision 23.

## Goal

Evolve Taskflow and CharterArc into the smallest useful declarative framework
for agent-maintained software projects:

> A project author defines what must stay true. CharterArc observes reality,
> selects the next bounded maintenance attempt, and uses Taskflow to make and
> verify the change. Over time, real projects require less human task
> decomposition and less human review without accepting more regressions or
> granting hidden authority.

This goal is not satisfied by adding a package, passing this repository's test
suite, or completing one self-edit. It is satisfied only when retained use in
real projects shows that the framework produces more verified, accepted,
non-reverted change per unit of human judgment than the alternatives it is
meant to replace.

## Product destination

The product should feel closer to Vue than to a workflow control panel:

- authors maintain a small Project declaration, not a growing collection of
  Agent prompts and governance records;
- `desired`, `observe`, and `maintain` are sufficient until real consumers
  prove that another authoring concept is unavoidable;
- Taskflow remains the built-in execution language: its phases, DAG, FlowIR,
  verification, recovery, and replay are reused rather than reimplemented;
- healthy projects start no model work; insufficient evidence authorizes no
  mutation; confirmed drift creates one bounded Taskflow attempt;
- internal execution and evidence objects remain internal unless exposing one
  demonstrably reduces author judgment.

The public promise is:

> Define what must stay true. CharterArc runs the agent work that keeps it true.

## Delegated decision authority

The user delegates day-to-day product and engineering judgment for this goal to
the primary agent. The primary agent chooses the next problem, prioritizes work,
defines acceptance, makes reversible architecture and API trade-offs, rejects
bad attempts, removes unnecessary code, and decides whether evidence justifies
the next capability. It should not stop merely because several reasonable
implementations exist.

All model-driven self-evolution implementation and model review use Grok Build
through the existing `grokSubagentRunner`. No Codex, Claude, OpenCode, Pi, or
ad-hoc model-agent fallback is allowed. The primary agent is the user's product
and engineering proxy: it frames each experiment, controls acceptance, checks
the real result, and retains or rejects Grok's work.

This delegation covers reversible work inside the project and its isolated
consumer experiments. It does not silently authorize publishing or releasing
packages, pushing or merging shared branches, production or paid-service
changes, destructive data operations, credential or permission expansion, or
weakening this goal's product promise. Those effects still require explicit
user authority. A model may propose a change to the goal or a boundary, but its
output alone is not authorization.

## Non-negotiable boundaries

1. **Reality outranks narration.** A real consumer command or external state
   outranks a test; a mechanical test outranks source inspection; source
   inspection outranks a Grok review; a Grok report is never proof by itself.
2. **One iteration, one contradiction.** Each cycle attacks the smallest
   observed gap between the North Star and current reality. It does not build a
   speculative platform around the gap.
3. **Acceptance precedes repair.** The failure must be observable before Grok
   may mutate implementation. Grok cannot edit, delete, rename, or weaken the
   acceptance boundary during the attempt.
4. **Unknown is not drift.** Missing dependencies, ambiguous output, wrong
   workspace, unavailable providers, and unclassified failures do not authorize
   source mutation.
5. **Bound every attempt.** A confirmed drift creates at most one ordinary
   Taskflow Run. Repair and review have finite time, tools, workspace, and
   effect scope. A new understanding or plan becomes a new Run.
6. **Delete before abstracting.** Reuse an existing Taskflow phase, DAG, runtime
   seam, or ordinary test before adding a CharterArc concept. A public concept
   needs repeated pressure from at least two retained real consumers.
7. **Do not optimize the rare hypothetical.** Ignore cases unlikely to appear
   in ordinary use unless they can cause data loss, security failure, wrong
   authorization, hidden external effects, or irreversible compatibility debt.
8. **No silent learning.** Ordinary Outcomes update reality and history. They
   do not automatically rewrite the Project declaration, Goal, Rule, or
   long-lived knowledge.
9. **Preserve the substrate.** Existing Taskflow definitions continue to run
   independently and can be used as CharterArc maintenance flows. CharterArc
   must not grow a second scheduler, IR, phase system, host runner, or control
   plane.
10. **Prefer fewer human decisions, not more Agent activity.** More Runs,
    agents, tokens, generated code, or internal objects are costs unless they
    reduce verified end-to-end judgment.

## Autonomous iteration loop

The primary agent repeats this loop without waiting for the user to choose an
ordinary next step:

1. **Observe.** Inspect current source, tests, dogfood evidence, retained
   consumers, and the last rejected attempts.
2. **Choose.** Select the highest-priority concrete contradiction using the
   order below. State one falsifiable claim for why closing it advances the
   Goal.
3. **Bind acceptance.** Add or identify the smallest immutable check that
   distinguishes success, drift, and unknown. Record the authoritative real
   command when a fixture cannot prove the product claim.
4. **Attempt.** Run the root CharterArc declaration. A healthy observation is a
   zero-model no-op; confirmed drift invokes one Grok-only repair then one
   Grok-only read-only review through an ordinary Taskflow.
5. **Re-observe.** Require the same observer to report `satisfied` and require
   the Taskflow Run itself not to have failed or been blocked.
6. **Verify reality.** Run the real consumer, packaging, host, or repository
   command that carries authority for the claim. Inspect the diff and side
   effects independently of Grok's report.
7. **Decide.** Retain, narrow, or reject the attempt. Rejection is a useful
   Outcome when it rules out an abstraction or exposes a missing criterion.
8. **Keep only durable learning.** Preserve the lesson as the smallest ordinary
   regression test, concise document correction, or narrower declaration.
   Replace the rolling dogfood criterion for the next slice rather than
   accumulating a new permanent record.
9. **Continue.** Select the next contradiction from fresh evidence. Do not add
   work merely to keep the loop busy.

### Work-selection order

Use a lexicographic order, not a fabricated precision score:

1. data loss, security, wrong authorization, hidden external effects, or
   irreversible compatibility risk;
2. a failure that blocks a retained real consumer from adopting or relying on
   CharterArc;
3. repeated authoring, bootstrap, recovery, or review friction observed in at
   least two retained consumers;
4. deletion or simplification that preserves demonstrated behavior;
5. new capability requested by one real case and impossible to express with
   the current Project declaration plus Taskflow;
6. speculative completeness, elegance, or rare edge cases: do not do them.

## Evidence milestones

Milestones are evidence thresholds, not feature roadmaps. The next milestone is
allowed to change the implementation plan, but not the Goal or boundaries.

### M1 — Trustworthy minimal loop

The repository self-consumer proves `observe → one Taskflow → re-observe`,
healthy checks make zero model calls, ambiguous failures cannot mutate source,
and packed consumption works without workspace-only resolution.

### M2 — Retained external adoption

At least three independent, real repositories choose to keep a Project
declaration because it is simpler than their prior manual Agent workflow. Any
repeated bootstrap seam is measured before a helper or new API is added.

### M3 — Proxy-selected maintenance

Across real maintenance needs, the primary agent can select the next bounded
problem, bind acceptance, dispatch Grok-only repair and review, reject bad work,
and reach verified reality without the user decomposing the task. User input is
reserved for effects outside delegated authority or a genuine change in the
North Star.

### M4 — Comparative value proof

Run at least 20 real maintenance cycles across at least three retained projects
and observe them for at least four weeks. Compare against the projects' prior
single-Agent or manual orchestration baseline using the same completion
standards. The working product hypothesis passes only if:

- median human judgment minutes per accepted change falls by at least 50%;
- median time to verified change improves;
- rework and rollback rate is no worse than the baseline;
- no mutation was authorized from `unknown`, and no undeclared authority or
  acceptance rewrite was accepted;
- the default authoring surface is still understandable as Project, optional
  Module, and Flow rather than an exposed governance ontology.

The numerical thresholds are falsifiable product targets, not natural laws. A
proposal may make them stricter. Weakening them or changing the product promise
requires explicit user authorization.

### M5 — Stable public product decision

Before M4, CharterArc may publish semver prereleases only through the npm
`experimental` dist-tag when that distribution is needed to make M2/M4 adoption
measurable. An experimental publication must not set or move `latest`, publish
the stable Taskflow package set, claim stable compatibility, or count as product
validation. Every actual publish and consumer merge still requires an explicit
execution-time review and approval.

Only after M4, decide whether CharterArc deserves the `latest` dist-tag and a
stable compatibility promise. Publish no stable release merely because the
implementation is complete. If comparative value is absent, reduce or end the
abstraction and retain Taskflow as the bounded workflow runtime.

## Metrics recorded for every real cycle

Longitudinal sample and per-cycle rows live in the [cycle metrics](./charterarc-cycle-metrics.md)
file. That file is experiment evidence only; it is not runtime state and does
not authorize mutation. Its operational definitions, baseline eligibility, and
missing-value rules are normative for the M4 comparison; activity counts must
not be promoted into substitutes for missing human-time or verification-time
evidence.

Keep measurement lightweight:

- human judgment minutes and number of user interventions;
- time from selected contradiction to verified change;
- accepted, narrowed, and rejected attempts;
- real verification command and result;
- rework or rollback during the observation window;
- model turns, tokens, cost, and unavailable accounting fields;
- whether the cycle repeated a previously disproved route;
- whether a new public concept was added, deleted, or avoided.

The North Star metric is:

> Verified, accepted, non-reverted changes per unit of human judgment time.

## Stop and rejection rules

Reject an iteration even if Grok and the local suite say PASS when the real
consumer contradicts it, acceptance changed, unrelated work moved, effects
escaped the declared scope, the API expanded without repeated adoption
evidence, or the change only makes the theory more complete.

Stop expanding CharterArc and reconsider the abstraction if longitudinal
evidence does not reduce human judgment, if governance creates a larger review
surface, or if most real projects still need to understand the internal object
model. The Goal is improved project maintenance, not CharterArc's survival.
