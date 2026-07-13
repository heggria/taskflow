import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type EventAccumulator,
	CTX_TOOLS_GUIDANCE,
	foldEventLine,
	isFailed,
	looksLikeHtmlOrJson,
	mapWithConcurrencyLimit,
	newAccumulator,
	runAgentTask,
	createPiSubagentRunner,
	type RunResult,
	sanitizeErrorMessage,
	TRANSPORT_ERROR_PLACEHOLDER,
} from "../src/runner.ts";
import type { AgentConfig } from "taskflow-core";
import { emptyUsage } from "taskflow-core";

// ── isFailed ────────────────────────────────────────────────────────

function mkResult(overrides: Partial<RunResult> = {}): RunResult {
	return {
		agent: "a",
		task: "t",
		exitCode: 0,
		output: "ok",
		stderr: "",
		usage: emptyUsage(),
		stopReason: "end",
		...overrides,
	};
}

test("isFailed: returns false for exitCode 0 and normal stopReason", () => {
	assert.equal(isFailed(mkResult()), false);
	assert.equal(isFailed(mkResult({ stopReason: "end" })), false);
	assert.equal(isFailed(mkResult({ stopReason: undefined })), false);
});

test("isFailed: returns true for non-zero exitCode", () => {
	assert.equal(isFailed(mkResult({ exitCode: 1 })), true);
	assert.equal(isFailed(mkResult({ exitCode: 127 })), true);
	assert.equal(isFailed(mkResult({ exitCode: -1 })), true);
});

test("isFailed: returns true for stopReason 'error'", () => {
	assert.equal(isFailed(mkResult({ stopReason: "error" })), true);
});

test("isFailed: returns true for stopReason 'aborted'", () => {
	assert.equal(isFailed(mkResult({ stopReason: "aborted" })), true);
});

test("isFailed: returns true when multiple failure indicators combine", () => {
	assert.equal(isFailed(mkResult({ exitCode: 1, stopReason: "error" })), true);
});

// ── foldEventLine (NDJSON event accumulation) ───────────────────────

function assistantLine(opts: {
	text?: string;
	usage?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number }; totalTokens: number }>;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}): string {
	const content: unknown[] = [];
	if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content,
			usage: opts.usage,
			model: opts.model,
			stopReason: opts.stopReason,
			errorMessage: opts.errorMessage,
		},
	});
}

test("foldEventLine: ignores empty, malformed, and non-message_end lines", () => {
	const acc = newAccumulator();
	assert.equal(foldEventLine(acc, ""), null);
	assert.equal(foldEventLine(acc, "   "), null);
	assert.equal(foldEventLine(acc, "not json {"), null);
	assert.equal(foldEventLine(acc, JSON.stringify({ type: "message_start", message: {} })), null);
	assert.equal(foldEventLine(acc, JSON.stringify({ type: "message_end" })), null); // no message
	assert.equal(acc.messages.length, 0);
	assert.deepEqual(acc.usage, emptyUsage());
});

test("foldEventLine: accumulates usage and returns a live update for assistant turns", () => {
	const acc = newAccumulator();
	const live = foldEventLine(
		acc,
		assistantLine({ text: "hello", usage: { input: 100, output: 50, cost: { total: 0.002 }, totalTokens: 1234 }, model: "m1" }),
	);
	assert.ok(live);
	assert.equal(live?.text, "hello");
	assert.equal(live?.model, "m1");
	assert.equal(acc.usage.input, 100);
	assert.equal(acc.usage.output, 50);
	assert.equal(acc.usage.cost, 0.002);
	assert.equal(acc.usage.contextTokens, 1234);
	assert.equal(acc.usage.turns, 1);
	assert.equal(acc.model, "m1");
});

test("foldEventLine: sums usage across multiple assistant turns", () => {
	const acc = newAccumulator();
	foldEventLine(acc, assistantLine({ text: "a", usage: { input: 10, output: 5, cost: { total: 0.001 } } }));
	foldEventLine(acc, assistantLine({ text: "b", usage: { input: 20, output: 8, cost: { total: 0.002 } } }));
	assert.equal(acc.usage.input, 30);
	assert.equal(acc.usage.output, 13);
	assert.equal(Number(acc.usage.cost.toFixed(3)), 0.003);
	assert.equal(acc.usage.turns, 2);
	assert.equal(acc.messages.length, 2);
});

