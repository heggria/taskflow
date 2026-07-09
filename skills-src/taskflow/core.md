Build and run **declarative, multi-phase workflows** of subagents. The runtime
holds intermediate results and the phase DAG, so your main context only receives
the final answer — not every step's transcript.

## Documentation map (progressive loading)

This file teaches the core: phase types, control flow, interpolation, and the
mistakes that break flows. Load the companion files **only when needed**:

| File | Load when you need |
|------|--------------------|
| `patterns.md` | **Designing a non-trivial flow.** Proven flow archetypes (audit fan-out, self-healing rework, plan→approve→execute, dynamic replanning, tournament synthesis, incremental audit), anti-patterns, and the production-flow quality checklist. |
<!-- host:pi -->
| `advanced.md` | Shared Context Tree (`ctx_*` tools, `ctx_spawn` sub-graphs), workspace isolation (`cwd: temp/dedicated/worktree`), dynamic sub-flow (`flow{def}`) contracts & security caps, and the **incremental recompute suite** (`ir` / `provenance` / `why-stale` / `recompute` / `cache-clear`). |
<!-- /host:pi -->
<!-- host:codex,claude,opencode,grok -->
| `advanced.md` | Dynamic sub-flow (`flow{def}`) contracts & security caps, and workspace isolation (`cwd: temp/dedicated/worktree`). |
<!-- /host:codex,claude,opencode,grok -->
| `configuration.md` | Every knob: per-phase `model`/`thinking`/`tools`/`cwd`, concurrency model, agent discovery, `settings.json`, cross-run caching (`cache`, `fingerprint`, per-item map caching), args, storage paths. |
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
<!-- host:pi -->
- A single quick delegation with no tracking needs — the plain `subagent` tool
  is fine (though the shorthand below gives you resume + save for free).
<!-- /host:pi -->

## Flow design ladder

Match the flow's sophistication to the task. Don't stop at level 1 when the
task deserves level 3 — the higher levels are where taskflow pays for itself.

| Level | Shape | Reach for it when |
|-------|-------|-------------------|
| 0 | shorthand `task` / `tasks` / `chain` | one-off delegation, simple sequence |
| 1 | linear DAG with `dependsOn` | fixed steps, each consuming the last |
| 2 | discover → `map` fan-out → `gate` → `reduce` | many items, needs review before reporting |
| 3 | + `eval` zero-token gates, `expect` contracts, `retry`, `onBlock: "retry"`, `budget`, `optional` fallbacks | production-grade: self-healing, cost-capped, fails precisely |
| 4 | + `loop`, `tournament`, `flow{def}` dynamic planning | the work itself is discovered at runtime; one shot is unreliable |
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
- Add `name` to label the run.
- Precedence if several are given: `chain` > `tasks` > `task`.
<!-- host:pi -->
- You can pass these as top-level tool params **or** inside `define`.
<!-- /host:pi -->
<!-- host:codex,claude,opencode,grok -->
- Pass these as the `define` argument to `taskflow_run`.
<!-- /host:codex,claude,opencode,grok -->

## How to author a taskflow

<!-- host:pi -->
Call the `taskflow` tool. To run a brand-new flow you write inline, pass
`action: "run"` with a `define` object. To run a saved flow, pass `name`.
**Before running a non-trivial flow, `action: "verify"` it — zero tokens,
catches cycles / missing deps / undefined refs / contract typos.**
<!-- /host:pi -->
<!-- host:codex,claude,opencode,grok -->
Call `taskflow_run` with an inline `define` object, or `name` for a saved flow.
**Before running a non-trivial flow, `taskflow_verify` it — zero tokens,
catches cycles / missing deps / undefined refs / contract typos.**
<!-- /host:codex,claude,opencode,grok -->

### Iterating on a big flow? Use `defineFile` (write once, verify / edit / run by path)

For a non-trivial flow you'll iterate on, **write the definition to a file**
(typically in the OS tmp dir) and point every call at it with `defineFile`:

<!-- host:pi -->
```jsonc
// 1. write /tmp/audit.json with the `write` tool (a full {name, phases:[…]} object)
// 2. verify, iterate, run — all reference the SAME file by path:
{ "action": "verify", "defineFile": "/tmp/audit.json" }        // zero tokens
{ "action": "compile", "defineFile": "/tmp/audit.json" }        // diagram + report
{ "action": "run",    "defineFile": "/tmp/audit.json", "args": { … } }
```
<!-- /host:pi -->
<!-- host:codex,claude,opencode,grok -->
```jsonc
// 1. write /tmp/audit.json with the `write` tool (a full {name, phases:[…]} object)
// 2. verify, iterate, run — all reference the SAME file by path:
{ "name": "taskflow_verify", "arguments": { "defineFile": "/tmp/audit.json" } }  // zero tokens
{ "name": "taskflow_compile", "arguments": { "defineFile": "/tmp/audit.json" } }  // diagram
{ "name": "taskflow_run",    "arguments": { "defineFile": "/tmp/audit.json" } }
```
<!-- /host:codex,claude,opencode,grok -->

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

