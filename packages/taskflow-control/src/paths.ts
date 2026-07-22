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

/** Atomic write: temp + fsync + rename (POSIX/NTFS atomic rename). */
export function writeFileAtomic(filePath: string, data: string | Buffer): void {
	ensureDir(path.dirname(filePath));
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const fd = fs.openSync(tmp, "w");
	try {
		fs.writeFileSync(fd, data);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, filePath);
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
 * Cross-process exclusive critical section via O_CREAT|O_EXCL lock file.
 * Callers re-read durable state inside `fn` (do not trust pre-lock memory).
 */
export function withExclusiveLockFile<T>(lockPath: string, fn: () => T, opts?: { maxAttempts?: number; staleMs?: number }): T {
	ensureDir(path.dirname(lockPath));
	const maxAttempts = opts?.maxAttempts ?? 200;
	const staleMs = opts?.staleMs ?? 30_000;
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			try {
				fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
				return fn();
			} finally {
				fs.closeSync(fd);
				try {
					fs.unlinkSync(lockPath);
				} catch {
					/* ignore */
				}
			}
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") throw e;
			// Steal clearly stale locks (no live writer holding them).
			try {
				const st = fs.statSync(lockPath);
				if (Date.now() - st.mtimeMs > staleMs) {
					const raw = fs.readFileSync(lockPath, "utf-8");
					let pid = 0;
					try {
						pid = (JSON.parse(raw) as { pid?: number }).pid ?? 0;
					} catch {
						pid = 0;
					}
					let alive = false;
					if (pid > 0) {
						try {
							process.kill(pid, 0);
							alive = true;
						} catch {
							alive = false;
						}
					}
					if (!alive) {
						try {
							fs.unlinkSync(lockPath);
							continue;
						} catch {
							/* race */
						}
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
