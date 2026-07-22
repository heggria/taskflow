/**
 * User-level singleton multi-mount lock (D32 / P13).
 *
 * Protocol: O_CREAT|O_EXCL create → writer; EEXIST + live peer → attach;
 * dead peer → CAS steal via rename with fencingEpoch bump.
 * Old writer after steal is fenced: isWriterStillAuthoritative() compares epoch.
 *
 * Unix GA: lock file + UDS path for transport. Windows named-pipe: non-GA (P13).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ensureDir,
	singletonLockPath,
	udsPath,
	userControlRoot,
	writeFileAtomic,
	readJsonFile,
} from "./paths.ts";

export interface SingletonLockInfo {
	holderId: string;
	pid: number;
	/** Monotonic fencing token; steals must bump. */
	fencingEpoch: number;
	endpoint: string;
	acquiredAt: number;
}

export type SingletonResult =
	| { role: "writer"; lock: SingletonLockInfo }
	| { role: "attach"; lock: SingletonLockInfo };

function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLock(lockPath: string): SingletonLockInfo | null {
	return readJsonFile<SingletonLockInfo>(lockPath);
}

/**
 * Acquire or attach to the user singleton.
 * Never forks an independent multi-mount authority on lock failure.
 */
export function acquireOrAttachSingleton(
	holderId: string,
	env: NodeJS.ProcessEnv = process.env,
): SingletonResult {
	ensureDir(userControlRoot(env));
	const lockPath = singletonLockPath(env);
	const endpoint = udsPath(env);
	const now = Date.now();

	const candidate: SingletonLockInfo = {
		holderId,
		pid: process.pid,
		fencingEpoch: now,
		endpoint,
		acquiredAt: now,
	};

	// 1) Exclusive create
	try {
		const fd = fs.openSync(lockPath, "wx");
		try {
			fs.writeFileSync(fd, JSON.stringify(candidate, null, 2));
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		return { role: "writer", lock: candidate };
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code !== "EEXIST") throw e;
	}

	// 2) Live peer → attach
	const existing = readLock(lockPath);
	if (existing && isPidAlive(existing.pid)) {
		return { role: "attach", lock: existing };
	}

	// 3) Stale steal: bump epoch from prior if present
	const prevEpoch = existing?.fencingEpoch ?? 0;
	const steal: SingletonLockInfo = {
		...candidate,
		fencingEpoch: Math.max(now, prevEpoch + 1),
	};
	const tmp = `${lockPath}.${process.pid}.${steal.fencingEpoch}.steal`;
	writeFileAtomic(tmp, JSON.stringify(steal, null, 2));
	try {
		// CAS: only replace if still same dead content (best-effort: rename is atomic)
		// Re-check peer before rename
		const again = readLock(lockPath);
		if (again && isPidAlive(again.pid)) {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* ignore */
			}
			return { role: "attach", lock: again };
		}
		fs.renameSync(tmp, lockPath);
		// Verify we won: re-read
		const won = readLock(lockPath);
		if (won && won.holderId === holderId && won.pid === process.pid) {
			return { role: "writer", lock: won };
		}
		if (won) return { role: "attach", lock: won };
		throw new Error("TF_BOOTSTRAP_FAILED: steal race lost and no lock readable");
	} catch (e) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		const after = readLock(lockPath);
		if (after) return { role: "attach", lock: after };
		throw e instanceof Error ? e : new Error(String(e));
	}
}

/** True iff local lock still matches durable lock (fencing). */
export function isWriterStillAuthoritative(
	local: SingletonLockInfo,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const durable = readLock(singletonLockPath(env));
	if (!durable) return false;
	return (
		durable.holderId === local.holderId &&
		durable.pid === local.pid &&
		durable.fencingEpoch === local.fencingEpoch
	);
}

export function releaseSingleton(
	holderId: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const lockPath = singletonLockPath(env);
	const existing = readLock(lockPath);
	if (!existing) return;
	if (existing.holderId !== holderId && existing.pid !== process.pid) return;
	// Only release if we still own the epoch
	if (existing.pid === process.pid || existing.holderId === holderId) {
		try {
			fs.unlinkSync(lockPath);
		} catch {
			/* ignore */
		}
	}
	void path;
	void udsPath;
}
