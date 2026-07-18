# Using taskflow from OpenCode (MCP)

taskflow runs on [OpenCode](https://opencode.ai) in two directions, both built
on the host-neutral `SubagentRunner` seam
(`packages/taskflow-core/src/host/runner-types.ts`):

1. **OpenCode as the executor** — a taskflow's subagents run as `opencode run`
   sessions (`packages/taskflow-hosts/src/opencode-runner.ts`).
2. **OpenCode as the caller** — taskflow is exposed to an OpenCode user as an
   **MCP server**, so the `taskflow_*` tools appear in the session. The MCP
   protocol, tools, and rendering all live in the host-neutral taskflow-mcp-core package
   (`packages/taskflow-mcp-core/src/mcp/`); the opencode adapter just binds them to
   the `opencode run` subagent runner (`packages/opencode-taskflow/src/mcp/`).
   This is the direction described here.

Requires **Node.js ≥ 22.19.0**. The MCP protocol layer speaks JSON-RPC 2.0 over
stdio without `@modelcontextprotocol/sdk`; published delivery packages still
depend on the internal taskflow packages, and core peers on `typebox`.

## Install: register the MCP server

OpenCode has no git-based plugin marketplace, so you register the MCP server
directly — either with the CLI:

```sh
opencode mcp add taskflow -- npx -y -p opencode-taskflow opencode-taskflow-mcp
```

…or by adding an `mcp` entry to your project (or global) `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "taskflow": {
      "type": "local",
      "command": ["npx", "-y", "-p", "opencode-taskflow", "opencode-taskflow-mcp"],
      "enabled": true
    }
  },
  "skills": {
    "paths": ["./node_modules/opencode-taskflow/plugin/skills"]
  }
}
```

The `command` runs via `npx` (a version-pinned `opencode-taskflow`), so the
server is fetched and launched on demand — nothing else to install globally, and
the pin binds the exact code that runs. Verify:

```sh
opencode mcp list   # → taskflow  enabled
```

The `skills.paths` entry is optional: OpenCode auto-discovers `**/SKILL.md`
skills (including Claude Code `.claude/skills`), and the taskflow tools are
self-describing, so the routing skill just helps OpenCode reach for them at the
right time. A ready-to-copy `opencode.json` (and the skill) ships in the
package's `plugin/` directory.

From a checkout of this repo (no install), point OpenCode at the built bin:

```sh
pnpm run build
opencode mcp add taskflow -- node /abs/path/to/taskflow/packages/opencode-taskflow/dist/mcp/bin.js
```

The server discovers saved flows and agents from its **launch cwd**, and each
subagent a flow spawns is itself an `opencode run` process — no pi process
needed.

## Permissions (the codex-sandbox analogue)

OpenCode has no per-run tool-whitelist flag, but it honours a per-process config
injected via the `OPENCODE_CONFIG_CONTENT` env var. The runner maps each phase's
tool whitelist the same way the codex runner maps to a sandbox mode:

- **Read-only phase** (no `write`/`edit`/`bash` in the phase/agent `tools`) → a
  default-deny permission policy is injected: only the known read/list/search
  built-ins are allowed, so inherited custom and MCP tools are denied too.
  Every child also uses `--pure`, disabling external plugins that execute
  outside the tool permission policy.
- **Mutating phase** (or no whitelist) → rejected by default because OpenCode
  has no OS sandbox backstop. A trusted operator may explicitly set
  `PI_TASKFLOW_OPENCODE_UNSAFE_AUTO=1`; only then does the runner add `--auto`.
  Prefer a throwaway worktree (`cwd: "worktree"`).

OpenCode children receive only platform/proxy/CA, OpenCode configuration, and
supported provider environment variables; unrelated parent secrets are
removed. Explicit task credentials can be added by name through the
comma-separated `PI_TASKFLOW_CHILD_ENV_ALLOW` operator setting.

## Model ids

OpenCode model ids are `provider/model` (e.g. `opencode/deepseek-v4-flash-free`,
`anthropic/claude-sonnet-4-5`) — a clean `provider/model` passes straight
through to `opencode run -m`. Because a valid OpenCode id contains a slash, the
runner does **not** reuse the codex/claude "contains `/` ⇒ drop" rule; it drops
only ids that clearly aren't OpenCode models: an unresolved role placeholder
(`{{fast}}`), a pi thinking suffix (`…:xhigh`), or a multi-segment openrouter
path (`openrouter/vendor/model`, ≥ 2 slashes). A dropped id falls back to
OpenCode's configured default model.

Effective Taskflow thinking is passed as OpenCode's provider/model-specific
`--variant`; `off` maps to `none` and `ultra` maps to `max`. Other levels are
best-effort because available variants differ by provider and model.

## Long-running flows

Foreground `taskflow_run` waits for the whole DAG. For a long flow, pass
`mode: "background"`: it returns a durable `runId` immediately and continues
independently of that MCP request. Use `taskflow_runs` with `action: "status"`,
`"wait"`, or `"cancel"`; bounded waits can be repeated until the persisted
final output is ready.

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

## Use it

Inside an OpenCode session, just ask — OpenCode will call the tools:

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
opencode mcp remove taskflow    # or delete the mcp.taskflow entry from opencode.json
```

## Proof / tests

- `pnpm run test:e2e-opencode-mcp` — spawns `bin.ts` as OpenCode would and drives
  the full MCP handshake + tool calls over a real subprocess pipe (no live
  model needed).
- `pnpm run test:e2e-opencode` — runs a 2-phase flow whose subagents are real
  `opencode run` sessions (proves OpenCode-as-executor; data flows phase A → B).
  Uses a free `opencode/` model by default (override with
  `PI_TASKFLOW_OPENCODE_MODEL`).
- `packages/opencode-taskflow/test/mcp-server.test.ts` — protocol + binding
  tests (in-memory streams).
- `packages/opencode-taskflow/test/opencode-runner.test.ts` — opencode JSON
  parser, model resolution, and permission mapping pinned against real captured
  events.
