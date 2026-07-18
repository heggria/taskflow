/**
 * File-backed control plane for detached Taskflow runs.
 *
 * A detached runner cannot rely on an IPC channel surviving its parent MCP
 * process. Cancellation is therefore requested through a small durable marker
 * in a user-private control directory keyed by the canonical invocation root.
 * The child polls that marker and aborts the normal RuntimeDeps signal,
 * preserving the runtime's existing paused semantics and process-tree cleanup.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { detachedControlDir, validateRunId, writeFileAtomic } from "./store.ts";

export interface DetachedCancelRequest {
	requestedAt: number;
	reason?: string;
}

const DEFAULT_POLL_MS = 250;
const CONTROL_VERSION = 1;

export const DETACHED_CONTROL_VERSION = CONTROL_VERSION;
export const DETACHED_CONTROL_CWD_ENV = "TASKFLOW_DETACHED_CONTROL_CWD";
export const DETACHED_CONTROL_RUN_ID_ENV = "TASKFLOW_DETACHED_CONTROL_RUN_ID";
export const DETACHED_CONTROL_INSTANCE_ENV = "TASKFLOW_DETACHED_CONTROL_INSTANCE";

export interface DetachedProcessRegistry {
	version: number;
	instanceId: string;
	ownerPid: number;
	heartbeatAt: number;
	pids: number[];
}

function ensureControlDir(cwd: string): string {
	const dir = detachedControlDir(cwd);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("Detached control root must be a private physical directory");
	}
	try { fs.chmodSync(dir, 0o700); } catch { /* Windows / restrictive filesystem */ }
	return dir;
}

function controlPath(cwd: string, runId: string, suffix: string): string {
	if (!validateRunId(runId)) throw new Error("Invalid runId for detached control");
	return path.join(detachedControlDir(cwd), `${runId}.${suffix}.json`);
}

/** Resolve the cancel marker for a run without accepting caller-selected paths. */
export function detachedCancelRequestPath(cwd: string, runId: string): string {
	return controlPath(cwd, runId, "cancel");
}

/** Persist an idempotent cancellation request for a detached runner. */
export function requestDetachedCancel(cwd: string, runId: string, reason?: string): DetachedCancelRequest {
	ensureControlDir(cwd);
	const request: DetachedCancelRequest = {
		requestedAt: Date.now(),
		...(typeof reason === "string" && reason.trim()
			? { reason: reason.trim().slice(0, 500) }
			: {}),
	};
	writeFileAtomic(detachedCancelRequestPath(cwd, runId), `${JSON.stringify(request)}\n`);
	return request;
}

/** Read a cancellation request. Corrupt markers still mean "cancel" fail-safe. */
export function readDetachedCancelRequest(cwd: string, runId: string): DetachedCancelRequest | null {
	const filePath = detachedCancelRequestPath(cwd, runId);
	if (!fs.existsSync(filePath)) return null;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			return {
				requestedAt: typeof record.requestedAt === "number" ? record.requestedAt : Date.now(),
				...(typeof record.reason === "string" ? { reason: record.reason } : {}),
			};
		}
	} catch {
		// The marker exists, so fail safe and cancel even if its optional metadata
		// was truncated or externally corrupted.
	}
	return { requestedAt: Date.now(), reason: "Cancellation marker was unreadable" };
}

export function clearDetachedCancelRequest(cwd: string, runId: string): void {
	try {
		fs.unlinkSync(detachedCancelRequestPath(cwd, runId));
	} catch {
		/* missing/already consumed */
	}
	try { fs.rmdirSync(detachedControlDir(cwd)); } catch { /* other markers / missing */ }
}

export function detachedProcessRegistryPath(cwd: string, runId: string): string {
	return controlPath(cwd, runId, "processes");
}

export function readDetachedProcessRegistry(cwd: string, runId: string): DetachedProcessRegistry | null {
	const filePath = detachedProcessRegistryPath(cwd, runId);
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const value = parsed as Record<string, unknown>;
		if (
			value.version !== CONTROL_VERSION ||
			typeof value.instanceId !== "string" ||
			!Number.isSafeInteger(value.ownerPid) ||
			typeof value.heartbeatAt !== "number" ||
			!Array.isArray(value.pids)
		) return null;
		return {
			version: CONTROL_VERSION,
			instanceId: value.instanceId,
			ownerPid: value.ownerPid as number,
			heartbeatAt: value.heartbeatAt,
			pids: value.pids.filter((pid): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0),
		};
	} catch {
		return null;
	}
}

