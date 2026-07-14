---
name: taskflow
description: Orchestrate multi-phase subagent workflows with Taskflow. Use whenever a request spans a whole project or many items — deeply exploring / 探索 / auditing / 审计 / analyzing a codebase, reviewing or migrating many files or modules in parallel, cross-checked/adversarial review, codebase-wide research, or any repeatable orchestration you want to save and rerun. Prefer this over ad-hoc parallel work when the task has multiple phases (discover → work → review → report) or dynamic fan-out over a discovered list. Drives the taskflow_* MCP tools.
---

<!-- GENERATED FILE — do not edit. Source: skills-src/taskflow/entry.codex.md + core.md (npm run build:skills) -->

# Taskflow (Codex)

**Host binding (Codex):** everything below is driven through the `taskflow_*`
MCP tools. Where an example shows a host-neutral invocation like `verify`, use
the Codex form (`taskflow_verify`).

| Tool | What it does |
|------|--------------|
| `taskflow_run` | Run a saved flow (`name`) or an inline `define` (full DAG, or shorthand `{task}` / `{tasks}` / `{chain}`). Optional `args`, `incremental`. Returns only the final phase output + a `runId`. |
| `taskflow_resume` | Fork a failed/paused run into a new immutable child run, optionally overriding one phase's task/model/timeouts. |
| `taskflow_version` | Report the executing package version, build commit, schema version, build time, and host identity. |
| `taskflow_list` | List saved flows discoverable from the current working directory. |
| `taskflow_show` | Show a saved flow's full definition as JSON. |
| `taskflow_verify` | Statically verify a flow (cycles, missing deps, undefined refs, contract typos) — no execution, zero tokens. |
| `taskflow_compile` | Render a flow's DAG as an inline SVG **and** text outline + a verification report — no execution. |
| `taskflow_peek` | Inspect one phase's intermediate output from a stored run (post-hoc debugging). Omit `phaseId` to list phases; `json`/`item`/`limit` refine the slice. Hard-truncated, read-only. |
| `taskflow_trace` | Read a run's append-only event timeline. |
| `taskflow_replay` | Replay recorded decisions offline with optional overrides — zero model calls. |
| `taskflow_why_stale` | Explain why phases are stale from observed and declared dependencies — zero tokens. |
| `taskflow_recompute` | Compute the stale frontier (**dry-run only** over MCP; never executes phases). |
| `taskflow_reconcile_workspace` | After inspection/repair, accept a failed resolve-only workspace. Requires host `TASKFLOW_WORKSPACE_RECONCILE_MODE=explicit`; never restores files. |
| `taskflow_save` | Save a reusable flow and optional library metadata. |
| `taskflow_search` | Search and rank reusable flows before authoring another one. |

**Always `taskflow_verify` a non-trivial flow before `taskflow_run`** — it is
free and catches most authoring mistakes.

Build and run **declarative, multi-phase workflows** of subagents. The runtime
holds intermediate results and the phase DAG, so your main context only receives
the final answer — not every step's transcript.

## Documentation map (progressive loading)

This file teaches the core: phase types, control flow, interpolation, and the
mistakes that break flows. Load the companion files **only when needed**:

| File | Load when you need |
|------|--------------------|
| `patterns.md` | **Designing a non-trivial flow.** Proven flow archetypes (audit fan-out, self-healing rework, plan→approve→execute, dynamic replanning, tournament synthesis, incremental audit), anti-patterns, and the production-flow quality checklist. |
| `advanced.md` | Dynamic sub-flow (`flow{def}`) contracts & security caps, workspace isolation (`cwd: temp/dedicated/worktree`), immutable resume (`taskflow_resume`), and build/host identity (`taskflow_version`). |
| `configuration.md` | Every knob: per-phase `model`/`thinking`/`tools`/`cwd`, concurrency model, agent discovery, `settings.json`, cross-run caching (`cache`, `fingerprint`, per-item map caching), args, storage paths. **TypeScript DSL CLI** (`taskflow-dsl` / S4). |
| `library.md` | **Before authoring a non-trivial flow — SEARCH the reusable-flow library.** Save reusable flows with `purpose`+`tags` so future search finds them; reuse + generalize instead of rewriting from scratch. The compounding flywheel. |

> Rule of thumb: writing a flow with ≥ 4 phases, a gate, or any fan-out?
> **Read `patterns.md` first** — it will make the flow better, not just valid.

## When to use

- A task needs **several coordinated steps** (discover → work → review → report).
- You need to **fan out over many items** (audit every endpoint, summarize every file).
- You want **cross-checked / adversarial review** before reporting.
- You want a **repeatable** orchestration you can save and rerun by name.
- The same expensive analysis will be **re-run as the repo evolves** (use
  `incremental: true` + fingerprints — see `configuration.md` §8).

## When NOT to use

