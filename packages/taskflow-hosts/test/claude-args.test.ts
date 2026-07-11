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
		assert.equal(args[0], "--tools");
		assert.equal(args[2], "--allowedTools");
		assert.equal(args[1], args[3]);
		assert.ok(!args.includes("bypassPermissions"));
	}
});

test("claude perms: read-only whitelist → --allowedTools with read-only set (Bash EXCLUDED)", () => {
	const args = permissionArgsForTools(["read", "grep", "glob"]);
	assert.equal(args[0], "--tools");
	const allowed = String(args[1]).split(",");
	assert.ok(allowed.includes("Read"));
	assert.ok(allowed.includes("Grep"));
	assert.ok(allowed.includes("Glob"));
	assert.ok(!allowed.includes("Bash"), "claude has no read-only shell — Bash must be excluded");
});

test("claude perms: mutating or unknown tools fail closed without explicit acknowledgement", () => {
	for (const t of ["write", "edit", "bash", "apply_patch"]) {
		assert.throws(
			() => permissionArgsForTools([t]),
			new RegExp(`${CLAUDE_UNSAFE_BYPASS_ENV}=1`),
		);
	}
	assert.throws(() => permissionArgsForTools(["future_tool"], true), /cannot be mapped/);
});

test("claude perms: explicit acknowledgement enables bypass only for unsafe tools", () => {
	assert.deepEqual(permissionArgsForTools(["bash"], true), ["--tools", "Bash", "--permission-mode", "bypassPermissions"]);
	assert.deepEqual(permissionArgsForTools(["read", "write"], true), ["--tools", "Read,Write", "--permission-mode", "bypassPermissions"]);
	assert.deepEqual(permissionArgsForTools(["read"], true), ["--tools", "Read", "--allowedTools", "Read"]);
});

test("claude perms: an explicit read request is not broadened to network or search tools", () => {
	assert.deepEqual(permissionArgsForTools(["read"]), ["--tools", "Read", "--allowedTools", "Read"]);
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

test("claude argv: safe mode isolates customizations, settings, and hooks", () => {
	const args = buildClaudeArgs({ ...baseCtx });
	assert.ok(args.includes("--safe-mode"));
	assert.ok(args.includes("--strict-mcp-config"));
	assert.equal(args[args.indexOf("--setting-sources") + 1], "");
	assert.deepEqual(JSON.parse(String(args[args.indexOf("--settings") + 1])), { disableAllHooks: true });
});

test("claude argv: permission flags follow the core flags", () => {
	const args = buildClaudeArgs({ ...baseCtx, tools: ["read"] });
	assert.deepEqual(
		args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 4),
		["--tools", "Read", "--allowedTools", "Read"],
	);

	assert.throws(() => buildClaudeArgs({ ...baseCtx, tools: ["bash"] }), /require unsandboxed permissions/);
	const bypass = buildClaudeArgs({ ...baseCtx, tools: ["bash"], allowUnsafeBypass: true });
	assert.deepEqual(bypass.slice(bypass.indexOf("--tools"), bypass.indexOf("--tools") + 2), ["--tools", "Bash"]);
	const permissionIndex = bypass.indexOf("--permission-mode");
	assert.deepEqual(bypass.slice(permissionIndex, permissionIndex + 2), ["--permission-mode", "bypassPermissions"]);
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
