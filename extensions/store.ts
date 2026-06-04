/**
 * Persistence for taskflow definitions and run state.
 *
 *   Definitions:  .pi/taskflows/<name>.json          (project)
 *                 ~/.pi/agent/taskflows/<name>.json   (user)
 *   Run state:    .pi/taskflows/runs/<runId>.json     (resume support)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Taskflow } from "./schema.ts";
import type { UsageStats } from "./usage.ts";

export interface SavedFlow {
	name: string;
	scope: "user" | "project";
	filePath: string;
	def: Taskflow;
}

export type PhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface PhaseState {
	id: string;
	status: PhaseStatus;
	output?: string;
	json?: unknown;
	usage?: UsageStats;
	model?: string;
	error?: string;
	inputHash?: string;
	startedAt?: number;
	endedAt?: number;
	/** Live fan-out progress for map/parallel phases. */
	subProgress?: { done: number; total: number; running: number; failed: number };
	/** Latest activity line from the running subagent(s). */
	liveText?: string;
	/** Gate verdict (gate phases only). */
	gate?: { verdict: "pass" | "block"; reason?: string };
	/** Total subagent attempts incl. retries (when > calls, a retry happened). */
	attempts?: number;
	/** True when a map/parallel fan-out was cut short by the budget cap. */
	budgetTruncated?: boolean;
	/** Human-in-the-loop outcome (approval phases only). */
	approval?: { decision: "approve" | "reject" | "edit"; note?: string; auto?: boolean };
}

export interface RunState {
	runId: string;
	flowName: string;
	def: Taskflow;
	args: Record<string, unknown>;
	status: "running" | "completed" | "failed" | "paused" | "blocked";
	phases: Record<string, PhaseState>;
	createdAt: number;
	updatedAt: number;
	cwd: string;
}

function userFlowsDir(): string {
	return path.join(getAgentDir(), "taskflows");
}

function findProjectFlowsDir(cwd: string, create = false): string | null {
	// Prefer an existing .pi dir up the tree; else use cwd/.pi when creating.
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".pi");
		if (fs.existsSync(candidate)) return path.join(candidate, "taskflows");
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return create ? path.join(cwd, ".pi", "taskflows") : null;
}

function readFlowFile(filePath: string, scope: "user" | "project"): SavedFlow | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const def = JSON.parse(raw) as Taskflow;
		if (!def?.name) return null;
		return { name: def.name, scope, filePath, def };
	} catch {
		return null;
	}
}

/** List all saved flows (project overrides user on name collision). */
export function listFlows(cwd: string): SavedFlow[] {
	const map = new Map<string, SavedFlow>();
	const dirs: Array<{ dir: string; scope: "user" | "project" }> = [{ dir: userFlowsDir(), scope: "user" }];
	const projDir = findProjectFlowsDir(cwd);
	if (projDir) dirs.push({ dir: projDir, scope: "project" });

	for (const { dir, scope } of dirs) {
		if (!fs.existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			const flow = readFlowFile(path.join(dir, name), scope);
			if (flow) map.set(flow.name, flow); // project after user → overrides
		}
	}
	return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getFlow(cwd: string, name: string): SavedFlow | null {
	return listFlows(cwd).find((f) => f.name === name) ?? null;
}

export function saveFlow(
	cwd: string,
	def: Taskflow,
	scope: "user" | "project" = "project",
): { filePath: string } {
	const dir = scope === "user" ? userFlowsDir() : (findProjectFlowsDir(cwd, true) ?? path.join(cwd, ".pi", "taskflows"));
	fs.mkdirSync(dir, { recursive: true });
	const safe = def.name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `${safe}.json`);
	writeFileAtomic(filePath, `${JSON.stringify(def, null, 2)}\n`);
	return { filePath };
}

// --- Run state ---

function runsDir(cwd: string): string {
	const projDir = findProjectFlowsDir(cwd, true)!;
	return path.join(projDir, "runs");
}

export function newRunId(flowName: string): string {
	const safe = flowName.replace(/[^\w.-]+/g, "_").slice(0, 24);
	return `${safe}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function saveRun(state: RunState): void {
	const dir = runsDir(state.cwd);
	fs.mkdirSync(dir, { recursive: true });
	state.updatedAt = Date.now();
	writeFileAtomic(path.join(dir, `${state.runId}.json`), JSON.stringify(state, null, 2));
}

export function loadRun(cwd: string, runId: string): RunState | null {
	try {
		const raw = fs.readFileSync(path.join(runsDir(cwd), `${runId}.json`), "utf-8");
		return JSON.parse(raw) as RunState;
	} catch {
		return null;
	}
}

export function listRuns(cwd: string, limit = 20): RunState[] {
	const dir = runsDir(cwd);
	if (!fs.existsSync(dir)) return [];
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const runs: RunState[] = [];
	for (const f of files) {
		try {
			runs.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
		} catch {
			/* ignore */
		}
	}
	return runs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** Stable hash of a phase's resolved task + inputs, for resume caching. */
export function hashInput(...parts: string[]): string {
	return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/**
 * Write a file atomically: write to a unique temp file in the same directory,
 * then rename over the target (rename is atomic on the same filesystem). Prevents
 * a crash or concurrent write from leaving a half-written, corrupt JSON file.
 */
function writeFileAtomic(filePath: string, data: string): void {
	const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, data, "utf-8");
		fs.renameSync(tmp, filePath);
	} catch (e) {
		try {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		} catch {
			/* ignore cleanup failure */
		}
		throw e;
	}
}
