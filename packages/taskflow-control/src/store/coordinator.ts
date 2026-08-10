/**
 * UserCoordinatorStore — singleton lease, capacity reservations, and typed
 * coordinator commands (D6 / D30 / D36 / D37 / P16).
 *
 * Every mutation is load → validate → mutate → save under state.lock. Command
 * hashes are derived from the typed request accepted by this store; callers
 * cannot supply a different body for idempotency hashing.
 */
import * as path from "node:path";
import {
	CAPACITY_OCCUPYING_STATES,
	FORCE_RELEASE_ACKNOWLEDGEMENT,
	RESERVATION_SLOTS,
	type ConcurrencyReservation,
	type CoordinatorCommandRecord,
	type CoordinatorLease,
	type ForceReleaseRequest,
	type ReservationState,
	type SetMaxActiveRunsRequest,
} from "../types.ts";
import { hashRequest, newId } from "../hash.ts";
import { assertSafeId, isSafeId } from "../validate-ids.ts";
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
	noLiveOrAmbiguousSideEffects: boolean;
	runIsTerminal: boolean;
	runIsParkedAndFutureDispatchRequiresReadmission: boolean;
}

export function canNormalRelease(ctx: ReleaseContext): boolean {
	if (!ctx.noLiveOrAmbiguousSideEffects) return false;
	return ctx.runIsTerminal || ctx.runIsParkedAndFutureDispatchRequiresReadmission;
}

export interface ReservationBinding {
	projectId: string;
	projectControlDomainId: string;
	runId: string;
	projectAdmitCommitSeq: number;
}

export interface CoordinatorCommandContext {
	commandId: string;
	callerPrincipal: string;
}

export interface UserCoordinatorStore {
	readonly maxActiveRuns: number;
	getLease(): CoordinatorLease | null;
	setLease(lease: CoordinatorLease): void;
	occupyingCount(): number;
	listReservations(): ConcurrencyReservation[];
	getReservation(id: string): ConcurrencyReservation | null;
	reserve(opts: { coordinatorEpoch: number; ttlMs?: number }): ConcurrencyReservation | null;
	commitReservation(reservationId: string, binding: ReservationBinding): ConcurrencyReservation;
	markOrphanSuspect(reservationId: string): ConcurrencyReservation;
	/** Preserve capacity when project/coordinator binding outcome is uncertain. */
	markReservationCommitUnknown(
		reservationId: string,
		binding: ReservationBinding,
	): ConcurrencyReservation;
	normalRelease(reservationId: string, ctx: ReleaseContext): ConcurrencyReservation;
	forceRelease(
		request: ForceReleaseRequest,
		cmd: CoordinatorCommandContext,
	): { reservation: ConcurrencyReservation; command: CoordinatorCommandRecord };
	setMaxActiveRuns(
		request: SetMaxActiveRunsRequest,
		cmd: CoordinatorCommandContext,
	): CoordinatorCommandRecord;
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
		schemaVersion: 2,
		maxActiveRuns: DEFAULT_MAX_ACTIVE_RUNS,
		lease: null,
		reservations: [],
		commands: [],
		nextCommandSeq: 1,
	};
}

