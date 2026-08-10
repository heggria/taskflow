import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CoordinatorAbortError,
	CoordinatorTimeoutError,
	PersistentFileMutex,
	defaultProcessIdentity,
	defaultProcessInspector,
	isPersistedOwnerStale,
	namespaceToken,
	readJsonFile,
	writeJsonAtomicDurable,
	type PersistentCoordinatorOptions,
	type ProcessIdentity,
} from "./persistence.ts";
import {
	canonicalLeaseKeysOverlap,
	canonicalPrefixContains,
	cloneExecutionOwner,
	compareLeaseKeys,
	normalizeLeaseKey,
	sameExecutionOwner,
	type ExecutionOwner,
	type LeaseRequest,
	type ResourceAccess,
} from "./types.ts";

export type { CanonicalLeaseKey, ExecutionOwner, LeaseRequest, ResourceAccess } from "./types.ts";
export { canonicalLeaseKeysOverlap } from "./types.ts";
export { CoordinatorAbortError, CoordinatorTimeoutError } from "./persistence.ts";

interface PersistedLeaseRequest {
	key: { resourceDomainId: string; canonicalPrefix: string };
	access: ResourceAccess;
}

interface PersistedLeaseRecord extends ProcessIdentity {
	leaseId: string;
	leaseToken: string;
	releaseMarkerToken: string;
	owner: ExecutionOwner;
	requests: PersistedLeaseRequest[];
	acquiredAt: number;
	expiresAt?: number;
}

interface PersistedLeaseReleaseMarker {
	version: 1;
	leaseId: string;
	releaseMarkerToken: string;
	leaseTokenSha256: string;
	state: "held" | "done";
}

interface PersistedLeaseState {
	version: 1;
	leases: PersistedLeaseRecord[];
}

export interface LeaseAcquireOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Optional renewable deadline. Omit for process-lifetime ownership. */
	leaseTtlMs?: number;
}

export interface LeaseHandle {
	readonly leaseId: string;
	readonly owner: ExecutionOwner;
	readonly requests: readonly LeaseRequest[];
	readonly acquiredAt: number;
	readonly expiresAt?: number;
	release(): Promise<void>;
	renew(ttlMs: number): Promise<void>;
}

export interface LeaseCoordinatorOptions extends PersistentCoordinatorOptions {
	registryId: string;
}

function accessRank(access: ResourceAccess): number {
	return access === "read-write" ? 1 : 0;
}

function normalizeRequests(requests: readonly LeaseRequest[]): LeaseRequest[] {
	if (requests.length === 0) throw new Error("At least one lease request is required");
	const normalized = requests.map((request) => ({
		key: normalizeLeaseKey(request.key),
		access: request.access,
		owner: cloneExecutionOwner(request.owner),
	}));
	const owner = normalized[0].owner;
	if (!normalized.every((request) => sameExecutionOwner(request.owner, owner))) {
		throw new Error("Atomic multi-key acquisition requires one identical execution owner");
	}
	for (const request of normalized) {
		if (request.access !== "read-only" && request.access !== "read-write") {
			throw new Error(`Unsupported lease access: ${String(request.access)}`);
		}
	}
	const deduped = new Map<string, LeaseRequest>();
	for (const request of normalized) {
		const id = `${request.key.resourceDomainId}\0${request.key.canonicalPrefix}`;
		const prior = deduped.get(id);
		if (!prior || accessRank(request.access) > accessRank(prior.access)) deduped.set(id, request);
	}
	return [...deduped.values()].sort((a, b) =>
		compareLeaseKeys(a.key, b.key) || accessRank(a.access) - accessRank(b.access));
}

function canReenter(existing: PersistedLeaseRecord, requested: LeaseRequest): boolean {
	const lineage = sameExecutionOwner(existing.owner, requested.owner) ||
		(requested.owner.runId === existing.owner.runId && requested.owner.ancestry.includes(existing.owner.attemptId));
	if (!lineage) return false;
	return existing.requests.some((held) =>
		held.key.resourceDomainId === requested.key.resourceDomainId &&
		canonicalPrefixContains(held.key.canonicalPrefix, requested.key.canonicalPrefix) &&
		accessRank(requested.access) <= accessRank(held.access));
}

