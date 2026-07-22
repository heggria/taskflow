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
