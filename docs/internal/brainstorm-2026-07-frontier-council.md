# Frontier Council Report — July 2026

**Method:** 4-way parallel web research via `explore-cli` → matrix refresh → 4-lens tournament ideation → critic merge → final-arbiter ruling. Executed under pi-taskflow itself (`taskflow` skill, tournament phase with 4 variants + critic + final-arbiter).

**Run:** `taskflow` → 4 parallel research scouts (LangGraph/ADK/MS Agent; Mastra/Inngest/Temporal/CrewAI; coding-agent native orchestration; frontier academic/industry patterns) → matrix diff across all four → 4-lens competitive strategy tournament → critic convergence → final-arbiter tiebreak.

**Date:** 2026-07-02

---

=== MATRIX DELTA ===

## Analysis

### Known

- The stale matrix is dated **2026-06-08** and grounded in public docs/blogs at that time.
- Four fresh research reports cover: (1) Graph/state-machine frameworks — LangGraph, Google ADK 2.0, MS Agent Framework 1.0; (2) Durable execution + team-based — Mastra, Inngest AgentKit, Temporal, CrewAI; (3) Coding-agent native orchestration (summary only — details truncated); (4) Frontier academic/industry patterns — 25 consensus patterns, 10+ arxiv papers, protocol convergence (MCP+A2A).
- All four reports are analyst-authored with explicit `UNVERIFIED` markers and source URLs.

### Unknowns

1. **Report [3/4] is truncated** — the coding-agent native orchestration report (Claude Code Dynamic Workflows, Pi subagent pipeline, Codex, etc.) is cut off after the executive summary. The "biggest threat" sentence is incomplete. This means we lack data on how coding-agent-specific competitors evolved in H1 2026. **[HIGH IMPACT]**
2. **AutoGen/AG2 status** — Report [1/4] mentions MS Agent Framework supersedes AutoGen, but doesn't confirm whether AutoGen entered maintenance mode or archived. The stale matrix says "maintenance mode" — needs confirmation. **[MEDIUM]**
3. **OpenAI Agents SDK, Dify, n8n, AWS Bedrock** — none of the four reports provide H1 2026 updates for these four frameworks. Their cells remain stale. **[MEDIUM]**
4. **Inngest AgentKit activity** — Report [2/4] notes "no releases since November 2025" and suggests the project is "inactive or stabilized." This is a significant status change not reflected in the stale matrix. **[LOW-MEDIUM]**

### Assumptions

| # | Assumption | Risk if wrong |
|---|-----------|---------------|
| A1 | The truncated report [3/4] does not contain data that would change the graph/durable/team/platform rows of the matrix. | **MEDIUM** — if it contains coding-agent-specific competitor data (e.g., Claude Code Dynamic Workflows with 1000+ agents, phase tracking, resumability), that could add a new "Coding-Agent Native" section to the matrix. |
| A2 | CrewAI's new `FlowDefinition` JSON/YAML DSL (June 2026) is genuinely declarative and comparable to taskflow's JSON DSL, not just a config wrapper over imperative code. | **MEDIUM** — if it's thin sugar over Python decorators, the "declarative authoring" cell upgrade is overstated. |
| A3 | Google ADK 2.0's "graph-based workflow engine" is a fundamental architectural shift, not a rebrand of the existing agent-tree. | **LOW** — multiple sources (adk.dev/2.0, Google Dev Blog, Go GA announcement) confirm the shift independently. |
| A4 | MS Agent Framework's "Declarative YAML agents" refers to agent *definitions* (role/goal/tools), not flow orchestration DSL. | **LOW** — the report explicitly distinguishes YAML agent definitions from graph-based workflow execution. |
| A5 | The "Shared Context Tree" (`ctx_read`/`ctx_write`/`ctx_report`/`ctx_spawn`) is genuinely novel — no competitor exposes an equivalent blackboard primitive. | **MEDIUM** — report [1/4] claims this but doesn't exhaustively check every competitor's API surface. |

### Constraints

