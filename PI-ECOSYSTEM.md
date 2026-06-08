# The Pi Orchestration Landscape — Where pi-taskflow Stands (June 2026)

> Pi-internal competitive map. Verified against npm registry metadata + package
> READMEs, 2026-06-08. Companion docs: [`COMPETITORS.md`](./COMPETITORS.md) (cross-ecosystem),
> [`STRATEGY.md`](./STRATEGY.md) (surpass plan).
> `yes/no/static/fixed/partial/UNVERIFIED` used honestly; `UNVERIFIED` = docs/source insufficient.

## 1. How many, and what kinds

There are now **20+ Pi-ecosystem extensions** that claim orchestration / workflow /
subagent-delegation territory — far more than when this README was first written.
They fall into archetypes:

| Archetype | Representatives |
|---|---|
| **Delegation tools** (spawn/parallel/chain) | `pi-subagents`, `@gotgenes/pi-subagents` v14, `@melihmucuk/pi-crew`, `@mjakl/pi-subagent`, `@narumitw/pi-subagents`, `@dreki-gg/pi-subagent`, `@wkronmiller/pi-subagent-extension`, `@0xkobold/pi-orchestration` |
| **Role-teams** (worktrees + durable state) | `pi-crew`, `@rajeshkrishnamurthy/pi-workflow-team` |
| **Fixed-pipeline harnesses** (plan→execute→review) | `pi-pipeline`, `ultimate-pi`, `gentle-pi`, `@mediadatafusion/pi-workflow-suite`, `@tianhai/pi-workflow-kit`, `@fiale-plus/pi-orchestration`, `@fiale-plus/pi-rogue-orchestration` |
| **Script-driven workflow** (user writes JS) | `@zhushanwen/pi-workflow`, `pi-agent-flow` |
| **Full orchestrator** (opinionated multi-phase DAG) | `@pi-agents/orchid` |
| **Declarative DAG DSL** | **`pi-taskflow` — the only one** |

## 2. The Full Matrix

| Extension | Ver | Deps | Model | DSL | DAG | Fan-out | X-session resume | Gate | Approval | Save-cmd | Worktree | Loop |
|---|---|:--:|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **pi-taskflow** | 0.0.12 | **0** | per-phase override | **yes** | **yes** | **yes** `map` | **yes** (phase-hash) | **yes** | **yes** | **yes** `/tf:` | no | **no** |
| pi-subagents | 0.28.0 | 3 | 8 builtin agents | no | no | static | UNVERIFIED | no | clarify | named wf | no | yes (review max-rounds) |
| pi-crew | 0.6.1 | 7 | role teams | partial | yes | yes | yes (async manifest) | yes | yes | UNVERIFIED | **yes** | UNVERIFIED |
| pi-pipeline | 0.4.22 | 2 | active model | no | fixed | no | yes (session-plan) | yes | UNVERIFIED | UNVERIFIED | no | no |
| pi-agent-flow | 2.3.5 | 2 | none | yes (flow JSON) | no | no | UNVERIFIED | no | no | UNVERIFIED | no | no |
| @0xkobold/pi-orchestration | 0.3.0 | 0 | typed registry + auto-select | no | no | yes (chain/parallel/fork) | no | yes (review_loop) | yes | no | **yes** (3 modes) | no |
| @fiale-plus/pi-orchestration | 0.1.2 | 0 | none (session cmds) | no | no | no | yes (session state) | no | no | no | no | yes (declarative `/loop`, no timer) |
| @fiale-plus/pi-rogue-orchestration | 0.1.17 | 0 | none | no | no | no | yes (loop state + history) | yes (goal-check) | no | no | no | **yes** (real setInterval loop) |
| @pi-agents/orchid | 0.1.0-β2 | 2 | agent prefs + override | **yes** (9-phase) | **yes** (wave sched) | **yes** | **yes** (batch state) | **yes** | **yes** (mailbox) | yes | **yes** (worktree.ts) | **yes** (Ralph loop) |
| @wkronmiller/pi-subagent-extension | 0.1.0 | 0 | inherits parent | no | no | no | yes (run records + events) | no | yes (mailbox) | no | no | no |
| @mediadatafusion/pi-workflow-suite | 0.0.11 | 3 | per-role model/thinking | no | no | UNVERIFIED | yes (mode persist) | **yes** (PASS/PARTIAL/FAIL) | **yes** | yes | no | yes (repair/retry) |
| @tianhai/pi-workflow-kit | 0.17.1 | 0 | active model | no | no | no | no | yes (checkpoint gates) | yes (pause) | yes (slash cmds) | no | no |
| @zhushanwen/pi-workflow | 0.2.2 | 0 | `agent({model})` | **yes** (JS API) | no (linear chain) | **yes** (`parallel()`) | **yes** (8-state + JSONL + call cache) | no | no | yes (call cache) | no | no |
| @rajeshkrishnamurthy/pi-workflow-team | 0.1.3 | 0 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| @dreki-gg/pi-subagent | 0.9.1 | 0 | 10 agents, per-run override | no | no | no | partial (fork-at clone) | no | per-agent | no | no | partial (prove-before-fix) |
| @melihmucuk/pi-crew | 1.0.20 | 0 | 6 agents, override | no | no | yes (manual spawn) | **yes** (survives /new /resume /fork) | no | no | partial | no | partial (multi-turn) |
| @gotgenes/pi-subagents | 14.0.1 | 1 | fuzzy haiku/sonnet | no | no | no | **yes** (resume by agent ID) | no | per-agent | no | **yes** (auto-commit branches) | no |
| @narumitw/pi-subagents | 0.1.37 | 1 | inherits | no | no | no | no | no | per-agent | no | no | no |
| @mjakl/pi-subagent | 2.1.0 | 0 | per-agent frontmatter | no | no | no | no | no | per-agent | no | no | no |
| ultimate-pi | 0.26.0 | **16** | dedicated harness agents | yes (YAML contracts) | **yes** (plan-time) | no | **yes** (active-run + trace) | **yes** (3-tier) | **yes** | **yes** (`/harness-auto`) | no | **yes** (steer loop) |
| gentle-pi | 0.4.5 | 1 | per-agent routing UI | yes (OpenSpec SDD) | no (sequential) | no | **yes** (artifact model) | **yes** (blind dual review) | **yes** | partial | no | **yes** (SDD apply→verify→sync) |

