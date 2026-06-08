/**
 * Tests for extensions/init.ts — model-role configuration.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, beforeEach, afterEach } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	INIT_ROLES,
	RECOMMENDED_DEFAULTS,
	getSettingsPath,
	readSettings,
	writeSettings,
	formatModelOption,
	parseModelFromLabel,
	buildRoleOptions,
	parseCustomModel,
	modelExists,
	diffRoles,
	formatRolesReport,
	formatDiffReport,
	formatFlowResult,
	formatTaskflowSettingsReport,
	runInteractiveInit,
} from "../extensions/init.ts";
import { DEFAULT_TASKFLOW_SETTINGS } from "../extensions/agents.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function makeTmpDir(prefix = "init-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a minimal mock Model<Api> for testing. */
function mockModel(
	provider: string,
	id: string,
	name: string,
	opts: { reasoning?: boolean; input?: ("text" | "image")[] } = {},
): Model<Api> {
	return {
		id,
		name,
		provider,
		reasoning: opts.reasoning ?? false,
		input: opts.input ?? ["text"],
		api: "openai-completions" as Api,
		baseUrl: "",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<Api>;
}

/** Build a minimal mock ExtensionUIContext that records calls. */
interface MockUI {
	selectCalls: Array<{ title: string; options: string[] }>;
	inputCalls: Array<{ title: string; placeholder?: string }>;
	notifyCalls: Array<{ message: string; type?: string }>;
	confirmCalls: Array<{ title: string; message: string }>;
	/** Queue of canned responses. Undefined simulates Esc. */
	answers: Array<string | undefined>;
	/** Queue of canned confirm() answers. Defaults to `true` when empty. */
	confirmAnswers: boolean[];
}

function createMockUI(
	answers: Array<string | undefined> = [],
	confirmAnswers: boolean[] = [],
): MockUI & ExtensionUIContext {
	const ui: MockUI = {
		selectCalls: [],
		inputCalls: [],
		notifyCalls: [],
		confirmCalls: [],
		answers: [...answers],
		confirmAnswers: [...confirmAnswers],
	};
	return Object.assign(ui as unknown as ExtensionUIContext, {
		async select(title: string, options: string[], _opts?: unknown) {
			ui.selectCalls.push({ title, options });
			return ui.answers.shift();
		},
		async input(title: string, placeholder?: string, _opts?: unknown) {
			ui.inputCalls.push({ title, placeholder });
			return ui.answers.shift();
		},
		async confirm(title: string, message: string, _opts?: unknown) {
			ui.confirmCalls.push({ title, message });
			const next = ui.confirmAnswers.shift();
			return next === undefined ? true : next;
		},
		notify(message: string, type?: "info" | "warning" | "error") {
			ui.notifyCalls.push({ message, type });
		},
	}) as MockUI & ExtensionUIContext;
}

// ---------------------------------------------------------------------------
// Per-test sandbox
// ---------------------------------------------------------------------------

let tmpRoot: string;
let agentDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
	tmpRoot = makeTmpDir();
	agentDir = path.join(tmpRoot, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	savedEnv = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = agentDir;
});

