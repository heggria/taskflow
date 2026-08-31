---
name: taskflow
description: >-
  Use Taskflow to delegate or orchestrate bounded work with isolated subagents:
  use cheaper or specialized agents, preserve your context, apply specialized
  skills or narrower tools, run independent work in parallel, coordinate dependent
  steps, review or verify results, process many discovered items, and keep long-running
  work tracked, resumable, or reusable. Common uses include research, engineering,
  software development, audits, migrations, data or document analysis, and repeatable
  workflows. Drives the taskflow_* MCP tools.
---

<!-- GENERATED FILE — do not edit. Source: skills-src/taskflow/entry.codex.md + core.md (npm run build:skills) -->

# Taskflow (Codex)

**Host binding (Codex):** everything below is driven through the `taskflow_*`
MCP tools. Where an example shows a host-neutral invocation like `verify`, use
the Codex form (`taskflow_verify`).

| Tool | What it does |
|------|--------------|
| `taskflow_run` | Run a saved or inline flow. Optional `args`, `incremental`; `mode: "background"` returns a durable `runId` immediately. |
| `taskflow_runs` | List background runs or `status` / `wait` / `cancel` one by `runId`. |
| `taskflow_resume` | Fork a failed/paused run into a new immutable child run, optionally overriding one phase's task/model/timeouts. |
| `taskflow_version` | Report the executing package version, build commit, schema version, build time, and host identity. |
| `taskflow_list` | List saved flows discoverable from the current working directory. |
| `taskflow_show` | Show a saved flow's full definition as JSON. |
| `taskflow_plan` | Preflight plan: bind args, phase order, dynamic bindings, worst-case agent-call bound — zero tokens, no execution. |
| `taskflow_analytics` | Aggregate last-N runs for a flow (status histogram, durations, per-phase fail/cache rates). Read-only. |
| `taskflow_verify` | Statically verify a flow (cycles, missing deps, undefined refs, contract typos) — no execution, zero tokens. |
| `taskflow_compile` | Render a flow's DAG as an inline SVG **and** text outline + a verification report — no execution. |
| `taskflow_peek` | Inspect one phase's intermediate output from a stored run (post-hoc debugging). Omit `phaseId` to list phases; `json`/`item`/`limit` refine the slice. Hard-truncated, read-only. |
| `taskflow_trace` | Read a run's append-only event timeline. |
| `taskflow_replay` | Replay recorded decisions offline with optional overrides — zero model calls. |
| `taskflow_why_stale` | Explain why phases are stale from observed and declared dependencies — zero tokens. |
| `taskflow_why_effect` | Explain why a declared effect is authorized, from the durable resource-intent ledger (`runId` + `effectId`, optional `phaseId`; `json: true` for the full record). Declaration alone is not authorization — zero tokens, read-only. |
| `taskflow_recompute` | Compute the stale frontier (**dry-run only** over MCP; never executes phases). |
| `taskflow_reconcile_workspace` | After inspection/repair, accept a failed resolve-only workspace. Requires host `TASKFLOW_WORKSPACE_RECONCILE_MODE=explicit`; never restores files. |
| `taskflow_save` | Save a reusable flow and optional library metadata. |
| `taskflow_search` | Search and rank reusable flows before authoring another one. |

**Always `taskflow_plan` (or at least `taskflow_verify`) a non-trivial flow before `taskflow_run`** — free, binds args, and catches most authoring mistakes.

## 1. Decide whether Taskflow helps

Decide from the execution shape. Look for useful delegation, concurrency, dependency, verification, isolation, specialization, or execution control.

### Signal: Bounded delegation

A substantial bounded part can be delegated without requiring frequent coordination from you.

→ **Benefit:** Use a cheaper or more specialized subagent while preserving your context.
→ **Likely shape:** one subagent

### Signal: Independent work

Several bounded parts are independent.

→ **Benefit:** Run them concurrently in isolated contexts.
→ **Likely shape:** small parallel fan-out

### Signal: Real dependency

B genuinely needs A's result.

→ **Benefit:** Make that dependency explicit and tracked.
→ **Likely shape:** chain / dependency

### Signal: Independent verification

Production benefits from separate verification or judgment.

