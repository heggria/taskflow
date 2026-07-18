/** Host-neutral detached launch + lifecycle helpers for MCP adapters. */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	clearDetachedCancelRequest,
	clearDetachedProcessRegistry,
	directoryIdentity,
	DETACHED_CONTROL_VERSION,
	isProcessAlive,
	killProcessTree,
	listRuns,
	loadRun,
	probeProcess,
	readDetachedCancelRequest,
	readDetachedProcessRegistry,
	requestDetachedCancel,
	saveRun,
	terminateDetachedProcessTrees,
	type AgentConfig,
	type AgentScope,
	type DetachedCancelRequest,
	type RunState,
} from "taskflow-core";

export interface DetachedRunnerBinding {
	/** Resolved file URL/path of a module exporting the host SubagentRunner. */
	module: string;
	exportName: string;
}

export interface BackgroundLaunchOptions {
	state: RunState;
	runner: DetachedRunnerBinding;
	incremental?: boolean;
	reusedSavedName?: string;
	agents: AgentConfig[];
	globalThinking?: string;
	agentScope: AgentScope;
	maxKeptRuns: number;
	maxRunAgeDays: number;
}

const STARTING_GRACE_MS = 5_000;
const WAIT_POLL_MS = 100;
const HEARTBEAT_STALE_MS = 30_000;
const MAX_PRESENTED_OUTPUT_CHARS = 50_000;

export const BACKGROUND_RUN_WARNING_THRESHOLD = 5;

export type BackgroundRunFilter = "all" | "running" | "terminal";

export interface BackgroundRunList {
	runs: RunState[];
	activeCount: number;
	totalCount: number;
}

function markDetachedFailure(state: RunState, message: string): RunState {
	state.status = "failed";
	if (!state.phases || typeof state.phases !== "object") state.phases = {};
	state.phases["__detach__"] = {
		id: "__detach__",
		status: "failed",
		endedAt: Date.now(),
		error: message.slice(0, 2_000),
	};
	saveRun(state, state.detachedRetention);
	return state;
}

function markDetachedExit(cwd: string, runId: string, pid: number, message: string): void {
	try {
		const state = loadRun(cwd, runId);
		if (state?.status === "running" && state.pid === pid) {
			if (state.detachedInstanceId) {
				terminateDetachedProcessTrees(state.cwd, state.runId, state.detachedInstanceId);
				clearDetachedProcessRegistry(state.cwd, state.runId, state.detachedInstanceId);
			}
			markDetachedFailure(state, message);
		}
	} catch {
		/* best-effort crash guard */
	}
}

function detachedNodeArgs(runnerScript: string): string[] {
	if (!runnerScript.endsWith(".ts")) return [];
	return ["--conditions=development", "--experimental-strip-types"];
}

/**
 * Spawn the shared core detached runner and release it only after pid metadata
 * is durably persisted, preventing a fast child from being overwritten by a
 * stale parent-side `running` save.
 */
