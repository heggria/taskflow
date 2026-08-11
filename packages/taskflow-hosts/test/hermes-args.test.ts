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
	prepareEphemeralHermesHome,
	resolveHermesModel,
	resolveHermesReasoning,
	resolveHermesToolsets,
	stripHermesReasoningNoise,
	type HermesArgsCtx,
} from "../src/hermes-runner.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

test("hermes toolsets: RO local-read → taskflow_readonly_files; never omit -t", () => {
	assert.equal(resolveHermesToolsets(["read"], true), "taskflow_readonly_files");
	assert.equal(
		resolveHermesToolsets(["read"], true, { readonlyWeb: true }),
		"search,taskflow_readonly_files,web",
	);
	// Critical: bare RO without local tools must still pass an explicit empty toolset.
	assert.equal(resolveHermesToolsets(["web_search"], true), "taskflow_model_only");
	assert.equal(resolveHermesToolsets(["web_search"], true, { readonlyWeb: true }), "search,web");
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

test("hermes fold: preserves session_id-like stdout as answer text", () => {
	const acc = newHermesAccumulator("m");
	const line = "session_id: this-is-answer-text";
	const update = foldHermesQuietLine(acc, line);
	assert.ok(update);
	assert.equal(acc.sessionId, undefined);
	assert.equal(acc.finalText, line);
	foldHermesQuietLine(acc, "world");
	assert.equal(acc.finalText, `${line}\nworld`);
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
	assert.ok(args.includes("--ignore-rules"));
	// Ephemeral config replaces --safe-mode (safe-mode would ignore our config).
	assert.equal(args.includes("--safe-mode"), false);
	// default-capable includes -t; pure model RO omits it (see next test).
	assert.ok(args.includes("-t"));
	assert.ok(args.includes("--max-turns"));
});

test("hermes argv: mutating/default fails closed unless yolo acknowledged", () => {
	assert.throws(
		() => buildHermesArgs({ ...baseCtx, allowUnsafeYolo: false }),
		new RegExp(`${HERMES_UNSAFE_YOLO_ENV}=1`),
	);
	assert.ok(buildHermesArgs({ ...baseCtx }).args.includes("--yolo"));
	const ro = buildHermesArgs({ ...baseCtx, tools: ["read"] });
	assert.equal(ro.args.includes("--yolo"), false, "read-only omits --yolo");
	assert.ok(ro.args.includes("-t"));
	assert.equal(ro.args[ro.args.indexOf("-t") + 1], "taskflow_readonly_files");
	const roWeb = buildHermesArgs({ ...baseCtx, tools: ["read"], readonlyWeb: true });
	assert.equal(roWeb.args[roWeb.args.indexOf("-t") + 1], "search,taskflow_readonly_files,web");
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

test("hermes ephemeral home: allowlists provider dotenv and writes config+RO plugin", () => {
	const parent = mkdtempSync(join(tmpdir(), "tf-hermes-parent-"));
	writeFileSync(
		join(parent, ".env"),
		"XAI_API_KEY=test\nTELEGRAM_BOT_TOKEN=must-not-copy\nDATABASE_URL=must-not-copy\n",
	);
	writeFileSync(join(parent, "auth.json"), "{}\n");
	writeFileSync(join(parent, "config.yaml"), "should-not-copy: true\nmodel:\n  default: test-model\n  provider: xai-oauth\n");
	mkdirSync(join(parent, "skills"));
	writeFileSync(join(parent, "skills", "x.md"), "nope");
	const eph = prepareEphemeralHermesHome(parent, { tmpRoot: tmpdir(), readOnly: true });
	try {
		assert.notEqual(eph.home, parent);
		assert.ok(existsSync(join(eph.home, ".env")));
		const dotenv = readFileSync(join(eph.home, ".env"), "utf8");
		assert.match(dotenv, /XAI_API_KEY=test/);
		assert.doesNotMatch(dotenv, /TELEGRAM_BOT_TOKEN|DATABASE_URL/);
		assert.ok(existsSync(join(eph.home, "auth.json")));
		assert.equal(existsSync(join(eph.home, "skills")), false);
		const cfg = readFileSync(join(eph.home, "config.yaml"), "utf8");
		assert.match(cfg, /show_reasoning:\s*false/);
		assert.match(cfg, /taskflow_readonly/);
		assert.match(cfg, /model:\n\s+default: test-model/);
		assert.doesNotMatch(cfg, /should-not-copy/);
		assert.ok(existsSync(join(eph.home, "plugins", "taskflow_readonly", "__init__.py")));
	} finally {
		eph.cleanup();
	}
	assert.equal(existsSync(eph.home), false);
});

test("hermes ephemeral home: mutating child does not load the read-only plugin", () => {
	const parent = mkdtempSync(join(tmpdir(), "tf-hermes-parent-mut-"));
	writeFileSync(join(parent, "config.yaml"), "model: test-model\n");
	const eph = prepareEphemeralHermesHome(parent, { tmpRoot: tmpdir(), readOnly: false });
	try {
		const cfg = readFileSync(join(eph.home, "config.yaml"), "utf8");
		assert.doesNotMatch(cfg, /taskflow_readonly/);
		assert.equal(existsSync(join(eph.home, "plugins", "taskflow_readonly")), false);
	} finally {
		eph.cleanup();
	}
});

test("hermes RO plugin: cwd-bounds read_file and search_files, including symlink escape", () => {
	const parent = mkdtempSync(join(tmpdir(), "tf-hermes-parent-ro-"));
	const eph = prepareEphemeralHermesHome(parent, { tmpRoot: tmpdir(), readOnly: true });
	try {
		const plugin = readFileSync(join(eph.home, "plugins", "taskflow_readonly", "__init__.py"), "utf8");
		assert.match(plugin, /name in \{"read_file", "search_files"\}/);
		assert.match(plugin, /args\.get\("path", "\."\)/);
		assert.match(plugin, /resolve\(strict=False\)/);
		assert.match(plugin, /target\.relative_to\(cwd\)/);
	} finally {
		eph.cleanup();
	}
});

test("hermes stripHermesReasoningNoise: drops box header and think tags", () => {
	const noisy =
		"\n┌─ Reasoning ──────────────────────────────────────────────────────────────────┐\nthinking aloud\nCLEAN_OK\n";
	assert.equal(stripHermesReasoningNoise(noisy).trim(), "thinking aloud\nCLEAN_OK");
	assert.equal(stripHermesReasoningNoise("<think>secret</think>\nHI").trim(), "HI");
});
