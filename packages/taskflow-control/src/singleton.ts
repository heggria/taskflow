/**
 * User-level singleton multi-mount lock (D32 / P13).
 * First writer wins; losers attach. Stale lock (dead pid) is stealable.
 *
 * Unix GA: file lock + UDS path. Windows named-pipe is non-GA in 0.3
 * (documented in P13) — same lock file semantics still apply for coordination.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, singletonLockPath, udsPath, userControlRoot, writeFileAtomic, readJsonFile } from "./paths.ts";

export interface SingletonLockInfo {
	holderId: string;
	pid: number;
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

	// Try exclusive create
	const now = Date.now();
	const candidate: SingletonLockInfo = {
		holderId,
		pid: process.pid,
		fencingEpoch: now,
		endpoint,
		acquiredAt: now,
	};

	try {
		// O_CREAT|O_EXCL via wx
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

	// Lock exists — read and decide
	const existing = readJsonFile<SingletonLockInfo>(lockPath);
	if (existing && isPidAlive(existing.pid)) {
		return { role: "attach", lock: existing };
	}

	// Stale lock — steal via atomic rename of temp
	const tmp = `${lockPath}.${process.pid}.steal`;
	writeFileAtomic(tmp, JSON.stringify(candidate, null, 2));
	try {
		// On POSIX rename over existing is atomic
		fs.renameSync(tmp, lockPath);
		return { role: "writer", lock: candidate };
	} catch {
		// Race: another stealer won
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		const again = readJsonFile<SingletonLockInfo>(lockPath);
		if (again) return { role: "attach", lock: again };
		throw new Error("TF_BOOTSTRAP_FAILED: could not acquire or attach singleton");
	}
}

export function releaseSingleton(
	holderId: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const lockPath = singletonLockPath(env);
	const existing = readJsonFile<SingletonLockInfo>(lockPath);
	if (!existing) return;
	if (existing.holderId !== holderId && existing.pid !== process.pid) return;
	try {
		fs.unlinkSync(lockPath);
	} catch {
		/* ignore */
	}
	// Best-effort remove stale socket path marker file (not a real listen in unit tests)
	const sock = udsPath(env);
	try {
		if (fs.existsSync(sock) && !fs.statSync(sock).isSocket()) {
			// only remove placeholder files we may have written
		}
	} catch {
		/* ignore */
	}
	void path;
}
