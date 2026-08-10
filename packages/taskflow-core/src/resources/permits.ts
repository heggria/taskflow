import * as crypto from "node:crypto";
import * as path from "node:path";
import {
	PersistentFileMutex,
	readJsonFile,
	writeJsonAtomicDurable,
	type PersistentCoordinatorOptions,
} from "./persistence.ts";
import {
	cloneExecutionOwner,
	minimalCanonicalScopeCover,
	sameCanonicalScopes,
	sameExecutionOwner,
	type CanonicalLeaseKey,
	type ExecutionOwner,
} from "./types.ts";

export type PermitState = "issued" | "active" | "settled" | "expired";

export interface MutationPermit {
	readonly permitId: string;
	readonly intentId: string;
	readonly journalEpoch: number;
	readonly owner: ExecutionOwner;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly nonce: string;
	readonly scopes: readonly CanonicalLeaseKey[];
}

export interface DurablePendingIntent {
	intentId: string;
	intentSequence: number;
	journalEpoch: number;
	owner: ExecutionOwner;
	scopes: readonly CanonicalLeaseKey[];
}

interface PermitRecord extends DurablePendingIntent {
	permitId: string;
	nonce: string;
	issuedAt: string;
	expiresAt: string;
	state: PermitState;
	activatedAt?: string;
	settledAt?: string;
}

interface PermitStateFile {
	version: 1;
	records: PermitRecord[];
}

export interface PermitRegistryOptions extends PersistentCoordinatorOptions {
	journalEpoch: number;
}

export interface PermitActivation {
	owner: ExecutionOwner;
	pendingIntents: readonly DurablePendingIntent[];
}

export class PermitValidationError extends Error {
	readonly code = "TFWS_PERMIT_INVALID";
	constructor(message: string) {
		super(message);
		this.name = "PermitValidationError";
	}
}

const BRANDED_PERMITS = new WeakSet<object>();

/** Runtime-only brand check for SandboxPlan sealing. Serialized/reconstructed
 * lookalikes deliberately fail even when every public field is identical. */
export function isIssuedMutationPermit(value: unknown): value is MutationPermit {
	return typeof value === "object" && value !== null && BRANDED_PERMITS.has(value);
}

function freezeOwner(owner: ExecutionOwner): ExecutionOwner {
	const cloned = cloneExecutionOwner(owner);
	Object.freeze(cloned.ancestry);
	return Object.freeze(cloned);
}

function freezeScopes(scopes: readonly CanonicalLeaseKey[]): readonly CanonicalLeaseKey[] {
	return Object.freeze(minimalCanonicalScopeCover(scopes).map((scope) => Object.freeze({ ...scope })));
}

function mintPermit(record: PermitRecord): MutationPermit {
	const permit = Object.freeze({
		permitId: record.permitId,
		intentId: record.intentId,
		journalEpoch: record.journalEpoch,
		owner: freezeOwner(record.owner),
		issuedAt: record.issuedAt,
		expiresAt: record.expiresAt,
		nonce: record.nonce,
		scopes: freezeScopes(record.scopes),
	});
	BRANDED_PERMITS.add(permit);
	return permit;
}

function samePendingIntent(a: DurablePendingIntent, b: DurablePendingIntent): boolean {
	return a.intentId === b.intentId &&
		a.intentSequence === b.intentSequence &&
		a.journalEpoch === b.journalEpoch &&
		sameExecutionOwner(a.owner, b.owner) &&
		sameCanonicalScopes(a.scopes, b.scopes);
}

function samePermitRecord(permit: MutationPermit, record: PermitRecord): boolean {
	return permit.permitId === record.permitId &&
		permit.intentId === record.intentId &&
		permit.journalEpoch === record.journalEpoch &&
		permit.nonce === record.nonce &&
		permit.issuedAt === record.issuedAt &&
		permit.expiresAt === record.expiresAt &&
		sameExecutionOwner(permit.owner, record.owner) &&
		sameCanonicalScopes(permit.scopes, record.scopes);
}

