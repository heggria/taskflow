# Using taskflow from Claude Code (MCP)

taskflow runs on [Claude Code](https://claude.com/product/claude-code) in two
directions, both built on the host-neutral `SubagentRunner` seam
(`packages/taskflow-core/src/host/runner-types.ts`):

1. **Claude Code as the executor** — a taskflow's subagents run as `claude -p`
   sessions (`packages/taskflow-hosts/src/claude-runner.ts`).
2. **Claude Code as the caller** — taskflow is exposed to a Claude Code user as
   an **MCP server**, so the `taskflow_*` tools appear inside the session. The
   MCP protocol, tools, and rendering all live in the host-neutral taskflow-mcp-core package
   (`packages/taskflow-mcp-core/src/mcp/`); the claude adapter just binds them to
   the `claude -p` subagent runner (`packages/claude-taskflow/src/mcp/`). This
   is the direction described here.

The MCP server is dependency-free: it speaks JSON-RPC 2.0 over stdio on Node
built-ins (`packages/taskflow-mcp-core/src/mcp/jsonrpc.ts`), so taskflow keeps its
**zero runtime dependencies** guarantee — no `@modelcontextprotocol/sdk`.

## Install (recommended): the Claude Code plugin

The zero-config path. Install taskflow as a Claude Code **plugin** and its MCP
server plus a routing skill are registered automatically — no manual
`claude mcp add`, no config editing:

```sh
claude plugin marketplace add heggria/taskflow
claude plugin install claude-taskflow@taskflow
```

The plugin declares its MCP server via `npx` (a version-pinned
`claude-taskflow`), so the server is fetched and launched on demand — nothing
else to install globally, and the plugin version binds the exact code that runs.
Verify:

```sh
claude plugin list   # → claude-taskflow@taskflow  installed, enabled
claude mcp list      # → taskflow … (npx -y -p claude-taskflow@0.1.7 claude-taskflow-mcp)
```

The bundled skill tells Claude Code *when* to reach for the tools (multi-phase
or fan-out work), so you usually don't have to name them explicitly.

## Permissions (the codex-sandbox analogue)

Claude Code has no OS-level sandbox in headless (`-p`) mode — a tool call is
either whitelisted or denied. The runner maps each phase's tool whitelist the
same way the codex runner maps to a sandbox mode:

- **Read-only phase** (no `write`/`edit`/`bash` in the phase/agent `tools`) →
  `--allowedTools Read,Grep,Glob,WebFetch,WebSearch`. Mutating tools are denied
  outright. Note there is **no read-only shell** (unlike codex's read-only OS
  sandbox), so `Bash` is not granted to read-only phases.
- **Mutating phase** (or no whitelist at all) → `--permission-mode
  bypassPermissions`. This is the workspace-write equivalent, but **without an
  OS sandbox backstop** — the subagent can run any tool. Run flows you trust,
  in a repo you can `git reset`, ideally in a throwaway worktree
  (`cwd: "worktree"`).

## Long-running flows and the tool-call timeout

`taskflow_run` returns only after the **whole DAG finishes** — intermediate
phase outputs stay in the runtime, so from Claude Code's side it's a single tool
call that can run for many minutes. If a flow is genuinely huge, consider
splitting it into a few smaller `taskflow_run` calls so each returns promptly,
or run it in the background from a plain shell (`claude -p … &`) and inspect the
run afterward with `taskflow_peek`.

## Alternative: register the MCP server manually

If you'd rather not use the plugin, install the package and register its
`claude-taskflow-mcp` bin yourself:

```sh
pnpm add -g claude-taskflow
claude mcp add taskflow -- claude-taskflow-mcp
```

From a checkout of this repo (no install), point Claude Code at the built bin
instead:

```sh
pnpm run build
claude mcp add taskflow -- \
  node /abs/path/to/taskflow/packages/claude-taskflow/dist/mcp/bin.js
```

Verify it registered:

```sh
claude mcp list   # → taskflow … enabled
```

The server discovers saved flows and agents from its **launch cwd**, and each
subagent a flow spawns is itself a `claude -p` process — no pi process needed.

## Tools exposed

| Tool | What it does |
|------|--------------|
| `taskflow_run` | Run a saved flow (`name`) or an inline `define` (full DAG or shorthand `{task}`/`{tasks}`/`{chain}`). Returns only the final phase output + a `runId`. |
| `taskflow_list` | List saved flows discoverable from the cwd, now with library metadata (`purpose`, `generality`, `reuseCount`) when available. |
| `taskflow_show` | Show a saved flow as `{definition, library}` — the `library` object holds the sidecar metadata (`purpose`, `tags`, `generality`, `reuseCount`, `phaseSignature`, …). |
| `taskflow_save` | Save a flow to the library with optional `purpose`, `tags`, and `notes`. Writes the flow JSON plus a sidecar `.meta.json`. |
| `taskflow_search` | Search the library before authoring. Returns ranked reusable flows with score, why, and a reuse hint. Structural + CJK-aware keyword scoring; embedding is Phase 2. |
| `taskflow_verify` | Statically verify a flow (cycles, missing deps, undefined refs) — no execution. |
| `taskflow_compile` | Render a flow's DAG as a text outline + a compact status line (with an inline SVG image for clients that render images). |
| `taskflow_peek` | Inspect one phase's intermediate output from a stored run (post-hoc debugging). Hard-truncated, read-only. |
| `taskflow_trace` | Read-only timeline of a run's append-only event log (subagent I/O + runtime decisions). |
| `taskflow_replay` | Offline what-if on a recorded trace: re-judge thresholds/budget/models **without calling the model** (zero tokens). |
| `taskflow_why_stale` | Explain observed/declared dependency staleness for a run (optional seed `phaseId`). Zero tokens. |
| `taskflow_recompute` | Report the stale frontier for a seed phase (**dry-run only** over MCP — never spends tokens). |

## How output is rendered

Claude Code shows an MCP tool result's `text` content as monospace text in the
transcript. The taskflow tools are written to read well there (and in the Codex
plaintext box too — the rendering logic is shared in core):

- **Plain text, not markdown.** No ```` ``` ```` fences, no tables, no `###`
  headings. `taskflow_show` returns raw JSON (already monospaced).
- **Conclusion-first.** `taskflow_verify` puts the verdict + issue counts on
  line 1 (`✗ verification FAILED — 5 errors, 4 warnings`), details below.
- **Deduped issues.** N phases tripping the same rule collapse to one line with
  a phase list (`… (5 phases: a, b, c, d +1 more)`). Counts stay honest.
- **DAG as a text outline.** `taskflow_compile` returns the DAG grouped into
  topological layers, with deps, agents, `★` final and issue markers — plus an
  inline SVG image for clients that render images.

## Use it

Inside a Claude Code session, just ask — Claude will call the tools:

```
> List my saved taskflows.
> Verify this flow: {name:"x", phases:[{id:"a",type:"agent",agent:"writer",task:"draft"}]}
> Run the "release-train" taskflow.
```

> **Note on approvals.** MCP-driven runs are non-interactive, so an `approval`
> phase **auto-rejects** (fail-open). Prefer a `gate` (agent review) in flows
> you run through the `taskflow_*` tools; use `approval` only in flows a human
> runs interactively.

## Remove

```sh
claude plugin uninstall claude-taskflow@taskflow   # if installed as a plugin
claude mcp remove taskflow                          # if registered manually
```

## Proof / tests

- `pnpm run test:e2e-claude-mcp` — spawns `bin.ts` as Claude Code would and
  drives the full MCP handshake + tool calls over a real subprocess pipe (no
  live claude needed).
- `pnpm run test:e2e-claude` — runs a 2-phase flow whose subagents are real
  `claude -p` sessions (proves Claude-as-executor; data flows phase A → B).
  Requires an authenticated `claude` CLI.
- `packages/claude-taskflow/test/mcp-server.test.ts` — protocol + binding tests
  (in-memory streams).
- `packages/claude-taskflow/test/claude-runner.test.ts` — claude stream-json
  parser + permission mapping pinned against real captured events.
