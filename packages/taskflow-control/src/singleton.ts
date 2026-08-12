/**
 * User singleton lock + coordination endpoint + fencing (P13 / RFC §5.1 D32).
 *
 * Contract implemented here (P13 "排他锁语义" + fresh-install §5.2):
 * - Owner publishes via hard-link create — never rename-overwrite.
 * - Malformed singleton metadata fails closed.
 * - Dead-PID takeover stays fail-closed: reclaim only when the owner is
 *   provably dead (liveness probe) AND the record's birth token still matches
 *   (PID reuse cannot inherit a live holder's lock).
 * - Collaborative competitors use identity-bound reclaim: fixed claim file +
 *   O_EXCL + generation check + rename-to-discard + recoverable claim cleanup.
 * - Release = compare-and-delete on acquire-time device/inode + owner token
 *   (rename-to-discard).
 * - Stale endpoint recovery: dead peer ⇒ remove socket file ⇒ restart.
 * - Fencing: every acquire/reclaim bumps the CoordinatorLease epoch; RPCs
 *   carrying an older epoch are rejected (TF_AUTHORITY_REVOKED).
 *
 * TE's `resources/*` persistence helpers are deliberately not exported by
 * taskflow-core, so this module re-implements the small POSIX primitives
 * (atomic write, process birth token) with the same fail-closed discipline.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import { bootstrapFailed, ControlError } from "./errors.ts";
import { CoordinatorLeaseSchema, type CoordinatorLease } from "./schema/coordinator.ts";

// ---------------------------------------------------------------------------
// Layout (P13): user `~/.taskflow/control/` (TASKFLOW_HOME overridable)
// ---------------------------------------------------------------------------

export const TASKFLOW_HOME_ENV = "TASKFLOW_HOME";
export const DEFAULT_CONTROL_DIR_NAME = "control";

export function userTaskflowHome(homeOverride?: string): string {
	return homeOverride ?? process.env[TASKFLOW_HOME_ENV] ?? path.join(os.homedir(), ".taskflow");
}

export function userControlHome(homeOverride?: string): string {
	return path.join(userTaskflowHome(homeOverride), DEFAULT_CONTROL_DIR_NAME);
}

export interface SingletonPaths {
	controlHome: string;
	/** Hard-link-created owner record (never rename-overwrite). */
	lockPath: string;
	/** Coordination endpoint (Unix UDS path / pipe name). */
	endpointPath: string;
	/** Renewable CoordinatorLease record (P16 wire type). */
	leasePath: string;
}

export function singletonPaths(controlHome?: string): SingletonPaths {
	const home = controlHome ?? userControlHome();
	return {
		controlHome: home,
		lockPath: path.join(home, "singleton.lock.json"),
		endpointPath: path.join(home, "taskflow.sock"),
		leasePath: path.join(home, "coordinator-lease.json"),
	};
}

// ---------------------------------------------------------------------------
// Process identity + liveness (fail-closed mirrors of TE persistence helpers)
// ---------------------------------------------------------------------------

export type BirthTokenKind = "native" | "opaque";

export interface ProcessIdentityLike {
	pid: number;
	birthToken: string;
	birthTokenKind: BirthTokenKind;
}

export interface ObservedProcessLike {
	alive: boolean;
	birthToken?: string;
	birthTokenKind?: BirthTokenKind;
}

/** Exact, platform-native process-birth identity; never an uptime estimate. */
export function readProcessBirthToken(pid: number): string | undefined {
	if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
	try {
		if (process.platform === "linux") {
			const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
			const commandEnd = stat.lastIndexOf(")");
			if (!bootId || commandEnd < 0) return undefined;
			const startTicks = stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
			if (!/^\d+$/.test(startTicks ?? "")) return undefined;
			return `linux:${bootId}:${startTicks}`;
		}
		return undefined; // macOS/others: fail closed (never reclaim a possibly-live owner)
	} catch {
		return undefined;
	}
}

export function defaultProcessIdentity(): ProcessIdentityLike {
	const native = readProcessBirthToken(process.pid);
	return {
		pid: process.pid,
		birthToken: native ?? `opaque:${crypto.randomUUID()}`,
		birthTokenKind: native === undefined ? "opaque" : "native",
	};
}

export function defaultProcessInspector(pid: number): ObservedProcessLike {
	if (pid === process.pid) {
		const identity = defaultProcessIdentity();
		return { alive: true, birthToken: identity.birthToken, birthTokenKind: identity.birthTokenKind };
	}
	try {
		process.kill(pid, 0);
		const birthToken = readProcessBirthToken(pid);
		return birthToken === undefined
			? { alive: true }
			: { alive: true, birthToken, birthTokenKind: "native" };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EPERM") return { alive: false };
		const birthToken = readProcessBirthToken(pid);
		return birthToken === undefined
			? { alive: true }
			: { alive: true, birthToken, birthTokenKind: "native" };
	}
}

