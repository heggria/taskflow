/**
 * The Grok Build binding of the host-neutral MCP server (taskflow-mcp-core/server).
 *
 * The protocol layer, tool schemas, and handlers all live in core; this shim
 * only closes the loop for Grok: every subagent a flow spawns is itself a
 * `grok -p` process (via grokSubagentRunner). Kept as a module (not just
 * bin.ts) so tests and embedders get the same pre-bound surface the bin runs.
 */

import {
	makeMcpHandlers as coreMakeMcpHandlers,
	makeToolHandlers as coreMakeToolHandlers,
	startMcpServer as coreStartMcpServer,
} from "taskflow-mcp-core/server";
import type { RpcHandler } from "taskflow-mcp-core/jsonrpc";
import { grokSubagentRunner } from "taskflow-hosts";

/** Per-call tool handlers with grok subagent execution bound in. */
export function makeToolHandlers(cwd: string): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
	return coreMakeToolHandlers(cwd, grokSubagentRunner);
}

/** Full MCP method dispatch table (protocol + tools), grok-bound. */
export function makeMcpHandlers(cwd: string): Record<string, RpcHandler> {
	return coreMakeMcpHandlers(cwd, grokSubagentRunner);
}

/** Start the stdio MCP server. Resolves when the client disconnects. */
export function startMcpServer(cwd: string = process.cwd()): Promise<void> {
	return coreStartMcpServer(grokSubagentRunner, cwd);
}
