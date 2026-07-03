# Release Guide (monorepo)

taskflow is a monorepo of five independently published packages:

| Package | npm name | What it is |
|---------|----------|------------|
| `packages/taskflow-core` | **`taskflow-core`** | Host-neutral engine (DSL, runtime, cache, verify, MCP server). Zero host SDK deps. |
| `packages/pi-taskflow` | **`pi-taskflow`** | Pi extension adapter. Keeps the original published name (no break for existing users). |
| `packages/codex-taskflow` | **`codex-taskflow`** | Codex adapter: subagent runner + MCP bin. |
| `packages/claude-taskflow` | **`claude-taskflow`** | Claude Code adapter: subagent runner + MCP bin. |
| `packages/opencode-taskflow` | **`opencode-taskflow`** | OpenCode adapter: subagent runner + MCP bin. |

Dependency order: `pi-taskflow`, `codex-taskflow`, `claude-taskflow`, and `opencode-taskflow` all depend on `taskflow-core`, so **core publishes first**.

## One-time setup

All five names are non-scoped and available on public npm — **no npm org needed**. `pi-taskflow` is already owned by `heggria`; `taskflow-core`, `codex-taskflow`, `claude-taskflow`, and `opencode-taskflow` are unclaimed (publishing creates them).

```sh
# 1. Point at PUBLIC npm (the repo's default registry may be a private mirror)
npm config get registry            # confirm what you're pointed at
# publish commands below pass --registry explicitly, so a global switch is optional

# 2. Log in as the account that owns / will own these names
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/   # expect: heggria (or the owner)
```

## Pre-flight (always)

```sh
npm install            # links the workspaces
npm run typecheck      # 0 errors (resolves taskflow-core to src via the dev condition)
npm test               # 918/918 green
npm run build          # emit dist/ for all three packages (tsc → .js + .d.ts)
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
      entry files (`entry.pi.md` / `entry.codex.md`) for host bindings.
- [ ] Host-only capabilities are wrapped in `<!-- host:pi -->` /
      `<!-- host:codex -->` blocks — never teach a host a tool it can't reach.
- [ ] `node scripts/build-skills.mjs` ran and the generated files are committed.
- [ ] The `taskflow` tool description in the pi adapter (`src/index.ts`) lists
      any new `action` values.
- [ ] Removed/renamed fields are purged from `skills-src/` (grep the old name).

> **Why a build step.** Node refuses to type-strip `.ts` files under
> `node_modules`, so the published packages ship compiled `dist/*.js` + `.d.ts`.
> `prepublishOnly` runs `npm run build` automatically, so `npm publish` always
> publishes fresh output even if you skip the manual build above.

## Publish (order matters)

```sh
# core FIRST — the adapters depend on it
npm publish -w taskflow-core   --registry=https://registry.npmjs.org/ --provenance
npm publish -w pi-taskflow     --registry=https://registry.npmjs.org/ --provenance
npm publish -w codex-taskflow  --registry=https://registry.npmjs.org/ --provenance
npm publish -w claude-taskflow --registry=https://registry.npmjs.org/ --provenance
npm publish -w opencode-taskflow --registry=https://registry.npmjs.org/ --provenance
```

`publishConfig.access: public` is set on each package, so scoped/unscoped both publish publicly.

> **Note on `taskflow-core` as a dependency.** `pi-taskflow` / `codex-taskflow` /
> `claude-taskflow` / `opencode-taskflow` declare `"taskflow-core": "0.1.5"` (an
> exact version, not `workspace:*`), so the published tarballs resolve the real
> npm package once it exists. Always publish `taskflow-core` first and bump all
> five in lockstep.

## Tag + GitHub Release (automated)

Pushing a `v*` tag triggers `.github/workflows/publish.yml`, which verifies all
five package versions match the tag, publishes them in order, and cuts a GitHub
Release from the matching `CHANGELOG.md` section.

```sh
git tag v0.1.3 && git push origin v0.1.3
```

## Verify after publish

```sh
npm view taskflow-core version --registry=https://registry.npmjs.org/
npm view pi-taskflow  version --registry=https://registry.npmjs.org/
npm view codex-taskflow version --registry=https://registry.npmjs.org/
npm view claude-taskflow version --registry=https://registry.npmjs.org/
npm view opencode-taskflow version --registry=https://registry.npmjs.org/
```

## Install (end users)

```sh
# Pi users (unchanged):
pi install npm:pi-taskflow

# Codex users (MCP server):
npm i -g codex-taskflow
codex mcp add taskflow -- codex-taskflow-mcp
```