export function openUserCoordinatorStore(
	env: NodeJS.ProcessEnv = process.env,
	opts?: { baseDir?: string },
): UserCoordinatorStore {
	const dir = opts?.baseDir ?? coordinatorDir(env);
	ensureDir(dir);
	const file = path.join(dir, "state.json");
	const lockPath = path.join(dir, "state.lock");

	function load(): CoordinatorFile {
		const data = readJsonFile<CoordinatorFile>(file) ?? emptyCoordinator();
		data.schemaVersion = Math.max(data.schemaVersion ?? 1, 2);
		data.reservations = (data.reservations ?? []).map((reservation) => ({
			...reservation,
			revision:
				Number.isInteger(reservation.revision) && reservation.revision >= 1
					? reservation.revision
					: 1,
		}));
		data.commands ??= [];
		data.nextCommandSeq ??= 1;
		const occupied = occupying(data);
		if (data.maxActiveRuns < occupied) data.maxActiveRuns = occupied;
		return data;
	}

	function save(data: CoordinatorFile): void {
		writeFileAtomic(file, JSON.stringify(data, null, 2));
	}

	function mutate<T>(fn: (data: CoordinatorFile) => T): T {
		return withExclusiveLockFile(lockPath, () => {
			const data = load();
			const result = fn(data);
			save(data);
			return result;
		});
	}

	function occupying(data: CoordinatorFile): number {
		return data.reservations.filter((reservation) =>
			(CAPACITY_OCCUPYING_STATES as readonly string[]).includes(reservation.state),
		).length;
	}

	function updateReservation(
		data: CoordinatorFile,
		reservationId: string,
		patch: Partial<ConcurrencyReservation>,
	): ConcurrencyReservation {
		const index = data.reservations.findIndex(
			(reservation) => reservation.reservationId === reservationId,
		);
		if (index < 0) throw new Error(`reservation not found: ${reservationId}`);
		const current = data.reservations[index];
		if (!current) throw new Error(`reservation not found: ${reservationId}`);
		const next: ConcurrencyReservation = {
			...current,
			...patch,
			revision: current.revision + 1,
			updatedAt: Date.now(),
		};
		data.reservations[index] = next;
		return next;
	}

	function reclaimExpiredInPlace(data: CoordinatorFile, now: number): number {
		let reclaimed = 0;
		for (const reservation of data.reservations) {
			if (
				reservation.state === "reserved" &&
				reservation.reservedExpiresAt !== undefined &&
				reservation.reservedExpiresAt <= now
			) {
				reservation.state = "expired";
				reservation.revision += 1;
				reservation.updatedAt = now;
				reclaimed += 1;
			}
		}
		return reclaimed;
	}

	function validateCommandContext(cmd: CoordinatorCommandContext): void {
		assertSafeId(cmd.commandId, "commandId");
		if (!cmd.callerPrincipal.trim()) {
			throw new Error("TF_INVALID_ARGUMENT: callerPrincipal is required");
		}
	}

	function priorCommand(
		data: CoordinatorFile,
		cmd: CoordinatorCommandContext,
		kind: CoordinatorCommandRecord["kind"],
		requestHash: string,
	): CoordinatorCommandRecord | null {
		const prior = data.commands.find((candidate) => candidate.commandId === cmd.commandId);
		if (!prior) return null;
		if (prior.callerPrincipal !== cmd.callerPrincipal) {
			throw new Error("TF_CROSS_PRINCIPAL_COMMAND: command owned by different principal");
		}
		if (prior.kind !== kind || prior.requestHash !== requestHash) {
			throw new Error("TF_IDEMPOTENCY_CONFLICT: same commandId with different request");
		}
		return prior;
	}

	function currentCoordinatorEpoch(data: CoordinatorFile): number {
		return data.lease?.fencingEpoch ?? 0;
	}

	function writeCommand(command: CoordinatorCommandRecord): void {
		writeFileAtomic(
			path.join(dir, `cmd-${command.commandId}.json`),
			JSON.stringify(command, null, 2),
		);
	}

	return {
		get maxActiveRuns() {
			return load().maxActiveRuns;
		},

		getLease() {
			return load().lease;
		},

		setLease(lease) {
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

		getReservation(id) {
			if (!isSafeId(id)) return null;
			return load().reservations.find((reservation) => reservation.reservationId === id) ?? null;
		},

		reserve(opts) {
			return mutate((data) => {
				const now = Date.now();
				reclaimExpiredInPlace(data, now);
				if (occupying(data) >= data.maxActiveRuns) return null;
				const reservation: ConcurrencyReservation = {
					reservationId: newId("rsv"),
					revision: 1,
					state: "reserved",
					slots: RESERVATION_SLOTS,
					coordinatorEpoch: opts.coordinatorEpoch,
					reservedExpiresAt: now + (opts.ttlMs ?? RESERVED_TTL_MS),
					createdAt: now,
					updatedAt: now,
				};
				data.reservations.push(reservation);
				return reservation;
			});
		},

		commitReservation(reservationId, binding) {
			assertSafeId(reservationId, "reservationId");
			assertSafeId(binding.projectId, "projectId");
			assertSafeId(binding.projectControlDomainId, "controlDomainId");
			assertSafeId(binding.runId, "runId");
			return mutate((data) => {
				const reservation = data.reservations.find(
					(candidate) => candidate.reservationId === reservationId,
				);
				if (!reservation) throw new Error(`reservation not found: ${reservationId}`);
				if (reservation.state !== "reserved") {
					throw new Error(`cannot commit reservation in state ${reservation.state}`);
				}
				return updateReservation(data, reservationId, {
					state: "committed",
					...binding,
					reservedExpiresAt: undefined,
				});
			});
		},

		markOrphanSuspect(reservationId) {
			assertSafeId(reservationId, "reservationId");
			return mutate((data) => {
				const reservation = data.reservations.find(
					(candidate) => candidate.reservationId === reservationId,
				);
				if (!reservation) throw new Error(`reservation not found: ${reservationId}`);
				if (reservation.state !== "committed" && reservation.state !== "orphan-suspect") {
					throw new Error(`cannot mark orphan-suspect from state ${reservation.state}`);
				}
				return updateReservation(data, reservationId, { state: "orphan-suspect" });
			});
		},

		markReservationCommitUnknown(reservationId, binding) {
			assertSafeId(reservationId, "reservationId");
			return mutate((data) => {
				const reservation = data.reservations.find(
					(candidate) => candidate.reservationId === reservationId,
				);
				if (!reservation) throw new Error(`reservation not found: ${reservationId}`);
				if (
					reservation.state !== "reserved" &&
					reservation.state !== "committed" &&
					reservation.state !== "orphan-suspect"
				) {
					throw new Error(`cannot preserve uncertain reservation from state ${reservation.state}`);
				}
				return updateReservation(data, reservationId, {
					state: "orphan-suspect",
					...binding,
					reservedExpiresAt: undefined,
				});
			});
		},

		normalRelease(reservationId, ctx) {
			assertSafeId(reservationId, "reservationId");
			if (!canNormalRelease(ctx)) {
				throw new Error(
					"D37 normalRelease denied: noLiveOrAmbiguousSideEffects and (terminal|parked-readmit) required",
				);
			}
			return mutate((data) => {
				const reservation = data.reservations.find(
					(candidate) => candidate.reservationId === reservationId,
				);
				if (!reservation) throw new Error(`reservation not found: ${reservationId}`);
				if (
					reservation.state !== "committed" &&
					reservation.state !== "orphan-suspect" &&
					reservation.state !== "reserved"
				) {
					throw new Error(`cannot normalRelease from state ${reservation.state}`);
				}
				return updateReservation(data, reservationId, { state: "released" });
			});
		},

		forceRelease(request, cmd) {
			validateCommandContext(cmd);
			assertSafeId(request.reservationId, "reservationId");
			assertSafeId(request.expectedProjectId, "expectedProjectId");
			assertSafeId(request.expectedControlDomainId, "expectedControlDomainId");
			assertSafeId(request.expectedRunId, "expectedRunId");
			return mutate((data) => {
				const requestHash = hashRequest(request);
				const prior = priorCommand(data, cmd, "forceRelease", requestHash);
				if (prior) {
					const reservation = data.reservations.find(
						(candidate) => candidate.reservationId === request.reservationId,
					);
					if (!reservation) throw new Error(`reservation not found: ${request.reservationId}`);
					return { reservation, command: prior };
				}
				const reservation = data.reservations.find(
					(candidate) => candidate.reservationId === request.reservationId,
				);
				if (!reservation) throw new Error(`reservation not found: ${request.reservationId}`);
				if (request.acknowledgement !== FORCE_RELEASE_ACKNOWLEDGEMENT) {
					throw new Error("TF_INVALID_ARGUMENT: forceRelease requires exact risk acknowledgement");
				}
				if (
					reservation.state !== request.expectedState ||
					reservation.revision !== request.expectedRevision ||
					reservation.coordinatorEpoch !== request.expectedCoordinatorEpoch ||
					reservation.projectId !== request.expectedProjectId ||
					reservation.projectControlDomainId !== request.expectedControlDomainId ||
					reservation.runId !== request.expectedRunId
				) {
					throw new Error("TF_STALE_VERSION: reservation changed; refresh before forceRelease");
				}
				if (data.lease && currentCoordinatorEpoch(data) !== request.expectedCoordinatorEpoch) {
					throw new Error("TF_STALE_VERSION: coordinator fencing epoch changed");
				}
				const seq = data.nextCommandSeq++;
				const command: CoordinatorCommandRecord = {
					commandId: cmd.commandId,
					requestHash,
					callerPrincipal: cmd.callerPrincipal,
					kind: "forceRelease",
					firstCommitSeq: seq,
					lastCommitSeq: seq,
					status: "completed",
					payload: { ...request },
					recordedAt: Date.now(),
				};
				data.commands.push(command);
				const released = updateReservation(data, request.reservationId, {
					state: "released",
					operatorOverridden: true,
				});
				writeCommand(command);
				return { reservation: released, command };
			});
		},

		setMaxActiveRuns(request, cmd) {
			validateCommandContext(cmd);
			if (!Number.isInteger(request.value) || request.value < 1) {
				throw new Error("TF_INVALID_ARGUMENT: maxActiveRuns must be integer >= 1");
			}
			return mutate((data) => {
				const requestHash = hashRequest(request);
				const prior = priorCommand(data, cmd, "setMaxActiveRuns", requestHash);
				if (prior) return prior;
				if (
					data.maxActiveRuns !== request.expectedMaxActiveRuns ||
					currentCoordinatorEpoch(data) !== request.expectedCoordinatorEpoch
				) {
					throw new Error(
						"TF_STALE_VERSION: coordinator summary changed; refresh before setMaxActiveRuns",
					);
				}
				reclaimExpiredInPlace(data, Date.now());
				const occupied = occupying(data);
				if (request.value < occupied) {
					throw new Error(
						`TF_CAPACITY_EXCEEDED: cannot set maxActiveRuns=${request.value} below occupancy=${occupied}`,
					);
				}
				const seq = data.nextCommandSeq++;
				const command: CoordinatorCommandRecord = {
					commandId: cmd.commandId,
					requestHash,
					callerPrincipal: cmd.callerPrincipal,
					kind: "setMaxActiveRuns",
					firstCommitSeq: seq,
					lastCommitSeq: seq,
					status: "completed",
					payload: { ...request },
					recordedAt: Date.now(),
				};
				data.commands.push(command);
				data.maxActiveRuns = request.value;
				writeCommand(command);
				return command;
			});
		},

		reclaimExpiredReserved(now = Date.now()) {
			return mutate((data) => reclaimExpiredInPlace(data, now));
		},

		getCommand(commandId) {
			if (!isSafeId(commandId)) return null;
			return load().commands.find((command) => command.commandId === commandId) ?? null;
		},
	};
}

export function capacityOk(
	reservations: ConcurrencyReservation[],
	maxActiveRuns: number,
): boolean {
	const occupied = reservations.filter((reservation) =>
		(CAPACITY_OCCUPYING_STATES as readonly string[]).includes(
			reservation.state as ReservationState,
		),
	).length;
	return occupied <= maxActiveRuns;
}
