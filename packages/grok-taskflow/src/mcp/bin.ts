#!/usr/bin/env node
/**
 * Executable entry for the taskflow MCP server, grok-bound (the
 * `grok-taskflow-mcp` bin).
 *
 * Register with Grok Build:
 *   npm install -g grok-taskflow
 *   grok mcp add taskflow -- grok-taskflow-mcp
 *
 * Or install the plugin scaffold (skills + MCP via npx):
 *   grok plugin install ./packages/grok-taskflow/plugin --trust
 *   # or: grok plugin install <marketplace-entry> --trust
 *
 * From a checkout of this repo (after `pnpm run build`):
 *   grok mcp add taskflow -- node /abs/path/to/packages/grok-taskflow/dist/mcp/bin.js
 *
 * Grok then launches this as a stdio MCP server and the taskflow_* tools
 * become available. The server discovers saved flows + agents from its launch
 * cwd, and runs each subagent as a grok -p session.
 */

import { startMcpServer } from "./server.ts";

startMcpServer(process.cwd())
	.then(() => process.exit(0))
	.catch((e) => {
		// Never write non-JSON to stdout (it would corrupt the MCP stream); log to
		// stderr and exit non-zero so the client sees the transport drop.
		process.stderr.write(`taskflow mcp server fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
		process.exit(1);
	});