afterEach(() => {
	if (savedEnv !== undefined) {
		process.env[AGENT_DIR_ENV] = savedEnv;
	} else {
		delete process.env[AGENT_DIR_ENV];
	}
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// INIT_ROLES
// ---------------------------------------------------------------------------

test("INIT_ROLES: every role has non-empty description AND non-empty defaultModel", () => {
	for (const r of INIT_ROLES) {
		assert.ok(r.role.length > 0, `role key is empty for ${JSON.stringify(r)}`);
		assert.ok(r.description.length > 0, `description is empty for ${r.role}`);
		assert.ok(r.defaultModel.length > 0, `defaultModel is empty for ${r.role}`);
	}
});

// ---------------------------------------------------------------------------
// RECOMMENDED_DEFAULTS
// ---------------------------------------------------------------------------

test("RECOMMENDED_DEFAULTS: derived from INIT_ROLES, not stored separately", () => {
	const expected: Record<string, string> = {};
	for (const r of INIT_ROLES) {
		expected[r.role] = r.defaultModel;
	}
	assert.deepEqual(RECOMMENDED_DEFAULTS, expected);
});

// ---------------------------------------------------------------------------
// Taskflow preferences
// ---------------------------------------------------------------------------

test("formatTaskflowSettingsReport: formats default settings", () => {
	const report = formatTaskflowSettingsReport(DEFAULT_TASKFLOW_SETTINGS);
	assert.ok(report.includes("Built-in agents: enabled"));
	assert.ok(report.includes("Sync built-ins to project .pi/agents: disabled"));
});

test("formatTaskflowSettingsReport: formats disabled settings", () => {
	const report = formatTaskflowSettingsReport({
		builtInAgents: false,
		syncBuiltinAgentsToProject: false,
	});
	assert.ok(report.includes("Built-in agents: disabled"));
});

// ---------------------------------------------------------------------------
// formatModelOption
// ---------------------------------------------------------------------------

test("formatModelOption: includes name + provider/id", () => {
	const m = mockModel("openrouter", "deepseek/v4-flash", "DeepSeek V4 Flash");
	const result = formatModelOption(m);
	assert.ok(result.includes("DeepSeek V4 Flash"), "should include name");
	assert.ok(result.includes("openrouter/deepseek/v4-flash"), "should include provider/id");
});

test("parseModelFromLabel: recovers provider/id from a simple label", () => {
	assert.equal(parseModelFromLabel("DeepSeek V4 Flash (openrouter/deepseek/v4-flash) tags"), "openrouter/deepseek/v4-flash");
});

test("parseModelFromLabel: model name with parens does NOT shadow provider/id (F1 regression)", () => {
	const label = formatModelOption(mockModel("openai", "gpt-4o-2024-08-06", "GPT-4o (2024-08-06)"));
	assert.equal(parseModelFromLabel(label), "openai/gpt-4o-2024-08-06");
});

test("parseModelFromLabel: falls back to the raw label with no provider/id group", () => {
	assert.equal(parseModelFromLabel("just-a-bare-string"), "just-a-bare-string");
	assert.equal(parseModelFromLabel("Name (no-slash-here)"), "Name (no-slash-here)");
});

test("formatModelOption: adds reasoning tag when model.reasoning is true", () => {
	const m = mockModel("openrouter", "x/y", "X", { reasoning: true });
	assert.ok(formatModelOption(m).includes("reasoning ✓"));
});

test("formatModelOption: adds image tag when model.input includes 'image'", () => {
	const m = mockModel("openrouter", "x/y", "X", { input: ["text", "image"] });
	assert.ok(formatModelOption(m).includes("image ✓"));
});

test("formatModelOption: omits modality tag for text-only models", () => {
	const m = mockModel("openrouter", "x/y", "X", { input: ["text"] });
	const result = formatModelOption(m);
	assert.ok(!result.includes("image ✓"));
	assert.ok(!result.includes("reasoning ✓"));
});

// ---------------------------------------------------------------------------
// buildRoleOptions
// ---------------------------------------------------------------------------

const sampleModels: Model<Api>[] = [
	mockModel("openrouter", "deepseek/v4-flash", "DeepSeek V4 Flash", { reasoning: false }),
	mockModel("openrouter", "deepseek/v4-pro", "DeepSeek V4 Pro", { reasoning: true }),
	mockModel("openrouter", "anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6", {
		reasoning: true,
		input: ["text", "image"],
	}),
	mockModel("minimax", "MiniMax-M3", "MiniMax M3", { reasoning: true, input: ["text", "image"] }),
	mockModel("openrouter", "openai/gpt-5", "GPT-5", { reasoning: false, input: ["text", "image"] }),
];

test("buildRoleOptions: marks current pick with '(current)'", () => {
	const options = buildRoleOptions(INIT_ROLES[0], sampleModels, {
		current: "openrouter/deepseek/v4-flash",
	});
	assert.ok(options.some((o) => o.includes("(current)")));
});

test("buildRoleOptions: marks recommended pick with '(recommended)'", () => {
	const options = buildRoleOptions(INIT_ROLES[0], sampleModels, {
		recommended: "openrouter/deepseek/v4-flash",
	});
	assert.ok(options.some((o) => o.includes("(recommended)")));
});

test("buildRoleOptions: includes separator, Custom, and Back entries", () => {
	const options = buildRoleOptions(INIT_ROLES[0], sampleModels, {});
	assert.ok(options.includes("───────────────"), "separator");
	assert.ok(options.includes("Custom (type your own)"), "Custom");
	assert.ok(options.includes("Back to action menu"), "Back");
});

test("buildRoleOptions: vision role filters out text-only models", () => {
	const visionRole = INIT_ROLES.find((r) => r.role === "vision")!;
	const options = buildRoleOptions(visionRole, sampleModels, {});
	// DeepSeek V4 Flash and V4 Pro are text-only, should be filtered
	assert.ok(!options.some((o) => o.includes("v4-flash")), "text-only v4-flash filtered");
	assert.ok(!options.some((o) => o.includes("v4-pro")), "text-only v4-pro filtered");
	// Claude Sonnet and MiniMax M3 should be present
	assert.ok(options.some((o) => o.includes("claude-sonnet-4-6")), "image model present");
	assert.ok(options.some((o) => o.includes("MiniMax-M3")), "image model present");
});

test("buildRoleOptions: thinker role sorts reasoning=true models first", () => {
	const thinkerRole = INIT_ROLES.find((r) => r.role === "thinker")!;
	const options = buildRoleOptions(thinkerRole, sampleModels, {});
	// The first real option (before separator) should be a reasoning model
	const firstOption = options[0];
	assert.ok(firstOption.includes("reasoning ✓"), `first option should be reasoning: ${firstOption}`);
});

// ---------------------------------------------------------------------------
// buildRoleOptions (empty state)
// ---------------------------------------------------------------------------

test("buildRoleOptions: ctx.current undefined → no 'Keep current' entry", () => {
	const options = buildRoleOptions(INIT_ROLES[0], sampleModels, {});
	assert.ok(!options.includes("Keep current"), "should not have 'Keep current' when ctx.current is undefined");
});

test("buildRoleOptions: ctx.current set → 'Keep current' entry present", () => {
	const options = buildRoleOptions(INIT_ROLES[0], sampleModels, {
		current: "openrouter/deepseek/v4-flash",
	});
	assert.ok(options.includes("Keep current"), "should have 'Keep current' when ctx.current is set");
});

// ---------------------------------------------------------------------------
// parseCustomModel
// ---------------------------------------------------------------------------

test("parseCustomModel: parses 'openrouter/xiaomi/mimo-v2.5-pro'", () => {
	const result = parseCustomModel("openrouter/xiaomi/mimo-v2.5-pro");
	assert.deepEqual(result, { provider: "openrouter", id: "xiaomi/mimo-v2.5-pro" });
});

test("parseCustomModel: parses 'vercel-ai-gateway/anthropic/claude-sonnet-4-6' (3+ segments)", () => {
	const result = parseCustomModel("vercel-ai-gateway/anthropic/claude-sonnet-4-6");
	assert.deepEqual(result, { provider: "vercel-ai-gateway", id: "anthropic/claude-sonnet-4-6" });
});

test("parseCustomModel: rejects 'no-slash'", () => {
	assert.equal(parseCustomModel("no-slash"), null);
});

test("parseCustomModel: rejects empty string", () => {
	assert.equal(parseCustomModel(""), null);
});

test("parseCustomModel: rejects 'provider/' (empty id)", () => {
	assert.equal(parseCustomModel("provider/"), null);
});

// ---------------------------------------------------------------------------
// modelExists
// ---------------------------------------------------------------------------

test("modelExists: true when provider+id match a registry entry", () => {
	assert.equal(modelExists("openrouter", "deepseek/v4-flash", sampleModels), true);
	assert.equal(modelExists("minimax", "MiniMax-M3", sampleModels), true);
});

test("modelExists: false for unknown id, unknown provider, and example placeholder", () => {
	assert.equal(modelExists("openrouter", "does/not-exist", sampleModels), false);
	assert.equal(modelExists("nope", "deepseek/v4-flash", sampleModels), false);
	// The exact string that polluted real settings.json and broke every flow.
	assert.equal(modelExists("myprovider", "my-custom-model", sampleModels), false);
});

test("modelExists: false against an empty registry", () => {
	assert.equal(modelExists("openrouter", "deepseek/v4-flash", []), false);
});

// ---------------------------------------------------------------------------
// diffRoles
// ---------------------------------------------------------------------------

test("diffRoles: unchanged / changed / new / stale-preserved correctly classified", () => {
	const catalog = [{ role: "a" }, { role: "b" }, { role: "c" }];
	const before = { a: "x", b: "y", stale: "s" };
	const after = { a: "x", b: "z", c: "new" };
	const diffs = diffRoles(before, after, catalog);

	assert.equal(diffs.length, 4); // a, b, c + stale
	const a = diffs.find((d) => d.role === "a")!;
	assert.equal(a.status, "unchanged");
	assert.equal(a.before, "x");
	assert.equal(a.after, "x");

	const b = diffs.find((d) => d.role === "b")!;
	assert.equal(b.status, "changed");
	assert.equal(b.before, "y");
	assert.equal(b.after, "z");

	const c = diffs.find((d) => d.role === "c")!;
	assert.equal(c.status, "new");
	assert.equal(c.after, "new");

	const stale = diffs.find((d) => d.role === "stale")!;
	assert.equal(stale.status, "stale-preserved");
	assert.equal(stale.before, "s");
});

test("diffRoles: diff order matches INIT_ROLES order, with unknown roles appended", () => {
	const catalog = INIT_ROLES;
	const before: Record<string, string> = {};
	const after: Record<string, string> = {};
	for (const r of INIT_ROLES) {
		before[r.role] = r.defaultModel;
		after[r.role] = r.defaultModel;
	}
	before["custom-role"] = "x";
	const diffs = diffRoles(before, after, catalog);
	// All catalog roles first, then stale
	for (let i = 0; i < catalog.length; i++) {
		assert.equal(diffs[i].role, catalog[i].role);
		assert.equal(diffs[i].status, "unchanged");
	}
	assert.equal(diffs[diffs.length - 1].role, "custom-role");
	assert.equal(diffs[diffs.length - 1].status, "stale-preserved");
});

// ---------------------------------------------------------------------------
// readSettings / writeSettings
// ---------------------------------------------------------------------------

test("readSettings: missing file returns {}", () => {
	// Ensure the settings file does not exist in our test dir
	const sp = getSettingsPath();
	if (fs.existsSync(sp)) fs.unlinkSync(sp);
	const result = readSettings();
	assert.deepEqual(result, {});
});

test("readSettings: malformed JSON throws", () => {
	const sp = getSettingsPath();
	fs.writeFileSync(sp, "not json {{{", "utf-8");
	assert.throws(() => readSettings());
});

test("readSettings: modelRoles: [] (array) returns {} for modelRoles", () => {
	const sp = getSettingsPath();
	fs.writeFileSync(
		sp,
		JSON.stringify({ modelRoles: [] }),
		"utf-8",
	);
	const result = readSettings();
	assert.deepEqual(result.modelRoles, {});
});

test("readSettings: modelRoles: '' (string) returns {} for modelRoles", () => {
	const sp = getSettingsPath();
	fs.writeFileSync(
		sp,
		JSON.stringify({ modelRoles: "" }),
		"utf-8",
	);
	const result = readSettings();
	assert.deepEqual(result.modelRoles, {});
});

test("readSettings: modelRoles: null returns {} for modelRoles", () => {
	const sp = getSettingsPath();
	fs.writeFileSync(
		sp,
		JSON.stringify({ modelRoles: null }),
		"utf-8",
	);
	const result = readSettings();
	assert.deepEqual(result.modelRoles, {});
});

test("readSettings: a settings file WITHOUT a modelRoles key leaves it undefined (F5 context)", () => {
	// readSettings only normalizes modelRoles when the key is present, so callers
	// MUST default it (the F5 `?? {}` fix). A foreign settings.json (written by
	// another extension) has no modelRoles at all.
	const sp = getSettingsPath();
	fs.writeFileSync(sp, JSON.stringify({ theme: "dark", someOtherKey: 1 }), "utf-8");
	const result = readSettings();
	assert.equal(result.modelRoles, undefined, "missing key stays undefined");
	const roles = (result.modelRoles ?? {}) as Record<string, string>;
	assert.doesNotThrow(() => Object.keys(roles));
	assert.equal(Object.keys(roles).length, 0);
});

test("readSettings/writeSettings: round-trip preserves non-modelRoles keys", () => {
	const settings = {
		modelRoles: { fast: "a/b" },
		subagents: { agentOverrides: { executor: { model: "x/y" } } },
		enabledModels: ["a/b", "c/d"],
	};
	writeSettings(settings);
	const result = readSettings();
	assert.deepEqual(result.subagents, { agentOverrides: { executor: { model: "x/y" } } });
	assert.deepEqual(result.enabledModels, ["a/b", "c/d"]);
});

test("writeSettings: merge preserves on-disk keys NOT in incoming (the F5 clobber guard)", () => {
	// Simulate reality: a real settings.json with packages, subagents, etc.
	const diskSnapshot = {
		defaultProvider: "anthropic",
		defaultModel: "claude-opus-4-8-thinking-xhigh",
		hideThinkingBlock: true,
		quietStartup: true,
		packages: ["npm:pi-crew", "npm:pi-mcp-adapter"],
		subagents: { agentOverrides: { planner: { model: "gpt-5.5" } } },
		enabledModels: ["deepseek-v4-flash"],
		warnings: { anthropicExtraUsage: false },
	};
	// Pre-populate the disk file with all these keys
	const sp = getSettingsPath();
	fs.writeFileSync(sp, JSON.stringify(diskSnapshot, null, 2), "utf-8");

	// Now simulate what /tf init writes — only modelRoles
	writeSettings({ modelRoles: { fast: "test/fast" } });

	const result = readSettings();
	// modelRoles was set
	assert.deepEqual(result.modelRoles, { fast: "test/fast" });
	// All other keys survived
	assert.equal(result.defaultProvider, "anthropic");
	assert.equal(result.defaultModel, "claude-opus-4-8-thinking-xhigh");
	assert.equal(result.hideThinkingBlock, true);
	assert.equal(result.quietStartup, true);
	assert.deepEqual(result.packages, ["npm:pi-crew", "npm:pi-mcp-adapter"]);
	assert.deepEqual(result.subagents, { agentOverrides: { planner: { model: "gpt-5.5" } } });
	assert.deepEqual(result.enabledModels, ["deepseek-v4-flash"]);
	assert.deepEqual(result.warnings, { anthropicExtraUsage: false });
});

test("writeSettings: creates .bak-tf-* backup for files with > 3 top-level keys", () => {
	const sp = getSettingsPath();
	// Enough keys to trigger backup threshold (> 3)
	fs.writeFileSync(sp, JSON.stringify({
		a: 1, b: 2, c: 3, d: 4,
	}), "utf-8");

	// Clean up any leftover .bak-tf-* files from previous runs
	const dir = path.dirname(sp);
	for (const f of fs.readdirSync(dir)) {
		if (f.startsWith("settings.json.bak-tf-")) fs.unlinkSync(path.join(dir, f));
	}

	writeSettings({ modelRoles: { fast: "test" } });

	// Verify backup was created
	const files = fs.readdirSync(dir);
	const backups = files.filter((f) => f.startsWith("settings.json.bak-tf-"));
	assert.equal(backups.length, 1, `expected 1 backup, got ${backups.length}: ${backups.join(", ")}`);

	// Clean up
	fs.unlinkSync(path.join(dir, backups[0]));
});

test("writeSettings: does NOT create backup for tiny files (≤ 3 keys)", () => {
	const sp = getSettingsPath();
	fs.writeFileSync(sp, JSON.stringify({ a: 1 }), "utf-8");

	const dir = path.dirname(sp);
	// Clean up any leftover .bak-tf-* files
	for (const f of fs.readdirSync(dir)) {
		if (f.startsWith("settings.json.bak-tf-")) fs.unlinkSync(path.join(dir, f));
	}

	writeSettings({ modelRoles: { fast: "test" } });

	const files = fs.readdirSync(dir);
	const backups = files.filter((f) => f.startsWith("settings.json.bak-tf-"));
	assert.equal(backups.length, 0, `expected 0 backups, got ${backups.length}`);
});

test("writeSettings: atomic write uses unique tmp and cleans up", () => {
	// writeSettings should succeed and produce a valid JSON file
	writeSettings({ modelRoles: { fast: "test" } });
	const sp = getSettingsPath();
	const content = JSON.parse(fs.readFileSync(sp, "utf-8"));
	assert.deepEqual(content, { modelRoles: { fast: "test" } });
	// No leftover .tmp files in the directory
	const dir = path.dirname(sp);
	const files = fs.readdirSync(dir);
	const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
	assert.equal(tmpFiles.length, 0, `leftover tmp files: ${tmpFiles.join(", ")}`);
});

// ---------------------------------------------------------------------------
// formatRolesReport
// ---------------------------------------------------------------------------

test("formatRolesReport: empty current shows message about no config", () => {
	const report = formatRolesReport({});
	assert.ok(report.includes("No modelRoles configured"));
});

test("formatRolesReport: populated current shows all roles", () => {
	const current: Record<string, string> = {};
	for (const r of INIT_ROLES) current[r.role] = r.defaultModel;
	const report = formatRolesReport(current);
	for (const r of INIT_ROLES) {
		assert.ok(report.includes(r.role), `missing role ${r.role}`);
		assert.ok(report.includes(r.defaultModel), `missing model for ${r.role}`);
	}
});

// ---------------------------------------------------------------------------
// formatDiffReport
// ---------------------------------------------------------------------------

test("formatDiffReport: shows all diff statuses", () => {
	const before: Record<string, string> = { fast: "a/b", stale: "x/y" };
	const after: Record<string, string> = { fast: "a/b", strong: "new/model" };
	// Fill other roles with same value
	for (const r of INIT_ROLES) {
		if (r.role !== "fast" && r.role !== "strong") {
			before[r.role] = r.defaultModel;
			after[r.role] = r.defaultModel;
		}
	}
	const report = formatDiffReport(before, after);
	assert.ok(report.includes("unchanged"), "should show unchanged");
	assert.ok(report.includes("new"), "should show new");
	assert.ok(report.includes("stale"), "should show stale-preserved");
});

// ---------------------------------------------------------------------------
// runInteractiveInit (mocked UI)
// ---------------------------------------------------------------------------

test("runInteractiveInit: empty currentRoles → 3-option action menu", async () => {
	const ui = createMockUI(["Configure each role", ...INIT_ROLES.map(() => "Keep current"), "Save these changes"]);
	const modelList = sampleModels;
	await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList,
		currentRoles: {},
	});
	// First select call should be the action menu
	const firstSelect = ui.selectCalls[0];
	assert.ok(firstSelect.title.includes("What do you want to do"));
	// Should have 3 options (recommended defaults, configure each role, taskflow preferences)
	assert.equal(firstSelect.options.length, 3);
	assert.ok(firstSelect.options.includes("Use recommended defaults"));
	assert.ok(firstSelect.options.includes("Configure each role"));
	assert.ok(firstSelect.options.includes("Configure taskflow preferences"));
});

