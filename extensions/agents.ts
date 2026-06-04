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
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			thinking: frontmatter.thinking,
			systemPrompt: body,
			source,
			filePath,
		});
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
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();
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
				if (override.model !== undefined) agent.model = override.model;
				if (override.thinking !== undefined) agent.thinking = override.thinking;
				if (override.tools !== undefined) agent.tools = override.tools;
			}
		}
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export interface SubagentSettings {
	agentOverrides?: Record<string, AgentOverride>;
	globalThinking?: string;
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
		};
	} catch {
		return {};
	}
}
