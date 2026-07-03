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
- `context` (optional, per step or top-level in single mode): file paths to
  pre-read and inject before the task — same as the full-DSL `Phase.context`
  (per-file `contextLimit`, default 8000 chars). In **parallel `tasks` mode**
  all branches SHARE the union of step contexts (the runtime pre-reads per
  phase, not per branch). In **chain mode** declare `context` on individual
  steps; a top-level `context` is ignored (with a warning).
- Add `name` to label the run (and to `save` it as a `/tf:<name>` command).
- Precedence if several are given: `chain` > `tasks` > `task`.
- You can pass these as top-level tool params **or** inside `define`.

```jsonc
// context pre-read in shorthand — the file content is injected before the task
{ "chain": [
  { "task": "Map the public API of src/lib", "agent": "scout" },
  { "task": "Write docs for:\n{previous.output}", "agent": "doc-writer",
    "context": ["AGENTS.md", "docs/style-guide.md"] }
] }
```

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

| type | meaning | details |
|------|---------|---------|
| `agent` | one subagent runs `task` | DSL shape |
| `parallel` | run `branches[]` concurrently | Conditional routing |
| `map` | fan out over `over` (an array) — one subagent per item, `{item}` bound | DSL shape |
| `gate` | quality/review step that can **halt the flow** | Gate phases |
| `reduce` | aggregate `from[]` phases into one output | DSL shape |
| `approval` | **human-in-the-loop** pause: ask a person to approve / reject / edit before continuing | Approval phases |
| `flow` | run a **sub-flow** as one phase — **saved** (`use`) or **runtime-generated** (`def`) | Sub-flows |
| `loop` | repeat a body until a condition / convergence / `maxIterations` | Loop phases |
| `tournament` | run N competing `variants`, a `judge` picks the best or aggregates | Tournament phases |
| `script` | run a **shell command** (no LLM, zero tokens) — captures stdout as the output | Script phases |

### Control-flow fields (any phase)