test("runInteractiveInit: 'Use recommended defaults' → saves RECOMMENDED_DEFAULTS", async () => {
	const ui = createMockUI(["Use recommended defaults"]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: {},
	});
	assert.equal(result.kind, "saved");
	if (result.kind === "saved") {
		assert.deepEqual(result.chosen, RECOMMENDED_DEFAULTS);
		assert.ok(result.savedPath.length > 0);
	}
});

test("runInteractiveInit: 'Configure each role' with all 'Keep current' → no-change", async () => {
	const current: Record<string, string> = {};
	for (const r of INIT_ROLES) current[r.role] = r.defaultModel;
	// All picks are "Keep current", then preview should not appear
	const ui = createMockUI(["Configure each role", ...INIT_ROLES.map(() => "Keep current")]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: current,
	});
	assert.equal(result.kind, "no-change");
	if (result.kind === "no-change") {
		assert.deepEqual(result.chosen, current);
	}
	// No preview dialog should have appeared (short-circuit)
	assert.ok(!ui.selectCalls.some((c) => c.title.includes("Review changes")));
});

test("runInteractiveInit: 'Cancel' on action menu → cancelled", async () => {
	const ui = createMockUI(["Cancel"]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: { fast: "a/b" },
	});
	assert.equal(result.kind, "cancelled");
});

