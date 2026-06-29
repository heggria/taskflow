# Using pi-taskflow from Codex (MCP)

pi-taskflow runs on [Codex](https://github.com/openai/codex) in two directions,
both built on the host-neutral `SubagentRunner` seam
(`packages/taskflow-core/src/host/runner-types.ts`):

1. **Codex as the executor** — a taskflow's subagents run as `codex exec`
   sessions (`packages/codex-taskflow/src/codex-runner.ts`).
2. **Codex as the caller** — taskflow is exposed to a Codex user as an **MCP
   server**, so the `taskflow_*` tools appear inside codex
   (`packages/codex-taskflow/src/mcp/`). This is the direction described here.

The MCP server is dependency-free: it speaks JSON-RPC 2.0 over stdio on Node
built-ins (`packages/codex-taskflow/src/mcp/jsonrpc.ts`), so pi-taskflow keeps its
**zero runtime dependencies** guarantee — no `@modelcontextprotocol/sdk`.

## Register with Codex

Install the package, then register its `codex-taskflow-mcp` bin:

```sh
npm install -g codex-taskflow
codex mcp add taskflow -- codex-taskflow-mcp
```

From a checkout of this repo (no install), point Codex at the built bin instead:

```sh
npm run build
codex mcp add taskflow -- \
  node /abs/path/to/pi-taskflow/packages/codex-taskflow/dist/mcp/bin.js
```

Verify it registered:

```sh
codex mcp list   # → taskflow … enabled
```

The server discovers saved flows and agents from its **launch cwd**, and each
subagent a flow spawns is itself a `codex exec` process — no pi process needed.

## Tools exposed

| Tool | What it does |
|------|--------------|
| `taskflow_run` | Run a saved flow (`name`) or an inline `define` (full DAG or shorthand `{task}`/`{tasks}`/`{chain}`). Returns only the final phase output. |
| `taskflow_list` | List saved flows discoverable from the cwd. |
| `taskflow_show` | Show a saved flow's definition as JSON. |
| `taskflow_verify` | Statically verify a flow (cycles, missing deps, undefined refs) — no execution. |
| `taskflow_compile` | Render a flow as a Mermaid diagram + verification report. |

## Use it

Inside a codex session, just ask — codex will call the tools:

```
> List my saved taskflows.
> Verify this flow: {name:"x", phases:[{id:"a",type:"agent",agent:"writer",task:"draft"}]}
> Run the "release-train" taskflow.
```

> **Note on approvals.** In non-interactive `codex exec`, MCP tool calls require
> approval; pass `--dangerously-bypass-approvals-and-sandbox` for unattended
> automation (only in an already-sandboxed environment). Interactive `codex`
> prompts for approval normally.

## Remove

```sh
codex mcp remove taskflow
```

## Proof / tests

- `npm run test:e2e-codex-mcp` — spawns `bin.ts` as codex would and drives the
  full MCP handshake + tool calls over a real subprocess pipe.
- `npm run test:e2e-codex` — runs a 2-phase flow whose subagents are real codex
  sessions (proves Codex-as-executor; data flows phase A → B).
- `test/mcp-server.test.ts` — protocol + dispatch unit tests (in-memory streams).
- `test/codex-runner.test.ts` — codex JSONL parser pinned against real captured
  events.
