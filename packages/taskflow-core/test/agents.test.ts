import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, beforeEach, afterEach } from "node:test";
import {
	DEFAULT_TASKFLOW_SETTINGS,
	discoverAgents,
	normalizePiChildSettings,
	normalizeTaskflowSettings,
	readSubagentSettings,
	shouldLoadBuiltinAgents,
	shouldSyncBuiltinAgentsToProject,
} from "../src/agents.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The env var that controls `getAgentDir()` inside @earendil-works/pi-coding-agent. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const BUILTIN_DIR_ENV = "PI_TASKFLOW_BUILTIN_AGENTS_DIR";

/** Create a temp directory rooted in os.tmpdir(). */
function makeTmpDir(prefix = "agents-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write an agent .md file with YAML frontmatter + body (systemPrompt). */
function writeAgent(
	dir: string,
	filename: string,
	fields: { name?: string; description?: string; model?: string; thinking?: string; tools?: string },
	body = "",
): string {
	fs.mkdirSync(dir, { recursive: true });
	const lines: string[] = ["---"];
	for (const [k, v] of Object.entries(fields)) {
		if (v !== undefined) {
			// Quote values containing {{ to prevent YAML flow-mapping interpretation
			const val = v.includes("{{") ? `"${v}"` : v;
			lines.push(`${k}: ${val}`);
		}
	}
	lines.push("---");
	if (body) lines.push(body);
	const filePath = path.join(dir, filename);
	fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
	return filePath;
}

// ---------------------------------------------------------------------------
// Per-test sandbox
// ---------------------------------------------------------------------------

let savedAgentDir: string | undefined;
let savedBuiltinDir: string | undefined;
let tmpRoot: string;
/** Simulated ~/.pi/agent directory */
let userAgentDir: string;
/** Simulated project cwd */
let projectCwd: string;

beforeEach(() => {
	savedAgentDir = process.env[AGENT_DIR_ENV];
	savedBuiltinDir = process.env[BUILTIN_DIR_ENV];
	tmpRoot = makeTmpDir();
	userAgentDir = path.join(tmpRoot, "user-agent");
	projectCwd = path.join(tmpRoot, "project");
	fs.mkdirSync(userAgentDir, { recursive: true });
	fs.mkdirSync(projectCwd, { recursive: true });
	process.env[AGENT_DIR_ENV] = userAgentDir;
});

afterEach(() => {
	if (savedAgentDir === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = savedAgentDir;
	}
	if (savedBuiltinDir === undefined) {
		delete process.env[BUILTIN_DIR_ENV];
	} else {
		process.env[BUILTIN_DIR_ENV] = savedBuiltinDir;
	}
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ===========================================================================
// Built-in agent project sync opt-in
// ===========================================================================

test("normalizeTaskflowSettings: defaults to built-ins enabled and project sync disabled", () => {
	assert.deepEqual(normalizeTaskflowSettings(undefined), DEFAULT_TASKFLOW_SETTINGS);
	assert.deepEqual(normalizeTaskflowSettings({}), DEFAULT_TASKFLOW_SETTINGS);
});

test("normalizeTaskflowSettings: accepts only boolean preference values", () => {
	assert.deepEqual(normalizeTaskflowSettings({ builtInAgents: false, syncBuiltinAgentsToProject: true }), {
		builtInAgents: false,
		syncBuiltinAgentsToProject: true,
		maxKeptRuns: DEFAULT_TASKFLOW_SETTINGS.maxKeptRuns,
		maxRunAgeDays: DEFAULT_TASKFLOW_SETTINGS.maxRunAgeDays,
		library: { enabled: true, scope: "both" },
		piChild: { resourceProfile: "isolated", extensions: [], terminalGraceMs: 1500 },
	});
	assert.deepEqual(normalizeTaskflowSettings({ builtInAgents: "false", syncBuiltinAgentsToProject: "true" }), DEFAULT_TASKFLOW_SETTINGS);
});

test("normalizePiChildSettings: profiles are host-only, bounded, and copied", () => {
	assert.deepEqual(normalizePiChildSettings(undefined), {
		resourceProfile: "isolated",
		extensions: [],
		terminalGraceMs: 1500,
	});
	assert.deepEqual(normalizePiChildSettings({
		resourceProfile: "allowlist",
		extensions: ["/trusted/a.ts", 1, "/trusted/b.ts"],
		terminalGraceMs: 2500,
	}), {
		resourceProfile: "allowlist",
		extensions: ["/trusted/a.ts", "/trusted/b.ts"],
		terminalGraceMs: 2500,
	});
	assert.deepEqual(normalizePiChildSettings({ resourceProfile: "flow-controlled", terminalGraceMs: -1 }), {
		resourceProfile: "isolated",
		extensions: [],
		terminalGraceMs: 1500,
	});
});

test("shouldLoadBuiltinAgents: follows taskflow builtInAgents setting", () => {
	assert.equal(shouldLoadBuiltinAgents(DEFAULT_TASKFLOW_SETTINGS), true);
	assert.equal(shouldLoadBuiltinAgents({ ...DEFAULT_TASKFLOW_SETTINGS, builtInAgents: false }), false);
});

test("shouldSyncBuiltinAgentsToProject: disabled by default and requires built-ins to be enabled", () => {
	assert.equal(shouldSyncBuiltinAgentsToProject(DEFAULT_TASKFLOW_SETTINGS), false);
	assert.equal(shouldSyncBuiltinAgentsToProject({ ...DEFAULT_TASKFLOW_SETTINGS, builtInAgents: true, syncBuiltinAgentsToProject: true }), true);
	assert.equal(shouldSyncBuiltinAgentsToProject({ ...DEFAULT_TASKFLOW_SETTINGS, builtInAgents: false, syncBuiltinAgentsToProject: true }), false);
});

// ===========================================================================
// discoverAgents — basic discovery
// ===========================================================================

test("discoverAgents: discovers user agents from <agentDir>/agents/", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "scout.md", { name: "scout", description: "finds things" }, "You are scout.");

	const { agents, projectAgentsDir } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, "scout");
	assert.equal(agents[0].description, "finds things");
	assert.equal(agents[0].systemPrompt, "You are scout.");
	assert.equal(agents[0].source, "user");
	assert.equal(projectAgentsDir, null);
});

