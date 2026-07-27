/**
 * User-level singleton multi-mount lock (D32 / P13).
 *
 * Protocol:
 * - write and fsync a complete owner record under a unique same-directory name;
 * - publish it with hard-link create (which never overwrites an existing owner);
 * - serialize normal acquire/release transitions; an unprovable stale owner is
 *   retained and reported as a durable recovery boundary rather than removed.
 *
 * A writer carries its immutable fencing record. Every mutation-capable host
 * must re-check that record before acting; a replacement epoch fences the old
 * writer even if its process still happens to be alive.
 *
 * Unix GA: lock file + UDS path for transport. Windows named-pipe remains
 * explicitly non-GA until the equivalent protocol is proven there.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	assertNoSymbolicLinkBelow,
	ControlStoreDurabilityError,
	ensureDir,
	fsyncDirectory,
	readJsonFileStrict,
	singletonLockPath,
	udsPath,
	userControlRoot,
	userHome,
	withExclusiveLockFile,
	writeFileAtomic,
} from "./paths.ts";

export interface SingletonLockInfo {
	holderId: string;
	pid: number;
	/** Monotonic fencing token; a future verified takeover must increase it. */
	fencingEpoch: number;
	endpoint: string;
	acquiredAt: number;
}

/**
 * Process-local capability minted only for the process that won singleton
 * publication. Runtime authority comes from private WeakMap membership, never
 * from a caller-supplied epoch or a deserialized lock record.
 */
export interface SingletonMutationAuthority {
	readonly __singletonMutationAuthority?: never;
}

export type SingletonResult =
	| { role: "writer"; lock: SingletonLockInfo; mutationAuthority: SingletonMutationAuthority }
	| { role: "attach"; lock: SingletonLockInfo };

const mutationAuthorityLocks = new WeakMap<object, SingletonLockInfo>();

type UnmintedSingletonResult =
	| { role: "writer"; lock: SingletonLockInfo }
	| { role: "attach"; lock: SingletonLockInfo };

/** Raised when a mutation reaches the singleton fence after its epoch was lost. */
export class SingletonAuthorityError extends Error {
	readonly code = "TF_AUTHORITY_REVOKED" as const;

