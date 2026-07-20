/**
 * MCP server binding tests for the opencode adapter.
 *
 * The protocol layer + tool handlers live in taskflow-core (fully covered by
 * the codex adapter's mcp-server tests against the same core); these pin the
 * opencode-bound surface: the handshake, the tool roster, and that the shim
 * actually dispatches (verify runs without any opencode process).
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

test("opencode mcp: initialize returns the protocol version + serverInfo", async () => {
	const [res] = await rpcRoundtrip([
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
	]);
	assert.equal(res.id, 1);
	assert.equal(res.result.protocolVersion, "2025-06-18");
	assert.ok(res.result.capabilities.tools, "advertises tools capability");
	assert.equal(res.result.serverInfo.name, "taskflow-opencode");
	assert.equal(res.result.serverInfo.version, "0.2.4");
});

test("opencode mcp: tools/list exposes the taskflow tools", async () => {
	const [res] = await rpcRoundtrip([{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
	const names = res.result.tools.map((t: any) => t.name);
	assert.deepEqual(
		names.sort(),
		["taskflow_compile", "taskflow_lint", "taskflow_list", "taskflow_peek", "taskflow_recompute", "taskflow_reconcile_workspace", "taskflow_replay", "taskflow_resume", "taskflow_run", "taskflow_runs", "taskflow_save", "taskflow_search", "taskflow_show", "taskflow_trace", "taskflow_verify", "taskflow_version", "taskflow_why_stale"],
	);
	for (const t of res.result.tools) {
		assert.equal(typeof t.description, "string");
		assert.equal(t.inputSchema.type, "object");
	}
});

test("opencode mcp: taskflow_verify dispatches through the opencode binding (no execution)", async () => {
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

test("opencode mcp: makeToolHandlers exposes the tools", () => {
	const tools = makeToolHandlers(process.cwd());
	assert.deepEqual(
		Object.keys(tools).sort(),
		["taskflow_compile", "taskflow_lint", "taskflow_list", "taskflow_peek", "taskflow_recompute", "taskflow_reconcile_workspace", "taskflow_replay", "taskflow_resume", "taskflow_run", "taskflow_runs", "taskflow_save", "taskflow_search", "taskflow_show", "taskflow_trace", "taskflow_verify", "taskflow_version", "taskflow_why_stale"],
	);
});
