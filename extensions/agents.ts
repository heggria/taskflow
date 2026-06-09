/**
 * Agent discovery and configuration.
 * Adapted from the pi subagent extension so taskflow shares the same agent
 * pool (~/.pi/agent/agents/*.md, .pi/agents/*.md) and settings overrides.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface TaskflowSettings {
	/** Whether taskflow's package-local built-in agents are available to flows. */
	builtInAgents: boolean;
	/** Whether package-local built-ins are copied into the current project's .pi/agents/. */
	syncBuiltinAgentsToProject: boolean;
	/** Maximum completed/failed runs to keep. 0 disables cleanup. */
	maxKeptRuns: number;
	/** Maximum age (days) for completed/failed runs. 0 disables age cleanup. */
	maxRunAgeDays: number;
}

import { DEFAULT_KEPT_RUNS, DEFAULT_RUN_AGE_DAYS } from "./store.ts";

export const DEFAULT_TASKFLOW_SETTINGS: TaskflowSettings = {
	builtInAgents: true,
	syncBuiltinAgentsToProject: false,
	maxKeptRuns: DEFAULT_KEPT_RUNS,
	maxRunAgeDays: DEFAULT_RUN_AGE_DAYS,
};

export function normalizeTaskflowSettings(raw: unknown): TaskflowSettings {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ...DEFAULT_TASKFLOW_SETTINGS };
	}
	const rec = raw as Record<string, unknown>;
	return {
		builtInAgents:
			typeof rec.builtInAgents === "boolean"
				? rec.builtInAgents
				: DEFAULT_TASKFLOW_SETTINGS.builtInAgents,
		syncBuiltinAgentsToProject:
			typeof rec.syncBuiltinAgentsToProject === "boolean"
				? rec.syncBuiltinAgentsToProject
				: DEFAULT_TASKFLOW_SETTINGS.syncBuiltinAgentsToProject,
		maxKeptRuns:
			typeof rec.maxKeptRuns === "number" && rec.maxKeptRuns >= 0 && Number.isInteger(rec.maxKeptRuns)
				? rec.maxKeptRuns
				: DEFAULT_TASKFLOW_SETTINGS.maxKeptRuns,
		maxRunAgeDays:
			typeof rec.maxRunAgeDays === "number" && rec.maxRunAgeDays >= 0 && Number.isInteger(rec.maxRunAgeDays)
				? rec.maxRunAgeDays
				: DEFAULT_TASKFLOW_SETTINGS.maxRunAgeDays,
	};
}

export function shouldLoadBuiltinAgents(settings: TaskflowSettings = DEFAULT_TASKFLOW_SETTINGS): boolean {
	return settings.builtInAgents;
}

export function shouldSyncBuiltinAgentsToProject(settings: TaskflowSettings = DEFAULT_TASKFLOW_SETTINGS): boolean {
	return settings.builtInAgents && settings.syncBuiltinAgentsToProject;
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
	modelRoles?: Record<string, string>,
	taskflowSettings: TaskflowSettings = DEFAULT_TASKFLOW_SETTINGS,
): AgentDiscoveryResult {
	// Built-in agents ship with the package (extensions/agents/*.md).
	// PI_TASKFLOW_BUILTIN_AGENTS_DIR is kept as a test hook only; user-facing
	// enable/disable lives in settings.json under `taskflow.builtInAgents`.
	const builtInDirEnv = process.env.PI_TASKFLOW_BUILTIN_AGENTS_DIR;
	const builtInDir = builtInDirEnv ? builtInDirEnv : builtInDirEnv === undefined ? path.resolve(import.meta.dirname, "agents") : "";
	const builtInAgents = shouldLoadBuiltinAgents(taskflowSettings) && builtInDir ? loadAgentsFromDir(builtInDir, "built-in") : [];

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

	// Resolve {{role}} model references (e.g. {{fast}} → openrouter/deepseek/v4-flash)
	// Clone before mutating, consistent with the overrides block above.
	if (modelRoles) {
		for (const [name, agent] of agentMap.entries()) {
			const resolved = resolveModelRole(agent.model, modelRoles);
			if (resolved !== agent.model) {
				const mutated: AgentConfig = { ...agent };
				mutated.model = resolved;
				agentMap.set(name, mutated);
			}
		}
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export interface SubagentSettings {
	globalThinking?: string;
	modelRoles?: Record<string, string>;
	taskflow: TaskflowSettings;
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
		if (!fs.existsSync(settingsPath)) return { taskflow: { ...DEFAULT_TASKFLOW_SETTINGS } };
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return {
			globalThinking: raw.subagents?.globalThinking ?? raw.defaultThinkingLevel,
			modelRoles: raw.modelRoles,
			taskflow: normalizeTaskflowSettings(raw.taskflow),
		};
	} catch {
		return { taskflow: { ...DEFAULT_TASKFLOW_SETTINGS } };
	}
}

/**
 * Copy the 18 built-in agents from extensions/agents/*.md into the project's
 * .pi/agents/ directory so Pi's native subagent tool (and any other extension)
 * can discover them. taskflow's own discoverAgents() already reads from this
 * directory with lower priority than built-in, so the copy is a no-op for
 * taskflow phases — it only matters for Pi's native agent discovery.
 *
 * Idempotent: only copies agents whose built-in source is newer than the
 * project copy (or that don't exist yet).
 */
export function syncBuiltinAgentsToProject(cwd: string): void {
	const builtInDir = path.resolve(import.meta.dirname, "agents");
	if (!fs.existsSync(builtInDir)) return;

	const projectAgentsDir = path.join(cwd, ".pi", "agents");
	fs.mkdirSync(projectAgentsDir, { recursive: true });

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(builtInDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const src = path.join(builtInDir, entry.name);
		const dst = path.join(projectAgentsDir, entry.name);

		let srcMtime = 0;
		try { srcMtime = fs.statSync(src).mtimeMs; } catch { continue; }

		let dstMtime = 0;
		try { dstMtime = fs.statSync(dst).mtimeMs; } catch { /* dst doesn't exist yet */ }

		// Only copy when the source is newer (or the destination is missing).
		if (srcMtime <= dstMtime) continue;

		try {
			const content = fs.readFileSync(src, "utf-8");
			fs.writeFileSync(dst, content, "utf-8");
		} catch {
			// Best-effort: a locked file must not block the sync.
		}
	}
}
