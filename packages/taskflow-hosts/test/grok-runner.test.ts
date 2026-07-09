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
} from "../src/grok-runner.ts";

test("grok parser: concatenates text chunks into finalText", () => {
	const acc = newGrokAccumulator("grok-build");
	foldGrokEventLine(acc, JSON.stringify({ type: "text", data: "Hello" }));
	foldGrokEventLine(acc, JSON.stringify({ type: "text", data: " world" }));
	foldGrokEventLine(acc, JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "abc" }));
	assert.equal(acc.finalText, "Hello world");
	assert.equal(acc.stopReason, "EndTurn");
	assert.equal(acc.sessionId, "abc");
	assert.equal(acc.fatalError, undefined);
});

test("grok parser: thought is activity only, not answer", () => {
	const acc = newGrokAccumulator();
	foldGrokEventLine(acc, JSON.stringify({ type: "thought", data: "planning…" }));
	assert.equal(acc.finalText, "");
	assert.match(acc.lastActivity, /planning/);
	foldGrokEventLine(acc, JSON.stringify({ type: "text", data: "done" }));
	assert.equal(acc.finalText, "done");
});

test("grok parser: error event is fatal and never the answer", () => {
	const acc = newGrokAccumulator();
	foldGrokEventLine(acc, JSON.stringify({ type: "text", data: "partial" }));
	foldGrokEventLine(acc, JSON.stringify({ type: "error", message: "auth failed" }));
	assert.equal(acc.fatalError, "auth failed");
	assert.match(acc.lastActivity, /auth failed/);
});

test("grok parser: end may supply text when no prior chunks", () => {
	const acc = newGrokAccumulator();
	foldGrokEventLine(acc, JSON.stringify({ type: "end", stopReason: "EndTurn", text: "full answer" }));
	assert.equal(acc.finalText, "full answer");
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
	assert.deepEqual(permissionArgsForGrokTools(undefined), ["--always-approve"]);
	assert.equal(permissionArgsForGrokTools(["read"])[0], "--tools");
	assert.deepEqual(permissionArgsForGrokTools(["write"]), ["--always-approve"]);
});
