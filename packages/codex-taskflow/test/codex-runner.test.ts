/**
 * Unit tests for the codex JSONL parser (foldCodexEventLine) and its mapping to
 * the host-neutral RunResult contract. Pure — no codex process spawned. The
 * fixtures are the REAL event lines captured from `codex exec --json`
 * (codex-cli 0.142), so a schema drift in the parser is caught here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { foldCodexEventLine, newCodexAccumulator } from "../src/codex-runner.ts";

// A full, real turn: thread.started → benign errors → command tool call →
// agent_message (final) → turn.completed (usage).
const REAL_STREAM = [
	`{"type":"thread.started","thread_id":"019f0854-e83b-7c33-bd8d-9db7df9399cc"}`,
	`{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Under-development features enabled: enable_fanout. Under-development features are incomplete and may behave unpredictably."}}`,
	`{"type":"turn.started"}`,
	`{"type":"item.completed","item":{"id":"item_1","type":"error","message":"Skill descriptions were shortened to fit the 2% skills context budget."}}`,
	`{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"find examples -name '*.json' | wc -l","exit_code":null,"status":"in_progress"}}`,
	`{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"find examples -name '*.json' | wc -l","aggregated_output":"5\\n","exit_code":0,"status":"completed"}}`,
	`{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"5"}}`,
	`{"type":"turn.completed","usage":{"input_tokens":48650,"cached_input_tokens":26368,"output_tokens":159,"reasoning_output_tokens":62}}`,
];

test("codex parser: folds a real turn into final text + usage", () => {
	const acc = newCodexAccumulator("gpt-5-codex");
	for (const line of REAL_STREAM) foldCodexEventLine(acc, line);

	assert.equal(acc.finalText, "5", "final answer = last agent_message text");
	assert.equal(acc.fatalError, undefined, "benign warning errors are NOT fatal");
	assert.equal(acc.usage.turns, 1);
	assert.equal(acc.usage.input, 48650);
	// output = output_tokens + reasoning_output_tokens
	assert.equal(acc.usage.output, 159 + 62);
	assert.equal(acc.usage.cacheRead, 26368);
});

test("codex parser: last agent_message wins as final answer", () => {
	const acc = newCodexAccumulator();
	foldCodexEventLine(acc, `{"type":"item.completed","item":{"type":"agent_message","text":"first draft"}}`);
	foldCodexEventLine(acc, `{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}`);
	assert.equal(acc.finalText, "final answer");
});

test("codex parser: a non-benign error item is fatal", () => {
	const acc = newCodexAccumulator();
	foldCodexEventLine(acc, `{"type":"item.completed","item":{"type":"error","message":"model request failed: 500"}}`);
	assert.equal(acc.fatalError, "model request failed: 500");
});

test("codex parser: benign warnings never set fatalError", () => {
	const acc = newCodexAccumulator();
	foldCodexEventLine(acc, `{"type":"item.completed","item":{"type":"error","message":"Under-development features enabled: enable_fanout"}}`);
	foldCodexEventLine(acc, `{"type":"item.completed","item":{"type":"error","message":"Skill descriptions were shortened to fit"}}`);
	assert.equal(acc.fatalError, undefined);
});

test("codex parser: command_execution becomes a one-line activity for streaming", () => {
	const acc = newCodexAccumulator();
	const live = foldCodexEventLine(
		acc,
		`{"type":"item.started","item":{"type":"command_execution","command":"ls -la","status":"in_progress"}}`,
	);
	assert.ok(live, "returns a LiveUpdate");
	assert.match(live!.text, /^\$ ls -la/);
});

test("codex parser: usage accumulates across multiple turns", () => {
	const acc = newCodexAccumulator();
	foldCodexEventLine(acc, `{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10,"reasoning_output_tokens":0,"cached_input_tokens":0}}`);
	foldCodexEventLine(acc, `{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":20,"reasoning_output_tokens":5,"cached_input_tokens":50}}`);
	assert.equal(acc.usage.turns, 2);
	assert.equal(acc.usage.input, 300);
	assert.equal(acc.usage.output, 35); // 10 + (20+5)
	assert.equal(acc.usage.cacheRead, 50);
});

test("codex parser: malformed / empty / unknown lines are ignored", () => {
	const acc = newCodexAccumulator();
	assert.equal(foldCodexEventLine(acc, ""), null);
	assert.equal(foldCodexEventLine(acc, "not json"), null);
	assert.equal(foldCodexEventLine(acc, `{"type":"thread.started","thread_id":"x"}`), null);
	assert.equal(foldCodexEventLine(acc, `{"type":"turn.started"}`), null);
	assert.equal(acc.finalText, "");
	assert.equal(acc.usage.turns, 0);
});
