/**
 * UserCoordinatorStore — singleton lease + concurrency reservations +
 * CoordinatorCommandRecord (D6 / D30 / D36 / D37 / P16).
 *
 * Capacity: count(reserved|committed|orphan-suspect) ≤ maxActiveRuns
 * slots ≡ 1 per admitted Run.
 * committed / orphan-suspect release ONLY via D37 normalRelease / forceRelease.
 *
 * All mutations run under exclusive state.lock with load→mutate→save inside
 * the critical section (cross-process safe; no last-writer-wins loss).
 */
import * as path from "node:path";
import {
	CAPACITY_OCCUPYING_STATES,
	RESERVATION_SLOTS,
	type ConcurrencyReservation,
	type CoordinatorCommandRecord,
	type CoordinatorLease,
	type ReservationState,
} from "../types.ts";
import { hashRequest, newId } from "../hash.ts";
import {
	coordinatorDir,
	ensureDir,
	readJsonFile,
	withExclusiveLockFile,
	writeFileAtomic,
} from "../paths.ts";

const DEFAULT_MAX_ACTIVE_RUNS = 4;
const RESERVED_TTL_MS = 60_000;

export interface ReleaseContext {
	/** Provider/isolation proves no live process tree AND no open ambiguous job. */
	noLiveOrAmbiguousSideEffects: boolean;
	runIsTerminal: boolean;
	runIsParkedAndFutureDispatchRequiresReadmission: boolean;
}

/** D37 normalRelease predicate. */
export function canNormalRelease(ctx: ReleaseContext): boolean {
	if (!ctx.noLiveOrAmbiguousSideEffects) return false;
	return ctx.runIsTerminal || ctx.runIsParkedAndFutureDispatchRequiresReadmission;
}

export interface UserCoordinatorStore {
	readonly maxActiveRuns: number;
	getLease(): CoordinatorLease | null;
	setLease(lease: CoordinatorLease): void;
	/** Count of capacity-occupying reservations. */
	occupyingCount(): number;
	listReservations(): ConcurrencyReservation[];
	getReservation(id: string): ConcurrencyReservation | null;
	/**
	 * Reserve one slot (slots≡1). Returns null if capacity exceeded.
	 * reserved is TTL-reclaimable.
	 */
	reserve(opts: { coordinatorEpoch: number; ttlMs?: number }): ConcurrencyReservation | null;
	/** After Run Admitted + projectAdmitCommitSeq → committed (no TTL release). */
	commitReservation(
		reservationId: string,
		binding: {
			projectId: string;
			projectControlDomainId: string;
			runId: string;
			projectAdmitCommitSeq: number;
		},
	): ConcurrencyReservation;
	/** Mark orphan-suspect (reconcile exhaustion) — still occupies capacity. */
	markOrphanSuspect(reservationId: string): ConcurrencyReservation;
	/**
	 * D37 normalRelease — only when predicates hold.
	 * Throws if predicates fail (does not silently release).
	 */
	normalRelease(reservationId: string, ctx: ReleaseContext): ConcurrencyReservation;
	/**
	 * D37 forceRelease — only via CoordinatorCommandRecord.
	 * Marks operator-overridden.
	 */
	forceRelease(
		reservationId: string,
		cmd: { commandId: string; callerPrincipal: string; requestBody: unknown },
	): { reservation: ConcurrencyReservation; command: CoordinatorCommandRecord };
	setMaxActiveRuns(
		value: number,
		cmd: { commandId: string; callerPrincipal: string; requestBody: unknown },
	): CoordinatorCommandRecord;
	/** Reclaim expired reserved (not committed) slots. */
	reclaimExpiredReserved(now?: number): number;
	getCommand(commandId: string): CoordinatorCommandRecord | null;
}

interface CoordinatorFile {
	schemaVersion: number;
	maxActiveRuns: number;
	lease: CoordinatorLease | null;
	reservations: ConcurrencyReservation[];
	commands: CoordinatorCommandRecord[];
	nextCommandSeq: number;
}

function emptyCoordinator(): CoordinatorFile {
	return {
		schemaVersion: 1,
		maxActiveRuns: DEFAULT_MAX_ACTIVE_RUNS,
		lease: null,
		reservations: [],
		commands: [],
		nextCommandSeq: 1,
	};
}

