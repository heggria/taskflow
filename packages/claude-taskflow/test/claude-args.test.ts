/**
 * Argv-contract tests for the claude host runner — PURE, no claude process.
 *
 * These lock down `claude -p`'s CLI flag contract in CI. The executor e2e
 * (`e2e-claude.mts`) needs a live claude session so it never runs in CI;
 * without these unit tests, a flag rename (e.g. `--output-format stream-json`
 * → `--json`) or a permission mapping regression would only be caught at
 * runtime. `buildClaudeArgs` is the extracted, pure, exported argv builder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildClaudeArgs,
	claudeBin,
	permissionArgsForTools,
	resolveClaudeModel,
	type ClaudeArgsCtx,
} from "../src/claude-runner.ts";

// --- bin resolution ---------------------------------------------------------

test("claude bin: defaults to `claude`, honours PI_TASKFLOW_CLAUDE_BIN override", () => {
	const prev = process.env.PI_TASKFLOW_CLAUDE_BIN;
	try {
		delete process.env.PI_TASKFLOW_CLAUDE_BIN;
		assert.equal(claudeBin(), "claude");
		process.env.PI_TASKFLOW_CLAUDE_BIN = "/custom/claude";
		assert.equal(claudeBin(), "/custom/claude");
	} finally {
		if (prev === undefined) delete process.env.PI_TASKFLOW_CLAUDE_BIN;
		else process.env.PI_TASKFLOW_CLAUDE_BIN = prev;
	}
});

// --- permission mapping -----------------------------------------------------

test("claude perms: no whitelist → --permission-mode bypassPermissions", () => {
	assert.deepEqual(permissionArgsForTools(undefined), ["--permission-mode", "bypassPermissions"]);
	assert.deepEqual(permissionArgsForTools([]), ["--permission-mode", "bypassPermissions"]);
});

test("claude perms: read-only whitelist → --allowedTools with read-only set (Bash EXCLUDED)", () => {
	const args = permissionArgsForTools(["read", "grep", "glob"]);
	assert.equal(args[0], "--allowedTools");
	const allowed = String(args[1]).split(",");
	assert.ok(allowed.includes("Read"));
	assert.ok(allowed.includes("Grep"));
	assert.ok(allowed.includes("Glob"));
	assert.ok(!allowed.includes("Bash"), "claude has no read-only shell — Bash must be excluded");
});

test("claude perms: any mutating tool → --permission-mode bypassPermissions", () => {
	for (const t of ["write", "edit", "bash", "apply_patch"]) {
		assert.deepEqual(permissionArgsForTools([t]), ["--permission-mode", "bypassPermissions"]);
	}
	assert.deepEqual(
		permissionArgsForTools(["read", "bash"]),
		["--permission-mode", "bypassPermissions"],
		"mixed (includes bash) → bypass",
	);
});

// --- model resolution -------------------------------------------------------

test("claude model: flat id/alias passes through", () => {
	assert.equal(resolveClaudeModel("sonnet"), "sonnet");
	assert.equal(resolveClaudeModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("claude model: pi-provider path (contains `/`) is dropped → claude default", () => {
	assert.equal(resolveClaudeModel("anthropic/claude-sonnet-4"), undefined);
	assert.equal(resolveClaudeModel("openrouter/vendor/x"), undefined);
});

test("claude model: unresolved role placeholder {{...}} is dropped", () => {
	assert.equal(resolveClaudeModel("{{fast}}"), undefined);
});

test("claude model: undefined → undefined", () => {
	assert.equal(resolveClaudeModel(undefined), undefined);
});

// --- full argv contract -----------------------------------------------------

const baseCtx: ClaudeArgsCtx = { systemPrompt: "", task: "count files", model: undefined, tools: undefined };

test("claude argv: core flags are exactly `-p --output-format stream-json --verbose --strict-mcp-config`", () => {
	const args = buildClaudeArgs({ ...baseCtx });
	assert.deepEqual(args.slice(0, 5), ["-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config"]);
});

test("claude argv: permission flags follow the core flags", () => {
	const args = buildClaudeArgs({ ...baseCtx, tools: ["read"] });
	// index 5,6 = the permission args from permissionArgsForTools
	assert.deepEqual([args[5], args[6]], ["--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch"]);

	const bypass = buildClaudeArgs({ ...baseCtx, tools: ["bash"] });
	assert.deepEqual([bypass[5], bypass[6]], ["--permission-mode", "bypassPermissions"]);
});

test("claude argv: model passed via `--model <id>` only when resolvable", () => {
	const withModel = buildClaudeArgs({ ...baseCtx, model: "haiku" });
	const idx = withModel.indexOf("--model");
	assert.ok(idx >= 0);
	assert.equal(withModel[idx + 1], "haiku");

	// pi-provider path dropped.
	const dropped = buildClaudeArgs({ ...baseCtx, model: "anthropic/claude-haiku" });
	assert.equal(dropped.indexOf("--model"), -1);
});

test("claude argv: system prompt rides on `--append-system-prompt`, NOT pasted into the task", () => {
	const withSys = buildClaudeArgs({ ...baseCtx, systemPrompt: "You are a reviewer." });
	const idx = withSys.indexOf("--append-system-prompt");
	assert.ok(idx >= 0);
	assert.equal(withSys[idx + 1], "You are a reviewer.");
	// The task stays the bare positional (not `Task: ...` prefixed like codex).
	assert.equal(withSys.at(-1), "count files", "claude task stays a clean positional");

	const noSys = buildClaudeArgs({ ...baseCtx });
	assert.equal(noSys.indexOf("--append-system-prompt"), -1, "no system prompt → no flag");
	assert.equal(noSys.at(-1), "count files");
});
