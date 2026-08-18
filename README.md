<div align="center">

<img src="./assets/hero.png" alt="taskflow 0.3: trusted effects for coding-agent workflows" width="100%">

<br />

[![CI](https://img.shields.io/github/actions/workflow/status/heggria/taskflow/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/heggria/taskflow/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-35C99A?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-35C99A?style=flat-square)](./LICENSE)
[![Hosts](https://img.shields.io/badge/hosts-6-7775FF?style=flat-square)](#host-adapters)

**English** · [简体中文](./README.zh-CN.md)

[0.3 overview](#taskflow-03-trusted-effects) · [Quickstart](#quickstart) · [Docs](https://heggria.github.io/taskflow/en/docs) · [Examples](./examples) · [Changelog](./CHANGELOG.md)

</div>

---

# taskflow 0.3: make agent side effects inspectable

**taskflow is a declarative runtime for coding-agent workflows.** It turns a graph into a verifiable execution contract, runs phases in isolation, and keeps intermediate work out of the host conversation. In the 0.3 candidate, the contract also describes the effects a phase is allowed to propose.

> **Status: 0.3.0-beta.2 — beta channel, not GA.** Ships the Trusted Effects MVP plus a Control Plane slice: Unix UDS ControlHost listen/attach (S2) and a files-only project ControlStore (S3-min). Wire contracts remain **PROPOSED**. `taskflow-control` is workspace-only until a later 11-package decision. Does **not** implement `#137` (`/tf web`) or `#95` (adaptive-authority isolation).

## The 0.3 idea

An agent can propose content. It should not become the mutation authority merely because it can run a command.

For admitted, declared filesystem-write targets, taskflow 0.3 makes the path explicit and routes the final mutation through the resources transaction:

```text
flow / .tf.ts
       │
       ▼
  validate + verify ──► EffectIR + FlowIR hash
       │                         │
       │                         ▼
       │                 admit declared targets
       │                         │
       ▼                         ▼
  isolated phase ───────► stage → commit | restore + reject
                                      │
                                      ▼
                          ledger-backed why-effect
```

This is **not** an OS sandbox. Resolve-only hosts cannot prevent every write to an undeclared path. Secret and service references are typed and fail closed in this cut; they do not imply a vault or network backend.

## What is in the candidate

| Layer | What it does | Candidate status |
|---|---|---|
| **Taskflow runtime** | Declarative DAGs, 12 phase types, budgets, retries, approvals, isolation, resume, replay, trace, and recompute | Existing 0.2 foundation |
| **Trusted Effects** | Closed `EffectIR`, `PathRef` / `SecretRef` / `ServiceRef`, confidentiality/integrity labels, effect validation, overlap checks, and ledger-backed `why-*` explainers | 0.3 MVP implementation |
| **Resource transaction** | Snapshot → lease → durable intent/permit → stage → commit, or restore and reject | 0.3 MVP implementation |
| **Host adapters** | Pi, Codex, Claude Code, OpenCode, Grok Build, and Hermes Agent use the same flow contract | Existing host surface; support remains host-specific |
| **Control Plane** | ControlHost scaffold, proposed wire contracts, singleton/fencing, and hello negotiation; future stores, approvals, receipts, and coordination | Active 0.3-C track; not shipped and not the 0.3 MVP GA claim |
| **WebUI** | Runs, approvals, receipts, and evidence browsing | Planned in the 0.3-C sequence; not shipped in this candidate |

The normative MVP definition is [`docs/internal/0.3.0-trusted-effects-mvp.md`](./docs/internal/0.3.0-trusted-effects-mvp.md). The 0.3-C Control Plane plan is [`docs/internal/0.3-c-control-plane-plan.md`](./docs/internal/0.3-c-control-plane-plan.md).

## Quickstart

The 0.3 beta can be installed from npm, or exercised from a clean source checkout. Use Node.js **≥ 22.19.0**:

```bash
git clone https://github.com/heggria/taskflow.git
cd taskflow
git checkout rc/0.3.0-trusted-effects
pnpm install
pnpm run typecheck
pnpm test
```

The beta commands below become usable after the tag workflow completes; until then they are release-target examples, not proof of registry availability.
```bash
npm install --global pi-taskflow@beta
npm install --global codex-taskflow@beta
```

The host-specific plugin and MCP commands remain in the [host guides](https://heggria.github.io/taskflow/en/docs/guides/). Stable 0.2.x installs remain available through exact stable pins.

Run the no-LLM Trusted Effects vertical-slice fixture:

```bash
pnpm exec node --conditions=development --experimental-strip-types --test \
  packages/taskflow-core/test/effects-e2e-fixture.test.ts
```

This exercises the checked-in `examples/trusted-effects-write.json` path without a live LLM. For an interactive run, use the host guide for the adapter you already run. The stable 0.2 installation path remains documented separately in the [host guides](https://heggria.github.io/taskflow/en/docs/guides/).

## Declare an effect

Effects are part of the flow contract, not a free-form prompt promise:

```json
{
  "name": "trusted-effects-write",
  "phases": [
    {
      "id": "write-report",
      "type": "script",
      "run": ["node", "scripts/render-report.mjs"],
      "effects": [
        {
          "id": "report",
          "kind": "fs.write",
          "purpose": "write final report",
          "target": {
            "kind": "path",
            "path": {
              "workspace": "project",
              "subpath": { "literalPath": "out/report.md" },
              "intent": "create-file"
            }
          },
          "confidentiality": "internal",
          "integrity": "project"
        }
      ],
      "final": true
    }
  ]
}
```

The declaration is not authorization by itself. The runtime resolves the `PathRef`, checks labels and overlaps, records the resource intent, and only then permits the transaction to stage and finalize the declared target. `taskflow_why_effect` explains the resulting authorization and ledger state without model calls.

## The runtime contract

The 0.2 runtime remains the foundation. A flow can be authored as portable JSON or compiled from TypeScript DSL to FlowIR:

```text
JSON / .tf.ts
      │
      ▼
validate → Taskflow JSON → FlowIR + content hash
                                  │
                                  ▼
                         isolated DAG runtime
                                  │
                   resume · replay · recompute · trace
                                  │
                                  ▼
                         finalOutput to the host
```

## One runtime, 12 phase types

| Family | Phases | Use them for |
|---|---|---|
| **Work** | `agent` · `parallel` · `map` · `reduce` · `script` | Single tasks, static concurrency, dynamic fan-out, aggregation, and zero-token shell steps |
| **Control** | `gate` · `approval` · `flow` · `loop` | Quality decisions, human checkpoints, composition, and iterative refinement |
| **Selection** | `tournament` · `race` | Best-of-N quality or first-success latency |
| **Dynamic graph** | `expand` | Validate and execute a runtime-produced nested or grafted fragment |

Across those phase types, the runtime provides shared behavior: dependencies, conditions, retries, timeouts, output contracts, budgets, workspace isolation, explicit final-output selection, and persistence for resume. Each phase kind accepts only the fields that are safe and meaningful for it.

Useful zero-token operations include:

| Operation | Question it answers |
|---|---|
| `taskflow_plan` | What will run, what arguments bind, and what is the worst-case agent-call bound? |
| `taskflow_verify` / `taskflow_compile` | Is the graph structurally valid and what is its canonical form? |
| `taskflow_trace` / `taskflow_replay` | What happened, or what would a zero-token what-if replay decide? |
| `taskflow_why_stale` / `taskflow_recompute` | What changed and what is the smallest affected frontier? |
| `taskflow_why_effect` | Why was a declared effect allowed, staged, committed, rejected, or left unknown? |
| `taskflow_analytics` | How have recent runs behaved? |

The MCP surface currently exposes **20 tools**. Intermediate transcripts remain inside the runtime unless you explicitly inspect them with `peek` or `trace`; the host normally receives only `finalOutput`.

## Host adapters

The same flow contract can be delivered through six coding-agent hosts:

- **Pi** — native extension, `/tf` commands, live run views, and interactive approvals.
- **Codex** — plugin and stdio MCP server.
- **Claude Code** — plugin and stdio MCP server.
- **OpenCode** — MCP configuration and generated skill.
- **Grok Build** — MCP configuration and generated skill.
- **Hermes Agent** — MCP delivery with explicit child toolsets and isolation policy.

Host support is not a blanket security guarantee. Read the [host support baseline](./conformance/workspace/host-support-baseline.json) and the [Trusted Effects documentation](./docs/internal/0.3.0-trusted-effects-mvp.md) before enabling mutating phases.

## Security boundaries we state plainly

- `effects[]` is a declaration and validation surface; it is not ambient authority.
- The resources layer is the only finalizer for admitted declared filesystem effects.
- Direct writes to declared targets are detected and restored by the MVP path.
- Writes to undeclared paths remain host-policy dependent under resolve-only execution.
- `SecretRef` and `ServiceRef` are typed handles only; no vault or live service adapter ships in this cut.
- There is no FileBroker or full OS sandbox claim in 0.3 MVP.
- Control Plane stores, approvals, receipts, and WebUI are future 0.3-C stages, not proof that 0.3 is released or GA.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run build:website
pnpm run test:pack
```

The monorepo contains the host-neutral `taskflow-core`, Trusted Effects and resources code, the `taskflow-control` 0.3-C contract package, the TypeScript DSL, MCP/host adapters, examples, and the website. See [`AGENTS.md`](./AGENTS.md) for architecture and coding conventions.

## Documentation

| Start here | Use it for |
|---|---|
| [0.3 overview](https://heggria.github.io/taskflow/en/docs) | Candidate scope, status, and the honest security boundary |
| [Getting Started](https://heggria.github.io/taskflow/en/docs/getting-started) | First flow and host setup |
| [Core Concepts](https://heggria.github.io/taskflow/en/docs/concepts/) | DAGs, isolation, verification, resume, and evidence |
| [Compiler & Runtime](https://heggria.github.io/taskflow/en/docs/compiler-runtime/) | JSON, TypeScript DSL, FlowIR, replay, and recompute |
| [Host Guides](https://heggria.github.io/taskflow/en/docs/guides/) | Pi, Codex, Claude Code, OpenCode, Grok, and Hermes |
| [Examples](./examples) | Runnable flow definitions, including Trusted Effects |
| [Changelog](./CHANGELOG.md) | Release history and candidate notes |

## License

[MIT](./LICENSE) © [heggria](https://github.com/heggria)

<div align="center">

**Declare the effect. Verify the path. Commit through one authority.**

[Read the docs](https://heggria.github.io/taskflow/en/docs) · [Try the candidate](#quickstart) · [View releases](https://github.com/heggria/taskflow/releases)

</div>
