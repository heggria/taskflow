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

Requires **Node.js ≥ 22.19.0**. The MCP protocol layer speaks JSON-RPC 2.0 over
stdio without `@modelcontextprotocol/sdk`; published delivery packages still
depend on the internal taskflow packages, and core peers on `typebox`.

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
claude mcp list      # → taskflow … (npx -y -p claude-taskflow@0.2.2 claude-taskflow-mcp)
```

The bundled skill tells Claude Code *when* to reach for the tools (multi-phase
or fan-out work), so you usually don't have to name them explicitly.

## Permissions (the codex-sandbox analogue)

Claude Code has no OS-level sandbox in headless (`-p`) mode — a tool call is
either whitelisted or denied. The runner maps each phase's tool whitelist the
same way the codex runner maps to a sandbox mode:

Taskflow requires Claude Code **2.1.169 or newer** for the `--safe-mode`
isolation contract. Older CLIs fail closed with an unknown-option error;
upgrade Claude Code before using the adapter.

- **Read-only or unspecified phase** (no mutating/unknown tool in the resolved
  phase/agent `tools`, including an omitted list) → matching `--tools` and
  `--allowedTools` lists. An explicit list remains narrow; omitted tools use
  `Read,Grep,Glob,WebFetch,WebSearch`. `--safe-mode` disables non-managed
  project/user customizations; disk setting sources and non-managed hooks are
  disabled as defense in depth. Administrator-managed policy hooks may still
  run. Mutating tools are denied outright. Note
  there is **no read-only shell** (unlike codex's read-only OS sandbox), so
  `Bash` is not granted.
- **Known mutating requested tool** → rejected by default. Headless Claude
  has no OS sandbox backstop, so silently selecting `bypassPermissions` is
  unsafe. A trusted operator may explicitly set
  `PI_TASKFLOW_CLAUDE_UNSAFE_BYPASS=1` to enable that mode. Even then, the
  requested built-in set stays narrow. Unknown tool names always fail closed.
  Use only trusted flows and prefer a throwaway worktree (`cwd: "worktree"`).

The spawned Claude process receives a filtered environment: platform/runtime,
proxy/CA, and Claude-supported provider variables (`ANTHROPIC_*`, Bedrock,
Vertex/Google, Azure/Foundry) are retained, while unrelated application secrets
such as npm tokens, database URLs, and other-provider API keys are not inherited.

## Long-running flows and the tool-call timeout

Foreground `taskflow_run` returns only after the **whole DAG finishes**. For a
long flow, pass `mode: "background"`: it returns a durable `runId` immediately
and continues independently of that MCP request. Use `taskflow_runs` with
`action: "status"`, `"wait"`, or `"cancel"`; `wait` is bounded by `timeoutMs`
and can be called repeatedly until the persisted final output is ready.
`action: "list"` reports total active concurrency and accepts
`status: "running" | "terminal"`; starting a sixth active background run warns
that no global cross-host concurrency/budget coordinator exists.

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
| `taskflow_run` | Run a saved or inline flow. Foreground returns the final output; `mode: "background"` returns a durable `runId` immediately. |
| `taskflow_runs` | List background runs or `status` / `wait` / `cancel` one by `runId`. |
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
| `taskflow_reconcile_workspace` | After inspecting or repairing a failed resolve-only invocation workspace, explicitly accept its current state and advance its generation. Requires host `TASKFLOW_WORKSPACE_RECONCILE_MODE=explicit`; does not restore files. |

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
> phase **auto-rejects** (fail-closed for the approval decision). Prefer a `gate` (agent review) in flows
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