test("foldEventLine: a non-assistant message is recorded but yields no live update", () => {
	const acc = newAccumulator();
	const live = foldEventLine(acc, JSON.stringify({ type: "message_end", message: { role: "user", content: [] } }));
	assert.equal(live, null);
	assert.equal(acc.messages.length, 1);
	assert.equal(acc.usage.turns, 0);
});

test("foldEventLine: captures stopReason and errorMessage", () => {
	const acc = newAccumulator();
	foldEventLine(acc, assistantLine({ text: "boom", stopReason: "error", errorMessage: "kaboom" }));
	assert.equal(acc.stopReason, "error");
	assert.equal(acc.errorMessage, "kaboom");
});

test("newAccumulator: seeds the model so the initial model wins over later messages", () => {
	const acc: EventAccumulator = newAccumulator("seed-model");
	foldEventLine(acc, assistantLine({ text: "x", model: "other" }));
	assert.equal(acc.model, "seed-model");
});

// ── mapWithConcurrencyLimit ─────────────────────────────────────────

test("mapWithConcurrencyLimit: empty array returns empty array", async () => {
	const result = await mapWithConcurrencyLimit([], 4, async () => "nope");
	assert.deepEqual(result, []);
});

test("mapWithConcurrencyLimit: processes all items and preserves order", async () => {
	const items = [10, 20, 30, 40, 50];
	const result = await mapWithConcurrencyLimit(items, 3, async (item) => item * 2);
	assert.deepEqual(result, [20, 40, 60, 80, 100]);
});

test("mapWithConcurrencyLimit: passes correct index to callback", async () => {
	const items = ["a", "b", "c"];
	const indices: number[] = [];
	await mapWithConcurrencyLimit(items, 2, async (_item, index) => {
		indices.push(index);
	});
	assert.deepEqual(indices.sort(), [0, 1, 2]);
});

test("mapWithConcurrencyLimit: respects concurrency cap", async () => {
	let active = 0;
	let peak = 0;
	const items = Array.from({ length: 8 }, (_, i) => i);

	await mapWithConcurrencyLimit(items, 2, async (item) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 5));
		active--;
		return item;
	});

	assert.ok(peak <= 2, `peak concurrency was ${peak}, expected ≤ 2`);
	assert.ok(peak >= 1, `peak concurrency was ${peak}, expected ≥ 1`);
});

test("mapWithConcurrencyLimit: concurrency=1 serializes execution", async () => {
	let active = 0;
	let peak = 0;
	const items = [1, 2, 3, 4];

	await mapWithConcurrencyLimit(items, 1, async (item) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 5));
		active--;
		return item;
	});

	assert.equal(peak, 1, "concurrency=1 must serialize");
});

test("mapWithConcurrencyLimit: concurrency > items.length works (clamped)", async () => {
	const items = [1, 2];
	const result = await mapWithConcurrencyLimit(items, 100, async (item) => item + 1);
	assert.deepEqual(result, [2, 3]);
});

test("mapWithConcurrencyLimit: concurrency=0 is clamped to 1", async () => {
	const items = [1, 2, 3];
	const result = await mapWithConcurrencyLimit(items, 0, async (item) => item * 10);
	assert.deepEqual(result, [10, 20, 30]);
});

test("mapWithConcurrencyLimit: negative concurrency is clamped to 1", async () => {
	const result = await mapWithConcurrencyLimit([42], -5, async (item) => item);
	assert.deepEqual(result, [42]);
});

test("mapWithConcurrencyLimit: error in callback rejects the promise", async () => {
	const items = [1, 2, 3, 4, 5];
	await assert.rejects(
		() =>
			mapWithConcurrencyLimit(items, 2, async (item) => {
				if (item === 3) throw new Error("boom at 3");
				return item;
			}),
		{ message: "boom at 3" },
	);
});

