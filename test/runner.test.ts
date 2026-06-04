import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type EventAccumulator,
	foldEventLine,
	isFailed,
	mapWithConcurrencyLimit,
	newAccumulator,
	type RunResult,
} from "../extensions/runner.ts";
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
