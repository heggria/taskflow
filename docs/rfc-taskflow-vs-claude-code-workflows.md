# RFC: taskflow vs Claude Code (2026-07) — capability gap & what to build next

> Status: research notes, 2026-07-07. Source: Claude Code official docs
> (`code.claude.com/docs/en/*`, fetched 2026-07-07) + taskflow source.
> Purpose: decide which features close the gap and push taskflow ahead of
> Claude Code's just-shipped **Dynamic Workflows** (GA 2026-07-03, PR-era
> research preview May 2026).

---

## 0. TL;DR

Claude Code shipped **Dynamic Workflows** — its first feature that shares
taskflow's core thesis ("move the plan into code; only the final answer reaches
the conversation"). The overlap is real and large. **But taskflow still leads on
orchestration depth** (10 phase types + DAG + cross-run caching + multi-host),
while **Claude Code leads on two things taskflow lacks**:

1. **Zero-author orchestration** — Claude *writes* the workflow script for you
   (`ultracode` / "use a workflow"). taskflow forces the LLM/user to hand-author
   the JSON DSL every time.
2. **A lifecycle hook system** — ~30 events (PreToolUse, SubagentStart, Stop,
   TaskCompleted, TeammateIdle, WorktreeCreate, PreCompact …) that users wire
   shell/HTTP/LLM handlers into. taskflow has only an internal `onProgress`.

The single highest-leverage feature to "fully surpass" is **#1: a
zero-author / auto-compose mode** — let the host LLM describe a task and have
taskflow draft the DSL, verify it (zero tokens), and run it. This neutralizes
Claude Code's biggest UX moat while keeping taskflow's deeper engine.

---

## 1. Claude Code's multi-agent surface (4 primitives)

Claude Code now offers **four** ways to run multi-step work. The official
"who holds the plan?" matrix:

| Primitive | Plan lives in | Scale | Comms | Repeatable |
|---|---|---|---|---|
| **Subagents** | Claude's context (turn-by-turn) | a few / turn | report back only | worker *definition* |
| **Skills** | Claude's context (follows prompt) | a few / turn | — | the *instructions* |
| **Agent Teams** *(experimental)* | a **lead agent** supervising peers | handful of long-running peers | **peers message each other** + shared task list | the *team definition* |
| **Dynamic Workflows** | a **script the runtime executes** | **dozens→1000 agents/run** | via script variables | **the orchestration itself** |

### 1a. Dynamic Workflows (the direct competitor — GA v2.1.154+)

- A workflow = a **JavaScript script** Claude writes. Runtime executes it in the
  background; session stays responsive.
- Two primitives: `agent(prompt, {schema, label})` (spawn one) and
  `pipeline(items, fn)` (one agent per item — **this is `map`**).
- Top-level `await`; intermediate results live in **script variables**, not
  Claude's context. Only the final return value reaches the conversation.
- **Resume**: stopped runs resume within the same session; completed agents
  return cached results. *(Does NOT survive session exit — fresh on next session.)*
- **`args` global** for saved-workflow input. Saved as `.claude/workflows/<n>.js`
  → becomes a `/<name>` slash command (project-shared or `~/.claude` personal).
- **Adversarial patterns built into examples**: independent agents review each
  other's findings, vote on claims, draft a plan from several angles and weigh
  them. (Bundled `/deep-research` fans out web search → cross-check → vote →
  cited report; unverified claims filtered.)
- **Limits**: 16 concurrent agents, **1000 agents/run** hard cap, no mid-run user
  input (only permission prompts can pause), no direct fs/shell from the script
  itself (agents do all I/O).
- **Size guideline** (`/config`): small (<5) / medium (<15) / large (<50) /
  unrestricted — advice sent to Claude.
- **ultracode** effort mode: xhigh reasoning + auto-workflow for *every*
  substantive task ("understand → change → verify" can chain several workflows).