test("runInteractiveInit: Esc on action menu (undefined return) → cancelled", async () => {
	const ui = createMockUI([undefined as unknown as string]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: { fast: "a/b" },
	});
	assert.equal(result.kind, "cancelled");
});

test("runInteractiveInit: custom model not in registry → confirm yes → saves", async () => {
	const current: Record<string, string> = {};
	for (const r of INIT_ROLES) current[r.role] = r.defaultModel;
	// Select "Edit one role", pick the first role, choose Custom, type a custom
	// model, then save. The custom model is NOT in the registry, so a confirm
	// dialog appears; answer yes (default).
	const ui = createMockUI(
		[
			"Edit one role",
			INIT_ROLES[0].role + " — " + INIT_ROLES[0].description,
			"Custom (type your own)",
			"myprovider/my-custom-model",
			"Save these changes",
		],
		[true],
	);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: current,
	});
	assert.equal(ui.confirmCalls.length, 1, "should warn via confirm for unknown model");
	assert.equal(result.kind, "saved");
	if (result.kind === "saved") {
		assert.equal(result.chosen[INIT_ROLES[0].role], "myprovider/my-custom-model");
	}
});

test("runInteractiveInit: custom model not in registry → confirm no → keeps current, no-change", async () => {
	const current: Record<string, string> = {};
	for (const r of INIT_ROLES) current[r.role] = r.defaultModel;
	const ui = createMockUI(
		[
			"Edit one role",
			INIT_ROLES[0].role + " — " + INIT_ROLES[0].description,
			"Custom (type your own)",
			"myprovider/my-custom-model",
			"Save these changes",
		],
		[false],
	);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: current,
	});
	assert.equal(ui.confirmCalls.length, 1, "should warn via confirm for unknown model");
	// Declining the unknown model falls back to the current value → no change.
	assert.equal(result.kind, "no-change");
});

