#!/usr/bin/env node
/**
 * Executable entry for the taskflow MCP server, hermes-bound (the
 * `hermes-taskflow-mcp` bin).
 *
 * Register with Hermes (~/.hermes/config.yaml):
 *   mcp_servers:
 *     taskflow:
 *       command: "npx"
 *       args: ["-y", "-p", "hermes-taskflow", "hermes-taskflow-mcp"]
 *       # Mutating agent phases need explicit yolo opt-in in the MCP env:
 *       env:
 *         PI_TASKFLOW_HERMES_UNSAFE_YOLO: "1"
 *
 * Or via CLI:
 *   hermes mcp add taskflow -- npx -y -p hermes-taskflow hermes-taskflow-mcp
 *
 * From a checkout of this repo (after `pnpm run build`):
 *   command: "node"
 *   args: ["/abs/path/to/packages/hermes-taskflow/dist/mcp/bin.js"]
 *
 * Hermes then launches this as a stdio MCP server and the taskflow_* tools
 * become available (prefixed mcp_taskflow_*). Each subagent runs as an
 * isolated `hermes chat -q -Q` session. This file ships compiled to
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