- A **single-file, single-step** change you can do directly — just do it.
- **Interactive debugging** where each step depends on watching live output.
- Work that is **one bash command** — run it yourself, don't wrap it in a flow.

## Flow design ladder

Match the flow's sophistication to the task. Don't stop at level 1 when the
task deserves level 3 — the higher levels are where taskflow pays for itself.

| Level | Shape | Reach for it when |
|-------|-------|-------------------|
| 0 | shorthand `task` / `tasks` / `chain` | one-off delegation, simple sequence |
| 1 | linear DAG with `dependsOn` | fixed steps, each consuming the last |
| 2 | discover → `map` fan-out → `gate` → `reduce` | many items, needs review before reporting |
| 3 | + `eval` zero-token gates, `expect` contracts, `retry`, `onBlock: "retry"`, `budget`, `optional` fallbacks | production-grade: self-healing, cost stop-loss, fails precisely |
| 4 | + `loop`, `tournament`, `flow{def}` / `expand`, `race` | the work itself is discovered at runtime; one shot is unreliable; try parallel approaches and keep the first win |
| 5 | + `incremental: true`, `cache.fingerprint` | the flow re-runs as the repo changes; only re-pay for what changed |

**A production-grade flow (level 3+) usually has:** machine checks before LLM
checks (`eval`, `script`), an `expect` contract on every JSON-emitting phase,
`retry` on contract-checked phases, a `budget`, `optional: true` on
degradable phases with a downstream fallback, and exactly one `final` phase.
`patterns.md` shows each of these composed into full archetypes.

## Shorthand (non-DAG)

Skip the DSL entirely for simple delegations. The runtime desugars these into a
proper flow, so you still get progress, persistence, and resume.

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
- `context` (optional, per step or top-level in single mode): file paths to
  pre-read and inject before the task — same as the full-DSL `Phase.context`
  (per-file `contextLimit`, default 8000 chars). In **parallel `tasks` mode**
  all branches SHARE the union of step contexts. In **chain mode** declare
  `context` on individual steps; a top-level `context` is ignored (with a warning).
- `cwd` (optional, top-level or per-step): working directory for the subagent —
  same as the full-DSL `Phase.cwd`. A top-level `cwd` is the default for every
  step; a per-step `cwd` overrides it. For **single** and **chain** it lands on
  each `Phase.cwd` (full workspace-keyword lifecycle: `temp`/`dedicated`/
  `worktree`). For **parallel `tasks`**, the top-level `cwd` is the shared phase
  cwd, and each branch may set its own **literal-path** `cwd` (mixed branch cwds
  are honored independently). Per-branch workspace keywords are **rejected**
  (the workspace lifecycle is per-phase — use the top-level `cwd` for isolation).
- Add `name` to label the run.
- Precedence if several are given: `chain` > `tasks` > `task`.
- Pass these as the `define` argument to `taskflow_run`.

## How to author a taskflow

Call `taskflow_run` with an inline `define` object, or `name` for a saved flow.
**Before running a non-trivial flow, `taskflow_verify` it — zero tokens,
catches cycles / missing deps / undefined refs / contract typos.**

### Iterating on a big flow? Use `defineFile` (write once, verify / edit / run by path)

For a non-trivial flow you'll iterate on, **write the definition to a file**
(typically in the OS tmp dir) and point every call at it with `defineFile`:

```jsonc
// 1. write /tmp/audit.json with the `write` tool (a full {name, phases:[…]} object)
// 2. verify, iterate, run — all reference the SAME file by path:
{ "name": "taskflow_verify", "arguments": { "defineFile": "/tmp/audit.json" } }  // zero tokens
{ "name": "taskflow_compile", "arguments": { "defineFile": "/tmp/audit.json" } }  // diagram
{ "name": "taskflow_run",    "arguments": { "defineFile": "/tmp/audit.json" } }
```

