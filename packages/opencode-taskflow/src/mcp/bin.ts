#!/usr/bin/env node
/**
 * Executable entry for the taskflow MCP server, opencode-bound (the
 * `opencode-taskflow-mcp` bin).
 *
 * Register with OpenCode (opencode.json):
 *   {
 *     "mcp": {
 *       "taskflow": {
 *         "type": "local",
 *         "command": ["npx", "-y", "-p", "opencode-taskflow", "opencode-taskflow-mcp"],
 *         "enabled": true
 *       }
 *     }
 *   }
 *
 * From a checkout of this repo (after `npm run build`):
 *   "command": ["node", "/abs/path/to/packages/opencode-taskflow/dist/mcp/bin.js"]
 *
 * OpenCode then launches this as a stdio MCP server and the taskflow_* tools
 * become available in the session. The server discovers saved flows + agents
 * from its launch cwd, and runs each subagent as an `opencode run` session, so
 * no pi process is required. This file ships compiled to dist/mcp/bin.js, so no
 * `--experimental-strip-types` flag is needed.
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
