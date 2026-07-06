/**
 * opencode-taskflow public entry.
 *
 * The opencode runner now lives in `taskflow-hosts` (shared host-runner
 * collection). This package re-exports it so the public surface of
 * `opencode-taskflow` is unchanged — `import { opencodeSubagentRunner,
 * runOpencodeAgentTask, buildOpencodeArgs, foldOpencodeEventLine, ... } from
 * "opencode-taskflow"` keeps working. New code should import directly from
 * `taskflow-hosts`; this re-export exists for back-compat.
 *
 * The delivery surface (the MCP server + bin + OpenCode config scaffold) is
 * still shipped from this package — see `./mcp/server.ts` and `./mcp/bin.ts`.
 */

export * from "taskflow-hosts/opencode";
