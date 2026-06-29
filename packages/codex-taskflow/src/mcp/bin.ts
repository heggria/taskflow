#!/usr/bin/env -S node --experimental-strip-types
/**
 * Executable entry for the pi-taskflow MCP server.
 *
 * Register with Codex:
 *   codex mcp add taskflow -- node --experimental-strip-types \
 *     /abs/path/to/extensions/mcp/bin.ts
 *
 * (or point at a compiled .js). Codex then launches this as a stdio MCP server
 * and the taskflow_* tools become available inside codex. The server discovers
 * saved flows + agents from its launch cwd, and runs each subagent as a codex
 * session, so no pi process is required.
 */

import { startMcpServer } from "./server.ts";

startMcpServer(process.cwd())
	.then(() => process.exit(0))
	.catch((e) => {
		// Never write non-JSON to stdout (it would corrupt the MCP stream); log to
		// stderr and exit non-zero so the client sees the transport drop.
		process.stderr.write(`pi-taskflow mcp server fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
		process.exit(1);
	});