test("discoverAgents: discovers project agents from <cwd>/.pi/agents/", () => {
	const projAgentsDir = path.join(projectCwd, ".pi", "agents");
	writeAgent(projAgentsDir, "auditor.md", { name: "auditor", description: "audits code" }, "Audit it.");

	const { agents, projectAgentsDir } = discoverAgents(projectCwd, "project");
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, "auditor");
	assert.equal(agents[0].source, "project");
	assert.equal(projectAgentsDir, projAgentsDir);
});

test("discoverAgents: returns empty agents when no agent dirs exist", () => {
	const { agents } = discoverAgents(projectCwd, "both");
	assert.equal(agents.length, 0);
});

test("discoverAgents: loads built-in agents by default", () => {
	const builtInDir = path.join(tmpRoot, "built-ins");
	writeAgent(builtInDir, "builtin.md", { name: "builtin", description: "package agent" }, "Built in.");
	process.env[BUILTIN_DIR_ENV] = builtInDir;

	const { agents } = discoverAgents(projectCwd, "both");
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, "builtin");
	assert.equal(agents[0].source, "built-in");
});

test("discoverAgents: skips built-in agents when taskflow.builtInAgents is false", () => {
	const builtInDir = path.join(tmpRoot, "built-ins");
	writeAgent(builtInDir, "builtin.md", { name: "builtin", description: "package agent" }, "Built in.");
	process.env[BUILTIN_DIR_ENV] = builtInDir;

	const { agents } = discoverAgents(projectCwd, "both", undefined, {
		...DEFAULT_TASKFLOW_SETTINGS,
		builtInAgents: false,
	});
	assert.deepEqual(agents.map((a) => a.name), []);
});

// ===========================================================================
// discoverAgents — scope filtering
// ===========================================================================

test("discoverAgents: scope=user ignores project agents", () => {
	writeAgent(path.join(userAgentDir, "agents"), "u.md", { name: "u", description: "user" });
	writeAgent(path.join(projectCwd, ".pi", "agents"), "p.md", { name: "p", description: "proj" });

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, "u");
});

test("discoverAgents: scope=project ignores user agents", () => {
	writeAgent(path.join(userAgentDir, "agents"), "u.md", { name: "u", description: "user" });
	writeAgent(path.join(projectCwd, ".pi", "agents"), "p.md", { name: "p", description: "proj" });

	const { agents } = discoverAgents(projectCwd, "project");
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, "p");
});