The file can be raw JSON **or** a Markdown doc with a fenced ```json block
(`write` the JSON form, or paste the flow into a note and fence it). Between
calls, edit the file (not the call) and re-`verify`. This avoids re-sending a
large definition on every call and keeps a durable draft you can diff. Falls
back cleanly: precedence is `define` (inline) > `defineFile` (disk) > `name`
(saved flow).

### DSL shape

```jsonc
{
  "name": "audit-endpoints",
  "description": "Audit API endpoints for missing auth",
  "args": { "dir": { "default": "src/routes" } },
  "concurrency": 8,
  "budget": { "maxUSD": 2.00 },
  "agentScope": "user",            // user | project | both
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout",
      "task": "List endpoints under {args.dir}. Output ONLY a JSON array [{\"route\":\"\",\"file\":\"\"}].",
      "output": "json",
      "expect": { "type": "array", "items": { "type": "object", "required": ["route", "file"] } },
      "retry": { "max": 2, "backoffMs": 0 } },
    { "id": "audit", "type": "map", "over": "{steps.discover.json}", "as": "item",
      "agent": "analyst", "task": "Audit {item.route} ({item.file}) for missing auth.",
      "dependsOn": ["discover"] },
    { "id": "review", "type": "gate", "agent": "reviewer",
      "task": "Remove false positives from:\n{steps.audit.output}\nVERDICT: PASS or BLOCK.",
      "dependsOn": ["audit"] },
    { "id": "report", "type": "reduce", "from": ["review"], "agent": "writer",
      "task": "Write a final report:\n{steps.review.output}", "dependsOn": ["review"],
      "final": true }
  ]
}
```

### Phase types (12)

| type | meaning | details |
|------|---------|---------|
| `agent` | one subagent runs `task` | this file |
| `parallel` | run static `branches[]` concurrently (all complete) | this file |
| `map` | fan out over `over` (an array) — one subagent per item, `{item}` bound | this file |
| `gate` | quality/review step that can **halt the flow** | Gate phases below |
| `reduce` | aggregate `from[]` phases into one output | this file |
| `approval` | **human-in-the-loop** pause: approve / reject / edit | Approval phases below |
| `flow` | run a **sub-flow** as one phase — saved (`use`) or runtime-generated (`def`) | summary below; deep contract in `advanced.md` |
| `loop` | repeat a body until a condition / convergence / `maxIterations` | Loop phases below |
| `tournament` | run N competing `variants`, a `judge` picks best or aggregates | Tournament phases below |
| `script` | run a **shell command** (no LLM, zero tokens) — stdout is the output | Script phases below |
| `race` | run `branches[]` concurrently; **first success wins** (unlike parallel) | Race phases below |
| `expand` | run a dynamic fragment (`def`); `nested` (isolated) or `graft` (promote onto parent) | Expand phases below |

### Control-flow fields (any phase)

| field | meaning |
|-------|---------|
| `when` | conditional guard — skip the phase unless the expression is truthy. Supports `{refs}`, `== != < > <= >=`, `&& \|\| !`, parentheses, quoted strings/numbers. Parse errors fail **open** (phase runs). |
| `join` | dependency join: `"all"` (default — wait for every dep) or `"any"` (OR-join — run as soon as one dep completes). |
| `retry` | `{ "max": N, "backoffMs": ms, "factor": k }` — retry a failing subagent up to N times; delay is `backoffMs * factor^attempt` (`factor:1`=fixed, `2`=exponential). |
| `timeout` | max ms per subagent call (>= 1000). On expiry the subagent is aborted and the phase fails with a `timedOut` marker — deterministic, **never retried**. Caps EACH call, so a map/parallel/race/loop/tournament phase's wall time is per item/iteration/variant (a tournament's judge call gets its own cap too). Script phases keep their own child-process timeout (default 60s, max 300s). Not supported on approval/flow/expand. Pair with `optional: true` + a downstream fallback phase to degrade instead of failing the run. |
| `expect` | output contract for `output: "json"` phases (agent/gate/reduce/loop): a JSON-Schema-like shape `{type, properties, required, items, enum}` validated the moment the subagent finishes. A violation fails the phase with per-path diagnostics (e.g. `$.score: required key is missing`) and is retryable under the phase's explicit `retry`. `verify`/`compile` also statically warn when a `{steps.X.json.field}` ref names a field absent from X's declared contract. |
| `idempotent` | side-effect classification. Default `true` (safe to cache + auto-retry). Set `false` on phases with **irreversible side effects** (webhook POSTs, deploys, DB writes, file mutations): transient provider errors are **not** auto-retried (an explicit `retry{}` IS still honored — it's your declaration that repeats are acceptable) and the result is **never cached** in any scope (within-run resume, cross-run, `incremental` — the phase re-runs every time). The phase state records `sideEffect: true` (rendered as ⚡). |
| `optional` | fail-soft — a failed/blocked phase won't abort the run; downstream sees empty output. Pair with a fallback phase guarded by `when`. |
| `cache` | per-phase reuse policy (`run-only` default / `cross-run` / `off`). See `configuration.md` §8. |

### Conditional routing (when + gate/branches)

Pair `when` with an upstream phase that emits a decision to build real if/else
routing. Use `join: "any"` on the merge phase so it runs whichever branch fired.
For static (non-conditional) concurrency, a `parallel` phase runs fixed
`branches[]` instead — `{ "type": "parallel", "branches": [{"task":"..."}, {"task":"...","agent":"reviewer"}] }`.

```jsonc
{ "id": "triage", "type": "agent", "agent": "analyst", "output": "json",
  "task": "Classify the task. Output ONLY {\"route\":\"deep\"} or {\"route\":\"quick\"}.",
  "expect": { "type": "object", "required": ["route"], "properties": { "route": { "enum": ["deep", "quick"] } } } },
{ "id": "deep",  "when": "{steps.triage.json.route} == deep",  "dependsOn": ["triage"], "agent": "analyst", "task": "..." },
{ "id": "quick", "when": "{steps.triage.json.route} == quick", "dependsOn": ["triage"], "agent": "executor-fast", "task": "..." },
{ "id": "report", "type": "reduce", "from": ["deep","quick"], "join": "any",
  "dependsOn": ["deep","quick"], "agent": "writer", "task": "...", "final": true }