→ **Benefit:** Separate making the result from checking it.
→ **Likely shape:** producer → verifier/gate

### Signal: Runtime-discovered items

You must discover an unknown set of similar items and then perform the same bounded work on each.

→ **Benefit:** Discover once, then process the resulting items under controlled fan-out.
→ **Likely shape:** discover → bounded map

### Signal: Context-heavy exploration

Substantial exploration would consume much of your context.

→ **Benefit:** Isolate that exploration in one or more subagents and return only the useful result.
→ **Likely shape:** one or more subagents

### Signal: Specialized execution profile

A part of the task benefits from a different model, reasoning level, specialized skill, or narrower tool set.

→ **Benefit:** Give that work its own execution profile.
→ **Likely shape:** one subagent or DAG

### Signal: Execution control or persistence

Timeout, budget, tracking, persistence/resume, or reuse would improve execution.

→ **Benefit:** Put the delegated work behind explicit execution controls and tracked state.
→ **Likely shape:** one subagent or DAG

Taskflow is useful when one or more of these signals changes the execution plan in a concrete way: who performs the work, what context it consumes, which capabilities it uses, what can run concurrently, what depends on what, how results are checked, or how execution is bounded and preserved.

**Single-agent Taskflow is useful when delegation itself helps:**

**cheaper model/reasoning • context isolation • specialized skills • narrower tools • timeout/budget control • tracked execution • persistence/resume**

If one or more signals changes how the task should be executed, choose the shape that captures that benefit. If none does, direct execution is usually simpler.

## 2. Choose the smallest useful shape

Start with the smallest shape that represents the real structure of the work.

```text
One bounded delegated objective
→ one subagent

A few known independent tasks
→ small parallel fan-out

B genuinely needs A
→ chain / dependency

An unknown set of similar items
→ discover → bounded map

A result needs deterministic proof
→ producer → deterministic verifier

A result needs independent judgment
→ producer → reviewer/gate

Many outputs genuinely need synthesis inside the flow
→ fan-out → reducer
```

Escalate when the work contains a requirement that the simpler shapes do not represent:

```text
Measurable iterative correction
→ bounded loop

Competing approaches are genuinely useful
→ tournament

The first successful acceptable result should win
→ race

Runtime data determines the graph structure
→ dynamic flow / expand

Repeated changing inputs should reuse unaffected work
→ incremental / recompute
```

These are adaptive starting shapes, not recipes.

**Add each mechanism when it represents a real property of the work.** Use a reducer when synthesis belongs inside the flow; a dependency when later work genuinely needs earlier output; retries for a justified recovery mode; and advanced control flow when the task actually requires it.

**Structure should represent a real execution constraint or benefit.**

### Before you author

For a non-trivial flow, establish the execution environment before writing agent references:

```text
execution root
→ discover actual agents and their scopes
→ confirm consequential execution configuration
→ choose bounds for expensive work
→ author
```

Use agents you actually discovered and carry their scope into the flow when scoped agents matter.

Choose an agent whose capability ceiling covers the work. Phase-level tools may narrow that capability envelope, never expand it. Selected skills provide specialized instructions and context; they do not grant additional tools.

## 3. Quick-start examples

Use shorthand when ordinary delegation does not require a full DAG.

The examples below assume the selected agents are project-scoped. Replace `<discovered-agent>` with an agent you actually discovered and use the matching `agentScope`.

Legal scopes are:

```text
user | project | both
```

Resource values in this skill are illustrative bounds chosen for each example, not Taskflow defaults. Choose timeout, concurrency, and budget from the actual work and environment.

### One bounded subagent

```json
{
  "agentScope": "project",
  "task": "Inspect src/auth for authentication entry points. Return a concise inventory with file paths and one-line purposes. Stop after the relevant auth paths are covered.",
  "agent": "<discovered-agent>"
}
```

Use this when one bounded delegation captures the useful execution boundary.

Keep the objective, scope, evidence, and stopping condition visible in the task.

### Small parallel fan-out

