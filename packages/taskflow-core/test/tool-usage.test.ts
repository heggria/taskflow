import assert from "node:assert/strict";
import { test } from "node:test";
import { foldEventLine, newAccumulator } from "../src/runner-core.ts";

function message(role: string, usage: Record<string, unknown>, extra = {}) {
	return JSON.stringify({ type: "message_end", message: { role, content: [], usage, ...extra } });
}

test("tool usage: top-level toolResult usage adds cost and tokens without adding assistant turns or context", () => {
	const acc = newAccumulator("main-model");
	foldEventLine(acc, message("assistant", { input: 100, output: 20, totalTokens: 120, cost: { total: 0.01 } }, {
		content: [{ type: "text", text: "working" }], stopReason: "toolUse",
	}));
	const live = foldEventLine(acc, message("toolResult", {
		input: 40, output: 10, cacheRead: 8, cacheWrite: 4, totalTokens: 62, cost: { total: 0.02 },
	}, { model: "nested-model", errorMessage: "tool failure", stopReason: "error" }));
	assert.equal(live, null);
	assert.deepEqual(acc.usage, { input: 140, output: 30, cacheRead: 8, cacheWrite: 4, cost: 0.03, contextTokens: 120, turns: 1 });
	assert.equal(acc.model, "main-model");
	assert.equal(acc.stopReason, "toolUse");
	assert.equal(acc.fatalError, undefined);
	assert.equal(acc.finalText, "working");
	foldEventLine(acc, message("assistant", { input: 200, output: 30, totalTokens: 230, cost: { total: 0.03 } }));
	assert.equal(acc.usage.contextTokens, 230);
	assert.equal(acc.usage.turns, 2);
	assert.equal(acc.usage.cost, 0.06);
});

test("tool usage: nested calls and redundant history do not duplicate the tool result's aggregate usage", () => {
	const acc = newAccumulator();
	const usage = { input: 12, output: 3, totalTokens: 15, cost: { total: 0.04 } };
	const toolResult = { role: "toolResult", content: [], usage, nestedCalls: [{ usage }, { result: { usage } }] };
	foldEventLine(acc, JSON.stringify({ type: "message_start", message: toolResult }));
	foldEventLine(acc, JSON.stringify({ type: "message_update", message: toolResult }));
	foldEventLine(acc, JSON.stringify({ type: "message_end", message: toolResult }));
	foldEventLine(acc, JSON.stringify({ type: "agent_end", messages: [toolResult] }));
	assert.deepEqual(acc.usage, { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.04, contextTokens: 0, turns: 0 });
});

test("tool usage: still accounted beyond the retained transcript cap", () => {
	const acc = newAccumulator();
	for (let i = 0; i < 501; i++) foldEventLine(acc, message("toolResult", { output: 1, cost: { total: 1 } }));
	assert.equal(acc.messages.length, 500);
	assert.equal(acc.truncated, true);
	assert.equal(acc.usage.output, 501);
	assert.equal(acc.usage.cost, 501);
	assert.equal(acc.usage.turns, 0);
});

test("tool usage: user or custom message metadata is not billable usage", () => {
	const acc = newAccumulator();
	for (const role of ["user", "custom", "system"]) foldEventLine(acc, message(role, { input: 10, cost: { total: 9 } }));
	assert.equal(acc.usage.input, 0);
	assert.equal(acc.usage.cost, 0);
});