test("discoverAgents: scope=both merges user and project agents", () => {
	writeAgent(path.join(userAgentDir, "agents"), "u.md", { name: "u", description: "user" });
	writeAgent(path.join(projectCwd, ".pi", "agents"), "p.md", { name: "p", description: "proj" });

	const { agents } = discoverAgents(projectCwd, "both");
	assert.equal(agents.length, 2);
	const names = agents.map((a) => a.name).sort();
	assert.deepEqual(names, ["p", "u"]);
});

test("discoverAgents: scope=both — project agent overrides user agent on name collision", () => {
	writeAgent(path.join(userAgentDir, "agents"), "scout.md", { name: "scout", description: "user scout" }, "user body");
	writeAgent(path.join(projectCwd, ".pi", "agents"), "scout.md", { name: "scout", description: "proj scout" }, "proj body");

	const { agents } = discoverAgents(projectCwd, "both");
	assert.equal(agents.length, 1);
	assert.equal(agents[0].description, "proj scout");
	assert.equal(agents[0].systemPrompt, "proj body");
	assert.equal(agents[0].source, "project");
});

// ===========================================================================
// discoverAgents — frontmatter parsing
// ===========================================================================

test("discoverAgents: skips files missing required name frontmatter", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	// Missing name
	writeAgent(agentsDir, "no-name.md", { description: "has desc" });

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 0);
});

test("discoverAgents: skips files missing required description frontmatter", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	// Missing description
	writeAgent(agentsDir, "no-desc.md", { name: "nodesc" });

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 0);
});

test("discoverAgents: parses tools from comma-separated frontmatter", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "tooled.md", { name: "tooled", description: "has tools", tools: "read, write, bash" });

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 1);
	assert.deepEqual(agents[0].tools, ["read", "write", "bash"]);
});

test("discoverAgents: tools is undefined when no tools frontmatter", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "no-tools.md", { name: "bare", description: "minimal" });

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents[0].tools, undefined);
});

test("discoverAgents: parses model and thinking from frontmatter", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "full.md", {
		name: "full",
		description: "fully specced",
		model: "claude-sonnet-4-20250514",
		thinking: "high",
	});

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents[0].model, "claude-sonnet-4-20250514");
	assert.equal(agents[0].thinking, "high");
});

test("discoverAgents: skips non-.md files", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "agent.txt"), "---\nname: txt\ndescription: nope\n---\nbody");
	fs.writeFileSync(path.join(agentsDir, "agent.json"), '{"name":"json"}');

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 0);
});

test("discoverAgents: skips directories inside agents dir", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	fs.mkdirSync(path.join(agentsDir, "subdir.md"), { recursive: true }); // dir named like .md

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 0);
});

test("discoverAgents: handles empty frontmatter body (systemPrompt is empty)", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "empty-body.md", { name: "empty", description: "no body" });

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents[0].systemPrompt, "");
});

test("discoverAgents: multiple agents discovered and ordered by directory listing", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "alpha.md", { name: "alpha", description: "first" });
	writeAgent(agentsDir, "beta.md", { name: "beta", description: "second" });
	writeAgent(agentsDir, "gamma.md", { name: "gamma", description: "third" });

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 3);
	const names = agents.map((a) => a.name);
	// fs.readdirSync order is alphabetical on most platforms
	assert.deepEqual(names, ["alpha", "beta", "gamma"]);
});

// ===========================================================================
// discoverAgents — findNearestProjectAgentsDir (tested indirectly)
// ===========================================================================

test("discoverAgents: finds .pi/agents in parent directory", () => {
	// Create .pi/agents two levels up
	const parentDir = path.join(tmpRoot, "workspace");
	const childDir = path.join(parentDir, "packages", "app");
	fs.mkdirSync(childDir, { recursive: true });
	writeAgent(path.join(parentDir, ".pi", "agents"), "deep.md", { name: "deep", description: "found deep" });

	const { agents, projectAgentsDir } = discoverAgents(childDir, "project");
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, "deep");
	assert.equal(projectAgentsDir, path.join(parentDir, ".pi", "agents"));
});

