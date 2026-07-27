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
 * ## Cooperative reclaim protocol (stale steal + incomplete abandon)
 *
 * Blind pathname `rm(lockPath)` after observing a dead/incomplete generation is
 * not a compare-and-swap: two contenders can both observe generation G, both
 * remove, and — when the second removal hits a successor already in the
 * critical section — both run `fn` (dual critical sections). Checking
 * dev/ino/token then unlinking is still TOCTOU; every actor that creates,
 * replaces, steals, or abandons the lock must participate in one serialized
 * identity-bound transition.
 *
 * Protocol (directories cannot hard-link the lock dir itself):
 * 1. Fixed claim **file** `${lockPath}.reclaim-claim` created with `O_CREAT|
 *    O_EXCL` and body = observed `{dev,ino,token,hasOwner,pid,at}`. Only one
 *    contender becomes the reclaimer for that observation.
 * 2. Any actor that sees the claim waits for that claim to clear (or for the
 *    claim to become orphaned — dead claimant, or live claimant whose observed
 *    generation no longer matches after a grace so mid-reclaim free-path is
 *    preserved). Never publish a successor while a live reclaim is in flight.
 *    After a successful `mkdir`, re-check the claim and yield (remove our empty
 *    dir) if a reclaim appeared.
 * 3. Reclaimer re-validates that `lockPath` still names the observed generation,
 *    then renames that exact directory to a private discard path (identity-bound
 *    unpublish), publishes `mkdir`+owner under the claim fence, then clears the
 *    claim and destroys the discard. A mismatched generation is restored rather
 *    than destroyed, and the claim is dropped.
 *
 * ## Cooperative liveness (bounded progress under N contenders)
 *
 * Waiters must not burn the attempt budget with fixed micro-spins while a peer
 * holds a claim or a live generation. Blocking waits are **generation-aware**:
 * sleep (via `Atomics.wait`) until the observed claim/lock generation ends.
 * Mutual exclusion (claim fence + mkdir exclusivity) is preserved while N
 * sequential critical sections complete under a modest wall budget.
 *
 * Release is compare-and-delete against the acquire-time directory inode and a
 * random owner token. A finally block must never pathname-rm a successor that
 * replaced the lock while this critical section was still running.
 *
 * ## Same-UID non-cooperative lower bound (explicit, not closed)
 *
 * This protocol serializes cooperative taskflow contenders only. A same-UID
 * process that bypasses the claim (raw `rm -rf` / foreign `mkdir`) can still
 * displace a live holder; that is an OS/credentials bound, not a P13 close.
 */