	constructor(message = "singleton writer lost its fencing epoch") {
		super(`TF_AUTHORITY_REVOKED: ${message}`);
		this.name = "SingletonAuthorityError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalidLock(lockPath: string, message: string): never {
	throw new ControlStoreDurabilityError(`singleton owner ${message}`, lockPath);
}

function validateLock(
	value: unknown,
	lockPath: string,
	expectedEndpoint: string,
): SingletonLockInfo {
	if (!isRecord(value)) invalidLock(lockPath, "must be a JSON object");
	if (
		!isNonEmptyString(value.holderId) ||
		!isPositiveSafeInteger(value.pid) ||
		!isNonNegativeSafeInteger(value.fencingEpoch) ||
		!isNonEmptyString(value.endpoint) ||
		!isNonNegativeSafeInteger(value.acquiredAt)
	) {
		invalidLock(lockPath, "has an invalid fencing record");
	}
	if (value.endpoint !== expectedEndpoint) {
		invalidLock(lockPath, "references an unexpected UDS endpoint");
	}
	return value as unknown as SingletonLockInfo;
}

/** `null` means only that no singleton owner exists at the instant of reading. */
function readLock(lockPath: string, expectedEndpoint: string): SingletonLockInfo | null {
	const raw = readJsonFileStrict<unknown>(lockPath);
	return raw === null ? null : validateLock(raw, lockPath, expectedEndpoint);
}

function isSameLock(a: SingletonLockInfo, b: SingletonLockInfo): boolean {
	return (
		a.holderId === b.holderId &&
		a.pid === b.pid &&
		a.fencingEpoch === b.fencingEpoch &&
		a.endpoint === b.endpoint &&
		a.acquiredAt === b.acquiredAt
	);
}

function mintMutationAuthority(lock: SingletonLockInfo): SingletonMutationAuthority {
	const authority = Object.freeze({}) as SingletonMutationAuthority;
	mutationAuthorityLocks.set(authority, lock);
	return authority;
}

function lockForMutationAuthority(authority: unknown): SingletonLockInfo {
	if (typeof authority !== "object" || authority === null) {
		throw new SingletonAuthorityError("singleton mutation requires a live writer capability");
	}
	const lock = mutationAuthorityLocks.get(authority);
	if (!lock) {
		throw new SingletonAuthorityError("singleton mutation capability is not held by this process");
	}
	return lock;
}

/**
 * EPERM means another-user process exists but cannot be probed: treat it as
 * live. A false result is deliberately not takeover authorization: PID
 * liveness cannot prove holder identity after reuse.
 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function candidatePath(lockPath: string): string {
	return path.join(
		path.dirname(lockPath),
		`.${path.basename(lockPath)}.${process.pid}.${randomUUID()}.candidate`,
	);
}

/** Write a complete and durable owner record before it is visible as the lock. */
function writeOwnerCandidate(lockPath: string, owner: SingletonLockInfo): string {
	const candidate = candidatePath(lockPath);
	let fd: number | undefined;
	let failure: unknown;
	try {
		fd = fs.openSync(candidate, "wx", 0o600);
		fs.writeFileSync(fd, JSON.stringify(owner, null, 2), "utf-8");
		fs.fsyncSync(fd);
	} catch (error) {
		failure = error;
	}
	if (fd !== undefined) {
		try {
			fs.closeSync(fd);
		} catch (error) {
			// A close fault is causal only after the write/fsync path succeeded;
			// preserve the earlier write fault if both occurred.
			if (failure === undefined) failure = error;
		}
	}
	if (failure !== undefined) {
		try {
			fs.unlinkSync(candidate);
		} catch {
			/* best-effort cleanup of an unpublished candidate */
		}
		throw new ControlStoreDurabilityError(
			`cannot durably write singleton owner candidate: ${failure instanceof Error ? failure.message : String(failure)}`,
			candidate,
			failure,
		);
	}
	return candidate;
}

function discardCandidate(candidate: string): void {
	try {
		fs.unlinkSync(candidate);
		fsyncDirectory(path.dirname(candidate));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// An orphan candidate cannot become authoritative, so keep the original
			// protocol outcome and leave cleanup to a later maintenance pass.
		}
	}
}

/**
 * Atomic publish: `link` creates the destination only when it does not exist.
 * Unlike rename, it cannot replace a concurrently published live owner.
 */
function publishCandidate(candidate: string, lockPath: string): boolean {
	try {
		fs.linkSync(candidate, lockPath);
		fsyncDirectory(path.dirname(lockPath));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw new ControlStoreDurabilityError(
			`cannot durably publish singleton owner candidate: ${error instanceof Error ? error.message : String(error)}`,
			lockPath,
			error,
		);
	}
}

function singletonAuthorityLockPath(lockPath: string): string {
	return `${lockPath}.authority`;
}

function fencingEpochPath(lockPath: string): string {
	return `${lockPath}.epoch.json`;
}

/**
 * The user home is the selected trust boundary. Singleton authority, its
 * transition lock, epoch sidecar, and UDS endpoint must remain beneath a real
 * `.taskflow/control` tree rather than follow a pre-existing descendant link.
 */
function assertSingletonPathsHaveNoSymlinks(env: NodeJS.ProcessEnv): void {
	const root = userHome(env);
	const lockPath = singletonLockPath(env);
	for (const durablePath of [
		userControlRoot(env),
		lockPath,
		singletonAuthorityLockPath(lockPath),
		fencingEpochPath(lockPath),
		udsPath(env),
	]) {
		assertNoSymbolicLinkBelow(root, durablePath);
	}
}

