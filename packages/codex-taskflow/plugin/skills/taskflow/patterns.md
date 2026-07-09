<!-- GENERATED FILE — do not edit. Source: skills-src/taskflow/patterns.md (npm run build:skills) -->

# Taskflow Patterns — proven archetypes & the production checklist

Read this when designing a flow with ≥ 4 phases, a gate, or any fan-out.
Each archetype below is a complete, runnable shape distilled from real runs.
Copy the closest one and adapt — don't design from a blank page.

---

## The production-flow checklist

Before running a flow you designed, check it against this list. Every item is
cheap to add and each one has prevented a real failure class:

- [ ] **`verify` first.** Run the static verifier (pi: `action: "verify"` /
      Codex / Claude Code / OpenCode: `taskflow_verify`) — zero tokens,
      catches cycles / missing deps / ref typos / contract mismatches.
- [ ] **Every JSON-emitting phase has `expect` + `retry`.** "Output ONLY JSON"
      in the task text is a request; `expect` is enforcement. Without it, a
      malformed router output silently skips both branches.
- [ ] **Machine checks before LLM checks.** `script` phases for build/test
      ground truth; gate `eval` assertions before the gate's LLM `task`. A
      token spent verifying what a shell command can verify is a wasted token.
- [ ] **`budget` on any flow with a fan-out.** A map over a mis-discovered
      500-item array is unbounded spend without one.
- [ ] **`optional: true` + a fallback for degradable phases.** An enrichment
      phase that times out shouldn't sink the run — pair `timeout` +
      `optional` with a downstream `when`-guarded fallback.
- [ ] **Exactly one `final: true`** on the result-bearing phase.
- [ ] **`strictInterpolation: true` on any flow you save.** Saved flows run
      later with args you're not watching; unresolved placeholders must be
      errors, not empty strings.
- [ ] **Discovery phases are cheap and sandboxed.** `agent: "scout"`,
      `tools: ["read","grep","ls"]`, low thinking. Don't pay executor prices
      for `ls`.
- [ ] **The reviewer is not the producer.** A gate reviewing phase X uses a
      different agent (ideally a different model) than X. Self-review passes
      ~everything.
- [ ] **Re-runnable flows are `incremental: true`** with `fingerprint` entries
      on phases that read the world (`git:HEAD`, `glob!:src/**/*.ts`). See
      `advanced.md`.

---

## Archetype 1: Audit fan-out (discover → map → gate → reduce)

The workhorse. Use for: audit every endpoint / migrate every file /
summarize every module.

```jsonc
{
  "name": "audit-endpoints",
  "strictInterpolation": true,
  "budget": { "maxUSD": 3.00 },
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout",
      "tools": ["read", "grep", "ls"],
      "task": "List every HTTP endpoint under src/routes. Output ONLY a JSON array [{\"route\":\"...\",\"file\":\"...\"}]. No prose.",
      "output": "json",
      "expect": { "type": "array", "items": { "type": "object", "required": ["route", "file"] } },
      "retry": { "max": 2, "backoffMs": 0 } },

    { "id": "audit", "type": "map", "over": "{steps.discover.json}", "as": "item",
      "agent": "analyst", "concurrency": 4,
      "task": "Audit {item.route} in {item.file} for missing auth. Report: SEVERITY (high/med/low/none), evidence (file:line), fix.",
      "dependsOn": ["discover"] },

    { "id": "screen", "type": "gate", "agent": "reviewer",
      "task": "Cross-check the findings below. Delete false positives (cite why). If ANY confirmed HIGH remains, end with VERDICT: BLOCK and list them; else VERDICT: PASS.\n\n{steps.audit.output}",
      "dependsOn": ["audit"] },

    { "id": "report", "type": "reduce", "from": ["screen"], "agent": "doc-writer",
      "task": "Write a prioritized remediation report from:\n{steps.screen.output}",
      "dependsOn": ["screen"], "final": true }
  ]
}
```