- **Permission gating** per-run: View raw script / Yes / Always / No; Ctrl+G to
  edit; subagents always run `acceptEdits` + inherit tool allowlist.

### 1b. Agent Teams (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`)

- Multiple **full Claude Code instances** as teammates; one is the **lead**.
- Each teammate = own context window, fully independent.
- **Teammates message each other directly** (vs subagents which only report to
  caller). Shared **task list** with self-coordination (assign/claim tasks).
- Quality gates enforced via **hooks**. Competing-hypotheses / parallel-review
  / cross-layer (frontend/backend/tests) ownership patterns.
- *Known weak spots (CC admits):* session resumption, task coordination,
  shutdown behavior, orphaned tmux sessions.

### 1c. Subagents (worker primitive)

- Single session, own context window, custom system prompt + tool subset +
  independent permissions. Returns summary to caller.
- Built-ins: **Explore** (read-only, capped at Opus), **Plan** (plan-mode
  research), **General-purpose**. Custom ones via `.claude/agents/*.md`.
- Model routing per subagent (cost control). Delegation decided by Claude from
  each subagent's `description`.

### 1d. Hooks (~30 lifecycle events)

The richest hook system of any host. Users wire **shell / HTTP / LLM-prompt /
agent / MCP-tool** handlers into:

- **Session**: SessionStart, SessionEnd, Setup
- **Turn**: UserPromptSubmit, UserPromptExpansion, Stop, StopFailure,
  Notification, MessageDisplay
- **Tool loop**: PreToolUse (can block/defer), PermissionRequest, PermissionDenied,
  PostToolUse, PostToolUseFailure, PostToolBatch
- **Agents/tasks**: SubagentStart, SubagentStop, TaskCreated, TaskCompleted,
  TeammateIdle
- **Env/fs**: ConfigChange, CwdChanged, FileChanged, WorktreeCreate,
  WorktreeRemove, PreCompact, PostCompact
- **Elicitation** (interactive prompts): Elicitation, ElicitationResult
- Hook **decision control**: exit code 2 / JSON `decision` can block, inject
  context, defer tool calls, persist env vars, force retry.

---

## 2. Side-by-side: taskflow vs Claude Code

Legend: ✅ has it · ⚠️ partial / weaker · ❌ missing.

### 2a. Orchestration primitives

| Capability | taskflow | Claude Code |
|---|---|---|
| Single worker (agent) | ✅ `agent` | ✅ `agent()` / Subagents |
| Static parallel branches | ✅ `parallel` | ⚠️ via script (Promise.all) |
| Dynamic fan-out over array | ✅ `map` | ✅ `pipeline()` |
| Quality gate (halt on BLOCK) | ✅ `gate` (score/scored/eval) | ⚠️ manual in script (agent review) |
| Aggregate N → 1 | ✅ `reduce` | ⚠️ manual in script |
| Best-of-N + judge | ✅ `tournament` | ⚠️ "weigh several angles" — manual |
| Loop until done/converge | ✅ `loop` (condition/convergence/cap) | ⚠️ manual `while` in script |
| Human approval | ✅ `approval` (approve/reject/edit) | ⚠️ per-run launch prompt only |
| Sub-flow composition | ✅ `flow` (saved sub-taskflow) | ✅ saved workflow → `/<name>` |
| Zero-token shell step | ✅ `script` | ❌ (no fs/shell from script) |
| **Explicit DAG + `dependsOn`** | ✅ topo-sorted, cycle-detected | ❌ implicit (script control flow) |
| Static verification (pre-run) | ✅ `verify` / `compile` (0 tokens) | ❌ |
| `when` guards / `join: any` | ✅ | ❌ |

> **taskflow wins on orchestration vocabulary.** Claude Code's workflow script
> can *emulate* gate/tournament/loop in JS, but it has no first-class primitive,
> no static verifier, and no explicit DAG — correctness rests on the LLM writing
> the right JS each time.

### 2b. Reliability & resumability

