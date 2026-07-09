# Release Guide (monorepo)

taskflow is a monorepo of eight independently published packages:

| Package | npm name | What it is |
|---------|----------|------------|
| `packages/taskflow-core` | **`taskflow-core`** | Host-neutral engine (DSL, runtime, cache, verify). Zero host SDK deps. |
| `packages/taskflow-mcp-core` | **`taskflow-mcp-core`** | Host-neutral MCP server (stdio JSON-RPC + taskflow_* tools + DAG renderer). Depends on core. |
| `packages/taskflow-hosts` | **`taskflow-hosts`** | Shared host-runner collection: codex/claude/opencode/grok `SubagentRunner` impls + argv builders + event-stream parsers. Depends on core. |
| `packages/pi-taskflow` | **`pi-taskflow`** | Pi extension adapter. Keeps the original published name (no break for existing users). |
| `packages/codex-taskflow` | **`codex-taskflow`** | Codex delivery package: re-exports the runner from `taskflow-hosts` + MCP bin + plugin. |
| `packages/claude-taskflow` | **`claude-taskflow`** | Claude Code delivery package: re-exports the runner from `taskflow-hosts` + MCP bin + plugin. |
| `packages/opencode-taskflow` | **`opencode-taskflow`** | OpenCode delivery package: re-exports the runner from `taskflow-hosts` + MCP bin + config scaffold. |
| `packages/grok-taskflow` | **`grok-taskflow`** | Grok Build delivery package: re-exports the runner from `taskflow-hosts` + MCP bin + plugin. |

Dependency order: `taskflow-mcp-core`, `taskflow-hosts`, `pi-taskflow`, `codex-taskflow`, `claude-taskflow`, `opencode-taskflow`, and `grok-taskflow` all depend on `taskflow-core` (`taskflow-mcp-core` and `taskflow-hosts` directly; the adapters via both `taskflow-hosts` and `taskflow-mcp-core`), so **core publishes first, then taskflow-mcp-core, then taskflow-hosts, then the adapters**.

## One-time setup

All eight names are non-scoped and available on public npm — **no npm org needed**. `pi-taskflow` is already owned by `heggria`; the rest (`taskflow-core`, `taskflow-mcp-core`, `taskflow-hosts`, `codex-taskflow`, `claude-taskflow`, `opencode-taskflow`, `grok-taskflow`) are unclaimed until first publish (publishing creates them).

```sh
# 1. Point at PUBLIC npm (the repo's default registry may be a private mirror)
pnpm config get registry            # confirm what you're pointed at
# publish commands below pass --registry explicitly, so a global switch is optional

# 2. Log in as the account that owns / will own these names
pnpm login --registry=https://registry.npmjs.org/
pnpm whoami --registry=https://registry.npmjs.org/   # expect: heggria (or the owner)
```

## Pre-flight (always)

```sh
pnpm install            # links the workspaces
pnpm run typecheck      # 0 errors (resolves taskflow-core to src via the dev condition)
pnpm test               # 1140/1140 green
pnpm run build          # emit dist/ for all eight packages (tsc → .js + .d.ts)
```

### Skill coverage check (before every release)

The skills are the LLM-facing API surface — an engine feature the skill doesn't
teach effectively does not exist. **Skills are authored ONCE in
`skills-src/taskflow/` and compiled per host** by `scripts/build-skills.mjs`
(pi → `packages/pi-taskflow/skills/taskflow/`, codex →
`packages/codex-taskflow/plugin/skills/taskflow/`). Never edit the generated
files — `skills-build.test.ts` fails CI on drift. For every feature/change in
this release's CHANGELOG section, verify:

- [ ] New DSL fields, phase types, actions, and commands appear in the right
      **source** layer: `core.md` (core DSL + actions), `patterns.md` (if it
      changes best practice), `advanced.md` (context sharing / dynamic flows /
      isolation / recompute), `configuration.md` (knobs), or the per-host
      entry files (`entry.pi.md` / `entry.codex.md` / `entry.claude.md` / `entry.opencode.md` / `entry.grok.md`) for host bindings.