```json
{
  "agentScope": "project",
  "concurrency": 2,
  "tasks": [
    {
      "task": "Inspect src/api for authentication checks. Return only concrete findings with file paths. Stop after the scoped API files are covered.",
      "agent": "<discovered-agent>"
    },
    {
      "task": "Inspect src/api for input-validation checks. Return only concrete findings with file paths. Stop after the scoped API files are covered.",
      "agent": "<discovered-agent>"
    }
  ]
}
```

Use this when the tasks are known, independent, and independently useful.

Keep the fan-out small. Add synthesis when the flow itself genuinely needs to own synthesis.

### Dependency chain

```json
{
  "agentScope": "project",
  "chain": [
    {
      "task": "Inventory the public API exported from src/lib. Return symbols, signatures, and source paths.",
      "agent": "<discovered-agent>"
    },
    {
      "task": "Using this inventory, identify missing or stale public API documentation. Base the assessment on the supplied inventory and return a prioritized fix list:\n{previous.output}",
      "agent": "<discovered-agent>"
    }
  ]
}
```

Use a chain when the second step genuinely needs the first step's output.

When the steps are independently useful, parallel work is the simpler shape.

### Full-DAG essentials

Use a full DAG when you need named phases, explicit dependencies, structured intermediate data, verification, maps, gates, reducers, or other graph behavior.

A normal top-level flow definition is an object containing a name and phases:

```json
{
  "name": "example-flow",
  "phases": [
    {
      "id": "first",
      "type": "agent",
      "agent": "<discovered-agent>",
      "task": "Produce one bounded result."
    },
    {
      "id": "second",
      "type": "agent",
      "agent": "<discovered-agent>",
      "dependsOn": ["first"],
      "task": "Use this upstream result:\n\n{steps.first.output}",
      "final": true
    }
  ]
}
```

The ordinary mechanics are:

```text
full flow
→ { name, phases: [...] }

phase B needs phase A
→ dependsOn: ["A"]

prior text output
→ {steps.A.output}

prior structured output
→ {steps.A.json}
→ {steps.A.json.field}

map item
→ {item}
→ {item.field}

immediately previous chain result
→ {previous.output}
```

Four rules cover most ordinary DAG authoring:

1. **Array order is not a dependency.** If phase B needs phase A, declare the dependency explicitly.
2. **References and dependencies belong together.** When a phase consumes `{steps.A...}`, make A an upstream dependency.
3. **Use structured output for machine-consumed data.** Declare JSON output and an appropriate contract when later phases depend on its shape.
4. **Make the intended result path explicit.** Mark the phase that should provide the flow's result when the flow has multiple possible endpoints.

## 4. Proven task patterns

Treat these as adaptive starting shapes.

### Discover → bounded map

**Use when:** the item set is unknown until runtime, but each discovered item can be handled independently.

```text
bounded discovery
→ bounded item set
→ narrow work over each item
```

Example:

```json
{
  "name": "inspect-migration-candidates",
  "agentScope": "project",
  "concurrency": 3,
  "phases": [
    {
      "id": "discover",
      "type": "agent",
      "agent": "<discovered-agent>",
      "output": "json",
      "expect": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["path", "reason"],
          "properties": {
            "path": { "type": "string" },
            "reason": { "type": "string" }
          }
        }
      },
      "retry": { "max": 0 },
      "timeout": 60000,
      "task": "Identify at most 6 migration candidates matching the stated criterion. Return only [{\"path\":\"...\",\"reason\":\"...\"}]. Exclude generated and vendor files. Stop when the bounded candidate set is complete."
    },
    {
      "id": "inspect-each",
      "type": "map",
      "over": "{steps.discover.json}",
      "as": "item",
      "agent": "<discovered-agent>",
      "concurrency": 3,
      "retry": { "max": 0 },
      "timeout": 120000,
      "dependsOn": ["discover"],
      "task": "Assess {item.path} for the requested migration. Return exact evidence and one recommended disposition. Stop after this item."
    }
  ]
}
```

**Adapt:** tighten the discovery criterion, maximum item count, evidence requirement, per-call timeout, and concurrency.

A runtime-discovered map may still plan with an **unbounded static agent-call estimate** because the planner cannot know the discovered array length before execution. A prompt-level item limit is useful, but it is not a statically proven fan-out bound. Use a run-wide budget when you need a hard spend stop-loss.

When the items are already known or can be discovered deterministically more cheaply, start from the known list instead.