```

> **⚠️ Breaking change (0.2.0 dogfood fix):** a `reduce` phase's `{previous.output}` now aggregates **all** completed `from[]` sources (in from-array order), not just the last completed dependency. If your reduce task referenced `{previous.output}` expecting only the last dep, it now receives every `from[]` output. Use explicit `{steps.ID.output}` refs to address individual sources. For large aggregations, set `reduceStrategy: "tree"` + `batchSize` to run batched intermediate reducer rounds (forces the imperative runtime).

> `when` should reference **upstream** (`dependsOn`) phases — a ref to a phase
> that hasn't completed resolves empty and the guard is treated as false. Note
> the `expect` enum on the router: it converts "the router said `Deep` with a
> capital D and both branches silently skipped" into an immediate retryable
> failure at the router.

### Gate phases (quality control)

A `gate` phase runs an agent to review upstream output and can **block the rest
of the workflow**. The runtime needs to read a verdict from the agent's output.
There are three ways to provide one, in order of robustness:

**1. JSON contract (most robust — preferred).** Set `output: "json"` + an `expect`
enum so the output is machine-validated. A verdict that isn't exactly `"pass"` or
`"block"` (wrong case, extra formatting, a synonym) fails the `expect` contract and
is retried — the verdict can never be silently misread.

```jsonc
{ "id": "review", "type": "gate", "agent": "reviewer", "dependsOn": ["impl"],
  "output": "json",
  "expect": { "type": "object",
    "properties": { "verdict": { "enum": ["pass", "block"] }, "reason": { "type": "string" } },
    "required": ["verdict", "reason"] },
  "task": "Review the diff. Respond ONLY with JSON: {\"verdict\":\"pass\"|\"block\",\"reason\":\"...\"}" }
```

**2. Explicit text marker.** End the task by asking the agent to emit a final line
`VERDICT: PASS` or `VERDICT: BLOCK` (also accepts OK/FAIL/STOP/REJECT/HALT; common
Markdown emphasis like `VERDICT: **BLOCK**` is tolerated). JSON objects such as
`{"continue": false, "reason": "missing auth checks"}` / `{"verdict": "block"}` also work.

**3. Auto-appended format suffix.** If a free-text gate's task does **not** already
ask for a `VERDICT:` marker (and has no JSON contract), the runtime automatically
appends the exact format instruction. You don't need to remember to add it — but
writing it yourself (option 2) makes the intent explicit in your flow.

On **BLOCK**, downstream phases are skipped and the run ends as `blocked` with the
reason surfaced. Unparseable gate **model output fails closed** (treated as BLOCK):
a gate that cannot reach a verdict cannot be trusted to pass (issue #54). Note
that *config* slips (an unresolved `score.target`, malformed `scorers`) are
different and still fail **open** with a warning — those are authoring errors that
degrade to the historical behavior, not a judge that couldn't decide. An explicit
non-blocking JSON verdict (e.g. `{"verdict":"No issues found"}`) is a semantic PASS,
not ambiguity.

**Zero-token machine checks (`eval`) — use these before spending tokens.**
List machine-checkable assertions in `eval`. If **all** pass, the gate
auto-passes with **no LLM call**; if any fails, it falls through to the LLM
`task` (the qualitative residue). Each entry supports the `when` operators plus
`X contains Y` (substring). A parse error fails **open**.

```jsonc
{ "id": "quality", "type": "gate", "dependsOn": ["build","test"],
  "eval": ["{steps.build.output} contains BUILD SUCCESS", "{steps.test.json.failures} == 0"],
  "task": "Review the diff for subtle logic errors a linter can't catch. VERDICT: PASS or BLOCK." }
```

**Self-healing (`onBlock: "retry"`).** By default a blocking gate halts the run
(`onBlock: "halt"`). With `onBlock: "retry"` the gate instead **re-runs its
upstream `dependsOn` phases and re-evaluates**, up to `retry.max` rounds (or
until PASS / budget / abort) — a generate→critique→regenerate rework loop. See
`patterns.md` for the full archetype.

```jsonc
{ "id": "spec-gate", "type": "gate", "onBlock": "retry", "retry": { "max": 3 },
  "dependsOn": ["implement"],
  "task": "Does the implementation satisfy ALL acceptance criteria? VERDICT: PASS or BLOCK with reasons." }