## 3. Where pi-taskflow leads the Pi ecosystem TODAY

1. **The only declarative DAG DSL with dynamic fan-out.** No other extension lets you
   describe a DAG in JSON, have the runtime own the topology, and fan out over a
   runtime-discovered list via `map`. `@pi-agents/orchid` has DAG + fan-out but the DSL
   is a fixed 9-phase pipeline, not a user-defined graph; `ultimate-pi` validates a DAG
   at plan-time but exposes no user-facing graph DSL.
2. **The only package combining DAG + gate + approval + budget + save-as-cmd + zero deps.**
   `@mediadatafusion` (3 deps) and `ultimate-pi` (16 deps) get gate+approval+save but
   have no user-definable DAG DSL.
3. **The only phase-level input-hash cross-session resume.** Everyone else resumes by
   session/state serialization or by subagent ID. Only pi-taskflow hashes *each phase's
   inputs* and skips completed phases — change one leaf, resume, and only that leaf +
   downstream re-run.
4. **Context isolation as a design pillar.** Only the final phase reaches your
   conversation; intermediate transcripts are withheld from the LLM. Others return
   results inline or to the parent session.
5. **Lowest ceremony-to-power ratio among feature-rich packages.** 0 deps, one install,
   no bootstrap — vs. `pi-crew` (`/team-init` + 7 deps), `orchid` (113 files + jiti),
   `ultimate-pi` (16 deps), `gentle-pi` (OpenSpec discipline).

## 4. Where other Pi extensions beat pi-taskflow (brutal honesty)