test("mapWithConcurrencyLimit: single item works", async () => {
	const result = await mapWithConcurrencyLimit([99], 4, async (item) => `val:${item}`);
	assert.deepEqual(result, ["val:99"]);
});

test("mapWithConcurrencyLimit: async results resolve in correct slots despite variable delays", async () => {
	const items = [50, 40, 30, 20, 10];
	const result = await mapWithConcurrencyLimit(items, 5, async (item) => {
		await new Promise((r) => setTimeout(r, item / 10));
		return item * 2;
	});
	assert.deepEqual(result, [100, 80, 60, 40, 20]);
});

// ── sanitizeErrorMessage / looksLikeHtmlOrJson ──────────────────────

test("sanitizeErrorMessage: passes through short, plain messages", () => {
	assert.equal(sanitizeErrorMessage("Network timeout"), "Network timeout");
	assert.equal(sanitizeErrorMessage(""), "");
	assert.equal(sanitizeErrorMessage(undefined), "");
});

test("sanitizeErrorMessage: truncates oversized messages with a marker", () => {
	const big = "x".repeat(8000);
	const out = sanitizeErrorMessage(big);
	assert.ok(out.length < 600, `should be truncated, got ${out.length}`);
	assert.match(out, /truncated \d+ chars/);
});

test("sanitizeErrorMessage: summarizes upstream HTML (Cloudflare challenge) without leaking it", () => {
	// A realistic Cloudflare challenge page is several KB — pad to ensure the
	// HTML summarization branch fires.
	const pad = " ".repeat(800);
	const cf = `<html><head><title>Just a moment...</title></head><body><div class="message">Unable to load site</div><span>Ray ID: a06c4b0eade32650</span>${pad}</body></html>`;
	const out = sanitizeErrorMessage(cf);
	assert.match(out, /non-JSON response/);
	assert.match(out, /Hint: Just a moment\.\.\./, "page title should be preferred when present");
	assert.ok(!out.includes("<html>"), "raw HTML tags must not leak through");
	assert.ok(!out.includes("a06c4b0eade32650"), "Ray ID should not be preserved verbatim");
});

test("sanitizeErrorMessage: falls back to title when HTML has no other known hints", () => {
	const page = `<html><head><title>Gateway blocked</title></head><body><div>Request denied</div></body></html>`;
	const out = sanitizeErrorMessage(page);
	assert.match(out, /Hint: Gateway blocked/);
	assert.ok(!out.includes("<title>"));
});

test("sanitizeErrorMessage: keeps short HTML as-is (false positive guard)", () => {
	// A short string starting with '<' that's clearly not a page (e.g. an error
	// code like "<unknown>") should be left alone.
	const out = sanitizeErrorMessage("<unknown>");
	assert.equal(out, "<unknown>");
});

test("looksLikeHtmlOrJson: detects document-like HTML", () => {
	assert.equal(looksLikeHtmlOrJson("<html><body>x</body></html>"), true);
	assert.equal(looksLikeHtmlOrJson("<!doctype html><html>"), true);
	assert.equal(looksLikeHtmlOrJson("<div>oops</div>"), true);
	assert.equal(looksLikeHtmlOrJson("plain error text"), false);
	assert.equal(looksLikeHtmlOrJson(""), false);
});

test("TRANSPORT_ERROR_PLACEHOLDER: stable marker for failed output", () => {
	assert.equal(TRANSPORT_ERROR_PLACEHOLDER, "(upstream error: subagent failed; see error)");
});

// ── runAgentTask: spawn error handling (F-003) ──────────────────────

test("runAgentTask: captures spawn ENOENT into errorMessage and stderr (not silently swallowed)", async () => {
	// Force spawn to fail by pointing PI_TASKFLOW_PI_BIN at a guaranteed-
	// nonexistent path. The runner must surface the underlying errno/path
	// so callers can diagnose "pi: command not found" instead of seeing
	// an opaque exitCode: 1, stderr: "", errorMessage: undefined.
	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = "/nonexistent/pi-taskflow-fixture-binary-xyz";
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "/dev/null" },
		];
		const result = await runAgentTask("/tmp", agents, "t", "do something", {});
		assert.equal(result.exitCode, 1);
		assert.equal(result.output, TRANSPORT_ERROR_PLACEHOLDER);
		assert.ok(result.errorMessage, "errorMessage must be set when spawn fails");
		assert.match(result.errorMessage, /ENOENT|nonexistent/i, `expected ENOENT/nonexistent in errorMessage, got: ${result.errorMessage}`);
		assert.ok(result.stderr.length > 0, "stderr must capture the spawn error message");
		assert.match(result.stderr, /ENOENT|nonexistent/i, `expected ENOENT/nonexistent in stderr, got: ${result.stderr}`);
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
	}
});

