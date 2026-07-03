#!/usr/bin/env node
/**
 * Executable entry for the taskflow MCP server, claude-bound (the
 * `claude-taskflow-mcp` bin).
 *
 * Register with Claude Code:
 *   npm install -g claude-taskflow
 *   claude mcp add taskflow -- claude-taskflow-mcp
 *
 * From a checkout of this repo (after `npm run build`):
 *   claude mcp add taskflow -- node /abs/path/to/packages/claude-taskflow/dist/mcp/bin.js
 *
 * Claude Code then launches this as a stdio MCP server and the taskflow_*
 * tools become available inside the session. The server discovers saved flows
 * + agents from its launch cwd, and runs each subagent as a `claude -p`
 * session, so no pi process is required. This file ships compiled to
 * dist/mcp/bin.js, so no `--experimental-strip-types` flag is needed.
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
