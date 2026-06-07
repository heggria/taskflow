import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type EventAccumulator,
	foldEventLine,
	isFailed,
	looksLikeHtmlOrJson,
	mapWithConcurrencyLimit,
	newAccumulator,
	runAgentTask,
	type RunResult,
	sanitizeErrorMessage,
	TRANSPORT_ERROR_PLACEHOLDER,
} from "../extensions/runner.ts";
import type { AgentConfig } from "../extensions/agents.ts";
import { emptyUsage } from "../extensions/usage.ts";

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
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