```

**Scoring gates (`score`) — graded, composable, auditable quality checks.**
Where `eval` gives boolean assertions, `score` runs deterministic scorers
against a target string at **zero tokens**, combines them into a [0,1] score,
and only escalates to an LLM when they can't decide. The structured result is
the gate's `.json` — downstream phases read `{steps.<gate>.json.combined}` /
`.json.results.0.passed` and route on quality, not just pass/fail.

| field | meaning |
|-------|---------|
| `target` | interpolation ref for the scored string (default `{previous.output}`) |
| `scorers` | array of checks: `exact-match` (`value`), `contains` (`value`), `regex` (`pattern`, optional `negate`), `json-schema` (`schema`, an `expect`-style contract), `length-range` (`min`/`max`), `code-compiles` (`language`: javascript\|typescript) |
| `combine` | `all` (default) / `any` / `weighted` |
| `weights` | weighted only — one entry per scorer, **+1 trailing entry for the judge** when present |
| `threshold` | weighted only — combined-score cutoff in (0,1], default 0.5 |
| `judge` | optional LLM-as-judge fallback `{agent?, task}` — runs when the deterministics fail (and, for `all`/`any`, whenever configured); sees the target + scorer report; returns `{"score": 0-1, "verdict": "pass"\|"block", "reason"}` |

Decision order: (1) deterministics pass **and the judge cannot veto** →
**auto-PASS, zero LLM tokens** — that means: no judge configured, or `weighted`
where the deterministic score is a lower bound already clearing the threshold
(the judge could not drop it). With `all`/`any` + a judge the judge **always
runs** — its verdict is authoritative (it may check what scorers cannot, e.g.
factuality); (2) fail + `judge` → judge decides; (3) fail + `task` → the gate
task runs with the scorer report appended; (4) fail + no fallback → **explicit
BLOCK** (a deterministic failure is not ambiguity). Fail-closed: an unparseable
judge → BLOCK (issue #54); unresolved `target` with no fallback → PASS +
warning (config slip, not a judge verdict); malformed `score` → the plain LLM
gate. **Security:** LLM-generated dynamic sub-flows
(`flow{def}`) may not use `code-compiles` (compiler execution) or `regex`
(ReDoS) scorers — same hardening class as the `script` block.

```jsonc
{ "id": "quality", "type": "gate", "dependsOn": ["gen"],
  "score": {
    "target": "{steps.gen.output}",
    "scorers": [
      { "type": "json-schema", "name": "shape", "schema": { "type": "object", "required": ["summary", "risks"] } },
      { "type": "regex", "name": "no-placeholders", "pattern": "TODO|TBD", "negate": true },
      { "type": "length-range", "name": "substantive", "min": 200 }
    ],
    "combine": "weighted", "weights": [3, 2, 1, 2], "threshold": 0.8,
    "judge": { "agent": "reviewer", "task": "Score the analysis quality 0-1: depth, evidence, actionability." }
  } }
