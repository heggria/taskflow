# Pi compatibility

The CI `pi-peers` job tests exact official Pi SDK versions **0.80.3, 0.85.1, and 1.0.4** on Node 22. The four adapter-local `@earendil-works/pi-*` resolutions are asserted before testing; checking only the root SDK is insufficient with pnpm.

The public peer ranges remain `*`. This is installation flexibility, not a promise that every Pi version has been tested. The matrix does not upgrade root dependencies, the committed lockfile, or release versions.

## Coverage

Each version runs the complete adapter unit suite, compiles the core and Pi extension, and launches the actual installed Pi CLI with the built extension. A local deterministic provider supplies model responses, without credentials or live model requests.

- Extension loading and actual `taskflow` tool dispatch.
- A foreground Taskflow launches `pi --mode json` and the child returns the owning run's ID. Direct runner identity and the shared-context `ctx_*` extension/allowlist are also exercised.
- A genuine Pi retry after a synthetic provider 429 recovers successfully. Event-stream regressions additionally cover exhaustion, overflow/threshold compaction, legacy clean exits, terminal reaping, cancellation and idle timeout.
- RPC approve/reject/cancel/edit/edit-cancel/abort paths, plus JSON-mode rejection that prevents the downstream script. Unit coverage retains the TUI overlay behavior, including missing or failed dialogs.
- Pi 1.0.4 additionally starts a harmless local stdio MCP server and exercises actual codemode calls, explicit MCP wildcard inclusion, and read-only tool-list filtering. Older matrix entries do not claim native MCP/codemode integration coverage.

The CLI fixture uses compiled workspace output. It is not a separate clean-consumer tarball test, real-provider credential test, or interactive terminal visual acceptance test.

## Pi 1.0 behavior handled by this adapter

An assistant `message_end` error can represent a failed attempt before Pi retries or compacts. Taskflow waits for recovery or final settlement instead of killing the process immediately. Explicit protocol errors and aborts remain fatal, and the existing idle watchdog remains active. Compaction revokes premature terminal reaping while preserving successful legacy clean-exit evidence when no retry follows.

RPC supports dialogs but not custom TUI overlays. Taskflow uses `ui.select` for RPC, retains the overlay for TUI, and rejects unavailable/cancelled dialogs and cancelled edits. JSON/print execution does not silently approve a human approval phase.

[Pi 1.0.4](https://github.com/earendil-works/pi/releases/tag/v1.0.4) preserves registered MCP tools when `--tools` contains no `mcp__` entry. That includes tools callable indirectly through codemode. Taskflow preserves its explicit tool-list contract by also passing `--exclude-tools mcp__*` unless the list contains `*` or an explicit `mcp__...` entry. For example:

| Taskflow tools | MCP behavior |
| --- | --- |
| `read` | MCP excluded, including indirect calls |
| `codemode` | MCP excluded, even if an MCP extension was loaded |
| `codemode,mcp__compat__*` | Pi filters MCP to the explicitly requested namespace |
| No tool list | Existing Pi/profile behavior retained |

This filter is not an OS sandbox. The default isolated child profile still disables ambient extensions; an allowlist or inherited profile can load explicitly authorized extensions.

## Reproduce

In a disposable checkout, after `pnpm install --frozen-lockfile`:

```sh
PI_VERSION=1.0.4 # Repeat with 0.80.3 and 0.85.1.
pnpm --filter pi-taskflow add --save-dev --save-exact \
  @earendil-works/pi-agent-core@$PI_VERSION \
  @earendil-works/pi-ai@$PI_VERSION \
  @earendil-works/pi-coding-agent@$PI_VERSION \
  @earendil-works/pi-tui@$PI_VERSION
PI_TEST_PEER_VERSION=$PI_VERSION pnpm run test:pi:peers
pnpm --filter taskflow-core build
pnpm --filter pi-taskflow build
pnpm run test:e2e-pi-compat
```

The installation modifies that checkout's adapter manifest and lockfile only for the test. Do not include those dependency changes in the compatibility PR.
