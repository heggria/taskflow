/**
 * The Codex binding of the host-neutral MCP server (taskflow-mcp-core/server).
 *
 * The protocol layer, tool schemas, and handlers all live in core; this shim
 * only closes the loop for Codex: every subagent a flow spawns is itself a
 * `codex exec` process (via codexSubagentRunner). Kept as a module (not just
 * bin.ts) so tests and embedders get the same pre-bound surface the bin runs.
 */

import {
	makeMcpHandlers as coreMakeMcpHandlers,
	makeToolHandlers as coreMakeToolHandlers,
	startMcpServer as coreStartMcpServer,
} from "taskflow-mcp-core/server";
import type { RpcHandler } from "taskflow-mcp-core/jsonrpc";
import { codexSubagentRunner } from "taskflow-hosts";

const HOST_OPTIONS = {
	host: "codex",
	detachedRunner: {
		module: import.meta.resolve("taskflow-hosts/codex"),
		exportName: "codexSubagentRunner",
	},
} as const;

/** Per-call tool handlers with codex subagent execution bound in. */
export function makeToolHandlers(cwd: string): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
	return coreMakeToolHandlers(cwd, codexSubagentRunner, HOST_OPTIONS);
}

/** Full MCP method dispatch table (protocol + tools), codex-bound. */
export function makeMcpHandlers(cwd: string): Record<string, RpcHandler> {
	return coreMakeMcpHandlers(cwd, codexSubagentRunner, HOST_OPTIONS);
}

/** Start the stdio MCP server. Resolves when the client disconnects. */
export function startMcpServer(cwd: string = process.cwd()): Promise<void> {
	return coreStartMcpServer(codexSubagentRunner, cwd, HOST_OPTIONS);
}