test("runInteractiveInit: hasUI=false → throws", async () => {
	await assert.rejects(
		() =>
			runInteractiveInit({
				hasUI: false,
				signal: new AbortController().signal,
				ui: createMockUI([]),
				modelRegistry: undefined as never,
				modelList: sampleModels,
				currentRoles: {},
			}),
		/hasUI/,
	);
});

test("runInteractiveInit: Esc on custom input → falls back to current, not cancelled", async () => {
	const current: Record<string, string> = {};
	for (const r of INIT_ROLES) current[r.role] = r.defaultModel;
	// Action menu: Configure each role.
	// Role 1 picker: "Custom (type your own)" → custom input: undefined (Esc) → falls back to current[role1].
	// Roles 2..N picker: "Keep current".
	// Expected: result is saved OR no-change (never cancelled), and chosen equals current.
	// The flow short-circuits to no-change when picks match current exactly.
	const ui = createMockUI([
		"Configure each role",
		"Custom (type your own)",  // role 1 picker
		undefined,                  // custom input Esc
		...INIT_ROLES.slice(1).map(() => "Keep current"),  // roles 2..N
	]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: current,
	});
	// The key invariant: Esc on custom input does NOT cancel the whole flow.
	// (If Esc on custom input were conflated with action-menu Esc, this would be 'cancelled'.)
	assert.notEqual(result.kind, "cancelled");
	// All roles fell back to their current values.
	const chosen = result.kind === "saved" ? result.chosen : result.kind === "no-change" ? result.chosen : {};
	assert.deepEqual(chosen, current);
});

