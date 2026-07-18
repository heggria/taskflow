<div align="center">

<img src="./assets/hero.png" alt="taskflow: compile, verify, and run multi-agent DAGs across five coding-agent hosts" width="100%">

<br />

[![npm](https://img.shields.io/npm/v/pi-taskflow?style=flat-square&color=7775FF&label=npm)](https://www.npmjs.com/package/pi-taskflow)
[![CI](https://img.shields.io/github/actions/workflow/status/heggria/taskflow/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/heggria/taskflow/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-35C99A?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-35C99A?style=flat-square)](./LICENSE)
[![Hosts](https://img.shields.io/badge/hosts-5-7775FF?style=flat-square)](#install-on-your-host)
[![Tests](https://img.shields.io/badge/tests-1%2C500%2B-7775FF?style=flat-square)](#built-to-survive-real-work)

**English** · [简体中文](./README.zh-CN.md)

[Install](#install-on-your-host) · [Quickstart](#60-second-start) · [What's new in 0.2](#02-is-the-compiler-turn) · [Docs](https://heggria.github.io/taskflow/en/docs) · [Examples](./examples)

</div>

---

# Build multi-agent systems you can inspect before they run.

**taskflow turns agent plans into compiled task graphs**: declared once, verified before model spend, executed in isolated subagents, resumed across sessions, replayed without tokens, and recomputed from the smallest stale frontier.

It runs on the coding agent you already use:

**Pi · Codex · Claude Code · OpenCode · Grok Build**

```text
JSON or .tf.ts
      │
      ▼
 validate ──► Taskflow JSON ──► FlowIR + content hash
                                      │
                                      ▼
                           isolated DAG runtime
                                      │
                         ┌────────────┼────────────┐
                         ▼            ▼            ▼
                      resume        replay      recompute
```

> Your host receives the final result. Intermediate transcripts stay inside the runtime unless you explicitly inspect them.

## Why taskflow?

Built-in subagent tools are excellent for one turn. The moment the work branches, retries, crosses sessions, or needs a quality gate, the plan becomes infrastructure.

| | Ad-hoc agents / scripts | **taskflow** |
|---|---|---|
| **Plan** | Re-derived from prose or hidden in a script | **An explicit, versionable DAG** |
| **Before execution** | Discover mistakes while spending | **Verify structure at zero model calls** |
| **Intermediate output** | Floods the host context | **Stays isolated in the runtime** |
| **Failure** | Start over or reconstruct state | **Resume from persisted phase state** |
| **Changed input** | Re-run broadly | **Explain staleness and re-run the affected frontier** |
| **Portability** | Coupled to one agent | **One JSON contract across five hosts** |

The trade is deliberate: less arbitrary orchestration code, more **verifiability, observability, recovery, and reuse**.

## 60-second start

Install taskflow on [Pi](https://pi.dev):

```bash
pi install npm:pi-taskflow
```

Then ask naturally:

> Use taskflow to audit `src/api` in parallel and return one prioritized report.

The routing skill uses the same familiar `task` / `tasks` / `chain` shape:

```json
{
  "chain": [
    { "agent": "scout", "task": "Map the public API under src/api." },
    {
      "agent": "security-reviewer",
      "task": "Audit this surface for missing auth and unsafe input boundaries:\n{previous.output}"
    },
    {
      "agent": "reviewer",
      "task": "Turn these findings into one prioritized report:\n{previous.output}"
    }
  ]
}
```

That already gives you an isolated, tracked run. When the job needs real topology, declare the graph:

```json
{
  "name": "audit-api",
  "args": { "dir": { "default": "src/api" } },
  "concurrency": 4,
  "phases": [
    {
      "id": "discover",
      "type": "agent",
      "agent": "scout",
      "task": "List source files under {args.dir}. Output ONLY a JSON array of {\"path\":\"...\"} objects.",
      "output": "json"
    },
    {
      "id": "audit-each",
      "type": "map",
      "over": "{steps.discover.json}",
      "as": "file",
      "agent": "security-reviewer",
      "task": "Audit {file.path}. Cite evidence and assign severity.",
      "dependsOn": ["discover"]
    },
    {
      "id": "report",
      "type": "reduce",
      "from": ["audit-each"],
      "agent": "reviewer",
      "task": "Synthesize one prioritized report:\n{steps.audit-each.output}",
      "dependsOn": ["audit-each"],
      "final": true
    }
  ]
}
```

Save it as `.pi/taskflows/audit-api.json`, then run:

```text
/tf:audit-api dir=src/api
```

On Codex, Claude Code, OpenCode, and Grok Build, run the same saved definition by name through `taskflow_run`. For long DAGs, use `mode: "background"`, then manage the durable run with `taskflow_runs` (`status` / `wait` / `cancel`).

[Follow the full quickstart →](https://heggria.github.io/taskflow/en/docs/getting-started)

## See the graph run

This is real output from a Pi run—not a mock dashboard:

```text
⊗ taskflow self-improve  6/7 · blocked · $0.095
    ✓ discover            agent   deepseek-v4-flash  10t ↑38k ↓6.7k $0.011
  ┌ ✓ write-runner-tests  agent   claude-sonnet-4-6  10t ↑13 ↓6.6k $0.020
  ├ ✓ write-store-tests   agent   claude-sonnet-4-6  10t ↑11 ↓10k $0.018
  ├ ✓ write-agents-tests  agent   claude-sonnet-4-6  10t ↑28 ↓13k $0.030
  └ ✓ fix-stability       agent   claude-sonnet-4-6  10t ↑13 ↓3.9k $0.012
    ✓ verify              gate    BLOCK 3 type errors in test files
    ⊘ report              reduce  skipped · Gate blocked  ↳ fix-stability
```

The layout **is** the DAG. Parallel rails expose concurrency; long edges expose dependencies; the gate explains why downstream work stopped. No separate control plane is required to understand the run.

## 0.2 is the compiler turn

Before 0.2, taskflow executed declarative graphs. Now the graph also has a compile-time frontend, a canonical intermediate representation, an append-only decision trace, offline replay, and incremental recompute.

### Author in JSON or TypeScript

JSON remains the portable runtime contract. For larger flows, `taskflow-dsl` adds a compile-time TypeScript authoring layer:

```ts
import { agent, flow, json, map, reduce } from "taskflow-dsl";

export default flow("audit", (ctx) => {
  ctx.budget({ maxUSD: 2 });

  const files = agent("List files under {args.dir}", {
    agent: "scout",
    output: json<{ path: string }[]>(),
  });

  const audits = map(files, (file) =>
    agent(`Audit ${file.path}`, { agent: "security-reviewer" }),
  );

  return reduce(
    [audits],
    (parts) => agent(`Write one report:\n${parts.audits.output}`),
    { final: true },
  );
});
```

```bash
pnpm add -D taskflow-dsl
taskflow-dsl check audit.tf.ts
taskflow-dsl build audit.tf.ts --emit both
# → audit.taskflow.json + audit.flowir.json
```

`.tf.ts` is **compile-time only**. Hosts execute the emitted Taskflow JSON; they never interpret TypeScript.

### Compile to a contract you can reason about

FlowIR canonicalizes the graph and gives it a content hash. That compiled identity makes provenance and stale analysis inspectable, while the runtime adds content-addressed caching and deterministic tools:

| Operation | What it answers | Model calls |
|---|---|---:|
| `verify` / `compile` | Is the graph structurally safe to run? | **0** |
| `ir` | What is the canonical graph and content hash? | **0** |
| `resume` | What unfinished work remains? (forks a new run; original untouched) | Only unfinished phases |
| `trace` | What calls and runtime decisions actually happened? | **0** to inspect |
| `replay` | What if thresholds or budgets had been different? | **0** |
| `why-stale` | What changed, and what depends on it? | **0** |
| `recompute` | What is the smallest observable affected frontier? | Only affected phases |

[Explore the compiler and runtime →](https://heggria.github.io/taskflow/en/docs/compiler-runtime/)

## One runtime, 12 phase types

| Family | Phases | Use them for |
|---|---|---|
| **Work** | `agent` · `parallel` · `map` · `reduce` · `script` | Single tasks, static fan-out, dynamic fan-out, aggregation, zero-token shell steps |
| **Control** | `gate` · `approval` · `flow` · `loop` | Quality decisions, human checkpoints, composition, iterative refinement |
| **Selection** | `tournament` · `race` | Best-of-N quality or first-success latency |
| **Dynamic graph** | `expand` | Validate and execute a runtime-produced fragment, nested or grafted |

Across those phase types, the DSL provides dependencies, conditions, retries, timeouts, output contracts, budgets, workspace isolation, and explicit final-output selection. Each kind accepts only the fields that are safe and meaningful for it; freshness-sensitive phases are excluded from cross-run caching.

[Read the phase reference →](https://heggria.github.io/taskflow/en/docs/syntax/phase-types)

## Runtime guarantees, not prompt conventions

### Verify before spend

Cycles, dangling dependencies, invalid references, impossible joins, unsafe dynamic fragments, and configuration hazards are rejected or surfaced before the expensive work starts.

### Keep intermediate work out of the host context

Agent-running phases execute in isolated subagent processes; control and script phases stay inside the runtime. Upstream outputs are wired into downstream inputs internally. Only `finalOutput` returns to the host unless you explicitly use `peek` or `trace`.

### Survive sessions and failures

Phase state is persisted atomically. Resume skips unchanged completed work; detached Pi runs can outlive the initiating session; an idle watchdog terminates stalled subagents.

### Reuse work honestly

Within-run resume is content-addressed. Cross-run caching is opt-in and can fingerprint Git commits, files, globs, environment variables, and TTLs. Change one declared input and only its dependents become stale.

### Bound the blast radius

Budgets, concurrency caps, retries, timeouts, nesting limits, dynamic-graph breadth caps, path containment, non-idempotent phase classification, and fail-closed approval behavior are runtime semantics—not suggestions in a prompt.

### 0.2.1: safe dynamic cwd and Pi terminal reaping

An invocation argument declared as `type: "relative-path"` may select a phase
working directory with the exact form `cwd: "{args.package}"`. The bridge is
default-off, requires host `resolve-only` authorization, and confines the
canonical directory to the invocation root. Absolute paths, concatenation, and
`{steps.*}` remain rejected; this compatibility bridge is not an OS sandbox.
Resolve-only writer phases within one invocation are serialized before durable
lease acquisition, so fan-out cannot self-timeout while separate processes
remain protected by cross-process leases.

Pi child agents no longer inherit ambient extensions by default. Trusted host
settings can use an explicit extension allowlist or opt back into legacy
inheritance. If a Pi child produces a validated final answer and terminal event
but an extension keeps the process alive, Taskflow waits a bounded grace window,
reaps the process group, and records `completionSource: "terminal-reap"` instead
of reporting a false timeout.

```json
{
  "taskflow": {
    "piChild": {
      "resourceProfile": "isolated",
      "extensions": [],
      "terminalGraceMs": 1500
    }
  }
}
```

`allowlist` accepts explicit trusted extension files; `inherit` restores ambient
Pi extension discovery as a compatibility mode. Flows cannot widen this host
authority.

[Read the core concepts →](https://heggria.github.io/taskflow/en/docs/concepts/)

## Install on your host

All packages require **Node.js ≥ 22.19.0**.

### Pi

```bash
pi install npm:pi-taskflow
```

Pi provides the richest local experience: the `taskflow` tool, `/tf` commands, live DAG rendering, interactive approvals, background runs, and model-role setup.

[Pi guide →](https://heggria.github.io/taskflow/en/docs/guides/pi)

### OpenAI Codex

```bash
codex plugin marketplace add heggria/taskflow
codex plugin add taskflow@taskflow
```

[Codex guide →](https://heggria.github.io/taskflow/en/docs/guides/codex)

### Claude Code

```bash
claude plugin marketplace add heggria/taskflow
claude plugin install claude-taskflow@taskflow
```

[Claude Code guide →](https://heggria.github.io/taskflow/en/docs/guides/claude-code)

### OpenCode

```bash
opencode mcp add taskflow -- \
  npx -y -p opencode-taskflow@0.2.2 opencode-taskflow-mcp
```

[OpenCode guide →](https://heggria.github.io/taskflow/en/docs/guides/opencode)

### Grok Build

```bash
grok mcp add taskflow -- \
  npx -y -p grok-taskflow@0.2.2 grok-taskflow-mcp
```

Grok Build support is new in 0.2. Its CLI stream does not report token/cost usage, so budget-declaring flows are rejected rather than silently running without enforcement.

[Grok Build guide →](https://heggria.github.io/taskflow/en/docs/guides/grok-build)

## Built to survive real work

<div align="center">

**9 packages** · **5 hosts** · **12 phase types** · **18 built-in agents** · **1,500+ tests** · **MIT**

</div>

```text
                              taskflow-core
                 ┌──────────────┼───────────────┐
                 │              │               │
           taskflow-dsl   pi-taskflow   taskflow-mcp-core ─┐
                                       taskflow-hosts ─────┼─ codex-taskflow
                                                          ├─ claude-taskflow
                                                          ├─ opencode-taskflow
                                                          └─ grok-taskflow
```

`taskflow-core` is host-neutral and imports no host SDK. `taskflow-mcp-core` implements stdio JSON-RPC without an MCP SDK dependency; `taskflow-hosts` owns the shared host process runners. The four MCP delivery packages bind both layers (and core), while Pi keeps its native adapter.

The test suite covers orchestration semantics, persistence and file-lock races, cache freshness, path traversal, dynamic graph hardening, cancellation, budgets, all 12 phase kinds, FlowIR/replay/recompute, TypeScript DSL erasure, host argv contracts, MCP servers, and packed consumer imports.

## Documentation

| Start here | When you need |
|---|---|
| [Getting Started](https://heggria.github.io/taskflow/en/docs/getting-started) | Your first successful run |
| [Concepts](https://heggria.github.io/taskflow/en/docs/concepts/) | DAGs, isolation, verification, resume, shared context |
| [Syntax](https://heggria.github.io/taskflow/en/docs/syntax/) | Phase fields, control flow, budgets, caching, scorers |
| [Compiler & Runtime](https://heggria.github.io/taskflow/en/docs/compiler-runtime/) | TypeScript DSL, FlowIR, replay, recompute, background runs |
| [Host Guides](https://heggria.github.io/taskflow/en/docs/guides/) | Pi, Codex, Claude Code, OpenCode, and Grok setup |
| [Reference](https://heggria.github.io/taskflow/en/docs/reference/) | Commands, shorthand, and exact tool surfaces |
| [Showcase](https://heggria.github.io/taskflow/en/docs/showcase/) | Real flows and case studies |

Also see [`examples/`](./examples), the [changelog](./CHANGELOG.md), and the [release guide](./RELEASE.md).

## Contributing

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run test:pack
```

Contributions are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the workflow and [`AGENTS.md`](./AGENTS.md) for architecture and coding conventions.

## License

[MIT](./LICENSE) © [heggria](https://github.com/heggria)

<div align="center">

**Declare once. Verify first. Recompute only what changed.**

[Read the docs](https://heggria.github.io/taskflow/en/docs) · [Try an example](./examples) · [View releases](https://github.com/heggria/taskflow/releases)

</div>
