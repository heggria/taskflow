/**
 * The Claude Code binding of the host-neutral MCP server (taskflow-mcp-core/server).
 *
 * The protocol layer, tool schemas, and handlers all live in core; this shim
 * only closes the loop for Claude Code: every subagent a flow spawns is itself
 * a `claude -p` process (via claudeSubagentRunner). Kept as a module (not just
 * bin.ts) so tests and embedders get the same pre-bound surface the bin runs.
 */

import {
	makeMcpHandlers as coreMakeMcpHandlers,
	makeToolHandlers as coreMakeToolHandlers,
	startMcpServer as coreStartMcpServer,
} from "taskflow-mcp-core/server";
import type { RpcHandler } from "taskflow-mcp-core/jsonrpc";
import { claudeSubagentRunner } from "taskflow-hosts";

const HOST_OPTIONS = {
	host: "claude",
	detachedRunner: {
		module: import.meta.resolve("taskflow-hosts/claude"),
		exportName: "claudeSubagentRunner",
	},
} as const;

/** Per-call tool handlers with claude subagent execution bound in. */
export function makeToolHandlers(cwd: string): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
	return coreMakeToolHandlers(cwd, claudeSubagentRunner, HOST_OPTIONS);
}

/** Full MCP method dispatch table (protocol + tools), claude-bound. */
export function makeMcpHandlers(cwd: string): Record<string, RpcHandler> {
	return coreMakeMcpHandlers(cwd, claudeSubagentRunner, HOST_OPTIONS);
}

/** Start the stdio MCP server. Resolves when the client disconnects. */
export function startMcpServer(cwd: string = process.cwd()): Promise<void> {
	return coreStartMcpServer(claudeSubagentRunner, cwd, HOST_OPTIONS);
}