export function withExclusiveLockFile<T>(
	lockPath: string,
	fn: () => T,
	opts?: {
		maxAttempts?: number;
		timeoutMs?: number;
		/** Age after which a dead-owner lock dir is reclaim-eligible. */
		staleMs?: number;
		/** Age after which an incomplete (no owner.json) lock dir is abandon-eligible. */
		abandonIncompleteMs?: number;
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
	const staleMs = opts?.staleMs ?? 30_000;
	const abandonIncompleteMs = opts?.abandonIncompleteMs ?? 5_000;
	const ownerFile = path.join(lockPath, "owner.json");
	/** Fixed claim file: serializes every cooperative reclaim of this lock. */
	const reclaimClaimPath = `${lockPath}.reclaim-claim`;
	/** Grace before treating a malformed/empty claim as abandoned (wx→write race). */
	const CLAIM_BODY_GRACE_MS = 1_000;
	/**
	 * Grace before treating a live-PID claim whose observed generation is gone
	 * as orphaned. Must exceed the mid-reclaim free-path window (rename → publish).
	 */
	const CLAIM_ORPHAN_MS = 2_000;
	/** Max wall time spent in one progress-wait slice before re-checking the loop. */
	const PROGRESS_WAIT_SLICE_MS = 64;

	type ObservedLock = {
		device: number;
		inode: number;
		hasOwner: boolean;
		pid: number;
		token: string;
		age: number;
	};

	type HeldLock = { device: number; inode: number; token: string };

	type ClaimBody = {
		pid: number;
		device: number;
		inode: number;
		hasOwner: boolean;
		token: string;
		at: number;
	};

	function sleepMs(ms: number): void {
		if (ms <= 0) return;
		Atomics.wait(LOCK_RETRY_SIGNAL, 0, 0, ms);
	}

	/**
	 * Wait while `blocked()` stays true. Exponential backoff up to 32ms slices.
	 * Returns true if unblocked before `maxWaitMs`, false if still blocked.
	 */
	function waitWhileBlocked(blocked: () => boolean, maxWaitMs: number): boolean {
		const waitDeadline = Date.now() + maxWaitMs;
		let slice = 1;
		while (blocked()) {
			const now = Date.now();
			if (now >= waitDeadline) return false;
			sleepMs(Math.min(slice, waitDeadline - now, 32));
			slice = Math.min(slice * 2, 32);
		}
		return true;
	}

	function reclaimClaimPresent(): boolean {
		try {
			fs.lstatSync(reclaimClaimPath);
			return true;
		} catch {
			return false;
		}
	}

	function destroyTree(target: string): void {
		try {
			fs.rmSync(target, { recursive: true, force: true });
		} catch {
			try {
				fs.unlinkSync(target);
			} catch {
				/* ignore private discard cleanup */
			}
		}
	}

	/** Intentional claim removal — surface non-ENOENT failures (D3). */
	function unlinkClaimStrict(): void {
		try {
			fs.unlinkSync(reclaimClaimPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw new ControlStoreDurabilityError(
				`cannot remove exclusive-lock reclaim-claim: ${readFailureDetail(error)}`,
				reclaimClaimPath,
				error,
			);
		}
	}

	/** Best-effort claim drop on local reclaim failure paths only. */
	function unlinkClaimBestEffort(): void {
		try {
			fs.unlinkSync(reclaimClaimPath);
		} catch {
			/* local cleanup; a later cleanupAbandonedClaim will recover or surface */
		}
	}

	function readClaimBody(): ClaimBody | "malformed" | null {
		try {
			const raw = fs.readFileSync(reclaimClaimPath, "utf-8");
			if (!raw.trim()) return "malformed";
			const parsed = JSON.parse(raw) as Partial<ClaimBody>;
			if (
				typeof parsed.pid !== "number" ||
				typeof parsed.device !== "number" ||
				typeof parsed.inode !== "number" ||
				typeof parsed.hasOwner !== "boolean" ||
				typeof parsed.token !== "string" ||
				typeof parsed.at !== "number"
			) {
				return "malformed";
			}
			return {
				pid: parsed.pid,
				device: parsed.device,
				inode: parsed.inode,
				hasOwner: parsed.hasOwner,
				token: parsed.token,
				at: parsed.at,
			};
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") return null;
			return "malformed";
		}
	}

	function ownerTokenFromRecord(record: { lockId?: unknown; token?: unknown }): string {
		if (typeof record.token === "string" && record.token.length > 0) return record.token;
		if (typeof record.lockId === "string" && record.lockId.length > 0) return record.lockId;
		return "";
	}

	function observeLockDir(): ObservedLock | null {
		try {
			const st = fs.lstatSync(lockPath);
			if (st.isSymbolicLink() || !st.isDirectory()) {
				throw new ControlStoreDurabilityError(
					`exclusive lock path is not a real directory; refusing destructive migration: ${lockPath}`,
					lockPath,
				);
			}
			let hasOwner = false;
			let pid = 0;
			let token = "";
			try {
				const raw = fs.readFileSync(ownerFile, "utf-8");
				hasOwner = true;
				const parsed = JSON.parse(raw) as { pid?: number; lockId?: string; token?: string };
				pid = typeof parsed.pid === "number" ? parsed.pid : 0;
				token = ownerTokenFromRecord(parsed);
			} catch {
				/* owner not written yet */
			}
			return {
				device: st.dev,
				inode: st.ino,
				hasOwner,
				pid,
				token,
				age: Date.now() - st.mtimeMs,
			};
		} catch (error) {
			if (error instanceof ControlStoreDurabilityError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new ControlStoreDurabilityError(
				`cannot inspect contended exclusive lock: ${readFailureDetail(error)}`,
				lockPath,
				error,
			);
		}
	}

	function isPidAlive(pid: number): boolean {
		if (!Number.isSafeInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			// EPERM: process exists but is not probeable — treat as live.
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	/**
	 * Remove an abandoned / orphaned reclaim claim only (never the lock dir).
	 *
	 * - Dead claimant → claim is removed (strict; errors surface).
	 * - Malformed claim after CLAIM_BODY_GRACE_MS → removed.
	 * - Live claimant whose observed generation no longer matches the path, after
	 *   CLAIM_ORPHAN_MS, is recoverable (D3): otherwise a leftover claim with a
	 *   still-alive PID fences all successors unboundedly.
	 * - Live claimant with matching generation still present → leave claim.
	 */
	function cleanupAbandonedClaim(): void {
		if (!reclaimClaimPresent()) return;
		const body = readClaimBody();
		if (body === null) return;
		if (body === "malformed") {
			try {
				const st = fs.lstatSync(reclaimClaimPath);
				if (Date.now() - st.mtimeMs < CLAIM_BODY_GRACE_MS) return;
			} catch {
				return;
			}
			unlinkClaimStrict();
			return;
		}
		if (!isPidAlive(body.pid)) {
			unlinkClaimStrict();
			return;
		}

		// Live claimant: only reclaim ownership of the claim when it is orphaned.
		let current: ObservedLock | null;
		try {
			current = observeLockDir();
		} catch (error) {
			if (error instanceof ControlStoreDurabilityError) throw error;
			return;
		}
		const claimAge = Date.now() - body.at;
		if (current === null) {
			// Mid-reclaim free-path window is short; only treat as orphan after grace.
			if (claimAge >= CLAIM_ORPHAN_MS) unlinkClaimStrict();
			return;
		}
		const generationMatches =
			current.device === body.device &&
			current.inode === body.inode &&
			(!body.hasOwner || !body.token || current.token === body.token || !current.hasOwner);
		if (!generationMatches && claimAge >= CLAIM_ORPHAN_MS) {
			unlinkClaimStrict();
		}
	}

	/**
	 * Abandon a generation we just published (or partially published) when we
	 * cannot hand it to enterWithHeld. Identity-bound on device/inode; token is
	 * preferred when present but a partial owner.json must not leave our inode.
	 */
	function abandonPublishedHeld(held: HeldLock): void {
		try {
			releaseHeldLock(held, true);
		} catch {
			/* fall through to inode drop */
		}
		try {
			const st = fs.lstatSync(lockPath);
			if (!st.isDirectory() || st.dev !== held.device || st.ino !== held.inode) return;
			const drop = `${lockPath}.abandon.${process.pid}.${held.token.slice(0, 12)}`;
			try {
				fs.renameSync(lockPath, drop);
			} catch {
				return;
			}
			try {
				const dropped = fs.lstatSync(drop);
				if (!dropped.isDirectory() || dropped.dev !== held.device || dropped.ino !== held.inode) {
					try {
						fs.renameSync(drop, lockPath);
					} catch {
						/* ignore */
					}
					return;
				}
				destroyTree(drop);
			} catch {
				try {
					fs.renameSync(drop, lockPath);
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* already gone or replaced */
		}
	}

	/**
	 * Remove only the acquire-time generation. Requires matching device/inode +
	 * token, then rename to a private drop path and re-verify before destroy.
	 * A displaced successor is left intact (L1). Mismatch is not a throw: the
	 * finally of a deposed critical section must not fail the whole process.
	 * Once identity is proven and the drop is ours, fsync/directory durability
	 * failures must surface (not swallowed).
	 */
	function releaseHeldLock(held: HeldLock, ownerWritten: boolean): void {
		if (!ownerWritten) {
			dropIncompleteHeld(held);
			return;
		}
		let drop: string | undefined;
		try {
			const st = fs.lstatSync(lockPath);
			if (!st.isDirectory() || st.dev !== held.device || st.ino !== held.inode) return;
			let token = "";
			try {
				const raw = fs.readFileSync(ownerFile, "utf-8");
				token = ownerTokenFromRecord(JSON.parse(raw) as { lockId?: string; token?: string });
			} catch {
				return;
			}
			if (token !== held.token) return;
			const again = fs.lstatSync(lockPath);
			if (!again.isDirectory() || again.dev !== held.device || again.ino !== held.inode) return;
			drop = `${lockPath}.release.${process.pid}.${held.token.slice(0, 12)}`;
			try {
				fs.renameSync(lockPath, drop);
			} catch {
				return;
			}
			const dropped = fs.lstatSync(drop);
			if (!dropped.isDirectory() || dropped.dev !== held.device || dropped.ino !== held.inode) {
				try {
					fs.renameSync(drop, lockPath);
				} catch {
					/* non-cooperative race */
				}
				return;
			}
			let dropToken = "";
			try {
				dropToken = ownerTokenFromRecord(
					JSON.parse(fs.readFileSync(path.join(drop, "owner.json"), "utf-8")) as {
						lockId?: string;
						token?: string;
					},
				);
			} catch {
				try {
					fs.renameSync(drop, lockPath);
				} catch {
					/* ignore */
				}
				return;
			}
			if (dropToken !== held.token) {
				try {
					fs.renameSync(drop, lockPath);
				} catch {
					/* ignore */
				}
				return;
			}
		} catch (error) {
			// Inspection / identity-proof failures: never delete another owner's lock.
			if (drop !== undefined) {
				try {
					fs.renameSync(drop, lockPath);
				} catch {
					/* ignore */
				}
			}
			if (error instanceof ControlStoreDurabilityError) throw error;
			return;
		}
		// Identity proven — destroy and make parent durable; surface failures.
		destroyTree(drop!);
		fsyncDirectory(path.dirname(lockPath));
	}

	/** Drop an incomplete dir we created (no owner yet) if still our inode. */
	function dropIncompleteHeld(held: HeldLock): void {
		try {
			const st = fs.lstatSync(lockPath);
			if (!st.isDirectory() || st.dev !== held.device || st.ino !== held.inode) return;
			try {
				fs.accessSync(ownerFile);
				return; // owner landed — releaseHeldLock owns cleanup
			} catch {
				/* incomplete */
			}
			const drop = `${lockPath}.incomplete-drop.${process.pid}.${randomUUID().slice(0, 12)}`;
			try {
				fs.renameSync(lockPath, drop);
			} catch {
				return;
			}
			try {
				const dropped = fs.lstatSync(drop);
				if (!dropped.isDirectory() || dropped.dev !== held.device || dropped.ino !== held.inode) {
					try {
						fs.renameSync(drop, lockPath);
					} catch {
						/* ignore */
					}
					return;
				}
				destroyTree(drop);
			} catch {
				try {
					fs.renameSync(drop, lockPath);
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* already released or replaced */
		}
	}

	function matchesObservation(observed: ObservedLock, current: ObservedLock): boolean {
		if (current.device !== observed.device || current.inode !== observed.inode) return false;
		if (current.hasOwner !== observed.hasOwner) return false;
		if (observed.hasOwner) {
			if (observed.token && current.token !== observed.token) return false;
			if (!observed.token && current.token) return false;
		}
		return true;
	}

	function writeOwnerRecord(token: string): void {
		let fd: number | undefined;
		let failure: unknown;
		try {
			fd = fs.openSync(ownerFile, "wx", 0o600);
			fs.writeFileSync(
				fd,
				JSON.stringify({
					lockId: token,
					token,
					pid: process.pid,
					acquiredAt: Date.now(),
					at: Date.now(),
				}),
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

	/**
	 * Identity-bound reclaim of the observed generation. On success the caller
	 * holds a freshly published lock at `lockPath` and must run `fn` + release.
	 * Returns the held identity, or null if this contender must retry.
	 */
	function reclaimObservedGeneration(observed: ObservedLock): HeldLock | null {
		const claimBody = JSON.stringify({
			pid: process.pid,
			device: observed.device,
			inode: observed.inode,
			hasOwner: observed.hasOwner,
			token: observed.token,
			at: Date.now(),
		});
		try {
			const fd = fs.openSync(reclaimClaimPath, "wx", 0o600);
			try {
				fs.writeFileSync(fd, claimBody);
				try {
					fs.fsyncSync(fd);
				} catch {
					/* best-effort durability of claim body */
				}
			} finally {
				fs.closeSync(fd);
			}
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "EEXIST") return null;
			unlinkClaimBestEffort();
			throw new ControlStoreDurabilityError(
				`cannot create exclusive-lock reclaim-claim: ${readFailureDetail(error)}`,
				reclaimClaimPath,
				error,
			);
		}

		const discard = `${lockPath}.reclaim-discard.${process.pid}.${randomUUID().slice(0, 12)}`;
		// Tracks a publish that must be returned to the caller or abandoned.
		let held: HeldLock | null = null;
		try {
			const current = observeLockDir();
			if (!current || !matchesObservation(observed, current)) {
				unlinkClaimStrict();
				return null;
			}

			try {
				fs.renameSync(lockPath, discard);
			} catch {
				unlinkClaimStrict();
				return null;
			}

			try {
				const discarded = fs.lstatSync(discard);
				if (
					!discarded.isDirectory() ||
					discarded.dev !== observed.device ||
					discarded.ino !== observed.inode
				) {
					// TOCTOU: path held a different generation — restore it.
					try {
						fs.renameSync(discard, lockPath);
					} catch {
						/* peer may hold path — do not destroy unknown */
					}
					unlinkClaimStrict();
					return null;
				}
				if (observed.hasOwner) {
					let discardToken = "";
					try {
						discardToken = ownerTokenFromRecord(
							JSON.parse(fs.readFileSync(path.join(discard, "owner.json"), "utf-8")) as {
								lockId?: string;
								token?: string;
							},
						);
					} catch {
						try {
							fs.renameSync(discard, lockPath);
						} catch {
							/* ignore */
						}
						unlinkClaimStrict();
						return null;
					}
					if (observed.token && discardToken !== observed.token) {
						try {
							fs.renameSync(discard, lockPath);
						} catch {
							/* ignore */
						}
						unlinkClaimStrict();
						return null;
					}
				} else {
					try {
						fs.accessSync(path.join(discard, "owner.json"));
						// Became complete after observation — restore.
						try {
							fs.renameSync(discard, lockPath);
						} catch {
							/* ignore */
						}
						unlinkClaimStrict();
						return null;
					} catch {
						/* still incomplete */
					}
				}
			} catch {
				try {
					fs.renameSync(discard, lockPath);
				} catch {
					/* ignore */
				}
				unlinkClaimStrict();
				return null;
			}

			// Publish successor under the claim fence.
			// Once `held` is set, every exit path must either return it to the
			// caller (enterWithHeld/releaseHeldLock) or abandon the published
			// generation. A thrown claim-cleanup error must never strand a
			// live-PID owner lock that fences successors for process lifetime.
			const publishDeadline = Date.now() + 2_000;
			let publishBackoff = 1;
			while (Date.now() < publishDeadline) {
				try {
					fs.mkdirSync(lockPath);
					const heldStat = fs.lstatSync(lockPath);
					const token = randomUUID();
					held = { device: heldStat.dev, inode: heldStat.ino, token };
					writeOwnerRecord(token);
					break;
				} catch (error) {
					if (held) {
						// mkdir succeeded but owner publish failed — drop our inode.
						abandonPublishedHeld(held);
						held = null;
					}
					const err = error as NodeJS.ErrnoException;
					if (err.code !== "EEXIST") throw error;
					waitWhileBlocked(() => {
						try {
							fs.lstatSync(lockPath);
							return true;
						} catch {
							return false;
						}
					}, Math.min(publishBackoff, publishDeadline - Date.now()));
					publishBackoff = Math.min(publishBackoff * 2, 32);
				}
			}
			if (!held) {
				try {
					if (!fs.existsSync(lockPath)) fs.renameSync(discard, lockPath);
				} catch {
					/* ignore */
				}
				unlinkClaimStrict();
				if (fs.existsSync(discard)) destroyTree(discard);
				return null;
			}

			// Publish succeeded. Claim cleanup failure must not leave `held` standing.
			try {
				unlinkClaimStrict();
			} catch (claimError) {
				abandonPublishedHeld(held);
				held = null;
				try {
					destroyTree(discard);
				} catch {
					/* private discard */
				}
				throw claimError;
			}
			destroyTree(discard);
			return held;
		} catch (error) {
			if (held) {
				abandonPublishedHeld(held);
				held = null;
			}
			unlinkClaimBestEffort();
			try {
				if (fs.existsSync(discard) && !fs.existsSync(lockPath)) {
					fs.renameSync(discard, lockPath);
				} else if (fs.existsSync(discard)) {
					destroyTree(discard);
				}
			} catch {
				try {
					destroyTree(discard);
				} catch {
					/* ignore */
				}
			}
			throw error;
		}
	}

	function enterWithHeld(held: HeldLock): T {
		let ownerWritten = true;
		let hasPrimaryFailure = false;
		try {
			return fn();
		} catch (error) {
			hasPrimaryFailure = true;
			throw error;
		} finally {
			try {
				releaseHeldLock(held, ownerWritten);
			} catch (releaseError) {
				if (!hasPrimaryFailure) throw releaseError;
			}
		}
	}

	/**
	 * After exclusive mkdir, yield if a reclaim claim is in flight so we never
	 * enter the critical section on a free-path race against a reclaimer.
	 */
	function yieldIfReclaimClaim(held: HeldLock): boolean {
		if (!reclaimClaimPresent()) return false;
		dropIncompleteHeld(held);
		return true;
	}

	function sameGenerationPresent(gen: ObservedLock): boolean {
		const cur = observeLockDir();
		if (!cur) return false;
		if (cur.device !== gen.device || cur.inode !== gen.inode) return false;
		if (gen.hasOwner) {
			if (gen.token) return cur.token === gen.token;
			return cur.hasOwner;
		}
		return !cur.hasOwner;
	}

	function waitForClaimOrGeneration(gen: ObservedLock | null, maxWaitMs: number): void {
		waitWhileBlocked(() => {
			cleanupAbandonedClaim();
			if (reclaimClaimPresent()) return true;
			if (!gen) return false;
			if (!gen.hasOwner) {
				const cur = observeLockDir();
				if (!cur) return false;
				if (cur.device !== gen.device || cur.inode !== gen.inode) return false;
				if (cur.hasOwner) return isPidAlive(cur.pid);
				return cur.age <= abandonIncompleteMs;
			}
			if (!sameGenerationPresent(gen)) return false;
			const cur = observeLockDir();
			if (!cur) return false;
			if (cur.hasOwner && !isPidAlive(cur.pid) && cur.age > staleMs) return false;
			return true;
		}, maxWaitMs);
	}

	// Wall-clock acquire budget from timeoutMs. maxAttempts is a hard bound on
	// acquire passes (mkdir try / reclaim try / contended observe). Pure
	// progress waits on an in-flight claim or live generation do **not** burn
	// attempts — so N cooperative contenders complete under a tight budget
	// while a micro-spin regression exhausts maxAttempts and fails closed.
	const acquireDeadline = Date.now() + timeoutMs;
	const attemptBudget =
		Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : Number.MAX_SAFE_INTEGER;
	let attempts = 0;

	while (Date.now() < acquireDeadline && attempts < attemptBudget) {
		const remaining = () => Math.max(0, acquireDeadline - Date.now());
		const slice = () => Math.min(PROGRESS_WAIT_SLICE_MS, remaining());

		cleanupAbandonedClaim();
		if (reclaimClaimPresent()) {
			// Waiting on a peer reclaim does not consume the attempt budget.
			if (slice() === 0) break;
			waitForClaimOrGeneration(null, slice());
			continue;
		}

		// One acquire pass: free-path mkdir, or contended observe/reclaim/wait.
		attempts += 1;

		// Migrate leftover file locks from older builds (legacy path only).
		try {
			const st = fs.lstatSync(lockPath);
			if (st.isFile()) {
				try {
					fs.unlinkSync(lockPath);
				} catch {
					/* race */
				}
			} else if (st.isSymbolicLink() || !st.isDirectory()) {
				throw new ControlStoreDurabilityError(
					`exclusive lock path is not a real directory; refusing destructive migration: ${lockPath}`,
					lockPath,
				);
			}
		} catch (error) {
			if (error instanceof ControlStoreDurabilityError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new ControlStoreDurabilityError(
					`cannot inspect contended exclusive lock: ${readFailureDetail(error)}`,
					lockPath,
					error,
				);
			}
		}

		let contended = false;
		try {
			fs.mkdirSync(lockPath); // atomic exclusive create
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") {
				if (e instanceof ControlStoreDurabilityError) throw e;
				throw new ControlStoreDurabilityError(
					`cannot create exclusive lock directory: ${readFailureDetail(e)}`,
					lockPath,
					e,
				);
			}
			contended = true;
		}

		if (!contended) {
			const heldStat = fs.lstatSync(lockPath);
			const token = randomUUID();
			const held: HeldLock = { device: heldStat.dev, inode: heldStat.ino, token };
			if (yieldIfReclaimClaim(held)) {
				if (slice() === 0) break;
				waitForClaimOrGeneration(null, slice());
				continue;
			}
			try {
				writeOwnerRecord(token);
			} catch (writeErr) {
				dropIncompleteHeld(held);
				throw writeErr;
			}
			if (reclaimClaimPresent()) {
				const stillOurs = (() => {
					try {
						const st = fs.lstatSync(lockPath);
						return st.isDirectory() && st.dev === held.device && st.ino === held.inode;
					} catch {
						return false;
					}
				})();
				if (!stillOurs) {
					if (slice() === 0) break;
					waitForClaimOrGeneration(null, slice());
					continue;
				}
			}
			// Critical-section body errors must propagate unchanged (e.g. TF_AUTHORITY_REVOKED).
			return enterWithHeld(held);
		}

		// Contended, incomplete, or stale lock dir — never blind pathname rm.
		cleanupAbandonedClaim();
		if (reclaimClaimPresent()) {
			if (slice() === 0) break;
			waitForClaimOrGeneration(null, slice());
			continue;
		}

		let observed: ObservedLock | null;
		try {
			observed = observeLockDir();
		} catch (error) {
			if (error instanceof ControlStoreDurabilityError) throw error;
			throw new ControlStoreDurabilityError(
				`cannot inspect contended exclusive lock: ${readFailureDetail(error)}`,
				lockPath,
				error,
			);
		}
		if (!observed) {
			sleepMs(Math.min(1, remaining()));
			continue;
		}

		let eligible = false;
		if (!observed.hasOwner) {
			// Do NOT reclaim during the mkdir→write window of a live holder.
			eligible = observed.age > abandonIncompleteMs;
		} else if (!isPidAlive(observed.pid) && observed.age > staleMs) {
			eligible = true;
		}

		if (eligible) {
			const held = reclaimObservedGeneration(observed);
			if (held) return enterWithHeld(held);
			if (slice() === 0) break;
			waitForClaimOrGeneration(null, slice());
			continue;
		}

		// Live owner or incomplete grace: progress-wait on this generation.
		// Does not burn further attempts until this wait returns.
		if (remaining() === 0) break;
		waitForClaimOrGeneration(observed, remaining());
	}
	throw new ControlStoreDurabilityError(
		`could not acquire exclusive lock within ${timeoutMs}ms; refusing unsafe stale reclamation`,
		lockPath,
	);
}