function readLastIssuedEpoch(epochPath: string): number {
	const raw = readJsonFileStrict<unknown>(epochPath);
	if (raw === null) return 0;
	if (!isRecord(raw) || !isNonNegativeSafeInteger(raw.lastIssuedEpoch)) {
		throw new ControlStoreDurabilityError(
			"singleton fencing epoch state has an invalid shape",
			epochPath,
		);
	}
	return raw.lastIssuedEpoch;
}

/**
 * Allocate a durable, never-reused fencing epoch. The caller holds the
 * singleton authority lock. This sidecar is necessary
 * even after clean release: an old writer with the same holderId/PID must not
 * become authoritative again merely because Date.now() repeated a millisecond.
 * Burned epochs from losing contenders are harmless; reuse is not.
 */
function allocateFencingEpochUnlocked(lockPath: string, strictlyAfter = 0): number {
	const epochPath = fencingEpochPath(lockPath);
	const last = readLastIssuedEpoch(epochPath);
	if (
		last >= Number.MAX_SAFE_INTEGER - 1 ||
		strictlyAfter >= Number.MAX_SAFE_INTEGER - 1
	) {
		throw new ControlStoreDurabilityError("singleton fencing epoch overflow", epochPath);
	}
	const next = Math.max(Date.now(), last + 1, strictlyAfter + 1);
	writeFileAtomic(epochPath, JSON.stringify({ lastIssuedEpoch: next }, null, 2));
	return next;
}

/**
 * Serialize normal singleton acquisition/release transitions. Owner
 * publication is hard-link create, so a fresh contender cannot overwrite an
 * existing pathname. A dead-looking owner is not automatically reclaimed:
 * POSIX/Node offer no compare-and-unlink primitive that binds the observed
 * owner inode to a later unlink, and PID liveness cannot distinguish reuse.
 * P13 therefore requires an OS-backed holder-identity/replacement protocol
 * before automatic stale recovery can be enabled.
 */
function acquireUnderAuthorityLock(
	lockPath: string,
	ownerTemplate: Omit<SingletonLockInfo, "fencingEpoch" | "acquiredAt">,
): UnmintedSingletonResult | undefined {
	return withExclusiveLockFile(
		singletonAuthorityLockPath(lockPath),
		() => {
			const current = readLock(lockPath, ownerTemplate.endpoint);
			if (current && isPidAlive(current.pid)) return { role: "attach", lock: current };
			if (current) {
				throw new ControlStoreDurabilityError(
					`singleton owner pid ${current.pid} is not provably reclaimable; ` +
						"refusing PID/pathname-based stale takeover without an OS-backed compare-and-replace protocol",
					lockPath,
				);
			}

			const now = Date.now();
			const replacement: SingletonLockInfo = {
				...ownerTemplate,
				fencingEpoch: allocateFencingEpochUnlocked(lockPath),
				acquiredAt: now,
			};
			const candidate = writeOwnerCandidate(lockPath, replacement);
			try {
				if (publishCandidate(candidate, lockPath)) {
					return { role: "writer", lock: replacement };
				}

				// A direct fresh contender published first. Preserve it; never rename
				// over it. If it already died, the next outer attempt will fail closed
				// rather than deleting a pathname based on a stale observation.
				const winner = readLock(lockPath, ownerTemplate.endpoint);
				return winner && isPidAlive(winner.pid)
					? { role: "attach", lock: winner }
					: undefined;
			} finally {
				discardCandidate(candidate);
			}
		},
		{ maxAttempts: 10_000, timeoutMs: 30_000 },
	);
}

/**
 * Acquire or attach to the user singleton.
 *
 * Never forks an independent multi-mount authority on lock failure. Corrupt
 * owner records are durable failures, not evidence that an owner is dead.
 */
