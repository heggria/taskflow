# pi-taskflow vs the Broader Agent-Orchestration Landscape (June 2026)

> Cross-ecosystem comparison (beyond Pi). For the Pi-internal comparison see
> [`PI-ECOSYSTEM.md`](./PI-ECOSYSTEM.md); for strategy see [`STRATEGY.md`](./STRATEGY.md).
> Researched via live web search; `UNVERIFIED` = not confirmed in fetched sources.
> Values: `YES` confirmed · `PARTIAL` exists with limits · `NO` absent · `PLANNED` roadmap.

## Full Matrix

| Framework | Orchestration model | Authoring | Durable / resume | Dynamic fan-out | Human-in-loop | Quality gate | Static verification | Cross-run memoization | Observability | Deps | Uniquely good at |
|---|---|---|---|:--:|:--:|:--:|:--:|:--:|---|:--:|---|
| **▼ LOCAL / EMBEDDED DAG DSL** |||||||||||
| **pi-taskflow** | Declarative JSON-DSL DAG (12 phase types) | JSON data | phase-level input-hash cache + cross-session resume | **YES** (`map`) | YES (approval) | YES (verdict) | NO (planned) | **YES** | basic (live DAG render; no OTel) | **ZERO** | zero-dep declarative subagent DAG; phase-hash caching; when-guards; budget caps; loop·tournament·race·expand·cross-run cache |
| **▼ GRAPH / STATE-MACHINE** |||||||||||
| LangGraph | StateGraph nodes/edges + Pregel super-steps | Python/JS code | checkpointer every super-step; time travel | YES (`Send`) | YES (`interrupt()` any node) | NO builtin | YES (`.compile()` + typed state) | within-session only | YES (LangSmith) | heavy | checkpoint durability + time travel; largest community |
| Google ADK | Directed graph + agent-tree hierarchy | Python/JS/Go/Java/Kotlin | durable memory; event-driven dormancy | YES | YES (any-node) | YES (safety framework) | YES (inferred from graph compile) | UNVERIFIED | YES (builtin logs/metrics/traces) | medium | multi-language agent-tree hierarchy; first-class delegation |
| **▼ ROLE / TEAM-BASED** |||||||||||
| CrewAI | role-goal-backstory sequential/hierarchical | Python SDK | PARTIAL (no auto-recovery per Diagrid) | PARTIAL | YES (builtin HITL) | UNVERIFIED | UNVERIFIED | UNVERIFIED | YES (rich tracing + OTel) | light | fastest prototyping; 44K★; 60% Fortune-500 adoption |
| AutoGen / AG2 | async actor + group-chat | Python SDK | NO (maintenance mode) | PARTIAL | PARTIAL (user proxy) | UNVERIFIED | UNVERIFIED | UNVERIFIED | NO (prototype-grade) | medium | research-style agent conversations; 58K★ |
| MS Agent Framework | graph superstep/Pregel | .NET/Python SDK | PARTIAL (superstep snapshot) | YES | YES (RequestPort + resume) | UNVERIFIED | PARTIAL (topology SHA-256) | UNVERIFIED | YES (Azure Foundry + OTel) | heavy | unified AutoGen+SK successor; A2A/AG-UI/MCP; GA Apr 2026 |
| **▼ DURABLE EXECUTION** |||||||||||
| Temporal | event-sourced Workflow + Activity | TS/Py/Go/Java/Ruby/C#/PHP | **GOLD STANDARD** — replay from snapshot; exactly-once | YES (child workflows) | YES (Signals, awaits indefinitely) | UNVERIFIED | PARTIAL (determinism checks) | UNVERIFIED | YES (UI + OpenMetrics + OTel) | heavy | industrial durability at scale (OpenAI Codex, Replit, Cursor) |
| Inngest AgentKit | event-driven durable functions + Network/Router | TypeScript | YES (each step persisted; resume from failed step) | YES (code router + LLM routing) | UNVERIFIED | UNVERIFIED | minimal (Zod) | UNVERIFIED | YES (dashboard + traces) | medium-light | TS-native agent networking; React streaming; MCP first-class |
| Mastra | step-engine + autonomous agents | TypeScript (Vercel AI SDK) | YES (`suspend()`/`resume()`; snapshot; time-travel) | YES | **first-class** (`suspend`/`resume`/`bail` typed) | **YES** (`@mastra/evals` scorers) | PARTIAL (Zod) | UNVERIFIED | YES (Studio UI) | light | batteries-included TS framework; first-class evals; ~25K★, 300K+ wk dl |
| **▼ PLATFORM SDKs / LOW-CODE** |||||||||||
| OpenAI Agents SDK | agent handoff (tool delegation) | Python SDK | YES (session backends) | UNVERIFIED (1:1 handoff) | YES | PARTIAL (guardrails/tripwires) | UNVERIFIED | UNVERIFIED | YES (builtin tracing) | light | first-party handoffs; tight OpenAI integration; guardrails |
| Dify | visual builder; single-agent + RAG (multi-agent not GA) | low-code canvas | UNVERIFIED | YES (branches) | PARTIAL | UNVERIFIED | UNVERIFIED | UNVERIFIED | YES (dashboard + cost) | heavy | visual AI-app builder + integrated RAG |
| n8n AI Agents | event-driven automation; AI = 1 node of 400+ | low-code nodes | YES (state persisted; retry from failure) | YES (Split-in-Batches) | YES (Wait node) | UNVERIFIED | UNVERIFIED | PARTIAL (data pinning + cache node) | YES (execution history) | moderate | general automation; 400+ integrations |
| AWS Bedrock multi-agent | hierarchical supervisor-collaborator | console + IaC | PARTIAL (managed state) | YES (supervisor→collaborators) | YES (confirmation prompts) | **YES** (per-agent guardrails) | UNVERIFIED | UNVERIFIED | YES (CloudWatch + X-Ray) | heavy | fully-managed enterprise multi-agent; native guardrails |