### Phase types (10)

| type | meaning | details |
|------|---------|---------|
| `agent` | one subagent runs `task` | this file |
| `parallel` | run static `branches[]` concurrently | this file |
| `map` | fan out over `over` (an array) — one subagent per item, `{item}` bound | this file |
| `gate` | quality/review step that can **halt the flow** | Gate phases below |
| `reduce` | aggregate `from[]` phases into one output | this file |
| `approval` | **human-in-the-loop** pause: approve / reject / edit | Approval phases below |
| `flow` | run a **sub-flow** as one phase — saved (`use`) or runtime-generated (`def`) | summary below; deep contract in `advanced.md` |
| `loop` | repeat a body until a condition / convergence / `maxIterations` | Loop phases below |
| `tournament` | run N competing `variants`, a `judge` picks best or aggregates | Tournament phases below |
| `script` | run a **shell command** (no LLM, zero tokens) — stdout is the output | Script phases below |

### Control-flow fields (any phase)

| field | meaning |
|-------|---------|
| `when` | conditional guard — skip the phase unless the expression is truthy. Supports `{refs}`, `== != < > <= >=`, `&& \|\| !`, parentheses, quoted strings/numbers. Parse errors fail **open** (phase runs). |
| `join` | dependency join: `"all"` (default — wait for every dep) or `"any"` (OR-join — run as soon as one dep completes). |
| `retry` | `{ "max": N, "backoffMs": ms, "factor": k }` — retry a failing subagent up to N times; delay is `backoffMs * factor^attempt` (`factor:1`=fixed, `2`=exponential). |
| `timeout` | max ms per subagent call (>= 1000). On expiry the subagent is aborted and the phase fails with a `timedOut` marker — deterministic, **never retried**. Caps EACH call, so a map/parallel/loop/tournament phase's wall time is per item/iteration/variant (a tournament's judge call gets its own cap too). Script phases keep their own child-process timeout (default 60s, max 300s). Not supported on approval/flow. Pair with `optional: true` + a downstream fallback phase to degrade instead of failing the run. |
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

<!-- host:pi -->
Place one before the expensive part of a flow (a big fan-out, a mutation) —
see the plan→approve→execute archetype in `patterns.md`.
<!-- /host:pi -->
<!-- host:codex,claude,opencode,grok -->
> **MCP-host caveat (Codex / Claude Code / OpenCode):** MCP-driven runs are
> non-interactive, so an `approval` phase **auto-rejects**. Prefer a `gate`
> (agent review) in flows you run through the `taskflow_*` tools; use `approval`
> only in flows a human runs interactively.
<!-- /host:codex,claude,opencode,grok -->

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

### Budget (cost / token caps)

Add a run-wide ceiling at the top level. When accumulated cost/tokens exceed it,
remaining phases are skipped (and an in-flight `map`/`parallel` stops spawning
new items); the run ends as `blocked` with partial outputs preserved.

```jsonc
{ "name": "...", "budget": { "maxUSD": 1.50, "maxTokens": 2000000 }, "phases": [ ... ] }
```

**Any flow with a fan-out should have a `budget`** — a map over a
mis-discovered 500-item array is otherwise unbounded spend.

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
- `{previous.output}` — the immediately-upstream phase output
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
<!-- host:pi -->
Check with `action: "agents"` instead of guessing.
<!-- /host:pi -->
<!-- host:codex,claude,opencode,grok -->
Built-in agents: `executor`, `executor-code` (complex, multi-file),
`executor-fast` (trivial), `executor-ui`, `scout` (cheap recon), `planner`,
`analyst`, `critic`, `reviewer`, `risk-reviewer`, `security-reviewer`,
`plan-arbiter`, `final-arbiter`, `test-engineer`, `doc-writer`, `verifier`,
`recover`, `visual-explorer`. **Do not invent agent names** — omit `agent` to
use the default. Use cheap agents (`scout`) for discovery and strong agents
(`critic`, `final-arbiter`) for gates/judging.
<!-- /host:codex,claude,opencode,grok -->

<!-- host:pi -->
## Actions (all 16)

