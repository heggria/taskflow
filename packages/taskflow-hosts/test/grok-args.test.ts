/**
 * Argv-contract tests for the Grok Build host runner — PURE, no grok process.
 *
 * Locks down `grok -p`'s CLI flag contract in CI (docs.x.ai / headless guide).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildGrokArgs,
	grokBin,
	permissionArgsForGrokTools,
	resolveGrokModel,
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

test("grok perms: no whitelist → --always-approve", () => {
	assert.deepEqual(permissionArgsForGrokTools(undefined), ["--always-approve"]);
	assert.deepEqual(permissionArgsForGrokTools([]), ["--always-approve"]);
});

test("grok perms: mutating whitelist → --always-approve", () => {
	assert.deepEqual(permissionArgsForGrokTools(["read", "write"]), ["--always-approve"]);
	assert.deepEqual(permissionArgsForGrokTools(["bash"]), ["--always-approve"]);
	assert.deepEqual(permissionArgsForGrokTools(["run_terminal_cmd"]), ["--always-approve"]);
	assert.deepEqual(permissionArgsForGrokTools(["search_replace"]), ["--always-approve"]);
});

test("grok perms: read-only whitelist → --tools <read set> + --always-approve", () => {
	const args = permissionArgsForGrokTools(["read", "grep", "glob"]);
	assert.equal(args[0], "--tools");
	const allowed = String(args[1]).split(",");
	assert.ok(allowed.includes("read_file"));
	assert.ok(allowed.includes("grep"));
	assert.ok(allowed.includes("list_dir"));
	assert.ok(!allowed.includes("run_terminal_cmd"));
	assert.ok(!allowed.includes("search_replace"));
	assert.equal(args[2], "--always-approve");
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

// --- argv contract ----------------------------------------------------------

const base: GrokArgsCtx = {
	systemPrompt: "",
	task: "do the thing",
};

test("grok argv: starts with -p <task> --output-format streaming-json", () => {
	const args = buildGrokArgs(base);
	assert.equal(args[0], "-p");
	assert.equal(args[1], "do the thing");
	assert.equal(args[2], "--output-format");
	assert.equal(args[3], "streaming-json");
});

test("grok argv: always-approve on default / mutating phases", () => {
	const a = buildGrokArgs(base);
	assert.ok(a.includes("--always-approve"));
	const b = buildGrokArgs({ ...base, tools: ["write", "bash"] });
	assert.ok(b.includes("--always-approve"));
	assert.equal(b.indexOf("--tools"), -1);
});

test("grok argv: read-only phases pass --tools + --always-approve", () => {
	const args = buildGrokArgs({ ...base, tools: ["read", "grep"] });
	const ti = args.indexOf("--tools");
	assert.ok(ti >= 0);
	assert.ok(String(args[ti + 1]).includes("read_file"));
	assert.ok(args.includes("--always-approve"));
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
