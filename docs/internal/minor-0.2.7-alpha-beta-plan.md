# Minor release plan — 包 α + 包 β

> **Status:** Planning / not started  
> **Date:** 2026-08-06  
> **Working title:** **0.2.7 — Plan before spend · Close the loop after**  
> **Branch policy:** implement on a branch cut from **`main` (v0.2.6)**; **do not** ship half-finished `feat/0.3.0` control-plane as this minor.  
> **Non-goals for this cut:** event-kernel default-ON, control-plane GA, Web Console, cloud workers, auto-tune, OTel, phase fallback/cascade (包 γ).

---

## 0. One-line product sentence

> **Spend 之前：零 token 看清图、参数、成本上界与将跑谁。Spend 之后：挂起能醒、跑完能喊、历史能看、重算能报数字。**

| 包 | 主题 | 用户可感知结果 |
|----|------|----------------|
| **α 跑前可信** | Preflight + Budget 上界 + 增量省钱 UX | `plan` 一屏；recompute/show 带 reused/rerun/saved |
| **β 跑完闭环** | Webhooks + Approval timeout + Analytics 只读 + Templates | background 有出口；approval 不永挂；`/tf analytics`；示例模板 |

---

## 1. Scope matrix (MUST / SHOULD / WONT)

### MUST (ship blockers)

| ID | Feature | Size | Primary surface |
|----|---------|------|-----------------|
| **A1** | Preflight dry-run (`plan`) | M | core + MCP + pi `/tf` + cli |
| **A2** | Budget upper-bound (phase-count; optional cost if hints) | S–M | core `verify` / plan payload |
| **A3** | Incremental savings summary (visible numbers) | S | recompute / run terminal / MCP render |
| **B1** | Notifications (`hooks` / onComplete·onFail·onBlocked) | M | core + detached/background path |
| **B2** | Approval `timeoutMs` + `onExpire` | S–M | schema + runtime + resume |
| **B3** | Analytics read-only (`analytics`) | S | store aggregate + MCP/pi |
| **B4** | Template library (4–6 flows) | S | `examples/` + skills mention |

### SHOULD (same release if capacity)

| ID | Feature | Note |
|----|---------|------|
| A2b | `costHint` / model rate table (optional) | without it, budget proof stays **phase-count only** |
| B1b | `hooks.onBlocked` for approval/gate pause | same dispatch path as complete/fail |
| B3b | JSON output for analytics | machines first |

### WONT (explicit)

- Auto-tuning from analytics  
- Kernel default ON / full expect+cache kernel parity  
- ControlHost-only hooks (0.2 path must work without daemon)  
- Transcript or full phase output in webhook payloads  
- Flow versioning / graph diff / NL scaffold  
- Phase-level model fallback (包 γ)

---

## 2. Feature specs

### A1 — Preflight dry-run (`plan`)

**Problem:** Interpolation / missing args / wrong refs blow up mid-run after tokens spent.  
`verify` / `lint` already exist but do **not** bind invocation args or project a run plan.

**API (core):**

```ts
// packages/taskflow-core/src/preflight.ts (new)
export interface PreflightOptions {
  args?: Record<string, unknown>;
  /** When true, missing required typed args → error. Default true. */
  strictArgs?: boolean;
}

export interface PreflightPhasePlan {
  id: string;
  type: string;
  /** topo order index among phases that may run under static when=true assumption */
  order: number;
  when?: "always" | "static-true" | "static-false" | "dynamic";
  /** bindings resolved from args; dynamic refs left symbolic */
  bindings: Array<{ path: string; status: "bound" | "unresolved" | "dynamic"; value?: string }>;
  agent?: string;
  modelHint?: string;
  notes?: string[];
}

export interface PreflightBudgetBound {
  /** max agent-call count under static worst-case (loops use maxIterations, maps mark unbounded if over is dynamic) */
  maxAgentCalls: number | "unbounded";
  maxMapFanout?: number | "unbounded";
  phasesCounted: number;
  /** only if cost hints present */
  maxUSD?: number | "unbounded";
  maxTokens?: number | "unbounded";
  assumptions: string[];
}

export interface PreflightResult {
  ok: boolean; // false only on errors (missing required args, invalid flow)
  issues: VerificationIssue[]; // includes verify+lint category + preflight category
  phases: PreflightPhasePlan[];
  budget: PreflightBudgetBound;
  /** human one-screen summary */
  summary: string;
}
```

