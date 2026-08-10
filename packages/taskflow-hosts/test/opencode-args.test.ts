/**
 * Argv-contract tests for the opencode host runner — PURE, no opencode process.
 *
 * These lock down `opencode run`'s CLI flag contract in CI. The executor e2e
 * (`e2e-opencode.mts`) needs a live opencode session so it never runs in CI;
 * without these unit tests, a flag rename (e.g. `--format json` → `--json`) or
 * a `--auto` / read-only policy regression would only be caught at runtime.
 * `buildOpencodeArgs` is the extracted, pure, exported argv builder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildOpencodeArgs,
	OPENCODE_UNSAFE_AUTO_ENV,
	OPENCODE_READ_ONLY_CONFIG,
	opencodeBin,
	opencodeChildEnv,
	opencodeUnsafeAutoEnabled,
	isReadOnlyPhase,
	resolveOpencodeModel,
	resolveOpencodeThinking,
	type OpencodeArgsCtx,
} from "../src/opencode-runner.ts";

// --- bin resolution ---------------------------------------------------------

test("opencode bin: defaults to `opencode`, honours PI_TASKFLOW_OPENCODE_BIN override", () => {
	const prev = process.env.PI_TASKFLOW_OPENCODE_BIN;
	try {
		delete process.env.PI_TASKFLOW_OPENCODE_BIN;
		assert.equal(opencodeBin(), "opencode");
		process.env.PI_TASKFLOW_OPENCODE_BIN = "/custom/opencode";
		assert.equal(opencodeBin(), "/custom/opencode");
	} finally {
		if (prev === undefined) delete process.env.PI_TASKFLOW_OPENCODE_BIN;
		else process.env.PI_TASKFLOW_OPENCODE_BIN = prev;
	}
});

// --- read-only / permission mapping ----------------------------------------

test("opencode read-only: no whitelist → NOT read-only (default-capable)", () => {
	assert.equal(isReadOnlyPhase(undefined), false);
	assert.equal(isReadOnlyPhase([]), false);
});

test("opencode read-only: read-only whitelist (no write/edit/bash) → read-only", () => {
	assert.equal(isReadOnlyPhase(["read", "grep", "glob"]), true);
});

test("opencode read-only: any mutating tool → NOT read-only", () => {
	for (const t of ["write", "edit", "bash", "apply_patch"]) {
		assert.equal(isReadOnlyPhase([t]), false);
	}
	assert.equal(isReadOnlyPhase(["read", "bash"]), false);
});

// --- model resolution (opencode is the inverse of codex/claude) ------------

test("opencode model: a clean `provider/model` (one slash) passes THROUGH", () => {
	assert.equal(resolveOpencodeModel("anthropic/claude-sonnet-4"), "anthropic/claude-sonnet-4");
	assert.equal(resolveOpencodeModel("openai/gpt-5"), "openai/gpt-5");
});

test("opencode model: unresolved placeholder / thinking-suffix / openrouter path dropped", () => {
	assert.equal(resolveOpencodeModel("{{fast}}"), undefined);
	assert.equal(resolveOpencodeModel("anthropic/glm-5.2:xhigh"), undefined); // pi thinking suffix
	assert.equal(resolveOpencodeModel("openrouter/vendor/model"), undefined); // ≥2 slashes
});

test("opencode model: undefined → undefined", () => {
	assert.equal(resolveOpencodeModel(undefined), undefined);
});

// --- full argv contract -----------------------------------------------------

const baseCtx: OpencodeArgsCtx = { systemPrompt: "", task: "count files", model: undefined, tools: undefined, cwd: undefined, allowUnsafeAuto: true };

test("opencode argv: starts with `run <prompt> --format json`", () => {
	const { args } = buildOpencodeArgs({ ...baseCtx });
	assert.equal(args[0], "run");
	assert.equal(args[2], "--format");
	assert.equal(args[3], "json", "opencode uses `--format json`, not `--json`");
	assert.ok(args.includes("--pure"), "every OpenCode child must disable external plugins");
});

test("opencode argv: mutating/default fails closed unless explicitly acknowledged", () => {
	assert.throws(
		() => buildOpencodeArgs({ ...baseCtx, allowUnsafeAuto: false }),
		new RegExp(`${OPENCODE_UNSAFE_AUTO_ENV}=1`),
	);
	assert.ok(buildOpencodeArgs({ ...baseCtx }).args.includes("--auto"), "no whitelist → --auto (bypass)");
	assert.ok(
		buildOpencodeArgs({ ...baseCtx, tools: ["bash"] }).args.includes("--auto"),
		"mutating tools → --auto",
	);
	assert.equal(
		buildOpencodeArgs({ ...baseCtx, tools: ["read"] }).args.includes("--auto"),
		false,
		"read-only phase omits --auto (deny-mutations policy injected via env instead)",
	);
});

test("opencode unsafe auto opt-in: only exact env value 1 is accepted", () => {
	for (const value of [undefined, "", "0", "true", "yes"]) {
		const env = value === undefined ? {} : { [OPENCODE_UNSAFE_AUTO_ENV]: value };
		assert.equal(opencodeUnsafeAutoEnabled(env), false);
	}
	assert.equal(opencodeUnsafeAutoEnabled({ [OPENCODE_UNSAFE_AUTO_ENV]: "1" }), true);
});

test("opencode read-only config denies inherited native, custom, and MCP tools by default", () => {
	const config = JSON.parse(OPENCODE_READ_ONLY_CONFIG) as { permission: Record<string, string> };
	assert.equal(config.permission["*"], "deny");
	for (const tool of ["read", "grep", "glob", "list"]) assert.equal(config.permission[tool], "allow");
});

test("opencode env: keeps provider/runtime keys and drops unrelated secrets", () => {
	const env = opencodeChildEnv({
		PATH: "/bin",
		HOME: "/home/test",
		OPENCODE_CONFIG: "/safe/config.json",
		ANTHROPIC_API_KEY: "provider",
		DATABASE_URL: "secret",
	});
	assert.equal(env.ANTHROPIC_API_KEY, "provider");
	assert.equal(env.OPENCODE_CONFIG, "/safe/config.json");
	assert.equal(env.DATABASE_URL, undefined);
});

test("opencode argv: read-only flag returned so the caller injects the env policy", () => {
	assert.equal(buildOpencodeArgs({ ...baseCtx, tools: ["read"] }).readOnly, true);
	assert.equal(buildOpencodeArgs({ ...baseCtx }).readOnly, false);
});

test("opencode argv: cwd passed via `--dir <dir>` when present", () => {
	const { args } = buildOpencodeArgs({ ...baseCtx, cwd: "/repo" });
	const idx = args.indexOf("--dir");
	assert.ok(idx >= 0);
	assert.equal(args[idx + 1], "/repo");
	assert.equal(buildOpencodeArgs({ ...baseCtx }).args.indexOf("--dir"), -1);
});

test("opencode argv: model passed via `-m <provider/model>` only when resolvable", () => {
	const { args } = buildOpencodeArgs({ ...baseCtx, model: "anthropic/claude-sonnet-4" });
	const idx = args.indexOf("-m");
	assert.ok(idx >= 0);
	assert.equal(args[idx + 1], "anthropic/claude-sonnet-4");

	// A pi thinking-suffix model is dropped — no `-m`.
	assert.equal(
		buildOpencodeArgs({ ...baseCtx, model: "anthropic/glm-5.2:xhigh" }).args.indexOf("-m"),
		-1,
	);
});

test("opencode argv: thinking is passed via provider-specific --variant", () => {
	const high = buildOpencodeArgs({ ...baseCtx, thinking: "high" }).args;
	assert.equal(high[high.indexOf("--variant") + 1], "high");
	const off = buildOpencodeArgs({ ...baseCtx, thinking: "off" }).args;
	assert.equal(off[off.indexOf("--variant") + 1], "none");
	const ultra = buildOpencodeArgs({ ...baseCtx, thinking: "ultra" }).args;
	assert.equal(ultra[ultra.indexOf("--variant") + 1], "max");
	assert.equal(buildOpencodeArgs({ ...baseCtx }).args.indexOf("--variant"), -1);
	assert.throws(() => resolveOpencodeThinking("bogus"), /Unsupported OpenCode thinking level/);
});

test("opencode argv: system prompt is prepended into the prompt (no --append-system-prompt flag)", () => {
	const { args } = buildOpencodeArgs({ ...baseCtx, systemPrompt: "You are a scout." });
	assert.equal(args.indexOf("--append-system-prompt"), -1, "opencode has no such flag");
	assert.match(
		String(args[1]),
		/^You are a scout\.\n\n---\n\nTask: count files$/,
		"system prompt prepended into the positional prompt (like codex)",
	);
});
