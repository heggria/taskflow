/**
 * Control-plane on-disk layout (P13 / P14).
 *
 * User-level:
 *   ~/.taskflow/control/
 *     registry.json
 *     coordinator/  (UserCoordinatorStore)
 *     singleton.lock
 *     taskflowd.sock  (UDS; Unix GA)
 *
 * Project-level:
 *   <project>/.taskflow/control/
 *     header.json
 *     journal/     (append-only commit batches)
 *     projections/ (runs, receipts indexes)
 *     commands/
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const USER_CONTROL_DIR_NAME = ".taskflow";
const CONTROL_SUBDIR = "control";

/** Override home for tests via TASKFLOW_HOME or explicit opts. */
export function userHome(env: NodeJS.ProcessEnv = process.env): string {
	if (env.TASKFLOW_HOME) return path.resolve(env.TASKFLOW_HOME);
	return os.homedir();
}

export function userControlRoot(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(userHome(env), USER_CONTROL_DIR_NAME, CONTROL_SUBDIR);
}

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(userControlRoot(env), "registry.json");
}

export function coordinatorDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(userControlRoot(env), "coordinator");
}

/** Standalone / project-local coordinator — not the user-level multi-project store. */
export function projectCoordinatorDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "coordinator-local");
}

export function singletonLockPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(userControlRoot(env), "singleton.lock");
}

export function udsPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(userControlRoot(env), "taskflowd.sock");
}

export function projectControlRoot(projectRoot: string): string {
	return path.join(path.resolve(projectRoot), USER_CONTROL_DIR_NAME, CONTROL_SUBDIR);
}

export function projectHeaderPath(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "header.json");
}

export function projectJournalDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "journal");
}

export function projectProjectionsDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "projections");
}

export function projectCommandsDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "commands");
}

export function projectReceiptsDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "receipts");
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

/** Atomic write: temp + fsync file + rename + fsync parent directory (durability). */
export function writeFileAtomic(filePath: string, data: string | Buffer): void {
	const dir = path.dirname(filePath);
	ensureDir(dir);
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const fd = fs.openSync(tmp, "w");
	try {
		fs.writeFileSync(fd, data);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, filePath);
	// fsync parent so the rename itself is durable after crash (mandate 7).
	try {
		const dirFd = fs.openSync(dir, "r");
		try {
			fs.fsyncSync(dirFd);
		} finally {
			fs.closeSync(dirFd);
		}
	} catch {
		/* some platforms / FS may not support directory fsync — best effort */
	}
}

export function readJsonFile<T>(filePath: string): T | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * Cross-process exclusive critical section via atomic `mkdir` (POSIX exclusive).
 *
 * Previous O_CREAT|O_EXCL *file* lock had a steal race: between `open(wx)` and
 * writing owner pid, another waiter could read an empty lock, treat pid=0 as
 * dead, unlink, and enter concurrently — dual approve Receipts under CAS.
 *
 * Directory create is a single exclusive step; owner metadata is written inside
 * only after the dir is held. Incomplete dirs (no owner yet) are not stolen
 * until a short abandon window. Callers must re-read durable state inside `fn`.
 */
export function withExclusiveLockFile<T>(
	lockPath: string,
	fn: () => T,
	opts?: { maxAttempts?: number; staleMs?: number },
): T {
	ensureDir(path.dirname(lockPath));
	const maxAttempts = opts?.maxAttempts ?? 500;
	const staleMs = opts?.staleMs ?? 30_000;
	const abandonIncompleteMs = 5_000;
	const ownerFile = path.join(lockPath, "owner.json");

	function removeLockTree(): void {
		try {
			fs.rmSync(lockPath, { recursive: true, force: true });
		} catch {
			try {
				fs.unlinkSync(lockPath); // legacy file lock
			} catch {
				/* ignore */
			}
		}
	}

	for (let i = 0; i < maxAttempts; i++) {
		// Migrate leftover file locks from older builds.
		try {
			const st = fs.statSync(lockPath);
			if (st.isFile()) {
				try {
					fs.unlinkSync(lockPath);
				} catch {
					/* race */
				}
			}
		} catch {
			/* missing — good */
		}

		try {
			fs.mkdirSync(lockPath); // atomic exclusive create
			try {
				fs.writeFileSync(
					ownerFile,
					JSON.stringify({ pid: process.pid, at: Date.now() }),
					"utf-8",
				);
				return fn();
			} finally {
				removeLockTree();
			}
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") throw e;
			// Contended or stale lock dir.
			try {
				const st = fs.statSync(lockPath);
				const age = Date.now() - st.mtimeMs;
				let pid = 0;
				let hasOwner = false;
				try {
					const raw = fs.readFileSync(ownerFile, "utf-8");
					hasOwner = true;
					pid = (JSON.parse(raw) as { pid?: number }).pid ?? 0;
				} catch {
					/* owner not written yet */
				}
				if (!hasOwner) {
					// Do NOT steal during the mkdir→write window of a live holder.
					if (age > abandonIncompleteMs) {
						removeLockTree();
						continue;
					}
				} else {
					let alive = false;
					if (pid > 0) {
						try {
							process.kill(pid, 0);
							alive = true;
						} catch {
							alive = false;
						}
					}
					if (!alive && age > staleMs) {
						removeLockTree();
						continue;
					}
				}
			} catch {
				/* lock disappeared */
			}
			// Brief backoff
			const until = Date.now() + 2 + (i % 5);
			while (Date.now() < until) {
				/* spin */
			}
		}
	}
	throw new Error(`could not acquire exclusive lock: ${lockPath}`);
}
