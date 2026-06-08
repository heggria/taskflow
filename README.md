<div align="center">

<img src="./assets/hero.png" alt="pi-taskflow — declarative DAG orchestration for Pi subagents: stateful, resumable, context-isolated" width="900">

<p>
  <a href="https://www.npmjs.com/package/pi-taskflow"><img src="https://img.shields.io/npm/v/pi-taskflow?style=flat-square&color=B692FF&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-taskflow"><img src="https://img.shields.io/npm/dm/pi-taskflow?style=flat-square&color=6E8BFF&label=downloads" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-43D9AD?style=flat-square" alt="MIT license"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/runtime%20deps-0-43D9AD?style=flat-square" alt="zero runtime dependencies"></a>
  <a href="https://github.com/heggria/pi-taskflow/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/heggria/pi-taskflow/ci.yml?branch=main&style=flat-square&label=CI" alt="CI status"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/tests-394-6E8BFF?style=flat-square" alt="394 tests"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/dogfooded-%E2%9C%93-43D9AD?style=flat-square" alt="dogfooded"></a>
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/for-Pi%20coding%20agent-B692FF?style=flat-square" alt="for the Pi coding agent"></a>
</p>

<p align="center">
  <b>English</b> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.hi.md">हिन्दी</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.bn.md">বাংলা</a> ·
  <a href="./README.pt.md">Português</a> ·
  <a href="./README.ru.md">Русский</a>
</p>

<p><strong>Declarative DAG orchestration for <a href="https://pi.dev">Pi</a> subagents.</strong><br/>
Fan out · gate · resume · save as a command — intermediate results stay out of your context.</p>

```bash
pi install npm:pi-taskflow
```

</div>

---

**Subagents are fire-and-forget. Taskflows fire, fan out, pause, gate, resume, and save themselves as a command.**

You already know the built-in subagent tool's `task` / `tasks` / `chain`. `pi-taskflow` speaks the *same* shorthand — so your existing delegations instantly become **tracked, resumable, and saveable as a one-word `/tf:<name>` command**. When you outgrow the shorthand, the full DSL gives you a real DAG: dynamic fan-out over dozens of items, conditional routing, quality gates, human approvals, retries, and a hard spend ceiling.

And the whole time, **only the final phase reaches your conversation.** Every intermediate transcript stays in the runtime, never your context window.

## Why this exists

Here's the wall you hit with raw subagents: you describe a multi-step plan in prose, the model re-derives it every single run, the intermediate transcripts flood your context, and the moment one model call fails you start over from zero. There's no reuse, no recovery, no structure.

`pi-taskflow` moves the plan **out of the prompt and into a declarative definition.** The runtime owns the DAG, the loops, the retries, and the intermediate state. You declare a pipeline once and run it a hundred times — by name.

<div align="center">
<img src="./assets/context-isolation.png" alt="With raw subagents every transcript floods your context; with pi-taskflow transcripts stay in the runtime and only the final result returns" width="900">
</div>

> When a job needs twelve steps with branching fan-out and a review gate, you want orchestration — not lucky prompting.

| | subagent (built-in) | **pi-taskflow** |
|---|---|---|
| **Who drives** | the model, turn by turn | the runtime, from a definition |
| **Topology** | chain / flat parallel | **DAG with layered concurrency + routing** |
| **Intermediate results** | in your context window | **in the runtime — not your context** |
| **Scale** | a handful of tasks | **dynamic `map` fan-out over dozens of items** |
| **Reusable** | re-described every time | **saved as `/tf:<name>`** |
| **Resumable** | ✗ | **✓ cross-session — cached phases auto-skip** |
| **Quality gates** | ✗ | **`gate` phases that halt on `VERDICT: BLOCK`** |
| **Conditional routing** | ✗ | **`when` guards + `join: any` OR-joins** |
| **Fault tolerance** | ✗ | **per-phase `retry` + auto-retry on transient errors** |
| **Human-in-the-loop** | ✗ | **`approval` phases (approve / reject / edit)** |
| **Cost control** | ✗ | **run-wide `budget` (USD / token caps)** |
| **Composition** | ✗ | **`flow` phases run saved sub-flows** |
| **Live progress** | opaque while running | **live DAG render with timing + cost** |
| **Ergonomics** | inline JSON each time | **shorthand (`task`/`tasks`/`chain`) *or* DSL** |

It doesn't replace the subagent tool. It gives your subagents a DAG, a memory, and a name.

## Compared to other Pi extensions

