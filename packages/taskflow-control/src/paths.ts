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
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const USER_CONTROL_DIR_NAME = ".taskflow";
const CONTROL_SUBDIR = "control";
/** Synchronous but scheduler-friendly backoff for cross-process lock contention. */
const LOCK_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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

/**
 * Project-identity anchor deliberately outside `.taskflow/`: losing only the
 * mutable control subtree must not look like first use for newly initialized
 * stores. It is still inside the project-root trust boundary.
 */
export function projectControlRootAnchorPath(projectRoot: string): string {
	return path.join(path.resolve(projectRoot), ".taskflow-control.anchor.json");
}

export function projectHeaderPath(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "header.json");
}

export function projectJournalDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "journal");
}

/** Durable journal chain anchor; deliberately outside the mutable journal directory. */
export function projectJournalAnchorPath(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "journal.anchor.json");
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

/**
 * Persist a directory entry change (rename, link, unlink). A data file's
 * fsync alone does not make its name durable across power loss.
 *
 * This control-plane primitive deliberately has no silent unsupported-filesystem
 * downgrade. If the platform cannot open, fsync, or close the directory, a
 * caller must treat the mutation as durability-uncertain and fail closed rather
 * than claim a durable authority/journal update.
 */
export function fsyncDirectory(dir: string): void {
	let dirFd: number | undefined;
	let failure: unknown;
	try {
		dirFd = fs.openSync(dir, "r");
		fs.fsyncSync(dirFd);
	} catch (error) {
		failure = error;
	}
	if (dirFd !== undefined) {
		try {
			fs.closeSync(dirFd);
		} catch (error) {
			// Preserve a prior open/fsync failure; otherwise a close error is the
			// durable-operation failure the caller must observe.
			if (failure === undefined) failure = error;
		}
	}
	if (failure !== undefined) {
		throw new ControlStoreDurabilityError(
			`cannot durably fsync directory ${dir}: ${readFailureDetail(failure)}`,
			dir,
			failure,
		);
	}
}

/**
 * Atomic write: exclusive random temp + fsync file + rename + fsync parent
 * directory. `wx` is essential: a durable caller must never follow a
 * pre-existing symlink at a predictable temporary pathname.
 *
 * This is a narrower hardening than an `openat(2)`/directory-FD no-follow
 * protocol. It does not prevent a hostile concurrent writer from replacing a
 * parent directory, the temporary source entry, or the destination after the
 * file descriptor is opened; pathname rechecks cannot close those races.
 */
