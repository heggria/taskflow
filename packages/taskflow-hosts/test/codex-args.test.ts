/**
 * Argv-contract tests for the codex host runner — PURE, no codex process.
 *
 * These lock down `codex exec`'s CLI flag contract in CI. The executor e2e
 * (`e2e-codex.mts`) needs a live codex session so it never runs in CI; without
 * these unit tests, a flag rename (e.g. `--json` → `--format json`) or a
 * sandbox/permission mapping regression would only be caught at runtime by a
 * user. `buildCodexArgs` is the extracted, pure, exported argv builder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildCodexArgs,
	codexBin,
	sandboxForTools,
	resolveCodexModel,
	resolveCodexThinking,
	type CodexArgsCtx,
} from "../src/codex-runner.ts";

// --- bin resolution ---------------------------------------------------------

test("codex bin: defaults to `codex`, honours PI_TASKFLOW_CODEX_BIN override", () => {
	const prev = process.env.PI_TASKFLOW_CODEX_BIN;
	try {
		delete process.env.PI_TASKFLOW_CODEX_BIN;
		assert.equal(codexBin(), "codex");
		process.env.PI_TASKFLOW_CODEX_BIN = "/custom/path/codex";
		assert.equal(codexBin(), "/custom/path/codex");
	} finally {
		if (prev === undefined) delete process.env.PI_TASKFLOW_CODEX_BIN;
		else process.env.PI_TASKFLOW_CODEX_BIN = prev;
	}
});

// --- sandbox / permission mapping ------------------------------------------

test("codex sandbox: no whitelist → workspace-write (default-capable agent)", () => {
	assert.equal(sandboxForTools(undefined), "workspace-write");
	assert.equal(sandboxForTools([]), "workspace-write");
});

test("codex sandbox: read-only whitelist (no write/edit/bash) → read-only", () => {
	assert.equal(sandboxForTools(["read", "grep", "glob"]), "read-only");
});

test("codex sandbox: any mutating tool → workspace-write", () => {
	assert.equal(sandboxForTools(["bash"]), "workspace-write");
	assert.equal(sandboxForTools(["write"]), "workspace-write");
	assert.equal(sandboxForTools(["edit"]), "workspace-write");
	assert.equal(sandboxForTools(["apply_patch"]), "workspace-write");
	assert.equal(sandboxForTools(["read", "bash"]), "workspace-write"); // mixed still mutates
});

// --- model resolution -------------------------------------------------------

test("codex model: flat id passes through", () => {
	assert.equal(resolveCodexModel("gpt-5.5"), "gpt-5.5");
	assert.equal(resolveCodexModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("codex model: pi-provider path (contains `/`) is dropped → codex default", () => {
	assert.equal(resolveCodexModel("openrouter/deepseek/deepseek-chat"), undefined);
	assert.equal(resolveCodexModel("anthropic/glm-5.2"), undefined);
});

test("codex model: unresolved role placeholder {{...}} is dropped", () => {
	assert.equal(resolveCodexModel("{{fast}}"), undefined);
	assert.equal(resolveCodexModel("{{executor}}"), undefined);
});

test("codex model: undefined → undefined", () => {
	assert.equal(resolveCodexModel(undefined), undefined);
});

// --- thinking resolution ----------------------------------------------------

test("codex thinking: maps Taskflow levels to model_reasoning_effort", () => {
	assert.equal(resolveCodexThinking("off"), "none");
	assert.equal(resolveCodexThinking("none"), "none");
	assert.equal(resolveCodexThinking("minimal"), "none");
	assert.equal(resolveCodexThinking("low"), "low");
	assert.equal(resolveCodexThinking("xhigh"), "xhigh");
	assert.equal(resolveCodexThinking("max"), "xhigh");
	assert.equal(resolveCodexThinking("ultra"), "xhigh");
	assert.throws(() => resolveCodexThinking("unknown"), /Unsupported Codex thinking level/);
	assert.equal(resolveCodexThinking(undefined), undefined);
});

// --- full argv contract -----------------------------------------------------

const baseCtx: CodexArgsCtx = { systemPrompt: "", task: "count files", model: undefined, tools: undefined, cwd: undefined };

test("codex argv: starts with `exec --json --skip-git-repo-check -s <sandbox>`", () => {
	const args = buildCodexArgs({ ...baseCtx });
	assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write"]);
});

test("codex argv: `-s` reflects the sandbox for the tool whitelist", () => {
	assert.equal(
		buildCodexArgs({ ...baseCtx, tools: ["read", "grep"] })[4],
		"read-only",
		"read-only tools → -s read-only",
	);
	assert.equal(
		buildCodexArgs({ ...baseCtx, tools: ["bash"] })[4],
		"workspace-write",
		"mutating tools → -s workspace-write",
	);
});

test("codex argv: model passed via `-m <id>` only when resolvable; never a `/` path", () => {
	const withModel = buildCodexArgs({ ...baseCtx, model: "gpt-5.5" });
	assert.deepEqual([-2, -1].map((i) => withModel.at(i)).includes("-m"), false); // model is mid-array; check directly
	const mIdx = withModel.indexOf("-m");
	assert.ok(mIdx >= 0, "resolvable model adds `-m`");
	assert.equal(withModel[mIdx + 1], "gpt-5.5");

	// A pi-provider path is dropped — no `-m` flag at all.
	const dropped = buildCodexArgs({ ...baseCtx, model: "openrouter/deepseek/chat" });
	assert.equal(dropped.indexOf("-m"), -1, "pi-provider model path is NOT passed to codex");
});

test("codex argv: cwd passed via `-C <dir>` when present", () => {
	const withCwd = buildCodexArgs({ ...baseCtx, cwd: "/repo" });
	const idx = withCwd.indexOf("-C");
	assert.ok(idx >= 0);
	assert.equal(withCwd[idx + 1], "/repo");
	assert.equal(buildCodexArgs({ ...baseCtx }).indexOf("-C"), -1, "no cwd → no -C flag");
});

test("codex argv: thinking is passed via model_reasoning_effort config", () => {
	const low = buildCodexArgs({ ...baseCtx, thinking: "low" });
	const lowIdx = low.indexOf("-c");
	assert.ok(lowIdx >= 0);
	assert.equal(low[lowIdx + 1], "model_reasoning_effort=low");

	const off = buildCodexArgs({ ...baseCtx, thinking: "off" });
	assert.equal(off[off.indexOf("-c") + 1], "model_reasoning_effort=none");
	assert.throws(() => buildCodexArgs({ ...baseCtx, thinking: "unknown" }), /Unsupported Codex thinking level/);
});

test("codex argv: prompt is the LAST positional arg; system prompt is prepended", () => {
	const noSys = buildCodexArgs({ ...baseCtx });
	assert.equal(noSys.at(-1), "Task: count files", "no system prompt → `Task: <task>` as last arg");

	const withSys = buildCodexArgs({ ...baseCtx, systemPrompt: "You are a scout." });
	assert.match(
		String(withSys.at(-1)),
		/^You are a scout\.\n\n---\n\nTask: count files$/,
		"system prompt prepended to the task prompt",
	);
});
