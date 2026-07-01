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
	assert.equal(res.result.serverInfo.name, "taskflow");
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

// --- Codex-rendering ergonomics (see docs/codex-mcp.md) -------------------
// Codex shows a `text` block as a fixed grey plaintext <pre> (no markdown, ~192px
// tall). These pin the output shape that keeps that box readable.

test("mcp: taskflow_verify is conclusion-first and dedupes same-rule hits", async () => {
	const tools = makeToolHandlers(process.cwd());
	// Five underscore ids + four terminal-not-final phases: without dedupe this is
	// ~9 near-identical lines (the exact screenshot ugliness).
	const define = {
		name: "code_review",
		phases: [
			{ id: "scope", type: "agent", agent: "scout", task: "scope" },
			{ id: "logic_review", type: "agent", agent: "critic", task: "logic", dependsOn: ["scope"] },
			{ id: "cross_end_review", type: "agent", agent: "critic", task: "cross", dependsOn: ["scope"] },
			{ id: "security_review", type: "agent", agent: "critic", task: "sec", dependsOn: ["scope"] },
			{ id: "test_review", type: "agent", agent: "critic", task: "test", dependsOn: ["scope"] },
		],
	};
	const res = (await tools.taskflow_verify({ define })) as {
		content: { text: string }[];
		isError: boolean;
	};
	const text = res.content[0].text;
	// Line 1 is the verdict + honest raw counts.
	assert.match(text.split("\n")[0], /^✗ verification FAILED — \d+ errors?, \d+ warnings?$/);
	assert.equal(res.isError, true);
	// The underscore rule collapses to ONE line listing the phases, not four.
	const underscoreLines = text.split("\n").filter((l) => l.includes("id uses underscores"));
	assert.equal(underscoreLines.length, 1, "same-rule errors collapse to one line");
	assert.match(underscoreLines[0], /\d+ phases:/);
	// No markdown fences / headers leak into the plaintext box.
	assert.ok(!text.includes("```"), "no code fences");
	assert.ok(!text.includes("###"), "no markdown headings");
});

test("mcp: taskflow_verify passes cleanly with a single line for a good flow", async () => {
	const tools = makeToolHandlers(process.cwd());
	const define = { name: "ok", phases: [{ id: "a", type: "agent", agent: "executor", task: "do", final: true }] };
	const res = (await tools.taskflow_verify({ define })) as { content: { text: string }[]; isError: boolean };
	assert.equal(res.content[0].text, "✓ verification PASSED");
	assert.equal(res.isError, false);
});

// Regression: malformed defs must return a structured validation error, never
// throw or false-pass. verifyTaskflow/compileTaskflow/renderFlowSvg assume a
// well-formed flow, so both tools must validateTaskflow first.
test("mcp: taskflow_verify rejects a missing-phases def without throwing", async () => {
	const tools = makeToolHandlers(process.cwd());
	const res = (await tools.taskflow_verify({ define: { name: "bad" } })) as { content: { text: string }[]; isError: boolean };
	assert.equal(res.isError, true);
	assert.match(res.content[0].text.split("\n")[0], /^✗ verification FAILED/);
	assert.ok(/phase/i.test(res.content[0].text), "names the missing-phase error");
});

test("mcp: taskflow_compile rejects an empty flow instead of false-passing", async () => {
	const tools = makeToolHandlers(process.cwd());
	const res = (await tools.taskflow_compile({ define: { name: "empty", phases: [] } })) as {
		content: { type: string; text?: string }[];
		isError: boolean;
	};
	assert.equal(res.isError, true);
	const text = res.content.find((c) => c.type === "text")?.text ?? "";
	assert.match(text, /✗ FAIL/);
});

