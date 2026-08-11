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
 *       env:
 *         # PI_TASKFLOW_HERMES_UNSAFE_YOLO: "1"   # only if you need mutating agents
 *         # PI_TASKFLOW_HERMES_READONLY_WEB: "1"  # RO phases may web_extract
 *
 * Prefer writing `env:` in config.yaml. Do not rely on `hermes mcp add … --env`
 * stuffing flags into the node argv list.
 *
 * Or via CLI (no env):
 *   hermes mcp add taskflow -- npx -y -p hermes-taskflow hermes-taskflow-mcp
 *
 * From a checkout of this repo (after `pnpm run build`):
 *   command: "node"
 *   args: ["/abs/path/to/packages/hermes-taskflow/dist/mcp/bin.js"]
 *
 * Hermes then launches this as a stdio MCP server and the taskflow_* tools
 * become available (prefixed mcp_taskflow_*). Each subagent runs as an
 * isolated `hermes chat -q -Q --ignore-rules` session. This file ships compiled to
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
