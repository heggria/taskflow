/**
 * hermes-taskflow public entry.
 *
 * The Hermes runner lives in `taskflow-hosts`. This package re-exports it so
 * `import { hermesSubagentRunner, buildHermesArgs, ... } from "hermes-taskflow"`
 * works. New code should import directly from `taskflow-hosts`; this re-export
 * exists for a stable delivery surface.
 *
 * The delivery surface (MCP server + bin + Hermes config scaffold) is shipped
 * from this package — see `./mcp/server.ts` and `./mcp/bin.ts`.
 */

export * from "taskflow-hosts/hermes";