export function openUserCoordinatorStore(
	env: NodeJS.ProcessEnv = process.env,
	opts?: { /** Override on-disk directory (project-local standalone). */ baseDir?: string },
): UserCoordinatorStore {
	const dir = opts?.baseDir ?? coordinatorDir(env);
	ensureDir(dir);
	const file = path.join(dir, "state.json");
	const lockPath = path.join(dir, "state.lock");

	function load(): CoordinatorFile {
		return readJsonFile<CoordinatorFile>(file) ?? emptyCoordinator();
	}

	function save(data: CoordinatorFile): void {
		writeFileAtomic(file, JSON.stringify(data, null, 2));
	}

	/** load → mutate → save under exclusive cross-process lock. */
	function mutate<T>(fn: (data: CoordinatorFile) => T): T {
		return withExclusiveLockFile(lockPath, () => {
			const data = load();
			const result = fn(data);
			save(data);
			return result;
		});
	}

	function occupying(data: CoordinatorFile): number {
		return data.reservations.filter((r) =>
			(CAPACITY_OCCUPYING_STATES as readonly string[]).includes(r.state),
		).length;
	}

	function updateRes(
		data: CoordinatorFile,
		id: string,
		patch: Partial<ConcurrencyReservation>,
	): ConcurrencyReservation {
		const i = data.reservations.findIndex((r) => r.reservationId === id);
		if (i < 0) throw new Error(`reservation not found: ${id}`);
		const next = { ...data.reservations[i]!, ...patch, updatedAt: Date.now() };
		data.reservations[i] = next;
		return next;
	}

	return {
		get maxActiveRuns() {
			return load().maxActiveRuns;
		},

		getLease() {
			return load().lease;
		},

		setLease(lease: CoordinatorLease) {
			mutate((data) => {
				data.lease = lease;
			});
		},

		occupyingCount() {
			return occupying(load());
		},

		listReservations() {
			return load().reservations.slice();
		},

		getReservation(id: string) {
			return load().reservations.find((r) => r.reservationId === id) ?? null;
		},

		reserve(opts) {
			return mutate((data) => {
				const now = Date.now();
				for (const r of data.reservations) {
					if (
						r.state === "reserved" &&
						r.reservedExpiresAt !== undefined &&
						r.reservedExpiresAt <= now
					) {
						r.state = "expired";
						r.updatedAt = now;
					}
				}
				if (occupying(data) >= data.maxActiveRuns) {
					return null;
				}
				const ttl = opts.ttlMs ?? RESERVED_TTL_MS;
				const res: ConcurrencyReservation = {
					reservationId: newId("rsv"),
					state: "reserved",
					slots: RESERVATION_SLOTS,
					coordinatorEpoch: opts.coordinatorEpoch,
					reservedExpiresAt: now + ttl,
					createdAt: now,
					updatedAt: now,
				};
				data.reservations.push(res);
				return res;
			});
		},

		commitReservation(reservationId, binding) {
			return mutate((data) => {
				const r = data.reservations.find((x) => x.reservationId === reservationId);
				if (!r) throw new Error(`reservation not found: ${reservationId}`);
				if (r.state !== "reserved") {
					throw new Error(`cannot commit reservation in state ${r.state}`);
				}
				return updateRes(data, reservationId, {
					state: "committed",
					...binding,
					reservedExpiresAt: undefined,
				});
			});
		},

		markOrphanSuspect(reservationId) {
			return mutate((data) => {
				const r = data.reservations.find((x) => x.reservationId === reservationId);
				if (!r) throw new Error(`reservation not found: ${reservationId}`);
				if (r.state !== "committed" && r.state !== "orphan-suspect") {
					throw new Error(`cannot mark orphan-suspect from state ${r.state}`);
				}
				return updateRes(data, reservationId, { state: "orphan-suspect" });
			});
		},

		normalRelease(reservationId, ctx) {
			if (!canNormalRelease(ctx)) {
				throw new Error(
					"D37 normalRelease denied: noLiveOrAmbiguousSideEffects and (terminal|parked-readmit) required",
				);
			}
			return mutate((data) => {
				const r = data.reservations.find((x) => x.reservationId === reservationId);
				if (!r) throw new Error(`reservation not found: ${reservationId}`);
				if (r.state !== "committed" && r.state !== "orphan-suspect" && r.state !== "reserved") {
					throw new Error(`cannot normalRelease from state ${r.state}`);
				}
				return updateRes(data, reservationId, { state: "released" });
			});
		},

		forceRelease(reservationId, cmd) {
			return mutate((data) => {
				const r = data.reservations.find((x) => x.reservationId === reservationId);
				if (!r) throw new Error(`reservation not found: ${reservationId}`);
				const seq = data.nextCommandSeq++;
				const command: CoordinatorCommandRecord = {
					commandId: cmd.commandId,
					requestHash: hashRequest(cmd.requestBody),
					callerPrincipal: cmd.callerPrincipal,
					kind: "forceRelease",
					firstCommitSeq: seq,
					lastCommitSeq: seq,
					status: "completed",
					payload: { reservationId, riskAcknowledged: true },
					recordedAt: Date.now(),
				};
				data.commands.push(command);
				const next = updateRes(data, reservationId, {
					state: "released",
					operatorOverridden: true,
				});
				writeFileAtomic(
					path.join(dir, `cmd-${command.commandId}.json`),
					JSON.stringify(command, null, 2),
				);
				return { reservation: next, command };
			});
		},

		setMaxActiveRuns(value, cmd) {
			if (!Number.isInteger(value) || value < 1) {
				throw new Error("maxActiveRuns must be integer >= 1");
			}
			return mutate((data) => {
				const seq = data.nextCommandSeq++;
				const command: CoordinatorCommandRecord = {
					commandId: cmd.commandId,
					requestHash: hashRequest(cmd.requestBody),
					callerPrincipal: cmd.callerPrincipal,
					kind: "setMaxActiveRuns",
					firstCommitSeq: seq,
					lastCommitSeq: seq,
					status: "completed",
					payload: { maxActiveRuns: value },
					recordedAt: Date.now(),
				};
				data.commands.push(command);
				data.maxActiveRuns = value;
				writeFileAtomic(
					path.join(dir, `cmd-${command.commandId}.json`),
					JSON.stringify(command, null, 2),
				);
				return command;
			});
		},

		reclaimExpiredReserved(now = Date.now()) {
			return mutate((data) => {
				let n = 0;
				for (const r of data.reservations) {
					if (
						r.state === "reserved" &&
						r.reservedExpiresAt !== undefined &&
						r.reservedExpiresAt <= now
					) {
						r.state = "expired";
						r.updatedAt = now;
						n += 1;
					}
				}
				return n;
			});
		},

		getCommand(commandId: string) {
			const data = load();
			return data.commands.find((c) => c.commandId === commandId) ?? null;
		},
	};
}

/** Test helper: assert capacity formula. */
export function capacityOk(reservations: ConcurrencyReservation[], maxActiveRuns: number): boolean {
	const n = reservations.filter((r) =>
		(CAPACITY_OCCUPYING_STATES as readonly string[]).includes(r.state as ReservationState),
	).length;
	return n <= maxActiveRuns;
}