- [ ] Host-only capabilities are wrapped in `<!-- host:pi -->` /
      `<!-- host:codex -->` blocks — never teach a host a tool it can't reach.
- [ ] `node scripts/build-skills.mjs` ran and the generated files are committed.
- [ ] The `taskflow` tool description in the pi adapter (`src/index.ts`) lists
      any new `action` values.
- [ ] Removed/renamed fields are purged from `skills-src/` (grep the old name).

> **Why a build step.** Node refuses to type-strip `.ts` files under
> `node_modules`, so the published packages ship compiled `dist/*.js` + `.d.ts`.
> `prepublishOnly` runs `pnpm run build` automatically, so `pnpm publish` always
> publishes fresh output even if you skip the manual build above.

## Publish (order matters)

```sh
# core FIRST — the adapters depend on it
pnpm publish --filter taskflow-core   --registry=https://registry.npmjs.org/ --provenance
pnpm publish --filter taskflow-mcp-core    --registry=https://registry.npmjs.org/ --provenance
pnpm publish --filter taskflow-hosts  --registry=https://registry.npmjs.org/ --provenance
pnpm publish --filter pi-taskflow     --registry=https://registry.npmjs.org/ --provenance
pnpm publish --filter codex-taskflow  --registry=https://registry.npmjs.org/ --provenance
pnpm publish --filter claude-taskflow --registry=https://registry.npmjs.org/ --provenance
pnpm publish --filter opencode-taskflow --registry=https://registry.npmjs.org/ --provenance
pnpm publish --filter grok-taskflow     --registry=https://registry.npmjs.org/ --provenance
```

`publishConfig.access: public` is set on each package, so scoped/unscoped both publish publicly.

> **Note on `taskflow-core` as a dependency.** `taskflow-mcp-core`, `taskflow-hosts`, and the host adapters
> (`pi-taskflow` / `codex-taskflow` / `claude-taskflow` / `opencode-taskflow` / `grok-taskflow`)
> declare `"taskflow-core": "0.1.7"` (an exact version, not `workspace:*`), so the
> published tarballs resolve the real npm package once it exists. Always publish
> `taskflow-core` first and bump all eight in lockstep. (`taskflow-mcp-core` and `taskflow-hosts` are the
> other internal dependencies: the MCP host adapters pin `"taskflow-mcp-core"`; the codex/claude/opencode/grok
> delivery packages pin `"taskflow-hosts"`.)

## Tag + GitHub Release (automated)

Pushing a `v*` tag triggers `.github/workflows/publish.yml`, which verifies all
eight package versions match the tag, publishes them in order, and cuts a GitHub
Release from the matching `CHANGELOG.md` section.

```sh
git tag v0.1.7 && git push origin v0.1.7
```

## Verify after publish

```sh
pnpm view taskflow-core version --registry=https://registry.npmjs.org/
pnpm view taskflow-mcp-core version --registry=https://registry.npmjs.org/
pnpm view taskflow-hosts version --registry=https://registry.npmjs.org/
pnpm view pi-taskflow  version --registry=https://registry.npmjs.org/
pnpm view codex-taskflow version --registry=https://registry.npmjs.org/
pnpm view claude-taskflow version --registry=https://registry.npmjs.org/
pnpm view opencode-taskflow version --registry=https://registry.npmjs.org/
pnpm view grok-taskflow version --registry=https://registry.npmjs.org/
```

## Install (end users)

```sh
# Pi users (unchanged):
pi install npm:pi-taskflow

# Codex users (plugin):
codex plugin marketplace add heggria/taskflow
codex plugin add taskflow@taskflow

# Claude Code users (plugin):
claude plugin marketplace add heggria/taskflow
claude plugin install claude-taskflow@taskflow

# OpenCode users (MCP server):
opencode mcp add taskflow -- npx -y -p opencode-taskflow opencode-taskflow-mcp

# Grok Build
grok plugin install <source> --trust
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```
