/**
 * Unit tests for the opencode JSON parser (foldOpencodeEventLine), the model
 * resolution + permission mapping, and their mapping to the host-neutral
 * RunResult contract. Pure — no opencode process spawned. The fixtures are REAL
 * event lines captured from `opencode run --format json` (opencode 1.17), so a
 * schema drift in the parser is caught here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	foldOpencodeEventLine,
	newOpencodeAccumulator,
	isReadOnlyPhase,
	resolveOpencodeModel,
} from "../src/opencode-runner.ts";

// A full, real turn: step_start → text → step_finish (usage + cost).
const REAL_STREAM = [
	`{"type":"step_start","timestamp":1,"sessionID":"ses_x","part":{"id":"p0","type":"step-start"}}`,
	`{"type":"text","timestamp":2,"sessionID":"ses_x","part":{"id":"p1","type":"text","text":"pong","time":{"start":1,"end":2}}}`,
	`{"type":"step_finish","timestamp":3,"sessionID":"ses_x","part":{"id":"p2","type":"step-finish","reason":"stop","tokens":{"total":15180,"input":15164,"output":3,"reasoning":13,"cache":{"write":0,"read":0}},"cost":0}}`,
];

test("opencode parser: folds a real turn into final text + usage", () => {
	const acc = newOpencodeAccumulator("opencode/deepseek-v4-flash-free");
	for (const line of REAL_STREAM) foldOpencodeEventLine(acc, line);

	assert.equal(acc.finalText, "pong", "final answer = text part");
	assert.equal(acc.fatalError, undefined);
	assert.equal(acc.usage.turns, 1, "one step_finish = one turn");
	assert.equal(acc.usage.input, 15164);
	assert.equal(acc.usage.output, 3 + 13, "output = output + reasoning");
	assert.equal(acc.usage.contextTokens, 15180, "contextTokens = tokens.total");
});

// A real tool-using run: step 1 (tool_use) then step 2 (text). The text before
// a tool is intermediate; the answer is the text of the LAST step.
const TOOL_STREAM = [
	`{"type":"step_start","part":{"type":"step-start"}}`,
	`{"type":"text","part":{"type":"text","text":"let me check"}}`,
	`{"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"echo hi"},"output":"hi\\n","title":"echo hi"}}}`,
	`{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":15233,"input":15169,"output":47,"reasoning":17,"cache":{"write":0,"read":0}},"cost":0}}`,
	`{"type":"step_start","part":{"type":"step-start"}}`,
	`{"type":"text","part":{"type":"text","text":"done"}}`,
	`{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"total":15274,"input":18,"output":2,"reasoning":22,"cache":{"write":0,"read":15232}},"cost":0}}`,
];

test("opencode parser: a tool call resets intermediate text; last step's text wins", () => {
	const acc = newOpencodeAccumulator();
	for (const line of TOOL_STREAM) foldOpencodeEventLine(acc, line);
	assert.equal(acc.finalText, "done", "pre-tool 'let me check' was discarded");
	assert.equal(acc.usage.turns, 2);
	assert.equal(acc.usage.input, 15169 + 18);
	assert.equal(acc.usage.output, 47 + 17 + 2 + 22);
	assert.equal(acc.usage.cacheRead, 15232);
});

test("opencode parser: streaming text parts within a step concatenate", () => {
	const acc = newOpencodeAccumulator();
	foldOpencodeEventLine(acc, `{"type":"text","part":{"type":"text","text":"the ans"}}`);
	foldOpencodeEventLine(acc, `{"type":"text","part":{"type":"text","text":"wer is X"}}`);
	assert.equal(acc.finalText, "the answer is X");
});

test("opencode parser: a bash tool_use becomes a $-prefixed activity for streaming", () => {
	const acc = newOpencodeAccumulator();
	const live = foldOpencodeEventLine(
		acc,
		`{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"running","input":{"command":"ls -la"}}}}`,
	);
	assert.ok(live, "returns a LiveUpdate");
	assert.match(live!.text, /^\$ ls -la/);
});

test("opencode parser: an error event is fatal and never becomes the answer", () => {
	const acc = newOpencodeAccumulator();
	foldOpencodeEventLine(
		acc,
		`{"type":"error","sessionID":"ses_x","error":{"name":"UnknownError","data":{"message":"Unexpected server error.","ref":"err_1"}}}`,
	);
	assert.equal(acc.fatalError, "Unexpected server error.");
	assert.equal(acc.finalText, "");
});

test("opencode parser: malformed / empty / unknown lines are ignored", () => {
	const acc = newOpencodeAccumulator();
	assert.equal(foldOpencodeEventLine(acc, ""), null);
	assert.equal(foldOpencodeEventLine(acc, "not json"), null);
	assert.equal(foldOpencodeEventLine(acc, `{"type":"step_start","part":{"type":"step-start"}}`), null);
	assert.equal(acc.finalText, "");
	assert.equal(acc.usage.turns, 0);
});

// --- model resolution (opencode ids are provider/model — cannot reuse the
//     codex/claude "contains slash ⇒ drop" rule) --------------------------

test("opencode model: a clean provider/model passes through", () => {
	assert.equal(resolveOpencodeModel("opencode/deepseek-v4-flash-free"), "opencode/deepseek-v4-flash-free");
	assert.equal(resolveOpencodeModel("anthropic/claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
});

test("opencode model: placeholders, thinking suffixes, and openrouter paths are dropped", () => {
	assert.equal(resolveOpencodeModel("{{fast}}"), undefined, "unresolved role placeholder");
	assert.equal(resolveOpencodeModel("anthropic/glm-5.2:xhigh"), undefined, "pi thinking suffix");
	assert.equal(resolveOpencodeModel("openrouter/deepseek/deepseek-v4-flash"), undefined, "openrouter path (2 slashes)");
	assert.equal(resolveOpencodeModel(undefined), undefined);
});

// --- permission mapping (the codex sandboxForTools analogue) ---------------

test("opencode permissions: no whitelist is NOT read-only (default-capable agent)", () => {
	assert.equal(isReadOnlyPhase(undefined), false);
	assert.equal(isReadOnlyPhase([]), false);
});

test("opencode permissions: a mutating whitelist is NOT read-only", () => {
	for (const tools of [["read", "bash"], ["write"], ["edit", "grep"], ["apply_patch"]]) {
		assert.equal(isReadOnlyPhase(tools), false, `${tools} should be mutating`);
	}
});

test("opencode permissions: a read-only whitelist IS read-only", () => {
	assert.equal(isReadOnlyPhase(["read", "grep", "find", "ls"]), true);
	assert.equal(isReadOnlyPhase(["read"]), true);
});
