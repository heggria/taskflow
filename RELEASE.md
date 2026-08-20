# Release Guide (monorepo)

taskflow is a monorepo of ten independently published packages:

| Package | npm name | What it is |
|---------|----------|------------|
| `packages/taskflow-core` | **`taskflow-core`** | Host-neutral engine (DSL, runtime, cache, verify). Zero host SDK deps. |
| `packages/taskflow-mcp-core` | **`taskflow-mcp-core`** | Host-neutral MCP server (stdio JSON-RPC + taskflow_* tools + DAG renderer). Depends on core. |
| `packages/taskflow-hosts` | **`taskflow-hosts`** | Shared host-runner collection: codex/claude/opencode/grok/hermes `SubagentRunner` impls + argv builders + event-stream parsers. Depends on core. |
| `packages/taskflow-dsl` | **`taskflow-dsl`** | TypeScript DSL CLI/package: erases `.tf.ts` to Taskflow JSON and optional FlowIR. Depends on core. |
| `packages/pi-taskflow` | **`pi-taskflow`** | Pi extension adapter. Keeps the original published name (no break for existing users). |
| `packages/codex-taskflow` | **`codex-taskflow`** | Codex npm delivery: re-exports the runner from `taskflow-hosts` + MCP bin. The plugin scaffold is repository/marketplace-distributed, not in the npm tarball. |
| `packages/claude-taskflow` | **`claude-taskflow`** | Claude Code npm delivery: re-exports the runner from `taskflow-hosts` + MCP bin. The plugin scaffold is repository/marketplace-distributed, not in the npm tarball. |
| `packages/opencode-taskflow` | **`opencode-taskflow`** | OpenCode delivery package: re-exports the runner from `taskflow-hosts` + MCP bin + config scaffold. |
| `packages/grok-taskflow` | **`grok-taskflow`** | Grok Build npm delivery: re-exports the runner from `taskflow-hosts` + MCP bin. The plugin scaffold is repository/marketplace-distributed, not in the npm tarball. |
| `packages/hermes-taskflow` | **`hermes-taskflow`** | Hermes Agent delivery package: re-exports the runner from `taskflow-hosts` + MCP bin + config scaffold. |

Dependency order: `taskflow-mcp-core`, `taskflow-hosts`, `taskflow-dsl`, `pi-taskflow`, `codex-taskflow`, `claude-taskflow`, `opencode-taskflow`, `grok-taskflow`, and `hermes-taskflow` all depend on `taskflow-core` (`taskflow-mcp-core`, `taskflow-hosts`, and `taskflow-dsl` directly; the adapters via both `taskflow-hosts` and `taskflow-mcp-core`), so **core publishes first, then taskflow-mcp-core, taskflow-hosts, taskflow-dsl, then the adapters (including hermes)**.

## One-time repository setup

The beta release path is `v0.3.0-beta.1.2`: merge the reviewed release commit to `main`, then push the tag. `.github/workflows/publish.yml` validates the `0.3.0-beta.*` prerelease family, publishes the same ten packages to npm's `beta` dist-tag with provenance, and creates a prerelease GitHub Release. Do not publish from a workstation.

## Pre-flight (always)

