---
name: taskflow
description: Orchestrate multi-phase subagent workflows with pi-taskflow. Use whenever a request spans a whole project or many items — deeply exploring / 探索 / auditing / 审计 / analyzing a codebase, reviewing or migrating many files or modules in parallel, cross-checked/adversarial review, codebase-wide research, or any repeatable orchestration you want to save and rerun. Prefer this over ad-hoc parallel subagents when the work has multiple phases or dynamic fan-out over a discovered list. Also supports subagent-style shorthand (single / parallel / chain) for simple non-DAG delegations you want tracked, resumable, or saveable.
---

# Taskflow

Build and run **declarative, multi-phase workflows** of subagents. The runtime
holds intermediate results and the phase DAG, so your main context only receives
the final answer — not every step's transcript.

## When to use

- A task needs **several coordinated steps** (discover → work → review → report).
- You need to **fan out over many items** (audit every endpoint, summarize every file).
- You want **cross-checked / adversarial review** before reporting.
- You want a **repeatable** orchestration saved as a `/tf:<name>` command.

For a single quick delegation you can use the **shorthand modes** below (no DSL),
or the plain `subagent` tool. Use the shorthand when you want the run tracked,
resumable, or saveable as a `/tf` command.

## Shorthand (non-DAG) — like the subagent tool

Skip the DSL entirely for simple delegations. The runtime desugars these into a
proper flow, so you still get progress, persistence, resume, and `save`.

```jsonc
// single  — one agent, one task
{ "task": "Summarize the architecture of src/", "agent": "explorer" }

// parallel — run several tasks at once, outputs merged
{ "tasks": [
  { "task": "Audit auth in src/api", "agent": "analyst" },
  { "task": "Audit input validation in src/api", "agent": "analyst" }
] }

// chain — run sequentially; reference the prior step with {previous.output}
{ "chain": [
  { "task": "List the public API of src/lib", "agent": "scout" },
  { "task": "Write docs for:\n{previous.output}", "agent": "writer" }
] }
```

- `agent` is optional (defaults to the first available agent).
- Add `name` to label the run (and to `save` it as a `/tf:<name>` command).
- Precedence if several are given: `chain` > `tasks` > `task`.
- You can pass these as top-level tool params **or** inside `define`.

## How to author a taskflow

Call the `taskflow` tool. To run a brand-new flow you write inline, pass
`action: "run"` with a `define` object. To run a saved flow, pass `name`.

### DSL shape

```jsonc
{
  "name": "audit-endpoints",
  "description": "Audit API endpoints for missing auth",
  "args": { "dir": { "default": "src/routes" } },
  "concurrency": 8,
  "agentScope": "user",            // user | project | both
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout",
      "task": "List endpoints under {args.dir}. Output ONLY a JSON array [{\"route\":\"\",\"file\":\"\"}].",
      "output": "json" },
    { "id": "audit", "type": "map", "over": "{steps.discover.json}", "as": "item",
      "agent": "analyst", "task": "Audit {item.route} ({item.file}) for missing auth.",
      "dependsOn": ["discover"] },
    { "id": "review", "type": "gate", "agent": "reviewer",
      "task": "Remove false positives from:\n{steps.audit.output}", "dependsOn": ["audit"] },
    { "id": "report", "type": "reduce", "from": ["review"], "agent": "writer",
      "task": "Write a final report:\n{steps.review.output}", "dependsOn": ["review"],
      "final": true }
  ]
}
```

### Phase types

| type | meaning |
|------|---------|
| `agent` | one subagent runs `task` |
| `parallel` | run `branches[]` concurrently |
| `map` | fan out over `over` (an array) — one subagent per item, `{item}` bound |
| `gate` | quality/review step that can **halt the flow** (see below) |
| `reduce` | aggregate `from[]` phases into one output |
| `approval` | **human-in-the-loop** pause: ask a person to approve / reject / edit before continuing |
| `flow` | run a **sub-flow** as one phase — **saved** (`use`) or **runtime-generated** (`def`) |

### Control-flow fields (any phase)

