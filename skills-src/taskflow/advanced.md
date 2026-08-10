<!-- host:pi -->
# Taskflow Advanced — context sharing, dynamic sub-flows, isolation, incremental recompute

Load this when a flow needs: cross-phase knowledge sharing (`shareContext`),
runtime-generated work (`flow{def}` / `ctx_spawn`), isolated working
directories, or surgical re-execution after the world changes
(`ir` / `provenance` / `why-stale` / `recompute`).
<!-- /host:pi -->
<!-- host:codex,claude,opencode,grok -->
# Taskflow Advanced — dynamic sub-flows & workspace isolation

Load this when a flow needs: runtime-generated work (`flow{def}` / `expand`) or
isolated working directories (`cwd: temp/dedicated/worktree`).
<!-- /host:codex,claude,opencode,grok -->

---

## `flow{def}` vs `expand` (when to use which)

| Need | Prefer |
|------|--------|
| Saved reusable flow by name | `flow` + `use` |
| Planner JSON as isolated nested sub-flow (classic) | `flow` + `def` **or** `expand` + `expandMode: "nested"` |
| Fragment phases must appear on the **parent** run as `<expandId>-<childId>` | `expand` + `expandMode: "graft"` |
| First of several static approaches (latency) | `race` (not tournament) |

`expand` is a first-class phase type (Horizon B). Dynamic validation / nesting /
breadth caps match `flow{def}`. **Event kernel** still excludes `race`/`expand`
(imperative path only until step handlers exist).

---

<!-- host:pi -->
## Shared Context Tree (blackboard + supervision) — opt-in

> **0.2.0 host scope:** context-tool injection is implemented by `pi-taskflow`.
> Codex, Claude, OpenCode, and Grok runners do not expose `ctx_*` tools yet.

By default subagents are fully isolated: they share nothing and only return a
final output string. Opt a phase in with `shareContext: true` (or
`contextSharing: true` at the flow level for every phase) to give its subagent
four extra tools backed by a per-run, file-based blackboard:

| tool | direction | use |
|------|-----------|-----|
| `ctx_write(key, value)` | horizontal | publish a finding so siblings/descendants can reuse it (avoid re-reading the same files) |
| `ctx_read(key?)` | horizontal | read findings visible to this node: its own + ancestors' + **completed** other nodes' (omit `key` to list all) |
| `ctx_report(summary, structured?)` | vertical ↑ | report a result upward to the parent |
| `ctx_spawn(assignments[])` | vertical ↓ | delegate child tasks; after this node finishes the runtime runs each child (isolated) and **folds their reports into this phase's output**. Each assignment is either a flat `{task, agent?}` OR a `{subflow, defaultAgent?}` — an inline plan `{phases:[...]}` the runtime validates and runs as a nested sub-flow |

Visibility is eventually-consistent: a sibling's findings become visible once
that sibling **completes** (a running sibling's half-written blackboard is
hidden). Own findings beat ancestors' beat completed-others' on key conflicts.

**When to use:** fan-out items share expensive context (one map item maps the
repo, the rest read its findings), or a task should discover work at runtime
and delegate it (`ctx_spawn`) rather than the author pre-declaring every branch.

```jsonc
{ "id": "survey", "type": "agent", "agent": "scout", "shareContext": true,
  "task": "Map the API surface. ctx_write key 'endpoints' with the JSON list so the auditors don't re-scan." },
{ "id": "audit", "type": "map", "over": "{steps.survey.json}", "shareContext": true,
  "dependsOn": ["survey"], "agent": "analyst",
  "task": "ctx_read 'endpoints' for shared context, then audit {item} for missing auth." }
```

**Spawning a sub-graph (not just flat tasks).** A `ctx_spawn` assignment can be
a whole inline plan — use `subflow` when the delegated work has multiple
coordinated steps with dependencies:

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

The subflow is validated (cycles / dangling refs / dead-ends) before it runs; a
bad plan fails **open** (a diagnostic is folded into the report, the run
continues). `agent` (flat task) = who executes; `defaultAgent` (subflow) =
fallback for inner phases. Nesting is bounded: spawn-subflows and `flow{def}`
share one depth counter capped at 5.

**Guards & limits:** ids used with sharing must match `[A-Za-z0-9._-]+`; keys
are `[A-Za-z0-9._-]` (≤128 chars); values ≤256 KB; ≤256 keys/node; `ctx_spawn`
≤16 tasks/call, task ≤64 KB, depth ≤5. All bookkeeping is fail-open (it can
never sink a phase); the per-run blackboard is cleaned up with the run.