// downstream: { "when": "{steps.quality.json.combined} >= 0.9", ... }
```

### Approval phases (human-in-the-loop)

An `approval` phase pauses the run and asks the operator to **Approve / Reject /
Edit**. Distinct from `gate` (an *agent* reviewing): this is a *human* deciding.
The (interpolated) `task` is the prompt shown.

- **Approve** → continue; the phase output is `(approve)`.
- **Reject** → halt the flow (same mechanism as a blocking gate).
- **Edit** → the typed note becomes this phase's `output` — inject guidance
  mid-run and reference it downstream with `{steps.<id>.output}`.
- **Non-interactive** runs (headless/CI/print mode) **auto-reject** and record it.
- **Background (detached)** runs **auto-reject** (no interactive approver);
  downstream sees the rejection; the flow continues (fail-open).

> **MCP-host caveat (Codex / Claude Code / OpenCode):** MCP-driven runs are
> non-interactive, so an `approval` phase **auto-rejects**. Prefer a `gate`
> (agent review) in flows you run through the `taskflow_*` tools; use `approval`
> only in flows a human runs interactively.

### Sub-flows (composition) — summary

A `flow` phase runs another taskflow as a single phase and bubbles up its final
output. Two mutually-exclusive sources:

- **Saved** (`use`): `{ "type": "flow", "use": "deep-research", "with": { "topic": "{item}" } }`
  — args via `with` (string values interpolate); recursion is detected and rejected.
- **Runtime-generated** (`def`): `{ "type": "flow", "def": "{steps.plan.json}" }`
  — an upstream planner emits a whole flow as JSON; the runtime validates it
  (cycles / dangling refs / security caps) then runs it nested. This is how a
  planner decides *at runtime* what work to spawn — the declarative answer to a
  code-mode `for`/`if` loop.

The `def` output contract, fail-open semantics (`defError`), nesting/breadth
caps, and the iterative-replanning pattern (`loop` + `flow{def}`) are in
`advanced.md`. The plan→execute and replan archetypes are in `patterns.md`.

### Loop phases (iterate until done)

A `loop` phase runs its body repeatedly, exposing each iteration's output as
`{steps.<thisId>.output}` / `.json` so the next round can react to the last. It
stops on the first of: `until` truthy, **convergence** (output stops changing),
or `maxIterations` (hard cap, required). The runtime always terminates.

- `until` — stop condition, same operators as `when` (a parse error stops the loop, fail-safe).
- `maxIterations` — hard iteration cap (required).
- `convergence` — `true` to stop early when an iteration's output equals the previous one.
- `reflexion` — `true` to feed each iteration a structured summary of the prior one (see below).

```jsonc
{
  "id": "refine", "type": "loop", "agent": "executor",
  "maxIterations": 5,
  "until": "{steps.refine.json.done} == true",
  "convergence": true,
  "task": "Improve the draft. When nothing else needs fixing, output JSON {\"done\":true,\"draft\":\"...\"}; otherwise {\"done\":false,\"draft\":\"...\"}.",
  "output": "json",
  "expect": { "type": "object", "required": ["done", "draft"] },
  "final": true
}
```

**Reflexion memory (`reflexion: true`).** By default each iteration sees only
the prior *output* — the *reason* it wasn't good enough (an `expect` contract
violation, an error, the unmet `until`) is discarded, so models repeat mistakes.
With `reflexion: true`, every iteration after the first receives a structured
failure summary of the prior one via the `{reflexion}` placeholder
(auto-appended if the task omits it, with a one-time warning; capped at 2000
chars): contract diagnostics like `$.done: required key is missing`, the
(sanitized) error, or the unmet stop condition, plus a truncated output
snippet. Iteration 1 sees a sentinel.

Semantics shift to enable self-correction: **body failures become feedback
instead of terminating the loop**. Timeout/abort/over-budget still hard-stop,
and if `maxIterations` exhausts with the last iteration failed, the phase fails
(reflexion defers failure, never erases it). Cost is bounded by `maxIterations`
+ the run `budget`.

```jsonc
{ "id": "emit-plan", "type": "loop", "reflexion": true, "maxIterations": 4,
  "output": "json", "expect": { "type": "object", "required": ["steps", "done"] },
  "until": "{steps.emit-plan.json.done} == true",
  "task": "Emit the migration plan as JSON {steps:[...], done:bool}.\n{reflexion}" }
```

### Tournament phases (N variants, judge picks best)

A `tournament` phase runs `variants` competing attempts in parallel, then a
**judge** sub-phase selects the winner (`mode: "best"`) or merges them
(`mode: "aggregate"`). Use it when one shot is unreliable and you want the best
of several drafts, or a synthesis of diverse approaches.

- `variants` — number of competing variants spawned from `task` (default 3, max 20).
  For genuinely different *approaches*, use `branches` instead — an explicit
  array of `{task, agent?}` definitions (e.g. one conservative, one aggressive).
- `mode` — `"best"` (judge picks one winner, default) or `"aggregate"` (judge merges all).
- `judge` — the judge's rubric/instructions. `judgeAgent` — optional judge agent
  (defaults to the phase `agent`; use a stronger model here).
- **Winner format — prefer JSON.** Have the judge return `{"winner": <n>}` (and an
  optional `"reason"`); the runtime also reads a `WINNER: <n>` line (`#3` and
  common Markdown emphasis like `WINNER: **3**` are tolerated — issue #54).
  JSON is more robust than a text marker: there's no formatting the model can
  get subtly wrong.
- Fail-open: if the judge's pick is still unparseable, variant 1 is returned
  (work is never lost — the variants are already computed, so blocking would be
  worse than picking a safe default).

```jsonc
{
  "id": "headline", "type": "tournament", "agent": "executor",
  "variants": 3, "mode": "best",
  "judge": "Pick the clearest, most accurate headline. Return JSON {\"winner\": <n>, \"reason\": \"...\"}.",
  "task": "Write one headline for the article below.\n\n{steps.draft.output}",
  "dependsOn": ["draft"], "final": true
}
```

### Script phases (shell commands, zero tokens)

A `script` phase runs a **shell command** directly — no subagent, no tokens — and
captures its stdout as the phase output. Use it to anchor LLM phases to ground
truth: builds, tests, `git`, formatters, scoring scripts. **Prefer a `script`
phase over asking an agent to run a command** — it is cheaper, faster, and the
output is exact.

- `run` — **required**. A **string** runs through a shell; an **array** is
  spawned directly (execvp, no shell). A string `run` containing an
  interpolation placeholder is **rejected at validation** (shell-injection
  guard) — use the array form or `input` for dynamic values.
- `input` — optional text piped to stdin (supports interpolation).
- `timeout` — optional ms cap (1000–300000, default 60000); SIGTERM → SIGKILL on expiry.
- A non-zero exit fails the phase (stderr captured); stdout capped at 1 MB.
  No `retry`, no `output: "json"`; **excluded from cross-run cache** (may have
  side effects). Not allowed inside LLM-generated dynamic sub-flows (RCE guard).