| field | meaning |
|-------|---------|
| `when` | conditional guard — skip the phase unless the expression is truthy. Supports `{refs}`, `== != < > <= >=`, `&& \|\| !`, parentheses, quoted strings/numbers. Parse errors fail **open** (phase runs). |
| `join` | dependency join: `"all"` (default — wait for every dep) or `"any"` (OR-join — run as soon as one dep completes). |
| `retry` | `{ "max": N, "backoffMs": ms, "factor": k }` — retry a failing subagent up to N times; delay is `backoffMs * factor^attempt` (`factor:1`=fixed, `2`=exponential). |

### Conditional routing (when + gate/branches)

Pair `when` with an upstream phase that emits a decision to build real if/else
routing. Use `join: "any"` on the merge phase so it runs whichever branch fired:

```jsonc
{ "id": "triage", "type": "agent", "agent": "analyst", "output": "json",
  "task": "Classify the task. Output ONLY {\"route\":\"deep\"} or {\"route\":\"quick\"}." },
{ "id": "deep",  "when": "{steps.triage.json.route} == deep",  "dependsOn": ["triage"], "agent": "analyst", "task": "..." },
{ "id": "quick", "when": "{steps.triage.json.route} == quick", "dependsOn": ["triage"], "agent": "executor-fast", "task": "..." },
{ "id": "report", "type": "reduce", "from": ["deep","quick"], "join": "any",
  "dependsOn": ["deep","quick"], "agent": "writer", "task": "...", "final": true }
```

> `when` should reference **upstream** (`dependsOn`) phases — a ref to a phase
> that hasn't completed resolves empty and the guard is treated as false.

### Approval phases (human-in-the-loop)

An `approval` phase pauses the run and asks the operator to **Approve / Reject /
Edit**. Distinct from `gate` (which is an *agent* reviewing): this is a *human*
deciding. The (interpolated) `task` is the prompt shown.

- **Approve** → continue; the phase output is `(approve)`.
- **Reject** → halt the flow (same mechanism as a blocking gate).
- **Edit** → the typed note becomes this phase's `output`, so you can inject
  guidance mid-run: reference it downstream with `{steps.<id>.output}`.
- **Non-interactive** runs (headless/CI/print mode) **auto-approve** and record it.

```jsonc
{ "id": "checkpoint", "type": "approval", "dependsOn": ["plan"],
  "task": "Review the plan above before the expensive fan-out. Approve, reject, or add guidance." }
```

### Sub-flows (composition)

A `flow` phase runs another taskflow as a single phase and bubbles up its final
output. Two sources, **mutually exclusive**:

**Saved** (`use`) — run a previously saved flow by name. Pass args via `with`
(string values interpolate). Recursion is detected and rejected.

```jsonc
{ "id": "research", "type": "flow", "use": "deep-research",
  "with": { "topic": "{item}" }, "dependsOn": ["plan"] }
```

**Runtime-generated** (`def`) — resolve a sub-flow *at runtime*, usually from an
upstream phase's JSON output. The runtime interpolates + JSON-parses the `def`,
**validates it** (cycles / dangling refs / duplicate ids), then runs it as a
nested sub-flow. This is how a planner decides *at runtime* what work to spawn —
the declarative answer to a code-mode `for`/`if` loop, with each generated plan
checked before it spends a token.

```jsonc
// 1) A planner emits a plan as JSON. 2) flow{def} runs it.
{ "id": "plan", "type": "agent", "agent": "planner", "output": "json",
  "task": "Scan the repo. Output ONLY JSON {\"name\":\"audit\",\"phases\":[...]} — one audit phase per file." },
{ "id": "run", "type": "flow", "def": "{steps.plan.json}", "dependsOn": ["plan"], "final": true }
```

