/**
 * claude-taskflow public entry.
 *
 * The claude runner now lives in `taskflow-hosts` (shared host-runner
 * collection). This package re-exports it so the public surface of
 * `claude-taskflow` is unchanged — `import { claudeSubagentRunner,
 * runClaudeAgentTask, buildClaudeArgs, foldClaudeEventLine, ... } from
 * "claude-taskflow"` keeps working. New code should import directly from
 * `taskflow-hosts`; this re-export exists for back-compat.
 *
 * The delivery surface (the MCP server + bin + Claude Code plugin scaffold) is
 * still shipped from this package — see `./mcp/server.ts` and `./mcp/bin.ts`.
 */

export * from "taskflow-hosts/claude";