| action | what it does |
|--------|--------------|
| `run` | Run an inline `define` or a saved `name` (+ optional `args`). Add `detach: true` for background (returns runId immediately). Add `incremental: true` to default every phase to cross-run cache reuse. |
| `save` | Persist `define` (scope `project` default / `user`); becomes `/tf:<name>`. Project overrides user on collision. |
| `resume` | Continue a paused/failed run by `runId`. Cache-aware: `done` phases are reused, only the unfinished tail re-runs. |
| `list` | List saved flows. |
| `agents` | List available agents (never invent names). |
| `verify` | Static-check a `define` or saved `name` — cycles, missing deps, undefined refs, contract-ref typos. Zero tokens. |
| `compile` | Render a flow as a Mermaid diagram + verification report. Zero tokens. |
| `ir` | Compile to **FlowIR** — the canonical intermediate representation with a content hash per phase. Use to diff two versions of a flow or confirm a definition change actually changed a phase's fingerprint. Zero tokens. |
| `provenance` | Show a completed run's **observed read-sets** — which phases actually read which upstream outputs at runtime (may be narrower than `dependsOn`). Requires `runId`. Zero tokens. |
| `trace` | Show a completed run's **deterministic-replay event trace** — each subagent call's input/output + the runtime's own decisions (gate verdicts, when-guard results, cache hits, unreplayable markers). `runId` required; `--json` for the complete machine-readable record. Zero tokens, read-only. |
| `replay` | **Offline what-if** on a recorded trace: re-evaluate under alternate gate thresholds, budget caps, or model routes **without calling the model** (zero tokens). Reports per-phase `reused` / `would-block` / `verdict-flipped` / `would-exceed-budget` / `needs-live-rerun`. `runId` required; optional `thresholds`, `budgetMaxUSD`, `budgetMaxTokens`, `models`; `--json` for the full `ReplayReport`. |
| `why-stale` | Given `runId` (+ optional `phaseId` as the assumed-changed seed): with no seed, prints the observed dependency graph; with a seed, computes the **transitive stale frontier** — exactly which phases would need re-running and why (observed ∪ declared edges). Zero tokens. |
| `recompute` | Re-run **only the stale frontier** of a stored run from a seed `phaseId`. **Defaults to `dryRun: true`** (reports what would re-run, zero tokens). Pass `dryRun: false` to actually re-execute the seed + frontier and persist the updated run. |
| `cache-clear` | Clear the cross-run memoization store. |
| `search` | Search the reusable-flow **library** by purpose/tags (structural + CJK-aware keyword scoring). Find a flow to reuse before authoring a new one. |
| `init` | Model-roles configuration. `mode: "show"` is read-only; `apply-defaults` requires `force: true`; `interactive` needs a UI session. |

**The incremental loop** (`ir` → `why-stale` → `recompute`) is taskflow's
cheapest superpower: after a repo change, re-pay for only the affected phases
of a prior run instead of re-running the whole flow. Full workflow with an
example in `advanced.md`.

## Background (detached) runs

Add `detach: true` to `action: "run"` to spawn the flow in a detached child
process. Returns immediately with the `runId`; the flow survives the host
session exiting. Poll via `/tf runs` or resume by `runId`. Approval phases
auto-reject in detached mode; a crashed detached process persists
`status: "failed"` (resumable).
<!-- /host:pi -->

## Operating a run (lifecycle & inspection)

A run moves through: **running →** `completed` (a `final` phase produced output)
**/** `blocked` (gate BLOCK, approval rejected, or `budget` hit) **/** `failed`
(a non-`optional` phase errored) **/** `paused` (aborted).
<!-- host:pi -->
`failed` and `paused` are resumable.
<!-- /host:pi -->

<!-- host:pi -->
- **Resume is cache-aware.** `action: "resume"` re-runs only what didn't finish;
  a phase that was mid-flight is re-executed cleanly.
- **Resume vs. re-run vs. recompute.** Resume when inputs are unchanged and you
  want to continue the tail (fixed a gate, raised the budget). Re-run from
  scratch when the task text changed. **Recompute** when the *world* changed
  (a file, a commit) and you want to re-pay for only the affected phases.
- **Inspect runs.** `/tf runs` lists recent runs; `/tf show <name>` prints a
  saved flow's definition. Run state:
  `<project .pi>/taskflows/runs/<flowName>/<runId>.json` (gitignored).
- **Peek at intermediate outputs.** `/tf peek <runId>` lists phases (status +
  output size); `/tf peek <runId> <phaseId>` prints that phase's stored output —
  `--json` for parsed JSON, `--item <n>` for one section of a fan-out,
  `--limit <chars>` (default 4000, max 32000). Read-only, human-invoked: the
  context-isolation contract still holds — peek is the debugging escape hatch
  when one phase of many produced garbage.

## User commands

- `/tf list` · `/tf run <name> [args]` · `/tf show <name>` · `/tf runs` · `/tf resume <runId>`
- `/tf verify` · `/tf compile <name> [lr|td]` · `/tf ir <name>`
- `/tf peek <runId> [phaseId] [--json] [--item <n>] [--limit <chars>]`
- `/tf provenance <runId>` · `/tf trace <runId> [--json]` · `/tf replay <runId> [--threshold phase=n] [--budget-usd n] [--json]`
- `/tf why-stale <runId> [phaseId]` · `/tf recompute <runId> <phaseId> [--apply]` (dry-run by default)
- `/tf init` — interactive model-roles setup
- `/tf:<name> [args]` — shortcut for each saved flow
<!-- /host:pi -->
<!-- host:codex,claude,opencode,grok -->
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
<!-- /host:codex,claude,opencode,grok -->
