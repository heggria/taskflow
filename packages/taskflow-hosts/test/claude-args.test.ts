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
	CLAUDE_UNSAFE_BYPASS_ENV,
	claudeBin,
	claudeChildEnv,
	claudeUnsafeBypassEnabled,
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

test("claude perms: no whitelist defaults to an explicit read-only allowlist", () => {
	for (const tools of [undefined, []]) {
		const args = permissionArgsForTools(tools);
		assert.equal(args[0], "--allowedTools");
		assert.ok(!args.includes("bypassPermissions"));
	}
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

test("claude perms: mutating or unknown tools fail closed without explicit acknowledgement", () => {
	for (const t of ["write", "edit", "bash", "apply_patch", "future_tool"]) {
		assert.throws(
			() => permissionArgsForTools([t]),
			new RegExp(`${CLAUDE_UNSAFE_BYPASS_ENV}=1`),
		);
	}
});

test("claude perms: explicit acknowledgement enables bypass only for unsafe tools", () => {
	assert.deepEqual(permissionArgsForTools(["bash"], true), ["--permission-mode", "bypassPermissions"]);
	assert.deepEqual(permissionArgsForTools(["read"], true), ["--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch"]);
});

test("claude unsafe opt-in: only exact env value 1 is accepted", () => {
	for (const value of [undefined, "", "0", "true", "yes"]) {
		const env = value === undefined ? {} : { [CLAUDE_UNSAFE_BYPASS_ENV]: value };
		assert.equal(claudeUnsafeBypassEnabled(env), false);
	}
	assert.equal(claudeUnsafeBypassEnabled({ [CLAUDE_UNSAFE_BYPASS_ENV]: "1" }), true);
});

test("claude child env: keeps platform/provider settings and drops unrelated secrets", () => {
	const env = claudeChildEnv({
		PATH: "/bin",
		HOME: "/home/test",
		ANTHROPIC_API_KEY: "anthropic-secret",
		AWS_PROFILE: "bedrock-profile",
		GOOGLE_APPLICATION_CREDENTIALS: "/tmp/vertex.json",
		https_proxy: "http://proxy.test",
		OPENAI_API_KEY: "must-not-leak",
		NPM_TOKEN: "must-not-leak",
		DATABASE_URL: "must-not-leak",
		NODE_OPTIONS: "--require /tmp/inject.cjs",
	});
	assert.deepEqual(env, {
		PATH: "/bin",
		HOME: "/home/test",
		ANTHROPIC_API_KEY: "anthropic-secret",
		AWS_PROFILE: "bedrock-profile",
		GOOGLE_APPLICATION_CREDENTIALS: "/tmp/vertex.json",
		https_proxy: "http://proxy.test",
	});
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

	assert.throws(() => buildClaudeArgs({ ...baseCtx, tools: ["bash"] }), /require unsandboxed permissions/);
	const bypass = buildClaudeArgs({ ...baseCtx, tools: ["bash"], allowUnsafeBypass: true });
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
