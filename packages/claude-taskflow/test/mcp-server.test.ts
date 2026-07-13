/**
 * MCP server binding tests for the claude adapter.
 *
 * The protocol layer + tool handlers live in taskflow-core (fully covered by
 * packages/codex-taskflow/test/mcp-server.test.ts against the same core); these
 * pin the claude-bound surface: the handshake, the tool roster, and that the
 * shim actually dispatches (verify runs without any claude process).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveStdio } from "taskflow-mcp-core/jsonrpc";
import { makeMcpHandlers, makeToolHandlers } from "../src/mcp/server.ts";

/** Send a list of JSON-RPC messages through the server, collect responses. */
async function rpcRoundtrip(messages: object[]): Promise<any[]> {
	const input = new PassThrough();
	const output = new PassThrough();
	const responses: any[] = [];

	let outBuf = "";
	output.on("data", (d) => {
		outBuf += d.toString();
		let i: number;
		while ((i = outBuf.indexOf("\n")) >= 0) {
			const line = outBuf.slice(0, i);
			outBuf = outBuf.slice(i + 1);
			if (line.trim()) responses.push(JSON.parse(line));
		}
	});

	const done = serveStdio(makeMcpHandlers(process.cwd()), { input, output });
	for (const m of messages) input.write(JSON.stringify(m) + "\n");
	input.end();
	await done;
	return responses;
}

test("claude mcp: initialize returns the protocol version + serverInfo", async () => {
	const [res] = await rpcRoundtrip([
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
	]);
	assert.equal(res.id, 1);
	assert.equal(res.result.protocolVersion, "2025-06-18");
	assert.ok(res.result.capabilities.tools, "advertises tools capability");
	assert.equal(res.result.serverInfo.name, "taskflow-claude");
	assert.equal(res.result.serverInfo.version, "0.2.1");
});

test("claude mcp: tools/list exposes the same taskflow tools as codex", async () => {
	const [res] = await rpcRoundtrip([{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
	const names = res.result.tools.map((t: any) => t.name);
	assert.deepEqual(
		names.sort(),
		["taskflow_compile", "taskflow_list", "taskflow_peek", "taskflow_recompute", "taskflow_reconcile_workspace", "taskflow_replay", "taskflow_resume", "taskflow_run", "taskflow_save", "taskflow_search", "taskflow_show", "taskflow_trace", "taskflow_verify", "taskflow_version", "taskflow_why_stale"],
	);
	for (const t of res.result.tools) {
		assert.equal(typeof t.description, "string");
		assert.equal(t.inputSchema.type, "object");
	}
});

test("claude mcp: taskflow_verify dispatches through the claude binding (no execution)", async () => {
	const [res] = await rpcRoundtrip([
		{
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "taskflow_verify",
				arguments: {
					define: { name: "x", phases: [{ id: "a", type: "agent", agent: "executor", task: "do", final: true }] },
				},
			},
		},
	]);
	assert.equal(res.result.content[0].text, "✓ verification PASSED");
	assert.equal(res.result.isError, false);
});

test("claude mcp: makeToolHandlers exposes the tools", () => {
	const tools = makeToolHandlers(process.cwd());
	assert.deepEqual(
		Object.keys(tools).sort(),
		["taskflow_compile", "taskflow_list", "taskflow_peek", "taskflow_recompute", "taskflow_reconcile_workspace", "taskflow_replay", "taskflow_resume", "taskflow_run", "taskflow_save", "taskflow_search", "taskflow_show", "taskflow_trace", "taskflow_verify", "taskflow_version", "taskflow_why_stale"],
	);
});
