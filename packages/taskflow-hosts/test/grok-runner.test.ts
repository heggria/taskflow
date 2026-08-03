/**
 * Unit tests for the Grok streaming-json parser (foldGrokEventLine).
 * Pure — no grok process. Fixtures mirror the official headless docs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	foldGrokEventLine,
	grokSubagentRunner,
	newGrokAccumulator,
	resolveGrokModel,
	permissionArgsForGrokTools,
	runGrokAgentTask,
} from "../src/grok-runner.ts";

test("grok parser: concatenates text chunks into finalText", () => {
	const acc = newGrokAccumulator("grok-build");
	foldGrokEventLine(acc, JSON.stringify({ type: "text", data: "Hello" }));
	foldGrokEventLine(acc, JSON.stringify({ type: "text", data: " world" }));
	foldGrokEventLine(acc, JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "abc" }));
	assert.equal(acc.finalText, "Hello world");
	assert.equal(acc.stopReason, "EndTurn");
	assert.equal(acc.sessionId, "abc");
	assert.equal(acc.terminalSeen, true);
	assert.equal(acc.fatalError, undefined);
});

test("grok parser: thought is activity only, not answer", () => {
	const acc = newGrokAccumulator();
	foldGrokEventLine(acc, JSON.stringify({ type: "thought", data: "planning…" }));
	assert.equal(acc.finalText, "");
	assert.match(acc.lastActivity, /planning/);
	foldGrokEventLine(acc, JSON.stringify({ type: "text", data: "done" }));
	assert.equal(acc.finalText, "done");
	assert.equal(acc.terminalSeen, undefined, "text before end is not terminal");
});

test("grok parser: error event is fatal and never the answer", () => {
	const acc = newGrokAccumulator();
	foldGrokEventLine(acc, JSON.stringify({ type: "text", data: "partial" }));
	foldGrokEventLine(acc, JSON.stringify({ type: "error", message: "auth failed" }));
	assert.equal(acc.fatalError, "auth failed");
	assert.match(acc.lastActivity, /auth failed/);
});

test("grok parser: max_turns_reached is fatal even after partial text", () => {
	const acc = newGrokAccumulator();
	foldGrokEventLine(acc, JSON.stringify({ type: "text", data: "partial" }));
	const live = foldGrokEventLine(acc, JSON.stringify({ type: "max_turns_reached" }));
	assert.equal(acc.stopReason, "max_turns_reached");
	assert.match(acc.fatalError ?? "", /maximum turn limit/);
	assert.match(live?.text ?? "", /^error:/);
});

test("grok parser: end may supply text when no prior chunks", () => {
	const acc = newGrokAccumulator();
	foldGrokEventLine(acc, JSON.stringify({ type: "end", stopReason: "EndTurn", text: "full answer" }));
	assert.equal(acc.finalText, "full answer");
	assert.equal(acc.terminalSeen, true);
});

test("grok parser: end captures current headless usage without enabling budgets", () => {
	const acc = newGrokAccumulator("grok-4.5-build");
	const live = foldGrokEventLine(acc, JSON.stringify({
		type: "end",
		stopReason: "EndTurn",
		sessionId: "abc",
		usage: {
			input_tokens: 7_210,
			cache_read_input_tokens: 41_000,
			output_tokens: 1_893,
			reasoning_tokens: 412,
			total_tokens: 50_103,
		},
		num_turns: 7,
		total_cost_usd: 0.01268905,
	}));

	assert.deepEqual(acc.usage, {
		input: 7_210,
		output: 1_893,
		cacheRead: 41_000,
		cacheWrite: 0,
		cost: 0.01268905,
		contextTokens: 50_103,
		turns: 7,
	});
	assert.deepEqual(live?.usage, acc.usage);
	assert.equal(
		grokSubagentRunner.usageAccounting,
		"unavailable",
		"older or incomplete Grok events must keep budget admission fail-closed",
	);
	assert.equal(
		(runGrokAgentTask as typeof runGrokAgentTask & { usageAccounting?: string }).usageAccounting,
		"unavailable",
	);
});

test("grok parser: omitted or malformed spend never invents usage", () => {
	const acc = newGrokAccumulator();
	foldGrokEventLine(acc, JSON.stringify({
		type: "end",
		stopReason: "EndTurn",
		usage: {
			input_tokens: -1,
			cache_read_input_tokens: "unknown",
			output_tokens: Number.POSITIVE_INFINITY,
		},
		num_turns: 0,
		total_cost_usd: -1,
	}));
	assert.deepEqual(acc.usage, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	});

	const incomplete = newGrokAccumulator();
	foldGrokEventLine(incomplete, JSON.stringify({
		type: "error",
		message: "cancelled",
		usage: {
			input_tokens: 3,
			cache_read_input_tokens: 2,
			output_tokens: 1,
			total_tokens: 6,
		},
		num_turns: 1,
		total_cost_usd: 9,
		usage_is_incomplete: true,
	}));
	assert.equal(incomplete.usage.input, 3, "reported tokens remain useful lower-bound evidence");
	assert.equal(incomplete.usage.cost, 0, "incomplete cost must not be presented as complete");
});

test("grok parser: malformed / empty / unknown lines are ignored", () => {
	const acc = newGrokAccumulator();
	assert.equal(foldGrokEventLine(acc, ""), null);
	assert.equal(foldGrokEventLine(acc, "not-json"), null);
	assert.equal(foldGrokEventLine(acc, JSON.stringify({ type: "auto_compact_start" })), null);
	assert.equal(acc.finalText, "");
});

test("grok model resolve: flat ok, openrouter path dropped", () => {
	assert.equal(resolveGrokModel("grok-build"), "grok-build");
	assert.equal(resolveGrokModel("openrouter/a/b"), undefined);
});

test("grok permissions: read-only vs mutating", () => {
	assert.throws(() => permissionArgsForGrokTools(undefined), /custom sandbox profile/);
	assert.throws(() => permissionArgsForGrokTools(["read"]), /PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE/);
	assert.ok(permissionArgsForGrokTools(["read"], undefined, "taskflow-readonly").includes("--tools"));
	assert.equal(
		permissionArgsForGrokTools(["read"], undefined, "taskflow-readonly")[permissionArgsForGrokTools(["read"], undefined, "taskflow-readonly").indexOf("--sandbox") + 1],
		"taskflow-readonly",
	);
	assert.ok(permissionArgsForGrokTools(["read"], undefined, "taskflow-readonly").includes("--disallowed-tools"));
	assert.deepEqual(permissionArgsForGrokTools(["write"], "taskflow-workspace"), ["--sandbox", "taskflow-workspace", "--always-approve"]);
});

test("grok runner: invalid global thinking fails before spawning", async () => {
	const result = await runGrokAgentTask(
		"/tmp",
		[{
			name: "reviewer",
			description: "test",
			systemPrompt: "Review carefully.",
			source: "project",
			filePath: "/tmp/reviewer.md",
		}],
		"reviewer",
		"review",
		{},
		"impossible",
	);
	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /Unsupported Grok thinking level/);
	assert.doesNotMatch(result.stderr, /ENOENT/, "thinking validation rejects before the process seam");
});
