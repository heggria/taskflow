/**
 * Argv-contract tests for the Grok Build host runner — PURE, no grok process.
 *
 * Locks down `grok -p`'s CLI flag contract in CI (docs.x.ai / headless guide).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildGrokArgs,
	GROK_MUTATING_SANDBOX_PROFILE_ENV,
	GROK_READONLY_SANDBOX_PROFILE_ENV,
	grokBin,
	permissionArgsForGrokTools,
	resolveGrokMutatingSandboxProfile,
	resolveGrokReadOnlySandboxProfile,
	resolveGrokModel,
	resolveGrokThinking,
	type GrokArgsCtx,
} from "../src/grok-runner.ts";

// --- bin resolution ---------------------------------------------------------

test("grok bin: defaults to `grok`, honours PI_TASKFLOW_GROK_BIN override", () => {
	const prev = process.env.PI_TASKFLOW_GROK_BIN;
	try {
		delete process.env.PI_TASKFLOW_GROK_BIN;
		assert.equal(grokBin(), "grok");
		process.env.PI_TASKFLOW_GROK_BIN = "/custom/grok";
		assert.equal(grokBin(), "/custom/grok");
	} finally {
		if (prev === undefined) delete process.env.PI_TASKFLOW_GROK_BIN;
		else process.env.PI_TASKFLOW_GROK_BIN = prev;
	}
});

// --- permission mapping -----------------------------------------------------

test("grok perms: no whitelist requires a fail-closed custom sandbox", () => {
	assert.throws(() => permissionArgsForGrokTools(undefined), new RegExp(GROK_MUTATING_SANDBOX_PROFILE_ENV));
	assert.throws(() => permissionArgsForGrokTools([], "workspace"), /built in and may continue unsandboxed/);
	assert.deepEqual(permissionArgsForGrokTools(undefined, "taskflow-workspace"), ["--sandbox", "taskflow-workspace", "--always-approve"]);
});

test("grok perms: mutating whitelist requires a fail-closed custom sandbox", () => {
	for (const tools of [["read", "write"], ["bash"], ["run_terminal_cmd"], ["search_replace"]]) {
		assert.throws(() => permissionArgsForGrokTools(tools), new RegExp(GROK_MUTATING_SANDBOX_PROFILE_ENV));
		assert.deepEqual(permissionArgsForGrokTools(tools, "taskflow-workspace"), ["--sandbox", "taskflow-workspace", "--always-approve"]);
	}
});

test("grok mutating sandbox profile: reads only a non-empty operator value", () => {
	assert.equal(resolveGrokMutatingSandboxProfile({}), undefined);
	assert.equal(resolveGrokMutatingSandboxProfile({ [GROK_MUTATING_SANDBOX_PROFILE_ENV]: "  " }), undefined);
	assert.equal(resolveGrokMutatingSandboxProfile({ [GROK_MUTATING_SANDBOX_PROFILE_ENV]: " taskflow-workspace " }), "taskflow-workspace");
});

test("grok read-only sandbox profile: is independent and must be custom", () => {
	assert.equal(resolveGrokReadOnlySandboxProfile({}), undefined);
	assert.equal(resolveGrokReadOnlySandboxProfile({ [GROK_READONLY_SANDBOX_PROFILE_ENV]: " taskflow-readonly " }), "taskflow-readonly");
	assert.throws(
		() => permissionArgsForGrokTools(["read"], undefined, "read-only"),
		/built in and may continue unsandboxed/,
	);
});

test("grok perms: read-only whitelist → --tools <read set> + --always-approve", () => {
	const args = permissionArgsForGrokTools(["read", "grep", "glob"], undefined, "taskflow-readonly");
	assert.equal(args[args.indexOf("--sandbox") + 1], "taskflow-readonly");
	assert.ok(args.includes("--tools"));
	const allowed = String(args[args.indexOf("--tools") + 1]).split(",");
	assert.ok(allowed.includes("read_file"));
	assert.ok(allowed.includes("grep"));
	assert.ok(allowed.includes("list_dir"));
	assert.ok(!allowed.includes("run_terminal_cmd"));
	assert.ok(!allowed.includes("search_replace"));
	assert.ok(args.includes("--disallowed-tools"));
	const denied = String(args[args.indexOf("--disallowed-tools") + 1]).split(",");
	assert.ok(denied.includes("run_terminal_cmd"));
	assert.ok(denied.includes("search_replace"));
	assert.ok(args.includes("--no-subagents"));
	assert.ok(args.includes("--always-approve"));
	assert.ok(args.includes("MCPTool"));
});

test("grok perms: web ids never enter the 0.2.93 allowlist regression path", () => {
	const args = permissionArgsForGrokTools(["read", "web_search", "web_fetch"], undefined, "taskflow-readonly");
	const allowed = String(args[args.indexOf("--tools") + 1]).split(",");
	assert.deepEqual(allowed, ["read_file"]);
	assert.ok(!args.join(" ").includes("web_search"));
	assert.ok(!args.join(" ").includes("web_fetch"));
});

test("grok perms: unknown read-only aliases fail closed to a non-empty safe allowlist", () => {
	const args = permissionArgsForGrokTools(["future_read_tool"], undefined, "taskflow-readonly");
	assert.equal(args[args.indexOf("--tools") + 1], "read_file");
	assert.ok(args.includes("--disallowed-tools"));
	assert.equal(args[args.indexOf("--sandbox") + 1], "taskflow-readonly");
});

// --- model resolution -------------------------------------------------------

test("grok model: flat ids pass through", () => {
	assert.equal(resolveGrokModel("grok-build"), "grok-build");
	assert.equal(resolveGrokModel("my-model"), "my-model");
});

test("grok model: placeholders / multi-slash / thinking-suffix dropped", () => {
	assert.equal(resolveGrokModel("{{fast}}"), undefined);
	assert.equal(resolveGrokModel("openrouter/vendor/model"), undefined);
	assert.equal(resolveGrokModel("grok-build:xhigh"), undefined);
	assert.equal(resolveGrokModel(undefined), undefined);
});

test("grok thinking: maps taskflow levels to --reasoning-effort", () => {
	assert.equal(resolveGrokThinking("off"), "none");
	assert.equal(resolveGrokThinking("high"), "high");
	assert.equal(resolveGrokThinking("xhigh"), "xhigh");
	assert.equal(resolveGrokThinking("ultra"), "max");
	assert.throws(() => resolveGrokThinking("unknown"), /Unsupported Grok thinking level/);
});

// --- argv contract ----------------------------------------------------------

const base: GrokArgsCtx = {
	systemPrompt: "",
	task: "do the thing",
	mutatingSandboxProfile: "taskflow-workspace",
	readOnlySandboxProfile: "taskflow-readonly",
};

test("grok argv: starts with -p <task> --output-format streaming-json", () => {
	const args = buildGrokArgs(base);
	assert.equal(args[0], "-p");
	assert.equal(args[1], "do the thing");
	assert.equal(args[2], "--output-format");
	assert.equal(args[3], "streaming-json");
});

test("grok argv: custom sandbox + always-approve on default / mutating phases", () => {
	const a = buildGrokArgs(base);
	assert.ok(a.includes("--always-approve"));
	assert.equal(a[a.indexOf("--sandbox") + 1], "taskflow-workspace");
	const b = buildGrokArgs({ ...base, tools: ["write", "bash"] });
	assert.ok(b.includes("--always-approve"));
	assert.equal(b[b.indexOf("--sandbox") + 1], "taskflow-workspace");
	assert.equal(b.indexOf("--tools"), -1);
});

test("grok argv: read-only phases pass --tools + --always-approve", () => {
	const args = buildGrokArgs({ ...base, tools: ["read", "grep"] });
	const ti = args.indexOf("--tools");
	assert.ok(ti >= 0);
	assert.ok(String(args[ti + 1]).includes("read_file"));
	assert.ok(args.includes("--always-approve"));
	assert.equal(args[args.indexOf("--sandbox") + 1], "taskflow-readonly");
});

test("grok argv: model via -m when resolvable", () => {
	const ok = buildGrokArgs({ ...base, model: "grok-build" });
	assert.ok(ok.includes("-m"));
	assert.equal(ok[ok.indexOf("-m") + 1], "grok-build");
	const drop = buildGrokArgs({ ...base, model: "{{fast}}" });
	assert.equal(drop.indexOf("-m"), -1);
});

test("grok argv: cwd via --cwd", () => {
	const args = buildGrokArgs({ ...base, cwd: "/tmp/proj" });
	assert.equal(args[args.indexOf("--cwd") + 1], "/tmp/proj");
});

test("grok argv: system prompt via --rules", () => {
	const args = buildGrokArgs({ ...base, systemPrompt: "You are careful." });
	assert.equal(args[args.indexOf("--rules") + 1], "You are careful.");
	const empty = buildGrokArgs({ ...base, systemPrompt: "   " });
	assert.equal(empty.indexOf("--rules"), -1);
});

test("grok argv: thinking via --reasoning-effort", () => {
	const args = buildGrokArgs({ ...base, thinking: "off" });
	assert.equal(args[args.indexOf("--reasoning-effort") + 1], "none");
});
