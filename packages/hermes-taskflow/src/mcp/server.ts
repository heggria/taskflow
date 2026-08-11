/**
 * The Hermes Agent binding of the host-neutral MCP server (taskflow-mcp-core/server).
 *
 * The protocol layer, tool schemas, and handlers all live in core; this shim
 * only closes the loop for Hermes: every subagent a flow spawns is itself a
 * `hermes chat -q -Q` process (via hermesSubagentRunner). Kept as a module (not
 * just bin.ts) so tests and embedders get the same pre-bound surface the bin runs.
 */

import {
	makeMcpHandlers as coreMakeMcpHandlers,
	makeToolHandlers as coreMakeToolHandlers,
	startMcpServer as coreStartMcpServer,
} from "taskflow-mcp-core/server";
import type { RpcContext, RpcHandler } from "taskflow-mcp-core/jsonrpc";
import { hermesSubagentRunner } from "taskflow-hosts";

const HOST_OPTIONS = {
	host: "hermes",
	detachedRunner: {
		module: import.meta.resolve("taskflow-hosts/hermes"),
		exportName: "hermesSubagentRunner",
	},
} as const;

/** Per-call tool handlers with hermes subagent execution bound in. */
export function makeToolHandlers(
	cwd: string,
): Record<string, (args: Record<string, unknown>, context?: RpcContext) => Promise<unknown>> {
	return coreMakeToolHandlers(cwd, hermesSubagentRunner, HOST_OPTIONS);
}

/** Full MCP method dispatch table (protocol + tools), hermes-bound. */
export function makeMcpHandlers(cwd: string): Record<string, RpcHandler> {
	return coreMakeMcpHandlers(cwd, hermesSubagentRunner, HOST_OPTIONS);
}

/** Start the stdio MCP server. Resolves when the client disconnects. */
export function startMcpServer(cwd: string = process.cwd()): Promise<void> {
	return coreStartMcpServer(hermesSubagentRunner, cwd, HOST_OPTIONS);
}