export function launchMcpBackgroundRun(options: BackgroundLaunchOptions): { pid: number } {
	const { state } = options;
	// A run id should be unique, but clearing first makes relaunch/recovery safe
	// if an operator deliberately reuses a stored state in tests or tooling.
	clearDetachedCancelRequest(state.cwd, state.runId);
	state.detached = true;
	state.detachedStartedAt = Date.now();
	state.detachedControlVersion = DETACHED_CONTROL_VERSION;
	state.detachedInstanceId = randomUUID();
	state.detachedRetention = {
		maxKeep: options.maxKeptRuns,
		maxAgeDays: options.maxRunAgeDays,
	};
	let tempDir: string | undefined;
	let child: ChildProcess | undefined;

	try {
		saveRun(state, { maxKeep: options.maxKeptRuns, maxAgeDays: options.maxRunAgeDays });
		tempDir = mkdtempSync(join(tmpdir(), "taskflow-detach-"));
		chmodSync(tempDir, 0o700);
		const contextPath = join(tempDir, "context.json");
		const startPath = join(tempDir, "start");
		writeFileSync(contextPath, JSON.stringify({
			runId: state.runId,
			defName: state.flowName,
			args: state.args,
			cwd: state.cwd,
			runnerModule: options.runner.module,
			runnerExport: options.runner.exportName,
			waitForStart: true,
			incremental: options.incremental === true,
			reusedSavedName: options.reusedSavedName,
			agents: options.agents,
			globalThinking: options.globalThinking,
			agentScope: options.agentScope,
			maxKeptRuns: options.maxKeptRuns,
			maxRunAgeDays: options.maxRunAgeDays,
			detachedInstanceId: state.detachedInstanceId,
		}), { encoding: "utf8", flag: "wx", mode: 0o600 });
		const runnerScript = fileURLToPath(import.meta.resolve("taskflow-core/detached-runner"));
		child = spawn(
			process.execPath,
			[...detachedNodeArgs(runnerScript), runnerScript, contextPath],
			{
				cwd: state.cwd,
				detached: true,
				stdio: "ignore",
				env: { ...process.env, TASKFLOW_DETACHED_RUNNER: "1" },
			},
		);
		const pid = child.pid;
		if (typeof pid !== "number") throw new Error("Detached runner did not report a pid");

		child.once("error", (error) => {
			markDetachedExit(state.cwd, state.runId, pid, `Failed to spawn detached runner: ${error.message}`);
			if (tempDir) try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		});
		child.once("exit", (code, signal) => {
			if (tempDir) try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* child consumed it */ }
			if (code === 0) return;
			markDetachedExit(
				state.cwd,
				state.runId,
				pid,
				`Detached runner exited before completing (code ${code ?? "null"}, signal ${signal ?? "none"}).`,
			);
		});

		state.pid = pid;
		saveRun(state, { maxKeep: options.maxKeptRuns, maxAgeDays: options.maxRunAgeDays });
		writeFileSync(startPath, "start\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
		child.unref();
		return { pid };
	} catch (error) {
		if (child?.pid) killProcessTree(child.pid, "SIGKILL", child);
		if (tempDir) try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		const message = error instanceof Error ? error.message : String(error);
		try { markDetachedFailure(state, `Failed to launch detached runner: ${message}`); } catch { /* preserve launch cause */ }
		throw error;
	}
}

function sameInvocationRoot(state: RunState, cwd: string): boolean {
	const current = directoryIdentity(cwd);
	const owner = state.invocationRootSnapshot ?? directoryIdentity(state.cwd);
	return Boolean(
		current && owner &&
		current.canonicalPath === owner.canonicalPath &&
		current.device === owner.device &&
		current.inode === owner.inode,
	);
}

function isStructurallyUsableRun(state: RunState): boolean {
	return Boolean(
		state && typeof state === "object" &&
		typeof state.runId === "string" && typeof state.cwd === "string" &&
		state.def && Array.isArray(state.def.phases) &&
		state.phases && typeof state.phases === "object" &&
		["running", "completed", "failed", "paused", "blocked"].includes(state.status),
	);
}

function refreshDetachedState(cwd: string, state: RunState): RunState | null {
	if (!isStructurallyUsableRun(state) || !sameInvocationRoot(state, cwd)) return null;
	if (state.status !== "running" || !state.detached) return state;

	const cancel = readDetachedCancelRequest(state.cwd, state.runId);
	if (typeof state.pid === "number") {
		const liveness = probeProcess(state.pid);
		if (state.detachedControlVersion === DETACHED_CONTROL_VERSION && state.detachedInstanceId) {
			const registry = readDetachedProcessRegistry(state.cwd, state.runId);
			const heartbeatFresh = Boolean(
				registry && registry.instanceId === state.detachedInstanceId &&
				registry.ownerPid === state.pid && Date.now() - registry.heartbeatAt <= HEARTBEAT_STALE_MS,
			);
			if (liveness !== "dead" && heartbeatFresh) return state;
			if (
				liveness !== "dead" && !registry &&
				Date.now() - (state.detachedStartedAt ?? state.createdAt) <= STARTING_GRACE_MS
			) return state;
			// For current-protocol workers the private heartbeat is authoritative.
			// EPERM from signal 0 must not keep a run phantom-running forever once
			// the startup grace has elapsed without a registry heartbeat.
			terminateDetachedProcessTrees(state.cwd, state.runId, state.detachedInstanceId);
			clearDetachedProcessRegistry(state.cwd, state.runId, state.detachedInstanceId);
		} else if (isProcessAlive(state.pid)) {
			return state;
		}
		const fresh = loadRun(cwd, state.runId);
		if (!fresh || fresh.status !== "running" || fresh.pid !== state.pid) return fresh;
		if (cancel) {
			fresh.status = "paused";
			fresh.detachedCancel = cancel;
			fresh.phases["__detach__"] = {
				id: "__detach__",
				status: "skipped",
				endedAt: Date.now(),
				warnings: ["Cancellation requested; detached process exited before persisting its normal paused state."],
			};
			saveRun(fresh);
			clearDetachedCancelRequest(fresh.cwd, fresh.runId);
			return fresh;
		}
		return markDetachedFailure(fresh, "Detached runner process exited before persisting a terminal state.");
	}

	if (Date.now() - (state.detachedStartedAt ?? state.createdAt) <= STARTING_GRACE_MS) return state;
	return markDetachedFailure(state, "Detached runner never persisted a process id.");
}