**LLM output contract for `def`:** the upstream phase must output a *full*
Taskflow `{"name":"...","phases":[...]}`, a bare `phases` array, or
`{"phases":[...]}` — pure JSON (a ```json fence is tolerated and stripped).
Use hyphens in ids, never underscores. Sub-flow phases reference each other in
their **own** `{steps.x.output}` namespace (no parent-id prefixing needed).

**Fail-open & limits:** if the `def` doesn't parse, has the wrong shape, or fails
validation, the phase fails *open* — it's marked failed with a `defError`, the
upstream output is preserved, and the run continues (use `optional: true` on the
flow phase so a bad plan never aborts the run). An **empty** `phases` array is a
valid no-op (the planner decided there's nothing to do). Inline nesting is capped
at `MAX_DYNAMIC_NESTING` (5) to bound runaway self-spawning.

**Iterative replanning** — pair `flow{def}` (or a JSON-emitting body) with `loop`
so round N's plan depends on round N-1's **result** (not a one-shot fan-out):
the declarative equivalent of `for (...) { read result; decide next }`. See
`examples/dynamic-plan-execute.json` and `examples/iterative-replan.json`.

### Budget (cost / token caps)

Add a run-wide ceiling at the top level. When accumulated cost/tokens exceed it,
remaining phases are skipped (and an in-flight `map`/`parallel` stops spawning
new items); the run ends as `blocked`.

```jsonc
{ "name": "...", "budget": { "maxUSD": 1.50, "maxTokens": 2000000 }, "phases": [ ... ] }
```

### Gate phases (quality control)

A `gate` phase runs an agent to review upstream output and can **block the rest
of the workflow**. End the gate task's instructions by asking the agent to emit a
verdict the runtime can read:

- a final line `VERDICT: PASS` or `VERDICT: BLOCK` (also accepts OK/FAIL/STOP/REJECT/HALT), or
- JSON like `{"continue": false, "reason": "missing auth checks"}` / `{"verdict": "block", "reason": "..."}`

On **BLOCK**, downstream phases are skipped and the run ends as `blocked` with the
reason surfaced. Ambiguous output **fails open** (treated as PASS) so a gate never
halts the flow by accident. Example gate task:

```
Review the audit results below. If any endpoint is missing auth, end with
"VERDICT: BLOCK" and a one-line reason; otherwise end with "VERDICT: PASS".

{steps.audit.output}
```

### Structured-verify phases (v0.0.8.1)

A "verify" phase typically runs `npx tsc --noEmit && npm test && git diff --stat`
and reports whether everything is green. **Don't** delegate this to a generic
verifier subagent that summarizes the output in prose — LLMs commonly misread
shell output (e.g., 234 tests reported as 230, 745 insertions as 599, "1 type
error" reported as "clean"). Instead, **use a dedicated agent whose task is a
structured shell pipeline** that echoes structured key/value lines the next
phase can parse directly. Recommended pattern:

```jsonc
{
  "id": "verify",
  "type": "agent",
  "agent": "verifier",
  "dependsOn": ["apply-fixes"],
  "task": "Run the verification pipeline and report structured results.\n\nExecute:\n```bash\ncd $REPO && npx tsc --noEmit 2>&1 | tee /tmp/tsc.log\ncd $REPO && npm test 2>&1 | tee /tmp/test.log | tail -10\ncd $REPO && git diff --shortstat HEAD | tee /tmp/diff.log\n```\n\nReport EXACTLY in this format (one key=value pair per line, no prose):\ntypecheck=PASS|FAIL\ntests_total=N\ntests_pass=N\ntests_fail=N\ninsertions=N\ndeletions=N\nfiles_changed=N\n\nIf any field is missing, you failed the task — re-run the command and re-read the output.",
  "tools": ["read", "edit", "write", "bash"]
}
```

The key insight: **LLMs are bad at summarizing shell output, good at copying
structured data**. Asking for `key=value` pairs with explicit fields and "if
missing, you failed" forces the agent to read each field carefully. Downstream
phases that consume `{steps.verify.output}` can then `safeParse`-it into a
JSON object and assert against expected values.

For audits where the upstream is LLM-generated prose (not shell output), use a
plain `gate` phase with `VERDICT:` instead.

### Interpolation

- `{args.X}` — invocation argument
- `{steps.ID.output}` — a prior phase's text output
- `{steps.ID.json}` / `{steps.ID.json.field}` — prior output parsed as JSON
- `{item}` / `{item.field}` — current item inside a `map` phase
- `{previous.output}` — the immediately-upstream phase output

## Rules that make flows work

1. For a `map` phase, make the upstream phase **emit a JSON array** and set
   `output: "json"` on it. Tell that agent to output **only** JSON.
2. Give each phase a clear, single responsibility.
3. Reference upstream results explicitly with `{steps.ID...}` and set `dependsOn`.
4. Mark the result-bearing phase with `"final": true` (else the last phase wins).

## Common mistakes (the runtime will reject these at validation time)

The runtime validates your flow at startup. As of v0.0.8.1, the two most
common authoring mistakes below are **hard validation errors** (the flow
refuses to start). Fix the flow before running it.

### 1. Referencing `{steps.X}` without `dependsOn: ["X"]`

```jsonc
// ❌ WRONG — 'fix-issues' will run in parallel with 'code-review-1' and see the
// literal string "{steps.code-review-1.output}" instead of the review text.
{
  "id": "code-review-1", "type": "agent", "task": "review code"
},
{
  "id": "fix-issues", "type": "agent",
  "task": "fix {steps.code-review-1.output}"   // ← no dependsOn!
}
```

Validation now rejects this with: `Phase 'fix-issues': task references
{steps.code-review-1.*} but 'code-review-1' is not in dependsOn. ...`
**Always declare the chain:**

```jsonc
// ✅ RIGHT
{
  "id": "code-review-1", "type": "agent", "task": "review code"
},
{
  "id": "fix-issues", "type": "agent",
  "task": "fix {steps.code-review-1.output}",
  "dependsOn": ["code-review-1"]                // ← declared
},
{
  "id": "code-review-2", "type": "agent",
  "task": "re-review {steps.fix-issues.output}",
  "dependsOn": ["fix-issues"]
}
```

Tip: write the `task` first (it tells you what each phase needs), then scan for
`{steps.*}` references and add the matching `dependsOn`. If a phase truly does
not depend on anything in its task, you can omit the reference.

Exception: phases with `join: "any"` are exempt from this check, since they
deliberately wait for only one of their declared deps to complete and may
reference others as informational context.

### 2. Assuming the runtime knows "this is a chain"

Phase order in the `phases` array is **documentation, not execution order**.
The DAG comes from `dependsOn`. If you list `code-review-1`, `fix-issues`,
`code-review-2`, `fix-final` in that order with no `dependsOn`, the runtime
treats them as four independent phases and runs all of them in **layer 0** in
parallel. A phase that finishes first may not be the one you expected.

```jsonc
// ❌ This is not a chain — it's 4 parallel phases, all racing.
"phases": [
  { "id": "code-review-1", ... },
  { "id": "fix-issues",    ... },
  { "id": "code-review-2", ... },
  { "id": "fix-final",     ... }
]
```

Use the shorthand if you literally just want `a → b → c → d`:

```jsonc
{ "chain": [
  { "agent": "reviewer", "task": "review code" },
  { "agent": "executor", "task": "fix {previous.output}" },
  { "agent": "reviewer", "task": "re-review" },
  { "agent": "executor", "task": "apply final fixes" }
] }
```

…or write the full DAG with explicit `dependsOn` (so reviewers/fixers can run
in parallel against multiple review streams when you want that).

## Configuration

For the full set of knobs — per-phase `model`/`thinking`/`tools`/`cwd`, the
two-level concurrency model, model/thinking/tools resolution precedence,
`agentScope` & agent discovery, `settings.json` overrides, environment
variables, and storage paths — read `configuration.md` (next to this file).

Quick reference:

- **Flow:** `name`, `description`, `concurrency` (default 8), `budget` (`maxUSD`/`maxTokens`), `agentScope` (user|project|both), `args`, `strictInterpolation`.
- **Phase:** `model`, `thinking`, `tools` (whitelist), `cwd`, `output:"json"`, `concurrency` (map/parallel fan-out), `when`, `join` (all|any), `retry`, `use`/`with` (flow), `final`.
- **Precedence (model/thinking/tools):** phase value → agent frontmatter (resolved via `modelRoles`) → global/default.
- **Concurrency:** same-layer phases use `flow.concurrency`; a `map`/`parallel` phase uses `phase.concurrency ?? flow.concurrency ?? 8`.

## Actions

- `action: "run"` — run inline `define` or a saved `name` (with optional `args`).
- `action: "save"` — persist `define` (scope `project` or `user`); becomes `/tf:<name>`.
- `action: "resume"` — continue a paused/failed run by `runId` (completed phases are cached).
- `action: "list"` — list saved flows.

## User commands

- `/tf list` · `/tf run <name> [args]` · `/tf show <name>` · `/tf runs` · `/tf resume <runId>`
- `/tf:<name> [args]` — shortcut for each saved flow
