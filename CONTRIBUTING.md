# Contributing to pi-taskflow

Thanks for your interest. `pi-taskflow` is a fast-moving project maintained primarily by [@heggria](https://github.com/heggria). Contributions are welcome — here's how.

## Quick start

```bash
git clone git@github.com:heggria/pi-taskflow.git
cd pi-taskflow
npm install
npm run typecheck   # TypeScript checks (no build needed)
npm test            # 864 tests, all passing
```

> The pi end-to-end suites (`packages/pi-taskflow/test/e2e*.mts`) spawn live Pi subagents and are run directly with `node --conditions=development --experimental-strip-types <file>`. They need `pi` installed and model access configured. CI runs unit tests only.

## What makes a good contribution

- **New phase types** — the DSL is the heart of the project. See `packages/taskflow-core/src/schema.ts` for the phase type registry.
- **Example flows** — copy one from `examples/`, adapt it, and send a PR. Each example should demonstrate a distinct pattern (fan-out, gating, approval, loop, tournament…).
- **Docs & TUI polish** — live progress, error messages, and diagnostic output are always improving.
- **Cache / store improvements** — the atomic file lock and cross-run memoization store are zero-dependency. All improvements must stay dependency-free or become optional peerDeps.

## Before you open a PR

1. **Open an issue first** to discuss the change. PRs without a linked issue may sit un-reviewed.
2. Keep the diff focused — one concern per PR.
3. All existing tests must pass (`npm test`).
4. Add tests for new behavior (each package keeps its tests under `packages/<pkg>/test/`).
5. Format is whatever Prettier with default settings would do. No strict config enforced.

## Response time

I review issues and PRs ~weekly. If you need a faster turnaround, mention why in the issue and I'll try to prioritize.

## Architecture

See [`AGENTS.md`](./AGENTS.md) for the full layout and conventions. `pi-taskflow` is an npm-workspaces monorepo of three published packages:

| Package / directory | What |
|---------------------|------|
| `packages/taskflow-core/` | Host-neutral engine: runtime, schema, agents, store, cache, verify, compile, context-store (zero host-SDK deps) |
| `packages/taskflow-core/src/agents/` | 18 built-in agent definitions (`.md` with YAML frontmatter) |
| `packages/pi-taskflow/` | Pi extension adapter (`taskflow` tool + `/tf` commands, TUI) + `skills/` |
| `packages/codex-taskflow/` | Codex subagent runner + dependency-free MCP server |
| `examples/` | Runnable flow definitions (`.json`) |
| `docs/` | Design docs, RFCs, dogfooding reports |

Each package compiles to `dist/` for publishing; dev runs the TypeScript sources directly (no build step needed for `typecheck`/`test`).

## License

MIT. By contributing you agree your contribution will be licensed under the same terms.