export class MutationPermitRegistry {
	readonly statePath: string;
	readonly journalEpoch: number;
	readonly now: () => number;
	readonly #mutex: PersistentFileMutex;

	constructor(options: PermitRegistryOptions) {
		if (!Number.isSafeInteger(options.journalEpoch) || options.journalEpoch < 1) {
			throw new Error("journalEpoch must be a positive safe integer");
		}
		this.journalEpoch = options.journalEpoch;
		this.statePath = path.join(options.directory, "mutation-permits.json");
		this.now = options.now ?? Date.now;
		this.#mutex = new PersistentFileMutex(path.join(options.directory, "mutation-permits.lock"), options);
	}

	#read(): PermitStateFile {
		const state = readJsonFile<PermitStateFile>(this.statePath, { version: 1, records: [] });
		if (state.version !== 1 || !Array.isArray(state.records)) throw new Error(`Invalid permit registry: ${this.statePath}`);
		return state;
	}

	#expire(state: PermitStateFile): boolean {
		let changed = false;
		const now = this.now();
		for (const record of state.records) {
			// expiresAt bounds the prepare-to-activate replay window. Once activated,
			// an execution may legitimately outlive that window; its live lease and
			// the journal's crash recovery own termination from that point forward.
			// Expiring an active permit here would turn every long-running successful
			// agent into dirty-unknown when it attempts to commit.
			if (record.state === "issued" && Date.parse(record.expiresAt) <= now) {
				record.state = "expired";
				record.settledAt = new Date(now).toISOString();
				changed = true;
			}
		}
		return changed;
	}

	/** Internal durability-plane hook. Call only after the matching intent WAL
	 * record has been appended and fsynced. JournalManager is the public issuer. */
	async issueForDurableIntent(intent: DurablePendingIntent, ttlMs: number): Promise<MutationPermit> {
		if (intent.journalEpoch !== this.journalEpoch) throw new PermitValidationError("Journal epoch does not match permit registry epoch");
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Permit ttlMs must be positive");
		const scopes = minimalCanonicalScopeCover(intent.scopes);
		if (scopes.length === 0) throw new PermitValidationError("A mutation permit requires at least one scope");
		return this.#mutex.runExclusive(() => {
			const state = this.#read();
			const changed = this.#expire(state);
			if (state.records.some((record) => record.intentId === intent.intentId && (record.state === "issued" || record.state === "active"))) {
				throw new PermitValidationError(`Intent ${intent.intentId} already has a live permit`);
			}
			const issuedAtMs = this.now();
			const record: PermitRecord = {
				intentId: intent.intentId,
				intentSequence: intent.intentSequence,
				journalEpoch: intent.journalEpoch,
				owner: cloneExecutionOwner(intent.owner),
				scopes,
				permitId: crypto.randomUUID(),
				nonce: crypto.randomBytes(24).toString("base64url"),
				issuedAt: new Date(issuedAtMs).toISOString(),
				expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
				state: "issued",
			};
			state.records.push(record);
			writeJsonAtomicDurable(this.statePath, state);
			void changed;
			return mintPermit(record);
		});
	}

	/** Atomically activate every permit in a sealed execution plan exactly once. */
	async activateMany(permits: readonly MutationPermit[], activation: PermitActivation): Promise<void> {
		if (permits.length === 0) throw new PermitValidationError("No permits supplied for activation");
		await this.#mutex.runExclusive(() => {
			const state = this.#read();
			const expired = this.#expire(state);
			if (expired) writeJsonAtomicDurable(this.statePath, state);
			const seen = new Set<string>();
			const records: PermitRecord[] = [];
			for (const permit of permits) {
				if (!isIssuedMutationPermit(permit)) {
					throw new PermitValidationError("Unbranded or reconstructed mutation permit");
				}
				if (seen.has(permit.permitId)) throw new PermitValidationError(`Duplicate permit ${permit.permitId}`);
				seen.add(permit.permitId);
				const record = state.records.find((candidate) => candidate.permitId === permit.permitId);
				if (!record || !samePermitRecord(permit, record)) throw new PermitValidationError(`Permit ${permit.permitId} does not match its registry record`);
				if (record.state !== "issued") throw new PermitValidationError(`Permit ${permit.permitId} is ${record.state}; activation replay rejected`);
				if (record.journalEpoch !== this.journalEpoch) throw new PermitValidationError(`Permit ${permit.permitId} belongs to an obsolete journal epoch`);
				if (!sameExecutionOwner(record.owner, activation.owner)) throw new PermitValidationError(`Permit ${permit.permitId} owner mismatch`);
				const pending = activation.pendingIntents.find((candidate) => candidate.intentId === record.intentId);
				if (!pending || !samePendingIntent(record, pending)) throw new PermitValidationError(`Permit ${permit.permitId} has no identical pending journal intent`);
				records.push(record);
			}
			const activatedAt = new Date(this.now()).toISOString();
			for (const record of records) {
				record.state = "active";
				record.activatedAt = activatedAt;
			}
			if (records.length > 0) writeJsonAtomicDurable(this.statePath, state);
		});
	}

	async assertIntentActive(intentId: string, owner: ExecutionOwner): Promise<void> {
		await this.#mutex.runExclusive(() => {
			const state = this.#read();
			if (this.#expire(state)) writeJsonAtomicDurable(this.statePath, state);
			const active = state.records.find((record) => record.intentId === intentId && record.state === "active");
			if (!active) throw new PermitValidationError(`Intent ${intentId} has no active mutation permit`);
			if (!sameExecutionOwner(active.owner, owner)) throw new PermitValidationError(`Intent ${intentId} active permit owner mismatch`);
		});
	}

	async assertActive(permit: MutationPermit, owner: ExecutionOwner): Promise<void> {
		await this.#mutex.runExclusive(() => {
			const state = this.#read();
			const expired = this.#expire(state);
			if (expired) writeJsonAtomicDurable(this.statePath, state);
			if (!isIssuedMutationPermit(permit)) throw new PermitValidationError("Unbranded mutation permit");
			const record = state.records.find((candidate) => candidate.permitId === permit.permitId);
			if (!record || !samePermitRecord(permit, record) || record.state !== "active") {
				throw new PermitValidationError(`Permit ${permit.permitId} is not active`);
			}
			if (!sameExecutionOwner(record.owner, owner)) throw new PermitValidationError(`Permit ${permit.permitId} owner mismatch`);
		});
	}

	async settleIntent(intentId: string): Promise<void> {
		await this.#mutex.runExclusive(() => {
			const state = this.#read();
			let changed = this.#expire(state);
			const settledAt = new Date(this.now()).toISOString();
			for (const record of state.records) {
				if (record.intentId !== intentId || (record.state !== "issued" && record.state !== "active")) continue;
				record.state = "settled";
				record.settledAt = settledAt;
				changed = true;
			}
			if (changed) writeJsonAtomicDurable(this.statePath, state);
		});
	}

	async stateOf(permitId: string): Promise<PermitState | undefined> {
		return this.#mutex.runExclusive(() => {
			const state = this.#read();
			if (this.#expire(state)) writeJsonAtomicDurable(this.statePath, state);
			return state.records.find((record) => record.permitId === permitId)?.state;
		});
	}

	async invalidateOlderEpochs(): Promise<number> {
		return this.#mutex.runExclusive(() => {
			const state = this.#read();
			let count = 0;
			const settledAt = new Date(this.now()).toISOString();
			for (const record of state.records) {
				if (record.journalEpoch === this.journalEpoch || (record.state !== "issued" && record.state !== "active")) continue;
				record.state = "expired";
				record.settledAt = settledAt;
				count++;
			}
			if (count > 0) writeJsonAtomicDurable(this.statePath, state);
			return count;
		});
	}
}
