import * as crypto from "node:crypto";
import * as path from "node:path";
import {
	PersistentFileMutex,
	appendJsonLinesDurable,
	readJsonLines,
	type PersistentCoordinatorOptions,
} from "./persistence.ts";
import {
	MutationPermitRegistry,
	type DurablePendingIntent,
	type MutationPermit,
} from "./permits.ts";
import {
	canonicalLeaseKeysOverlap,
	canonicalPrefixContains,
	cloneExecutionOwner,
	minimalCanonicalScopeCover,
	normalizeCanonicalPrefix,
	sameCanonicalScopes,
	sameExecutionOwner,
	type CanonicalLeaseKey,
	type ExecutionOwner,
	type ExternalMutationModel,
	type ScopedContentEvidence,
	type VersionCommitMode,
} from "./types.ts";

export type { ExternalMutationModel, ScopedContentEvidence, VersionCommitMode } from "./types.ts";
export type { MutationPermit } from "./permits.ts";

export type WriteIntentStatus =
	| "pending"
	| "committed-content"
	| "committed-generation"
	| "aborted-restored"
	| "dirty-unknown"
	| "reconciled";

export interface WriteIntentRecord {
	journalVersion: 1;
	intentId: string;
	resourceDomainId: string;
	providerInstanceId?: string;
	scopes: ScopedContentEvidence[];
	owner: ExecutionOwner;
	beforeGeneration: number;
	intentSequence: number;
	commitGeneration?: number;
	journalEpoch: number;
	commitMode: VersionCommitMode;
	externalMutation: ExternalMutationModel;
	status: WriteIntentStatus;
	restorableSnapshotArtifactIds?: string[];
	terminalReason?: string;
	authorizationPrincipalId?: string;
	authorizationScopeRoot?: string;
}

export interface RecoverPendingOptions {
	/**
	 * Return true only when the exact execution owner still holds a live
	 * mutation lease. The callback runs while the journal mutex is held so a
	 * writer cannot create a new intent between the liveness check and the WAL
	 * recovery append.
	 */
	isOwnerActive?: (owner: ExecutionOwner) => boolean | Promise<boolean>;
	/** Trusted resource backend hook. Return exact before=after evidence only
	 * after restoring every scope from durable pre-state artifacts. */
	recoverKnownClean?: (
		intent: WriteIntentRecord,
	) => Promise<{
		scopes: readonly ScopedContentEvidence[];
		reason: string;
		restorableSnapshotArtifactIds?: readonly string[];
	} | undefined>;
}

export interface PrepareWriteIntent {
	resourceDomainId: string;
	providerInstanceId?: string;
	scopes: ScopedContentEvidence[];
	owner: ExecutionOwner;
	/** Optional external CAS assertion. Omit for ordinary writers so generation
	 * sampling and intent creation occur under one journal mutex. */
	beforeGeneration?: number;
	commitMode: VersionCommitMode;
	externalMutation: ExternalMutationModel;
	/** Durable pre-state artifacts captured before permit activation. */
	restorableSnapshotArtifactIds?: readonly string[];
	/** Host-authenticated principal; flow JSON cannot supply this value. */
	authorizationPrincipalId?: string;
	authorizationScopeRoot?: string;
	permitTtlMs?: number;
}

export interface CommitWriteIntentOptions {
	/** Last-moment synchronous validation after permit checks and before WAL. */
	preCommitGuard?: () => void;
}

interface IntentWalRecord {
	journalVersion: 1;
	type: "write-intent";
	ts: string;
	intent: WriteIntentRecord;
}

interface CommitContentWalRecord {
	journalVersion: 1;
	type: "write-commit-content";
	ts: string;
	intentId: string;
	resourceDomainId: string;
	commitGeneration: number;
	scopes: ScopedContentEvidence[];
	restorableSnapshotArtifactIds?: string[];
}

interface CommitGenerationWalRecord {
	journalVersion: 1;
	type: "write-commit-generation";
	ts: string;
	intentId: string;
	resourceDomainId: string;
	commitGeneration: number;
}

