/**
 * grok-taskflow public entry.
 *
 * The grok runner lives in `taskflow-hosts`. This package re-exports it so
 * `import { grokSubagentRunner, runGrokAgentTask, buildGrokArgs, … } from
 * "grok-taskflow"` works. New code should prefer `taskflow-hosts` /
 * `taskflow-hosts/grok`; this re-export is the delivery-package public surface.
 *
 * The delivery surface (MCP server + bin + Grok plugin scaffold) ships from
 * this package — see `./mcp/server.ts`, `./mcp/bin.ts`, and `./plugin/`.
 */

export * from "taskflow-hosts/grok";
