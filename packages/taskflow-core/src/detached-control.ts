/**
 * File-backed control plane for detached Taskflow runs.
 *
 * A detached runner cannot rely on an IPC channel surviving its parent MCP
 * process. Cancellation is therefore requested through a small durable marker
 * under the project runs directory. The child polls that marker and aborts the
 * normal RuntimeDeps signal, preserving the runtime's existing paused semantics
 * and process-tree cleanup.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runsDir, validateRunId, writeFileAtomic } from "./store.ts";

export interface DetachedCancelRequest {
	requestedAt: number;
	reason?: string;
}

const CONTROL_DIR = ".control";
const DEFAULT_POLL_MS = 250;

/** Resolve the cancel marker for a run without accepting caller-selected paths. */
export function detachedCancelRequestPath(cwd: string, runId: string): string {
	if (!validateRunId(runId)) throw new Error("Invalid runId for detached control");
	return path.join(runsDir(cwd), CONTROL_DIR, `${runId}.cancel.json`);
}

/** Persist an idempotent cancellation request for a detached runner. */
export function requestDetachedCancel(cwd: string, runId: string, reason?: string): DetachedCancelRequest {
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
): () => void {
	const check = () => {
		if (controller.signal.aborted) return;
		const request = readDetachedCancelRequest(cwd, runId);
		if (request) controller.abort(request);
	};
	check();
	const timer = setInterval(check, Math.max(50, pollMs));
	timer.unref();
	return () => clearInterval(timer);
}
