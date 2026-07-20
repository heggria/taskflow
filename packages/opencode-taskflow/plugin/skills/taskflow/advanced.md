<!-- GENERATED FILE — do not edit. Source: skills-src/taskflow/advanced.md (npm run build:skills) -->

# Taskflow Advanced — dynamic sub-flows & workspace isolation

Load this when a flow needs: runtime-generated work (`flow{def}` / `expand`) or
isolated working directories (`cwd: temp/dedicated/worktree`).

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
because the current 0.2.x runtime cannot restore filesystem mutations on a cache hit. Generated
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

---

## Trace & offline replay (`trace` / `replay`) — vs resume / recompute

Three **different** reuse tools; do not conflate them:

| Tool | Spends tokens? | Mutates the run? | Answers |
|------|----------------|------------------|---------|
| **`resume`** | Only unfinished / cache-miss phases | **Forks a new run** (parent untouched; child carries `parentRunId`) | "Pick up where we stopped" |
| **`why-stale` → `recompute`** | Dry-run free; `--apply` / `dryRun:false` spends | Optional write of recompute result | "World/input changed — which phases re-run?" |
| **`trace` → `replay`** | **Never** | Never | "If the gate threshold / budget had been different, would we have blocked?" |

### Trace (read the evidence)

Every instrumented run may write an append-only **event log**
(`runs/<flow>/<runId>.trace.jsonl`): phase lifecycle, each subagent
input/output, and runtime **decisions** (gate verdict/score, when-guard,
cache-hit, budget-hit, tournament-winner, unreplayable).

```
taskflow_trace { runId: "<id>" }
taskflow_trace { runId: "<id>", json: true }
```

MCP trace responses are bounded. JSON mode returns an envelope with
`total`/`returned`/`truncated`; use `limit` (default 200, max 1000) to select the
newest events without flooding the host context.

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

```
taskflow_replay { runId: "<id>", thresholds: { review: 0.9 } }
taskflow_replay { runId: "<id>", budgetMaxUSD: 0.05, json: true }
```

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

---

## Resume overrides (re-run one phase with a patch)

`taskflow_resume` accepts a `failed` or `paused` run and **forks a new
run** — the original run file is never
modified (the child carries `parentRunId`). To re-run exactly one phase with a
patched task/model/timeout/idleTimeout, pass override fields alongside
`phaseId`:

```
taskflow_resume { runId: "<id>", phaseId: "audit",
                  task: "re-audit src/api with the new checklist",
                  model: "gpt-5" }
```

The overrides apply to the child's def only; the parent is untouched. Without
overrides, ordinary resume re-runs the non-done phases.

---

## Pluggable verifiers — zero-token custom static checks

Beyond the built-in structural detectors (dead-ends, unreachable, gate-exhaustion,
budget-overflow, concurrency, ref-integrity, guard-contradictions, contracts),
Taskflow supports **pluggable verifiers**: pure functions that lint a flow's
declarations at compile time, before any model is spawned.

### Built-in: script-lint

`compileTaskflow` auto-includes the **script-lint** verifier (opt out with
`lint: false`). It catches common shell mistakes in `script` phase `run`
commands:

- `grep` pattern starting with `-` without a `--` separator (exit 2, false RED)
- Unbalanced `[` or `(` in `grep`/`sed` regex (exit 2)
- Pipeline ending with a filter (`grep`/`awk`/`head`/`tail`/`wc`/`sort`)
  without `set -o pipefail` or `PIPESTATUS` (failing upstream masked)

### Custom verifiers (convention dir)

Drop a `.ts`/`.js`/`.mjs` file in `.pi/taskflows/verifiers/` (project) or
`~/.pi/taskflows/verifiers/` (user). Export a `TaskflowVerifier`:

```ts
export default {
  name: "my-check",
  verify(flow) {
    // flow.phases, flow.budget, flow.name are available.
    // Return VerifierIssue[]: { phaseId?, message, severity: "error"|"warning" }.
    return [];
  },
};
```

Project-scope verifiers shadow user-scope by `name`. Broken modules are
skipped with a warning (fail-open). Use `taskflow_lint` (MCP) or
`verifyTaskflow(flow, { verifiers })` (programmatic) to run them.

### MCP: `taskflow_lint`

```
taskflow_lint { "defineFile": "/tmp/flow.json" }
```

Runs built-in + discovered verifiers. Plugin issues are stamped
`category: "plugin"` with `source: <verifier-name>`. Structural issues
are covered by `taskflow_verify`; `taskflow_lint` reports only plugin findings.

---

## `taskflow_version` — build/host identity

`taskflow_version` reports the engine package version, the git commit the dist
was built from, the run-state schema version, and the bound host
(`codex`/`claude`/`opencode`/`grok`). The git commit is stamped at build time —
`git` is never run at runtime.
```
taskflow_version {}
```