Why each piece: `expect`+`retry` on discover means a chatty scout gets a second
chance instead of feeding garbage to the map; `concurrency: 4` protects rate
limits; the gate is a *different* agent than the auditor; `budget` bounds the
fan-out.

**Variant — per-item caching for repeated audits:** add
`"cache": { "scope": "cross-run" }` to the map phase. On the next run, only
items whose task text changed re-execute; the rest are $0 cache hits.
(Details: `configuration.md` §8.)

---

## Archetype 2: Self-healing implement→verify→rework

Use for: implement against acceptance criteria, fix-until-green.
The gate re-runs its upstream on BLOCK — a generate→critique→regenerate loop
without you writing a loop.

```jsonc
{
  "name": "implement-verified",
  "budget": { "maxUSD": 5.00 },
  "phases": [
    { "id": "implement", "type": "agent", "agent": "executor-code",
      "task": "Implement the feature per the spec in docs/spec.md. Run nothing; just edit." },

    { "id": "build-test", "type": "script",
      "run": "npx tsc --noEmit && pnpm test 2>&1 | tail -20",
      "timeout": 180000, "dependsOn": ["implement"] },

    { "id": "spec-gate", "type": "gate", "agent": "reviewer",
      "onBlock": "retry", "retry": { "max": 3 },
      "eval": ["{steps.build-test.output} contains pass"],
      "task": "Build/test output:\n{steps.build-test.output}\n\nDoes the implementation satisfy ALL acceptance criteria in docs/spec.md? VERDICT: PASS, or VERDICT: BLOCK with a precise list of what to fix.",
      "dependsOn": ["implement", "build-test"] },

    { "id": "summary", "type": "agent", "agent": "doc-writer",
      "task": "Summarize what was implemented and the verification result:\n{steps.spec-gate.output}",
      "dependsOn": ["spec-gate"], "final": true }
  ]
}
```

Key mechanics: on BLOCK, `spec-gate` re-runs **both** its `dependsOn` upstreams
(`implement` gets the blocker's reasons via re-interpolation, `build-test`
re-verifies), up to 3 rounds. The `eval` line means a green build+test skips
the LLM review entirely on the happy path.

**Verification phases: force structured output.** LLMs are bad at
*summarizing* shell output (234 tests read as 230) but good at *copying*
structured data. If a verification step must go through an agent (not a
`script`), demand `key=value` lines:

```
Report EXACTLY in this format (one key=value per line, no prose):
typecheck=PASS|FAIL
tests_total=N
tests_fail=N
If any field is missing, you failed the task — re-run and re-read.
```

Prefer a `script` phase whenever the check is a command — exact, free, fast.

---

## Archetype 3: Plan → human approval → execute

Use for: anything expensive or destructive where a human should see the plan
before the spend. The approval's **Edit** option injects mid-run guidance.

> **MCP-host caveat (Codex / Claude Code / OpenCode):** approval phases auto-reject in
> MCP-driven (non-interactive) runs. This archetype only works when a human
> runs the flow interactively; for tool-driven runs, replace the approval with
> a strict `gate`.

```jsonc
{
  "name": "guarded-migration",
  "phases": [
    { "id": "plan", "type": "agent", "agent": "planner",
      "task": "Plan the migration of src/legacy/* to the new API. List each file, the change, and the risk." },

    { "id": "checkpoint", "type": "approval",
      "task": "Migration plan:\n\n{steps.plan.output}\n\nApprove to execute, reject to abort, or edit to add constraints.",
      "dependsOn": ["plan"] },

    { "id": "execute", "type": "agent", "agent": "executor-code",
      "task": "Execute the migration plan:\n{steps.plan.output}\n\nOperator guidance (if any): {steps.checkpoint.output}",
      "dependsOn": ["checkpoint"] },

    { "id": "verify", "type": "script", "run": "npx tsc --noEmit && pnpm test 2>&1 | tail -5",
      "timeout": 180000, "dependsOn": ["execute"], "final": true }
  ]
}
```