```sh
pnpm install            # links the workspaces
pnpm run typecheck      # 0 errors (resolves taskflow-core to src via the dev condition)
pnpm test               # full unit suite green
pnpm run build          # emit dist/ for all ten packages (tsc → .js + .d.ts)
pnpm run test:pack      # pack → clean install → public imports/bins for all ten
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
      entry files (`entry.pi.md` / `entry.codex.md` / `entry.claude.md` / `entry.opencode.md` / `entry.grok.md` / `entry.hermes.md`) for host bindings.
- [ ] Host-only capabilities are wrapped in `<!-- host:pi -->` /
      `<!-- host:codex -->` blocks — never teach a host a tool it can't reach.
- [ ] `node scripts/build-skills.mjs` ran and the generated files are committed.
- [ ] The `taskflow` tool description in the pi adapter (`src/index.ts`) lists
      any new `action` values.
- [ ] Removed/renamed fields are purged from `skills-src/` (grep the old name).

> **Why build and packed-consumer gates both exist.** Node refuses to
> type-strip `.ts` under `node_modules`, so packages ship `dist/*.js` and
> `.d.ts`. Every package also has `prepublishOnly` and
> `publishConfig.access: public`, but release safety does not rely on lifecycle
> hooks alone: CI and the tag workflow stage pnpm's publish-ready content,
> canonicalize its manifest, prove repeat-pack byte stability, install those
> exact tarballs into a clean npm consumer, reject leaked
> `workspace:*` ranges, and exercise public exports and bins.

> **Note on internal dependencies.** Workspace package manifests use
> `workspace:*` locally so `pnpm install --frozen-lockfile` never depends on a
> not-yet-published release. The deterministic release packer converts those
> workspace ranges before `npm publish` receives the immutable tarball. Always
> publish `taskflow-core` first and bump all ten in lockstep.

## Publish from a tag (the only supported release path)

First merge the release commit to `main` and wait for every required check,
including `packed consumer (10 packages)`, to pass. From the updated `main`, push
the matching annotated tag:

```sh
git switch main
git pull --ff-only origin main
git tag -a v0.3.0-beta.1.2 -m "Release v0.3.0-beta.1.2"
git push origin v0.3.0-beta.1.2
```

`.github/workflows/publish.yml` then performs the complete release transaction:

1. proves the tag resolves to the event commit and that commit belongs to
   `origin/main`;
2. runs typecheck, unit tests and build, creates repeat-verified deterministic
   tarballs, then runs the packed-consumer gate against those exact bytes;
3. checks the root, all ten package versions, plugin manifests, and pinned MCP
   package versions against the tag;
4. publishes core first, then shared packages and delivery adapters, all with
   public access and provenance;
5. creates the GitHub Release from the matching `CHANGELOG.md` section.

The workflow is safely rerunnable. An existing npm version is skipped only
after owner, repository/workflow provenance, tag commit, and byte-for-byte
local tarball integrity all match; an existing GitHub Release is likewise
validated before it is accepted.

## Verify after publish

```sh
pnpm view taskflow-core version --registry=https://registry.npmjs.org/
pnpm view taskflow-mcp-core version --registry=https://registry.npmjs.org/
pnpm view taskflow-hosts version --registry=https://registry.npmjs.org/
pnpm view taskflow-dsl version --registry=https://registry.npmjs.org/
pnpm view pi-taskflow  version --registry=https://registry.npmjs.org/
pnpm view codex-taskflow version --registry=https://registry.npmjs.org/
pnpm view claude-taskflow version --registry=https://registry.npmjs.org/
pnpm view opencode-taskflow version --registry=https://registry.npmjs.org/
pnpm view grok-taskflow version --registry=https://registry.npmjs.org/
pnpm view hermes-taskflow version --registry=https://registry.npmjs.org/
```

Also verify the `Publish & Release` workflow completed successfully and that
the non-draft prerelease GitHub Release targets the tagged commit. A
partially published ten-package set is not a completed release; fix the cause
and rerun the same tag workflow rather than creating a replacement tag or
publishing missing packages manually.

## Upgrade and rollback

- Upgrade all host package pins as one transaction to `0.2.10`, restart/reload the
  host's MCP/plugin registration, and verify `taskflow_version` reports `0.2.10`.
- This patch does not introduce a run-state migration. Keep `.pi/taskflows/` and
  existing run history in place when upgrading or rolling back.
- All six hosts can roll back by pinning their delivery package to `0.2.9` and
  restarting/reloading the host. Keep all taskflow package versions aligned; do
  not mix a `0.2.10` adapter with `0.2.9` shared packages.
- Before rolling back, move any definitions from `.pi/taskflows/flows/**` back to
  the legacy top-level taskflows directory and remove `scriptCwd: "flow"`; 0.2.9
  does not discover the nested convention or understand that field.

## Install (end users)

The 0.3 beta is prepared for npm's `beta` channel; after the tag workflow publishes it, use `@beta` explicitly. The stable examples below remain pinned to `0.2.10`.

```sh
# Pi users:
pi install npm:pi-taskflow@beta

# Codex users (plugin source; npm MCP package uses @beta):
codex plugin marketplace add heggria/taskflow
codex plugin add taskflow@taskflow

# Claude Code users (plugin source; npm MCP package uses @beta):
claude plugin marketplace add heggria/taskflow
claude plugin install claude-taskflow@taskflow

# OpenCode users (beta MCP server):
opencode mcp add taskflow -- npx -y -p opencode-taskflow@beta opencode-taskflow-mcp

# Grok Build (beta MCP package)
grok mcp add taskflow -- npx -y -p grok-taskflow@beta grok-taskflow-mcp

# Hermes Agent (beta MCP package)
# 0.3 beta candidate (after publication, select @beta)
hermes mcp add taskflow --command npx --args -y -p hermes-taskflow@beta hermes-taskflow-mcp
```
