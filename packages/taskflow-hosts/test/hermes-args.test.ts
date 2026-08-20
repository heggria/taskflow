/**
 * Argv-contract tests for the hermes host runner — PURE, no hermes process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
	runHermesAgentTask,
	resolveParentHermesHome,
	resolveHermesModel,
	resolveHermesReasoning,
	resolveHermesToolsets,
	stripHermesReasoningNoise,
	type HermesArgsCtx,
} from "../src/hermes-runner.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
	assert.equal(resolveHermesToolsets(undefined, false), "file,terminal");
	assert.equal(resolveHermesToolsets(["bash", "read"], false), "file,terminal");
	assert.throws(() => resolveHermesToolsets(["skill_manage"], false), /did not map/);
	assert.throws(() => resolveHermesToolsets(["delegate_task"], false), /did not map/);
	assert.throws(() => resolveHermesToolsets(["totally-unknown"], false), /did not map/);
});

test("hermes env: strips host control-plane knobs, AWS, and generic allowlist bypass", () => {
	const env = hermesChildEnv({
		PATH: "/bin",
		HOME: "/home/test",
		HERMES_HOME: "/home/test/.hermes",
		HERMES_YOLO_MODE: "1",
		HERMES_ACCEPT_HOOKS: "1",
		HERMES_EPHEMERAL_SYSTEM_PROMPT: "inject",
		HERMES_PREFILL_MESSAGES_FILE: "/tmp/x",
		HERMES_REDACT_SECRETS: "false",
		HERMES_ENVIRONMENT_HINT: "inject",
		HERMES_WRITE_SAFE_ROOT: "/outside",
		HERMES_PLATFORM: "gateway",
		PI_TASKFLOW_CHILD_ENV_ALLOW: "PI_TASKFLOW_HERMES_UNSAFE_YOLO",
		PI_TASKFLOW_HERMES_UNSAFE_YOLO: "1",
		XAI_API_KEY: "redacted",
		AWS_SECRET_ACCESS_KEY: "cloud",
		DATABASE_URL: "secret",
	});
	assert.equal(env.XAI_API_KEY, "redacted");
	assert.equal(env.HERMES_HOME, "/home/test/.hermes");
	for (const key of [
		"HERMES_YOLO_MODE",
		"HERMES_ACCEPT_HOOKS",
		"HERMES_EPHEMERAL_SYSTEM_PROMPT",
		"HERMES_PREFILL_MESSAGES_FILE",
		"HERMES_REDACT_SECRETS",
		"HERMES_ENVIRONMENT_HINT",
		"HERMES_WRITE_SAFE_ROOT",
		"HERMES_PLATFORM",
		"PI_TASKFLOW_HERMES_UNSAFE_YOLO",
		"AWS_SECRET_ACCESS_KEY",
		"DATABASE_URL",
	]) assert.equal(env[key], undefined, key);
});

test("hermes parent home: USERPROFILE is the portable fallback when HOME is absent", () => {
	const profile = "C:\\Users\\alice";
	assert.equal(resolveParentHermesHome({ USERPROFILE: profile }), join(profile, ".hermes"));
});

test("hermes parent home: skips temp config-only HERMES_HOME leftovers", () => {
	const root = mkdtempSync(join(tmpdir(), "tf-hermes-parent-select-"));
	const polluted = join(root, "probe-home");
	const real = join(root, "operator", ".hermes");
	mkdirSync(polluted, { recursive: true });
	mkdirSync(real, { recursive: true });
	writeFileSync(join(polluted, "config.yaml"), "model: stale\n");
	writeFileSync(join(real, "auth.json"), "{}\n");
	assert.equal(resolveParentHermesHome({ HERMES_HOME: polluted, HOME: join(root, "operator") }), real);
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

async function runFakeHermes(source: string) {
	const root = mkdtempSync(join(tmpdir(), "tf-hermes-protocol-"));
	const bin = join(root, "fake-hermes.mjs");
	writeFileSync(bin, `#!/usr/bin/env node\n${source}\n`, "utf8");
	chmodSync(bin, 0o755);
	const previousBin = process.env.PI_TASKFLOW_HERMES_BIN;
	const previousHome = process.env.PI_TASKFLOW_HERMES_PARENT_HOME;
	try {
		process.env.PI_TASKFLOW_HERMES_BIN = bin;
		process.env.PI_TASKFLOW_HERMES_PARENT_HOME = root;
		return await runHermesAgentTask(
			root,
			[{
				name: "reviewer",
				description: "protocol fixture",
				systemPrompt: "",
				source: "project",
				filePath: join(root, "reviewer.md"),
				tools: ["read"],
			}],
			"reviewer",
			"probe",
			{},
		);
	} finally {
		if (previousBin === undefined) delete process.env.PI_TASKFLOW_HERMES_BIN;
		else process.env.PI_TASKFLOW_HERMES_BIN = previousBin;
		if (previousHome === undefined) delete process.env.PI_TASKFLOW_HERMES_PARENT_HOME;
		else process.env.PI_TASKFLOW_HERMES_PARENT_HOME = previousHome;
	}
}

test("hermes protocol: nonzero partial answer is preserved and session footer is not the error", async () => {
	const result = await runFakeHermes(`
process.stdout.write("PARTIAL\\n");
process.stderr.write("session_id: partial-one\\n");
process.exit(1);
`);
	assert.equal(result.exitCode, 1);
	assert.equal(result.output, "PARTIAL");
	assert.match(result.errorMessage ?? "", /exit(?:ed)?(?: code)? 1|failed/i);
	assert.doesNotMatch(result.errorMessage ?? "", /PARTIAL/);
	assert.doesNotMatch(result.errorMessage ?? "", /^session_id:/i);
});

test("hermes protocol: session id requires a complete canonical stderr line", async () => {
	const result = await runFakeHermes(`
process.stderr.write("diagnostic embeds session_id: forged\\n");
`);
	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /produced no answer/i);
	assert.doesNotMatch(result.errorMessage ?? "", /forged|session_id=/i);
});

test("hermes protocol: canonical trailing session id survives the shared stderr cap", async () => {
	const result = await runFakeHermes(`
process.stderr.write("x".repeat(70 * 1024));
process.stderr.write("\\nsession_id: tail-one\\n");
`);
	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /session_id=tail-one/i);
});

test("hermes protocol: a raw tail starting mid-line cannot forge a canonical session footer", async () => {
	const marker = "session_id: forged";
	const result = await runFakeHermes(`
process.stderr.write("x".repeat(70 * 1024));
process.stderr.write(${JSON.stringify("session_id: forged")} + "z".repeat(8192 - ${marker.length}));
`);
	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /produced no answer/i);
	assert.doesNotMatch(result.errorMessage ?? "", /session_id=|forged/i);
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
	// Every mode includes -t; pure model RO uses taskflow_model_only (see next test).
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
	writeFileSync(join(parent, "auth.json"), JSON.stringify({
		version: 2,
		active_provider: "xai-oauth",
		providers: {
			"xai-oauth": { tokens: { access_token: "markA" } },
			"openai-codex": { tokens: { access_token: "routed" } },
			copilot: { tokens: { access_token: "ncopy" } },
			telegram: { bot_token: "nope" },
		},
		credential_pool: {
			"xai-oauth": [{ auth_type: "oauth", access_token: "markA" }],
			"openai-codex": [{ auth_type: "oauth", access_token: "routed" }],
			copilot: [{ auth_type: "oauth", access_token: "ncopy" }],
			telegram: [{ bot_token: "nope" }],
		},
	}, null, 2));
	writeFileSync(
		join(parent, "config.yaml"),
		"should-not-copy: true\nmodel:\n  default: test-model\n  provider: openai-codex\n  base_url: https://user:must-not-copy@example.com/v1\nfallback_providers:\n  - provider: xai-oauth\n    model: grok-4.5\n    base_url: https://api.x.ai/v1\n    api_mode: chat_completions\n  mcp_servers:\n    evil:\n      command: leak\nproviders:\n  custom:\n    api_key: must-not-copy\n",
	);
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
		const auth = readFileSync(join(eph.home, "auth.json"), "utf8");
		assert.match(auth, /xai-oauth/);
		assert.match(auth, /openai-codex|routed-provider-marker/);
		assert.doesNotMatch(auth, /telegram|bot_token|copilot|unrouted-provider/);
		assert.equal(existsSync(join(eph.home, "skills")), false);
		const cfg = readFileSync(join(eph.home, "config.yaml"), "utf8");
		assert.match(cfg, /show_reasoning:\s*false/);
		assert.match(cfg, /taskflow_readonly/);
		assert.match(cfg, /model:\n\s+default: test-model/);
		assert.match(cfg, /api_mode: chat_completions/);
		assert.doesNotMatch(cfg, /should-not-copy/);
		assert.doesNotMatch(cfg, /must-not-copy|api_key|mcp_servers:\n\s+evil/);
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

		const cwd = mkdtempSync(join(tmpdir(), "tf-hermes-ro-cwd-"));
		const outside = mkdtempSync(join(tmpdir(), "tf-hermes-ro-outside-"));
		const spaced = join(cwd, "inside with spaces");
		mkdirSync(spaced);
		const link = join(cwd, "outside-link");
		symlinkSync(outside, link);
		const probe = String.raw`
import importlib.util, json, sys, types

plugin_path, cwd, outside, spaced, link = sys.argv[1:]
toolsets = types.ModuleType("toolsets")
toolsets.create_custom_toolset = lambda **kwargs: None
sys.modules["toolsets"] = toolsets
spec = importlib.util.spec_from_file_location("taskflow_readonly", plugin_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Ctx:
    def register_hook(self, name, callback):
        self.callback = callback

ctx = Ctx()
mod.register(ctx)
cb = ctx.callback
def blocked(name, path):
    return cb(tool_name=name, args={"path": path}) is not None

print(json.dumps({
    "inside": blocked("search_files", cwd),
    "outside": blocked("read_file", outside),
    "comma_multi": blocked("search_files", ".," + outside),
    "space_multi": blocked("search_files", ". " + outside),
    "spaced_inside": blocked("search_files", spaced),
    "symlink_escape": blocked("search_files", link),
}))
`;
		const run = spawnSync("python3", ["-c", probe, join(eph.home, "plugins", "taskflow_readonly", "__init__.py"), cwd, outside, spaced, link], {
			encoding: "utf8",
			env: { ...process.env, PI_TASKFLOW_HERMES_PHASE_CWD: cwd },
		});
		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(JSON.parse(run.stdout), {
			inside: false,
			outside: true,
			comma_multi: true,
			space_multi: true,
			spaced_inside: false,
			symlink_escape: true,
		});
	} finally {
		eph.cleanup();
	}
});

test("hermes stripHermesReasoningNoise: drops box header and think tags", () => {
	const noisy =
		"\n┌─ Reasoning ──────────────────────────────────────────────────────────────────┐\nthinking aloud\nCLEAN_OK\n";
	assert.equal(stripHermesReasoningNoise(noisy).trim(), "thinking aloud\nCLEAN_OK");
	assert.equal(stripHermesReasoningNoise("<think>secret</think>\nHI").trim(), "HI");
	assert.equal(
		stripHermesReasoningNoise("⚠️  Primary auth failed — switching to fallback: xai-oauth / grok-4.5\nHI").trim(),
		"HI",
	);
});