Note `{steps.checkpoint.output}` — on Edit it carries the operator's note; on
Approve it's `(approve)`. Don't use approval in detached/headless runs (it
auto-rejects there — by design).

---

## Archetype 4: Dynamic plan → execute (`flow{def}`)

Use when the *work itself* must be discovered at runtime — the planner emits a
whole sub-flow as JSON and the runtime validates + runs it. The declarative
answer to "loop over whatever we find".

```jsonc
{
  "name": "dynamic-audit",
  "budget": { "maxUSD": 4.00 },
  "phases": [
    { "id": "plan", "type": "agent", "agent": "planner", "output": "json",
      "task": "Scan this repo. Output ONLY a JSON taskflow {\"name\":\"sub\",\"phases\":[...]} with one 'agent' phase per module that needs auditing (agent: \"analyst\"), plus a final 'reduce' phase (agent: \"doc-writer\", from: [all audit ids], final: true). Use hyphens in ids. No script phases, no cwd fields.",
      "expect": { "type": "object", "required": ["name", "phases"] },
      "retry": { "max": 2, "backoffMs": 0 } },

    { "id": "run-plan", "type": "flow", "def": "{steps.plan.json}",
      "optional": true, "dependsOn": ["plan"] },

    { "id": "deliver", "type": "agent", "agent": "doc-writer",
      "task": "Final result (empty means the plan failed validation — say so):\n{steps.run-plan.output}",
      "dependsOn": ["run-plan"], "final": true }
  ]
}
```

Critical details (full contract in `advanced.md`): a bad plan **fails open**
(`defError` diagnostic, empty output downstream) — `optional: true` + the
`deliver` phase turn that into a graceful report instead of a dead run. The
planner prompt must forbid what validation will reject anyway (`script`
phases, workspace `cwd` keywords) so the plan doesn't waste a retry.

**Iterative replanning:** wrap a plan-emitting body in a `loop` so round N's
plan reacts to round N−1's result — see `examples/iterative-replan.json`.

---

## Archetype 5: Tournament for one-shot-unreliable work

Use when quality varies run-to-run (naming, copywriting, tricky refactor
strategy, root-cause hypotheses). Branches > variants when you want genuinely
different *approaches* judged against each other.

```jsonc
{
  "id": "strategy", "type": "tournament", "mode": "best",
  "judgeAgent": "final-arbiter",
  "judge": "Judge on: correctness under concurrent access, blast radius, migration cost. Quote evidence. Return JSON {\"winner\": <n>, \"reason\": \"...\"}.",
  "branches": [
    { "task": "Design the cache-invalidation fix with a conservative approach: minimal diff, no schema change.", "agent": "analyst" },
    { "task": "Design the fix assuming we can change the schema: optimal correctness.", "agent": "analyst" },
    { "task": "Design the fix as an adversary: what will break each obvious approach? Then propose the one that survives.", "agent": "critic" }
  ],
  "dependsOn": ["context"], "final": true
}
```

Give the judge a **rubric with named criteria**, a stronger model
(`judgeAgent`), and a structured winner output (`{"winner": <n>}` JSON,
or an exact `WINNER: <n>` terminator). `mode: "aggregate"`
instead merges all variants — good for research synthesis, bad for decisions.

---

## Archetype 7: Race for latency (first approach wins)

When several strategies can answer the same question and you care about **time
to first good answer** more than comparing quality, use `race` (not
`tournament`). Branches start together; the first successful completion becomes
the phase output.

```jsonc
{
  "name": "quick-answer",
  "budget": { "maxUSD": 0.5 },
  "phases": [
    {
      "id": "answer", "type": "race",
      "branches": [
        { "task": "Answer from local heuristics only: {args.q}", "agent": "executor" },
        { "task": "Answer after a short web/docs look: {args.q}", "agent": "researcher" }
      ],
      "final": true
    }
  ]
}
```

**Prefer tournament when** you need a judge to pick the *best* draft after all
variants finish. **Prefer parallel when** you need *every* branch's output
downstream (then `reduce`).