### Producer → deterministic verifier

**Use when:** a machine check can reliably establish the acceptance criterion.

```text
subagent produces
→ test / script / schema / lint / typecheck / drift check
```

Example:

```json
{
  "name": "produce-and-verify",
  "agentScope": "project",
  "phases": [
    {
      "id": "produce",
      "type": "agent",
      "agent": "<discovered-agent>",
      "retry": { "max": 0 },
      "timeout": 180000,
      "task": "Produce the requested structured artifact using only the required fields."
    },
    {
      "id": "verify",
      "type": "script",
      "dependsOn": ["produce"],
      "run": ["./scripts/verify-output"],
      "input": "{steps.produce.output}",
      "timeout": 30000,
      "final": true
    }
  ]
}
```

Use deterministic verification when it establishes the acceptance criterion reliably. Reserve model judgment for criteria that actually require judgment.

### Producer → independent reviewer/gate

**Use when:** production and judgment should remain separate and deterministic proof is insufficient.

```json
{
  "name": "produce-and-review",
  "agentScope": "project",
  "phases": [
    {
      "id": "produce",
      "type": "agent",
      "agent": "<discovered-agent>",
      "retry": { "max": 0 },
      "timeout": 150000,
      "task": "Produce the bounded deliverable with evidence for each material claim."
    },
    {
      "id": "review",
      "type": "gate",
      "agent": "<discovered-reviewer>",
      "dependsOn": ["produce"],
      "output": "json",
      "expect": {
        "type": "object",
        "required": ["verdict", "reason"],
        "properties": {
          "verdict": { "enum": ["pass", "block"] },
          "reason": { "type": "string" }
        }
      },
      "retry": { "max": 0 },
      "timeout": 90000,
      "task": "Independently judge the deliverable below against the stated criteria. Check the evidence rather than the producer's confidence.\n\nDELIVERABLE:\n{steps.produce.output}\n\nReturn only {\"verdict\":\"pass\"|\"block\",\"reason\":\"...\"}.",
      "final": true
    }
  ]
}
```

Give the reviewer the criteria and evidence it needs while preserving genuine separation from production.

A structured contract validates the result shape; retry remains a separate recovery decision.

A gate that is intentionally the sole path to the final result may produce a gate-exhaustion warning. That warning describes the consequence of blocking; it does not by itself mean you should add a bypass.

Use this pattern when independent judgment affects acceptance.

### Fan-out → reducer when synthesis belongs inside the flow

**Use when:** multiple upstream outputs genuinely require fresh-context synthesis, a reusable final contract, or an in-flow final result.

```text
bounded independent subagents
→ one reducer
```

Example:

```json
{
  "name": "synthesize-findings",
  "agentScope": "project",
  "phases": [
    {
      "id": "inspect-a",
      "type": "agent",
      "agent": "<discovered-agent>",
      "retry": { "max": 0 },
      "timeout": 120000,
      "task": "Inspect the first bounded area. Return concise findings with evidence."
    },
    {
      "id": "inspect-b",
      "type": "agent",
      "agent": "<discovered-agent>",
      "retry": { "max": 0 },
      "timeout": 120000,
      "task": "Inspect the second independent bounded area. Return concise findings with evidence."
    },
    {
      "id": "summary",
      "type": "reduce",
      "from": ["inspect-a", "inspect-b"],
      "agent": "<discovered-agent>",
      "retry": { "max": 0 },
      "timeout": 150000,
      "task": "Synthesize the upstream findings below into one deduplicated prioritized report. Preserve evidence, reconcile conflicts explicitly, and omit unsupported claims.\n\n{previous.output}",
      "final": true
    }
  ]
}
```

For a reducer, `from` identifies its upstream inputs and establishes those dependency edges. `{previous.output}` supplies the aggregated completed `from` outputs.

Define the synthesis contract explicitly: deduplication, ranking, conflict handling, evidence preservation, and stopping condition.

When a few compact results can be combined directly in your current context, direct synthesis is usually enough.

## 5. Adapt the pattern safely

Start from the selected shape, then adapt the controls that materially change execution.