test("discoverAgents: prefers closest .pi/agents when multiple exist", () => {
	const grandparent = path.join(tmpRoot, "gp");
	const parent = path.join(grandparent, "parent");
	const child = path.join(parent, "child");
	fs.mkdirSync(child, { recursive: true });

	writeAgent(path.join(grandparent, ".pi", "agents"), "gp.md", { name: "gp-agent", description: "from grandparent" });
	writeAgent(path.join(parent, ".pi", "agents"), "parent.md", { name: "parent-agent", description: "from parent" });

	const { agents, projectAgentsDir } = discoverAgents(child, "project");
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, "parent-agent");
	assert.equal(projectAgentsDir, path.join(parent, ".pi", "agents"));
});

test("discoverAgents: returns null projectAgentsDir when no .pi/agents found", () => {
	const isolated = path.join(tmpRoot, "isolated");
	fs.mkdirSync(isolated, { recursive: true });

	const { agents, projectAgentsDir } = discoverAgents(isolated, "project");
	assert.equal(agents.length, 0);
	assert.equal(projectAgentsDir, null);
});

// ===========================================================================
// discoverAgents — edge cases
// ===========================================================================

test("discoverAgents: handles unreadable agent file gracefully", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "good.md", { name: "good", description: "readable" });
	const badPath = path.join(agentsDir, "bad.md");
	fs.writeFileSync(badPath, "---\nname: bad\ndescription: bad\n---\nbody");
	fs.chmodSync(badPath, 0o000);

	const { agents } = discoverAgents(projectCwd, "user");
	// On systems that enforce file permissions (non-root), bad.md is skipped
	// On root or permissive systems, both may be loaded
	assert.ok(agents.length >= 1);
	assert.ok(agents.some((a) => a.name === "good"));

	// Restore permissions for cleanup
	fs.chmodSync(badPath, 0o644);
});

test("discoverAgents: agent filePath is absolute and correct", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	const expectedPath = writeAgent(agentsDir, "pathcheck.md", { name: "pathcheck", description: "check" });

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents[0].filePath, expectedPath);
	assert.ok(path.isAbsolute(agents[0].filePath));
});

test("discoverAgents: tools with extra whitespace are trimmed", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "spaces.md", { name: "spaces", description: "spaced tools", tools: " read , write ,  bash  " });

	const { agents } = discoverAgents(projectCwd, "user");
	assert.deepEqual(agents[0].tools, ["read", "write", "bash"]);
});

test("discoverAgents: empty tools string results in undefined tools", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	// Write raw frontmatter with quoted YAML to avoid parse error on bare commas
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "empty-tools.md"),
		'---\nname: empty-tools\ndescription: no real tools\ntools: " , , "\n---\n',
	);

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents[0].tools, undefined);
});

// ===========================================================================
// readSubagentSettings
// ===========================================================================

test("readSubagentSettings: returns defaults when settings.json missing", () => {
	const settings = readSubagentSettings();
	assert.deepEqual(settings, { taskflow: DEFAULT_TASKFLOW_SETTINGS });
});


test("readSubagentSettings: parses globalThinking from subagents.globalThinking", () => {
	const settingsPath = path.join(userAgentDir, "settings.json");
	fs.writeFileSync(
		settingsPath,
		JSON.stringify({
			subagents: { globalThinking: "high" },
		}),
	);

	const settings = readSubagentSettings();
	assert.equal(settings.globalThinking, "high");
});

test("readSubagentSettings: falls back to defaultThinkingLevel when subagents.globalThinking is absent", () => {
	const settingsPath = path.join(userAgentDir, "settings.json");
	fs.writeFileSync(
		settingsPath,
		JSON.stringify({
			defaultThinkingLevel: "medium",
			subagents: {},
		}),
	);

	const settings = readSubagentSettings();
	assert.equal(settings.globalThinking, "medium");
});

test("readSubagentSettings: subagents.globalThinking takes precedence over defaultThinkingLevel", () => {
	const settingsPath = path.join(userAgentDir, "settings.json");
	fs.writeFileSync(
		settingsPath,
		JSON.stringify({
			defaultThinkingLevel: "low",
			subagents: { globalThinking: "high" },
		}),
	);

	const settings = readSubagentSettings();
	assert.equal(settings.globalThinking, "high");
});

test("readSubagentSettings: returns defaults for malformed JSON", () => {
	const settingsPath = path.join(userAgentDir, "settings.json");
	fs.writeFileSync(settingsPath, "NOT VALID JSON {{{");

	const settings = readSubagentSettings();
	assert.deepEqual(settings, { taskflow: DEFAULT_TASKFLOW_SETTINGS });
});