test("mcp: taskflow_compile reports a non-string map `over` as FAIL without throwing", async () => {
	const tools = makeToolHandlers(process.cwd());
	const define = { name: "m", phases: [{ id: "a", type: "map", over: ["x"], task: "t" }] };
	const res = (await tools.taskflow_compile({ define })) as {
		content: { type: string; text?: string }[];
		isError: boolean;
	};
	assert.equal(res.isError, true);
	const text = res.content.find((c) => c.type === "text")?.text ?? "";
	assert.match(text, /✗ FAIL/);
});

test("mcp: taskflow_compile handles hard-malformed defs without throwing", async () => {
	const tools = makeToolHandlers(process.cwd());
	// Non-array phases and a phase missing its id both crash the compiler/renderer
	// if they reach it; the handler must short-circuit to a structured FAIL.
	for (const define of [
		{ name: "x", phases: {} } as unknown,
		{ name: "x", phases: [{ type: "agent", task: "t" }] } as unknown,
	]) {
		const res = (await tools.taskflow_compile({ define })) as {
			content: { type: string; text?: string }[];
			isError: boolean;
		};
		assert.equal(res.isError, true);
		const text = res.content.find((c) => c.type === "text")?.text ?? "";
		assert.match(text, /✗ FAIL/);
		// No SVG image for an unrenderable flow.
		assert.ok(!res.content.some((c) => c.type === "image"), "no diagram for an unrenderable flow");
	}
});

test("mcp: taskflow_show returns raw JSON with no code fence", async () => {
	const tools = makeToolHandlers(process.cwd());
	const res = (await tools.taskflow_show({ name: "definitely-not-a-real-saved-flow" })) as {
		content: { text: string }[];
		isError: boolean;
	};
	// Missing flow -> error text (exercises the handler without needing a saved flow).
	assert.equal(res.isError, true);
	assert.ok(!res.content[0].text.includes("```"));
});

test("mcp: taskflow_compile returns an SVG image block for a small flow", async () => {
	const tools = makeToolHandlers(process.cwd());
	const define = {
		name: "tiny",
		phases: [
			{ id: "a", type: "agent", agent: "executor", task: "one" },
			{ id: "b", type: "agent", agent: "executor", task: "two", dependsOn: ["a"], final: true },
		],
	};
	const res = (await tools.taskflow_compile({ define })) as {
		content: { type: string; data?: string; mimeType?: string; text?: string }[];
	};
	const img = res.content.find((c) => c.type === "image");
	assert.ok(img, "emits an image content block");
	assert.equal(img!.mimeType, "image/svg+xml");
	const svg = Buffer.from(img!.data!, "base64").toString("utf8");
	assert.match(svg, /^<svg /);
	assert.ok(svg.includes("</svg>"));
	// A text block rides along so the CLI/TUI (which can't render images) and
	// vision-less models still get the graph: caption + a layered DAG outline.
	const text = res.content.find((c) => c.type === "text");
	assert.ok(text, "emits a text fallback block alongside the image");
	assert.match(text!.text!, /2 phases/);
	assert.match(text!.text!, /Layer 1:/);
	assert.match(text!.text!, /b ★/); // final marker in the outline
	assert.match(text!.text!, /← a/); // dependency edge rendered as text
});

test("mcp: taskflow_compile falls back to text-only (with outline) for a huge flow", async () => {
	const tools = makeToolHandlers(process.cwd());
	// Past the SVG legibility limit -> no image, but the text outline must remain.
	const phases = Array.from({ length: 80 }, (_, i) => ({
		id: `p${i}`,
		type: "agent",
		agent: "executor",
		task: "x",
		...(i ? { dependsOn: [`p${i - 1}`] } : {}),
		...(i === 79 ? { final: true } : {}),
	}));
	const res = (await tools.taskflow_compile({ define: { name: "huge", phases } })) as {
		content: { type: string; text?: string }[];
	};
	assert.ok(!res.content.some((c) => c.type === "image"), "no image for an oversized graph");
	const text = res.content.find((c) => c.type === "text");
	assert.match(text!.text!, /80 phases/);
	assert.match(text!.text!, /Layer 1:/);
});
