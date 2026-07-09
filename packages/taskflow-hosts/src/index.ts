/**
 * taskflow-hosts — the shared collection of host-runner implementations.
 *
 * Each non-pi host (codex / claude / opencode / grok) has two halves:
 *   1. the **runner** — a `SubagentRunner` that spawns that host's CLI, folds
 *      its event stream, and classifies the outcome into a host-neutral
 *      `RunResult`. PLUS the pure argv builders (`buildXxxArgs`) and
 *      permission/model helpers.
 *   2. the **delivery** — the per-host MCP server + bin + plugin scaffold,
 *      which lives in that host's own package (codex-taskflow /
 *      claude-taskflow / opencode-taskflow / grok-taskflow) because it's the
 *      host-ecosystem install target (`codex plugin add`, `claude plugin
 *      install`, `grok plugin install`, …).
 *
 * This package holds only #1 — the runners — so all host runners live in one
 * place. A new host adds a `<host>-runner.ts` here; its delivery package
 * imports the runner from `taskflow-hosts`. Host delivery packages re-export
 * from here (or import the runner directly into their `mcp/server`).
 *
 * The barrel re-exports the full public surface of each runner so a consumer
 * can `import { codexSubagentRunner, buildCodexArgs } from "taskflow-hosts"`,
 * or use a sub-path (`taskflow-hosts/codex`) to tree-shake to one host.
 */

export * from "./codex-runner.ts";
export * from "./claude-runner.ts";
export * from "./opencode-runner.ts";
export * from "./grok-runner.ts";