test("readSubagentSettings: returns empty globalThinking when subagents key is missing", () => {
	const settingsPath = path.join(userAgentDir, "settings.json");
	fs.writeFileSync(settingsPath, JSON.stringify({ someOtherKey: true }));

	const settings = readSubagentSettings();
	assert.equal(settings.globalThinking, undefined);
});

test("readSubagentSettings: returns empty globalThinking when subagents is null", () => {
	const settingsPath = path.join(userAgentDir, "settings.json");
	fs.writeFileSync(settingsPath, JSON.stringify({ subagents: null }));

	const settings = readSubagentSettings();
	assert.equal(settings.globalThinking, undefined);
});

test("readSubagentSettings: parses taskflow preferences from settings.json", () => {
	const settingsPath = path.join(userAgentDir, "settings.json");
	fs.writeFileSync(
		settingsPath,
		JSON.stringify({ taskflow: { builtInAgents: false, syncBuiltinAgentsToProject: false, maxKeptRuns: 100, maxRunAgeDays: 30 } }),
	);

	const settings = readSubagentSettings();
	assert.deepEqual(settings.taskflow, {
		builtInAgents: false,
		syncBuiltinAgentsToProject: false,
		maxKeptRuns: 100,
		maxRunAgeDays: 30,
		library: { enabled: true, scope: "both" },
		piChild: { resourceProfile: "isolated", extensions: [], terminalGraceMs: 1500 },
	});
});

test("readSubagentSettings: malformed taskflow preferences fall back to defaults", () => {
	const settingsPath = path.join(userAgentDir, "settings.json");
	fs.writeFileSync(
		settingsPath,
		JSON.stringify({ taskflow: { builtInAgents: "false", syncBuiltinAgentsToProject: "true" } }),
	);

	const settings = readSubagentSettings();
	assert.deepEqual(settings.taskflow, DEFAULT_TASKFLOW_SETTINGS);
});

// ===========================================================================
// Integration: discoverAgents + readSubagentSettings
// ===========================================================================

test("integration: readSubagentSettings modelRoles flow into discoverAgents", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "scout.md", { name: "scout", description: "scout agent", model: "{{fast}}" });

	const settingsPath = path.join(userAgentDir, "settings.json");
	fs.writeFileSync(
		settingsPath,
		JSON.stringify({
			modelRoles: { fast: "openrouter/deepseek/deepseek-v4-flash" },
		}),
	);

	const settings = readSubagentSettings();
	const { agents } = discoverAgents(projectCwd, "user", settings.modelRoles);

	assert.equal(agents[0].model, "openrouter/deepseek/deepseek-v4-flash");
});

// ===========================================================================
// discoverAgents — symlink support
// ===========================================================================

test("discoverAgents: follows symlinked .md files", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	const realDir = path.join(tmpRoot, "real-agents");
	writeAgent(realDir, "linked.md", { name: "linked", description: "via symlink" }, "linked body");

	fs.mkdirSync(agentsDir, { recursive: true });
	fs.symlinkSync(path.join(realDir, "linked.md"), path.join(agentsDir, "linked.md"));

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 1);
	assert.equal(agents[0].name, "linked");
	assert.equal(agents[0].systemPrompt, "linked body");
});

// ===========================================================================
// F-001 regression: YAML array frontmatter.tools must not crash discovery
// ===========================================================================

/** Write a raw .md file (needed when we need YAML that the typed helper can't express). */
function writeRawAgent(dir: string, filename: string, frontmatterYaml: string, body = ""): string {
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, filename);
	const content = `---\n${frontmatterYaml}\n---\n${body}`;
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

test("F-001: tools: [read, write] YAML array is parsed (no TypeError on .split)", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeRawAgent(agentsDir, "array-tools.md", "name: array-tools\ndescription: yaml array\ntools:\n  - read\n  - write\n  - bash\n");

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 1);
	assert.deepEqual(agents[0].tools, ["read", "write", "bash"]);
});

test("F-001: inline-flow YAML sequence [read, write] is parsed", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeRawAgent(agentsDir, "inline-array.md", 'name: inline-array\ndescription: inline yaml\ntools: [read, write]\n');

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 1);
	assert.deepEqual(agents[0].tools, ["read", "write"]);
});