function requestsConflict(existing: PersistedLeaseRecord, requested: readonly LeaseRequest[]): boolean {
	for (const next of requested) {
		for (const held of existing.requests) {
			if (!canonicalLeaseKeysOverlap(held.key, next.key)) continue;
			if (held.access === "read-only" && next.access === "read-only") continue;
			if (canReenter(existing, next)) continue;
			return true;
		}
	}
	return false;
}

export class PersistentLeaseCoordinator {
	readonly statePath: string;
	readonly identity: ProcessIdentity;
	readonly now: () => number;
	readonly pollMs: number;
	readonly #mutex: PersistentFileMutex;
	readonly #inspectProcess: NonNullable<PersistentCoordinatorOptions["inspectProcess"]>;

	constructor(options: LeaseCoordinatorOptions) {
		if (!options.registryId) throw new Error("registryId is required for the persistent lease namespace");
		const token = namespaceToken(options.registryId);
		this.statePath = path.join(options.directory, `leases-${token}.json`);
		this.identity = options.processIdentity ?? defaultProcessIdentity();
		this.#inspectProcess = options.inspectProcess ?? defaultProcessInspector;
		this.now = options.now ?? Date.now;
		this.pollMs = options.pollMs ?? 20;
		this.#mutex = new PersistentFileMutex(path.join(options.directory, `leases-${token}.lock`), options);
	}