**Rules:**

1. Reuse `validateTaskflow` → `desugar` → `verifyTaskflow` → discover verifiers (`lint` path).  
2. Resolve **typed args** the same way run does (required/default/enum). Fail closed on missing required.  
3. Walk phase templates with a **shared** path against `interpolate.ts` collectors (`collectRefs` / existing static helpers) — **no forked semantics**.  
4. Static `when` that can be evaluated with only `args` → mark skip/run; anything depending on `{steps.*}` → `dynamic`.  
5. **Zero tokens, zero process spawn.** Pure + local FS only if needed for typed `relative-path` existence (match run bind rules).  
6. Do **not** claim cache hits (unknown without prior run); optional later: “if prior run X, recompute frontier would be…” as SHOULD.

**Surfaces:**

| Host | Shape |
|------|--------|
| MCP | `taskflow_plan` (new tool #18) — `name` \| `define` \| `defineFile` + `args` + optional `json` |
| Pi | `action=plan` + `/tf plan <name\|file> [--args …] [--json]` |
| CLI | `taskflow plan …` if cli already mirrors tools; else document MCP/pi only |

**Acceptance:**

- [ ] Missing required typed arg → `ok:false`, no agent spawn in tests  
- [ ] Unresolved `{args.x}` with no default → error; `{steps.y.output}` → listed `dynamic`, not error  
- [ ] Same flow: `verify` issues appear inside plan issues (no drift)  
- [ ] Golden fixture: linear chain + map + loop + when-guard

---

### A2 — Budget upper-bound (phase / call count)

**Problem:** `detectBudgetOverflow` exists for declared `budget` caps vs topology, but users cannot see **worst-case agent calls** before run.

**Algorithm (deterministic):**

| Construct | Bound |
|-----------|--------|
| `agent` / `gate` / `reduce` / `script` | 1 call (script = 0 LLM) |
| `parallel` / `tournament` | sum of branch bounds |
| `map` | if `over` is literal array or resolvable from args → `len × body`; else **`unbounded`** + assumption string |
| `loop` | `maxIterations × body` (default max from schema) |
| `race` | sum (worst-case all start) or max+1 — **document as sum** (conservative) |
| `flow` / `expand` | recurse into child def if inline; saved-use → “unknown child” assumption or load saved once |
| `when: static-false` | 0 |

**Output:** fold into `PreflightResult.budget` and a verify **warning** category (new: `"budget-bound"`) when `budget.maxTokens`/`maxUSD` declared but bound is `unbounded`.

**Non-goal:** accurate dollar without rate table. Optional `flow.costHints` / env table is SHOULD.

**Acceptance:**

- [ ] loop maxIterations=3 body 2 agents → maxAgentCalls ≥ 6  
- [ ] map over dynamic `{steps.x.json}` → unbounded + assumption  
- [ ] unit tests pure, no I/O

---

### A3 — Incremental savings summary (visible numbers)

**Problem:** `RecomputeReport` already has `rerun` / `reused` / `cutoff` / `decisions`; MCP/pi formatters under-sell the flagship number. Terminal run completion also does not say how many phases were cache hits.

**Deliverable:**

1. **Shared formatter** (core):  
   `formatSavingsLine(report | runStats) →`  
   `reused 5 · rerun 2 · cutoff 1 · est. saved ~71% phases`  
   Optional: sum `usage` from reused phases vs would-be full (only when usage present).

2. **Wire into:**  
   - `formatRecompute` / `formatRecomputeMcp` first line  
   - Run terminal summary (foreground + background wait) when any phase `status` indicates cache hit / skip  
   - `taskflow_show` run path / pi `/tf show` if easy

3. **Run-level stats** (minimal): on `RuntimeResult`, optional:

```ts
{
  phaseCounts: { completed: n, failed: n, skipped: n, cached: n },
  // cached = cross-run or within-run cache hits if already tracked
}
```

If cache hit counters are hard, ship **recompute path first** (MUST), run-path counters SHOULD.

**Acceptance:**

- [ ] dry-run recompute MCP text starts with reused/rerun counts  
- [ ] applied recompute includes cutoff in the same line  
- [ ] no transcript leakage

---

### B1 — Notifications / hooks

**DSL (flow-level, optional):**

```jsonc
{
  "name": "audit-api",
  "hooks": {
    "onComplete": [
      { "type": "webhook", "url": "https://example.com/hook", "timeoutMs": 5000 },
      { "type": "file", "path": ".taskflow/hooks/last-complete.json" },
      { "type": "command", "run": ["notify-send", "taskflow", "{runId} {status}"] }
    ],
    "onFail": [ /* same shape */ ],
    "onBlocked": [ /* approval / gate block pause */ ]
  },
  "phases": [ /* ... */ ]
}
```

**Payload (JSON, summary only):**

```jsonc
{
  "schema": "taskflow.hook.v1",
  "event": "complete" | "fail" | "blocked",
  "runId": "...",
  "flowName": "...",
  "status": "completed" | "failed" | "paused" | "blocked",
  "host": "codex" | "pi" | ...,
  "packageVersion": "...",
  "startedAt": "...",
  "endedAt": "...",
  "phaseCounts": { "total": 8, "completed": 7, "failed": 1 },
  "usage": { "inputTokens": 0, "outputTokens": 0, "totalCost": 0 },
  "outputSourcePhaseId": "...",
  "errorSummary": "…truncated…",   // fail only, max ~500 chars
  "approvalPhaseId": "…"      // blocked only
}
```

**Invariants:**

1. **Never** include phase outputs, transcripts, tool logs, or peek bodies.  
2. Default **fire-and-forget**: hook failure logs to trace (`hook-dispatch` / warning) and **does not** change run status.  
3. `command` argv only — **no shell string**; reject `run: "curl …"` strings at validate.  
4. Webhook: POST JSON, bounded timeout (default 5s), no redirect follow to private IP if easy (best-effort SSRF note in docs).  
5. Dispatch points: imperative runtime terminal + detached-runner + background MCP worker — **one helper** `dispatchHooks(event, state)`.  
6. Hooks field enters FlowIR / definition hash (changing hooks invalidates identity; good).

**Validation:**

- `url` must be `https:` (or `http://127.0.0.1` for local dev — document)  
- `file.path` project-relative, no `..` escape  
- max N hooks per event (e.g. 5)

**Acceptance:**

- [ ] background completed → file hook written with schema v1  
- [ ] webhook mock server receives payload without `finalOutput` body  
- [ ] throwing hook does not flip completed → failed  
- [ ] command with shell metacharacters rejected at validate

---

### B2 — Approval timeout + onExpire

**DSL:**

```jsonc
{
  "id": "human-gate",
  "type": "approval",
  "dependsOn": ["draft"],
  "timeoutMs": 86400000,
  "onExpire": "reject"
  // onExpire: "reject" | "approve" | "fail"
  // default when timeoutMs set: "reject"
  // no timeoutMs → infinite wait (current behavior, unchanged)
}
```

**Semantics:**

| `onExpire` | Effect |
|------------|--------|
| `reject` | phase fails / run blocked-or-failed per existing reject path; downstream `when` can branch |
| `approve` | treat as approved empty edit (dangerous — require explicit; document) |
| `fail` | phase `failed` with `error: "approval-expired"` |

**Implementation sketch:**

1. When approval pauses, persist `approvalExpiresAt = startedAt + timeoutMs` on phase state.  
2. Watchers:  
   - Pi TUI already interactive — timer on next poll / command  
   - MCP background / detached: poll path or idle tick checks expiry  
   - `taskflow_runs status|wait` must surface expired decision  
3. Expiry is **idempotent**: first writer wins; concurrent approve loses with clear error.  
4. Trace decision: `approval-expired`.

**Acceptance:**

- [ ] timeoutMs=50 in test with fake clock → reject path without human  
- [ ] human approve before expiry wins  
- [ ] no timeoutMs → no auto decision (compat)  
- [ ] expired run resume rules documented (new run vs resume)

---

### B3 — Analytics (read-only)

**API:**

```ts
// packages/taskflow-core/src/analytics.ts
export interface FlowAnalytics {
  flowName: string;
  window: { last: number; from?: string; to?: string };
  runs: number;
  statusHistogram: Record<string, number>;
  p50DurationMs?: number;
  p95DurationMs?: number;
  totalCostUSD?: number;
  perPhase: Array<{
    phaseId: string;
    runs: number;
    failRate: number;
    p50DurationMs?: number;
    cacheHitRate?: number; // if attributable
  }>;
}
```

**Source:** project run index + light load of run files (cap last N, default 20, max 100).  
**No writes, no auto-tune, no SQLite.**

**Surfaces:** `/tf analytics <flow> [--last 20] [--json]` · MCP `taskflow_analytics`.

**Acceptance:**

- [ ] empty history → friendly empty  
- [ ] synthetic runs produce correct failRate  
- [ ] never loads full transcripts into host message (aggregate only)

---

### B4 — Template library

Ship under `examples/templates/` (or promote existing):

| Name | Pattern |
|------|---------|
| `audit-map-reduce.json` | map audit → reduce → gate |
| `adversarial-review.json` | parallel reviewers → tournament/reduce |
| `guarded-refactor.json` | already exists — polish + docs link |
| `quality-pipeline.json` | already exists |
| `background-with-hooks.json` | script/agent + hooks file + approval timeout demo |
| `plan-first.json` | documents plan → run habit |

Skills/README: “copy from examples/templates”. No new phase types.

---

## 3. MCP / tool roster impact

| Tool | Action |
|------|--------|
| `taskflow_plan` | **ADD** |
| `taskflow_analytics` | **ADD** |
| existing | render savings on recompute / runs wait |
| count | 17 → **19** (sync marketplace, skills, tests) |

Pi `action` enum and `/tf` subs mirrored.

---

## 4. Implementation order (dependency DAG)

```text
A2 (budget bound pure) ──┐
                         ├──► A1 preflight plan ──► MCP/pi surfaces
verify/lint reuse ───────┘

A3 savings formatter ──► recompute + run terminal

B2 approval timeout ──► (independent)

B1 hooks helper ──► runtime terminal + detached + background

B3 analytics ──► (independent, after store list APIs)

B4 templates ──► last (uses hooks + approval examples)
```

**Suggested PR slices:**

1. `feat(core): preflight plan + budget bound`  
2. `feat(mcp): taskflow_plan + savings line on recompute`  
3. `feat(core): approval timeout onExpire`  
4. `feat(core): flow hooks dispatch (file/webhook/command)`  
5. `feat(mcp): taskflow_analytics + templates + docs/changelog`

---

## 5. Testing plan

| Layer | Coverage |
|-------|----------|
| Unit | preflight pure fixtures; budget bound; hook payload redaction; approval expiry; analytics aggregate |
| Integration | detached complete → file hook; background wait text includes savings when recompute; MCP tool roster 19 |
| Contract | schema reject shell command hooks; https-only webhook |
| Manual dogfood | plan on `examples/quality-pipeline.json`; background + file hook; approval short timeout |

---

## 6. Docs / skills / CHANGELOG

- CHANGELOG under `## [0.2.7] — Unreleased` (or chosen tag)  
- skills-src: plan + analytics + hooks + approval timeout; `pnpm run build:skills`  
- README “What's new” blurb: **Plan before spend · Close the loop after**  
- Host MCP guides: tool table +1/+1  

---

## 7. Version & branch decision

| Option | When |
|--------|------|
| **0.2.7** from main | Recommended: user-facing DX while 0.3 hardens |
| **0.3.1** after 0.3.0 GA | Only if hooks must be ControlHost-native only (we explicitly avoid that) |

**Workspace note:** today control packages already say `0.3.0` while core is `0.2.4`/`0.2.6` tags — this minor **only bumps packages it touches** (core, mcp-core, hosts delivery, pi, skills). Do not declare control GA.

---

## 8. Effort (order-of-magnitude)

| Slice | Eng days |
|-------|----------|
| A1+A2 preflight+budget | 2–3 |
| A3 savings UX | 0.5–1 |
| B2 approval timeout | 1–1.5 |
| B1 hooks | 2–3 |
| B3 analytics | 1 |
| B4 templates + docs/skills | 0.5–1 |
| **Total** | **~7–10 eng-days** |

One focused engineer ~1.5–2 weeks; two can parallelize (A\* ∥ B2/B3).

---

## 9. Success metrics (release gate)

1. **Plan:** `taskflow_plan` on a broken-args flow fails with zero runner calls (assert mock runner never invoked).  
2. **Savings:** recompute dry-run output matches `/reused \d+.*rerun \d+/`.  
3. **Hook:** file artifact exists after background complete; payload parses as `taskflow.hook.v1` without output fields.  
4. **Approval:** unit clock test expires without hang.  
5. **Analytics:** last-N on fixture store returns stable histogram.  
6. **Roster:** all host adapter tests expect 19 tools.  
7. **No 0.3 dependency:** full suite green without `TASKFLOW_CONTROL_PLANE=1`.

---

## 10. Product decisions (locked 2026-08-06)

| # | Question | Decision |
|---|----------|----------|
| 1 | Version tag | **0.2.7** from `main` |
| 2 | Webhook localhost | **Allow** `https:` and `http://127.0.0.1` / `http://localhost` (other `http:` rejected) |
| 3 | `onExpire: "approve"` | **Open** — full enum `reject` \| `fail` \| `approve`; docs warn approve is footgun |
| 4 | Shell CLI `taskflow plan` | **Out of 0.2.7 MUST** — see §10.1 |

### 10.1 What “加 taskflow plan” meant

Three **different** entry points, easy to confuse:

| Entry | Who uses it | Exists today? | 0.2.7 plan surface |
|-------|-------------|-----------------|---------------------|
| **MCP tool** `taskflow_plan` | Codex / Claude / OpenCode / Grok via MCP | tools are `taskflow_*` roster | **MUST** — new tool |
| **Pi** `action=plan` + `/tf plan` | Pi extension users | `/tf verify` etc. already | **MUST** |
| **Shell CLI** `taskflow plan …` | bare terminal / CI without a coding host | `taskflow-cli` today is **control-plane only**: `run\|status\|wait\|cancel\|version` (0.3 daemon path) | **WONT this cut** |

So “加 taskflow plan” was asking: *besides* MCP + Pi, do we also teach the **`taskflow` npm bin** a pure offline `plan` subcommand?

**Locked for 0.2.7:** implement **MCP + Pi only**.  
Reasons: (1) preflight is pure engine work and belongs next to `verify`/`lint` on host surfaces users already use; (2) current `taskflow-cli` is ControlHost-oriented and mixed offline plan would blur 0.2 vs 0.3 stories; (3) CI can still call plan later via a thin script or a future offline cli slice.

**Optional follow-up (not blocking 0.2.7):** `taskflow plan` offline on cli *without* bootstrapping control — only if dogfood demands headless no-host.

### 10.2 Spec deltas from decisions

**Webhook URL validation:**

- Allow: `https://…`, `http://127.0.0.1…`, `http://localhost…` (and `[::1]` if we parse IPv6 loopback)
- Reject: other `http://`, non-http(s) schemes, credentials-in-URL if cheap to ban

**Approval onExpire:**

```jsonc
"onExpire": "reject" | "fail" | "approve"  // required when timeoutMs set; default "reject"
```

`approve` = same path as human empty approve (document: auto-continue without review).

---

## 11. Next action

Decisions locked → implement slice 1 (`preflight.ts` + tests) on branch `feat/0.2.7-plan-and-close-loop` from `main`.