test("F-001: tools YAML array with extra whitespace per item is trimmed", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeRawAgent(agentsDir, "padded-array.md", 'name: padded\ndescription: padded array\ntools: [" read ", "  write  "]\n');

	const { agents } = discoverAgents(projectCwd, "user");
	assert.deepEqual(agents[0].tools, ["read", "write"]);
});

test("F-001: empty YAML array tools becomes undefined tools", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeRawAgent(agentsDir, "empty-array.md", "name: empty-array\ndescription: empty array\ntools: []\n");

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 1);
	assert.equal(agents[0].tools, undefined);
});

test("F-001: array tools coexists with sibling agents using string tools", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	// Mix of array and string tools in the same dir
	writeAgent(agentsDir, "csv.md", { name: "csv", description: "csv tools", tools: "read, write" });
	writeRawAgent(agentsDir, "arr.md", "name: arr\ndescription: array tools\ntools:\n  - bash\n  - edit\n");

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents.length, 2);
	const byName = new Map(agents.map((a) => [a.name, a]));
	assert.deepEqual(byName.get("csv")?.tools, ["read", "write"]);
	assert.deepEqual(byName.get("arr")?.tools, ["bash", "edit"]);
});

test("F-001: defense-in-depth — exotic frontmatter shapes do not abort discovery", () => {
	// tools as a YAML number — pre-fix would have crashed on .split.
	// Post-fix: parsed as a single-element array via String(t), or coerced to string and split.
	const agentsDir = path.join(userAgentDir, "agents");
	writeRawAgent(agentsDir, "num-tools.md", "name: num\ndescription: numeric\ntools: 42\n");
	writeAgent(agentsDir, "ok.md", { name: "ok", description: "fine" });

	const { agents } = discoverAgents(projectCwd, "user");
	// Both files must load — the bad one must not poison the whole loop.
	assert.equal(agents.length, 2);
	const names = agents.map((a) => a.name).sort();
	assert.deepEqual(names, ["num", "ok"]);
});

test("modelRoles: resolves {{role}} references from settings", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "fast.md", { name: "fast-agent", description: "fast", model: "{{fast}}" });
	writeAgent(agentsDir, "strong.md", { name: "strong-agent", description: "strong", model: "{{strong}}" });
	writeAgent(agentsDir, "literal.md", { name: "literal-agent", description: "literal", model: "openai/gpt-4o" });
	writeAgent(agentsDir, "nomodel.md", { name: "nomodel-agent", description: "no model" });

	const roles = { fast: "openrouter/deepseek/v4-flash", strong: "anthropic/claude-sonnet-4-20250514" };
	const { agents } = discoverAgents(projectCwd, "user", roles);

	const byName = Object.fromEntries(agents.map(a => [a.name, a.model]));
	assert.equal(byName["fast-agent"], "openrouter/deepseek/v4-flash");
	assert.equal(byName["strong-agent"], "anthropic/claude-sonnet-4-20250514");
	assert.equal(byName["literal-agent"], "openai/gpt-4o");
	assert.equal(byName["nomodel-agent"], undefined);
});

test("modelRoles: unmapped role resolves to undefined", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "unknown.md", { name: "unk", description: "unknown", model: "{{nonexistent}}" });

	const { agents } = discoverAgents(projectCwd, "user", { fast: "openrouter/deepseek/v4-flash" });
	assert.equal(agents[0].model, undefined);
});

test("modelRoles: no roles configured leaves {{role}} as-is", () => {
	const agentsDir = path.join(userAgentDir, "agents");
	writeAgent(agentsDir, "role.md", { name: "role-agent", description: "role", model: "{{fast}}" });

	const { agents } = discoverAgents(projectCwd, "user");
	assert.equal(agents[0].model, "{{fast}}");
});

test("readSubagentSettings: reads modelRoles from settings.json", () => {
	const agentDir = path.join(userAgentDir);
	const settingsPath = path.join(agentDir, "settings.json");
	fs.writeFileSync(settingsPath, JSON.stringify({
		modelRoles: { fast: "openai/gpt-4o-mini", strong: "anthropic/claude-sonnet-4-20250514" },
	}), "utf-8");

	const settings = readSubagentSettings();
	assert.deepEqual(settings.modelRoles, { fast: "openai/gpt-4o-mini", strong: "anthropic/claude-sonnet-4-20250514" });
});
