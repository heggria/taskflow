/**
 * Argv-contract tests for the hermes host runner — PURE, no hermes process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildHermesArgs,
	HERMES_UNSAFE_YOLO_ENV,
	foldHermesQuietLine,
	hermesBin,
	hermesChildEnv,
	hermesUnsafeYoloEnabled,
	isHermesReadOnlyPhase,
	newHermesAccumulator,
	resolveHermesModel,
	resolveHermesReasoning,
	resolveHermesToolsets,
	type HermesArgsCtx,
} from "../src/hermes-runner.ts";

// --- bin resolution ---------------------------------------------------------

test("hermes bin: defaults to `hermes`, honours PI_TASKFLOW_HERMES_BIN override", () => {
	const prev = process.env.PI_TASKFLOW_HERMES_BIN;
	try {
		delete process.env.PI_TASKFLOW_HERMES_BIN;
		assert.equal(hermesBin(), "hermes");
		process.env.PI_TASKFLOW_HERMES_BIN = "/custom/hermes";
		assert.equal(hermesBin(), "/custom/hermes");
	} finally {
		if (prev === undefined) delete process.env.PI_TASKFLOW_HERMES_BIN;
		else process.env.PI_TASKFLOW_HERMES_BIN = prev;
	}
});

// --- read-only / permission mapping ----------------------------------------

test("hermes read-only: no whitelist → NOT read-only (default-capable)", () => {
	assert.equal(isHermesReadOnlyPhase(undefined), false);
	assert.equal(isHermesReadOnlyPhase([]), false);
});

test("hermes read-only: read-only whitelist → read-only", () => {
	assert.equal(isHermesReadOnlyPhase(["read", "grep", "web_search"]), true);
	assert.equal(isHermesReadOnlyPhase(["read_file", "search_files"]), true);
});

test("hermes read-only: any mutating tool → NOT read-only", () => {
	for (const t of ["write", "edit", "bash", "terminal", "write_file", "patch", "execute_code"]) {
		assert.equal(isHermesReadOnlyPhase([t]), false, t);
	}
	assert.equal(isHermesReadOnlyPhase(["read", "terminal"]), false);
});

test("hermes toolsets: read-only → search (no file write); web opt-in; empty mutating safe default", () => {
	assert.equal(resolveHermesToolsets(["read"], true), "search");
	assert.equal(resolveHermesToolsets(["read"], true, { readonlyWeb: true }), "web,search");
	assert.equal(resolveHermesToolsets(undefined, false), "file,terminal,web,search");
	assert.equal(resolveHermesToolsets(["bash", "read"], false), "file,terminal");
	assert.equal(resolveHermesToolsets(["skill_manage"], false), "skills");
	assert.equal(resolveHermesToolsets(["delegate_task"], false), "delegation");
	assert.throws(() => resolveHermesToolsets(["totally-unknown"], false), /did not map/);
});

test("hermes env: strips YOLO, prefill injection, AWS; keeps HERMES_HOME + provider", () => {
	const env = hermesChildEnv({
		PATH: "/bin",
		HOME: "/home/test",
		HERMES_HOME: "/home/test/.hermes",
		HERMES_YOLO_MODE: "1",
		HERMES_ACCEPT_HOOKS: "1",
		HERMES_EPHEMERAL_SYSTEM_PROMPT: "inject",
		HERMES_PREFILL_MESSAGES_FILE: "/tmp/x",
		XAI_API_KEY: "provider",
		AWS_SECRET_ACCESS_KEY: "cloud",
		DATABASE_URL: "secret",
	});
	assert.equal(env.XAI_API_KEY, "provider");
	assert.equal(env.HERMES_HOME, "/home/test/.hermes");
	assert.equal(env.HERMES_YOLO_MODE, undefined);
	assert.equal(env.HERMES_ACCEPT_HOOKS, undefined);
	assert.equal(env.HERMES_EPHEMERAL_SYSTEM_PROMPT, undefined);
	assert.equal(env.HERMES_PREFILL_MESSAGES_FILE, undefined);
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(env.DATABASE_URL, undefined);
});

// --- model / reasoning ------------------------------------------------------

test("hermes model: passes through provider/model; drops placeholders and strips thinking suffix", () => {
	assert.equal(resolveHermesModel("xai/grok-4.5"), "xai/grok-4.5");
	assert.equal(resolveHermesModel("{{fast}}"), undefined);
	assert.equal(resolveHermesModel("anthropic/claude-sonnet-4:xhigh"), "anthropic/claude-sonnet-4");
	assert.equal(resolveHermesModel(undefined), undefined);
});

test("hermes reasoning: normalizes off→none; rejects unknown", () => {
	assert.equal(resolveHermesReasoning("off"), "none");
	assert.equal(resolveHermesReasoning("high"), "high");
	assert.throws(() => resolveHermesReasoning("ludicrous"), /Unsupported Hermes reasoning/);
});

// --- quiet-mode fold --------------------------------------------------------

test("hermes fold: strips session_id meta; accumulates answer body", () => {
	const acc = newHermesAccumulator("m");
	assert.equal(foldHermesQuietLine(acc, "session_id: 20260811_121111_f093bf"), null);
	assert.equal(acc.sessionId, "20260811_121111_f093bf");
	const u1 = foldHermesQuietLine(acc, "hello");
	assert.ok(u1);
	assert.equal(acc.finalText, "hello");
	foldHermesQuietLine(acc, "world");
	assert.equal(acc.finalText, "hello\nworld");
	assert.equal(acc.terminalSeen, true);
});

test("hermes fold: leading error: line becomes fatal when no body yet", () => {
	const acc = newHermesAccumulator();
	foldHermesQuietLine(acc, "error: boom");
	assert.equal(acc.fatalError, "boom");
});

// --- full argv contract -----------------------------------------------------

const baseCtx: HermesArgsCtx = {
	systemPrompt: "",
	task: "count files",
	model: undefined,
	tools: undefined,
	cwd: undefined,
	allowUnsafeYolo: true,
};

test("hermes argv: starts with chat -q <prompt> -Q --source tool and isolation flags", () => {
	const { args } = buildHermesArgs({ ...baseCtx });
	assert.equal(args[0], "chat");
	assert.equal(args[1], "-q");
	assert.ok(String(args[2]).includes("count files"));
	assert.ok(args.includes("-Q"));
	const src = args.indexOf("--source");
	assert.ok(src >= 0);
	assert.equal(args[src + 1], "tool");
	assert.ok(args.includes("--safe-mode"));
	// --safe-mode implies ignore-user-config/ignore-rules; we do not double-list them.
	assert.ok(args.includes("-t"));
	assert.ok(args.includes("--max-turns"));
});

test("hermes argv: mutating/default fails closed unless yolo acknowledged", () => {
	assert.throws(
		() => buildHermesArgs({ ...baseCtx, allowUnsafeYolo: false }),
		new RegExp(`${HERMES_UNSAFE_YOLO_ENV}=1`),
	);
	assert.ok(buildHermesArgs({ ...baseCtx }).args.includes("--yolo"));
	assert.equal(
		buildHermesArgs({ ...baseCtx, tools: ["read"] }).args.includes("--yolo"),
		false,
		"read-only omits --yolo",
	);
});

test("hermes unsafe yolo opt-in: only exact env value 1 is accepted", () => {
	for (const value of [undefined, "", "0", "true", "yes"]) {
		const env = value === undefined ? {} : { [HERMES_UNSAFE_YOLO_ENV]: value };
		assert.equal(hermesUnsafeYoloEnabled(env), false);
	}
	assert.equal(hermesUnsafeYoloEnabled({ [HERMES_UNSAFE_YOLO_ENV]: "1" }), true);
});

test("hermes argv: cwd via --in; model via -m; reasoning via --reasoning", () => {
	const { args } = buildHermesArgs({
		...baseCtx,
		cwd: "/repo",
		model: "xai/grok-4.5",
		thinking: "high",
	});
	const inIdx = args.indexOf("--in");
	assert.ok(inIdx >= 0);
	assert.equal(args[inIdx + 1], "/repo");
	const mIdx = args.indexOf("-m");
	assert.ok(mIdx >= 0);
	assert.equal(args[mIdx + 1], "xai/grok-4.5");
	const rIdx = args.indexOf("--reasoning");
	assert.ok(rIdx >= 0);
	assert.equal(args[rIdx + 1], "high");
});

test("hermes argv: system prompt prepended to -q body", () => {
	const { args } = buildHermesArgs({ ...baseCtx, systemPrompt: "You are careful." });
	const q = args[args.indexOf("-q") + 1] as string;
	assert.match(q, /You are careful/);
	assert.match(q, /Task: count files/);
});