interface UnknownWalRecord {
	journalVersion: 1;
	type: "write-unknown";
	ts: string;
	intentId: string;
	resourceDomainId: string;
	reason: string;
}

interface AbortRestoredWalRecord {
	journalVersion: 1;
	type: "write-abort-restored";
	ts: string;
	intentId: string;
	resourceDomainId: string;
	reason: string;
	scopes: ScopedContentEvidence[];
	restorableSnapshotArtifactIds?: string[];
}

interface ReconcileWalRecord {
	journalVersion: 1;
	type: "write-reconcile";
	ts: string;
	resourceDomainId: string;
	reconcileGeneration: number;
	intentIds: string[];
	reason: string;
}

export type JournalWalRecord =
	| IntentWalRecord
	| CommitContentWalRecord
	| CommitGenerationWalRecord
	| AbortRestoredWalRecord
	| UnknownWalRecord
	| ReconcileWalRecord;

interface JournalProjection {
	intents: Map<string, WriteIntentRecord>;
	domainGenerations: Map<string, number>;
	maxIntentSequence: number;
}

export interface JournalManagerOptions extends PersistentCoordinatorOptions {
	journalEpoch: number;
	permitRegistry?: MutationPermitRegistry;
}

export interface PreparedMutation {
	intent: WriteIntentRecord;
	permit: MutationPermit;
}

export interface RecoveryResult {
	recoveredIntentIds: string[];
	restoredIntentIds: string[];
	dirtyDomains: string[];
}

export interface ReconciliationResult {
	resourceDomainId: string;
	previousGeneration: number;
	generation: number;
	reconciledIntentIds: string[];
}

export class JournalStateError extends Error {
	readonly code = "TFWS_JOURNAL_STATE";
	constructor(message: string) {
		super(message);
		this.name = "JournalStateError";
	}
}

function cloneEvidence(scope: ScopedContentEvidence): ScopedContentEvidence {
	if (typeof scope.scopeDigest !== "string" || scope.scopeDigest.length === 0) throw new Error("scopeDigest must be non-empty");
	return {
		canonicalPrefix: normalizeCanonicalPrefix(scope.canonicalPrefix),
		scopeDigest: scope.scopeDigest,
		...(scope.effectId === undefined ? {} : { effectId: scope.effectId }),
		...(scope.capabilityBindingId === undefined ? {} : { capabilityBindingId: scope.capabilityBindingId }),
		...(scope.beforeContentId === undefined ? {} : { beforeContentId: scope.beforeContentId }),
		...(scope.afterContentId === undefined ? {} : { afterContentId: scope.afterContentId }),
	};
}

function normalizeEvidence(scopes: readonly ScopedContentEvidence[]): ScopedContentEvidence[] {
	if (scopes.length === 0) throw new Error("A write intent requires at least one scope");
	const byPrefix = new Map<string, ScopedContentEvidence>();
	for (const scope of scopes.map(cloneEvidence)) {
		if (byPrefix.has(scope.canonicalPrefix)) throw new Error(`Duplicate write scope ${scope.canonicalPrefix}`);
		byPrefix.set(scope.canonicalPrefix, scope);
	}
	const sorted = [...byPrefix.values()].sort((a, b) => a.canonicalPrefix.localeCompare(b.canonicalPrefix));
	return sorted.filter((scope, index) => !sorted.some((parent, parentIndex) =>
		parentIndex !== index && canonicalPrefixContains(parent.canonicalPrefix, scope.canonicalPrefix)));
}

function intentScopeKeys(intent: Pick<WriteIntentRecord, "resourceDomainId" | "scopes">): CanonicalLeaseKey[] {
	return minimalCanonicalScopeCover(intent.scopes.map((scope) => ({
		resourceDomainId: intent.resourceDomainId,
		canonicalPrefix: scope.canonicalPrefix,
	})));
}

function scopesOverlap(a: WriteIntentRecord, b: Pick<WriteIntentRecord, "resourceDomainId" | "scopes">): boolean {
	return intentScopeKeys(a).some((left) => intentScopeKeys(b).some((right) => canonicalLeaseKeysOverlap(left, right)));
}