## Archetype 8: Expand graft (planner fragment on the parent DAG)

Planner emits a fragment; `expand` with `expandMode: "graft"` runs it and
promotes child phase states as `<expandId>-<childId>` so a later phase can read
them. Use `nested` (or classic `flow{def}`) when you only need the fragment's
**final** output and do not want child ids on the parent.

```jsonc
{
  "name": "plan-graft",
  "phases": [
    {
      "id": "plan", "type": "agent", "agent": "planner", "output": "json",
      "task": "Emit a mini-flow JSON: {name, phases:[{id,type,agent,task,final?}…]} for the audit.",
      "expect": { "type": "object", "required": ["phases"] }
    },
    {
      "id": "grow", "type": "expand", "expandMode": "graft",
      "def": "{steps.plan.json}", "dependsOn": ["plan"]
    },
    {
      "id": "wrap", "type": "agent", "agent": "writer",
      "task": "Summarize grafted work. Child outputs may appear as steps.grow-* in the run state.",
      "dependsOn": ["grow"], "final": true
    }
  ]
}
```

## Archetype 6: Incremental repo-watch audit (cross-run)

Use for flows you'll re-run as the repo evolves. First run pays full price;
subsequent runs re-pay only for what changed.

```jsonc
{
  "name": "security-sweep",
  "incremental": true,
  "budget": { "maxUSD": 3.00 },
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout", "output": "json",
      "task": "List all files handling user input. Output ONLY a JSON array of paths.",
      "expect": { "type": "array" },
      "cache": { "scope": "cross-run", "fingerprint": ["glob!:src/**/*.ts"] } },
    { "id": "audit", "type": "map", "over": "{steps.discover.json}",
      "agent": "security-reviewer", "task": "Audit {item} for injection/authz issues.",
      "cache": { "scope": "cross-run" },
      "dependsOn": ["discover"] },
    { "id": "report", "type": "reduce", "from": ["audit"], "agent": "doc-writer",
      "task": "Prioritized findings report:\n{steps.audit.output}",
      "dependsOn": ["audit"], "final": true }
  ]
}
```

The `glob!:` fingerprint makes `discover` a cache miss only when file
*contents* change; the map's per-item cache means one changed file re-audits
one item.

---

## Anti-patterns (seen in real flows)

| Anti-pattern | Why it fails | Fix |
|--------------|--------------|-----|
| One mega-phase doing discover+audit+report | No parallelism, no caching granularity, one failure loses everything | Split along the archetype-1 shape |
| Gate whose task doesn't demand a `VERDICT:` terminator | Ambiguous model output fails closed → gate blocks on a model that forgot the verdict | Use `output:"json"` + `expect` enum (preferred), or end the task with the exact `VERDICT: PASS\|BLOCK` instruction (auto-appended if you omit it) |
| Router phase without `expect` enum | `"Deep"` vs `"deep"` → both `when` branches skip, `join:"any"` reduce gets nothing | `expect: { properties: { route: { enum: [...] } } }` + `retry` |
| Agent phase that just runs a shell command | Tokens spent, output paraphrased inaccurately | `script` phase |
| Same agent produces and reviews | Self-review passes everything | Different agent (ideally model) for the gate |
| Fan-out with no `budget` and no `concurrency` cap | Unbounded spend + rate-limit storms | `budget` + `phase.concurrency` |
| `dependsOn` declared but output never referenced | The downstream agent doesn't see the upstream's work — dependency ≠ data flow | Interpolate `{steps.X.output}` into the task (or `context`) |
| Saving a flow without `strictInterpolation` | Later invocations with wrong args silently run on empty strings | `strictInterpolation: true` before saving |
| `map` over `{steps.X.output}` (text, not json) | `over` must resolve to an array | `output: "json"` upstream + `over: "{steps.X.json}"` |
| Deep `chain` where steps don't need each other's output | Serialized latency for no reason | `tasks` (parallel) or a DAG with real edges only |
