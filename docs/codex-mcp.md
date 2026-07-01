# Using taskflow from Codex (MCP)

taskflow runs on [Codex](https://github.com/openai/codex) in two directions,
both built on the host-neutral `SubagentRunner` seam
(`packages/taskflow-core/src/host/runner-types.ts`):

1. **Codex as the executor** — a taskflow's subagents run as `codex exec`
   sessions (`packages/codex-taskflow/src/codex-runner.ts`).
2. **Codex as the caller** — taskflow is exposed to a Codex user as an **MCP
   server**, so the `taskflow_*` tools appear inside codex
   (`packages/codex-taskflow/src/mcp/`). This is the direction described here.

The MCP server is dependency-free: it speaks JSON-RPC 2.0 over stdio on Node
built-ins (`packages/codex-taskflow/src/mcp/jsonrpc.ts`), so taskflow keeps its
**zero runtime dependencies** guarantee — no `@modelcontextprotocol/sdk`.

## Install (recommended): the Codex plugin

The zero-config path. Install taskflow as a Codex **plugin** and its MCP server
plus a routing skill are registered automatically — no manual `codex mcp add`,
no config editing:

```sh
codex plugin marketplace add heggria/taskflow
codex plugin add taskflow@taskflow
```

The plugin declares its MCP server via `npx` (a version-pinned `codex-taskflow`),
so the server is fetched and launched on demand — nothing else to install
globally, and the plugin version binds the exact code that runs. Verify:

```sh
codex plugin list   # → taskflow@taskflow  installed, enabled
codex mcp list      # → taskflow … enabled  (npx -y -p codex-taskflow@0.1.2 codex-taskflow-mcp)
```

The bundled skill tells Codex *when* to reach for the tools (multi-phase or
fan-out work), so you usually don't have to name them explicitly.

## Long-running flows and the tool-call timeout

`taskflow_run` returns only after the **whole DAG finishes** — intermediate
phase outputs stay in the runtime, so from Codex's side it's a single tool call
that can run for many minutes. Codex applies a per-server MCP **tool-call
timeout**; if the call outlives it, Codex abandons the result client-side even
though the run keeps executing server-side.

To stop large flows from being cut off, the plugin's `.mcp.json` ships a
30-minute default:

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "npx",
      "args": ["-y", "-p", "codex-taskflow@0.1.2", "codex-taskflow-mcp"],
      "tool_timeout_sec": 1800
    }
  }
}
```

Override it per machine in `~/.codex/config.toml` (this wins over the plugin
default):

```toml
[mcp_servers.taskflow]
tool_timeout_sec = 3600
```

If a flow is genuinely huge, also consider splitting it into a few smaller
`taskflow_run` calls so each returns well inside the window.

## Alternative: register the MCP server manually

If you'd rather not use the plugin, install the package and register its
`codex-taskflow-mcp` bin yourself:

```sh
npm install -g codex-taskflow
codex mcp add taskflow -- codex-taskflow-mcp
```

From a checkout of this repo (no install), point Codex at the built bin instead:

```sh
npm run build
codex mcp add taskflow -- \
  node /abs/path/to/taskflow/packages/codex-taskflow/dist/mcp/bin.js
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
| `taskflow_compile` | Render a flow's DAG as a **diagram** (an inline SVG image, shown by the desktop app) **plus a text outline** (shown by the CLI/TUI, which can't render images) + a compact status line. Very large graphs return the text outline alone. |

## How output is rendered (Codex desktop app)

The Codex desktop app renders an MCP tool result's `text` content blocks as a
fixed **plaintext `<pre>` box**: no markdown parsing, no syntax highlighting,
wrapped on whitespace, capped at ~192px tall with an inner scrollbar and
labeled *plaintext*. Rich rendering (`structuredContent` / `_meta`) is reserved
for Codex's first-party "Apps" server, so a third-party MCP server can't opt in.

The taskflow tools are written for that box:

- **Plain text, not markdown.** No ```` ``` ```` fences, no tables, no `###`
  headings — they'd show as literal characters. `taskflow_show` returns raw JSON
  (already monospaced), not a fenced block.
- **Conclusion-first.** `taskflow_verify` puts the verdict + issue counts on
  line 1 (`✗ verification FAILED — 5 errors, 4 warnings`), details below, so the
  short box leads with what matters.
- **Deduped issues.** N phases tripping the same rule collapse to one line with
  a phase list (`… (5 phases: a, b, c, d +1 more)`) instead of N near-identical
  lines. Counts stay honest (the raw total, not the collapsed line count).
- **Diagrams as images, with a text fallback.** Codex's **desktop app** renders
  an `image` block (`<img src="data:…">`), so `taskflow_compile` hand-renders
  the DAG to a dependency-free **SVG** and returns it as an image — an actual
  picture, not Mermaid source. Node color mirrors the static audit (red = error,
  amber = warning, green border = final); a dotted edge is `join:any`. The
  **CLI/TUI** can't render images (it prints a bare `<image content>`
  placeholder), so the same result also carries a self-sufficient **text
  outline** — the DAG grouped into topological layers, with deps, agents, `★`
  final and issue markers — which the terminal shows and a vision-less model can
  read. Oversized graphs skip the image and return the text outline alone.

The portable Mermaid + markdown artifact still exists in core
(`compileTaskflow`) for GitHub/PR use; the SVG is a codex-only presentation
layer (`packages/codex-taskflow/src/mcp/svg.ts`).

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
codex plugin remove taskflow@taskflow   # if installed as a plugin
codex mcp remove taskflow               # if registered manually
```

## Proof / tests

- `npm run test:e2e-codex-mcp` — spawns `bin.ts` as codex would and drives the
  full MCP handshake + tool calls over a real subprocess pipe.
- `npm run test:e2e-codex` — runs a 2-phase flow whose subagents are real codex
  sessions (proves Codex-as-executor; data flows phase A → B).
- `test/mcp-server.test.ts` — protocol + dispatch unit tests (in-memory streams).
- `test/codex-runner.test.ts` — codex JSONL parser pinned against real captured
  events.