| Weak adaptation | Better adaptation |
|---|---|
| “Investigate the repository and summarize.” | “Inspect `src/auth/**` for missing authorization checks; cite file/line evidence; exclude tests/generated code; return at most 10 findings; stop after the scoped files.” |
| Use the strongest model and highest reasoning on every phase. | Match capability to the phase: simple reading/discovery → lower reasoning; ordinary analysis → moderate; difficult bounded judgment → higher only when justified. |
| Give every subagent broad ambient capability. | Select specialized skills where useful and narrow tools within the chosen agent's declared capability envelope. |
| Set only `idleTimeout` for open-ended investigation. | Set a finite per-call `timeout` on expensive agent work. `idleTimeout` detects inactivity; an active subagent can continue without becoming idle. |
| Retry expensive reasoning automatically. | Begin with no author-declared phase retry unless another attempt has a concrete recoverable rationale. |
| Pair every `expect` contract with retry. | Use `expect` to enforce the contract. Decide retry separately. |
| Raise concurrency because work is read-only. | Size concurrency to independent, bounded, affordable work. Start small and raise it only when useful. |
| Omit a budget because the flow is not a large fan-out. | Add a run-wide stop-loss when execution can expand or become expensive. |
| Inject large context and still ask for broad discovery. | Known sources → focused context. Unknown sources → bounded discovery. Use both only when both are necessary. |
| Add reviewer → cross-check → reducer → final model by habit. | Stop at the first mechanism that establishes the result: deterministic proof, one independent judgment, or direct synthesis when cheap. |

> **Output length does not bound investigation cost.**

A request for “five bullets” can still trigger extensive search, tool calls, and reasoning.

Bound the objective, scope, evidence, stopping condition, per-call execution time, concurrency, and spend—not only the answer length.

> **Read-only does not mean cheap.**

A read-only subagent can still inspect thousands of files, consume substantial context, invoke expensive reasoning, or run for a long time.

A compact expensive phase usually looks like:

```json
{
  "id": "analyze",
  "type": "agent",
  "agent": "<discovered-agent>",
  "retry": { "max": 0 },
  "timeout": 110000,
  "task": "Answer one bounded question over the stated scope. Cite required evidence. Exclude unrelated material. Stop when the acceptance criterion is established or the scoped evidence is exhausted."
}
```

The timeout and concurrency values in these examples are illustrative.

For agent-running phases, `timeout` caps each subagent call. It is not necessarily a deadline for the entire phase or flow: a map, retrying phase, tournament, or multi-call reduction may make more than one subagent call.

`idleTimeout` is separate. It detects inactivity rather than total elapsed execution time.

`retry.max: 0` disables **author-declared phase retries**. Taskflow may still automatically retry failures it classifies as transient. A Taskflow phase `timeout` expiry itself is treated as deterministic and is not transient-retried.

An `expect` contract also does not imply retry. A contract violation fails the attempt and is eligible for the phase's explicit retry policy; without one, the contract failure is not automatically retried as a transient error.

A retry repeats work. On broad analysis, repository investigation, or synthesis, that can multiply wall time and cost.

Match model and reasoning to the phase:

```text
simple reading / exact discovery
→ lower reasoning

ordinary static or semantic analysis
→ moderate reasoning

difficult bounded judgment
→ higher reasoning when justified
```

A strong calling model can deliberately delegate simpler work to a cheaper subagent.

### Context versus discovery

```text
Known sources
→ focused context

Unknown sources
→ bounded discovery

Both
→ only when both are genuinely necessary
```

Preloaded context can reduce exploration, but excessive context plus broad discovery can pay for the same information twice.

## 6. Preflight → verify → plan → run

After establishing the pre-author checkpoint above, verify and plan the exact invocation you intend to execute.

```text
verify
→ plan with real args
→ inspect
→ run
```

For a non-trivial flow you are iterating on, a stable `defineFile` can keep verification, planning, and execution pointed at the same definition:

Use the corresponding host MCP tools with the same definition and arguments:

```json
{ "name": "taskflow_verify", "arguments": { "defineFile": "/tmp/audit-auth.json" } }
```

```json
{ "name": "taskflow_plan", "arguments": { "defineFile": "/tmp/audit-auth.json", "args": { "dir": "src/api" } } }
```

