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
 *     run-index.json               (rebuildable project-local read index)
 *     approval-recovery-index.json (rebuildable startup-recovery accelerator)
 *     journal/     (append-only commit batches)
 *     projections/ (run projections)
 *     bound-plans/ (immutable linked programs, addressed by BoundPlan hash)
 *     bound-fragments/       (immutable dynamic bodies, addressed by hash)
 *     bound-fragment-links/  (Run-scoped parent/causation/commit provenance)
 *     receipts/    (immutable receipts + by-run indexes)
 *     approvals/   (durable approval requests + by-run indexes)
 *     artifacts/   (immutable metadata + content-addressed blobs)
 *     commands/
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const USER_CONTROL_DIR_NAME = ".taskflow";
const CONTROL_SUBDIR = "control";
/**
 * Conservative cross-runtime ceiling below macOS sockaddr_un.sun_path.
 * Keeping margin avoids runtimes that account for the trailing NUL differently.
 */
const UNIX_SOCKET_PATH_MAX_BYTES = 90;

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

function boundedUserSocketPath(
	basename: string,
	env: NodeJS.ProcessEnv,
): string {
	const direct = path.join(userControlRoot(env), basename);
	if (
		process.platform === "win32" ||
		Buffer.byteLength(direct, "utf8") <=
			UNIX_SOCKET_PATH_MAX_BYTES
	) {
		return direct;
	}
	const rootHash = createHash("sha256")
		.update(userControlRoot(env))
		.digest("hex")
		.slice(0, 32);
	const owner =
		typeof process.getuid === "function"
			? String(process.getuid())
			: "user";
	const directory = `tf-${owner}-${rootHash}`;
	const temporary = path.join(
		os.tmpdir(),
		directory,
		basename,
	);
	if (
		Buffer.byteLength(temporary, "utf8") <=
		UNIX_SOCKET_PATH_MAX_BYTES
	) {
		return temporary;
	}
	return path.join("/tmp", directory, basename);
}

export function udsPath(env: NodeJS.ProcessEnv = process.env): string {
	return boundedUserSocketPath("taskflowd.sock", env);
}

export function projectControlRoot(projectRoot: string): string {
	return path.join(path.resolve(projectRoot), USER_CONTROL_DIR_NAME, CONTROL_SUBDIR);
}

/**
 * Ephemeral owner-only control socket for an explicit standalone Web UI.
 *
 * Unix socket paths are very short on macOS, so the project identity is
 * hashed into the private user control root instead of embedding a possibly
 * long project path.
 */
export function projectWebUiSocketPath(
	projectRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const projectKey = createHash("sha256")
		.update(path.resolve(projectRoot))
		.digest("hex")
		.slice(0, 12);
	// Keep the basename no longer than taskflowd.sock so a home that can host
	// the retained UDS can also host this project-scoped transient endpoint.
	return boundedUserSocketPath(`u${projectKey}`, env);
}

export function projectHeaderPath(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "header.json");
}

export function projectApprovalRecoveryIndexPath(
	projectRoot: string,
): string {
	return path.join(
		projectControlRoot(projectRoot),
		"approval-recovery-index.json",
	);
}

export function projectRunIndexPath(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "run-index.json");
}

export function projectJournalDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "journal");
}

export function projectProjectionsDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "projections");
}

export function projectBoundPlansDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "bound-plans");
}

export function projectBoundFragmentsDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "bound-fragments");
}

export function projectBoundFragmentLinksDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "bound-fragment-links");
}

export function projectCommandsDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "commands");
}

export function projectReceiptsDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "receipts");
}

export function projectApprovalsDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "approvals");
}

export function projectArtifactsDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "artifacts");
}

export function projectArtifactMetadataDir(
	projectRoot: string,
): string {
	return path.join(projectArtifactsDir(projectRoot), "metadata");
}

export function projectArtifactBlobsDir(
	projectRoot: string,
): string {
	return path.join(projectArtifactsDir(projectRoot), "blobs");
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
 * Cross-process exclusive critical section via an atomic hard-link claim.
 *
 * The owner record is fully written and closed in a same-directory candidate
 * before `link(candidate, lockPath)` publishes it. The link is exclusive and
 * atomic, so live contenders cannot observe an empty/partial owner and steal a
 * live lock. The candidate is ephemeral coordination state, not durable domain
 * data: forcing it to stable storage would add one disk flush to every critical
 * section without improving post-power-loss authority (no prior owner process
 * survives a reboot). A crashed candidate is harmless because it was never
 * published. Callers must re-read durable state inside `fn`.
 */
export function withExclusiveLockFile<T>(
	lockPath: string,
	fn: () => T,
	opts?: { maxAttempts?: number; staleMs?: number },
): T {
	ensureDir(path.dirname(lockPath));
	const maxAttempts = opts?.maxAttempts ?? 3_000;
	const staleMs = opts?.staleMs ?? 30_000;
	const sleeper = new Int32Array(new SharedArrayBuffer(4));

	for (let i = 0; i < maxAttempts; i++) {
		const candidate = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
		const owner = JSON.stringify({ pid: process.pid, at: Date.now() });
		try {
			const fd = fs.openSync(candidate, "wx");
			try {
				fs.writeFileSync(fd, owner);
			} finally {
				fs.closeSync(fd);
			}
		} catch (cause) {
			throw new Error(`could not prepare exclusive lock candidate: ${candidate}`, {
				cause,
			});
		}

		let acquired = false;
		try {
			fs.linkSync(candidate, lockPath);
			acquired = true;
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") {
				try {
					fs.unlinkSync(candidate);
				} catch {
					/* ignore */
				}
				throw e;
			}
		}

		try {
			fs.unlinkSync(candidate);
		} catch {
			/* candidate is never authoritative */
		}

		if (acquired) {
			try {
				return fn();
			} finally {
				try {
					fs.unlinkSync(lockPath);
				} catch {
					/* a stale-steal race may already have removed it */
				}
			}
		}

		// Contended or stale lock. The hard-link owner is always complete. During
		// migration, an older directory lock is also understood without stealing
		// an unowned-but-possibly-live directory before the full stale window.
		try {
			const st = fs.statSync(lockPath);
			const age = Date.now() - st.mtimeMs;
			const ownerPath = st.isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
			const persisted = readJsonFile<{ pid?: number }>(ownerPath);
			const pid = persisted?.pid ?? 0;
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
				if (st.isDirectory()) fs.rmSync(lockPath, { recursive: true, force: true });
				else fs.unlinkSync(lockPath);
				continue;
			}
		} catch {
			/* lock disappeared; retry immediately */
			continue;
		}

		// Blocking sleep avoids starving the current holder under repository-wide
		// parallel test/process load. 3,000 attempts gives roughly a 30s bound.
		Atomics.wait(sleeper, 0, 0, 8 + (i % 5));
	}
	throw new Error(`could not acquire exclusive lock: ${lockPath}`);
}