| Capability | Who beats us | How |
|---|---|---|
| **Loop-until-done** | `@fiale-plus/pi-rogue` (real setInterval), `@pi-agents/orchid` (Ralph loop), `ultimate-pi` (steer loop) | we have no iterative convergence loop |
| **Git-worktree isolation** | `pi-crew`, `@gotgenes` v14 (auto-commit branches), `orchid`, `@0xkobold` (3 modes) | we share one repo checkout |
| **Non-blocking async** | `@melihmucuk/pi-crew`, `pi-crew` v0.6 | we block the parent during a run (single long tool call) |
| **Install base & maturity** | `@gotgenes` v14, `pi-subagents` v0.28, `@mjakl` v2 | many versions, production users; we're v0.0.12 |
| **Governed harness depth** | `ultimate-pi` (3-tier gate, knowledge graph, forensic trace, incident recording) | our `gate` is a single PASS/BLOCK |
| **TDD enforcement** | `@tianhai/pi-workflow-kit`, `gentle-pi` (RED→GREEN→TRIANGULATE→REFACTOR) | we have no methodology opinion |
| **Mid-run steering** | `@gotgenes` (inject messages), `ultimate-pi` | we run to completion or halt on gate/approval |
| **Agent-to-agent messaging** | `@pi-agents/orchid`, `@wkronmiller` (mailbox) | phases share data via result map; no agent↔agent messaging |
| **Review-loop automation** | `pi-subagents` (max-rounds), `@dreki-gg` (worker→reviewer→validator) | our gates halt but don't auto-retry upstream |
| **Community size** | `@gotgenes` (14 majors), `gentle-pi` (companion packages) | solo-maintainer project |

## 5. The unique 1-line positioning

> **pi-taskflow is the only Pi extension that gives you a declarative, resumable,
> DAG-shaped subagent pipeline you save as a one-word command — with zero runtime
> dependencies and context isolation by design.**

No other extension can truthfully claim *all five*: (1) declarative JSON DSL,
(2) runtime-owned DAG topology, (3) cross-session resume with phase-hash caching,
(4) save-as-`/tf:<name>`, (5) zero runtime deps. The closest each miss ≥2: `orchid`
(fixed pipeline, 2 deps, no user DSL); `ultimate-pi` (16 deps, heavy ceremony);
`pi-crew` (7 deps, team-init bootstrap).

## 6. Threats to watch

| Threat | Why it's dangerous | Urgency | Countermove |
|---|---|:--:|---|
| **`@melihmucuk/pi-crew`** | non-blocking async is the UX users actually want; our blocking run is the biggest UX gap. Add DAG+save and it eats our lunch | **med-high** | prioritize detached child-process execution + `/tf status` polling |
| **`@fiale-plus/pi-rogue`** | real loop-until-done (our #1 missing feature). Add subagent spawning and it's a lightweight autonomous runtime | **high** | ship a DAG-integrated `loop` phase (re-feed output→input until `doneWhen`), not a raw timer |
| **`@zhushanwen/pi-workflow`** | 0 deps + `agent()/parallel()/pipeline()` JS DSL + real cross-session resume + call cache; updated 2026-06-08, closest in spirit. Add a DAG engine and it's a direct competitor | **med** | lean into "the safe, auditable DSL"; phase-hash resume is more granular than call-cache dedup |
| **`@0xkobold/pi-orchestration`** | cleanest architecture: typed registry, 3-mode worktree, chain/parallel/fork. Add DAG+resume and it occupies our niche with worktrees already shipped | **med** | we already have DAG+resume; treat worktree isolation as a pre-emptive v2 feature |
| **`@pi-agents/orchid`** | most feature-complete (DAG+worktree+Ralph loop+mailbox). Once stable + slimmed it's a superset of our surface | **low** (beta, heavy) | stay lighter, faster to install, more auditable — 0 deps is the antidote |

## 7. Open decisions

1. **Loop-until-done shape** — DAG-native `loop` phase (`doneWhen` re-feed) vs. timer-based periodic retrigger? Both defensible; the `loop` phase is more in keeping with the declarative ethos.
2. **Worktree isolation** — required or out of scope? Four competitors ship it. Candidate: a `worktree` phase field.
3. **Non-blocking execution** — v2 priority vs. loop/static-verification? Two competitors prove users want it.
4. **Static verification depth** — beyond TypeBox schema validation, add dead-phase/unreachable/budget-overflow analysis (see STRATEGY.md #2).
5. **DSL vs scripts** — is JSON DSL the defensible differentiator, or should we also offer a script mode (the `@zhushanwen` approach)?

---
*All cells grounded in npm metadata + package READMEs as of 2026-06-08. Re-run the
`pi-ecosystem-matrix` taskflow to refresh — the ecosystem moves fast.*
