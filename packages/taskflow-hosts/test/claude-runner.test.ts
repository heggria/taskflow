/**
 * Unit tests for the claude stream-json parser (foldClaudeEventLine), the
 * permission mapping (permissionArgsForTools), and their mapping to the
 * host-neutral RunResult contract. Pure — no claude process spawned. The
 * fixtures are REAL event lines captured from
 * `claude -p --output-format stream-json --verbose` (claude-code 2.1), so a
 * schema drift in the parser is caught here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAUDE_UNSAFE_BYPASS_ENV,
	foldClaudeEventLine,
	newClaudeAccumulator,
	permissionArgsForTools,
	runClaudeAgentTask,
} from "../src/claude-runner.ts";

// A full, real run: system init → assistant tool_use → assistant text →
// result (authoritative usage + cost).
const REAL_STREAM = [
	`{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"a1e55e9c","tools":["Task","Bash","Read"],"model":"claude-haiku-4-5","permissionMode":"bypassPermissions","claude_code_version":"2.1.178","uuid":"c5cf546f"}`,
	`{"type":"assistant","message":{"id":"msg_1","model":"claude-haiku-4-5","role":"assistant","type":"message","usage":{"input_tokens":4,"output_tokens":78,"cache_creation_input_tokens":2515,"cache_read_input_tokens":13629},"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo taskflow-probe","description":"Echo probe"}}]},"parent_tool_use_id":null,"session_id":"a1e55e9c","uuid":"u1"}`,
	`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"taskflow-probe"}]},"session_id":"a1e55e9c","uuid":"u2"}`,
	`{"type":"assistant","message":{"id":"msg_2","model":"claude-haiku-4-5","role":"assistant","type":"message","usage":{"input_tokens":6,"output_tokens":5,"cache_creation_input_tokens":94,"cache_read_input_tokens":16144},"content":[{"type":"text","text":"done"}]},"parent_tool_use_id":null,"session_id":"a1e55e9c","uuid":"u3"}`,
	`{"type":"result","subtype":"success","is_error":false,"duration_ms":4180,"duration_api_ms":3980,"num_turns":2,"result":"done","stop_reason":"end_turn","session_id":"a1e55e9c","total_cost_usd":0.0034,"usage":{"input_tokens":10,"cache_creation_input_tokens":2609,"cache_read_input_tokens":29773,"output_tokens":83},"permission_denials":[],"uuid":"u4"}`,
];

test("claude parser: folds a real run into final text + authoritative usage", () => {
	const acc = newClaudeAccumulator("haiku");
	for (const line of REAL_STREAM) foldClaudeEventLine(acc, line);

	assert.equal(acc.finalText, "done", "final answer = the result event's `result`");
	assert.equal(acc.fatalError, undefined);
	assert.equal(acc.model, "claude-haiku-4-5", "model updated from the stream");
	// The result event's cumulative usage wins over the per-turn accumulation.
	assert.equal(acc.usage.turns, 2, "turns = num_turns");
	assert.equal(acc.usage.input, 10);
	assert.equal(acc.usage.output, 83);
	assert.equal(acc.usage.cacheRead, 29773);
	assert.equal(acc.usage.cacheWrite, 2609);
	assert.equal(acc.usage.cost, 0.0034, "cost = total_cost_usd");
});

test("claude parser: per-turn usage accumulates for live streaming before the result", () => {
	const acc = newClaudeAccumulator();
	foldClaudeEventLine(acc, REAL_STREAM[1]);
	assert.equal(acc.usage.turns, 1);
	assert.equal(acc.usage.output, 78);
	assert.equal(acc.usage.cacheRead, 13629);
	foldClaudeEventLine(acc, REAL_STREAM[3]);
	assert.equal(acc.usage.turns, 2);
	assert.equal(acc.usage.output, 83); // 78 + 5
});

test("claude parser: last assistant text is the fallback answer when no result event arrives", () => {
	const acc = newClaudeAccumulator();
	foldClaudeEventLine(acc, `{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"first draft"}]}}`);
	foldClaudeEventLine(acc, `{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"final answer"}]}}`);
	assert.equal(acc.finalText, "final answer");
});

test("claude parser: an is_error result is fatal and never becomes the answer", () => {
	const acc = newClaudeAccumulator();
	foldClaudeEventLine(
		acc,
		`{"type":"result","subtype":"success","is_error":true,"api_error_status":403,"num_turns":1,"result":"Failed to authenticate. API Error: 403","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}`,
	);
	assert.equal(acc.fatalError, "Failed to authenticate. API Error: 403");
	assert.equal(acc.finalText, "", "an error result must not become the final answer");
});

test("claude parser: synthetic assistant messages never become the final answer", () => {
	// Real fixture: an auth failure is surfaced as a synthetic assistant message
	// (model "<synthetic>") whose text is a diagnostic, plus error metadata.
	const acc = newClaudeAccumulator();
	foldClaudeEventLine(
		acc,
		`{"type":"assistant","message":{"id":"x","model":"<synthetic>","role":"assistant","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":"Failed to authenticate. API Error: 403"}]},"error":"authentication_failed"}`,
	);
	assert.equal(acc.finalText, "", "synthetic text is not an answer");
	assert.equal(acc.fatalError, "Failed to authenticate. API Error: 403");
	assert.equal(acc.usage.turns, 0, "synthetic messages don't count as turns");
});

test("claude parser: tool_use becomes a one-line activity for streaming", () => {
	const acc = newClaudeAccumulator();
	const live = foldClaudeEventLine(
		acc,
		`{"type":"assistant","message":{"model":"m","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}`,
	);
	assert.ok(live, "returns a LiveUpdate");
	assert.match(live!.text, /^\$ ls -la/);
	const live2 = foldClaudeEventLine(
		acc,
		`{"type":"assistant","message":{"model":"m","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x"}}]}}`,
	);
	assert.match(live2!.text, /^Read: \/x/, "Read/Edit/Write summarize to Tool: path (parity with pi/codex)");
});

test("claude parser: malformed / empty / unknown lines are ignored", () => {
	const acc = newClaudeAccumulator();
	assert.equal(foldClaudeEventLine(acc, ""), null);
	assert.equal(foldClaudeEventLine(acc, "not json"), null);
	assert.equal(foldClaudeEventLine(acc, `{"type":"user","message":{"role":"user","content":[]}}`), null);
	assert.equal(foldClaudeEventLine(acc, `{"type":"stream_event","event":{}}`), null);
	assert.equal(acc.finalText, "");
	assert.equal(acc.usage.turns, 0);
});

test("claude parser: system init sets the model", () => {
	const acc = newClaudeAccumulator();
	assert.equal(foldClaudeEventLine(acc, REAL_STREAM[0]), null, "init produces no live update");
	assert.equal(acc.model, "claude-haiku-4-5");
});

// --- permission mapping (the codex sandboxForTools analogue) ---------------

test("claude permissions: no whitelist → explicit read-only allowlist", () => {
	for (const tools of [undefined, []]) {
		const args = permissionArgsForTools(tools);
		assert.equal(args[0], "--tools");
		assert.equal(args[2], "--allowedTools");
		assert.equal(args[1], args[3]);
		assert.ok(!args.includes("bypassPermissions"));
	}
});

test("claude permissions: mutating whitelist is denied unless explicitly acknowledged", () => {
	for (const tools of [["read", "bash"], ["write"], ["edit", "grep"], ["apply_patch"]]) {
		assert.throws(() => permissionArgsForTools(tools), /PI_TASKFLOW_CLAUDE_UNSAFE_BYPASS=1/);
		const optedIn = permissionArgsForTools(tools, true);
		assert.equal(optedIn[0], "--tools");
		assert.ok(optedIn.includes("--permission-mode"));
		assert.ok(optedIn.includes("bypassPermissions"));
	}
	assert.throws(() => permissionArgsForTools(["future_tool"], true), /cannot be mapped/);
});

test("claude permissions: a read-only whitelist → matching narrow tool sets", () => {
	const args = permissionArgsForTools(["read", "grep", "find", "ls"]);
	assert.equal(args[0], "--tools");
	assert.equal(args[2], "--allowedTools");
	assert.equal(args[1], args[3]);
	const allowed = args[1].split(",");
	assert.ok(allowed.includes("Read"));
	assert.ok(allowed.includes("Grep"));
	assert.ok(!allowed.includes("Bash"), "no read-only shell on claude — Bash stays denied");
	assert.ok(!allowed.includes("Write"));
	assert.ok(!allowed.includes("Edit"));
});

const TEST_AGENT = [{
	name: "reviewer",
	description: "test",
	systemPrompt: "Review carefully.",
	source: "project" as const,
	filePath: "/tmp/reviewer.md",
}];

function withFakeClaude(body: string, run: (bin: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "taskflow-claude-runner-"));
	const bin = join(dir, "claude");
	writeFileSync(bin, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
	chmodSync(bin, 0o755);
	return run(bin).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("claude runner seam: unsafe tools fail closed before spawning with actionable error", async () => {
	const previousBin = process.env.PI_TASKFLOW_CLAUDE_BIN;
	const previousOptIn = process.env[CLAUDE_UNSAFE_BYPASS_ENV];
	try {
		process.env.PI_TASKFLOW_CLAUDE_BIN = "/definitely/not/a/claude/binary";
		delete process.env[CLAUDE_UNSAFE_BYPASS_ENV];
		const result = await runClaudeAgentTask("/tmp", TEST_AGENT, "reviewer", "change a file", { tools: ["write"] });
		assert.equal(result.exitCode, 1);
		assert.equal(result.stopReason, "permission_denied");
		assert.match(result.errorMessage ?? "", /PI_TASKFLOW_CLAUDE_UNSAFE_BYPASS=1/);
		assert.doesNotMatch(result.stderr, /ENOENT/, "permission policy rejects before the process seam");
	} finally {
		if (previousBin === undefined) delete process.env.PI_TASKFLOW_CLAUDE_BIN;
		else process.env.PI_TASKFLOW_CLAUDE_BIN = previousBin;
		if (previousOptIn === undefined) delete process.env[CLAUDE_UNSAFE_BYPASS_ENV];
		else process.env[CLAUDE_UNSAFE_BYPASS_ENV] = previousOptIn;
	}
});

test("claude runner seam: unspecified tools spawn with read-only flags", async () => {
	await withFakeClaude(
		`case " $* " in *" --tools Read,Grep,Glob,WebFetch,WebSearch --allowedTools Read,Grep,Glob,WebFetch,WebSearch "*) ;; *) exit 64 ;; esac
case " $* " in *" bypassPermissions "*) exit 65 ;; esac
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"safe","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'`,
		async (bin) => {
			const previousBin = process.env.PI_TASKFLOW_CLAUDE_BIN;
			const previousOptIn = process.env[CLAUDE_UNSAFE_BYPASS_ENV];
			try {
				process.env.PI_TASKFLOW_CLAUDE_BIN = bin;
				delete process.env[CLAUDE_UNSAFE_BYPASS_ENV];
				const result = await runClaudeAgentTask("/tmp", TEST_AGENT, "reviewer", "inspect", {});
				assert.equal(result.exitCode, 0, result.stderr);
				assert.equal(result.output, "safe");
			} finally {
				if (previousBin === undefined) delete process.env.PI_TASKFLOW_CLAUDE_BIN;
				else process.env.PI_TASKFLOW_CLAUDE_BIN = previousBin;
				if (previousOptIn === undefined) delete process.env[CLAUDE_UNSAFE_BYPASS_ENV];
				else process.env[CLAUDE_UNSAFE_BYPASS_ENV] = previousOptIn;
			}
		},
	);
});

test("claude runner seam: exact user opt-in permits requested unsandboxed tools", async () => {
	await withFakeClaude(
		`case " $* " in *" --tools Write --permission-mode bypassPermissions "*) ;; *) exit 64 ;; esac
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"opted-in","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'`,
		async (bin) => {
			const previousBin = process.env.PI_TASKFLOW_CLAUDE_BIN;
			const previousOptIn = process.env[CLAUDE_UNSAFE_BYPASS_ENV];
			try {
				process.env.PI_TASKFLOW_CLAUDE_BIN = bin;
				process.env[CLAUDE_UNSAFE_BYPASS_ENV] = "1";
				const result = await runClaudeAgentTask("/tmp", TEST_AGENT, "reviewer", "change", { tools: ["write"] });
				assert.equal(result.exitCode, 0, result.stderr);
				assert.equal(result.output, "opted-in");
			} finally {
				if (previousBin === undefined) delete process.env.PI_TASKFLOW_CLAUDE_BIN;
				else process.env.PI_TASKFLOW_CLAUDE_BIN = previousBin;
				if (previousOptIn === undefined) delete process.env[CLAUDE_UNSAFE_BYPASS_ENV];
				else process.env[CLAUDE_UNSAFE_BYPASS_ENV] = previousOptIn;
			}
		},
	);
});