/** Refresh a detached run and terminalize an orphaned process. */
export function refreshDetachedRun(cwd: string, runId: string): RunState | null {
	const state = loadRun(cwd, runId);
	return state ? refreshDetachedState(cwd, state) : null;
}

export function cancelMcpBackgroundRun(cwd: string, runId: string, reason?: string): DetachedCancelRequest {
	return requestDetachedCancel(cwd, runId, reason);
}

export async function waitForMcpBackgroundRun(
	cwd: string,
	runId: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RunState | null> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	let state = refreshDetachedRun(cwd, runId);
	while (state?.status === "running" && Date.now() < deadline && !signal?.aborted) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now()))));
		state = refreshDetachedRun(cwd, runId);
	}
	return state;
}

/**
 * Read the project-backed background roster, refreshing orphaned processes
 * before filtering. The active count is always computed from the full roster,
 * so a filtered/limited list still reports total contention.
 */
export function listMcpBackgroundRuns(
	cwd: string,
	limit: number,
	filter: BackgroundRunFilter = "all",
): BackgroundRunList {
	const all = listRuns(cwd, Number.MAX_SAFE_INTEGER)
		.filter((run) => isStructurallyUsableRun(run) && run.detached && sameInvocationRoot(run, cwd))
		.map((run) => refreshDetachedState(cwd, run))
		.filter((run): run is RunState => run !== null);
	const activeCount = all.filter((run) => run.status === "running").length;
	const filtered = filter === "all"
		? all
		: all.filter((run) => filter === "running" ? run.status === "running" : run.status !== "running");
	return {
		runs: filtered.slice(0, Math.max(0, limit)),
		activeCount,
		totalCount: all.length,
	};
}

function phaseProgress(state: RunState): { done: number; total: number } {
	const total = state.def.phases.length;
	const done = Object.values(state.phases).filter((phase) => phase.status !== "running").length;
	return { done: Math.min(done, total), total };
}

function statusGlyph(status: RunState["status"]): string {
	switch (status) {
		case "completed": return "✓";
		case "running": return "↻";
		case "blocked": return "■";
		case "paused": return "Ⅱ";
		case "failed": return "✗";
	}
}

/** Compact, plaintext MCP presentation shared by list/status/wait/cancel. */
export function formatBackgroundRun(state: RunState, includeOutput: boolean): string {
	const progress = phaseProgress(state);
	const pid = typeof state.pid === "number" ? ` · pid ${state.pid}` : "";
	const host = state.host ? ` · ${state.host}` : "";
	const first = `${statusGlyph(state.status)} ${state.status} · ${state.flowName} · ${progress.done}/${progress.total} phases${pid}${host} · run ${state.runId} · cwd ${state.cwd}`;
	if (!includeOutput || state.status === "running") {
		const cancel = readDetachedCancelRequest(state.cwd, state.runId);
		return cancel ? `${first} · cancellation requested` : first;
	}
	const source = state.outputSourcePhaseId ? `--- ${state.outputSourcePhaseId} ---\n` : "";
	if (state.finalOutput !== undefined) {
		const truncated = state.finalOutput.length > MAX_PRESENTED_OUTPUT_CHARS
			? `${state.finalOutput.slice(0, MAX_PRESENTED_OUTPUT_CHARS)}\n\n… output truncated; use taskflow_peek for targeted inspection.`
			: state.finalOutput;
		return `${first}\n\n${source}${truncated}`;
	}
	const failure = Object.values(state.phases).find((phase) => phase.status === "failed" && phase.error)?.error;
	return failure ? `${first}\n\n${failure}` : first;
}
