# Taskflow on Hermes Agent (MCP)

Hermes Agent has a built-in MCP client. `hermes-taskflow` is the delivery package
that binds Taskflow's host-neutral MCP server to Hermes subagents.

## Install

```bash
hermes mcp add taskflow --command node --args "$(pwd)/packages/hermes-taskflow/dist/mcp/bin.js"
```

Or paste into `~/.hermes/config.yaml` (see `packages/hermes-taskflow/plugin/hermes.config.snippet.yaml`):

```yaml
mcp_servers:
  taskflow:
    command: "npx"
    args: ["-y", "-p", "hermes-taskflow", "hermes-taskflow-mcp"]
    env:
      # PI_TASKFLOW_HERMES_UNSAFE_YOLO: "1"  # required for mutating agent phases
    timeout: 600
```

**Footgun:** do **not** put `--env KEY=VAL` after bare `--args …` in a way that Hermes
parses env flags into the node argv list. Prefer writing `env:` in `config.yaml`
explicitly (as above), then `hermes mcp test taskflow`.

Restart Hermes. Tools register as `mcp_taskflow_*`.

Optional skill (from the package or monorepo):

```bash
cp -R node_modules/hermes-taskflow/plugin/skills/taskflow ~/.hermes/skills/taskflow
# monorepo dogfood:
# cp -R packages/hermes-taskflow/plugin/skills/taskflow ~/.hermes/skills/taskflow
```

## What you get

| Concern | Behavior |
|---------|----------|
| Control plane | Full `taskflow_*` MCP roster (run, plan, verify, compile, resume, …) |
| Execution | Each agent phase: `hermes chat -q … -Q --source tool --safe-mode` |
| Read-only phases | model-only by default (no `-t`); `READONLY_WEB=1` → `web,search` |
| Mutating phases | Requires `PI_TASKFLOW_HERMES_UNSAFE_YOLO=1` → `--yolo` |
| Isolation | ephemeral `HERMES_HOME` (creds+RO plugin+show_reasoning:false) + `--ignore-rules` |
| Session hygiene | `--source tool` keeps integration runs out of the main user session list |

## Env knobs

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_TASKFLOW_HERMES_UNSAFE_YOLO` | unset | Must be `1` for mutating/default-capable phases |
| `PI_TASKFLOW_HERMES_READONLY_WEB` | unset | `1` adds web+search on read-only phases |
| `PI_TASKFLOW_HERMES_MAX_TURNS` | `64` | Child `--max-turns` |
| `PI_TASKFLOW_HERMES_BIN` | `hermes` | Binary override |
| `HERMES_HOME` | inherited | Profile / credentials home for child hermes (`.env` still loaded under `--safe-mode`) |

## Dogfood from a checkout

```bash
# after pnpm install
node --conditions=development --experimental-strip-types \
  packages/hermes-taskflow/src/mcp/bin.ts
# point config at that node command, or:
pnpm --filter hermes-taskflow build
# then: node packages/hermes-taskflow/dist/mcp/bin.js
```

Network-free MCP smoke:

```bash
node --conditions=development --experimental-strip-types \
  packages/hermes-taskflow/test/e2e-hermes-mcp.mts
```

## Related

- Package README: `packages/hermes-taskflow/README.md`
- Runner: `packages/taskflow-hosts/src/hermes-runner.ts`
- Hermes MCP docs: https://hermes-agent.nousresearch.com/docs/