```jsonc
{ "id": "build", "type": "script", "run": "pnpm run build", "timeout": 120000 },
{ "id": "score", "type": "script", "run": ["python", "score.py"],
  "input": "{steps.analyze.output}", "dependsOn": ["analyze"], "final": true }
```

### Race phases (first success wins)

A `race` phase runs static `branches[]` concurrently and **returns the first
branch that finishes successfully** (failed settles do **not** win — a slower
success still wins over a fast hard-fail). Unlike `parallel` (waits for all) or
`tournament` (judges quality after all variants), use race when latency matters
more than comparing every approach.

- `branches` — **required**, at least two `{task, agent?}`.
- `cancelLosers` — optional boolean (default `true`). After the first **success**,
  abort other branches via `AbortSignal` (best-effort — host must honor the
  signal). Set `false` to let losers finish naturally.
- Phase `usage` **aggregates all branches** (including aborted partials) so
  budgets stay honest.
- Output of the winning branch becomes the race phase output; a warning records
  which branch won.

```jsonc
{
  "id": "quick", "type": "race",
  "branches": [
    { "task": "Answer with a short heuristic…", "agent": "executor" },
    { "task": "Answer with a thorough search…", "agent": "researcher" }
  ],
  "final": true
}
```

### Expand phases (dynamic fragment: nested or graft)

An `expand` phase runs a **fragment Taskflow** from `def` (inline object,
phases array, or interpolated `{steps.plan.json}`). Two modes:

| `expandMode` | Behavior |
|--------------|----------|
| `nested` (default) | Run as an isolated sub-flow (like `flow{def}`); child phase ids stay **off** the parent. |
| `graft` | After success, **promote** child phase states onto the parent as `<expandId>-<childId>` so later phases can read `{steps.grow-leaf.output}`. |

- `def` — **required** for expand.
- `maxNodes` — optional cap on fragment phase count (default 50, hard max 100).
- Dynamic validation + nesting caps match `flow{def}` (see `advanced.md`).
- Prefer `expand` when the planner fragment is a first-class kind; prefer
  `flow` + `use` for saved reusable flows; prefer `flow` + `def` when you want
  the classic nested sub-flow without graft promote.

```jsonc
{
  "id": "grow", "type": "expand", "expandMode": "graft",
  "def": "{steps.plan.json}",
  "dependsOn": ["plan"], "final": true
}
```

### Budget (observed-usage stop-loss)

Add a run-wide stop-loss at the top level. Ordinary budgeted DAG layers and
`map`/`parallel`/`tournament` fan-out use serial call admission. Once reported
cost/tokens exceed the threshold, no new model call is started; the run ends as
`blocked` with partial outputs preserved. An admitted call may cross the
threshold. A `race` necessarily starts competing branches together, so all
already-active race branches may contribute overshoot. This is never a
zero-overshoot guarantee.

```jsonc
{ "name": "...", "budget": { "maxUSD": 1.50, "maxTokens": 2000000 }, "phases": [ ... ] }
```

**Any flow with a fan-out should have a `budget`** — a map over a
mis-discovered 500-item array is otherwise unbounded spend.

Host accounting matters: Codex reports tokens but not cost, so Codex accepts
`maxTokens` and rejects `maxUSD`. Grok 0.2.93 reports neither and rejects every
flow declaring `budget`. Pi, Claude Code, and OpenCode accept both dimensions.

### Strict interpolation

By default an unresolved placeholder (typo'd `{steps.X.output}`, missing
`{args.Y}`) resolves to an empty string and validation issues a *warning* —
the flow still runs, possibly doing subtly wrong work. Set
`"strictInterpolation": true` at the flow level to promote unresolved
placeholders and missing-dep/arg warnings to **hard errors**. Recommended for
any flow you save — a saved flow will be run later with args you're not
watching.

## Interpolation

- `{args.X}` — invocation argument
- `{steps.ID.output}` — a prior phase's text output
- `{steps.ID.json}` / `{steps.ID.json.field}` — prior output parsed as JSON
- `{item}` / `{item.field}` — current item inside a `map` phase
- `{previous.output}` — the immediately-upstream phase output. For `reduce` phases, this resolves to **all completed `from[]` outputs** in from-array order: one completed input → its raw output; many → `### <id>\n\n<output>` sections joined by `\n\n---\n\n`. `join: "any"` includes only completed branches (skipped/failed are omitted). Explicit `{steps.ID.output}` refs are unaffected.
- `{loop.iteration}` / `{loop.lastOutput}` / `{loop.maxIterations}` — inside a `loop` body: the 1-based round, the prior iteration's output, and the cap
- `{reflexion}` — inside a `loop` body with `reflexion: true`: the structured failure summary of the prior iteration (sentinel on iteration 1)

