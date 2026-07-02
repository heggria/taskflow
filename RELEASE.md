# Release Guide (monorepo)

taskflow is a monorepo of three independently published packages:

| Package | npm name | What it is |
|---------|----------|------------|
| `packages/taskflow-core` | **`taskflow-core`** | Host-neutral engine (DSL, runtime, cache, verify). Zero host SDK deps. |
| `packages/pi-taskflow` | **`pi-taskflow`** | Pi extension adapter. Keeps the original published name (no break for existing users). |
| `packages/codex-taskflow` | **`codex-taskflow`** | Codex adapter: subagent runner + MCP server. |

Dependency order: `pi-taskflow` and `codex-taskflow` both depend on `taskflow-core`, so **core publishes first**.

## One-time setup

All three names are non-scoped and available on public npm — **no npm org needed**. `pi-taskflow` is already owned by `heggria`; `taskflow-core` and `codex-taskflow` are unclaimed (publishing creates them).

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
```

`publishConfig.access: public` is set on each package, so scoped/unscoped both publish publicly.

> **Note on `taskflow-core` as a dependency.** `pi-taskflow` / `codex-taskflow`
> declare `"taskflow-core": "0.1.3"` (an exact version, not `workspace:*`),
> so the published tarballs resolve the real npm package once it exists. Always
> publish `taskflow-core` first and bump all three in lockstep.

## Tag + GitHub Release (automated)

Pushing a `v*` tag triggers `.github/workflows/publish.yml`, which verifies all
three package versions match the tag, publishes them in order, and cuts a GitHub
Release from the matching `CHANGELOG.md` section.

```sh
git tag v0.1.3 && git push origin v0.1.3
```

## Verify after publish

```sh
npm view taskflow-core version --registry=https://registry.npmjs.org/
npm view pi-taskflow  version --registry=https://registry.npmjs.org/
npm view codex-taskflow version --registry=https://registry.npmjs.org/
```

## Install (end users)

```sh
# Pi users (unchanged):
pi install npm:pi-taskflow

# Codex users (MCP server):
npm i -g codex-taskflow
codex mcp add taskflow -- codex-taskflow-mcp
```