export function acquireOrAttachSingleton(
	holderId: string,
	env: NodeJS.ProcessEnv = process.env,
): SingletonResult {
	if (!holderId.trim()) {
		throw new Error("TF_BOOTSTRAP_FAILED: singleton holderId must be non-empty");
	}
	assertSingletonPathsHaveNoSymlinks(env);
	ensureDir(userControlRoot(env));
	const lockPath = singletonLockPath(env);
	const endpoint = udsPath(env);

	const ownerTemplate: Omit<SingletonLockInfo, "fencingEpoch" | "acquiredAt"> = {
		holderId,
		pid: process.pid,
		endpoint,
	};
	for (let attempt = 0; attempt < 250; attempt++) {
		const result = acquireUnderAuthorityLock(lockPath, ownerTemplate);
		if (result?.role === "writer") {
			return { ...result, mutationAuthority: mintMutationAuthority(result.lock) };
		}
		if (result) return result;

		// A concurrent fresh contender published first but vanished before the
		// observation. Retry only the non-overwriting acquisition; if its record
		// is still present on the next pass, recovery fails closed.
	}

	throw new Error(
		`TF_BOOTSTRAP_FAILED: singleton contention did not resolve safely at ${lockPath}`,
	);
}

/**
 * True only when the exact durable fencing record still belongs to this writer.
 * A damaged/missing owner is deliberately treated as non-authoritative.
 */
export function isWriterStillAuthoritative(
	local: SingletonLockInfo,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	try {
		assertSingletonPathsHaveNoSymlinks(env);
		const durable = readLock(singletonLockPath(env), udsPath(env));
		return durable !== null && isSameLock(durable, local);
	} catch {
		return false;
	}
}

/**
 * Hold the singleton transition lock across one synchronous durable mutation.
 * Takeover/release uses the same lock, so an old epoch cannot pass a check and
 * then write after a replacement has become authoritative.
 */
function withSingletonMutationFence<T>(
	local: SingletonLockInfo,
	fn: () => T,
	env: NodeJS.ProcessEnv = process.env,
): T {
	assertSingletonPathsHaveNoSymlinks(env);
	const lockPath = singletonLockPath(env);
	const endpoint = udsPath(env);
	return withExclusiveLockFile(
		singletonAuthorityLockPath(lockPath),
		() => {
			const durable = readLock(lockPath, endpoint);
			if (!durable || !isSameLock(durable, local)) {
				throw new SingletonAuthorityError();
			}
			return fn();
		},
		{ maxAttempts: 10_000, timeoutMs: 30_000 },
	);
}

/**
 * Execute a mutation using the in-memory capability created for the current
 * singleton writer. A copied JSON lock record cannot satisfy this boundary.
 */
export function withSingletonMutationAuthority<T>(
	authority: SingletonMutationAuthority,
	fn: () => T,
	env: NodeJS.ProcessEnv = process.env,
): T {
	return withSingletonMutationFence(lockForMutationAuthority(authority), fn, env);
}

/** True only while this process-held capability still names the durable writer. */
export function isSingletonMutationAuthorityCurrent(
	authority: SingletonMutationAuthority,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	try {
		return isWriterStillAuthoritative(lockForMutationAuthority(authority), env);
	} catch {
		return false;
	}
}

/** Immutable epoch carried by a process-held writer capability. */
export function singletonMutationAuthorityEpoch(authority: SingletonMutationAuthority): number {
	return lockForMutationAuthority(authority).fencingEpoch;
}

/**
 * Release requires the opaque process-held writer capability, not a serialized
 * SingletonLockInfo. A fenced old writer may never unlink a replacement owner.
 */
export function releaseSingleton(
	authority: SingletonMutationAuthority,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const local = lockForMutationAuthority(authority);
	assertSingletonPathsHaveNoSymlinks(env);
	const lockPath = singletonLockPath(env);
	const endpoint = udsPath(env);
	withExclusiveLockFile(
		singletonAuthorityLockPath(lockPath),
		() => {
			const durable = readLock(lockPath, endpoint);
			if (!durable || !isSameLock(durable, local)) return;
			try {
				fs.unlinkSync(lockPath);
				fsyncDirectory(path.dirname(lockPath));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},
		{ maxAttempts: 10_000, timeoutMs: 30_000 },
	);
}