| Capability | taskflow | Claude Code |
|---|---|---|
| Retry w/ exponential backoff | ✅ `retry` | ❌ (LLM re-spawns manually) |
| Per-call timeout | ✅ `timeout` | ❌ |
| Output contract (`expect`) | ✅ schema-validated, retryable | ⚠️ `agent({schema})` validates result |
| Cost ceiling | ✅ `budget` {maxUSD, maxTokens} | ⚠️ "size guideline" (advice only) |
| Resume **within** session | ✅ | ✅ (cached agent results) |
| Resume **across** sessions | ✅ (durable run state) | ❌ "fresh on next session" |
| **Cross-run memoization cache** | ✅ content-addressed, git/glob/file/env fingerprints, TTL | ❌ |
| Incremental recompute (why-stale) | ✅ `recompute` / `why-stale` | ❌ |
| Fail-open invariants | ✅ documented + enforced | ⚠️ ad hoc |

> **taskflow wins on durability + caching.** Claude Code workflows are
> session-scoped and have no content-addressed cache — re-running a similar task
> re-spawns everything. taskflow's cross-run cache + incremental recompute is a
> genuine moat.

### 2c. Context & isolation

| Capability | taskflow | Claude Code |
|---|---|---|
| Only final output to host context | ✅ | ✅ (script variables) |
| Per-phase workspace isolation | ✅ `cwd: temp/dedicated/worktree` | ✅ worktrees (per session/phase) |
| Shared blackboard (horizontal) | ✅ `ctx_read` / `ctx_write` | ⚠️ Agent Teams shared task list |
| Vertical supervision | ✅ `ctx_report` / `ctx_spawn` (nested DAG) | ⚠️ Agent Teams lead↔teammates |
| Inter-agent direct messaging | ❌ (via shared tree only) | ✅ Agent Teams |

> **Roughly even.** taskflow's Shared Context Tree is more structured (a
> supervised blackboard with depth caps + budget); CC's Agent Teams are more
> "chatty" (direct peer messaging) but CC admits coordination is buggy.

### 2d. Authoring & UX

| Capability | taskflow | Claude Code |
|---|---|---|
| **LLM auto-writes the orchestration** | ❌ (hand-author DSL) | ✅ **ultracode / "use a workflow"** |
| Authoring format | JSON DSL (+ JSONC) | JS script (Claude-written) |
| Verify-before-run (0 token) | ✅ `verify`/`compile` + Mermaid | ❌ (View raw script, manual) |
| Saved flow → slash command | ✅ `/tf:<name>` | ✅ `/<name>` |
| `args` input to saved flow | ✅ `{args.X}` | ✅ `args` global |
| Interactive init | ✅ `/tf init` | ✅ `/config` toggles |
| Live progress TUI | ✅ runs-view + approval-view | ✅ `/workflows` + task panel |
| Searchable flow library | ✅ `search` (structural + CJK) | ❌ |
| **Multi-host** (Pi/Codex/Claude/OpenCode) | ✅ | ❌ (Claude Code only) |

> **Claude Code wins on zero-author UX; taskflow wins on portability + library.**
> The auto-compose gap is the one that matters most for adoption.

### 2e. Lifecycle hooks

| Capability | taskflow | Claude Code |
|---|---|---|
| User-configurable event hooks | ❌ (internal `onProgress` only) | ✅ ~30 events, 5 handler types |
| Pre/post-phase side effects | ❌ | ✅ PreToolUse/PostToolUse/etc. |
| Inject context / block / defer | ❌ | ✅ decision control |

> **Claude Code wins decisively.** This is the cleanest gap.

---

## 3. Where taskflow is clearly ahead (defend these)

1. **Orchestration vocabulary** — 10 phase types vs 2 primitives. gate /
   tournament / loop / approval / reduce are first-class, statically verified.
2. **Cross-run caching + incremental recompute** — unique. CC re-runs everything.
3. **Cross-session resume** — CC workflows die with the session.
4. **Multi-host** — runs on Pi, Codex, Claude Code, OpenCode. CC is locked to
   Claude Code.