test("runInteractiveInit: 'Use recommended defaults' with stale keys → preserves stale keys", async () => {
	const current: Record<string, string> = {
		fast: "openrouter/anthropic/claude-sonnet-4-6",
		"old-role-1": "openrouter/x/y", // stale (not in INIT_ROLES)
	};
	const ui = createMockUI(["Use recommended defaults"]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: current,
	});
	assert.equal(result.kind, "saved");
	if (result.kind === "saved") {
		// Stale key preserved
		assert.equal(result.chosen["old-role-1"], "openrouter/x/y");
		// Existing role overridden by recommended default
		assert.equal(result.chosen.fast, RECOMMENDED_DEFAULTS.fast);
	}
});

test("runInteractiveInit: 'Show current roles' → notifies and returns cancelled", async () => {
	const current: Record<string, string> = { fast: "openrouter/x/y" };
	const ui = createMockUI(["Show current roles"]);
	const result = await runInteractiveInit({
		hasUI: true,
		signal: new AbortController().signal,
		ui,
		modelRegistry: undefined as never,
		modelList: sampleModels,
		currentRoles: current,
	});
	assert.equal(result.kind, "cancelled");
	assert.equal(ui.notifyCalls.length, 1);
	assert.equal(ui.notifyCalls[0].type, "info");
	assert.match(ui.notifyCalls[0].message, /fast/);
});

test("getSettingsPath: returns a path ending in settings.json", () => {
	const p = getSettingsPath();
	assert.match(p, /settings\.json$/);
});

test("formatFlowResult: cancelled returns a cancellation message", () => {
	const result: { kind: "cancelled" } = { kind: "cancelled" };
	const text = formatFlowResult(result);
	assert.match(text, /cancel/i);
});

test("formatFlowResult: no-change shows the unchanged roles", () => {
	const chosen: Record<string, string> = { fast: "openrouter/x/y" };
	const result: { kind: "no-change"; chosen: Record<string, string> } = {
		kind: "no-change",
		chosen,
	};
	const text = formatFlowResult(result);
	assert.match(text, /no change|unchanged/i);
	assert.match(text, /fast/);
});

test("formatFlowResult: saved includes the path", () => {
	const result = {
		kind: "saved" as const,
		chosen: { fast: "openrouter/x/y" },
		savedPath: "/tmp/settings.json",
	};
	const text = formatFlowResult(result);
	assert.match(text, /saved/i);
	assert.match(text, /\/tmp\/settings\.json/);
});