// ── runAgentTask: errorMessage sanitization (F-013) ────────────────

test("runAgentTask: sanitizes errorMessage even when output is truthy (mid-stream failure)", async () => {
	// Simulate a subagent that emitted a partial assistant message, then
	// crashed with a raw HTML errorMessage (e.g. an upstream gateway returned
	// a Cloudflare-style challenge page mid-stream). The errorMessage must be
	// sanitized regardless of whether result.output is truthy, otherwise the
	// raw HTML leaks into PhaseState and downstream interpolation contexts.
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-taskflow-f013-"));
	const scriptPath = path.join(tmpDir, "fake-pi.sh");
	// The script ignores the args the runner passes (--mode json -p ...) and
	// instead emits a deterministic event stream: one good assistant turn,
	// then a terminal error with an HTML errorMessage, then exit 1.
	const scriptBody = `#!/bin/sh
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial work"}]}}'
echo '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"<html><head><title>Just a moment...</title></head><body>Unable to load site pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad</body></html>"}}'
exit 1
`;
	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	try {
		await fs.promises.writeFile(scriptPath, scriptBody, { mode: 0o755 });
		process.env.PI_TASKFLOW_PI_BIN = scriptPath;
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "/dev/null" },
		];
		const result = await runAgentTask("/tmp", agents, "t", "do something", {});
		assert.equal(result.exitCode, 1, "subagent must report failure");
		assert.equal(result.stopReason, "error");
		assert.equal(result.output, "partial work", "truthy output must be preserved (not replaced with placeholder)");
		assert.ok(result.errorMessage, "errorMessage must be set on failure");
		assert.ok(
			!result.errorMessage.includes("<html>"),
			`raw HTML must not leak through, got: ${result.errorMessage}`,
		);
		assert.ok(
			!result.errorMessage.includes("Ray ID") && !result.errorMessage.includes("Unable to load site"),
			`raw HTML body must not leak through, got: ${result.errorMessage}`,
		);
		assert.match(result.errorMessage, /non-JSON response/, "sanitization marker must be present");
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	}
});

// ── idle watchdog (subagent stall) ──────────────────────────────────

test("runAgentTask: idle watchdog kills a silent (stalled) subagent", async () => {
	// A fake "pi" binary that produces NO stdout and just sleeps forever
	// simulates a wedged subagent (hung stream / provider stall / tool deadlock).
	// The idle watchdog must kill it and surface a stall error instead of
	// hanging the whole flow indefinitely.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-idle-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		// Sleep 60s with no output. Keep the event loop alive.
		`setTimeout(() => process.exit(0), 60000);\n`,
	);

	const agents: AgentConfig[] = [
		{ name: "stall", description: "d", systemPrompt: "", source: "user", filePath: "" },
	];

	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = `${process.execPath}`;
	// getPiInvocation returns { command: override, args }, so prepend the script
	// via a wrapper: easier to point the override at a node that runs our script.
	// We instead set the override to a tiny shim that execs node fake-pi.mjs.
	const shim = path.join(dir, "shim.sh");
	fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}"\n`);
	fs.chmodSync(shim, 0o755);
	process.env.PI_TASKFLOW_PI_BIN = shim;

	try {
		const start = Date.now();
		const res = await runAgentTask(dir, agents, "stall", "do work", {
			idleTimeoutMs: 300, // 300ms idle → kill
		});
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 10_000, `should be killed quickly, took ${elapsed}ms`);
		assert.equal(isFailed(res), true, "stalled subagent must be a failure");
		assert.match(res.errorMessage ?? "", /stalled|idle timeout/i);
		assert.equal(res.idleTimeout, true, "idleTimeout flag must be set");
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── signal kill detection (C-1) ─────────────────────────────────────