Interpolation also runs on a scoring gate's `score.target` and `score.judge.task`
— refs there need `dependsOn` like any other `{steps.X}` use.

## Rules that make flows work

1. For a `map` phase, make the upstream phase **emit a JSON array** and set
   `output: "json"` on it. Tell that agent to output **only** JSON, and pin the
   shape with an `expect` contract + `retry`.
2. Give each phase a clear, single responsibility.
3. Reference upstream results explicitly with `{steps.ID...}` and set `dependsOn`.
4. Mark the result-bearing phase with `"final": true` (else the last phase wins).
5. Machine checks before LLM checks: `script` for ground truth, gate `eval`
   before gate `task`, `expect` before a downstream "did it parse?" phase.
6. **Decision phases should emit structured output, not free text.** Any phase
   whose output is a *decision* a downstream phase (or the runtime) acts on — a
   gate verdict, a router's branch, a tournament winner, a judge's score — should
   use `output: "json"` + an `expect` enum/contract so the decision is
   machine-validated. Free-text markers (`VERDICT:`, `WINNER:`, `SCORE:`) are
   tolerated and Markdown-emphasis-tolerant (issue #54), but a JSON contract is
   strictly more robust: there's no formatting the model can get subtly wrong, and
   a malformed decision fails the contract (retryable) instead of being silently
   mis-read.
7. `verify` before `run` for anything non-trivial (zero tokens).

## Common mistakes (the runtime rejects these at validation time)

### 1. Referencing `{steps.X}` without `dependsOn: ["X"]`

```jsonc
// ❌ WRONG — 'fix-issues' runs in parallel with 'code-review-1' and sees the
// literal string "{steps.code-review-1.output}" instead of the review text.
{ "id": "code-review-1", "type": "agent", "task": "review code" },
{ "id": "fix-issues", "type": "agent",
  "task": "fix {steps.code-review-1.output}" }   // ← no dependsOn!
```

Validation rejects this: `Phase 'fix-issues': task references
{steps.code-review-1.*} but 'code-review-1' is not in dependsOn. ...`
**Always declare the chain:**

```jsonc
// ✅ RIGHT
{ "id": "code-review-1", "type": "agent", "task": "review code" },
{ "id": "fix-issues", "type": "agent",
  "task": "fix {steps.code-review-1.output}",
  "dependsOn": ["code-review-1"] }
```

Tip: write the `task` first (it tells you what each phase needs), then scan for
`{steps.*}` references and add the matching `dependsOn`.
Exception: phases with `join: "any"` are exempt (they deliberately wait for only
one dep and may reference others as informational context).

### 2. Assuming the runtime knows "this is a chain"

Phase order in the `phases` array is **documentation, not execution order**.
The DAG comes from `dependsOn`. Four phases listed in order with no `dependsOn`
are four **parallel** phases, all racing in layer 0. Use the shorthand `chain`
if you literally want `a → b → c → d`, or write explicit `dependsOn`.

### 3. Underscores in ids / invented agent names

Phase ids and agent names use **hyphens** (`audit-each`, `risk-reviewer`).
An unknown agent name fails the phase with the list of available agents.
Built-in agents: `executor`, `executor-code` (complex, multi-file),
`executor-fast` (trivial), `executor-ui`, `scout` (cheap recon), `planner`,
`analyst`, `critic`, `reviewer`, `risk-reviewer`, `security-reviewer`,
`plan-arbiter`, `final-arbiter`, `test-engineer`, `doc-writer`, `verifier`,
`recover`, `visual-explorer`. **Do not invent agent names** — omit `agent` to
use the default. Use cheap agents (`scout`) for discovery and strong agents
(`critic`, `final-arbiter`) for gates/judging.

## Operating a run (lifecycle & inspection)

A run moves through: **running →** `completed` (a `final` phase produced output)
**/** `blocked` (gate BLOCK, approval rejected, or `budget` hit) **/** `failed`
(a non-`optional` phase errored) **/** `paused` (aborted).

`taskflow_run` reports a `runId`. If the final output looks wrong, don't
re-run blind — `taskflow_peek` the run: omit `phaseId` to list phase statuses
and output sizes, then peek the suspicious phase (`json: true` for parsed
output, `item: n` for one fan-out section). Output is hard-truncated
(default 4000 chars, max 32000) so a peek never floods your context.

Use `taskflow_trace` to inspect the append-only event log for a finished run,
then `taskflow_replay` to re-judge it under alternate thresholds/budget **offline
(zero tokens)** — e.g. "would a 0.9 gate threshold have blocked this run?"

For flows re-run as the repo evolves, pass `incremental: true` to
`taskflow_run` — every phase defaults to **cross-run cache reuse**: identical
input → $0 instant hit. Per-phase `cache.fingerprint` entries
(`git:HEAD`, `glob!:src/**/*.ts`, `file:package.json`) invalidate on world
changes; a cached `map` re-executes only changed items. See `configuration.md` §8.