function cloneIntent(intent: WriteIntentRecord): WriteIntentRecord {
	return structuredClone(intent);
}

function fold(records: readonly JournalWalRecord[]): JournalProjection {
	const intents = new Map<string, WriteIntentRecord>();
	const domainGenerations = new Map<string, number>();
	let maxIntentSequence = 0;
	for (const record of records) {
		if (record.journalVersion !== 1) throw new JournalStateError(`Unsupported journal record version: ${String(record.journalVersion)}`);
		if (record.type === "write-intent") {
			if (intents.has(record.intent.intentId)) throw new JournalStateError(`Duplicate intent ${record.intent.intentId}`);
			intents.set(record.intent.intentId, cloneIntent(record.intent));
			maxIntentSequence = Math.max(maxIntentSequence, record.intent.intentSequence);
			continue;
		}
		if (record.type === "write-reconcile") {
			const intentIds = [...new Set(record.intentIds)];
			if (intentIds.length === 0 || intentIds.length !== record.intentIds.length) {
				throw new JournalStateError("Reconcile record must reference a non-empty unique intent set");
			}
			const previousGeneration = domainGenerations.get(record.resourceDomainId) ?? 0;
			if (record.reconcileGeneration !== previousGeneration + 1) {
				throw new JournalStateError(
					`Non-monotonic reconcile generation ${record.reconcileGeneration} for ${record.resourceDomainId}; expected ${previousGeneration + 1}`,
				);
			}
			for (const intentId of intentIds) {
				const intent = intents.get(intentId);
				if (!intent) throw new JournalStateError(`Reconcile record references unknown intent ${intentId}`);
				if (intent.resourceDomainId !== record.resourceDomainId) {
					throw new JournalStateError(`Reconcile intent ${intentId} domain mismatch`);
				}
				if (intent.status !== "dirty-unknown") {
					throw new JournalStateError(`Reconcile intent ${intentId} is ${intent.status}, not dirty-unknown`);
				}
				intent.status = "reconciled";
				intent.commitGeneration = record.reconcileGeneration;
			}
			domainGenerations.set(record.resourceDomainId, record.reconcileGeneration);
			continue;
		}
		const intent = intents.get(record.intentId);
		if (!intent) throw new JournalStateError(`Terminal record references unknown intent ${record.intentId}`);
		if (intent.status !== "pending") throw new JournalStateError(`Intent ${record.intentId} has multiple terminal WAL records`);
		if (record.resourceDomainId !== intent.resourceDomainId) throw new JournalStateError(`Intent ${record.intentId} domain mismatch`);
		if (record.type === "write-unknown") {
			intent.status = "dirty-unknown";
			intent.terminalReason = record.reason;
			continue;
		}
		if (record.type === "write-abort-restored") {
			if (!sameCanonicalScopes(intentScopeKeys(intent), record.scopes.map((scope) => ({
				resourceDomainId: intent.resourceDomainId,
				canonicalPrefix: scope.canonicalPrefix,
			})))) {
				throw new JournalStateError(`Restored scopes do not match intent ${record.intentId}`);
			}
			for (const scope of record.scopes) {
				if (!scope.beforeContentId || scope.afterContentId !== scope.beforeContentId) {
					throw new JournalStateError(`Restored scope ${scope.canonicalPrefix} does not prove before=after`);
				}
			}
			intent.status = "aborted-restored";
			intent.scopes = structuredClone(record.scopes);
			intent.restorableSnapshotArtifactIds = record.restorableSnapshotArtifactIds
				? [...record.restorableSnapshotArtifactIds]
				: undefined;
			intent.terminalReason = record.reason;
			continue;
		}
		const previousGeneration = domainGenerations.get(record.resourceDomainId) ?? 0;
		if (record.commitGeneration !== previousGeneration + 1) {
			throw new JournalStateError(`Non-monotonic commit generation ${record.commitGeneration} for ${record.resourceDomainId}; expected ${previousGeneration + 1}`);
		}
		domainGenerations.set(record.resourceDomainId, record.commitGeneration);
		intent.commitGeneration = record.commitGeneration;
		if (record.type === "write-commit-content") {
			intent.status = "committed-content";
			intent.scopes = structuredClone(record.scopes);
			intent.restorableSnapshotArtifactIds = record.restorableSnapshotArtifactIds ? [...record.restorableSnapshotArtifactIds] : undefined;
		} else {
			intent.status = "committed-generation";
		}
	}
	return { intents, domainGenerations, maxIntentSequence };
}

