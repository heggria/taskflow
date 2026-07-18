/** Host-neutral detached launch + lifecycle helpers for MCP adapters. */

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	clearDetachedCancelRequest,
	isProcessAlive,
	loadRun,
	readDetachedCancelRequest,
	requestDetachedCancel,
	saveRun,
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
}

const STARTING_GRACE_MS = 5_000;
const WAIT_POLL_MS = 100;

function markDetachedFailure(state: RunState, message: string): RunState {
	state.status = "failed";
	state.phases["__detach__"] = {
		id: "__detach__",
		status: "failed",
		endedAt: Date.now(),
		error: message.slice(0, 2_000),
	};
	saveRun(state);
	return state;
}

function markDetachedExit(cwd: string, runId: string, pid: number, message: string): void {
	try {
		const state = loadRun(cwd, runId);
		if (state?.status === "running" && state.pid === pid) markDetachedFailure(state, message);
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
	saveRun(state);

	const tempDir = mkdtempSync(join(tmpdir(), "taskflow-detach-"));
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
	}), { encoding: "utf8", flag: "wx", mode: 0o600 });

	try {
		const runnerScript = fileURLToPath(import.meta.resolve("taskflow-core/detached-runner"));
		const child = spawn(
			process.execPath,
			[...detachedNodeArgs(runnerScript), runnerScript, contextPath],
			{ cwd: state.cwd, detached: true, stdio: "ignore" },
		);
		const pid = child.pid;
		if (typeof pid !== "number") throw new Error("Detached runner did not report a pid");

		child.once("error", (error) => {
			markDetachedExit(state.cwd, state.runId, pid, `Failed to spawn detached runner: ${error.message}`);
		});
		child.once("exit", (code, signal) => {
			if (code === 0) return;
			markDetachedExit(
				state.cwd,
				state.runId,
				pid,
				`Detached runner exited before completing (code ${code ?? "null"}, signal ${signal ?? "none"}).`,
			);
		});

		state.pid = pid;
		saveRun(state);
		writeFileSync(startPath, "start\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
		child.unref();
		return { pid };
	} catch (error) {
		try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		const message = error instanceof Error ? error.message : String(error);
		markDetachedFailure(state, `Failed to launch detached runner: ${message}`);
		throw error;
	}
}

/** Refresh a detached run and terminalize an orphaned process. */
export function refreshDetachedRun(cwd: string, runId: string): RunState | null {
	const state = loadRun(cwd, runId);
	if (!state || state.status !== "running" || !state.detached) return state;

	const cancel = readDetachedCancelRequest(cwd, runId);
	if (typeof state.pid === "number") {
		if (isProcessAlive(state.pid)) return state;
		const fresh = loadRun(cwd, runId);
		if (!fresh || fresh.status !== "running" || fresh.pid !== state.pid) return fresh;
		if (cancel) {
			fresh.status = "paused";
			fresh.phases["__detach__"] = {
				id: "__detach__",
				status: "skipped",
				endedAt: Date.now(),
				warnings: ["Cancellation requested; detached process exited before persisting its normal paused state."],
			};
			saveRun(fresh);
			clearDetachedCancelRequest(cwd, runId);
			return fresh;
		}
		return markDetachedFailure(fresh, "Detached runner process exited before persisting a terminal state.");
	}

	if (Date.now() - (state.detachedStartedAt ?? state.createdAt) <= STARTING_GRACE_MS) return state;
	return markDetachedFailure(state, "Detached runner never persisted a process id.");
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
	const first = `${statusGlyph(state.status)} ${state.status} · ${state.flowName} · ${progress.done}/${progress.total} phases${pid} · run ${state.runId}`;
	if (!includeOutput || state.status === "running") {
		const cancel = readDetachedCancelRequest(state.cwd, state.runId);
		return cancel ? `${first} · cancellation requested` : first;
	}
	const source = state.outputSourcePhaseId ? `--- ${state.outputSourcePhaseId} ---\n` : "";
	if (state.finalOutput) return `${first}\n\n${source}${state.finalOutput}`;
	const failure = Object.values(state.phases).find((phase) => phase.status === "failed" && phase.error)?.error;
	return failure ? `${first}\n\n${failure}` : first;
}
