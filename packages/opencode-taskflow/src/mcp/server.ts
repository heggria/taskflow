/**
 * The OpenCode binding of the host-neutral MCP server (taskflow-mcp-core/server).
 *
 * The protocol layer, tool schemas, and handlers all live in core; this shim
 * only closes the loop for OpenCode: every subagent a flow spawns is itself an
 * `opencode run` process (via opencodeSubagentRunner). Kept as a module (not
 * just bin.ts) so tests and embedders get the same pre-bound surface the bin
 * runs.
 */

import {
	makeMcpHandlers as coreMakeMcpHandlers,
	makeToolHandlers as coreMakeToolHandlers,
	startMcpServer as coreStartMcpServer,
} from "taskflow-mcp-core/server";
import type { RpcContext, RpcHandler } from "taskflow-mcp-core/jsonrpc";
import { opencodeSubagentRunner } from "taskflow-hosts";

const HOST_OPTIONS = {
	host: "opencode",
	detachedRunner: {
		module: import.meta.resolve("taskflow-hosts/opencode"),
		exportName: "opencodeSubagentRunner",
	},
} as const;

/** Per-call tool handlers with opencode subagent execution bound in. */
export function makeToolHandlers(
	cwd: string,
): Record<string, (args: Record<string, unknown>, context?: RpcContext) => Promise<unknown>> {
	return coreMakeToolHandlers(cwd, opencodeSubagentRunner, HOST_OPTIONS);
}

/** Full MCP method dispatch table (protocol + tools), opencode-bound. */
export function makeMcpHandlers(cwd: string): Record<string, RpcHandler> {
	return coreMakeMcpHandlers(cwd, opencodeSubagentRunner, HOST_OPTIONS);
}

/** Start the stdio MCP server. Resolves when the client disconnects. */
export function startMcpServer(cwd: string = process.cwd()): Promise<void> {
	return coreStartMcpServer(opencodeSubagentRunner, cwd, HOST_OPTIONS);
}