test("runAgentTask: process killed by signal marks as failed", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-signal-"));
	// Use a shell script that starts node, waits, then kills it with SIGKILL.
	// The shell exits with code 137 (128+SIGKILL) — this is the standard behavior
	// when a child process is killed by a signal and the parent reaps it.
	const script = path.join(dir, "run.sh");
	fs.writeFileSync(
		script,
		`#!/bin/sh\n"${process.execPath}" -e "setTimeout(() => {}, 60000)" &\npid=$!\nsleep 0.1\nkill -9 $pid\nwait $pid 2>/dev/null\n`,
	);
	fs.chmodSync(script, 0o755);

	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = script;
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
		];
		const res = await runAgentTask(dir, agents, "t", "do work", {});
		assert.equal(isFailed(res), true, "signal-killed process must be a failure");
		// The shell exits with 137 (128+SIGKILL) which is non-zero → failure.
		assert.ok(res.exitCode !== 0, "exitCode must be non-zero for killed process");
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runAgentTask: signal kill preserves partial output", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-signal-partial-"));
	// A script that emits partial output then gets killed.
	const script = path.join(dir, "run.sh");
	// Use a node process that writes partial output then waits forever.
	// The shell kills it with SIGKILL after a short delay.
	const nodeScript = path.join(dir, "worker.mjs");
	fs.writeFileSync(
		nodeScript,
		`process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'partial work'}]}})+'\\n');\nsetTimeout(() => {}, 60000);\n`,
	);
	fs.writeFileSync(
		script,
		`#!/bin/sh\n"${process.execPath}" "${nodeScript}" &\npid=$!\nsleep 0.2\nkill -9 $pid\nwait $pid 2>/dev/null\n`,
	);
	fs.chmodSync(script, 0o755);

	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = script;
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
		];
		const res = await runAgentTask(dir, agents, "t", "do work", {});
		assert.equal(res.output, "partial work", "partial output must be preserved");
		assert.equal(isFailed(res), true, "killed process must be a failure");
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── stderr cap (M-7) ───────────────────────────────────────────────

test("runAgentTask: stderr is capped at 64KB", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-stderr-cap-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	// Write 100KB of garbage to stderr, then exit 0.
	fs.writeFileSync(
		fakePi,
		`process.stderr.write("A".repeat(100_000));\nprocess.exit(0);\n`,
	);
	const shim = path.join(dir, "shim.sh");
	fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}"\n`);
	fs.chmodSync(shim, 0o755);

	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = shim;
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
		];
		const res = await runAgentTask(dir, agents, "t", "do work", {});
		assert.ok(res.stderr.length <= 64 * 1024 + 50, `stderr should be capped, got ${res.stderr.length}`);
		assert.match(res.stderr, /truncated/, "stderr cap must include truncation marker");
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── message cap (M-6) ──────────────────────────────────────────────

test("foldEventLine: message cap prevents unbounded growth", () => {
	const acc = newAccumulator();
	const line = assistantLine({ text: "turn" });
	for (let i = 0; i < 600; i++) {
		foldEventLine(acc, line);
	}
	assert.ok(acc.messages.length <= 500, `messages capped at 500, got ${acc.messages.length}`);
	// Usage must still accumulate beyond the cap.
	assert.equal(acc.usage.turns, 600, "usage must accumulate even after cap");
});

// ── fix-7: stderr truncation marker appears exactly once ───────────

test("fix-7: stderr truncation marker appears exactly once even with many chunks", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-stderr-once-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	// Write 200KB in 10KB chunks — the truncation should cap at 64KB and the
	// marker should appear exactly once.
	fs.writeFileSync(
		fakePi,
		`for (let i = 0; i < 20; i++) { process.stderr.write('A'.repeat(10_000)); }
process.exit(0);
`,
	);
	const shim = path.join(dir, "shim.sh");
	fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}"\n`);
	fs.chmodSync(shim, 0o755);

	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = shim;
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
		];
		const res = await runAgentTask(dir, agents, "t", "do work", {});
		assert.ok(res.stderr.length <= 64 * 1024 + 50, `stderr should be capped, got ${res.stderr.length}`);
		// Count occurrences of the truncation marker.
		const markerCount = (res.stderr.match(/\[\.\.\.stderr truncated at 64KB\]/g) ?? []).length;
		assert.equal(markerCount, 1, `truncation marker must appear exactly once, got ${markerCount}`);
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── Shared Context Tree: guidance + env + extension wiring ───────────

