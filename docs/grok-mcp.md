# Using taskflow from Grok Build (MCP)

taskflow runs on [Grok Build](https://docs.x.ai/build/overview) in two
directions, both built on the host-neutral `SubagentRunner` seam
(`packages/taskflow-core/src/host/runner-types.ts`):

1. **Grok Build as the executor** — a taskflow's subagents run as
   `grok -p --output-format streaming-json` sessions
   (`packages/taskflow-hosts/src/grok-runner.ts`).
2. **Grok Build as the caller** — taskflow is exposed to a Grok Build user as
   an **MCP server**, so the `taskflow_*` tools appear inside the session. The
   MCP protocol, tools, and rendering all live in the host-neutral
   `taskflow-mcp-core` package (`packages/taskflow-mcp-core/src/mcp/`); the
   grok adapter just binds them to the Grok subagent runner
   (`packages/grok-taskflow/src/mcp/`). This is the direction described here.

The MCP server is dependency-free: it speaks JSON-RPC 2.0 over stdio on Node
built-ins (`packages/taskflow-mcp-core/src/mcp/jsonrpc.ts`), so taskflow keeps its
**zero runtime dependencies** guarantee — no `@modelcontextprotocol/sdk`.

Official Grok docs used for this integration:

- Plugins: `~/.grok/docs/user-guide/09-plugins.md` / [docs.x.ai skills & plugins](https://docs.x.ai/build/features/skills-plugins-marketplaces)
- MCP servers: `~/.grok/docs/user-guide/07-mcp-servers.md`
- Headless / streaming-json: `~/.grok/docs/user-guide/14-headless-mode.md`

## Install (recommended): the Grok Build plugin

The zero-config path once `grok-taskflow` is on npm. Install the plugin and its
MCP server plus a routing skill are registered automatically:

```sh
# From the published package / marketplace entry (when available):
grok plugin install <source> --trust
# e.g. local checkout (skills + plugin manifest):
grok plugin install /abs/path/to/taskflow/packages/grok-taskflow/plugin --trust
grok plugin enable taskflow   # plugins may be disabled until enabled
```

The plugin declares its MCP server via `npx` (a version-pinned
`grok-taskflow`), so the server is fetched and launched on demand when the
package is published. Verify:

```sh
grok plugin list   # → taskflow  installed / enabled
grok plugin details taskflow
grok mcp list      # → taskflow …
grok inspect       # plugins + MCP + skills with source labels
```

The bundled skill tells Grok *when* to reach for the tools (multi-phase or
fan-out work), so you usually don't have to name them explicitly. In the TUI,
open `/plugins` or `/mcps` to inspect components.

### From a monorepo checkout (dogfood / pre-publish)

Until `grok-taskflow` is published to npm, point MCP at the **built** local bin
(plugin install still gives you the skill + manifest):

```sh
cd /path/to/taskflow
pnpm install
pnpm --filter taskflow-core build
pnpm --filter taskflow-mcp-core build
pnpm --filter taskflow-hosts build
pnpm --filter grok-taskflow build

grok plugin install ./packages/grok-taskflow/plugin --trust
grok plugin enable taskflow

# Local stdio MCP (overrides / complements npx until publish):
grok mcp add taskflow -- \
  node "$(pwd)/packages/grok-taskflow/dist/mcp/bin.js"
```

Optional: raise startup timeout for cold `npx` (when using the published form):

```toml
# ~/.grok/config.toml
[mcp_servers.taskflow]
startup_timeout_sec = 60
tool_timeout_sec = 1800
```

## Permissions (the codex-sandbox analogue)

The runner always selects a Grok kernel sandbox profile and maps each phase's
tool whitelist as follows:

- **Read-only phase** (no `write`/`edit`/`bash` / `run_terminal_cmd` /
  `search_replace` in the phase/agent `tools`) → a known-good
  kernel-enforced `--sandbox read-only`, a
  `--tools read_file,grep,list_dir` allowlist, an independent
  `--disallowed-tools` mutator denylist, `--deny Bash/Edit/Write/MCPTool`, and
  `--no-subagents`. `--always-approve` then applies only to the surviving
  read-only tools. Grok 0.2.93 treats `web_search` / `web_fetch` as unmappable
  allowlist entries and can restore the full toolset, so those two tools are
  deliberately unavailable in a read-only phase until the CLI fixes that
  fail-open behavior.
- **Mutating phase** (or no whitelist) → kernel-enforced `--sandbox workspace`
  plus `--always-approve`. All tools remain available, but filesystem writes
  are confined to the phase cwd plus Grok's documented temp/session paths
  (`/tmp`, `/var/tmp`, platform temp directories, and `~/.grok/`). Reads and
  network remain available. Prefer `cwd: "worktree"` for disposable changes.

Both sandbox profiles cover the whole Grok process and spawned tools on
macOS/Linux. The independent built-in/MCP denies are also required for
read-only phases because that profile deliberately permits session writes under
temporary directories; together they keep a read-only phase non-mutating even
when its workspace itself is under `/tmp`. A live executor E2E additionally
proves that the workspace profile permits an in-cwd write and rejects a marker
outside the cwd and documented exceptions.

Agent system prompts are passed with `--rules`. Model ids that look like
unresolved `{{placeholders}}`, multi-segment openrouter paths, or pi thinking
suffixes (`:xhigh`) are dropped so Grok uses its configured default.
Effective Taskflow thinking is passed as `--reasoning-effort` (`off` maps to
`none`).

### Budget limitation

Grok 0.2.93 does not include token or cost usage in its `streaming-json`
events. Consequently the Grok-bound MCP server **refuses any flow that declares
`budget`**; accepting it would advertise a ceiling the runtime cannot enforce.
Unbudgeted flows still run normally. Use another host when a hard token/USD
ceiling is required.

## Long-running flows and the tool-call timeout

`taskflow_run` returns only after the **whole DAG finishes** — intermediate
phase outputs stay in the runtime, so from Grok's side it's a single tool call
that can run for many minutes. The plugin's `.mcp.json` ships
`tool_timeout_sec: 1800` (30 minutes). For huge flows, split into a few smaller
`taskflow_run` calls. MCP does not expose Pi's detached-run mode. If the client
sends `notifications/cancelled` (including after a tool timeout), the server
aborts the active DAG and subagent instead of leaving hidden background work.

## Alternative: register the MCP server manually

```sh
pnpm add -g grok-taskflow
grok mcp add taskflow -- grok-taskflow-mcp
```

Or with npx (no global install):

```sh
grok mcp add taskflow -- npx -y -p grok-taskflow@0.2.0 grok-taskflow-mcp
```

Verify:

```sh
grok mcp list
grok mcp doctor taskflow
```

The server discovers saved flows and agents from its **launch cwd**, and each
subagent a flow spawns is itself a `grok -p` process — no pi process needed.

## Tools exposed

| Tool | What it does |
|------|--------------|
| `taskflow_run` | Run a saved flow (`name`) or an inline `define` (full DAG or shorthand `{task}`/`{tasks}`/`{chain}`). Returns only the final phase output + a `runId`. |
| `taskflow_list` | List saved flows discoverable from the cwd, with library metadata when available. |
| `taskflow_show` | Show a saved flow as `{definition, library}`. |
| `taskflow_save` | Save a flow to the library with optional `purpose`, `tags`, and `notes`. |
| `taskflow_search` | Search the library before authoring. |
| `taskflow_verify` | Statically verify a flow — no execution, zero tokens. |
| `taskflow_compile` | Render a flow's DAG as a text outline (+ inline SVG when the client renders images). |
| `taskflow_peek` | Inspect one phase's intermediate output from a stored run. Hard-truncated, read-only. |
| `taskflow_trace` | Read-only timeline of a run's append-only event log (subagent I/O + runtime decisions). |
| `taskflow_replay` | Offline what-if on a recorded trace: re-judge thresholds/budget/models **without calling the model** (zero tokens). |
| `taskflow_why_stale` | Explain observed/declared dependency staleness for a run (optional seed `phaseId`). Zero tokens. |
| `taskflow_recompute` | Report the stale frontier for a seed phase (**dry-run only** over MCP — never spends tokens). |

Grok namespaces MCP tools as `taskflow__taskflow_*` in some UIs; discover with
`search_tool` then call via `use_tool`.

## Use it

Inside a Grok Build session (TUI or headless), just ask:

```
> List my saved taskflows.
> Verify this flow: {name:"x", phases:[{id:"a",type:"agent",agent:"writer",task:"draft"}]}
> Run the "release-train" taskflow.
```

Headless smoke (after MCP is registered):

```sh
grok -p "Call taskflow_verify on this define (do not run it):
{name:'dogfood', phases:[{id:'a', type:'agent', agent:'executor', task:'noop', final:true}]}" \
  --always-approve --output-format json
```

> **Note on approvals.** MCP-driven runs are non-interactive, so an `approval`
> phase **auto-rejects** (fail-closed for the approval decision). Prefer a `gate` (agent review) in flows
> you run through the `taskflow_*` tools; use `approval` only in flows a human
> runs interactively.

## Remove

```sh
grok plugin uninstall taskflow    # if installed as a plugin
grok mcp remove taskflow          # if registered manually
```

## Proof / tests

- `pnpm run test:grok` — MCP binding unit tests (in-memory streams).
- `pnpm run test:e2e-grok-mcp` — spawns `bin.ts` over a real subprocess pipe
  (no live Grok model needed).
- `packages/taskflow-hosts/test/grok-args.test.ts` — pure argv contract
  (`buildGrokArgs`) locked for CI.
- `packages/taskflow-hosts/test/grok-runner.test.ts` — streaming-json parser
  pinned to the official headless event shape.
- `grok plugin validate packages/grok-taskflow/plugin` — official manifest
  validator (skills + MCP components).