function pendingDescriptor(intent: WriteIntentRecord): DurablePendingIntent {
	return {
		intentId: intent.intentId,
		intentSequence: intent.intentSequence,
		journalEpoch: intent.journalEpoch,
		owner: cloneExecutionOwner(intent.owner),
		scopes: intentScopeKeys(intent),
	};
}

export class WriteIntentJournal {
	readonly walPath: string;
	readonly journalEpoch: number;
	readonly permits: MutationPermitRegistry;
	readonly now: () => number;
	readonly #mutex: PersistentFileMutex;

	constructor(options: JournalManagerOptions) {
		if (!Number.isSafeInteger(options.journalEpoch) || options.journalEpoch < 1) throw new Error("journalEpoch must be a positive safe integer");
		this.journalEpoch = options.journalEpoch;
		this.walPath = path.join(options.directory, "resource-journal.wal.jsonl");
		this.now = options.now ?? Date.now;
		this.#mutex = new PersistentFileMutex(path.join(options.directory, "resource-journal.lock"), options);
		this.permits = options.permitRegistry ?? new MutationPermitRegistry(options);
		if (this.permits.journalEpoch !== this.journalEpoch) throw new Error("Journal and permit registry epochs must match");
	}

	#records(): JournalWalRecord[] {
		return readJsonLines<JournalWalRecord>(this.walPath);
	}

	#projection(): JournalProjection {
		return fold(this.#records());
	}

	#append(records: readonly JournalWalRecord[]): void {
		appendJsonLinesDurable(this.walPath, records);
	}

	async prepare(input: PrepareWriteIntent): Promise<PreparedMutation> {
		if (input.beforeGeneration !== undefined && (!Number.isSafeInteger(input.beforeGeneration) || input.beforeGeneration < 0)) {
			throw new Error("beforeGeneration must be a non-negative safe integer");
		}
		if (!input.resourceDomainId) throw new Error("resourceDomainId must be non-empty");
		if (input.authorizationPrincipalId !== undefined && !input.authorizationPrincipalId.trim()) {
			throw new Error("authorizationPrincipalId must be non-empty when supplied");
		}
		if (input.authorizationScopeRoot !== undefined && !path.isAbsolute(input.authorizationScopeRoot)) {
			throw new Error("authorizationScopeRoot must be absolute when supplied");
		}
		if (!(["content-snapshot", "generation-only", "unavailable"] as const).includes(input.commitMode)) throw new Error(`Unsupported commitMode ${String(input.commitMode)}`);
		if (!(["taskflow-managed", "externally-mutable"] as const).includes(input.externalMutation)) throw new Error(`Unsupported externalMutation ${String(input.externalMutation)}`);
		const scopes = normalizeEvidence(input.scopes);
		const ttlMs = input.permitTtlMs ?? 60_000;
		return this.#mutex.runExclusive(async () => {
			const projection = this.#projection();
			const currentGeneration = projection.domainGenerations.get(input.resourceDomainId) ?? 0;
			if (input.beforeGeneration !== undefined && input.beforeGeneration !== currentGeneration) {
				throw new JournalStateError(`beforeGeneration ${input.beforeGeneration} does not match durable generation ${currentGeneration} for ${input.resourceDomainId}`);
			}
			const candidate = {
				resourceDomainId: input.resourceDomainId,
				scopes,
			};
			for (const existing of projection.intents.values()) {
				if ((existing.status === "pending" || existing.status === "dirty-unknown") && scopesOverlap(existing, candidate)) {
					throw new JournalStateError(`Scope overlaps ${existing.status} intent ${existing.intentId}; reconcile before writing`);
				}
			}
			const nowIso = new Date(this.now()).toISOString();
			const intent: WriteIntentRecord = {
				journalVersion: 1,
				intentId: crypto.randomUUID(),
				resourceDomainId: input.resourceDomainId,
				...(input.providerInstanceId === undefined ? {} : { providerInstanceId: input.providerInstanceId }),
				scopes,
				owner: cloneExecutionOwner(input.owner),
				beforeGeneration: currentGeneration,
				intentSequence: projection.maxIntentSequence + 1,
				journalEpoch: this.journalEpoch,
				commitMode: input.commitMode,
				externalMutation: input.externalMutation,
				status: "pending",
				...(input.authorizationPrincipalId === undefined
					? {}
					: { authorizationPrincipalId: input.authorizationPrincipalId }),
				...(input.authorizationScopeRoot === undefined
					? {}
					: { authorizationScopeRoot: path.normalize(input.authorizationScopeRoot) }),
				...(input.restorableSnapshotArtifactIds === undefined
					? {}
					: { restorableSnapshotArtifactIds: [...input.restorableSnapshotArtifactIds] }),
			};
			this.#append([{ journalVersion: 1, type: "write-intent", ts: nowIso, intent }]);
			try {
				const permit = await this.permits.issueForDurableIntent(pendingDescriptor(intent), ttlMs);
				return { intent: cloneIntent(intent), permit };
			} catch (error) {
				this.#append([{
					journalVersion: 1,
					type: "write-unknown",
					ts: new Date(this.now()).toISOString(),
					intentId: intent.intentId,
					resourceDomainId: intent.resourceDomainId,
					reason: `permit issuance failed: ${error instanceof Error ? error.message : String(error)}`,
				}]);
				throw error;
			}
		});
	}

	/** Verify durable pending intents and atomically CAS all permits to active. */
	async activate(permits: readonly MutationPermit[], owner: ExecutionOwner): Promise<void> {
		await this.#mutex.runExclusive(async () => {
			const projection = this.#projection();
			const pending: DurablePendingIntent[] = [];
			for (const permit of permits) {
				const intent = projection.intents.get(permit.intentId);
				if (!intent || intent.status !== "pending") throw new JournalStateError(`Permit intent ${permit.intentId} is not pending`);
				if (!sameExecutionOwner(intent.owner, owner)) throw new JournalStateError(`Intent ${intent.intentId} owner mismatch`);
				pending.push(pendingDescriptor(intent));
			}
			await this.permits.activateMany(permits, { owner, pendingIntents: pending });
		});
	}

	async assertActive(permit: MutationPermit, owner: ExecutionOwner): Promise<void> {
		await this.#mutex.runExclusive(async () => {
			const intent = this.#projection().intents.get(permit.intentId);
			if (!intent || intent.status !== "pending") throw new JournalStateError(`Permit intent ${permit.intentId} is not pending`);
			await this.permits.assertActive(permit, owner);
		});
	}

	async commitGeneration(intentId: string, options: CommitWriteIntentOptions = {}): Promise<WriteIntentRecord> {
		return this.#commit(intentId, "generation-only", undefined, undefined, options);
	}

	async commitContent(
		intentId: string,
		scopes: readonly ScopedContentEvidence[],
		restorableSnapshotArtifactIds?: readonly string[],
		options: CommitWriteIntentOptions = {},
	): Promise<WriteIntentRecord> {
		const normalized = normalizeEvidence(scopes);
		if (normalized.some((scope) => typeof scope.afterContentId !== "string" || scope.afterContentId.length === 0)) {
			throw new JournalStateError("content-snapshot commit requires afterContentId for every scope");
		}
		return this.#commit(intentId, "content-snapshot", normalized, restorableSnapshotArtifactIds, options);
	}

	async #commit(
		intentId: string,
		mode: "generation-only" | "content-snapshot",
		scopes?: ScopedContentEvidence[],
		restorableSnapshotArtifactIds?: readonly string[],
		options: CommitWriteIntentOptions = {},
	): Promise<WriteIntentRecord> {
		return this.#mutex.runExclusive(async () => {
			const projection = this.#projection();
			const intent = projection.intents.get(intentId);
			if (!intent || intent.status !== "pending") throw new JournalStateError(`Intent ${intentId} is not pending`);
			if (intent.commitMode !== mode) throw new JournalStateError(`Intent ${intentId} commit mode is ${intent.commitMode}, not ${mode}`);
			await this.permits.assertIntentActive(intentId, intent.owner);
			// Permit validation may wait on another cross-process mutex. Revalidate
			// cancellation/path invariants after every awaited lock and immediately
			// before the synchronous terminal WAL append.
			options.preCommitGuard?.();
			const generation = (projection.domainGenerations.get(intent.resourceDomainId) ?? 0) + 1;
			const ts = new Date(this.now()).toISOString();
			let record: JournalWalRecord;
			if (mode === "content-snapshot") {
				if (!scopes || !sameCanonicalScopes(intentScopeKeys(intent), scopes.map((scope) => ({ resourceDomainId: intent.resourceDomainId, canonicalPrefix: scope.canonicalPrefix })))) {
					throw new JournalStateError(`Committed content scopes do not match intent ${intentId}`);
				}
				record = {
					journalVersion: 1,
					type: "write-commit-content",
					ts,
					intentId,
					resourceDomainId: intent.resourceDomainId,
					commitGeneration: generation,
					scopes,
					...(restorableSnapshotArtifactIds === undefined ? {} : { restorableSnapshotArtifactIds: [...restorableSnapshotArtifactIds] }),
				};
			} else {
				record = {
					journalVersion: 1,
					type: "write-commit-generation",
					ts,
					intentId,
					resourceDomainId: intent.resourceDomainId,
					commitGeneration: generation,
				};
			}
			this.#append([record]);
			await this.#settleTerminalPermit(intentId);
			// The terminal WAL append is the durability point. Do not perform a new
			// fallible WAL read after it or turn a committed mutation into a retryable
			// caller failure.
			const committed = cloneIntent(intent);
			committed.commitGeneration = generation;
			if (record.type === "write-commit-content") {
				committed.status = "committed-content";
				committed.scopes = structuredClone(record.scopes);
				committed.restorableSnapshotArtifactIds = record.restorableSnapshotArtifactIds
					? [...record.restorableSnapshotArtifactIds]
					: undefined;
			} else {
				committed.status = "committed-generation";
			}
			return cloneIntent(committed);
		});
	}

	async markUnknown(intentId: string, reason: string): Promise<WriteIntentRecord> {
		return this.#mutex.runExclusive(async () => {
			const projection = this.#projection();
			const intent = projection.intents.get(intentId);
			if (!intent || intent.status !== "pending") throw new JournalStateError(`Intent ${intentId} is not pending`);
			this.#append([{
				journalVersion: 1,
				type: "write-unknown",
				ts: new Date(this.now()).toISOString(),
				intentId,
				resourceDomainId: intent.resourceDomainId,
				reason: reason || "mutation outcome unknown",
			}]);
			await this.#settleTerminalPermit(intentId);
			const dirty = cloneIntent(intent);
			dirty.status = "dirty-unknown";
			dirty.terminalReason = reason || "mutation outcome unknown";
			return cloneIntent(dirty);
		});
	}

	/**
	 * Settle an active mutation without advancing the resource generation after
	 * the caller has restored every admitted scope to its exact pre-state.
	 * This is a known-clean terminal state, not reconciliation: callers must
	 * provide content evidence proving `beforeContentId === afterContentId` for
	 * every originally admitted scope.
	 */
	async abortRestored(
		intentId: string,
		scopes: readonly ScopedContentEvidence[],
		reason: string,
		restorableSnapshotArtifactIds?: readonly string[],
	): Promise<WriteIntentRecord> {
		const normalized = normalizeEvidence(scopes);
		if (normalized.some((scope) => !scope.beforeContentId || scope.afterContentId !== scope.beforeContentId)) {
			throw new JournalStateError("abort-restored requires beforeContentId === afterContentId for every scope");
		}
		return this.#mutex.runExclusive(async () => {
			const intent = this.#projection().intents.get(intentId);
			if (!intent || intent.status !== "pending") throw new JournalStateError(`Intent ${intentId} is not pending`);
			if (!sameCanonicalScopes(intentScopeKeys(intent), normalized.map((scope) => ({
				resourceDomainId: intent.resourceDomainId,
				canonicalPrefix: scope.canonicalPrefix,
			})))) {
				throw new JournalStateError(`Restored content scopes do not match intent ${intentId}`);
			}
			await this.permits.assertIntentActive(intentId, intent.owner);
			const terminalReason = reason || "mutation rejected and pre-state restored";
			this.#append([{
				journalVersion: 1,
				type: "write-abort-restored",
				ts: new Date(this.now()).toISOString(),
				intentId,
				resourceDomainId: intent.resourceDomainId,
				reason: terminalReason,
				scopes: normalized,
				...(restorableSnapshotArtifactIds === undefined
					? {}
					: { restorableSnapshotArtifactIds: [...restorableSnapshotArtifactIds] }),
			}]);
			await this.#settleTerminalPermit(intentId);
			const aborted = cloneIntent(intent);
			aborted.status = "aborted-restored";
			aborted.scopes = structuredClone(normalized);
			aborted.restorableSnapshotArtifactIds = restorableSnapshotArtifactIds
				? [...restorableSnapshotArtifactIds]
				: undefined;
			aborted.terminalReason = terminalReason;
			return cloneIntent(aborted);
		});
	}

	/** Explicitly acknowledge the current external filesystem state for one
	 * resource domain. Callers must hold an exclusive whole-domain lease; this
	 * method serializes the durable decision and advances the generation so no
	 * earlier observation can be reused as the reconciled state. */
	async reconcileDomain(resourceDomainId: string, reason: string): Promise<ReconciliationResult> {
		if (!resourceDomainId) throw new Error("resourceDomainId must be non-empty");
		const normalizedReason = reason.trim();
		if (!normalizedReason || normalizedReason.length > 512) {
			throw new Error("reconcile reason must contain 1-512 characters");
		}
		return this.#mutex.runExclusive(async () => {
			const projection = this.#projection();
			const inDomain = [...projection.intents.values()]
				.filter((intent) => intent.resourceDomainId === resourceDomainId);
			const pending = inDomain.filter((intent) => intent.status === "pending");
			if (pending.length > 0) {
				throw new JournalStateError("Cannot reconcile while a write intent is still pending");
			}
			const dirty = inDomain
				.filter((intent) => intent.status === "dirty-unknown")
				.sort((left, right) => left.intentSequence - right.intentSequence);
			const previousGeneration = projection.domainGenerations.get(resourceDomainId) ?? 0;
			if (dirty.length === 0) {
				return {
					resourceDomainId,
					previousGeneration,
					generation: previousGeneration,
					reconciledIntentIds: [],
				};
			}
			const generation = previousGeneration + 1;
			this.#append([{
				journalVersion: 1,
				type: "write-reconcile",
				ts: new Date(this.now()).toISOString(),
				resourceDomainId,
				reconcileGeneration: generation,
				intentIds: dirty.map((intent) => intent.intentId),
				reason: normalizedReason,
			}]);
			for (const intent of dirty) await this.#settleTerminalPermit(intent.intentId);
			return {
				resourceDomainId,
				previousGeneration,
				generation,
				reconciledIntentIds: dirty.map((intent) => intent.intentId),
			};
		});
	}

	async #settleTerminalPermit(intentId: string): Promise<void> {
		try {
			await this.permits.settleIntent(intentId);
		} catch {
			// The WAL terminal record is the commit/dirty decision point. Permit
			// cleanup may be retried during recovery, but must never turn an already
			// committed filesystem mutation into a retryable execution failure.
			console.warn(`[taskflow] workspace permit cleanup deferred for intent ${intentId}`);
		}
	}

	/** Startup recovery: a stale taskflow-managed content intent may first be
	 * restored by its trusted resource backend. Every other fsynced intent
	 * without a terminal WAL record becomes dirty-unknown before reuse. */
	async recoverPending(
		reason = "startup recovery found an uncommitted write intent",
		options: RecoverPendingOptions = {},
	): Promise<RecoveryResult> {
		return this.#mutex.runExclusive(async () => {
			const projection = this.#projection();
			const pending: WriteIntentRecord[] = [];
			const restored: Array<{
				intent: WriteIntentRecord;
				scopes: ScopedContentEvidence[];
				reason: string;
				artifacts?: string[];
			}> = [];
			const dirty: WriteIntentRecord[] = [];
			for (const intent of projection.intents.values()) {
				if (intent.status !== "pending") continue;
				if (options.isOwnerActive && await options.isOwnerActive(cloneExecutionOwner(intent.owner))) continue;
				pending.push(intent);
				let recovered: Awaited<ReturnType<NonNullable<RecoverPendingOptions["recoverKnownClean"]>>>;
				try {
					recovered = await options.recoverKnownClean?.(cloneIntent(intent));
				} catch {
					recovered = undefined;
				}
				if (recovered) {
					const scopes = normalizeEvidence(recovered.scopes);
					const exact = sameCanonicalScopes(intentScopeKeys(intent), scopes.map((scope) => ({
						resourceDomainId: intent.resourceDomainId,
						canonicalPrefix: scope.canonicalPrefix,
					})));
					const clean = scopes.every((scope) =>
						typeof scope.beforeContentId === "string" && scope.afterContentId === scope.beforeContentId);
					if (exact && clean) {
						restored.push({
							intent,
							scopes,
							reason: recovered.reason || reason,
							...(recovered.restorableSnapshotArtifactIds === undefined
								? {}
								: { artifacts: [...recovered.restorableSnapshotArtifactIds] }),
						});
						continue;
					}
				}
				dirty.push(intent);
			}
			if (pending.length > 0) {
				const ts = new Date(this.now()).toISOString();
				this.#append([
					...restored.map(({ intent, scopes, reason: restoredReason, artifacts }): AbortRestoredWalRecord => ({
						journalVersion: 1,
						type: "write-abort-restored",
						ts,
						intentId: intent.intentId,
						resourceDomainId: intent.resourceDomainId,
						reason: restoredReason,
						scopes,
						...(artifacts === undefined ? {} : { restorableSnapshotArtifactIds: artifacts }),
					})),
					...dirty.map((intent): UnknownWalRecord => ({
						journalVersion: 1,
						type: "write-unknown",
						ts,
						intentId: intent.intentId,
						resourceDomainId: intent.resourceDomainId,
						reason,
					})),
				]);
			}
			// Also closes the crash window after a durable commit/unknown append but
			// before the permit registry transition was persisted. Retained pending
			// intents with a live owner are deliberately excluded.
			const settle = [
				...pending,
				...[...projection.intents.values()].filter((intent) => intent.status !== "pending"),
			];
			for (const intent of settle) await this.#settleTerminalPermit(intent.intentId);
			return {
				recoveredIntentIds: pending.map((intent) => intent.intentId),
				restoredIntentIds: restored.map(({ intent }) => intent.intentId),
				dirtyDomains: [...new Set(dirty.map((intent) => intent.resourceDomainId))].sort(),
			};
		});
	}

	async getIntent(intentId: string): Promise<WriteIntentRecord | undefined> {
		return this.#mutex.runExclusive(() => {
			const intent = this.#projection().intents.get(intentId);
			return intent ? cloneIntent(intent) : undefined;
		});
	}

	async getDomainGeneration(resourceDomainId: string): Promise<number> {
		return this.#mutex.runExclusive(() => this.#projection().domainGenerations.get(resourceDomainId) ?? 0);
	}

	async listIntents(): Promise<WriteIntentRecord[]> {
		return this.#mutex.runExclusive(() => [...this.#projection().intents.values()].map(cloneIntent));
	}
}