Inspect the plan, then call `taskflow_run` with the same `defineFile` and arguments.

If the definition or consequential arguments change, plan again.

`verify` performs structural/static checks such as graph validity, references, dependencies, cycles, contracts, and verifier findings.

`plan` binds invocation arguments, performs validation and verification, projects topological phase order and dynamic or unresolved bindings, and estimates a worst-case agent-call bound without spawning subagents.

A runtime-discovered map can legitimately produce an `unbounded` static call estimate because its item count is not known at planning time.

Structural validity and a plausible plan are necessary checks, but they do not by themselves establish that the flow is well-scoped, affordable, operationally available, or configured with appropriate resource and recovery choices.

For saved or reused flows, consider `strictInterpolation: true` when unresolved interpolation should be treated as validation errors rather than remain unresolved placeholders with diagnostics.

## 7. When execution fails

Do not make rerun or resume your first move.

```text
stop
→ classify
→ inspect evidence
→ decide
```

| Failure class | Examples | Response |
|---|---|---|
| Configuration / authoring | unknown agent, wrong scope, unsupported model, invalid dependency/interpolation | Repair the definition or invocation. Do not retry unchanged. |
| Transport / provider / process | provider/network failure, child/process failure, protocol/stream failure | Inspect runtime evidence first. Retry only when a transient explanation is plausible and repeating the work is safe. |
| Output / contract / quality | malformed structured output, failed `expect`, bounded result misses acceptance criteria | A bounded explicit retry or targeted rework may fit. Change something that addresses the failure. |
| Timeout / budget | per-call timeout reached, spend stop-loss reached | Reassess objective, scope, stopping condition, model, timeout, budget, or fan-out before spending again. |

Recovery mechanisms do not explain why execution failed.

Use retry, resume, recompute, or rerun only after deciding why that mechanism fits the observed condition.

Remember that Taskflow may already absorb failures it classifies as transient before returning a phase failure. Do not assume another whole-flow rerun is needed merely because a provider or transport problem occurred internally.

Do not repeat an unchanged failed flow merely because another execution is available.

## 8. Advanced shapes

Use advanced shapes when they represent a real property of the work.

### Bounded loop

```text
bounded phase
→ evaluate measurable stop condition
→ repeat up to a fixed maximum
```

Use when each iteration can make measurable progress toward a clear stop condition.

Avoid when “better” is vague or one bounded pass is enough.

### Tournament

```text
independent competing approaches
→ judge
→ selected or aggregated result
```

Use when competing approaches are genuinely useful and independent judgment can distinguish them.

Avoid when deterministic work or one strong approach is sufficient.

### Race

```text
several independent attempts
→ first successful acceptable result wins
```

Use when the first successful result is sufficient and latency matters more than comparing every output.

Avoid when all outputs are required or quality comparison must happen after completion.

### Dynamic flow / expand

```text
runtime result
→ bounded generated graph or fragment
→ execute
```

Use when runtime discovery genuinely determines graph structure.

Keep generated work explicitly bounded.

Avoid when the topology is already known.

### Incremental / recompute

```text
previous tracked execution
+ changed inputs
→ identify affected work
→ reuse unchanged work where supported
→ recompute what changed
```

Use when repeated runs over changing inputs benefit from preserving unaffected work.

Do not assume every phase or side effect is reusable.

Load `advanced.md` before authoring these mechanisms when their exact semantics matter.

## 9. Need more detail?

Load only the sidecar that answers the next concrete question.

| Load | When it is worth loading |
|---|---|
| `patterns.md` | You need deeper adaptive patterns, richer compositions, anti-patterns, or larger worked examples. |
| `configuration.md` | You need exact fields, precedence, agent/model settings, scopes, tools, skills, context, timeout, retry, budget, caching, or host-specific configuration. |
| `advanced.md` | You need exact mechanics for loops, races, tournaments, dynamic/generated flows, resume, replay, recompute, caching, background execution, isolation, or other specialized runtime features. |
| `library.md` | You want to find, save, adapt, generalize, tag, or reuse flows instead of authoring one from scratch. Reuse only when the existing control structure actually fits the task. |

Load sidecars progressively: start here, then load the one that answers the next concrete decision.