// ---------------------------------------------------------------------------
// Singleton lock record (immutable; published by hard-link create)
// ---------------------------------------------------------------------------

export const SINGLETON_LOCK_VERSION = 1;

export interface SingletonLockRecord {
	version: typeof SINGLETON_LOCK_VERSION;
	holderId: string;
	pid: number;
	birthToken: string;
	birthTokenKind: BirthTokenKind;
	fencingEpoch: number;
	endpoint: string;
	acquiredAt: number;
}

export interface ClaimRecord {
	version: 1;
	claimantId: string;
	pid: number;
	birthToken: string;
	birthTokenKind: BirthTokenKind;
	createdAt: number;
	/** Generation (acquiredAt) of the lock record the claimant observed. */
	targetGeneration: number;
}

function validateLockRecord(value: unknown): SingletonLockRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw bootstrapFailed("malformed singleton lock record: not an object");
	}
	const record = value as Record<string, unknown>;
	if (
		record.version !== SINGLETON_LOCK_VERSION ||
		typeof record.holderId !== "string" ||
		!Number.isSafeInteger(record.pid) ||
		typeof record.birthToken !== "string" ||
		(record.birthTokenKind !== "native" && record.birthTokenKind !== "opaque") ||
		!Number.isSafeInteger(record.fencingEpoch) ||
		typeof record.endpoint !== "string" ||
		!Number.isSafeInteger(record.acquiredAt)
	) {
		throw bootstrapFailed("malformed singleton lock record: missing or invalid fields");
	}
	return record as unknown as SingletonLockRecord;
}

function validateClaimRecord(value: unknown): ClaimRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw bootstrapFailed("malformed singleton reclaim claim: not an object");
	}
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.claimantId !== "string" ||
		!Number.isSafeInteger(record.pid) ||
		typeof record.birthToken !== "string" ||
		(record.birthTokenKind !== "native" && record.birthTokenKind !== "opaque") ||
		!Number.isSafeInteger(record.createdAt) ||
		!Number.isSafeInteger(record.targetGeneration)
	) {
		throw bootstrapFailed("malformed singleton reclaim claim: missing or invalid fields");
	}
	return record as unknown as ClaimRecord;
}

// ---------------------------------------------------------------------------
// Durability primitives (mirror of TE writeJsonAtomicDurable)
// ---------------------------------------------------------------------------

function ensurePrivateDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		const stat = fs.statSync(directory);
		if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
	}
}

function fsyncDirectory(directory: string): void {
	try {
		const fd = fs.openSync(directory, "r");
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	} catch { /* best effort */ }
}

export function writeJsonAtomicDurable(filePath: string, value: unknown): void {
	ensurePrivateDirectory(path.dirname(filePath));
	const temp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
	const fd = fs.openSync(temp, "wx", 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(value));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.renameSync(temp, filePath);
		fsyncDirectory(path.dirname(filePath));
	} catch (error) {
		try { fs.unlinkSync(temp); } catch { /* best effort */ }
		throw error;
	}
}