test("CTX_TOOLS_GUIDANCE mentions all four tools and the read-first discipline", () => {
	for (const tool of ["ctx_read", "ctx_write", "ctx_report", "ctx_spawn"]) {
		assert.match(CTX_TOOLS_GUIDANCE, new RegExp(tool), `guidance mentions ${tool}`);
	}
	assert.match(CTX_TOOLS_GUIDANCE, /BEFORE exploring/i, "tells the agent to read before exploring");
});

test("runAgentTask: ctxDir/nodeId opt-in injects env, --extension, and the guidance prompt", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-ctxwire-"));
	const capture = path.join(dir, "capture.json");
	const fakePi = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		`import * as fs from "node:fs";\n` +
			`const argv = process.argv.slice(2);\n` +
			`const i = argv.indexOf("--append-system-prompt");\n` +
			`const promptFile = i >= 0 ? argv[i + 1] : null;\n` +
			`const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";\n` +
			`fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({\n` +
			`  hasExtension: argv.includes("--extension"),\n` +
			`  tools: (() => { const j = argv.indexOf("--tools"); return j >= 0 ? argv[j + 1] : null; })(),\n` +
			`  ctxDir: process.env.PI_TASKFLOW_CTX_DIR ?? null,\n` +
			`  nodeId: process.env.PI_TASKFLOW_NODE_ID ?? null,\n` +
			`  cwdBridgeMode: process.env.TASKFLOW_CWD_BRIDGE_MODE ?? null,\n` +
			`  reconcileMode: process.env.TASKFLOW_WORKSPACE_RECONCILE_MODE ?? null,\n` +
			`  prompt,\n` +
			`}));\n` +
			`process.exit(0);\n`,
	);
	const shim = path.join(dir, "shim.sh");
	fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`);
	fs.chmodSync(shim, 0o755);

	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	const prevExt = process.env.PI_TASKFLOW_EXT_PATH;
	const prevBridge = process.env.TASKFLOW_CWD_BRIDGE_MODE;
	const prevReconcile = process.env.TASKFLOW_WORKSPACE_RECONCILE_MODE;
	process.env.PI_TASKFLOW_PI_BIN = shim;
	process.env.PI_TASKFLOW_EXT_PATH = fakePi; // a real file so --extension is added
	process.env.TASKFLOW_CWD_BRIDGE_MODE = "resolve-only";
	process.env.TASKFLOW_WORKSPACE_RECONCILE_MODE = "explicit";
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "AGENT-OWN-PROMPT", source: "user", filePath: "" },
		];

		// (1) Opted IN.
		await runAgentTask(dir, agents, "t", "do work", { ctxDir: dir, nodeId: "node-1" });
		const on = JSON.parse(fs.readFileSync(capture, "utf-8"));
		assert.equal(on.ctxDir, dir, "PI_TASKFLOW_CTX_DIR injected");
		assert.equal(on.nodeId, "node-1", "PI_TASKFLOW_NODE_ID injected");
		assert.equal(on.cwdBridgeMode, null, "host cwd bridge authority is not inherited by the child");
		assert.equal(on.reconcileMode, null, "host reconciliation authority is not inherited by the child");
		assert.equal(on.hasExtension, true, "--extension flag added");
		assert.match(on.prompt, /AGENT-OWN-PROMPT/, "agent's own prompt preserved");
		assert.match(on.prompt, /Shared Context Tree/, "guidance appended");
		assert.match(on.prompt, /ctx_read/, "guidance lists the tools");

		// (1b) An agent with a TOOLS WHITELIST must get the ctx_* tools appended,
		// else --tools would filter out the registered tools (real e2e bug).
		fs.rmSync(capture, { force: true });
		const whitelisted: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "", tools: ["read", "grep"] },
		];
		await runAgentTask(dir, whitelisted, "t", "do work", { ctxDir: dir, nodeId: "node-2" });
		const wl = JSON.parse(fs.readFileSync(capture, "utf-8"));
		assert.ok(wl.tools, "--tools whitelist present");
		for (const t of ["read", "grep", "ctx_read", "ctx_write", "ctx_report", "ctx_spawn"]) {
			assert.match(wl.tools, new RegExp(`\\b${t}\\b`), `whitelist includes ${t}`);
		}

		// (2) Opted OUT.
		fs.rmSync(capture, { force: true });
		await runAgentTask(dir, agents, "t", "do work", {});
		const off = JSON.parse(fs.readFileSync(capture, "utf-8"));
		assert.equal(off.ctxDir, null, "no ctx env when not opted in");
		assert.equal(off.nodeId, null);
		assert.equal(off.hasExtension, false, "no --extension when not opted in");
		assert.doesNotMatch(off.prompt, /Shared Context Tree/, "no guidance when not opted in");
		assert.match(off.prompt, /AGENT-OWN-PROMPT/, "agent prompt still present");
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		if (prevExt === undefined) delete process.env.PI_TASKFLOW_EXT_PATH;
		else process.env.PI_TASKFLOW_EXT_PATH = prevExt;
		if (prevBridge === undefined) delete process.env.TASKFLOW_CWD_BRIDGE_MODE;
		else process.env.TASKFLOW_CWD_BRIDGE_MODE = prevBridge;
		if (prevReconcile === undefined) delete process.env.TASKFLOW_WORKSPACE_RECONCILE_MODE;
		else process.env.TASKFLOW_WORKSPACE_RECONCILE_MODE = prevReconcile;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("Pi child resource profiles: isolated default, allowlist, and host-only inherit build safe argv", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-profile-"));
	const capture = path.join(dir, "argv.json");
	const extension = path.join(dir, "trusted-extension.ts");
	const fakePi = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(extension, "export default function trusted() {}\n");
	fs.writeFileSync(
		fakePi,
		`#!${process.execPath}\n` +
			`import fs from "node:fs";\n` +
			`fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n` +
			`const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n");\n` +
			`emit({type:"agent_start"}); emit({type:"turn_start"});\n` +
			`emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"DONE"}],stopReason:"stop"}});\n` +
			`emit({type:"agent_end"});\n`,
	);
	fs.chmodSync(fakePi, 0o755);
	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = fakePi;
	const agents: AgentConfig[] = [
		{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
	];
	try {
		const isolated = await runAgentTask(dir, agents, "t", "default", {});
		assert.equal(isolated.exitCode, 0);
		let argv = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
		assert.ok(argv.includes("--no-extensions"), "isolated is the default profile");
		assert.equal(argv.at(-1), "Task: default", "the prompt remains the final positional argument");

		const allowlisted = await createPiSubagentRunner({
			resourceProfile: "allowlist",
			extensions: [extension, extension],
			terminalGraceMs: 25,
		}).runTask(dir, agents, "t", "allow", {});
		assert.equal(allowlisted.exitCode, 0);
		argv = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
		assert.ok(argv.includes("--no-extensions"));
		const extensionValues = argv.flatMap((entry, index) => entry === "--extension" ? [argv[index + 1]] : []);
		assert.deepEqual(extensionValues, [fs.realpathSync(extension)], "allowlist is canonicalized and deduplicated");

		const inherited = await createPiSubagentRunner({
			resourceProfile: "inherit",
			extensions: [],
			terminalGraceMs: 25,
		}).runTask(dir, agents, "t", "inherit", {});
		assert.equal(inherited.exitCode, 0);
		argv = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
		assert.equal(argv.includes("--no-extensions"), false, "only trusted host configuration can select inherit");

		const invalid = await createPiSubagentRunner({
			resourceProfile: "allowlist",
			extensions: ["relative-extension.ts"],
			terminalGraceMs: 25,
		}).runTask(dir, agents, "t", "invalid", {});
		assert.equal(isFailed(invalid), true);
		assert.match(invalid.errorMessage ?? "", /absolute path/i);
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("Pi completion: final + agent_end + agent_settled with a leaky handle is reaped successfully", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-terminal-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		`#!${process.execPath}\n` +
			`const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n");\n` +
			`emit({type:"agent_start"}); emit({type:"turn_start"});\n` +
			`emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"PHASE_ONE_DONE"}],stopReason:"stop"}});\n` +
			`emit({type:"agent_end"}); emit({type:"agent_settled"});\n` +
			`setInterval(()=>{},1000);\n`,
	);
	fs.chmodSync(fakePi, 0o755);
	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = fakePi;
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
		];
		const result = await createPiSubagentRunner({
			resourceProfile: "isolated",
			extensions: [],
			terminalGraceMs: 30,
		}).runTask(dir, agents, "t", "leak", { idleTimeoutMs: 10_000 });
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "PHASE_ONE_DONE");
		assert.equal(result.completionSource, "terminal-reap");
		assert.equal(result.reapedAfterTerminal, true);
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("Pi completion: agent_end alone is accepted on clean exit but never used to reap", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-agent-end-only-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		`#!${process.execPath}\n` +
			`const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n");\n` +
			`emit({type:"agent_start"}); emit({type:"turn_start"});\n` +
			`emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"DONE"}],stopReason:"stop"}});\n` +
			`emit({type:"agent_end"});\n` +
			`if(process.env.TASKFLOW_TEST_AGENT_END_LEAK==="1") setInterval(()=>{},1000);\n`,
	);
	fs.chmodSync(fakePi, 0o755);
	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	const prevLeak = process.env.TASKFLOW_TEST_AGENT_END_LEAK;
	process.env.PI_TASKFLOW_PI_BIN = fakePi;
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
		];
		const result = await createPiSubagentRunner({
			resourceProfile: "isolated",
			extensions: [],
			terminalGraceMs: 10,
		}).runTask(dir, agents, "t", "clean", { idleTimeoutMs: 10_000 });
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "DONE");
		assert.equal(result.completionSource, "process-exit");
		assert.equal(result.reapedAfterTerminal, undefined);
		process.env.TASKFLOW_TEST_AGENT_END_LEAK = "1";
		const leaky = await createPiSubagentRunner({
			resourceProfile: "isolated",
			extensions: [],
			terminalGraceMs: 10,
		}).runTask(dir, agents, "t", "leaky", { idleTimeoutMs: 80 });
		assert.equal(isFailed(leaky), true);
		assert.equal(leaky.completionSource, "idle-timeout");
		assert.equal(leaky.reapedAfterTerminal, undefined);
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		if (prevLeak === undefined) delete process.env.TASKFLOW_TEST_AGENT_END_LEAK;
		else process.env.TASKFLOW_TEST_AGENT_END_LEAK = prevLeak;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("Pi completion: post-agent_end activity revokes the early terminal candidate", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-terminal-retry-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		`#!${process.execPath}\n` +
			`const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n");\n` +
			`emit({type:"agent_start"}); emit({type:"turn_start"});\n` +
			`emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"FIRST"}],stopReason:"stop"}});\n` +
			`emit({type:"agent_end",willRetry:true});\n` +
			`setTimeout(()=>{\n` +
			`  emit({type:"auto_retry_start",attempt:1,maxAttempts:1,delayMs:0,errorMessage:"retry"});\n` +
			`  emit({type:"agent_start"}); emit({type:"turn_start"});\n` +
			`  emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"SECOND"}],stopReason:"stop"}});\n` +
			`  emit({type:"agent_end",willRetry:false}); emit({type:"agent_settled"});\n` +
			`},20);\n` +
			`setInterval(()=>{},1000);\n`,
	);
	fs.chmodSync(fakePi, 0o755);
	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = fakePi;
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
		];
		const result = await createPiSubagentRunner({
			resourceProfile: "isolated",
			extensions: [],
			terminalGraceMs: 50,
		}).runTask(dir, agents, "t", "retry", { idleTimeoutMs: 10_000 });
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "SECOND");
		assert.equal(result.completionSource, "terminal-reap");
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