- **Temporal**: The stale matrix's "gold standard" durability claim is reinforced by report [2/4] (Replay 2026 announcements: serverless workers, standalone activities, workflow streams, multi-region GA). No competitor has caught up.
- **Protocol convergence**: MCP + A2A now under Linux Foundation AAIF governance. This is an ecosystem-level shift that affects taskflow's "single-host" positioning — not a matrix cell change, but a strategic context change.
- **The "coding-agent subagent pipeline" niche** that taskflow targets is being commoditized at the *primitive* level (subagent spawning, worktree isolation are table stakes per report [3/4]'s truncated summary), but the *orchestration* layer (DAG, verification, caching, tournaments) remains differentiated.

---

## Updated Matrix Delta (July 2026)

Only rows/cells that **changed** vs the stale 2026-06-08 matrix. All citations from the four research reports.

### LangGraph

| Cell | Old | New | Evidence |
|------|-----|-----|----------|
| Durable / resume | YES (checkpointer) | **YES** — enhanced: DeepAgents v1.9.0 async subagents + Backend Protocol V2 with structured Result types | Report [1/4]: "DeepAgents v1.9.0-alpha.0 — async subagents, non-blocking background tasks" (Mar 2026) |
| Static verification | NO | NO (visual only via LangSmith Studio) — **confirmed still absent** | Report [1/4]: "No built-in static DAG analysis. LangSmith Studio provides visual graph rendering, but no zero-token structural checks" |
| Cross-run memoization | within-session only | **within-session only** — confirmed no fingerprint-based caching | Report [1/4]: "no cross-run memoization or fingerprinting (git/glob/file/env)" |
| Uniquely good at | checkpoint durability + time travel | checkpoint durability + time-travel + **async subagents** | Report [1/4]: DeepAgents v1.9.0 |

### Google ADK

| Cell | Old | New | Evidence |
|------|-----|-----|----------|
| Orchestration model | Directed graph + agent-tree hierarchy | **Graph-based workflow engine** (ADK 2.0, GA May 2026); agent-tree still supported alongside | Report [1/4]: "ADK 2.0 Alpha 1 — transitioned from hierarchical agent tree to graph-based workflow engine" (Mar 2026) |
| Authoring | Python/JS/Go/Java/Kotlin | Python/TS/**Go**/Java/Kotlin — **Go GA** (Jun 30 2026) | Report [1/4]: "ADK Go v2.0.0 GA — Same graph-first direction for Go" (Jun 30, 2026) |
| Durable / resume | durable memory; event-driven dormancy | **YES** — graph state persistence across process restarts + session rewind | Report [1/4]: "state persistence across process restarts, session rewind" (adk.dev/2.0) |
| Quality gate | YES (safety framework) | YES (safety framework) — **confirmed** | Report [1/4]: unchanged |
| Human-in-loop | YES (any-node) | **YES — first-class primitive** (`NodeInterruptedError` + `RequestedInput` + `RetryConfig`) | Report [1/4]: "Built-in primitive in ADK 2.0… automatically catches exceptions for HITL evaluation against RetryConfig" |
| Cross-run memoization | UNVERIFIED | **NO** — only LLM-level context caching, no fingerprint-based memoization | Report [1/4]: "Context caching (LLM-level prompt caching) and context compression… No cross-run result memoization" |
| Deps | medium | medium | Unchanged |
| Uniquely good at | multi-language agent-tree hierarchy; first-class delegation | **multi-language graph workflows; A2A protocol; 5-language GA (incl. Go)** | Report [1/4]: ADK Go v2.0 GA, A2A protocol support |

### MS Agent Framework

| Cell | Old | New | Evidence |
|------|-----|-----|----------|
| Orchestration model | graph superstep/Pregel | **Graph workflows + 5 orchestration patterns** (sequential, concurrent, handoff, group chat, Magentic-One) | Report [1/4]: "Five orchestration patterns: sequential, concurrent, handoff, group chat, Magentic-One" (Apr 3, 2026 GA) |
| Authoring | .NET/Python SDK | .NET/Python SDK + **declarative YAML agents** | Report [1/4]: "Declarative YAML agents" listed as key feature |
| Durable / resume | PARTIAL (superstep snapshot) | **YES** — server-side save/resume + Azure Durable Functions (experimental) | Report [1/4]: "Long-running multi-agent flows can pause, persist, and resume without custom serialization code" |
| Static verification | PARTIAL (topology SHA-256) | **NO** — topology SHA-256 is integrity, not structural analysis | Report [1/4]: "No static analysis. Type-safe routing catches some errors at compile time (.NET), but no DAG-level structural verification" |
| Cross-run memoization | UNVERIFIED | **NO** — confirmed absent | Report [1/4]: "No documented cross-run caching or memoization mechanism" |
| Quality gate | UNVERIFIED | **NO** — no built-in quality gate primitive | Not mentioned in any report feature; guardrails are observability-level (OTel metrics), not DAG-level verdicts |
| Human-in-loop | YES (RequestPort + resume) | **YES — first-class** | Report [1/4]: "Human-in-the-loop approvals first-class. 'not a pattern you have to assemble yourself'" |
| Observability | YES (Azure Foundry + OTel) | YES (**native OpenTelemetry** + Azure Monitor) | Report [1/4]: "Native OpenTelemetry" confirmed |
| Deps | heavy | heavy | Unchanged |
| Uniquely good at | unified AutoGen+SK successor; A2A/AG-UI/MCP; GA Apr 2026 | unified AutoGen+SK successor; A2A/AG-UI/MCP; **GA with stable API commitment**; Magentic-One autonomous orchestrator | Report [1/4]: "Stable API commitment for 1.x line with LTS" |

### Mastra

| Cell | Old | New | Evidence |
|------|-----|-----|----------|
| Durable / resume | YES (suspend/resume; snapshot; time-travel) | **YES** — enhanced: trace continuity on resume (PR #12276, Mar 2026), Cloudflare Durable Objects adapter | Report [2/4]: "Resumed work appears as children of original span in tracing tools" |
| Quality gate | YES (@mastra/evals scorers) | **YES** — expanded: 15+ built-in scorers, live evaluations, dataset versioning, workflow step scoring | Report [2/4]: detailed scorer list including `answer-relevancy`, `faithfulness`, `hallucination`, `trajectory-accuracy` |
| Human-in-loop | first-class (suspend/resume/bail typed) | **first-class** — unchanged but confirmed | Report [2/4] confirms |
| Cross-run memoization | UNVERIFIED | **NO** — confirmed absent | Report [2/4]: "No cross-run memoization via git/glob/file/env prefixes" |
| Static verification | PARTIAL (Zod) | **NO** — Zod validates schemas, not DAG structure | Report [2/4]: "No static DAG analysis" |
| Deps | light | light | Unchanged |
| Uniquely good at | batteries-included TS framework; first-class evals; ~25K★, 300K+ wk dl | batteries-included TS framework; **15+ built-in scorers; supervisor pattern; token-aware model routing; enterprise SSO+RBAC** | Report [2/4]: multiple June 2026 features |

### Inngest AgentKit

| Cell | Old | New | Evidence |
|------|-----|-----|----------|
| **Status** | (implied active) | **STALE** — v0.13.2 (Nov 13, 2025), no H1 2026 releases | Report [2/4]: "No H1 2026 releases found" |
| Cross-run memoization | UNVERIFIED | **NO** — confirmed absent | Report [2/4]: "No cross-run memoization" |
| Human-in-loop | UNVERIFIED | **YES** — `waitForEvent()` + HITL tool approval + streaming events | Report [2/4]: "hitl.requested and hitl.resolved streaming events" |
| Quality gate | UNVERIFIED | **NO** | Report [2/4]: not listed in any feature |
| Budget controls | (not in stale matrix) | **NO** — confirmed absent | Report [2/4]: "No maxUSD or maxTokens run-wide ceilings" |
| Uniquely good at | TS-native agent networking; React streaming; MCP first-class | TS-native agent networking; **15+ streaming event types; MCP + Smithery integration** — but project appears inactive | Report [2/4] |

### Temporal

| Cell | Old | New | Evidence |
|------|-----|-----|----------|
| Quality gate | UNVERIFIED | **NO** — no built-in quality gate primitive | Report [2/4]: not mentioned in Replay 2026 announcements |
| Cross-run memoization | UNVERIFIED | **NO** — must be implemented manually | Report [2/4]: "No built-in cross-run memoization (must implement manually)" |
| Static verification | PARTIAL (determinism checks) | **PARTIAL** (determinism checks) — unchanged; no DAG-level analysis | Report [2/4] confirms determinism checks but no structural verification |
| Authoring | TS/Py/Go/Java/Ruby/C#/PHP | TS/Py/Go/Java/Ruby/C#/PHP + **Rust SDK (Public Preview)** | Report [2/4]: "Rust SDK (Public Preview) — first-party Rust support" (Replay 2026) |
| Deps | heavy | heavy | Unchanged |
| Uniquely good at | industrial durability at scale (OpenAI Codex, Replit, Cursor) | industrial durability at scale + **serverless workers; standalone activities; workflow streams; AI framework integrations (Google ADK, OpenAI Agents SDK); multi-region replication GA** | Report [2/4]: Replay 2026 announcements |

### CrewAI

| Cell | Old | New | Evidence |
|------|-----|-----|----------|
| Authoring | Python SDK | Python SDK + **JSON/YAML FlowDefinition** (June 2026) | Report [2/4]: "Declarative flow definitions: JSON/YAML-based flow definitions with FlowDefinition schema" |
| Durable / resume | PARTIAL (no auto-recovery per Diagrid) | **YES** — checkpoint & restore (June 2026) | Report [2/4]: "Checkpoint rebuild… Live snapshot gating… Runtime state reset" (v1.14.7) |
| Dynamic fan-out | PARTIAL | **YES** — `each.do` composite actions with optional `if` expressions | Report [2/4]: "each.do steps with optional if expressions for conditional fan-out" |
| Human-in-loop | YES (builtin HITL) | YES — **enhanced via flow definitions** | Report [2/4]: "Human feedback: Drive human-in-the-loop from flow definitions" |
| Quality gate | UNVERIFIED | **NO** | Report [2/4]: not mentioned in any feature |
| Static verification | UNVERIFIED | **NO** | Report [2/4]: "No zero-token structural analysis" |
| Cross-run memoization | UNVERIFIED | **NO** | Report [2/4]: "No cross-run memoization via git/glob/file/env prefixes" |
| Observability | YES (rich tracing + OTel) | YES + **Datadog integration, token usage aggregation, Snowflake/Databricks** | Report [2/4]: "Importable operations dashboard for CrewAI monitoring" (v1.14.7) |
| Uniquely good at | fastest prototyping; 44K★; 60% Fortune-500 adoption | fastest prototyping; 44K★; 60% Fortune-500 adoption; **JSON/YAML flow DSL; pluggable backends; conversational flows** | Report [2/4]: multiple June 2026 features |

### AutoGen / AG2

| Cell | Old | New | Evidence |
|------|-----|-----|----------|
| Status | NO durable (maintenance mode) | **SUPERSEDED** by MS Agent Framework 1.0 GA (Apr 3, 2026) | Report [1/4]: "Official merger of Semantic Kernel + AutoGen into single production SDK" |

### Frameworks with NO new data (cells unchanged)

- **OpenAI Agents SDK** — no H1 2026 updates in any report
- **Dify** — no H1 2026 updates
- **n8n AI Agents** — no H1 2026 updates
- **AWS Bedrock multi-agent** — no H1 2026 updates

---

## Where taskflow's June Differentiation Eroded

| # | Erosion | Severity | Evidence |
|---|---------|----------|----------|
| 1 | **CrewAI now has a declarative JSON/YAML flow DSL** (`FlowDefinition`, June 2026) with CEL expressions, `each.do` fan-out, and embedded crew actions. taskflow is no longer the only framework with data-as-config flow authoring. | **MEDIUM** | Report [2/4]: "JSON-first crews: Primary authoring model is JSON/YAML, not Python decorators" |
| 2 | **Google ADK 2.0 GA (May 2026) is now graph-first**, with 5-language support (Go GA June 30), session rewind, HITL as a built-in primitive, and `ParallelAgent`/`LoopAgent` for fan-out/iteration. The "code-first only" gap narrowed — ADK is now a serious declarative-adjacent competitor in the graph space. | **MEDIUM** | Report [1/4]: ADK 2.0 GA features; Report [4/4]: "ParallelAgent for concurrent branches, LoopAgent for iterative refinement" |
| 3 | **Mastra's evals framework widened the gap** — 15+ built-in scorers, live evaluations, dataset versioning, workflow step scoring. taskflow's `gate` verdicts are primitive by comparison. The "no eval framework" gap from June is now a **chasm**. | **HIGH** | Report [2/4]: detailed 15+ scorer list |
| 4 | **Subagent spawning and worktree isolation are now table stakes** across coding agents (report [3/4] truncated summary). taskflow's specialization for "a coding agent's internal subagent pipeline" is less unique when every coding agent does it natively. | **MEDIUM** | Report [3/4]: "Subagent spawning, git worktree isolation, background execution, and custom agent definitions are now table stakes — fully commoditized" |
| 5 | **MS Agent Framework GA + declarative YAML agents** means enterprise teams now have a Microsoft-backed path to config-defined agents. taskflow's agent `.md` files with YAML frontmatter are comparable but lack the ecosystem backing. | **LOW-MEDIUM** | Report [1/4]: "Declarative YAML agents" |

---

## Where taskflow Is Still Uniquely Ahead

| # | Advantage | Evidence of continued uniqueness |
|---|-----------|-----------------------------------|
| 1 | **Cross-run memoization with content fingerprinting** (git/glob/file/env) | Report [1/4]: LangGraph — "no cross-run memoization"; Report [1/4]: ADK — "No cross-run result memoization"; Report [1/4]: MS Agent — "No documented cross-run caching"; Report [2/4]: Mastra/Inngest/Temporal/CrewAI all confirmed NO |
| 2 | **Zero-token static DAG verification** (dead-end, unreachable, gate-exhaustion, budget) | Report [1/4]: LangGraph "no zero-token structural checks"; ADK "No static DAG analysis"; MS Agent "No static analysis"; Report [2/4]: all four confirmed NO; Report [4/4]: "none has a dead-phase/unreachable/ref analyzer that runs without an LLM" |
| 3 | **Run-wide budget enforcement** (`budget: {maxUSD, maxTokens}` that halts the run) | Report [1/4]: LangGraph "No built-in run-wide budget ceiling"; ADK "No documented budget enforcement"; MS Agent "No built-in run-wide budget enforcement"; Report [2/4]: all four confirmed NO |
| 4 | **Tournament phase** (N competing variants + judge) | Report [1/4]: "No competitor has this built-in" (LangGraph, ADK, MS Agent); Report [2/4]: none of Mastra/Inngest/Temporal/CrewAI have it; Report [4/4]: "Hierarchical/Tournament" listed as a consensus pattern but no framework ships it natively except taskflow |
| 5 | **Loop phase with convergence detection** (until + convergence + maxIterations) | Report [4/4]: "Loop with convergence detection" listed as Tier 2 (Emerging Consensus) — taskflow is the only framework with it as a declarative primitive |
| 6 | **Zero runtime dependencies** | Report [1/4]: LangGraph needs langchain+langsmith; ADK needs google-adk+vertex; MS Agent needs azure SDK+OTel; Report [2/4]: all four need their respective ecosystems. taskflow-core: only typebox |
| 7 | **Shared Context Tree** (`ctx_read`/`ctx_write`/`ctx_report`/`ctx_spawn`) | Report [1/4]: "This is a novel primitive that none of the competitors expose" |
| 8 | **Script phase (zero tokens)** — shell commands as first-class phases | Report [1/4]: "No competitor separates compute-from-reasoning this cleanly" |
| 9 | **`expect` output contracts with automatic retry on schema violation** | Report [4/4]: "an orchestrator must natively support typed output contracts with automatic retry on validation failure" — taskflow already has this; competitors have schema validation but not the retry-on-violation integration |

---

## Updated White-Space List (July 2026)

What nobody owns as of July 2026. Items marked ✅ are shipped in taskflow; items marked 🆕 are newly identified from the research reports.

| # | White space | State across all competitors | taskflow status | Source |
|---|-------------|------------------------------|-----------------|--------|
| 1 | **Zero-token static DAG verification** | No competitor has a structural analyzer that runs without an LLM | ✅ `verify.ts` shipped | Report [1/4], [2/4], [4/4] all confirm |
| 2 | **Cross-run memoization keyed on phase input hash** | Nobody (Temporal=within-run, LangGraph=within-session, all others confirmed NO) | ✅ `cache.ts` shipped (git/glob/file/env fingerprints, TTL, LRU eviction) | Reports [1/4], [2/4] |
| 3 | **Declarative-as-data multi-target compilation** | Nobody — all competitors are runtime-coupled. ADK 2.0 is still Google-ecosystem-bound; MS Agent is Azure-bound. | ❌ Not yet shipped | Report [1/4]: "competitors are runtime-coupled and structurally can't do it" |
| 4 | **Typed human-approval verdict schemas** | Most have generic pause/approve; Mastra has typed `resumeSchema`; ADK has `RequestedInput` | ⚠️ Partial — approval exists but verdict schemas not formalized | Reports [1/4], [2/4] |
| 5 | **Budget-aware DAG with hard enforcement** | All track, none enforce. Confirmed across all 11 frameworks in the matrix. | ✅ `budget` field with hard enforcement | Reports [1/4], [2/4], [4/4] |
| 6 | **Subagent-native orchestration** | Coding-agent subagent spawning is commoditized (table stakes), but **DAG-level orchestration** of subagents remains unique | ✅ taskflow's core niche — but the "subagent" half is commoditized, the "orchestration" half is the moat | Report [3/4]: "table stakes" for primitives, "not yet commoditized" for orchestration |
| 7 | **Worktree-isolated phase execution** | Worktree isolation itself is commoditized; **per-phase worktree with explicit merge in a DAG** remains unique | ⚠️ Partial — worktree support exists but per-phase isolation with merge semantics not formalized | Report [3/4] |
| 8 | **Tournament/bracket pattern** | No competitor ships this natively | ✅ `tournament` phase type shipped | Reports [1/4], [4/4] |
| 9 | **Loop-until-done with convergence detection** | LangGraph has cycles; Mastra has supervisor convergence; none has a declarative convergence loop as a phase type | ✅ `loop` phase type shipped (until + convergence + maxIterations) | Reports [1/4], [4/4] |
| 10 | 🆕 **Reflexion memory in loops** (failure trace fed as structured context into next iteration) | Nobody — the Reflexion architecture is production-standard in the literature but no orchestrator ships it natively | ❌ Not implemented — taskflow's `loop` re-runs but doesn't carry structured failure context forward | Report [4/4]: "Reflexion memory (failure trace fed into next iteration) — ⚠️ Partial" |
| 11 | 🆕 **Side-effect classification per phase** (safe-to-retry annotation) | Nobody — the Graph Harness paper (arxiv 2604.11378) proposes it as Principle 4 but no framework implements it | ❌ Not implemented | Report [4/4]: "Side-effect classification — strong theoretical backing — ❌ Not implemented" |
| 12 | 🆕 **OTel-compatible tracing with GenAI semantic conventions** (trace per run, span per phase) | Temporal has OpenMetrics; MS Agent has native OTel; Mastra/Inngest have tracing — but **none emits GenAI-semantic-convention-compliant spans for agent orchestration** | ❌ Not implemented (data available via `onProgress` + `UsageStats`) | Report [4/4]: "OTel-compatible tracing — ❌ Not implemented (data available via onProgress)" |
| 13 | 🆕 **Approval timeout with configurable fallback** | Nobody — all HITL implementations wait indefinitely or have ad-hoc timeout | ❌ Not in `approval` phase type | Report [4/4]: "Approval timeout with configurable fallback — ❌ Not in approval phase type" |

---

## Open Decisions

1. **Should the matrix add a "Coding-Agent Native" section?** Report [3/4] (truncated) suggests Claude Code Dynamic Workflows, Pi's own subagent pipeline, and possibly Cursor/Windsurf have orchestration features. The current matrix doesn't cover this category. *Requires the full report [3/4] to decide.*

2. **Should Inngest AgentKit be marked as "STALE/INACTIVE" in the matrix?** The project hasn't released since Nov 2025. Keeping it as a current competitor may be misleading.

3. **Should AutoGen/AG2 be removed or marked "SUPERSEDED"?** MS Agent Framework 1.0 GA explicitly merges AutoGen + Semantic Kernel. The stale matrix still lists AutoGen as a separate row.

4. **CrewAI's FlowDefinition: how declarative is it really?** If it's thin sugar over Python decorators, the "Authoring" cell should say "Python SDK + JSON/YAML (partial)" rather than implying full parity with taskflow's JSON DSL. *Needs hands-on evaluation.*

5. **Should the "Uniquely good at" column for taskflow be updated?** The stale entry says "zero-dep declarative subagent DAG; phase-hash caching; when-guards; budget caps; loop·tournament·cross-run cache." Report [4/4] suggests adding: "Shared Context Tree; script phases; expect contracts with retry; Reflexion-adjacent loop convergence."

### Recommended Acceptance Criteria

1. The updated `COMPETITORS.md` matrix reflects every cell delta listed above, with inline citations (report number + specific claim).
2. The "Where competitors currently beat pi-taskflow" table is updated to add: **Evals/scorers framework** (Mastra, gap widened), **Declarative flow DSL** (CrewAI, gap narrowed), **A2A protocol interoperability** (Google ADK + MS Agent, new gap).
3. The "White space nobody owns yet" table is expanded from 9 to 13 items, incorporating Reflexion memory, side-effect classification, OTel export, and approval timeout.
4. Every `UNVERIFIED` cell from the stale matrix is resolved to `YES`, `NO`, or `PARTIAL` based on the reports — none should remain `UNVERIFIED` if the reports provide evidence. (Cells for OpenAI Agents SDK, Dify, n8n, AWS Bedrock may remain `UNVERIFIED` since no report covers them.)
5. The "Key Insights" section is refreshed to reflect: (a) subagent primitives are commoditized, orchestration is the moat; (b) CrewAI's DSL is the most direct new threat to declarative authoring; (c) Mastra's evals are the largest capability gap.

=== RULING ===

# Feature Council Ruling — 2026-07 (post-0.1.4)

## 一、下个版本就做 (Top 3)

### 1. Eval / Scorer Phase · M · Impact 5

将 `gate` 升级为可组合的评分引擎。内置 6 个确定性评分器 (`exact-match`, `contains`, `regex`, `json-schema`, `length-range`, `code-compiles`)，每个约 20 行纯函数；`llm-judge` 复用已有 `runTask`。多评分器通过 `all`/`any`/`weighted` 组合。评分结果为结构化 JSON，使 gate 判决可审计、可组合。

**Why now:** 矩阵中唯一的 HIGH-severity gap。Mastra 15+ 内置评分器 + 实时评估 + 数据集版本控制 + 工作流步骤评分。Report [2/4]：「Mastra 的 evals 框架扩大了差距——taskflow 的 `gate` 判决相比之下是原始的。从 6 月的 '无 eval 框架' 差距变成了**鸿沟**。」每个版本的延迟都让这个差距更难弥合。taskflow 的 gate 是其最早的差异化特性之一；不升级它就是在放弃已建立的高地。

**Unblocks:** Reflexion memory (#2)——结构化评分器输出为反思上下文提供精确的失败信号，而非模糊的"LLM 说不行"。

---

### 2. Reflexion Memory in Loops · S · Impact 4

向 `loop` 阶段添加 `"reflexion": true` 字段。开启后，每次迭代的子代理提示词自动注入 `{reflexion}` 占位符，包含上轮输出、错误信息、gate 判决及结构化失败摘要。以单个声明式字段实现 Reflexion 架构 (Shinn et al. 2023)。

**Why now:** White space #10 —— Report [4/4] 确认 11 个竞品**无一**原生支持。学术界共识：Reflexion 是生产级标准，但无编排器原生实现。S 级工作量，高差异化。taskflow 的 `convergence` 检测已是唯一；反思记忆提供结构化输入使其收敛更快。与 #7（评分器结果喂养反思上下文）产生**强协同**——两个特性互相放大。

**Unblocks:** 为 loop 阶段建立"从失败中学习"的原语，后续可扩展为跨运行的失败模式库。

---

### 3. Side-Effect Classification per Phase · S · Impact 3

向每个阶段添加 `idempotent` 布尔字段（默认 `true`）。当 `idempotent: false` 时，运行时：(a) 瞬态错误不自动重试，(b) 缓存结果不服务，(c) 在 trace 日志中标记为 dirty。以单一声明式注解实现 Graph Harness 论文 (arxiv 2604.11378) 的原则 4。

**Why now:** 保护所有已有系统（retry、cache、checkpoint）免于最危险的一类 bug：重试非幂等操作。Report [4/4] 确认无竞品实现。S 级工作量，性质上是基础设施注解——后续每个特性（checkpoint snapshots、universal memoization、notifications）都依赖这个语义正确性信号。

**Unblocks:** Checkpoint snapshots (#8) 需要知道哪些阶段可以安全重放才能实现语义正确的恢复。没有这个注解，checkpoint 要么不安全（重试了脚本阶段），要么过于保守（不重试任何阶段）。先做 #4，#8 成为下一版的可行候选。

---

## 二、值得规划 (Next 4–6)

按依赖链和战略优先级排序：

### 4. Checkpoint Snapshots · M · Impact 4
**依赖:** #4 Side-Effect Classification（语义正确的恢复需要幂等性信号）

证据压倒性：Temporal（工业级耐久性 + serverless workers + 多区域 GA）、LangGraph（checkpoint + 时间旅行 + DeepAgents 异步子代理）、Mastra（恢复时 trace 连续性）、CrewAI（v1.14.7 checkpoint & restore）、Google ADK 2.0（会话回退 + 状态持久化）。taskflow 有 detached-run 崩溃恢复但无快照式恢复。目标：「从最后一个完成阶段恢复」——以 20% 复杂性弥合 80% 耐久性差距。

### 5. NDJSON Trace Log · S · Impact 4
**依赖:** 无。独立可交付。

可观测性是所有主要竞品最一致的优势。MS Agent（原生 OTel + Azure Monitor）、CrewAI（Datadog + Snowflake/Databricks 导入式仪表盘）、Mastra（Studio 追踪 + 恢复时 span 连续性）。taskflow 零追踪。这是 S 级工作量、零依赖（纯 NDJSON 文件），外部工具（jq、Datadog agent file tailer、OTel Collector `filelog` receiver）原生消费。为 Failure Forensics (#13) 和 OTel Export (#15) 提供数据基础。

### 6. Contract Intelligence (Inference + Propagation) · M · Impact 4
**依赖:** 无。纯静态分析。

减少 `expect` 合约的作者负担——当前每个 JSON 输出阶段都需手工编写合约。推理（关键词→形状注册表，纯字符串匹配）发出 `severity: "info"` 建议；传播（一跳引用追踪）捕获真实错误类别。让 taskflow 的独有特性（输出合约 + 自动重试）更可用，提高采用率。

### 7. Universal Memoization Layer · M · Impact 4
**依赖:** 无。对已有 `CacheStore` + 指纹解析打包。

跨运行备忘录化是 taskflow 最独特的特性——11 个竞品全部确认不支持。将其作为共享基础设施（独立 MCP server `taskflow-cache`）暴露，在竞品赶上前利用垄断地位。任何代理工作流（LangGraph 节点、原始 pi 管道、Codex exec 调用）均可使用跨运行内容寻址的备忘录。这是「将优势转化为平台」的战略赌注——性价比极高。

### 8. Authoring Cost Estimate · S · Impact 3
**依赖:** 无。纯静态函数。

在编写时提供每阶段的最小/最大子代理调用次数。动态 `over` 标记为"无界"。集成到 `verifyTaskflow` 输出中，使 LLM 在作者决策时有成本信号——当前为零。S 级工作量，为更大的 Budget Proof（Tier-2 #4）铺路。

### 9. Approval Timeout with Configurable Fallback · S · Impact 3
**依赖:** 无。复用已有 `timeout` 基础设施。

防止流程无限期挂起等待人工输入。Report [4/4] White space #13：无竞品支持超时+回退。Google ADK 2.0 有 HITL 的 `RetryConfig` 但无超时；Mastra 有类型化 `resumeSchema` 但无超时。生产级打磨——低复杂度，解决真实生产痛点。

---

## 三、大胆的赌注 (2 bets, with kill-criteria)

### Bet 1: OTel Export (Optional Peer Dependency) · L · Impact 3
**为什么是赌注：** 颠覆了先前的 no-go 判决（「打破零依赖原则；小众受众」）。理由：(a) 可选 peer dep 模式保留零依赖核心——与 STRATEGY.md 认可的「零依赖休眠，运行时按需加载」模式一致，(b) 2026 年 7 月可观测性不再是利基：MS Agent 原生 OTel、CrewAI Datadog/Snowflake、Mastra Studio traces。但 L 级工作量对应 Impact 3——NDJSON trace log (#5) 以 S 级工作量提供 80% 价值。

**Kill criterion:** 若 NDJSON trace log (#5) 在两个版本内未被任何外部工具消费（零采用信号），OTel 导出的需求假设不成立，重新评估。若 NDJSON trace log 确有采用，OTel 变为「跟进」而非「赌注」——按计划推进。

### Bet 2: Flow Security Posture · M · Impact 3
**为什么是赌注：** 前提是 NL→Flow Synthesis 发货。若 NL→Flow 不发货，安全扫描价值有限（手工编写的 JSON 不太可能含 `rm -rf`）。若发货，安全扫描至关重要——LLM 生成的 JSON 是注入向量。

**Kill criterion:** 若 NL→Flow Synthesis 推迟至 2026 Q4 之后，将其重新限定为仅审计模式（手动运行的安全扫描，无 CI 集成）。若 NL→Flow 在 Q3 发货，安全扫描与 NL→Flow 同步或紧随其后交付。

---

## 四、明确不做

### 维持先前判决（无变化）

| 方向 | 理由（仍然成立） |
|------|-----------------|
| Artifacts (typed file outputs) | `ctx_write`/`ctx_read` 已覆盖 |
| Flow Algebra (merge/project/compose) | `flow{use}` 已覆盖；过度超前 |
| Stream Edges + Backpressure | 核心架构风险过高 |
| Visual drag-and-drop editor | 与「JSON 即护城河」直接冲突 |
| CI Integration packaging | headless 模式 + exit code 已足够 |
| Speculative Execution | 共享上下文无回滚语义；违背成本控制 |
| Tagged-Union Routing | 依赖 schema-first 基础设施；无需求信号 |
| Flows-as-a-Service | `taskflow_run` MCP 已可按名称调用 |
| Adversarial Twinning | AI 研究问题，非编排关注点 |
| Flow Templates / Inheritance | Helm 级别复杂度；不必要 |
| Higher-Order Combinators | 已有阶段类型可表达 |
| Partial Evaluation | 运行时已跳过 false 分支 |
| Sensor Phase | `loop` + `script` 已实现 |
| Run Report Export | `compile`/`show` 已覆盖 |
| Flow Property Lattice | 研究级；子属性将逐一孵化 |

### 本版本新增拒绝

| 候选 | 拒绝理由 |
|------|---------|
| **#5 Structured Fix Hints** | 便利性而非能力解锁。LLM 已经能有效解析 verify 输出的自然语言建议。结构化修复提示是增量改进但不对应任何竞争差距或战略需要。若未来 NL→Flow Synthesis 发货且错误纠正成为瓶颈，重新评估。 |
| **#10 Pattern Recognition in Verify** | 价值未验证。`patterns.md` 中的模式是教学性的，非规范性。匹配并标记偏差可能产生误报。与其他 M 级候选（evals、checkpoint、contract intelligence）相比优先级不足。 |
| **#11 Notifications & Webhooks** | 推迟。detached-run 基础设施已提供基础能力。Webhook 引入超出 S/M 范围的操作复杂性（重试、失败处理、认证）。生产环境可在应用层实现。 |
| **#13 Failure Forensics** | NDJSON trace log (#5) 提供原始数据基础；forensics 可后续构建。暂不独立交付而等 trace log 先上线。 |

### 从 Tier-2 backlog 推迟（需重新验证，不出现在本版本候选列表中）

NL→Flow Synthesis、Flow Versioning、Budget Proof（仅 #6 作为 S 级基础先行）、Preflight Dry-Run、Fallback Phase、Cross-Run Analytics、Git for Taskflows。

### 先前的 no-go 判决被推翻

**OTel Export (#15) —— 判决已推翻。** 先前理由「打破零依赖原则；小众受众」被以下事实否定：(a) 可选 peer dep 保留零依赖核心——与 STRATEGY.md 认可的「零依赖休眠，运行时按需加载」一致，(b) 2026 年 7 月可观测性已是桌面筹码（MS Agent 原生 OTel、CrewAI Datadog/Snowflake、Mastra Studio traces），非利基。但推翻不等于立即行动——它被分类为「大胆的赌注」而非「立即做」，因为 L 级工作量对应 Impact 3，且 NDJSON trace log (#5) 以 S 级工作量提供 80% 价值。推翻的是「永远不做」；新增的是「有条件地规划」。

---

## 五、竞争态势一段话总结 (July 2026)

2026 年 7 月的竞争格局确认了 taskflow 的护城河：无竞品拥有跨运行备忘录化、零 token 静态验证、预算硬执行、锦标赛或收敛循环。但地面正在快速移动。CrewAI（44K★，60% Fortune 500）现在发布了 JSON/YAML 流程 DSL——这是对 taskflow 声明式作者定位的首次直接攻击。Google ADK 2.0 转向图优先架构，支持 5 种语言 GA、会话回退、以及内置人机交互原语——「纯代码优先」的差距已经缩小。Mastra 的 15+ 评分器框架已将 evals 差距扩大为**鸿沟**——taskflow 的单一 LLM gate 判决相比之下是原始的。子代理生成与工作树隔离现已成为所有编码代理主机的桌面筹码，侵蚀了「编码代理原生」的定位。战略命令：加倍投入竞品结构上无法实现的能力——需要图优先架构的声明式编排原语，而非附加在命令式代码上的 SDK 插件。

---

## 最终裁决 —— 如果只能做一件事

**Eval / Scorer Phase (#7)。**

直接针对单一最大竞争差距（严重性：HIGH，Report [2/4]）。扩展 taskflow 已有的 gate 优势。内置评分器是低风险的确定性纯函数；llm-judge 复用已有基础设施。Mastra 的 evals 鸿沟正在扩大——每个版本的延迟都使弥合更加困难。无其他候选具有 Impact 5 的证据支撑。