	#read(): PersistedLeaseState {
		const state = readJsonFile<PersistedLeaseState>(this.statePath, { version: 1, leases: [] });
		if (state.version !== 1 || !Array.isArray(state.leases)) throw new Error(`Invalid lease state: ${this.statePath}`);
		return state;
	}

	#releaseMarkerPath(record: Pick<PersistedLeaseRecord, "leaseId" | "releaseMarkerToken">): string {
		if (!/^[0-9a-f-]{36}$/i.test(record.leaseId) || !/^[0-9a-f]{48}$/.test(record.releaseMarkerToken)) {
			throw new Error("Invalid persisted lease release marker identity");
		}
		return path.join(path.dirname(this.statePath), `lease-release-${record.leaseId}-${record.releaseMarkerToken}.json`);
	}

	#releaseMarkerBody(record: PersistedLeaseRecord, state: "held" | "done"): PersistedLeaseReleaseMarker {
		return {
			version: 1,
			leaseId: record.leaseId,
			releaseMarkerToken: record.releaseMarkerToken,
			leaseTokenSha256: crypto.createHash("sha256").update(record.leaseToken).digest("hex"),
			state,
		};
	}

	#validateReleaseMarker(value: unknown, record: PersistedLeaseRecord): PersistedLeaseReleaseMarker {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid lease release marker");
		const marker = value as PersistedLeaseReleaseMarker;
		const expected = this.#releaseMarkerBody(record, marker.state);
		if (marker.version !== 1 || (marker.state !== "held" && marker.state !== "done") ||
			marker.leaseId !== expected.leaseId || marker.releaseMarkerToken !== expected.releaseMarkerToken ||
			marker.leaseTokenSha256 !== expected.leaseTokenSha256 ||
			Object.keys(marker).length !== 5) {
			throw new Error("Invalid lease release marker");
		}
		return marker;
	}

	#readReleaseMarker(record: PersistedLeaseRecord): PersistedLeaseReleaseMarker | undefined {
		const markerPath = this.#releaseMarkerPath(record);
		const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
		let fd: number | undefined;
		try {
			fd = fs.openSync(markerPath, fs.constants.O_RDONLY | noFollow);
			const stat = fs.fstatSync(fd);
			if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid lease release marker file");
			return this.#validateReleaseMarker(JSON.parse(fs.readFileSync(fd, "utf8")) as unknown, record);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	#createReleaseMarker(record: PersistedLeaseRecord): void {
		writeJsonAtomicDurable(this.#releaseMarkerPath(record), this.#releaseMarkerBody(record, "held"));
	}

	#markReleaseMarkerDone(record: PersistedLeaseRecord): boolean {
		const markerPath = this.#releaseMarkerPath(record);
		const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
		let fd: number | undefined;
		try {
			fd = fs.openSync(markerPath, fs.constants.O_RDWR | noFollow);
			const currentRaw = fs.readFileSync(fd, "utf8");
			const current = this.#validateReleaseMarker(JSON.parse(currentRaw) as unknown, record);
			if (current.state === "done") return true;
			const terminal = Buffer.from(JSON.stringify({ ...current, state: "done" } satisfies PersistedLeaseReleaseMarker));
			if (terminal.byteLength !== Buffer.byteLength(currentRaw)) throw new Error("Lease release marker size changed");
			let offset = 0;
			while (offset < terminal.byteLength) {
				offset += fs.writeSync(fd, terminal, offset, terminal.byteLength - offset, offset);
			}
			fs.fsyncSync(fd);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	#cleanupReleaseMarkers(records: readonly PersistedLeaseRecord[]): void {
		for (const record of records) {
			try { fs.unlinkSync(this.#releaseMarkerPath(record)); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					// The state no longer references the marker. An orphan is inert and
					// can be removed by ordinary control-directory maintenance.
				}
			}
		}
	}

	#isStale(record: PersistedLeaseRecord): boolean {
		const expiredOrDead = () =>
			(record.expiresAt !== undefined && record.expiresAt <= this.now()) ||
			isPersistedOwnerStale(record, this.identity, this.#inspectProcess);
		try {
			return this.#readReleaseMarker(record)?.state === "done" || expiredOrDead();
		} catch {
			// Marker corruption cannot authorize recovery while the owner may still be
			// active. Once independently expired or dead, the immutable lease identity
			// is sufficient to prune this record and its exact marker path.
			if (expiredOrDead()) return true;
			// Preserve a possibly-live lease as active. Conflict checks will still block
			// overlapping access, while unrelated resource scopes remain available.
			return false;
		}
	}

	#prune(state: PersistedLeaseState): PersistedLeaseRecord[] {
		const stale = state.leases.filter((record) => this.#isStale(record));
		if (stale.length > 0) {
			const ids = new Set(stale.map((record) => record.leaseId));
			state.leases = state.leases.filter((record) => !ids.has(record.leaseId));
		}
		return stale;
	}

	async acquire(requests: readonly LeaseRequest[], options: LeaseAcquireOptions = {}): Promise<LeaseHandle> {
		const normalized = normalizeRequests(requests);
		if (options.leaseTtlMs !== undefined && (!Number.isFinite(options.leaseTtlMs) || options.leaseTtlMs <= 0)) {
			throw new Error("leaseTtlMs must be positive");
		}
		const timeoutMs = options.timeoutMs ?? 10_000;
		const deadline = this.now() + timeoutMs;
		while (true) {
			if (options.signal?.aborted) throw new CoordinatorAbortError();
			let created: PersistedLeaseRecord | undefined;
			await this.#mutex.runExclusive(() => {
				const state = this.#read();
				const stale = this.#prune(state);
				if (!state.leases.some((record) => requestsConflict(record, normalized))) {
					created = {
						...this.identity,
						leaseId: crypto.randomUUID(),
						leaseToken: crypto.randomBytes(24).toString("hex"),
						releaseMarkerToken: crypto.randomBytes(24).toString("hex"),
						owner: cloneExecutionOwner(normalized[0].owner),
						requests: normalized.map(({ key, access }) => ({ key, access })),
						acquiredAt: this.now(),
						...(options.leaseTtlMs === undefined ? {} : { expiresAt: this.now() + options.leaseTtlMs }),
					};
					this.#createReleaseMarker(created);
					state.leases.push(created);
				}
				try {
					if (stale.length > 0 || created) writeJsonAtomicDurable(this.statePath, state);
				} catch (error) {
					if (created) this.#cleanupReleaseMarkers([created]);
					throw error;
				}
				this.#cleanupReleaseMarkers(stale);
			}, { timeoutMs: Math.max(1, deadline - this.now()), signal: options.signal });

			if (created) {
				const record = created;
				let released = false;
				let releasePromise: Promise<void> | undefined;
				const release = async () => {
					if (released) return;
					if (releasePromise) return releasePromise;
					let terminal = false;
					try { terminal = this.#markReleaseMarkerDone(record); } catch { /* exact state removal may still succeed */ }
					releasePromise = this.#remove(record)
						.then(() => {
							released = true;
						})
						.catch((error: unknown) => {
							if (terminal) {
								released = true;
								console.warn(`[taskflow] lease cleanup deferred for ${record.leaseId} (critical section durably released)`);
								return;
							}
							throw error;
						})
						.finally(() => {
							if (!released) releasePromise = undefined;
						});
					return releasePromise;
				};
				const renew = async (ttlMs: number) => {
					if (released) throw new Error(`Lease ${record.leaseId} is already released`);
					if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be positive");
					await this.#mutex.runExclusive(() => {
						const state = this.#read();
						const current = state.leases.find((lease) => lease.leaseId === record.leaseId && lease.leaseToken === record.leaseToken);
						if (!current || this.#isStale(current)) throw new Error(`Lease ${record.leaseId} is no longer active`);
						current.expiresAt = this.now() + ttlMs;
						record.expiresAt = current.expiresAt;
						writeJsonAtomicDurable(this.statePath, state);
					});
				};
				// The acquisition signal cancels only a waiter. Once granted, the lease
				// protects the actual writer until its invoke promise settles or the owner
				// process dies; abort alone is not proof that mutation has stopped.
				if (options.signal?.aborted) {
					await release();
					throw new CoordinatorAbortError();
				}
				return {
					leaseId: record.leaseId,
					owner: cloneExecutionOwner(record.owner),
					requests: normalized,
					acquiredAt: record.acquiredAt,
					get expiresAt() { return record.expiresAt; },
					release,
					renew,
				};
			}

			if (this.now() >= deadline) {
				throw new CoordinatorTimeoutError(`Lease timeout after ${timeoutMs}ms for ${normalized.length} resource scope(s)`);
			}
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, Math.min(this.pollMs, Math.max(1, deadline - this.now())));
				const onAbort = () => {
					clearTimeout(timer);
					reject(new CoordinatorAbortError());
				};
				options.signal?.addEventListener("abort", onAbort, { once: true });
				if (options.signal) setTimeout(() => options.signal?.removeEventListener("abort", onAbort), this.pollMs + 1).unref?.();
			});
		}
	}

	async #remove(record: PersistedLeaseRecord): Promise<void> {
		await this.#mutex.runExclusive(() => {
			const state = this.#read();
			const next = state.leases.filter((lease) =>
				lease.leaseId !== record.leaseId || lease.leaseToken !== record.leaseToken);
			if (next.length !== state.leases.length) {
				state.leases = next;
				writeJsonAtomicDurable(this.statePath, state);
			}
			this.#cleanupReleaseMarkers([record]);
		});
	}

	async recoverStale(): Promise<string[]> {
		return this.#mutex.runExclusive(() => {
			const state = this.#read();
			const stale = this.#prune(state);
			if (stale.length > 0) writeJsonAtomicDurable(this.statePath, state);
			this.#cleanupReleaseMarkers(stale);
			return stale.map((record) => record.leaseId);
		});
	}

	async list(): Promise<Array<Omit<PersistedLeaseRecord, "leaseToken" | "releaseMarkerToken">>> {
		return this.#mutex.runExclusive(() => {
			const state = this.#read();
			const stale = this.#prune(state);
			if (stale.length > 0) writeJsonAtomicDurable(this.statePath, state);
			this.#cleanupReleaseMarkers(stale);
			return state.leases.map(({ leaseToken: _secret, releaseMarkerToken: _marker, ...record }) => structuredClone(record));
		});
	}
}