## Where pi-taskflow is already differentiated TODAY

1. **Zero dependencies.** Every competitor needs at minimum an SDK package; most need a server/DB/cloud.
2. **Declarative-as-data authoring.** The entire DAG is data → programmatic generation, diffing, and static reasoning without execution. Competitors are code-first or visual.
3. **Phase-level input-hash caching.** Precise invalidation: unchanged inputs → cached outputs. LangGraph checkpoints super-steps but doesn't content-address phases.
4. **Quality gate verdict as a first-class DAG phase** (not an eval add-on or a safety filter).
5. **Budget caps per phase** with hard enforcement (others only *track* usage).

## Where competitors currently beat pi-taskflow

| Capability | Winner | Our gap |
|---|---|---|
| Gold-standard durability (event-sourcing, crash recovery, exactly-once) | Temporal | session resume only; mid-phase crash may re-execute |
| Node-level checkpoint + time-travel | LangGraph | phase-level only |
| Evaluation/scoring framework | Mastra (`@mastra/evals`) | verdicts but no eval framework to produce them |
| Visual low-code builder | Dify, n8n | JSON-DSL only |
| Fast prototyping with role metaphor | CrewAI | JSON authoring, no role abstraction |
| Built-in guardrails | OpenAI Agents SDK, Bedrock | gate but no inline guardrails |
| Multi-language agents | Google ADK, Temporal | TS/Node only |
| Managed enterprise deployment | AWS Bedrock | self-hosted |
| Production observability (OTel/Prometheus) | most | live DAG render only |
| Community & ecosystem | CrewAI/AutoGen/Mastra | niche project |

## White space nobody owns yet (surpass targets)

| # | White space | State across all competitors | Our opportunity |
|---|-------------|------------------------------|-----------------|
| 1 | **Zero-token static DAG verification** | none has a dead-phase/unreachable/ref analyzer that runs without an LLM | ship `verify` — structural correctness for 0 tokens |
| 2 | **Cross-run memoization keyed on phase input hash** | nobody (Temporal=within-run, LangGraph=within-session) | `cache` — **✅ shipped** (git/glob/file/env fingerprints, TTL, LRU eviction) |
| 3 | **Declarative-as-data multi-target compilation** | nobody (all runtime-coupled) | "LLVM of agent orchestration" — compile one DSL to many runtimes |
| 4 | **Typed human-approval verdict schemas** | most have generic pause/approve | formalize verdict outcomes + auto-routing |
| 5 | **Budget-aware DAG with hard enforcement** | all track, none enforce | budget pools + pre-flight cost estimation |
| 6 | **Subagent-native orchestration** | none targets a coding agent's internal subagent pipeline | defensible specialization for Pi's AGENTS.md routing |
| 7 | **Worktree-isolated phase execution** | none isolates per-phase filesystem | worktree-per-phase with explicit merge |
| 8 | **Tournament/bracket pattern** | none has rank-and-promote | `tournament` phase type — **✅ shipped** |
| 9 | **Loop-until-done with convergence detection** | LangGraph has cycles, none has declarative convergence loop | `loop` phase type — **✅ shipped** (until+convergence+maxIterations) |

## Key Insights

- **Nobody owns cross-run memoization** — pi-taskflow shipped it (`cache` → persistent store with fingerprint guards); nobody else has equivalent.
- **Temporal is the only true durability** — we don't need to match it; Mastra-level suspend/resume + phase-hash caching is enough for subagent orchestration.
- **The visual-builder gap is real but may not matter** for our target users (Pi subagent operators).
- **Multi-target compilation is the deepest moat** — competitors are runtime-coupled and structurally can't do it.

---
*All cells grounded in public docs/blogs as of 2026-06-08. No private docs or live testing. Diagrid's March 2026 durability analysis applies: only Temporal offers true Durable Execution.*