function writeDetachedProcessRegistry(cwd: string, runId: string, registry: DetachedProcessRegistry): void {
	ensureControlDir(cwd);
	writeFileAtomic(detachedProcessRegistryPath(cwd, runId), `${JSON.stringify(registry)}\n`);
}

export function heartbeatDetachedProcessRegistry(
	cwd: string,
	runId: string,
	instanceId: string,
	ownerPid = process.pid,
): void {
	const existing = readDetachedProcessRegistry(cwd, runId);
	const pids = existing?.instanceId === instanceId ? existing.pids : [];
	writeDetachedProcessRegistry(cwd, runId, {
		version: CONTROL_VERSION,
		instanceId,
		ownerPid,
		heartbeatAt: Date.now(),
		pids,
	});
}

function processRegistryContextFromEnv(): { cwd: string; runId: string; instanceId: string } | null {
	const cwd = process.env[DETACHED_CONTROL_CWD_ENV];
	const runId = process.env[DETACHED_CONTROL_RUN_ID_ENV];
	const instanceId = process.env[DETACHED_CONTROL_INSTANCE_ENV];
	if (!cwd || !runId || !instanceId || !validateRunId(runId)) return null;
	return { cwd, runId, instanceId };
}

/** Best-effort hook used by runner-core whenever a Host CLI process group starts. */
export function registerDetachedProcessTreeFromEnv(pid: number): void {
	const context = processRegistryContextFromEnv();
	if (!context || !Number.isSafeInteger(pid) || pid <= 0) return;
	try {
		const existing = readDetachedProcessRegistry(context.cwd, context.runId);
		const pids = existing?.instanceId === context.instanceId ? existing.pids : [];
		writeDetachedProcessRegistry(context.cwd, context.runId, {
			version: CONTROL_VERSION,
			instanceId: context.instanceId,
			ownerPid: process.pid,
			heartbeatAt: Date.now(),
			pids: [...new Set([...pids, pid])],
		});
	} catch { /* lifecycle diagnostics must never replace phase execution */ }
}

/** Best-effort hook used by runner-core after a Host CLI process group is reaped. */
export function unregisterDetachedProcessTreeFromEnv(pid: number): void {
	const context = processRegistryContextFromEnv();
	if (!context) return;
	try {
		const existing = readDetachedProcessRegistry(context.cwd, context.runId);
		if (!existing || existing.instanceId !== context.instanceId) return;
		writeDetachedProcessRegistry(context.cwd, context.runId, {
			...existing,
			heartbeatAt: Date.now(),
			pids: existing.pids.filter((candidate) => candidate !== pid),
		});
	} catch { /* lifecycle diagnostics must never replace phase execution */ }
}

function killRegisteredProcessTree(pid: number): void {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
				shell: false,
				stdio: "ignore",
				windowsHide: true,
			});
		} catch { /* already gone / taskkill unavailable */ }
		return;
	}
	try { process.kill(-pid, "SIGKILL"); } catch {
		try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
	}
}

/** Reap every Host CLI process group owned by exactly this worker instance. */
export function terminateDetachedProcessTrees(cwd: string, runId: string, instanceId: string): number[] {
	const registry = readDetachedProcessRegistry(cwd, runId);
	if (!registry || registry.instanceId !== instanceId) return [];
	for (const pid of registry.pids) killRegisteredProcessTree(pid);
	return registry.pids;
}

export function clearDetachedProcessRegistry(cwd: string, runId: string, instanceId?: string): void {
	try {
		const existing = readDetachedProcessRegistry(cwd, runId);
		if (instanceId && existing && existing.instanceId !== instanceId) return;
		fs.unlinkSync(detachedProcessRegistryPath(cwd, runId));
	} catch { /* missing/already cleared */ }
	try { fs.rmdirSync(detachedControlDir(cwd)); } catch { /* other markers / missing */ }
}

/**
 * Poll a detached cancellation marker and bridge it into an AbortController.
 * Returns a cleanup callback. The timer is unref'd so it never keeps a
 * completed detached runner alive by itself.
 */
export function watchDetachedCancel(
	cwd: string,
	runId: string,
	controller: AbortController,
	pollMs = DEFAULT_POLL_MS,
	onRequest?: (request: DetachedCancelRequest) => void,
): () => void {
	const check = () => {
		if (controller.signal.aborted) return;
		const request = readDetachedCancelRequest(cwd, runId);
		if (request) {
			onRequest?.(request);
			controller.abort(request);
		}
	};
	check();
	const timer = setInterval(check, Math.max(50, pollMs));
	timer.unref();
	return () => clearInterval(timer);
}
