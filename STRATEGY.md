# Beyond Dynamic Workflows: A Surpass Strategy for pi-taskflow

> Internal strategy doc. Synthesized from a multi-phase research + brainstorm run
> (4 parallel web-research agents → strategist → skeptic gate → synthesis),
> verified against live sources June 2026. Companion docs:
> [`COMPETITORS.md`](./COMPETITORS.md) (cross-ecosystem), [`PI-ECOSYSTEM.md`](./PI-ECOSYSTEM.md) (Pi-internal).

## 1. The Thesis

Claude Code's dynamic workflows are **JavaScript closures** — you execute them, you
observe results, but the workflow definition itself is opaque to deterministic
tooling. pi-taskflow's **declarative JSON DSL** is *structured data*. A DAG expressed
as structured data can be **statically analyzed** before any token is spent,
**deterministically replayed** without re-execution, **memoized across runs** by hash
lookup rather than LLM reasoning, and **compiled to multiple artifacts** (Mermaid,
OTel span templates, CI YAML) from a single source of truth. Claude bans `Date.now()`
to control non-determinism; pi-taskflow can **embrace non-determinism and capture it**
for replay and forensics. This wedge — *declarative structure over imperative script*
— is the foundation for every move below.

## 2. The Category-Defining Bet: the **Structurally Verifiable** Workflow

> **pi-taskflow is the first agent orchestrator whose workflow structure is verifiable
> by deterministic algorithms — not by running the workflow and hoping.**

| Stage | What happens | Tokens |
|-------|--------------|:------:|
| **Compile-time** | Dead-end phases, gate exhaustion, flow-ref integrity, concurrency topology warnings, trivial guard contradictions — caught by graph algorithms on the DAG | **0** |
| **Pre-execution** | Graph-position cache key per phase; cross-run memoization index consulted; matched phases reused instantly | **0 (cache hit)** |
| **Execution** | Declarative criteria (schema conformance, path containment, structural invariants) evaluated **before** the LLM gate agent runs; the LLM handles only the qualitative residue | **gate only** |
| **Post-execution** | Event-sourced trace replays the run deterministically; change a gate threshold / budget and replay against cached data | **0** |

No framework does all four. LangGraph has checkpointing but no static verification and
no cross-run memoization. Temporal has event-sourced replay but workflows are imperative
code you can't statically analyze. Claude's JS scripts are structurally opaque.

**The qualifier matters.** "Structurally verifiable" = we can prove DAG integrity,
reference soundness, and gate completeness — *not* that the LLM won't hallucinate. The
tagline is **Structurally Verifiable**, never unqualified "provable".

## 3. Strategic Moves — Ranked

| # | Idea | Attacks | Why pi-taskflow wins | Effort | Surpasses Claude? |
|---|------|---------|----------------------|:------:|:-----------------:|
| 1 | **Graph-position caching** — key = `phaseId(upstreamKeys):inputHash` | map fan-out cache collisions, best-of-N cache pollution | DAG position is explicit & computable at runtime; lives inside existing `hashInput`/`cachedPhase` | **S** | **Y** |
| 2 | **Static structural verification** (dead-ends, gate exhaustion, flow refs, concurrency warnings, trivial contradictions) | 41.8% of multi-agent failures are spec/coordination errors (MAST); Claude has zero static checks | `validateTaskflow()` already does cycle detection + ref checks; the rest is graph-algorithmic on existing output | **S** | **Y** |
| 3 | **Cross-run memoization** (global cache index keyed on phase input hash) | Claude/LangGraph don't share state across sessions | file-based store is inherently shareable & inspectable; needs #1 | **S** | **Y** |
| 4 | **Declarative eval gates** + `onBlock: "retry"` (retry upstream on fail, not halt) | 21.3% of failures are in verification/termination (MAST) | machine-checkable criteria run *before* the LLM gate; `onBlock:retry` is genuinely new control flow | **M** | **Y** |
| 5 | **Deterministic replay** from append-only event trace | Agent Reproducibility Paradox; Claude resume is session-scoped only | `PhaseState` already captures inputHash/output/usage/model; upgrade to JSONL event trace, replay against recorded responses | **L** | **Partial** (Temporal replays workflow code; we replay agent decisions) |
| 6 | **OpenTelemetry GenAI export** (optional peerDependency; no-op when absent) | observability gaps; Claude has no external tracing | already collect timing/tokens/status/agent/model per phase; custom `taskflow.*` span attributes | **S** | **Y** |
| 7 | **Multi-target DSL compilation** (Mermaid + verification report + OTel template now; CNCF/GH-Actions later) | workflows trapped in framework-specific code | JSON DSL compiles to many artifacts from one source; source hash enables drift detection | **M** | **Partial** |
| 8 | **Best-of-N with late binding** (spawn N, take best K) — rescoped from speculative pruning | brute-force parallel blows up cost | runtime owns scheduling; graph-position keys keep pruned branches out of cache | **XL→M** | **Partial** |
| 9 | **Model routing / cost optimization** (cheap phases → cheap models) | per-phase cost is known; nobody auto-routes | runtime already tracks `usage` + enforces caps; add a `route` hint | **S** | n/a |
| 10 | **Workflow template library** (4–6 battle-tested `.tf.json`) | patterns re-implemented per project | dogfoods the `flow` sub-workflow type; reduces adoption friction | **S** | n/a |

## 4. Capability Gaps to Close First (all naturally declarative)

| Gap | pi-taskflow approach | Effort |
|-----|----------------------|:------:|
| **Loop-until-done** | new `loop` phase: `"until": "{steps.X.output.done}==true"` + `maxIterations` + convergence detection | M |
| **Tournament** | new `tournament` phase: N variants compete, a judge sub-phase picks `best`/`aggregate` | M |
| **Worktree isolation** | `"cwd": "temp"`/`"dedicated"` per phase; runtime creates & destroys an isolated dir | M |
| **Security quarantine** | per-phase `"tools": {"allow":[...], "deny":[...]}` (depends on pi core tool-restriction API) | S (if pi supports) |
| **Saga/compensation** | `compensate` phase triggered on upstream failure, reverse order | L (defer) |

## 5. Three-Horizon Roadmap

- **H1 — Verifiable Foundation (~4 wks):** graph-position caching → static verification → loop-until-done → cross-run memoization → OTel export → model routing. *Outcome: the only orchestrator with static DAG verification + cross-run memoization + OTel.*
- **H2 — Quality & Portability (~4 wks):** declarative eval gates (`onBlock:retry`) → tournament → worktree → Mermaid+verification compilation → template library.
- **H3 — Research Frontier (~6 wks):** deterministic replay → best-of-N late binding → quarantine → saga (deferred).

## 6. Honest Risks & Where Others Still Win

- **Zero-dep vs OTel/JSON-Schema tension** → resolve via **optional peerDependencies** (zero-deps at rest, opt-in at runtime). Don't hand-roll OTLP.
- **Claude still wins:** IDE integration, serverless execution, single-`.js` simplicity, Opus model quality.
- **LangGraph still wins:** node-level checkpoint + time-travel (we're phase-level only).
- **Temporal still wins:** event-sourced durability + exactly-once at scale (we're a local orchestrator).
- **Biggest threat:** if Claude ships loops + tournaments + static analysis first, the "structured DAG" narrative erodes. The wedge is only defensible if we ship H1 fast — their imperative model makes static analysis *harder*, which is our time window.

---
*Every capability claim is grounded against existing code; nothing is invented. Update as the landscape moves.*
