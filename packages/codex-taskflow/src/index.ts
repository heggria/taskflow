/**
 * codex-taskflow public entry.
 *
 * The codex runner now lives in `taskflow-hosts` (shared host-runner
 * collection). This package re-exports it so the public surface of
 * `codex-taskflow` is unchanged — `import { codexSubagentRunner,
 * runCodexAgentTask, buildCodexArgs, foldCodexEventLine, ... } from
 * "codex-taskflow"` keeps working. New code should import directly from
 * `taskflow-hosts`; this re-export exists for back-compat with anything that
 * already depended on the `codex-taskflow` name.
 *
 * The delivery surface (the MCP server + bin + Codex plugin scaffold) is still
 * shipped from this package — see `./mcp/server.ts` and `./mcp/bin.ts`.
 */

export * from "taskflow-hosts/codex";