| field | meaning |
|-------|---------|
| `when` | conditional guard — skip the phase unless the expression is truthy. Supports `{refs}`, `== != < > <= >=`, `&& \|\| !`, parentheses, quoted strings/numbers. Parse errors fail **open** (phase runs). |
| `join` | dependency join: `"all"` (default — wait for every dep) or `"any"` (OR-join — run as soon as one dep completes). |
| `retry` | `{ "max": N, "backoffMs": ms, "factor": k }` — retry a failing subagent up to N times; delay is `backoffMs * factor^attempt` (`factor:1`=fixed, `2`=exponential). |
| `timeout` | max ms per subagent call (>= 1000). On expiry the subagent is aborted and the phase fails with a `timedOut` marker — deterministic, **never retried**. Valid on any agent-running phase; note it caps EACH call, so a map/parallel/loop/tournament phase's wall time is per item/iteration/variant (a tournament's judge call gets its own cap too). Script phases keep their own child-process timeout (default 60s, max 300s). Not supported on approval/flow. Pair with `optional: true` + a downstream fallback phase to degrade instead of failing the run. |
| `expect` | output contract for `output: "json"` phases (agent/gate/reduce/loop): a JSON-Schema-like shape `{type, properties, required, items, enum}` validated the moment the subagent finishes. A violation fails the phase with a precise diagnostic (e.g. `$.score: required key is missing`) and is retryable under the phase's explicit `retry`. `verify`/`compile` also statically warn when a `{steps.X.json.field}` ref names a field absent from X's declared contract. |
| `idempotent` | side-effect classification. Default `true` (safe to cache + auto-retry). Set `false` on phases with **irreversible side effects** (webhook POSTs, deploys, DB writes, file mutations): transient provider errors are **not** auto-retried (an explicit `retry{}` IS still honored — it's your declaration that repeats are acceptable) and the result is **never cached** in any scope (within-run resume, cross-run, `incremental` — the phase re-runs every time). The phase state records `sideEffect: true` (rendered as ⚡). |

### Conditional routing (when + gate/branches)

Pair `when` with an upstream phase that emits a decision to build real if/else
routing. Use `join: "any"` on the merge phase so it runs whichever branch fired. For
static (non-conditional) concurrency, a `parallel` phase runs fixed `branches[]`
instead — `{ "type": "parallel", "branches": [{"task":"..."}, {"task":"...","agent":"reviewer"}] }`.

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
- **Non-interactive** runs (headless/CI/print mode) **auto-reject** and record it — approval gates are safety boundaries that must never be silently bypassed.
- **Background (detached)** runs **auto-reject** (no interactive approver) — downstream sees the rejection; the flow continues (fail-open).

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
validation, the phase completes with `status: "done"` and carries a `defError`
diagnostic field; downstream phases receive empty output. Authors who want a
hard failure can add a gate that checks for `defError`. The run continues
(add `optional: true` on the flow phase so a bad plan never aborts the run). An **empty** `phases` array is a
valid no-op (the planner decided there's nothing to do). Inline nesting is capped
at `MAX_DYNAMIC_NESTING` (5) to bound runaway self-spawning.

**Iterative replanning** — pair `flow{def}` (or a JSON-emitting body) with `loop`
so round N's plan depends on round N-1's **result** (not a one-shot fan-out):
the declarative equivalent of `for (...) { read result; decide next }`. See
`examples/dynamic-plan-execute.json` and `examples/iterative-replan.json`.

### Loop phases (iterate until done)

A `loop` phase runs its body repeatedly, exposing each iteration's output as
`{steps.<thisId>.output}` / `.json` so the next round can react to the last. It
stops on the first of: `until` truthy, **convergence** (output stops changing),
or `maxIterations` (hard cap). This is the declarative "keep going until good
enough" — the runtime always terminates (the cap is mandatory).

- `until` — stop condition, same operators as `when` (a parse error stops the loop, fail-safe).
- `maxIterations` — hard iteration cap (required to bound the loop).
- `convergence` — `true` to stop early when an iteration's output equals the previous one.
- `reflexion` — `true` to give each iteration structured feedback about the prior one (see below).

```jsonc
{
  "id": "refine",
  "type": "loop",
  "agent": "executor",
  "maxIterations": 5,
  "until": "{steps.refine.json.done} == true",
  "convergence": true,
  "task": "Improve the draft. When nothing else needs fixing, output JSON {\"done\":true,\"draft\":\"...\"}; otherwise {\"done\":false,\"draft\":\"...\"}.",
  "output": "json",
  "final": true
}
```

**Reflexion memory (`reflexion: true`).** By default each iteration only sees
the prior output — the *reason* the loop isn't done yet (a contract violation,
an error, the unmet `until`) is discarded, so models tend to repeat the same
mistake. With `reflexion: true`, every iteration after the first receives a
structured failure summary of the prior one: `expect`-contract diagnostics
(the strongest signal), the error message, or the unmet stop condition, plus a
truncated output snippet (capped at 2000 chars). Put `{reflexion}` in the task
where you want it; if absent it is auto-appended (with a one-time warning).
Iteration 1 sees a sentinel (`_(first iteration — no prior feedback yet)_`).

Semantics shift to enable self-correction: **body failures become feedback
instead of terminating the loop** — a failed iteration's diagnostics feed the
next attempt. Timeout/abort still hard-stop, and if `maxIterations` exhausts
with the last iteration failed, the phase fails (reflexion defers failure, it
never erases it). Costs are bounded by `maxIterations` + the run `budget`.

```jsonc
{
  "id": "emit-plan", "type": "loop", "reflexion": true, "maxIterations": 4,
  "output": "json", "expect": { "type": "object", "required": ["steps", "done"] },
  "until": "{steps.emit-plan.json.done} == true",
  "task": "Emit the migration plan as JSON {steps:[...], done:bool}.\n{reflexion}"
}
```
// iteration 2 sees e.g.: "## Reflexion: iteration 1 (prior) — FAILED — output
// contract violated — $.done: required key is missing — Fix the issues above…"

For data-dependent **replanning** each round, pair a `loop` body that emits a
plan with `flow{def}` (see Sub-flows above). See `examples/iterative-replan.json`.

### Tournament phases (N variants, judge picks best)

A `tournament` phase runs `variants` competing attempts in parallel, then a
**judge** sub-phase selects the winner (`mode: "best"`) or merges them
(`mode: "aggregate"`). Use it when one shot is unreliable and you want the best
of several drafts, or a synthesis of diverse approaches.

- `variants` — a number specifying how many competing variants to spawn from 'task' (default 3, max 20). For genuinely different approaches, use the `branches` field instead — an explicit array of `{task, agent?}` definitions.
- `mode` — `"best"` (judge picks one winner, default) or `"aggregate"` (judge merges all into one output).
- `judge` — the judge's rubric/instructions (how to choose or merge).
- `judgeAgent` — *(optional)* the agent that runs the judge step; defaults to the phase `agent`.
- Fail-open: if the judge's pick is unparseable, variant 1 is returned (work is never lost).

```jsonc
{
  "id": "headline",
  "type": "tournament",
  "agent": "executor",
  "variants": 3,
  "mode": "best",
  "judge": "Pick the clearest, most accurate headline. End with: WINNER: <n>.",
  "task": "Write one headline for the article below.\n\n{steps.draft.output}",
  "dependsOn": ["draft"],
  "final": true
}
```

### Script phases (shell commands, zero tokens)

A `script` phase runs a **shell command** directly — no subagent, no tokens — and
captures its stdout as the phase output. Use it to glue LLM phases to real tools:
run a build/test/format, `git`, a webhook, or pipe an upstream phase through a
script.

- `run` — **required**. A **string** runs through a shell; an **array** is
  spawned directly (execvp, no shell). A string `run` that contains an
  interpolation placeholder is **rejected at validation** (shell-injection
  guard) — use the array form or `input` for dynamic values.
- `input` — optional text piped to stdin (supports interpolation).
- `timeout` — optional ms cap (1000–300000, default 60000); on timeout the child
  is SIGTERM'd then SIGKILL'd and the phase fails.
- A non-zero exit fails the phase (stderr captured); stdout is capped at 1 MB.
  No `retry`, no `output: "json"`; **excluded from `cross-run` cache** (may have
  side effects). Compiles to a `⚡ script` node.

```jsonc
{ "id": "build", "type": "script", "run": "npm run build", "timeout": 120000 },
{ "id": "score", "type": "script", "run": ["python", "score.py"],
  "input": "{steps.analyze.output}", "dependsOn": ["analyze"], "final": true }
```

### Workspace isolation (`cwd` keywords)

A phase's `cwd` is normally a literal path (or inherited from the run). Three
**reserved keywords** instead ask the runtime to allocate an isolated working
directory for the phase's subagent and tear it down afterwards — so a phase can
do scratch work, or mutate files, without touching the main tree:

| `cwd` value | what the runtime does | lifecycle |
|-------------|-----------------------|-----------|
| `"temp"` | makes an ephemeral dir under the OS tmpdir | removed when the phase finishes |
| `"dedicated"` | makes a persistent dir under the run state (`runs/ws/<runId>/<phaseId>`) | **kept** for inspection; deterministic per phase (resume reuses it) |
| `"worktree"` | `git worktree add` on a throwaway branch off `HEAD` | `git worktree remove` + branch delete when the phase finishes |

```jsonc
{ "id": "experiment", "type": "agent", "agent": "executor", "cwd": "worktree",
  "task": "Try the risky refactor and run the tests. Your edits are isolated in a git worktree." }
```

- **Fail-open.** If allocation fails (e.g. `worktree` requested but the repo
  isn't a git work tree), the phase degrades — `worktree`→`temp`, and any other
  failure → the base cwd — and records a `warnings` diagnostic. A phase never
  fails to run because of isolation.
- **Security.** The keywords are honoured only in **author-written** flows.
  An LLM-authored sub-flow (`flow{def}` / `ctx_spawn` subflow) that asks for a
  reserved keyword is **rejected at validation** — generated plans cannot
  allocate worktrees or temp dirs that mutate the repo.
- A literal path is passed through unchanged (fully backward-compatible).

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

**Zero-token machine checks (`eval`).** Before spending a token on the LLM gate,
list machine-checkable assertions in `eval`. If **all** pass, the gate
auto-passes with **no LLM call**; if any fails, it falls through to the LLM
`task` (the qualitative residue). Each entry supports the `when` operators plus
`X contains Y` (substring). A parse error fails **open** (consistent with the
gate invariant).

```jsonc
{ "id": "quality", "type": "gate", "dependsOn": ["build","test"],
  "eval": ["{steps.build.output} contains BUILD SUCCESS", "{steps.test.json.failures} == 0"],
  "task": "Review the diff for subtle logic errors a linter can't catch. VERDICT: PASS or BLOCK." }
```

**Self-healing (`onBlock: "retry"`).** By default a blocking gate halts the run
(`onBlock: "halt"`). With `onBlock: "retry"` the gate instead **re-runs its
upstream `dependsOn` phases and re-evaluates**, up to `retry.max` rounds (or
until PASS / budget / abort) — a generate→critique→regenerate rework loop.

```jsonc
{ "id": "spec-gate", "type": "gate", "onBlock": "retry", "retry": { "max": 3 },
  "dependsOn": ["implement"],
  "task": "Does the implementation satisfy ALL acceptance criteria? VERDICT: PASS or BLOCK with reasons." }
```

**Scoring gates (`score`).** Where `eval` gives boolean assertions, `score`
gives **graded, composable, auditable** quality checks: deterministic scorers
run against a target string at zero tokens, combine into a [0,1] score, and
only fall back to an LLM when they can't decide. The structured result is the
gate's `.json` — downstream phases can read `{steps.<gate>.json.combined}` /
`.json.results.0.passed` and route on quality.

| field | meaning |
|-------|---------|
| `target` | interpolation ref for the scored string (default `{previous.output}`) |
| `scorers` | array of checks: `exact-match` (`value`), `contains` (`value`), `regex` (`pattern`, optional `negate`), `json-schema` (`schema`, an `expect`-style contract), `length-range` (`min`/`max`), `code-compiles` (`language`: javascript\|typescript) |
| `combine` | `all` (default) / `any` / `weighted` |
| `weights` | weighted only — one entry per scorer, **+1 trailing entry for the judge** when present |
| `threshold` | weighted only — combined-score cutoff in (0,1], default 0.5 |
| `judge` | optional LLM-as-judge fallback `{agent?, task}` — runs ONLY when the deterministics fail; sees the target + scorer report; returns `{"score": 0-1, "verdict": "pass"\|"block", "reason"}` |

Decision order: (1) deterministic scorers pass → **auto-PASS, zero LLM tokens**
(with `weighted`+judge, the deterministic score is a lower bound — if it already
clears the threshold the judge is skipped); (2) fail + `judge` → judge decides
(weighted folds its score in; all/any takes its verdict); (3) fail + `task` →
the gate task runs with the scorer report appended; (4) fail + no fallback →
**explicit BLOCK** (a deterministic failure is not ambiguity). Fail-open cases:
unparseable judge output → PASS; unresolved `target` with no fallback → PASS
with a warning; malformed `score` → degrades to the plain LLM gate.

```jsonc
// zero-token quality bar with LLM escalation:
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

### Shared Context Tree (blackboard + supervision) — opt-in

By default subagents are fully isolated: they share nothing and only return a
final output string. Opt a phase into the **Shared Context Tree** with
`shareContext: true` (or set `contextSharing: true` at the flow level for every
phase) to give its subagent four extra tools backed by a per-run, file-based
blackboard:

| tool | direction | use |
|------|-----------|-----|
| `ctx_write(key, value)` | horizontal | publish a finding so siblings/descendants can reuse it (avoid re-reading the same files) |
| `ctx_read(key?)` | horizontal | read findings visible to this node: its own + ancestors' + **completed** other nodes' (omit `key` to list all) |
| `ctx_report(summary, structured?)` | vertical ↑ | report a result upward to the parent |
| `ctx_spawn(assignments[])` | vertical ↓ | delegate child tasks; after this node finishes the runtime runs each child (isolated) and **folds their reports into this phase's output**. Each assignment is either a flat `{task, agent?}` OR a `{subflow, defaultAgent?}` — an inline plan `{phases:[...]}` (a dependency-bearing DAG) the runtime validates and runs as a nested sub-flow |

Visibility is eventually-consistent: a sibling's findings become visible once
that sibling **completes** (a running sibling's half-written blackboard is
hidden). Own findings beat ancestors' beat completed-others' on key conflicts.

Use it when fan-out items share expensive context (one map item maps the repo,
the rest read its findings), or when a task should discover work at runtime and
delegate it (`ctx_spawn`) rather than the author pre-declaring every branch.

**Spawning a sub-graph (not just flat tasks).** A `ctx_spawn` assignment can be
a whole inline plan instead of a single task — use `subflow` when the delegated
work has multiple coordinated steps with dependencies:

```jsonc
ctx_spawn({ assignments: [
  { task: "quick standalone check", agent: "analyst" },          // flat task
  { subflow: {                                                   // a DAG
      phases: [
        { id: "scan",  type: "agent",  agent: "scout",  task: "list endpoints" },
        { id: "audit", type: "map",    over: "{steps.scan.json}", task: "audit {item}", dependsOn: ["scan"] },
        { id: "sum",   type: "reduce", from: ["audit"], task: "summarize", dependsOn: ["audit"], final: true }
      ]
    },
    defaultAgent: "analyst"   // inner phases without their own `agent` use this
  }
] })
```

The subflow is validated (cycles / dangling refs / dead-ends) before it runs;
a bad plan fails **open** (a diagnostic is folded into the report, the run
continues). `agent` (flat task) = who executes; `defaultAgent` (subflow) =
fallback for inner phases — different fields because the semantics differ.
Nesting is bounded: spawn-subflows and `flow{def}` share one depth counter
capped at `MAX_DYNAMIC_NESTING` (5), so neither can multiply with the other.

```jsonc
{ "id": "survey", "type": "agent", "agent": "scout", "shareContext": true,
  "task": "Map the API surface. ctx_write key 'endpoints' with the JSON list so the auditors don't re-scan." },
{ "id": "audit", "type": "map", "over": "{steps.survey.json}", "shareContext": true,
  "dependsOn": ["survey"], "agent": "analyst",
  "task": "ctx_read 'endpoints' for shared context, then audit {item} for missing auth." }
```

Guards & limits: ids used with sharing must match `[A-Za-z0-9._-]+`; keys are
`[A-Za-z0-9._-]` (≤128 chars); values ≤256 KB; ≤256 keys/node; `ctx_spawn`
≤16 tasks/call, task ≤64 KB, depth-capped at 5. All bookkeeping is fail-open
(it can never sink a phase) and the per-run blackboard is cleaned up with the
run. Backward compatible: flows that don't opt in behave exactly as before.

You do **not** need to teach the tools in your `task` text — enabling
`shareContext` auto-appends usage guidance to the subagent's system prompt
(read-first discipline, publish reusable findings, report up, delegate on
fan-out). Mentioning a specific key in the task (e.g. "ctx_write the endpoint
list under 'endpoints'") just makes the cross-phase contract explicit.

**Producer tip (learned from real runs):** the phase that *publishes* shared
context should be a **capable** agent (high thinking), and the `ctx_write`
should be framed as its **primary deliverable** ("if you did not call ctx_write
you failed the task"). A fast / `thinking: off` agent asked to "survey AND
ctx_write" will often do the survey and skip the write. Consumers (the agents
that `ctx_read`) can be lighter — reading is a single reliable step.

## Configuration

For the full set of knobs — per-phase `model`/`thinking`/`tools`/`cwd`, the
two-level concurrency model, model/thinking/tools resolution precedence,
`agentScope` & agent discovery, `settings.json` overrides, environment
variables, and storage paths — read `configuration.md` (next to this file).

Quick reference:

- **Flow:** `name`, `description`, `concurrency` (default 8), `budget` (`maxUSD`/`maxTokens`), `agentScope` (user|project|both), `args`, `strictInterpolation`.
- **Phase:** `model`, `thinking`, `tools` (whitelist), `cwd`, `output:"json"`, `expect` (output contract), `concurrency` (map/parallel fan-out), `when`, `join` (all|any), `retry`, `timeout` (per-call ms cap), `use`/`with` (flow), `optional` (fail-soft — a failed/blocked phase won't abort the run), `final`.
- **Cross-run caching:** add `cache: { "scope": "cross-run" }` to a phase to memoize its output across runs (same input → instant reuse, zero tokens), or set `incremental: true` at the flow level (or pass `incremental: true` to `run`) to default every phase to cross-run reuse. See `configuration.md` for `ttl`, `fingerprint` (git/glob/file/env invalidation), scope options, and the `incremental` precedence rules.
- **Precedence (model/thinking/tools):** phase value → agent frontmatter (resolved via `modelRoles`) → global/default.
- **Concurrency:** same-layer phases use `flow.concurrency`; a `map`/`parallel` phase uses `phase.concurrency ?? flow.concurrency ?? 8`.

### Per-item map caching (cross-run)

A `map` phase with `cache: { "scope": "cross-run" }` is cached **per item**, not
just as a whole. When one of N items changes between runs, only that item
re-executes — the other N−1 are served from the cross-run cache for $0.

```jsonc
{ "id": "audit-each", "type": "map",
  "over": "{steps.discover.json.files}",   // array from an upstream phase
  "task": "audit {item}",
  "cache": { "scope": "cross-run" },        // ← enables per-item reuse
  "dependsOn": ["discover"], "final": true }
```

How it works:

- The **whole-map** entry is still checked first (fast path): an identical
  re-run is a single $0 hit and never enters the fan-out.
- On a whole-map miss, each item is looked up individually before it spawns a
  subagent; a hit returns a 0-token synthesized result. Successful fresh items
  are recorded so a later run with that item unchanged reuses them.
- Per-item keys fold the item's resolved task **and agent** (so changing
  `phase.agent` invalidates every item), plus the phase sub-fingerprint,
  `thinking`/`tools`, and any `fingerprint` entries — exactly like a standalone
  cross-run phase.

Automatic fallbacks (per-item disables and the whole-map path is used):

- `shareContext: true` on the phase, or flow-wide `contextSharing: true` — a
  sharing item can read sibling blackboard writes outside its declared deps, so
  the per-item key would under-approximate real reads.
- The map runs **inside a runtime-generated sub-flow** (a `flow { def }` phase
  or a `ctx_spawn({subflow})`) — untrusted / possibly non-deterministic.
- `scope: "run-only"` (default) or `"off"` — no persistent store to reuse from.

Notes & limitations:

- Duplicate items (identical task + agent) share a single entry — reuse is
  content-addressable, not positional.
- Failed items and **budget-skipped** items are never cached, so they always
  re-execute on the next run.
- `{steps.<map>.json.k}` (dot-index) indexes the k-th **successful** item (not
  the k-th position in `over`); the merged `output` text, however, IS
  positionally aligned with `over` (labels read `[k/N]`).
- Within-run resume of a partially-completed map is not supported (only
  fully-completed maps resume within a run); cross-run per-item reuse covers the
  common case.

## Actions

- `action: "run"` — run an inline `define` (a one-off DAG) **or** a saved `name` (with optional `args`). Use `define` for an ad-hoc flow; use `name` to invoke something previously saved. Add `detach: true` to run in the background (returns immediately with the runId; poll the store for status).
- `action: "save"` — persist `define` (scope `project` — default, committed/shared — or `user`); it becomes `/tf:<name>`. On a name collision, project overrides user.
- `action: "resume"` — continue a paused/failed run by `runId`.
- `action: "list"` — list saved flows. `action: "verify"` — static-check a `define` (zero tokens). `action: "compile"` — render a saved or inline flow as a Mermaid diagram + verification report (zero tokens, no LLM). `action: "agents"` — list available agents.

## Background (detached) runs

Add `detach: true` to `action: "run"` to spawn the flow in a detached child process. The tool returns immediately with the `runId`; the flow continues running even if the host session exits. Status is polled via the store (`/tf runs` or `action: "resume"`).

- **Approval phases auto-reject** in detached mode (no interactive approver). Downstream phases see the rejection; the flow continues (fail-open).
- **Crash resilience:** if the detached process crashes, the store persists `status: "failed"`; resume with `action: "resume"`.
- **Same flow, both modes:** a flow can run foreground or background — `detach` is a dispatch-time decision, not a flow property.

## Operating a run (lifecycle, resume, inspection)

A run moves through: **running →** `completed` (a `final` phase produced output) **/** `blocked` (a gate emitted BLOCK, an `approval` was rejected, or the `budget` cap was hit) **/** `failed` (a non-`optional` phase errored) **/** `paused` (the run was aborted). `failed` and `paused` runs are resumable.

- **`blocked` runs:** a blocked status halts the current run — the flow status is set to `blocked` and remaining phases are skipped. Re-running the flow resumes from the last completed state: `done` phases with matching input hashes are skipped; blocked/failed/skipped phases are re-attempted. Fix the gate condition or budget before re-running.
- **Resume is cache-aware.** `action: "resume"` re-runs only what didn't finish: every phase already `done` is reused from its recorded output (within-run cache), so resuming after a crash or a failed/blocked stop never repeats completed work. A phase that was mid-flight is re-executed cleanly (stale `error`/`endedAt` are cleared first).
- **When to resume vs. re-run.** Resume when the inputs are unchanged and you just want to continue/retry the tail (fixed a gate, raised the budget, approved a checkpoint). Re-run from scratch when the task or upstream inputs changed — resume would reuse now-stale outputs. (For reuse *across* runs, opt a phase into `cache: {scope:"cross-run"}` — see configuration.md.)
- **Budget mid-run.** When the run-wide `budget` is exceeded, remaining phases are skipped and an in-flight `map`/`parallel` stops spawning new items; the run ends `blocked` with the partial outputs preserved.
- **Inspect runs.** `/tf runs` lists recent runs with status; `/tf show <name>` prints a saved flow's definition. Run state lives at `<project .pi>/taskflows/runs/<flowName>/<runId>.json` (gitignored).
- **Peek at intermediate outputs.** `/tf peek <runId>` lists a run's phases (status + output size); `/tf peek <runId> <phaseId>` prints that phase's stored output — `--json` for the parsed JSON, `--item <n>` for one section of a map/parallel fan-out, `--limit <chars>` to adjust the hard truncation (default 4000, max 32000). Read-only and explicitly human-invoked: the context-isolation contract (only the final output enters the conversation) still holds for the LLM — peek is the debugging escape hatch when one phase of many produced garbage and you don't want to re-run the whole flow.

### Output contracts (`expect`)

Declare the shape a JSON-emitting phase must produce; the runtime enforces it the
moment the subagent finishes — turning "phase completed but the shape is wrong and
downstream silently mis-parses" into an immediate, precise failure at the source.

```jsonc
{ "id": "triage", "type": "agent", "agent": "analyst", "output": "json",
  "task": "Classify. Output ONLY JSON {\"route\":\"deep\"|\"quick\",\"score\":0-1}.",
  "expect": { "type": "object", "required": ["route", "score"],
               "properties": { "route": { "enum": ["deep", "quick"] },
                                "score": { "type": "number" } } },
  "retry": { "max": 2, "backoffMs": 0 } }
```

- Supported keywords: `type` (object|array|string|number|integer|boolean|null),
  `properties`, `required`, `items`, `enum`. Nested contracts compose.
- A violation fails the phase with per-path diagnostics; with an explicit
  `retry` the subagent gets another attempt (the diagnostic is deterministic, so
  transient auto-retry does NOT apply).
- Static payoff: `verify` warns when any `{steps.X.json.field}` ref names a field
  X's contract doesn't declare — catching ref typos before a single token is spent.

## User commands

- `/tf list` · `/tf run <name> [args]` · `/tf show <name>` · `/tf compile <name> [lr|td]` · `/tf runs` · `/tf peek <runId> [phaseId] [--json] [--item <n>] [--limit <chars>]` · `/tf resume <runId>`
- `/tf:<name> [args]` — shortcut for each saved flow