function readJsonOrNull<T>(filePath: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Singleton acquire / attach / release / reclaim
// ---------------------------------------------------------------------------

export interface SingletonOptions {
	paths: SingletonPaths;
	holderId?: string;
	processIdentity?: ProcessIdentityLike;
	inspectProcess?: (pid: number) => ObservedProcessLike;
	now?: () => number;
	/** Hard pass budget (P13: maxAttempts is a pass budget, not spins×K). */
	maxAttempts?: number;
	/** Renewal TTL for the CoordinatorLease (default 30s; renew while held). */
	leaseTtlMs?: number;
	/**
	 * coordinated mode (P13): attach to an existing winner only. No lock
	 * publication and no reclaim — a missing/dead control fails closed with
	 * TF_JOURNAL_UNAVAILABLE instead of being started.
	 */
	attachOnly?: boolean;
}

export type SingletonAcquireResult =
	| {
			status: "won";
			holderId: string;
			fencingEpoch: number;
			endpoint: string;
			/** Compare-and-delete release (rename-to-discard). */
			release: () => void;
	  }
	| {
			status: "attached";
			/** Winner's identity — this process attaches as a client (D32). */
			holderId: string;
			fencingEpoch: number;
			endpoint: string;
	  };

function ownerIsDead(record: SingletonLockRecord, identity: ProcessIdentityLike, inspect: (pid: number) => ObservedProcessLike): boolean {
	return ownerIdentityIsDead(record.pid, record.birthToken, record.birthTokenKind, identity, inspect);
}

function ownerIdentityIsDead(
	pid: number,
	birthToken: string,
	birthTokenKind: BirthTokenKind,
	identity: ProcessIdentityLike,
	inspect: (pid: number) => ObservedProcessLike,
): boolean {
	if (pid === identity.pid) {
		// Opaque tokens identify one module instance, not an OS process. Only
		// native kernel birth tokens are comparable across instances.
		return birthTokenKind === "native" && identity.birthTokenKind === "native" &&
			birthToken !== identity.birthToken;
	}
	const observed = inspect(pid);
	if (!observed.alive) return true;
	// Alive but unidentifiable owners are never reclaimed (fail closed).
	if (birthTokenKind !== "native" || observed.birthTokenKind !== "native" || observed.birthToken === undefined) return false;
	return observed.birthToken !== birthToken;
}

function publishLockByHardLink(lockPath: string, record: SingletonLockRecord): void {
	ensurePrivateDirectory(path.dirname(lockPath));
	const temp = `${lockPath}.publish.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
	const fd = fs.openSync(temp, "wx", 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(record));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		// Hard-link create — never rename-overwrite (P13).
		fs.linkSync(temp, lockPath);
		fs.unlinkSync(temp);
		fsyncDirectory(path.dirname(lockPath));
	} catch (error) {
		try { fs.unlinkSync(temp); } catch { /* best effort */ }
		throw error;
	}
}

function readLockRecord(paths: SingletonPaths): SingletonLockRecord | null {
	try {
		const value = readJsonOrNull<unknown>(paths.lockPath);
		return value === null ? null : validateLockRecord(value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function readLease(paths: SingletonPaths): CoordinatorLease | null {
	try {
		const value = readJsonOrNull<unknown>(paths.leasePath);
		if (value === null) return null;
		return Value.Parse(CoordinatorLeaseSchema, value) as CoordinatorLease;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function writeLease(paths: SingletonPaths, lease: CoordinatorLease): void {
	writeJsonAtomicDurable(paths.leasePath, lease);
}

function claimPath(paths: SingletonPaths): string {
	return `${paths.lockPath}.claim`;
}

function discardPath(paths: SingletonPaths, token: string): string {
	return `${paths.lockPath}.discard.${token}`;
}

/** True when the exact lock inode is still ours (compare-and-delete check). */
function lockInodeMatches(paths: SingletonPaths, expected: { dev: bigint; ino: bigint }): boolean {
	try {
		const stat = fs.statSync(paths.lockPath, { bigint: true });
		return stat.dev === expected.dev && stat.ino === expected.ino;
	} catch {
		return false;
	}
}

export function acquireUserSingleton(options: SingletonOptions): SingletonAcquireResult {
	const { paths } = options;
	const identity = options.processIdentity ?? defaultProcessIdentity();
	const inspect = options.inspectProcess ?? defaultProcessInspector;
	const now = options.now ?? Date.now;
	const holderId = options.holderId ?? crypto.randomUUID();
	const endpoint = paths.endpointPath;
	const maxAttempts = options.maxAttempts ?? 8;
	const leaseTtlMs = options.leaseTtlMs ?? 30_000;

	ensurePrivateDirectory(paths.controlHome);

	// coordinated (attach-only): the external control must already be alive.
	if (options.attachOnly === true) {
		const existing = readLockRecord(paths);
		if (existing === null || ownerIsDead(existing, identity, inspect)) {
			throw new ControlError(
				"TF_JOURNAL_UNAVAILABLE",
				"coordinated mode requires an external control which is down; failing closed (P13)",
				{ recoveryAction: "refresh", sideEffects: "none" },
			);
		}
		return {
			status: "attached",
			holderId: existing.holderId,
			fencingEpoch: existing.fencingEpoch,
			endpoint: existing.endpoint,
		};
	}

	let published: { dev: bigint; ino: bigint } | undefined;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		// 1) Try to publish the lock by hard-link create.
		const record: SingletonLockRecord = {
			version: SINGLETON_LOCK_VERSION,
			holderId,
			pid: identity.pid,
			birthToken: identity.birthToken,
			birthTokenKind: identity.birthTokenKind,
			fencingEpoch: 1,
			endpoint,
			acquiredAt: now(),
		};
		try {
			publishLockByHardLink(paths.lockPath, record);
			// 2) Fresh-install win: lease starts at epoch 1 (P13: fencing epoch 0
			//    only in the BootstrapManifest before the first acquisition).
			writeLease(paths, {
				holderId,
				fencingEpoch: 1,
				endpoint,
				expiresAt: now() + leaseTtlMs,
			});
			const stat = fs.statSync(paths.lockPath, { bigint: true });
			published = { dev: stat.dev, ino: stat.ino };
			return {
				status: "won",
				holderId,
				fencingEpoch: 1,
				endpoint,
				release: () => releaseUserSingleton(paths, { holderId, dev: published!.dev, ino: published!.ino }),
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "ENOENT" && code !== "EPERM") throw error;
			// Lock exists or the publish raced — fall through to inspect/reclaim.
		}

		// 3) Inspect the existing lock record.
		const existing = readLockRecord(paths);
		if (existing === null) continue; // vanished between publish and inspect — retry

		// 4) Loser attaches to a live winner (D32) — never run dual authority.
		if (!ownerIsDead(existing, identity, inspect)) {
			return {
				status: "attached",
				holderId: existing.holderId,
				fencingEpoch: existing.fencingEpoch,
				endpoint: existing.endpoint,
			};
		}

		// 5) Identity-bound reclaim of a dead owner (fail-closed).
		const reclaimed = reclaimStaleLock(paths, existing, identity, inspect, now, endpoint, leaseTtlMs);
		if (reclaimed) {
			const stat = fs.statSync(paths.lockPath, { bigint: true });
			published = { dev: stat.dev, ino: stat.ino };
			return {
				status: "won",
				holderId,
				fencingEpoch: existing.fencingEpoch + 1,
				endpoint,
				release: () => releaseUserSingleton(paths, { holderId, dev: published!.dev, ino: published!.ino }),
			};
		}
		// Reclaim lost the race or could not be completed; retry with the pass
		// budget (maxAttempts is a hard pass budget — P13).
	}
	throw bootstrapFailed(`could not acquire the user singleton lock after ${maxAttempts} pass(es) (${paths.lockPath})`);
}

/**
 * Identity-bound reclaim: fixed claim file + O_EXCL + generation check +
 * rename-to-discard + recoverable claim cleanup.
 */
function reclaimStaleLock(
	paths: SingletonPaths,
	existing: SingletonLockRecord,
	identity: ProcessIdentityLike,
	inspect: (pid: number) => ObservedProcessLike,
	now: () => number,
	endpoint: string,
	leaseTtlMs: number,
): boolean {
	const claimFilePath = claimPath(paths);
	const claim: ClaimRecord = {
		version: 1,
		claimantId: crypto.randomUUID(),
		pid: identity.pid,
		birthToken: identity.birthToken,
		birthTokenKind: identity.birthTokenKind,
		createdAt: now(),
		targetGeneration: existing.acquiredAt,
	};
	// Fixed claim file, O_EXCL create.
	try {
		const fd = fs.openSync(claimFilePath, "wx", 0o600);
		try {
			fs.writeFileSync(fd, JSON.stringify(claim));
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		// Another contender holds the claim; recover it if ITS owner is dead.
		let priorRaw: unknown = null;
		try {
			priorRaw = readJsonOrNull<unknown>(claimFilePath);
		} catch { /* fall through to fail-closed */ }
		if (priorRaw === null) return false;
		let prior: ClaimRecord;
		try {
			prior = validateClaimRecord(priorRaw);
		} catch {
			throw bootstrapFailed("malformed singleton reclaim claim: failing closed");
		}
		if (!ownerIdentityIsDead(prior.pid, prior.birthToken, prior.birthTokenKind, identity, inspect)) {
			return false; // live contender — back off
		}
		fs.unlinkSync(claimFilePath); // recoverable claim cleanup
		return false; // one more pass will retry the whole loop
	}

	try {
		// Generation check: the lock record must still be the one we observed.
		const current = readLockRecord(paths);
		if (current === null || current.holderId !== existing.holderId || current.acquiredAt !== existing.acquiredAt) {
			return false; // another claimant already took over — retry loop
		}
		// rename-to-discard: remove the dead owner's lock without a shared-name
		// ABA window, then publish our own (hard-link create again).
		const discard = discardPath(paths, crypto.randomBytes(8).toString("hex"));
		fs.renameSync(paths.lockPath, discard);
		try { fs.unlinkSync(discard); } catch { /* best effort */ }
		fsyncDirectory(paths.controlHome);
		publishLockByHardLink(paths.lockPath, {
			version: SINGLETON_LOCK_VERSION,
			holderId: claim.claimantId,
			pid: identity.pid,
			birthToken: identity.birthToken,
			birthTokenKind: identity.birthTokenKind,
			fencingEpoch: existing.fencingEpoch + 1,
			endpoint,
			acquiredAt: now(),
		});
		writeLease(paths, {
			holderId: claim.claimantId,
			fencingEpoch: existing.fencingEpoch + 1,
			endpoint,
			expiresAt: now() + leaseTtlMs,
		});
		return true;
	} finally {
		try { fs.unlinkSync(claimFilePath); } catch { /* best effort */ }
	}
}

export interface SingletonReleaseIdentity {
	holderId: string;
	dev: bigint;
	ino: bigint;
}

/**
 * Release = compare-and-delete on acquire-time device/inode + owner token
 * (P13). rename-to-discard keeps the unlink atomic.
 */
export function releaseUserSingleton(paths: SingletonPaths, acquired: SingletonReleaseIdentity): void {
	if (!lockInodeMatches(paths, { dev: acquired.dev, ino: acquired.ino })) return; // not our lock — never delete someone else's
	const discard = discardPath(paths, crypto.randomBytes(8).toString("hex"));
	try {
		fs.renameSync(paths.lockPath, discard);
		fs.unlinkSync(discard);
		fsyncDirectory(paths.controlHome);
	} catch {
		// best effort — the lease still gates authority
	}
	try {
		const lease = readLease(paths);
		if (lease !== null && lease.holderId === acquired.holderId) fs.unlinkSync(paths.leasePath);
	} catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Stale endpoint recovery + fencing
// ---------------------------------------------------------------------------

export interface StaleEndpointOptions {
	inspectProcess?: (pid: number) => ObservedProcessLike;
}

/**
 * Fresh-install contract §5.2(4): detect a dead peer (pid/lock), remove its
 * socket file, and let the next acquire restart cleanly. A live owner's
 * endpoint is never touched; malformed metadata fails closed.
 */
export function recoverStaleEndpoint(paths: SingletonPaths, options: StaleEndpointOptions = {}): boolean {
	if (!fs.existsSync(paths.endpointPath)) return false;
	const inspect = options.inspectProcess ?? defaultProcessInspector;
	const record = readLockRecord(paths);
	if (record === null) {
		// No lock at all: an orphaned socket is stale by definition.
		try { fs.unlinkSync(paths.endpointPath); } catch { /* best effort */ }
		return true;
	}
	const dead = ownerIsDead(record, defaultProcessIdentity(), inspect);
	if (!dead) return false; // live owner — endpoint belongs to it
	try { fs.unlinkSync(paths.endpointPath); } catch { /* best effort */ }
	return true;
}

/**
 * Fencing: a client RPC must present a fencingEpoch >= the current lease
 * epoch, or the holder has been fenced out (stale writer) → TF_AUTHORITY_REVOKED.
 * A missing lease means no verifiable authority exists — fail closed rather
 * than accept an unverifiable claim.
 */
export function assertFencing(lease: CoordinatorLease | null, claimedEpoch: number): void {
	if (lease === null) {
		throw new ControlError(
			"TF_AUTHORITY_REVOKED",
			"no coordinator lease is present; cannot verify fencing authority — failing closed",
			{ recoveryAction: "refresh", sideEffects: "none" },
		);
	}
	if (claimedEpoch < lease.fencingEpoch) {
		throw new ControlError(
			"TF_AUTHORITY_REVOKED",
			`fencing epoch ${claimedEpoch} is stale; current lease epoch is ${lease.fencingEpoch}`,
			{ recoveryAction: "refresh", sideEffects: "none" },
		);
	}
}

/** Read the current CoordinatorLease record (null when none exists). */
export function readCoordinatorLease(paths: SingletonPaths): CoordinatorLease | null {
	return readLease(paths);
}

export function renewCoordinatorLease(paths: SingletonPaths, holderId: string, epoch: number, ttlMs: number, now?: () => number): CoordinatorLease {
	const at = now ?? Date.now;
	const lease: CoordinatorLease = {
		holderId,
		fencingEpoch: epoch,
		endpoint: paths.endpointPath,
		expiresAt: at() + ttlMs,
	};
	const existing = readLease(paths);
	if (existing !== null && existing.holderId !== holderId) {
		throw new ControlError(
			"TF_AUTHORITY_REVOKED",
			"cannot renew a coordinator lease owned by another holder",
			{ recoveryAction: "refresh", sideEffects: "none" },
		);
	}
	writeLease(paths, lease);
	return lease;
}
