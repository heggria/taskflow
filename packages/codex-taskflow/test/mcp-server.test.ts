/**
 * MCP server protocol + tool-dispatch tests.
 *
 * Drives the real JSON-RPC stdio loop over in-memory streams (no codex process,
 * no real stdin). Pins the MCP handshake codex expects (initialize / tools/list
 * / tools/call) and the taskflow tool wiring. The run path uses the protocol
 * layer directly with mock flows; a separate e2e (e2e-codex-mcp) proves the
 * real codex-subagent execution.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveStdio } from "../src/mcp/jsonrpc.ts";
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

test("mcp: initialize returns the protocol version + serverInfo codex expects", async () => {
	const [res] = await rpcRoundtrip([
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
	]);
	assert.equal(res.id, 1);
	assert.equal(res.result.protocolVersion, "2025-06-18");
	assert.ok(res.result.capabilities.tools, "advertises tools capability");
	assert.equal(res.result.serverInfo.name, "pi-taskflow");
});

test("mcp: tools/list exposes the taskflow tools with schemas", async () => {
	const [res] = await rpcRoundtrip([{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
	const names = res.result.tools.map((t: any) => t.name);
	assert.deepEqual(
		names.sort(),
		["taskflow_compile", "taskflow_list", "taskflow_run", "taskflow_show", "taskflow_verify"],
	);
	for (const t of res.result.tools) {
		assert.equal(typeof t.description, "string");
		assert.equal(t.inputSchema.type, "object");
	}
});

test("mcp: notification (no id) yields no response", async () => {
	const responses = await rpcRoundtrip([
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ jsonrpc: "2.0", id: 9, method: "ping" },
	]);
	// Only the ping (id:9) should produce a response.
	assert.equal(responses.length, 1);
	assert.equal(responses[0].id, 9);
});

test("mcp: unknown method returns method-not-found error", async () => {
	const [res] = await rpcRoundtrip([{ jsonrpc: "2.0", id: 3, method: "does/not/exist" }]);
	assert.equal(res.error.code, -32601);
});

test("mcp: malformed line returns a parse error", async () => {
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
	input.write("this is not json\n");
	input.end();
	await done;
	assert.equal(responses[0].error.code, -32700);
});

test("mcp: tools/call taskflow_verify validates an inline flow without executing", async () => {
	const [res] = await rpcRoundtrip([
		{
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "taskflow_verify",
				arguments: {
					define: { name: "x", phases: [{ id: "a", type: "agent", agent: "executor", task: "do", final: true }] },
				},
			},
		},
	]);
	assert.ok(res.result.content[0].text.includes("verification"), "returns a verification report");
});

test("mcp: tools/call taskflow_verify flags a cycle as an error", async () => {
	const [res] = await rpcRoundtrip([
		{
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: {
				name: "taskflow_verify",
				arguments: {
					define: {
						name: "cyc",
						phases: [
							{ id: "a", type: "agent", agent: "x", task: "t", dependsOn: ["b"] },
							{ id: "b", type: "agent", agent: "x", task: "t", dependsOn: ["a"], final: true },
						],
					},
				},
			},
		},
	]);
	assert.equal(res.result.isError, true, "a cyclic flow fails verification");
	assert.match(res.result.content[0].text, /FAILED/);
});

test("mcp: tools/call unknown tool returns invalid-params", async () => {
	const [res] = await rpcRoundtrip([
		{ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } },
	]);
	assert.equal(res.error.code, -32602);
});

test("mcp: makeToolHandlers exposes the five tools", () => {
	const tools = makeToolHandlers(process.cwd());
	assert.deepEqual(
		Object.keys(tools).sort(),
		["taskflow_compile", "taskflow_list", "taskflow_run", "taskflow_show", "taskflow_verify"],
	);
});
