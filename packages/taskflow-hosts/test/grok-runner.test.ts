/**
 * Unit tests for the Grok streaming-json parser (foldGrokEventLine).
 * Pure — no grok process. Fixtures mirror the official headless docs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	foldGrokEventLine,
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
