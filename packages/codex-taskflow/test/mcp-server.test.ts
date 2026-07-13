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
import { serveStdio } from "taskflow-mcp-core/jsonrpc";
import { makeMcpHandlers, makeToolHandlers } from "../src/mcp/server.ts";
import { persistTerminalRun } from "taskflow-mcp-core/server";
import type { RunState } from "taskflow-core";

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
	assert.equal(res.result.serverInfo.version, "0.2.0");
});

test("mcp: tools/list exposes the taskflow tools with schemas", async () => {
	const [res] = await rpcRoundtrip([{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
	const names = res.result.tools.map((t: any) => t.name);
	assert.deepEqual(
		names.sort(),
		["taskflow_compile", "taskflow_list", "taskflow_peek", "taskflow_recompute", "taskflow_replay", "taskflow_run", "taskflow_save", "taskflow_search", "taskflow_show", "taskflow_trace", "taskflow_verify", "taskflow_why_stale"],
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

test("mcp: tools/call taskflow_verify validates a flow from defineFile (shared on-disk draft)", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const def = { name: "from-file", phases: [{ id: "a", type: "agent", agent: "executor", task: "do", final: true }] };
	const f = path.join(os.tmpdir(), `tf-definefile-${process.pid}-${Date.now()}.json`);
	fs.writeFileSync(f, JSON.stringify(def));
	try {
		const [res] = await rpcRoundtrip([
			{
				jsonrpc: "2.0",
				id: 99,
				method: "tools/call",
				params: { name: "taskflow_verify", arguments: { defineFile: f } },
			},
		]);
		assert.ok(res.result.content[0].text.includes("verification"), "verify reads the flow from defineFile");
	} finally {
		fs.unlinkSync(f);
	}
});

test("mcp: taskflow_verify with a missing defineFile returns a clear error", async () => {
	const [res] = await rpcRoundtrip([
		{
			jsonrpc: "2.0",
			id: 100,
			method: "tools/call",
			params: {
				name: "taskflow_verify",
				arguments: { defineFile: "/tmp/taskflow-definitely-missing-xyz.json" },
			},
		},
	]);
	assert.equal(res.error.code, -32602);
	assert.match(res.error.message, /defineFile not found:/);
});

test("mcp: defineFile cannot escape cwd or the OS temp directory", async (t) => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const outside = process.platform === "win32"
		? path.join(process.env.SystemRoot ?? "C:\\Windows", "win.ini")
		: "/etc/hosts";
	if (!fs.existsSync(outside)) return t.skip(`no stable outside fixture at ${outside}`);
	const [res] = await rpcRoundtrip([
		{
			jsonrpc: "2.0",
			id: 101,
			method: "tools/call",
			params: { name: "taskflow_verify", arguments: { defineFile: outside } },
		},
	]);
	assert.equal(res.error.code, -32602);
	assert.match(res.error.message, /contained in the server cwd or OS temp directory/i);
});

test("mcp: tools/call unknown tool returns invalid-params", async () => {
	const [res] = await rpcRoundtrip([
		{ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } },
	]);
	assert.equal(res.error.code, -32602);
});

test("mcp: tools/call enforces advertised argument schemas before dispatch", async () => {
	for (const [id, arguments_] of [
		[61, { query: "x", scope: "porject" }],
		[62, { query: 42 }],
		[63, { query: "x", unexpected: true }],
	] as const) {
		const [res] = await rpcRoundtrip([
			{ jsonrpc: "2.0", id, method: "tools/call", params: { name: "taskflow_search", arguments: arguments_ } },
		]);
		assert.equal(res.error.code, -32602);
		assert.match(res.error.message, /Invalid taskflow_search arguments/);
	}
});

test("mcp: makeToolHandlers exposes the tools", () => {
	const tools = makeToolHandlers(process.cwd());
	assert.deepEqual(
		Object.keys(tools).sort(),
		["taskflow_compile", "taskflow_list", "taskflow_peek", "taskflow_recompute", "taskflow_replay", "taskflow_run", "taskflow_save", "taskflow_search", "taskflow_show", "taskflow_trace", "taskflow_verify", "taskflow_why_stale"],
	);
});

test("mcp: terminal persistence failure is surfaced", () => {
	const state = {
		runId: "persist-failure",
		flowName: "persist-failure",
		def: { name: "persist-failure", phases: [] },
		args: {},
		status: "completed",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	} as RunState;
	const error = persistTerminalRun(state, { maxKeep: 1, maxAgeDays: 1 }, () => {
		throw new Error("disk full");
	});
	assert.equal(error, "disk full");
});

test("mcp: taskflow_save + taskflow_search round-trip (the reuse flywheel)", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	// Isolated project cwd with a .pi marker so listFlows finds it.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-lib-mcp-"));
	fs.mkdirSync(path.join(cwd, ".pi", "taskflows"), { recursive: true });
	const tools = makeToolHandlers(cwd);
	try {
		// Save a reusable flow WITH purpose + tags (the recommended workflow).
		const save = (await tools.taskflow_save({
			name: "audit-auth",
			definition: {
				name: "audit-auth",
				args: { dir: { default: "src/routes" } },
				phases: [
					{ id: "d", type: "agent", agent: "executor", task: "List endpoints under {args.dir}.", output: "json", final: true },
				],
			},
			purpose: "审计 API endpoint 是否缺少鉴权",
			tags: ["audit", "auth", "security"],
		})) as { content: { text: string }[] };
		assert.match(save.content[0].text, /Saved taskflow 'audit-auth'/);
		assert.match(save.content[0].text, /审计/);

		// Search by a paraphrased purpose → should find it.
		const search = (await tools.taskflow_search({ query: "check api security auth endpoints" })) as { isError?: boolean; content: { text: string }[] };
		assert.equal(search.isError, false);
		const text = search.content[0].text;
		assert.match(text, /structural mode/);
		assert.ok(text.includes("audit-auth"), `search should surface audit-auth:\n${text}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mcp: taskflow_search with empty query returns an error", async () => {
	const tools = makeToolHandlers(process.cwd());
	const res = (await tools.taskflow_search({ query: "" })) as { isError?: boolean; content: { text: string }[] };
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /requires `query`/);
});

test("mcp: inline run cannot increment a different saved flow's reuse metadata", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-inline-reuse-"));
	fs.mkdirSync(path.join(cwd, ".pi", "taskflows"), { recursive: true });
	const tools = makeToolHandlers(cwd);
	try {
		await tools.taskflow_save({
			name: "saved-a",
			definition: { name: "saved-a", phases: [{ id: "s", type: "script", run: "printf saved", final: true }] },
			purpose: "saved flow",
		});
		const run = (await tools.taskflow_run({
			name: "saved-a",
			define: { name: "inline-b", phases: [{ id: "s", type: "script", run: "printf inline", final: true }] },
			reusedFromSearch: true,
		})) as { isError?: boolean };
		assert.equal(run.isError, false);
		const show = (await tools.taskflow_show({ name: "saved-a", json: true })) as { content: Array<{ text: string }> };
		const parsed = JSON.parse(show.content[0].text) as { library?: { reuseCount?: number } };
		assert.equal(parsed.library?.reuseCount, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
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
	// Every malformed def must short-circuit to a structured FAIL, never throw.
	// `unrenderable` marks defs with no well-formed phase to draw (no SVG image);
	// the rest are renderable-but-invalid (diagram shown with an error overlay).
	for (const { define, unrenderable } of [
		{ define: { name: "x", phases: {} } as unknown, unrenderable: true },
		{ define: { name: "x", phases: [{ type: "agent", task: "t" }] } as unknown, unrenderable: true },
		{ define: { name: "x", phases: [null] } as unknown, unrenderable: true },
		{ define: { name: 1, phases: [{ id: "a", type: "agent", task: "t" }] } as unknown, unrenderable: false },
		{ define: { name: "x", phases: [{ id: 1, type: "agent", task: "t" }] } as unknown, unrenderable: false },
		{ define: { name: "x", phases: [{ id: "a", type: "gate", task: "t", eval: [1] }] } as unknown, unrenderable: false },
	]) {
		const res = (await tools.taskflow_compile({ define })) as {
			content: { type: string; text?: string }[];
			isError: boolean;
		};
		assert.equal(res.isError, true);
		const text = res.content.find((c) => c.type === "text")?.text ?? "";
		assert.match(text, /✗ FAIL/);
		if (unrenderable) {
			assert.ok(!res.content.some((c) => c.type === "image"), "no diagram for an unrenderable flow");
		}
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

// The bundled skill is the plugin's primary authoring surface — a flow example
// that fails taskflow_verify would teach Codex to emit rejected flows. Extract
// every self-contained JSON(c) flow block from every bundled skill file and
// assert it validates.
test("skill: every complete flow example in the bundled skill files passes taskflow_verify", async () => {
	const { readFileSync, readdirSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const path = await import("node:path");
	const skillDir = fileURLToPath(new URL("../plugin/skills/taskflow/", import.meta.url));
	const tools = makeToolHandlers(process.cwd());

	let checked = 0;
	for (const file of readdirSync(skillDir).filter((f) => f.endsWith(".md"))) {
		const src = readFileSync(path.join(skillDir, file), "utf8");
		const re = /```jsonc?\n([\s\S]*?)```/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(src)) !== null) {
			const body = m[1];
			if (!body.includes('"phases"')) continue;
			// Strip // comments + trailing commas so the jsonc example parses as JSON.
			const cleaned = body
				.replace(/(^|[^:])\/\/.*$/gm, "$1")
				.replace(/,(\s*[}\]])/g, "$1");
			let obj: { phases?: unknown[]; name?: unknown };
			try {
				obj = JSON.parse(cleaned);
			} catch {
				continue; // fragment / placeholder block, not a full flow
			}
			if (!obj || !Array.isArray(obj.phases) || !obj.name) continue;
			checked++;
			const res = (await tools.taskflow_verify({ define: obj })) as {
				content: { type: string; text?: string }[];
				isError: boolean;
			};
			const text = res.content.find((c) => c.type === "text")?.text ?? "";
			assert.equal(res.isError, false, `${file} flow example "${obj.name}" must verify cleanly, got: ${text}`);
		}
	}
	assert.ok(checked >= 5, `expected at least 5 complete flow examples across the skill files, found ${checked}`);
});