The Pi ecosystem now has **20+ delegation, workflow, and orchestration extensions** — each great at what it's for. Here's an honest map of where `pi-taskflow` sits (verified against each package's latest npm release, June 2026). For the full breakdown — every package, strengths *and* weaknesses — see [`PI-ECOSYSTEM.md`](./PI-ECOSYSTEM.md). For the broader, non-Pi landscape (LangGraph, Temporal, CrewAI, Mastra…) see [`COMPETITORS.md`](./COMPETITORS.md).

| Extension | Model | Custom DSL | DAG | Dynamic fan-out | Cross-session resume | Quality gate | Human approval | Save as command | Zero deps |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **pi-taskflow** | **declarative multi-phase taskflows** | **✓** | **✓** | **✓ `map`** | **✓ phase-hash** | **✓** | **✓** | **✓ `/tf:<name>`** | **✓** |
| [`@pi-agents/orchid`](https://www.npmjs.com/package/@pi-agents/orchid) | opinionated 9-phase pipeline + Ralph loop | fixed | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ (2) |
| [`pi-crew`](https://www.npmjs.com/package/pi-crew) | role teams + git worktrees + async | partial | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✕ (7) |
| [`ultimate-pi`](https://www.npmjs.com/package/ultimate-pi) | governed plan→execute→review harness | YAML contracts | ✓ (plan-time) | ✕ | ✓ | ✓ (3-tier) | ✓ | ✓ | ✕ (16) |
| [`@zhushanwen/pi-workflow`](https://www.npmjs.com/package/@zhushanwen/pi-workflow) | JS scripts (`agent`/`parallel`/`pipeline`) | yes (JS) | ✕ (linear) | ✓ | ✓ | ✕ | ✕ | ✓ (call cache) | ✓ |
| [`@fiale-plus/pi-rogue-orchestration`](https://www.npmjs.com/package/@fiale-plus/pi-rogue-orchestration) | timer loop + goal resolution | ✕ | ✕ | ✕ | ✓ | ✓ (goal-check) | ✕ | ✕ | ✓ |
| [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) | single / parallel / chain delegation | ✕ | ✕ | static | – | ✕ | clarify | named workflows | ✕ (3) |
| [`@gotgenes/pi-subagents`](https://www.npmjs.com/package/@gotgenes/pi-subagents) | Claude-Code-style subagents + worktrees | ✕ | ✕ | ✕ | ✓ (by id) | ✕ | per-agent | ✕ | ✕ (1) |
| [`pi-pipeline`](https://www.npmjs.com/package/pi-pipeline) | fixed SPEC→PLAN→TASKS→VERIFY | ✕ | fixed | ✕ | session planning | ✓ | clarify | ✕ | ✕ (2) |
| [`pi-agent-flow`](https://www.npmjs.com/package/pi-agent-flow) | one-shot parallel specialist `fork` | yes | ✕ | ✕ | – | ✕ | ✕ | – | ✕ (2) |

*(Representative slice of the 20+ — see [`PI-ECOSYSTEM.md`](./PI-ECOSYSTEM.md) for all of them, plus `@0xkobold/pi-orchestration`, `@melihmucuk/pi-crew`, `@mediadatafusion/pi-workflow-suite`, `gentle-pi`, `@dreki-gg/pi-subagent`, and more.)*

**How to choose:**

- **`@pi-agents/orchid`** is the most feature-complete orchestrator in the ecosystem (DAG + worktrees + Ralph loop + agent mailbox) — but its DSL is a *fixed* 9-phase pipeline, it carries runtime deps + jiti, and it's beta. Reach for `pi-taskflow` when you want to **define your own graph** (not adopt an opinionated one) with **zero dependencies** and a one-command install.
- **`pi-crew` / `ultimate-pi`** go heavier — worktree isolation, durable async teams, multi-tier governance. If you want lightweight, declarative, and zero-dependency, that's this project.
- **`@zhushanwen/pi-workflow`** is the closest in spirit and also zero-dep, but you author workflows as **JavaScript scripts**. `pi-taskflow`'s **declarative JSON DSL** is safer and more auditable, and its **phase-level input-hash resume** is more granular than call-cache dedup.
- **`@fiale-plus/pi-rogue-orchestration`** has a real **loop-until-done** (a feature `pi-taskflow` doesn't yet have). If your job is "keep going until the goal is met," it's worth a look; `pi-taskflow` is for *structured, branching* pipelines instead.
- **`pi-subagents` / `@gotgenes/pi-subagents`** are the mature picks for ad-hoc "use reviewer on this diff" delegation and background jobs. `pi-taskflow` is for when those delegations need to become a *repeatable, resumable pipeline*.
- **`pi-pipeline` / `pi-agent-flow`** ship *opinionated, fixed* flows. `pi-taskflow` ships an *empty canvas*: you (or the model) declare the graph that fits the job.

> The honest one-liner: **`pi-taskflow` is the only Pi extension that gives you a declarative, resumable, DAG-shaped subagent pipeline you save as a one-word command — with zero runtime dependencies and context isolation by design.** The known gaps it's closing next: loop-until-done, worktree isolation, and non-blocking background runs (see [`STRATEGY.md`](./STRATEGY.md)).

## 30-second start

**1. Install** — one command:

```bash
pi install npm:pi-taskflow
```

> **Optional:** run `/tf init` once to map the 18 built-in agents' model roles
> (`fast`, `strong`, `thinker`, …) to your own models — an interactive picker.
> Skip it and agents just use Pi's default model. See [Model roles](#model-roles).

**2. Run** — just ask the model in a Pi session:

> *Run a chain: first explore the auth flow, then summarize the findings.*

The model calls the `taskflow` tool automatically. You get live progress, per-step timing, token cost, and a saved run record — **same effort as the built-in tool, now tracked and resumable.**

**3. Save** — say *"save it"* and you have `/tf:<name>` forever.

That's it. You can be running your first workflow before your coffee cools — without writing a single phase definition.

### The shorthand (same shape as the built-in tool)

```jsonc
// Single — one agent, one job
{ "task": "Summarize the architecture of src/", "agent": "explorer" }

// Parallel — fire several at once, outputs merge
{ "tasks": [
  { "task": "Audit auth in src/api",             "agent": "analyst" },
  { "task": "Audit input validation in src/api", "agent": "analyst" }
] }

// Chain — sequential; each step sees the previous output
{ "chain": [
  { "task": "List the public API of src/lib", "agent": "scout" },
  { "task": "Write docs for:\n{previous.output}", "agent": "writer" }
] }
```

`agent` is optional (defaults to the first discovered agent). Add a `name` to label the run and unlock saving it as a command.

## Watch it run

This is not a mockup. **This is stdout from a real run** — the `self-improve` flow that writes and verifies its own test suites, caught mid-flight by a quality gate:

```
⊗ taskflow self-improve  6/7 · blocked · $0.095
    ✓ discover            agent   deepseek-v4-flash  10t ↑38k ↓6.7k $0.011
  ┌ ✓ write-runner-tests  agent   claude-sonnet-4-6  10t ↑13 ↓6.6k $0.020
  ├ ✓ write-store-tests   agent   claude-sonnet-4-6  10t ↑11 ↓10k $0.018
  ├ ✓ write-agents-tests  agent   claude-sonnet-4-6  10t ↑28 ↓13k $0.030
  └ ✓ fix-stability       agent   claude-sonnet-4-6  10t ↑13 ↓3.9k $0.012
    ✓ verify              gate    BLOCK 3 type errors in test files  deepseek-v4-flash
    ⊘ report              reduce  skipped · Gate blocked  ↳ fix-stability
```

**The layout *is* the DAG.** No dashboard, no logs to grep — you read the progress bar and you understand the whole pipeline:

- **Header** — `⊗` = blocked (a gate halted it); `6/7` phases processed; aggregate cost `$0.095`.
- **Status icons** — `✓` done · `◐` running · `✗` failed · `⊘` skipped · `○` pending.
- **Rail `┌ ├ └`** — phases in the same DAG layer, running concurrently. The four `write-*`/`fix-stability` tasks fan out from `discover`. A blank gutter = a single-phase layer.
- **`↳`** — a long, layer-skipping dependency. `report` depends on the adjacent `verify` *and* on `fix-stability` two layers back, so only that skip edge is annotated.
- **Gate** — `verify` emitted `VERDICT: BLOCK`, so the runtime skipped `report` and ended the run as `blocked`, surfacing the reason inline.
- **Detail** — per phase: model, token counts (`↑`in `↓`out), cost, timing. Fan-out phases also show sub-task progress (`3/15 2✗ 8▸`).

## Go declarative

The shorthand is your onramp. The DSL is where `pi-taskflow` earns its keep — dynamic fan-out, structured routing, and quality gates.

### Fan out and reduce

```jsonc
{
  "name": "summarize-files",
  "description": "Discover files, summarize each, produce one report",
  "args": { "dir": { "default": "." } },
  "concurrency": 8,
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout",
      "task": "List source files under {args.dir} (non-recursive).\nOutput ONLY a JSON array [{\"file\":\"\"}]. No prose.",
      "output": "json" },
    { "id": "summarize", "type": "map",
      "over": "{steps.discover.json}", "as": "item", "agent": "scout",
      "task": "Read {item.file} and give a one-sentence summary.",
      "dependsOn": ["discover"] },
    { "id": "report", "type": "reduce", "from": ["summarize"], "agent": "writer",
      "task": "Combine into a short overview:\n{steps.summarize.output}",
      "dependsOn": ["summarize"], "final": true }
  ]
}
```

1. **`discover`** lists every file and emits a JSON array.
2. **`summarize`** is a `map` — it fans out one subagent per file, throttled to 8 concurrent, with `{item.file}` bound to each path.
3. **`report`** is a `reduce` — it merges every summary into one clean overview.

The intermediate summaries never enter your context. The runtime owns them; you get the report. **Save it once → `/tf:summarize-files dir=src` forever.**

### Route, gate, retry, approve, and cap the spend

```jsonc
{
  "name": "triage-and-fix",
  "budget": { "maxUSD": 1.5 },
  "phases": [
    { "id": "triage", "type": "agent", "agent": "analyst", "output": "json",
      "task": "Classify the bug. Output ONLY {\"severity\":\"high\"} or {\"severity\":\"low\"}." },
    { "id": "deep",  "when": "{steps.triage.json.severity} == high", "dependsOn": ["triage"],
      "agent": "executor-code", "task": "Root-cause and patch it.",
      "retry": { "max": 2, "backoffMs": 500 } },
    { "id": "quick", "when": "{steps.triage.json.severity} == low",  "dependsOn": ["triage"],
      "agent": "executor-fast", "task": "Apply the quick fix." },
    { "id": "approve", "type": "approval", "join": "any", "dependsOn": ["deep", "quick"],
      "task": "Review the fix before it ships." },
    { "id": "ship", "type": "agent", "dependsOn": ["approve"],
      "task": "Open a PR with the change.", "final": true }
  ]
}
```

- **`when`** routes to `deep` *or* `quick` from the triage JSON — the other branch is skipped.
- **`join: "any"`** lets `approve` fire the moment whichever branch ran completes (an OR-join).
- **`retry`** re-runs a flaky patch with backoff; **`budget`** halts the whole run if it gets too expensive.
- **`approval`** pauses for a human (approve / reject / edit) before the final `ship`.

No scripting. No `eval`. Just data the runtime executes — safe enough to run LLM-generated definitions directly.

## Phase types

| type | what it does | required fields |
|------|--------------|-----------------|
| `agent` | one subagent runs a single task | `task` |
| `parallel` | run `branches[]` concurrently | `branches` (array of `{task, agent?}`) |
| `map` | **fan out** over an array — one subagent per item, `{item}` bound | `over`, `task` |
| `gate` | quality/review step that can **halt the flow** | `task` |
| `reduce` | aggregate `from[]` phase outputs into one | `from`, `task` |
| `approval` | **human-in-the-loop** pause — approve / reject / edit | — |
| `flow` | run a **saved sub-flow** as one phase (composition) | `use` |
| `loop` | **iterate a task until done** — re-run a body until a condition, convergence, or a cap | `task`, `until` |
| `tournament` | **N variants compete**, a judge picks the best (or aggregates) | `task` \| `branches` |

### Common phase fields

Every phase needs a unique `id` and a `type` (defaults to `agent`). On top of the per-type fields:

| Field | Meaning |
|---|---|
| `agent` | Agent to run (defaults to the first discovered agent) |
| `dependsOn` | Phase ids this phase waits for — builds the DAG |
| `join` | `"all"` (default) waits for every dep; `"any"` is an OR-join |
| `when` | Conditional guard — skip unless the expression is truthy |
| `retry` | `{ max, backoffMs?, factor? }` — retry a failing subagent |
| `output` | `"text"` (default) or `"json"` (exposes `{steps.ID.json}`) |
| `model` / `thinking` / `tools` | Per-phase overrides for the subagent |
| `cwd` | Working directory for the subagent |
| `concurrency` | Fan-out cap for `map` / `parallel` (overrides the flow default) |
| `final` | Marks the result-bearing phase (else the last phase wins) |
| `optional` | A failure here does **not** abort the run |
| `use` / `with` | (`flow`) saved sub-flow name + its args |
| `cache` | `{ scope, ttl?, fingerprint? }` — cross-run memoization (see below) |

Flow-level keys: `name`, `description`, `args`, `concurrency` (default 8), `agentScope`, and `budget: { maxUSD?, maxTokens? }`.

### Control flow & reliability

- **`when`** — skip a phase unless an expression is truthy. Supports `{refs}`, `== != < > <= >=`, `&& || !`, parentheses, and quoted strings/numbers. Pair with `join: "any"` on the merge phase for real if/else routing. Parse errors **fail open**.
- **`join: "any"`** — an OR-join: the phase runs as soon as *one* dependency completes (default `"all"` waits for all).
- **`retry`** — `{ "max": 2, "backoffMs": 500, "factor": 2 }` retries a failing subagent with fixed or exponential backoff; usage is summed and the attempt count shows as `↻N` in the TUI. Transient provider errors (rate-limit / 5xx / timeout) **auto-retry even without an explicit policy**; hard errors don't.
- **`approval`** — pause for a human (Approve / Reject / Edit). Reject halts the flow; Edit injects the typed note as the phase output for downstream steps. Non-interactive runs auto-approve.
- **`flow`** — `{ "type": "flow", "use": "deep-research", "with": { "topic": "{item}" } }` runs a saved flow as a phase (recursion is detected and rejected).

### Loop-until-done (`loop`)

Some work is inherently iterative — refine a draft until a reviewer is satisfied, retry-and-improve until tests pass, converge on an answer. A `loop` phase re-runs one task body until a stop condition holds:

```jsonc
{
  "id": "refine",
  "type": "loop",
  "task": "Improve this draft (iteration {loop.iteration}). Previous attempt:\n{loop.lastOutput}\n\nReturn JSON {\"draft\":\"…\",\"done\":true|false}.",
  "until": "{steps.refine.json.done} == true",   // the iteration's own output is exposed here
  "output": "json",
  "maxIterations": 6,        // default 10, hard cap 100 — the loop ALWAYS terminates
  "convergence": true        // default: stop early if an iteration's output is identical to the last
}
```

- **Body locals** — the task can read `{loop.iteration}` (1-based), `{loop.lastOutput}` (the prior iteration's output), and `{loop.maxIterations}` to build on its own previous work; all three are also available to the `until` condition.
- **`until`** — evaluated after each iteration with the iteration's output exposed as `{steps.<thisId>.output}` / `.json`. Same operators as `when`. The loop stops the moment it's truthy.
- **Always terminates.** Four independent stops: `until` truthy, **convergence** (a fixed point — output identical to the previous iteration), **`maxIterations`** (hard-capped at 100), or a **failing iteration** (the phase fails with the partial output preserved). A malformed `until` **stops** the loop rather than spinning forever (fail-safe) and surfaces a warning on the phase.
- The TUI shows `↻N` with the stop reason (`done` / `converged` / `max` / `failed`); usage is summed across iterations. Like `gate`/`approval`, `loop` is **excluded from `cross-run` cache** (each run must iterate fresh).

### Tournament (`tournament`)

For open-ended work, the best result often comes from generating several candidates and picking the strongest — best-of-N with a judge, in one declarative phase:

```jsonc
{
  "id": "headline",
  "type": "tournament",
  "task": "Write a punchy headline for this launch post.",
  "variants": 4,                    // spawn 4 competitors of the SAME task (default 3, max 20)
  "judge": "Pick the headline with the strongest hook and clearest promise.",
  "judgeAgent": "reviewer",          // optional; defaults to the phase agent
  "mode": "best"                     // "best" (default) | "aggregate"
}
```

- **Competitors** — either `variants: N` copies of one `task` (diversity comes from model nondeterminism), or distinct `branches: [{task, agent?}, …]` when you want to pit *different approaches* against each other.
- **Judge** — after the fan-out, one judge agent sees every variant (numbered) plus your `judge` rubric and picks a winner via a `WINNER: <n>` line or `{"winner": n}`. An unreadable verdict **fails open** to variant 1; a failed judge falls back too — the work is never lost.
- **`mode`** — `best` returns the winning variant **verbatim**; `aggregate` returns the judge's **synthesized** answer combining the strongest parts.
- **Short-circuits:** if only one competitor survives, it wins with no judge call; if all fail, the phase fails. The TUI shows `⚑ N→#k`; usage sums variants + judge. Like `gate`, it's **excluded from `cross-run` cache**.
- **`budget`** — a run-wide `{maxUSD, maxTokens}` ceiling; once exceeded, pending phases skip and in-flight fan-out stops spawning, ending the run as `blocked`.
- **idle watchdog** — a subagent that goes silent for 5 minutes is treated as wedged and killed (SIGTERM → SIGKILL), so one hung child can never freeze the whole flow.

### Cross-run memoization (`cache`)

Every phase is already content-addressed: within a single run's **resume**, a phase whose resolved inputs are unchanged is skipped. `cache` extends that reuse **across independent runs** — if any prior run computed a phase with an identical input hash, its result is reused for **$0.00**.

```jsonc
{
  "id": "analyze-auth",
  "task": "Summarize how the auth module works.",
  "context": ["src/auth/**/*.ts"],
  "cache": {
    "scope": "cross-run",                 // "run-only" (default) | "cross-run" | "off"
    "ttl": "6h",                          // optional max age before a hit is treated as a miss
    "fingerprint": ["git:HEAD", "glob:src/auth/**/*.ts"]  // fold world-state into the key
  }
}
```

- **`scope`** — `"run-only"` (default) is exactly the historical behavior (within-run resume only). `"cross-run"` opts the phase into the persistent store. `"off"` disables reuse entirely (even within a run), for debugging.
- **Freshness is the whole game.** The cache key already includes the prompt, the `over` items, and any `context` files (pre-read into the task). `fingerprint` folds *implicit* inputs into the key so "the world changed" becomes a cache miss: `git:HEAD`, `glob:<pat>` (size+mtime), `glob!:<pat>` (content hash), `file:<path>`, `env:<NAME>`. `ttl` (`30m`/`6h`/`7d`) is a time backstop.
- **Honest limit:** a subagent that reads a file it didn't declare in `context`/`fingerprint` can still serve a stale `cross-run` hit. That's why the default is `run-only` and why `gate`/`approval` phases are **forbidden** from `cross-run` (they must produce a fresh result each run). Opt in only for phases whose output is a function of declared inputs.
- Cache lives in `.pi/taskflows/cache/` (gitignored). Clear it with `action: "cache-clear"`. Full rationale: [`docs/rfc-cross-run-memoization.md`](./docs/rfc-cross-run-memoization.md).

### Gate phases (quality control)

A `gate` runs an agent to review upstream output and can **block the rest of the workflow.** End the gate task by asking for a verdict the runtime can read:

- a final line `VERDICT: PASS` or `VERDICT: BLOCK` (also accepts `OK`, `FAIL`, `STOP`, `REJECT`, `HALT` — last occurrence wins), or
- JSON like `{"continue": false, "reason": "missing auth checks"}` / `{"verdict": "block", "reason": "..."}`.

On **BLOCK**, downstream phases skip and the run ends as `blocked` with the reason surfaced. **Ambiguous output fails open** (treated as PASS) — a gate never halts your flow by accident.

```
Review the audit below. If any endpoint is missing auth, end with
"VERDICT: BLOCK" and a one-line reason; otherwise end with "VERDICT: PASS".

{steps.audit.output}
```

## Interpolation & expressions

| placeholder | resolves to |
|---|---|
| `{args.X}` | invocation argument |
| `{steps.ID.output}` | a prior phase's text output |
| `{steps.ID.json}` | prior output parsed as JSON (or `{steps.ID.json.field}`) |
| `{item}` / `{item.field}` | current item inside a `map` phase |
| `{previous.output}` | the immediately-upstream phase output |

Condition grammar (for `when`): `== != < > <= >=`, `&& || !`, parentheses, quoted strings/numbers, and any `{...}` reference — e.g. `"when": "{steps.triage.json.route} == deep && {args.force} != true"`.

> Referencing `{steps.X}` that isn't declared in `dependsOn` is a **hard validation error** — the runtime catches the most common pipeline bug before a single agent runs.

## Commands

Saved flows become CLI shortcuts. All commands run in the Pi session:

| Command | What it does |
|---|---|
| `/tf list` | List all saved flows |
| `/tf run <name> [args]` | Run a saved flow (e.g. `/tf run summarize-files dir=src`) |
| `/tf show <name>` | Print a flow's definition |
| `/tf runs` | Browse recent run history (interactive TUI) |
| `/tf resume <runId>` | Continue a paused/failed run — cached phases skip automatically |
| `/tf init` | **Interactively map model roles** to your enabled models (writes `~/.pi/agent/settings.json`) |
| `/tf:<name> [args]` | Shortcut — runs the flow in one tap |

Tool actions (used by the model): `run` (inline `define` or saved `name`), `save`, `resume`, `list`, `init`.

## Resume across sessions

A taskflow run isn't tied to your session. Every completed phase is written to disk, so a run that fails (or that you stop) can be continued later with `/tf resume <runId>` — **cached phases skip automatically** and only the remaining work spends tokens.

<div align="center">
<img src="./assets/resume.png" alt="A run fails midway in session 1; in session 2 /tf resume skips the cached phases and only re-runs the failed phase and what follows" width="900">
</div>

Resume is keyed on each phase's input hash — if an upstream output changed, dependent phases re-run; if nothing changed, they're reused. No competing Pi extension does this across sessions.

## Storage

```
.pi/taskflows/<name>.json          # project-scoped definitions (commit to share)
~/.pi/agent/taskflows/<name>.json  # user-scoped definitions
.pi/taskflows/runs/<runId>.json    # run state for resume (gitignore this)
```

> Commit `.pi/taskflows/` and your whole team shares the pipelines — no config sync, no onboarding doc. Run state is written atomically and guarded by a zero-dependency file lock, so concurrent runs never corrupt the index.

Agent discovery scope (via `agentScope` in the flow definition):

| value | discovers agents from |
|---|---|
| `"user"` (default) | `~/.pi/agent/agents/*.md` |
| `"project"` | `.pi/agents/*.md` (walks up the tree) |
| `"both"` | user + project; project wins on name collision |

## Agents

Taskflow ships **18 built-in agents** — each a `.md` file with a tuned system prompt, thinking level, and tool set. You can reference them by `name` in any phase or shorthand, right after install. No setup required.

### Built-in agent roster

| Agent | Role | Thinking | Default role |
|---|---|---:|---|
| `executor` | Implement planned code changes | high | `{{fast}}` |
| `executor-fast` | Trivial fixes (≤2 files, ≤50 lines) | off | `{{fast}}` |
| `executor-code` | Complex multi-file implementation | high | `{{strong}}` |
| `executor-ui` | Frontend / styling / visual changes | high | `{{vision}}` |
| `scout` | Fast codebase recon & file mapping | off | `{{fast}}` |
| `planner` | Implementation plan creation | high | `{{strong}}` |
| `analyst` | Requirements analysis, ambiguity detection | high | `{{thinker}}` |
| `critic` | Inline self-doubt during reasoning | xhigh | `{{thinker}}` |
| `reviewer` | General code / architecture review | high | `{{strong}}` |
| `risk-reviewer` | Backend / infra / DB / API risk | high | `{{reasoner}}` |
| `security-reviewer` | Security vulns, auth/crypto | xhigh | `{{reasoner}}` |
| `plan-arbiter` | Plan quality gate (complex tasks) | high | `{{arbiter}}` |
| `final-arbiter` | Tiebreaker when critics disagree | xhigh | `{{arbiter}}` |
| `test-engineer` | Design & implement tests | high | `{{fast}}` |
| `doc-writer` | Documentation authoring | off | `{{fast}}` |
| `recover` | Session recovery after compaction | low | `{{fast}}` |
| `verifier` | Run tests, validate outcomes | off | `{{fast}}` |
| `visual-explorer` | Figma design metadata analysis | high | `{{vision}}` |

Agents are layered: **built-in → user (`~/.pi/agent/agents/`) → project (`.pi/agents/`)**. A user or project agent with the same `name` overrides the built-in — so you can customize any agent without touching the package.

### Model roles

Each built-in agent's `model` field uses a **role placeholder** (e.g. `{{fast}}`) instead of a hardcoded provider string. This decouples *intent* from *implementation* — you map roles to models once, and every agent adapts.

| Role | Intent | Typical model |
|---|---|---|
| `{{fast}}` | Cheap & quick — high-volume, low-stakes | DeepSeek V4 Flash |
| `{{strong}}` | Balanced — planning, review, moderate complexity | MiMo v2.5 Pro |
| `{{thinker}}` | Deep analysis — requirements, critique | DeepSeek V4 Pro |
| `{{arbiter}}` | Final judgment — tiebreak, plan quality gates | Qwen 3.7 Max |
| `{{vision}}` | Multimodal — UI work, design reading | MiniMax M3 |
| `{{reasoner}}` | Cautious reasoning — security, risk | GLM 5.1 |

Without configuration, agents fall back to Pi's default model. To map roles to real models, run the interactive setup:

```bash
/tf init
```

`/tf init` starts with an **action menu**. First-time users get a 2-option shortcut ("Use recommended defaults" / "Configure each role"). Returning users see the full 5-option menu:

```
? What do you want to do with model roles?
  ❯ Use recommended defaults
    Configure each role
    Edit one role
    Show current roles
    Cancel
```

The picker shows model **display names** with capability flags and current/recommended markers:

```
? Model for 'vision' — Multimodal (executor-ui, visual-explorer)
  Current: openrouter/anthropic/claude-sonnet-4-6
  Recommended: minimax/MiniMax-M3
  ───────────────
  ❯ MiniMax M3 (minimax/MiniMax-M3) · image ✓ · reasoning ✓ · (recommended)
    Claude Sonnet 4.6 (openrouter/anthropic/...) · image ✓ · reasoning ✓ · (current)
    GPT-5 (openrouter/openai/gpt-5) · image ✓
    DeepSeek V4 Flash (openrouter/deepseek/v4-flash)
    ───────────────
    Custom (type your own)
    Keep current
    Back to action menu
```

Before saving, a **preview screen** shows the diff of your changes:

```
? Review changes:
  fast       openrouter/deepseek/deepseek-v4-flash   (unchanged)
  strong     openrouter/xiaomi/mimo-v2.5-pro         (unchanged)
  thinker    openrouter/qwen/qwen3.7-max             (changed ← was: openrouter/deepseek/v4-pro)
  arbiter    openrouter/qwen/qwen3.7-max             (unchanged)
  vision     minimax/MiniMax-M3                      (unchanged)
  reasoner   z-ai/glm-5.1                            (unchanged)
  ───────────────
  ❯ Save these changes
    Edit a role
    Cancel
```

Your choices are written to `~/.pi/agent/settings.json`:

```json
{
  "modelRoles": {
    "fast":     "openrouter/deepseek/deepseek-v4-flash",
    "strong":   "openrouter/xiaomi/mimo-v2.5-pro",
    "thinker":  "openrouter/deepseek/deepseek-v4-pro",
    "arbiter":  "openrouter/qwen/qwen3.7-max",
    "vision":   "minimax/MiniMax-M3",
    "reasoner": "z-ai/glm-5.1"
  }
}
```

Edit the values manually any time, or just re-run `/tf init`. You can also override individual agents via `subagents.agentOverrides` in the same file:

```json
{
  "modelRoles": { ... },
  "subagents": {
    "agentOverrides": {
      "executor": { "model": "anthropic/claude-sonnet-4-20250514" },
      "reviewer": { "thinking": "xhigh" }
    }
  }
}
```

### Tool path (`action="init"`)

The model can also configure roles via the `taskflow` tool:

| Mode | Behavior |
|---|---|
| `mode: "show"` (default) | Read-only report of current `modelRoles`. Never overwrites. |
| `mode: "apply-defaults"` + `force: true` | Writes `RECOMMENDED_DEFAULTS` to `settings.json`, preserving stale keys. |
| `mode: "interactive"` | Launches the full action menu + picker flow (requires a UI session). |

> **v0.0.13 deprecation note:** If `mode` is omitted, the tool falls back to v0.0.12 behavior when `modelRoles` is empty (auto-writes defaults) with a `console.warn` deprecation notice. If `modelRoles` already exists, it behaves as `mode: "show"`. This bridge will be removed in v0.0.14.

### Custom agents

Drop a `.md` file into `~/.pi/agent/agents/` (user-level) or `.pi/agents/` (project-level, commit it) to add your own:

```markdown
---
name: my-linter

description: Run ESLint and report violations

tools: read, bash

model: "{{fast}}"

thinking: off
---

You are a linting agent. Run `npx eslint --format json` on the
provided files. Report violations grouped by file. No fixes.
```

Then reference it in any phase: `{ "agent": "my-linter", "task": "Lint src/" }`.

## Examples

Ready-to-read definitions in [`examples/`](./examples):

| File | Demonstrates |
|---|---|
| [`summarize-files.json`](./examples/summarize-files.json) | discover → `map` fan-out → `reduce` |
| [`conditional-research.json`](./examples/conditional-research.json) | `when` routing + `join: any` + `gate` + `budget` |
| [`guarded-refactor.json`](./examples/guarded-refactor.json) | `approval` (human-in-the-loop) + `retry` + `gate` |

Copy one into `.pi/taskflows/<name>.json` (or `~/.pi/agent/taskflows/`) and it registers as `/tf:<name>` — or just point the model at it.

## What's inside

<div align="center">

**0 runtime dependencies** · **394 tests** · **10 phase types** · **cross-session resume** · **cross-run memoization** · **~4.9k LOC runtime**

</div>

- **Zero runtime dependencies.** No `dependencies` field — the runtime is built entirely on Node built-ins (`fs` / `path` / `os` / `child_process` / `crypto`). The file lock is `fs.openSync("wx")`, not a third-party library.
- **371 tests across 14 suites** covering concurrency, atomic file locking (8-process race regressions), path-traversal hardening, cross-session resume, cross-run cache freshness (flow/thinking/tools key isolation, fingerprint invalidation, TTL/LRU eviction), gate verdicts, budget caps, retry/backoff, approval flows, loop termination, tournament judging, sub-flow composition, callback isolation, the idle watchdog, model-role init config, and parseModelFromLabel with parenthesized-model-name regression — plus a live end-to-end test that spawns real subagents and a cross-run cache dogfood.
- **Hardened by design.** Path-traversal defense (lexical + `realpath`), runId validation, HTML/error sanitization, atomic writes, stale-lock stealing via `rename`, and an idle watchdog that kills wedged subagents.
- **Dogfooded.** Every new feature has to survive the project's own `self-improve` taskflow before it ships.

## 🍽️ We eat our own dog food

Every feature in `pi-taskflow` ships **through `pi-taskflow`.**

Our `self-improve` flow is a 10-phase DAG — it audits the codebase, patches defects, verifies correctness, gates on quality, and surfaces the report — all declaratively. It's saved as `/tf:self-improve` and run before every release. No other agent orchestrator in the Pi ecosystem builds itself with itself.

| Campaign | Scale | Phases | Outcome |
|----------|-------|--------|---------|
| [v0.0.8 dogfood](./docs/dogfooding-v0.0.8-report.md) | Full codebase audit → triage → fix → verify | 10 phases, 234 tests | 13 fixes, all pass |
| [v0.0.6 self-audit](./docs/self-audit-report.md) | inventory → map audit → gate → approval → map fix → reduce | 9 phases | 11 critical defects fixed |
| [Cross-run cache dogfood](./docs/rfc-cross-run-memoization.md) | Real runtime + on-disk store | Dedicated test harness | Cache correctness under adversarial fingerprints |
| [Adversarial cross-review](./docs/brainstorm-adversarial-review-report.md) | Multi-agent adversarial review | `tournament` + `gate` | P0 cache-key fix shipped |
| [Init redesign review](./docs/issue-necessity-review-report.md) | Necessity audit → parallel checks → verdict | 7 phases | Full redesign plan validated |

> **Meta:** we used `pi-taskflow`'s `map` fan-out, `gate` verdicts, `approval` human-in-the-loop, `tournament` best-of-N, `loop` until-done, and `cross-run` cache — to build `pi-taskflow`.

## Status & limits

**v0.0.13** — loop-until-done (`loop` phase: iterate to a condition, convergence, or cap), tournament (best-of-N with a judge), cross-run memoization (content-addressed cache with git/file/glob/env fingerprints and TTL), interactive `/tf init` with role-aware model pickers + diff preview + atomic merge-write, 18 built-in agents with 6 model roles. Full control-flow & reliability layer (`when` guards, `join: any`, `retry`/backoff, `approval`, `flow` composition, `budget` caps, idle watchdog) on top of the DSL + DAG runtime (`agent`/`parallel`/`map`/`gate`/`reduce`). Inline + saved flows, cross-session resume, live progress, and isolated context. A run executes as one streaming tool call.

Known boundaries (tracked, bounded — no surprises mid-flow):

- **No detached background execution.** A run needs the Pi session open. True background execution (and event/cron triggers on top of it) is on the roadmap.
- **No `output: "file"`.** Outputs are text/JSON only — write files via an agent's `write` tool call.
- **`map` requires a JSON array.** The `over` field must resolve to a `{steps.ID.json}` array. Wrap a text list in a single-agent `output: "json"` phase first.
- **The DAG must be acyclic.** Cycles are rejected at validation.

## Development

```bash
npm install
npm run typecheck
npm test            # unit tests — no network, no process spawning
npm run test:e2e    # real end-to-end (spawns live subagents; needs model access)
```

Runtime lives in `extensions/`, tests in `test/`, runnable examples in `examples/`, and the full design rationale in [`DESIGN.md`](./DESIGN.md).

## Contributing

Contributions welcome — this is a young, fast-moving project. Open an issue or PR on [GitHub](https://github.com/heggria/pi-taskflow). Good first contributions: new example flows, phase-type ideas, and TUI polish.

## License

MIT