export function writeFileAtomic(filePath: string, data: string | Buffer): void {
	const dir = path.dirname(filePath);
	try {
		ensureDir(dir);
	} catch (error) {
		throw new ControlStoreDurabilityError(
			`cannot create durable parent directory ${dir}: ${readFailureDetail(error)}`,
			filePath,
			error,
		);
	}
	let tmp: string | undefined;
	let fd: number | undefined;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const candidate = path.join(
			dir,
			`.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
		);
		try {
			// O_EXCL rejects an already present path, including a planted symlink.
			fd = fs.openSync(candidate, "wx", 0o600);
			tmp = candidate;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw new ControlStoreDurabilityError(
					`cannot create exclusive durable temporary file for ${filePath}: ${readFailureDetail(error)}`,
					filePath,
					error,
				);
			}
		}
	}
	if (tmp === undefined || fd === undefined) {
		throw new ControlStoreDurabilityError(
			`could not create an exclusive durable temporary file for ${filePath}`,
			filePath,
		);
	}
	let writeFailure: unknown;
	let writeFailed = false;
	try {
		fs.writeFileSync(fd, data);
		fs.fsyncSync(fd);
	} catch (error) {
		writeFailed = true;
		writeFailure = error;
	}
	try {
		fs.closeSync(fd);
	} catch (error) {
		// A close failure is causal only when write/fsync already succeeded. Do
		// not let it mask the earlier failure or skip temporary-file cleanup.
		if (!writeFailed) {
			writeFailed = true;
			writeFailure = error;
		}
	}
	if (writeFailed) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Keep the primary causal error even when cleanup also fails.
		}
		throw new ControlStoreDurabilityError(
			`cannot durably write temporary file for ${filePath}: ${readFailureDetail(writeFailure)}`,
			filePath,
			writeFailure,
		);
	}
	let renameFailure: unknown;
	let renameFailed = false;
	try {
		fs.renameSync(tmp, filePath);
		tmp = undefined;
	} catch (error) {
		renameFailed = true;
		renameFailure = error;
	} finally {
		if (tmp !== undefined) {
			try {
				fs.unlinkSync(tmp);
			} catch {
				// A failed cleanup must not hide the original durable-write failure.
			}
		}
	}
	if (renameFailed) {
		throw new ControlStoreDurabilityError(
			`cannot durably publish ${filePath}; publication was not acknowledged: ${readFailureDetail(renameFailure)}`,
			filePath,
			renameFailure,
		);
	}
	// Do not return success after publication until the parent entry is durably
	// synced. A failure means the target may be visible but its durability is
	// uncertain, so the caller must fail closed/reconcile.
	fsyncDirectory(dir);
}

/**
 * Durable-state corruption must be distinguishable from an optional file that
 * has not been created yet. Callers that own authority, capacity, or journal
 * state use this error to stop rather than treating a damaged file as empty.
 */
export class ControlStoreDurabilityError extends Error {
	readonly code = "TF_DURABILITY_FAILED" as const;
	readonly filePath?: string;

	constructor(message: string, filePath?: string, cause?: unknown) {
		super(`TF_DURABILITY_FAILED: ${message}`, cause === undefined ? undefined : { cause });
		this.name = "ControlStoreDurabilityError";
		this.filePath = filePath;
	}
}

function readFailureDetail(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

/**
 * Refuse a durable path whose existing descendants cross a symbolic link.
 *
 * The caller deliberately chooses the trusted root: project roots and home
 * directories may themselves be user-managed symlinks, but Taskflow must not
 * follow a symlink introduced below that root into a second control domain.
 * Missing trailing components are allowed for first-use creation. This is a
 * fail-closed inspection guard, not a replacement for an OS-level openat(2)
 * no-follow protocol against a concurrent hostile filesystem writer.
 */
export function assertNoSymbolicLinkBelow(trustedRoot: string, targetPath: string): void {
	const root = path.resolve(trustedRoot);
	const target = path.resolve(targetPath);
	const relative = path.relative(root, target);
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new ControlStoreDurabilityError(
			`durable path escapes trusted root ${root}: ${target}`,
			target,
		);
	}
	if (relative.length === 0) return;

	let current = root;
	for (const component of relative.split(path.sep)) {
		current = path.join(current, component);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw new ControlStoreDurabilityError(
				`cannot inspect durable path ${current}: ${readFailureDetail(error)}`,
				current,
			);
		}
		if (stat.isSymbolicLink()) {
			throw new ControlStoreDurabilityError(
				`durable path traverses symbolic link ${current}`,
				current,
			);
		}
	}
}

/**
 * Strict JSON read for durable control-plane state.
 *
 * `null` means only ENOENT (a genuinely absent optional/new file). Permission
 * errors, directories in place of files, truncated writes, and malformed JSON
 * are all durable failures: callers must not silently mint identity, reset
 * capacity, or skip journal evidence.
 */
export function readJsonFileStrict<T>(filePath: string): T | null {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new ControlStoreDurabilityError(
			`cannot inspect ${filePath}: ${readFailureDetail(error)}`,
			filePath,
		);
	}
	if (stat.isSymbolicLink()) {
		throw new ControlStoreDurabilityError(
			`durable JSON file must not be a symbolic link: ${filePath}`,
			filePath,
		);
	}
	if (!stat.isFile()) {
		throw new ControlStoreDurabilityError(
			`durable JSON path must be a regular file: ${filePath}`,
			filePath,
		);
	}
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new ControlStoreDurabilityError(
			`cannot read ${filePath}: ${readFailureDetail(error)}`,
			filePath,
		);
	}
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new ControlStoreDurabilityError(
			`cannot parse JSON in ${filePath}: ${readFailureDetail(error)}`,
			filePath,
		);
	}
}

/**
 * Legacy best-effort JSON read. New durable authority paths must use
 * readJsonFileStrict so corruption is never confused with absence.
 */
export function readJsonFile<T>(filePath: string): T | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * Cross-process exclusive critical section via atomic `mkdir`.
 *
 * A pathname lock cannot safely perform automatic stale reclamation: after one
 * contender observes a dead-looking directory, another may replace it before
 * the first calls `rm`. Deleting by pathname would evict the new owner and
 * admit two critical sections. This primitive therefore never reclaims a
 * contended path; it waits for normal release and then fails closed.
 *
 * An operator-mediated or OS-backed recovery protocol must prove
 * compare-and-delete semantics before stale recovery is enabled.
 */
export function withExclusiveLockFile<T>(
	lockPath: string,
	fn: () => T,
	opts?: {
		maxAttempts?: number;
		timeoutMs?: number;
		/** @deprecated Ignored: pathname stale reclamation is unsafe without CAS. */
		staleMs?: number;
	},
): T {
	try {
		ensureDir(path.dirname(lockPath));
	} catch (error) {
		throw new ControlStoreDurabilityError(
			`cannot create exclusive-lock parent directory: ${readFailureDetail(error)}`,
			lockPath,
			error,
		);
	}
	const maxAttempts = opts?.maxAttempts ?? Number.MAX_SAFE_INTEGER;
	const timeoutMs = opts?.timeoutMs ?? 30_000;
	const deadline = Date.now() + timeoutMs;
	const ownerFile = path.join(lockPath, "owner.json");
	const lockId = randomUUID();

	function releaseOwnedLock(ownerWritten: boolean): void {
		let ours = !ownerWritten;
		try {
			if (ownerWritten) {
				const raw = fs.readFileSync(ownerFile, "utf-8");
				const record = JSON.parse(raw) as { lockId?: unknown };
				ours = record.lockId === lockId;
			}
		} catch (error) {
			// A failed owner write is ours to clean up. Once a complete record was
			// written, missing/corrupt metadata is not permission to delete a path.
			if (ownerWritten) {
				throw new ControlStoreDurabilityError(
					`cannot inspect exclusive lock owner while releasing; leaving ${lockPath} intact: ${readFailureDetail(error)}`,
					lockPath,
					error,
				);
			}
			ours = true;
		}
		if (!ours) {
			throw new ControlStoreDurabilityError(
				`cannot prove ownership while releasing exclusive lock; leaving ${lockPath} intact`,
				lockPath,
			);
		}
		try {
			fs.unlinkSync(ownerFile);
		} catch (error) {
			throw new ControlStoreDurabilityError(
				`cannot remove exclusive lock owner record: ${readFailureDetail(error)}`,
				ownerFile,
				error,
			);
		}
		try {
			fs.rmdirSync(lockPath);
		} catch (error) {
			throw new ControlStoreDurabilityError(
				`cannot remove exclusive lock directory: ${readFailureDetail(error)}`,
				lockPath,
				error,
			);
		}
		// Deletion is visible but not durable until the parent directory sync
		// succeeds. Propagate that uncertainty to the caller instead of reporting
		// a clean critical-section completion.
		fsyncDirectory(path.dirname(lockPath));
	}

	function writeOwnerRecord(): void {
		let fd: number | undefined;
		let failure: unknown;
		try {
			fd = fs.openSync(ownerFile, "wx", 0o600);
			fs.writeFileSync(
				fd,
				JSON.stringify({ lockId, pid: process.pid, acquiredAt: Date.now() }),
				"utf-8",
			);
			fs.fsyncSync(fd);
			fsyncDirectory(lockPath);
		} catch (error) {
			failure = error;
		}
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch (error) {
				// Do not let a close failure hide the earlier owner-publication fault.
				if (failure === undefined) failure = error;
			}
		}
		if (failure !== undefined) {
			throw new ControlStoreDurabilityError(
				`cannot publish exclusive lock owner: ${readFailureDetail(failure)}`,
				ownerFile,
				failure,
			);
		}
	}

	for (let attempt = 0; attempt < maxAttempts && Date.now() <= deadline; attempt++) {
		let contended = false;
		try {
			fs.mkdirSync(lockPath); // atomic exclusive create
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") {
				throw new ControlStoreDurabilityError(
					`cannot create exclusive lock directory: ${readFailureDetail(error)}`,
					lockPath,
					error,
				);
			}
			contended = true;
		}
		if (!contended) {
			let ownerWritten = false;
			let hasPrimaryFailure = false;
			try {
				writeOwnerRecord();
				ownerWritten = true;
				return fn();
			} catch (error) {
				hasPrimaryFailure = true;
				throw error;
			} finally {
				try {
					releaseOwnedLock(ownerWritten);
				} catch (releaseError) {
					// A failed body already makes the operation fail closed. Preserve
					// that primary causal error rather than masking it with cleanup
					// uncertainty; a successful body must surface release failure.
					if (!hasPrimaryFailure) throw releaseError;
				}
			}
		}
		try {
			const st = fs.lstatSync(lockPath);
			if (st.isSymbolicLink() || !st.isDirectory()) {
				throw new ControlStoreDurabilityError(
					`exclusive lock path is not a real directory; refusing destructive migration: ${lockPath}`,
					lockPath,
				);
			}
		} catch (inspectionError) {
			if (inspectionError instanceof ControlStoreDurabilityError) throw inspectionError;
			if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") {
				// The contended path disappeared while inspecting; retry immediately.
				continue;
			}
			throw new ControlStoreDurabilityError(
				`cannot inspect contended exclusive lock: ${readFailureDetail(inspectionError)}`,
				lockPath,
				inspectionError,
			);
		}
		Atomics.wait(LOCK_RETRY_SIGNAL, 0, 0, 2 + (attempt % 5));
	}
	throw new ControlStoreDurabilityError(
		`could not acquire exclusive lock within ${timeoutMs}ms; refusing unsafe stale reclamation`,
		lockPath,
	);
}