5. **Static verification** — `verify`/`compile` catch DAG bugs before spending a
   token; CC has nothing equivalent.
6. **Searchable flow library** — `taskflow_search` with structural + CJK scoring;
   CC has no reuse-discovery.

## 4. Where Claude Code is ahead (the gaps to close)

| Gap | Severity | Why it matters |
|---|---|---|
| **G1. No zero-author / auto-compose** | 🔴 critical | CC's `ultracode` lets a user say "audit every route" and gets a workflow. taskflow demands a hand-written DSL. This is the adoption moat. |
| **G2. No lifecycle hook system** | 🟠 high | Power users wire CI, formatters, slack pings, permission policy into CC hooks. taskflow can't. |
| **G3. No inter-agent direct messaging** | 🟡 medium | Agent Teams let peers argue. taskflow's shared tree is structured but less "conversational". (Likely a *non-goal* — structured beats chatty.) |
| **G4. Smaller scale ceiling** | 🟡 medium | CC: 1000 agents/run. taskflow has no published cap but isn't tuned for 1000-way fan-out UX. |
| **G5. No bundled "killer" workflow** | 🟡 medium | CC ships `/deep-research`. taskflow ships the *engine* but no marquee one-command flow. |

---

## 5. Recommended features for 0.1.7 (to "fully surpass")

Ranked by leverage. Each is sized for one release.

### 🥇 P0 — Auto-compose (`action=compose`)
**Closes G1.** New `taskflow_compose` action (and a `/tf compose` command):
the host LLM describes the task in prose → a dedicated **planner agent** drafts
a taskflow DSL → `verify` runs (0 tokens) → if clean, optionally `run` it;
if not, the planner revises (a `loop` until `verify` passes or cap). Reuses the
existing `loop` + `gate` + `verify` primitives — the feature *is* a taskflow
flow that writes taskflow. This neutralizes CC's biggest UX edge while keeping
taskflow's deeper, verifiable engine. **CC cannot match the static-verify step.**

### 🥈 P1 — Lifecycle hooks (`on` phase field + global hooks)
**Closes G2.** Two layers:
- **Per-phase hooks**: `on: { start, end, block }` running a `script` (shell,
  zero tokens) — covers PreToolUse/PostToolUse/onBlock patterns.
- **Global run hooks**: `hooks: { onPhaseStart, onPhaseEnd, onRunComplete,
  onApproval }` wired to shell commands, emitting the same JSON event shape CC
  uses (so existing CC hook scripts port). Decision control: exit 2 / JSON
  `decision` can block or inject.

### 🥉 P2 — Bundled marquee flow: `/tf:deep-research` (and `/tf:audit`)
**Closes G5.** Ship a library flow that fans out web/source search →
cross-check → vote → cited report, exactly mirroring CC's `/deep-research`,
*but* running on all four hosts and cacheable across runs. Demonstrates the
engine's superiority on a task users already recognize. Plus `/tf:audit`
(per-file adversarial review → ranked summary) — the other CC headline example.

### P3 — Scale + observability for large fan-out
**Closes G4.** Publish a `maxAgents`/`concurrency` config, add a
"1000-agents" progress mode to the runs TUI (phases collapse to counts), and a
`size` advice field mirroring CC's small/medium/large so the composer aims
right.

### P4 (optional) — Peer messaging via shared tree
**Closes G3.** Add `ctx_message` (addressed, non-supervised) on top of the
existing Shared Context Tree, so peers can "argue" without going through a
supervisor. Low priority — structured reuse usually beats chat.

---

## 6. The one-sentence pitch after 0.1.7

> *taskflow: the only multi-agent orchestrator where the LLM writes the flow,
> the engine **verifies** it before a token is spent, results are **cached
> across runs**, and it runs on **every host** — not just Claude Code.*

The two words Claude Code cannot match: **verify** and **cached**.
