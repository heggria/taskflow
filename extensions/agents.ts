/**
 * Agent discovery and configuration.
 * Adapted from the pi subagent extension so taskflow shares the same agent
 * pool (~/.pi/agent/agents/*.md, .pi/agents/*.md) and settings overrides.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentOverride {
	model?: string;
	thinking?: string;
	tools?: string[];
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "user" | "project" | "built-in";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project" | "built-in"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		try {
			if (!entry.name.endsWith(".md")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;

			const filePath = path.join(dir, entry.name);
			let content: string;
			try {
				content = fs.readFileSync(filePath, "utf-8");
			} catch {
				continue;
			}

			const { frontmatter, body } = (() => {
				try {
					return parseFrontmatter<Record<string, unknown>>(content);
				} catch {
					// A single malformed agent file must not break discovery for every flow.
					return { frontmatter: {} as Record<string, unknown>, body: "" };
				}
			})();
			if (!frontmatter.name || !frontmatter.description) continue;

			// frontmatter is YAML-parsed: tools may be a comma-separated string ("a, b")
			// OR a YAML sequence ([a, b]). Handle both forms.
			const rawTools = frontmatter.tools;
			const tools: string[] | undefined = Array.isArray(rawTools)
				? rawTools.map((t) => String(t).trim()).filter(Boolean)
				: rawTools !== undefined && rawTools !== null
					? String(rawTools)
							.split(",")
							.map((t) => t.trim())
							.filter(Boolean)
					: undefined;

			agents.push({
				name: String(frontmatter.name),
				description: String(frontmatter.description),
				tools: tools && tools.length > 0 ? tools : undefined,
				model: frontmatter.model === undefined ? undefined : String(frontmatter.model),
				thinking: frontmatter.thinking === undefined ? undefined : String(frontmatter.thinking),
				systemPrompt: body,
				source,
				filePath,
			});
		} catch {
			// Defense-in-depth: a single bad agent file must not break discovery
			// for the entire flow (e.g. exotic YAML shapes, runtime errors in
			// field access, symlink races, etc.).
			continue;
		}
	}
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	overrides?: Record<string, AgentOverride>,
	modelRoles?: Record<string, string>,
): AgentDiscoveryResult {
	// Built-in agents ship with the package (extensions/agents/*.md)
	// PI_TASKFLOW_BUILTIN_AGENTS_DIR allows tests to override or disable (empty = skip)
	const builtInDirEnv = process.env.PI_TASKFLOW_BUILTIN_AGENTS_DIR;
	const builtInDir = builtInDirEnv ? builtInDirEnv : builtInDirEnv === undefined ? path.resolve(import.meta.dirname, "agents") : "";
	const builtInAgents = builtInDir ? loadAgentsFromDir(builtInDir, "built-in") : [];

	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Layer order: built-in → user → project (later layers override earlier)
	const agentMap = new Map<string, AgentConfig>();
	for (const a of builtInAgents) agentMap.set(a.name, a);
	if (scope === "both") {
		for (const a of userAgents) agentMap.set(a.name, a);
		for (const a of projectAgents) agentMap.set(a.name, a);
	} else if (scope === "user") {
		for (const a of userAgents) agentMap.set(a.name, a);
	} else {
		for (const a of projectAgents) agentMap.set(a.name, a);
	}

	if (overrides) {
		for (const [name, override] of Object.entries(overrides)) {
			const agent = agentMap.get(name);
			if (agent) {
				// Clone before mutating: agentMap owns the original AgentConfig
				// (loaded from disk in loadAgentsFromDir). Mutating it in place
				// would cause cross-contamination for any caller that retains a
				// reference and invokes discoverAgents again with different overrides.
				const mutated: AgentConfig = { ...agent };
				if (override.model !== undefined) mutated.model = override.model;
				if (override.thinking !== undefined) mutated.thinking = override.thinking;
				if (override.tools !== undefined) mutated.tools = override.tools;
				agentMap.set(name, mutated);
			}
		}
	}

	// Resolve {{role}} model references (e.g. {{fast}} → openrouter/deepseek/v4-flash)
	if (modelRoles) {
		for (const agent of agentMap.values()) {
			const resolved = resolveModelRole(agent.model, modelRoles);
			if (resolved !== agent.model) agent.model = resolved;
		}
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export interface SubagentSettings {
	agentOverrides?: Record<string, AgentOverride>;
	globalThinking?: string;
	modelRoles?: Record<string, string>;
}

/**
 * Resolve `{{roleName}}` model references against a role→model mapping.
 * E.g. `{{fast}}` → `openrouter/deepseek/deepseek-v4-flash` if modelRoles.fast is set.
 * Returns undefined if the value is not a role reference or the role is unmapped.
 */
export function resolveModelRole(model: string | undefined, roles?: Record<string, string>): string | undefined {
	if (!model || !roles) return model;
	const match = model.match(/^\{\{(\w+)\}\}$/);
	if (!match) return model;
	return roles[match[1]] ?? undefined;
}

/** Read subagent overrides from ~/.pi/agent/settings.json (shared with the subagent extension). */
export function readSubagentSettings(): SubagentSettings {
	try {
		const settingsPath = path.join(getAgentDir(), "settings.json");
		if (!fs.existsSync(settingsPath)) return {};
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return {
			agentOverrides: raw.subagents?.agentOverrides,
			globalThinking: raw.subagents?.globalThinking ?? raw.defaultThinkingLevel,
			modelRoles: raw.modelRoles,
		};
	} catch {
		return {};
	}
}