You do **not** need to teach the tools in your `task` text — enabling
`shareContext` auto-appends usage guidance to the subagent's system prompt.
Mentioning a specific key in the task ("ctx_write the endpoint list under
'endpoints'") just makes the cross-phase contract explicit.

**Producer tip (learned from real runs):** the phase that *publishes* shared
context should be a **capable** agent (high thinking), and the `ctx_write`
should be framed as its **primary deliverable** ("if you did not call ctx_write
you failed the task"). A fast / `thinking: off` agent asked to "survey AND
ctx_write" will often do the survey and skip the write. Consumers can be
lighter — reading is a single reliable step.

**Caching interaction:** `shareContext: true` disables per-item map caching
(a sharing item can read sibling writes outside its declared deps, so the
per-item key would under-approximate real reads). The whole-map cache path
still applies.

---
<!-- /host:pi -->

## Dynamic sub-flows (`flow{def}`) — the full contract

A `flow` phase with `def` resolves a sub-flow **at runtime**, usually from an
upstream phase's JSON output. The runtime interpolates + JSON-parses the `def`,
validates it, then runs it nested. This is how a planner decides at runtime
what work to spawn — with each generated plan checked before it spends a token.

```jsonc
{ "id": "plan", "type": "agent", "agent": "planner", "output": "json",
  "task": "Scan the repo. Output ONLY JSON {\"name\":\"audit\",\"phases\":[...]} — one audit phase per file." },
{ "id": "run", "type": "flow", "def": "{steps.plan.json}", "optional": true,
  "dependsOn": ["plan"], "final": true }
```

**LLM output contract for `def`** (put this in the planner's task):
- A *full* Taskflow `{"name":"...","phases":[...]}`, a bare `phases` array, or
  `{"phases":[...]}` — pure JSON (a ```json fence is tolerated and stripped).
- Hyphens in ids, never underscores.
- Sub-flow phases reference each other in their **own** `{steps.x.output}`
  namespace (no parent-id prefixing).
- An **empty** `phases` array is a valid no-op (the planner decided there's
  nothing to do).

**Security caps on generated flows** (validation rejects; tell the planner not
to emit these so a retry isn't wasted):
- **No `script` phases** — shell execution from an LLM-authored plan is an RCE
  vector; only author-written flows may use `script`.
- **No workspace `cwd` keywords** (`temp`/`dedicated`/`worktree`) and no `cwd`
  escaping the run directory.
- Breadth caps: ≤100 phases, concurrency ≤16 (flow and per-phase).
- Depth: inline nesting capped at 5 (shared with `ctx_spawn` subflows).

**Fail-open semantics:** if the `def` doesn't parse, has the wrong shape, or
fails validation, the phase completes with `status: "done"` and a `defError`
diagnostic field; downstream phases receive empty output and the run continues.
Design for it:
- Add `optional: true` on the flow phase so a bad plan never aborts the run.
- Want a hard stop instead? Add a downstream gate:
  `{ "type": "gate", "eval": ["{steps.run.output} != "], "task": "…VERDICT: BLOCK if the plan failed." }`

**Iterative replanning** — pair `flow{def}` with a `loop` whose body emits the
next plan from the previous round's result: the declarative equivalent of
`for (...) { read result; decide next }`. See `examples/dynamic-plan-execute.json`
and `examples/iterative-replan.json`.

---

## Workspace isolation (`cwd` keywords)

A phase's `cwd` is normally a literal path (or inherited from the run). Three
**reserved keywords** ask the runtime to allocate an isolated working directory
for the phase's subagent and tear it down afterwards — scratch work or file
mutation without touching the main tree:

| `cwd` value | what the runtime does | lifecycle |
|-------------|-----------------------|-----------|
| `"temp"` | ephemeral dir under the OS tmpdir | removed when the phase finishes |
| `"dedicated"` | persistent dir under the run state (`runs/ws/<runId>/<phaseId>`) | **kept** for inspection; deterministic per phase (resume reuses it) |
| `"worktree"` | `git worktree add` on a throwaway branch off `HEAD` | `git worktree remove` + branch delete when the phase finishes |

```jsonc
{ "id": "experiment", "type": "agent", "agent": "executor", "cwd": "worktree",
  "task": "Try the risky refactor and run the tests. Your edits are isolated in a git worktree." }
```

- **Fail-open.** If allocation fails (e.g. `worktree` outside a git tree), the
  phase degrades — `worktree`→`temp`, any other failure → the base cwd — with a
  `warnings` diagnostic. A phase never fails to run because of isolation.
- **Security.** Keywords are honoured only in **author-written** flows; a
  generated plan (`flow{def}` / `ctx_spawn` subflow) requesting one is rejected
  at validation.
- A literal path passes through unchanged.

### Argument-selected cwd (0.2.1 compatibility bridge)

An author-written flow may set `cwd: "{args.package}"` only when `package` is
declared as `{ "type": "relative-path" }`. The placeholder must occupy the
whole field. The value is resolved below the invocation cwd, must be an existing
directory, and cannot escape through `..`, absolute paths, or symlinks at bind time.

The bridge is fail-closed and disabled unless the host operator explicitly sets
`TASKFLOW_CWD_BRIDGE_MODE=resolve-only`. That mode performs a time-of-check path
validation but has no no-follow filesystem handle and is not an OS filesystem sandbox; each phase emits a warning stating the lower
guarantee. Cwd-bridge flow trees do not reuse output-only cache/resume entries,
because 0.2.1 cannot restore filesystem mutations on a cache hit. Generated
sub-flows cannot use the bridge. Saved-flow definitions are frozen for one
top-level execution, the invocation root identity is persisted for resume, and
a selected sub-flow inherits a non-expanding canonical boundary: nested literal
cwd and context files may narrow it but cannot escape it or allocate a workspace
provider.

Do not combine this bridge with `retry.max > 0`; validation rejects that
combination. After a failed writer, the filesystem outcome is unknown and an
operator must explicitly reconcile the invocation workspace before another
write can start.

**Pattern — competing experiments in worktrees:** run two `parallel` branches,
each `cwd: "worktree"`, each attempting a different refactor strategy and
reporting its test results; a downstream gate/judge picks which diff to apply
for real. The main tree is never touched by the losers.

<!-- host:pi -->
---

## Incremental recompute suite (`ir` / `provenance` / `why-stale` / `recompute`)

Taskflow's cheapest superpower: after the world changes, re-pay for **only the
affected phases** of a stored run instead of re-running the flow.

Two complementary planes:

| Plane | Mechanism | Answers |
|-------|-----------|---------|
| **Declared** | `dependsOn` ∪ `{steps.X}` refs in the definition | "what *could* depend on what" |
| **Observed** | read-sets recorded at runtime (which upstream outputs a phase actually consumed) | "what *did* depend on what" |

`why-stale` and `recompute` use the **union** (observed ∪ declared) so the
frontier is sound even for runs made before observation existed.

### The workflow

```
1. taskflow { action: "ir", name: "security-sweep" }
     → FlowIR: canonical form + a content hash per phase.
       Diff two versions of a flow; confirm an edit actually changed a
       phase's fingerprint (identical hash ⇒ cache-hit eligible).

2. taskflow { action: "provenance", runId: "<id>" }
     → the run's observed read-sets: who actually read what.

3. taskflow { action: "why-stale", runId: "<id>", phaseId: "discover" }
     → the transitive stale frontier if 'discover' is assumed changed —
       exactly which phases would re-run and the edge that makes each stale.
       Omit phaseId to print the whole observed dependency graph.

4. taskflow { action: "recompute", runId: "<id>", phaseId: "discover" }
     → DRY-RUN by default: reports what would re-execute, zero tokens.

5. taskflow { action: "recompute", runId: "<id>", phaseId: "discover", "dryRun": false }
     → actually re-runs the seed + stale frontier, reuses every non-stale
       phase's stored output, persists the updated run.
       An aborted recompute never overwrites the original run.
```

CLI equivalents: `/tf ir <name>` · `/tf provenance <runId>` ·
`/tf why-stale <runId> [phaseId]` · `/tf recompute <runId> <phaseId> [--apply]`.

### When to reach for which reuse mechanism

| Situation | Mechanism |
|-----------|-----------|
| Run crashed / gate blocked / budget hit — inputs unchanged | `action: "resume"` (within-run cache) |
| The flow will be re-run repeatedly as the repo evolves | `incremental: true` + `cache.fingerprint` (cross-run cache — `configuration.md` §8) |
| One phase of a completed run is now wrong/stale (a file changed, you edited one task) | `why-stale` → `recompute` (surgical, keeps the same run) |
| The definition changed structurally | fresh `run` (compare `ir` hashes to see what changed) |
| Cache serving stale results you can't explain | `provenance` to see real reads; `cache-clear` as the last resort |

### Worked example

A 12-phase nightly audit run completed yesterday. Today `src/auth/session.ts`
changed. Instead of re-running all 12 phases:

```
/tf why-stale run-xyz discover
  → Stale frontier (transitive, 4 phases):
    ■ discover        (changed — seed)
    ■ audit           ← reads discover
    ■ screen          ← reads audit
    ■ report          ← reads screen (declared)
/tf recompute run-xyz discover --apply
  → re-runs 4 phases, reuses 8, persists the updated run.
```

The other 8 phases (dependency summary, license scan, …) are served from the
stored run at $0.
<!-- /host:pi -->

---

## Trace & offline replay (`trace` / `replay`) — vs resume / recompute

Three **different** reuse tools; do not conflate them:

| Tool | Spends tokens? | Mutates the run? | Answers |
|------|----------------|------------------|---------|
| **`resume`** | Only unfinished / cache-miss phases | Continues the same run | "Pick up where we stopped" |
| **`why-stale` → `recompute`** | Dry-run free; `--apply` / `dryRun:false` spends | Optional write of recompute result | "World/input changed — which phases re-run?" |
| **`trace` → `replay`** | **Never** | Never | "If the gate threshold / budget had been different, would we have blocked?" |

### Trace (read the evidence)

Every instrumented run may write an append-only **event log**
(`runs/<flow>/<runId>.trace.jsonl`): phase lifecycle, each subagent
input/output, and runtime **decisions** (gate verdict/score, when-guard,
cache-hit, budget-hit, tournament-winner, unreplayable).

<!-- host:pi -->
```
taskflow { action: "trace", runId: "<id>" }
taskflow { action: "trace", runId: "<id>", json: true }   // full machine record
/tf trace <runId> [--json]
```
<!-- /host:pi -->
<!-- host:codex,claude,opencode,grok -->
```
taskflow_trace { runId: "<id>" }
taskflow_trace { runId: "<id>", json: true }
```

MCP trace responses are bounded. JSON mode returns an envelope with
`total`/`returned`/`truncated`; use `limit` (default 200, max 1000) to select the
newest events without flooding the host context.
<!-- /host:codex,claude,opencode,grok -->

If there is no log (pre-trace run, or no sink injected), the tool reports that
clearly — it never invents events.

### Offline replay (what-if, zero tokens)

`replay` **re-folds** the recorded log under alternate **decision knobs** without
calling any model:

- `thresholds` — map of `phaseId → new score threshold` (gate-score events)
- `budgetMaxUSD` / `budgetMaxTokens` — would later phases have been skipped?
- `models` / `args` — currently report `needs-live-rerun` (quality cannot be
  re-judged offline without re-execution)

Outcomes per phase: `reused`, `would-block`, `verdict-flipped`,
`would-exceed-budget`, `threshold-changed`, `needs-live-rerun`, `failed`.

<!-- host:pi -->
```
taskflow { action: "replay", runId: "<id>", thresholds: { review: 0.9 } }
taskflow { action: "replay", runId: "<id>", budgetMaxUSD: 0.05, json: true }
/tf replay <runId> --threshold review=0.9 --budget-usd 0.05 [--json]
```
<!-- /host:pi -->
<!-- host:codex,claude,opencode,grok -->
```
taskflow_replay { runId: "<id>", thresholds: { review: 0.9 } }
taskflow_replay { runId: "<id>", budgetMaxUSD: 0.05, json: true }
```
<!-- /host:codex,claude,opencode,grok -->

**Import-graph guarantee:** `replayRun` never imports the process-spawning
runtime or event kernel — offline replay cannot accidentally spend tokens.

### When to use which

| Situation | Use |
|-----------|-----|
| Rate-limit mid-run; inputs unchanged | `resume` |
| Repo file changed; re-pay only affected phases | `why-stale` → `recompute` |
| "Would a stricter gate have blocked last night's run?" | `trace` → `replay` with new `thresholds` |
| "Would a $0.10 cap have stopped the fan-out?" | `replay` with `budgetMaxUSD` |
| Need fresh model judgment under a new model id | `replay` will say `needs-live-rerun` → live `recompute`/`run` |

<!-- host:pi -->
---

## `init` — model roles setup

`action: "init"` manages the `modelRoles` map (`{{fast}}` / `{{strong}}` / …
placeholders in agent frontmatter → real model ids):

- `mode: "show"` (default) — read-only report of current roles.
- `mode: "apply-defaults"` — writes recommended defaults; **requires
  `force: true`** (destructive: overwrites `modelRoles` in settings.json).
- `mode: "interactive"` — requires a UI session (`/tf init` is the human path).

If phases fail with `Model metadata for {{fast}} not found`, roles are
unconfigured — run `/tf init`.
<!-- /host:pi -->
