/**
 * Project ControlStore — sole Run/Command/Approval/Receipt authority (D6).
 * Files-only engine (P14): atomic batch commits under exclusive lock, fsync,
 * rebuildable indexes. commitSeq is re-read from disk inside the lock so two
 * open handles cannot mint the same sequence.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	CONTROL_STORE_SCHEMA_VERSION,
	RUN_STATUSES,
	RUN_STAGES,
	type AdmissionIntent,
	type ApprovalRequest,
	type BoundPlan,
	type CommandRecord,
	type ConcurrencyReservation,
	type ControlCompactionState,
	type ControlEvent,
	type ControlStoreHeader,
	type DurableCancelRequest,
	type DurableDispatchAttempt,
	type DurablePhaseAttempt,
	type Receipt,
	type RunContinuation,
	type RunProjection,
} from "../types.ts";
import { newId } from "../hash.ts";
import {
	bindDirectory,
	resolveIdentityOnOpen,
	type IdentityOpenPolicy,
} from "../identity.ts";
import {
	assertNoSymbolicLinkBelow,
	ensureDir,
	fsyncDirectory,
	projectCommandsDir,
	projectControlRoot,
	projectControlRootAnchorPath,
	projectHeaderPath,
	projectJournalAnchorPath,
	projectJournalDir,
	projectProjectionsDir,
	projectReceiptsDir,
	ControlStoreDurabilityError,
	readJsonFileStrict,
	withExclusiveLockFile,
	writeFileAtomic,
} from "../paths.ts";

const READ_ONLY_OPEN_RETRY_SIGNAL = new Int32Array(
	new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
const READ_ONLY_OPEN_TIMEOUT_MS = 30_000;

export interface CommitBatch {
	command?: CommandRecord;
	events: ControlEvent[];
	run?: RunProjection;
	receipt?: Receipt;
}

export type CompareAndCommitFailCode = "TF_NOT_FOUND" | "TF_STALE_VERSION" | "TF_INVALID_ARGUMENT";

export type CompareAndCommitResult =
	| {
			ok: true;
			run: RunProjection;
			receipt?: Receipt;
			commitSeqStart: number;
			commitSeqEnd: number;
	  }
	| {
			ok: false;
			code: CompareAndCommitFailCode;
			message: string;
			run?: RunProjection;
	  };

export interface CompareAndCommitOpts {
	runId: string;
	/** When set, re-read under lock must match (first-commit-wins dual-client CAS). */
	expectedRunVersion?: number;
	/** Return error message to reject (TF_INVALID_ARGUMENT); null = ok. */
	validate?: (run: RunProjection) => string | null;
	/** Build the mutation from the locked durable run snapshot. */
	build: (run: RunProjection) => {
		run: RunProjection;
		events: ControlEvent[];
		command?: CommandRecord;
		receipt?: Receipt;
	};
}

export interface AdmissionIntentClaimInput {
	commandId: string;
	requestHash: string;
	callerPrincipal: string;
	authorizationContextHash: string;
	admission: AdmissionIntent;
}

export type AdmissionIntentClaimResult =
	| { kind: "claimed"; command: CommandRecord }
	| { kind: "existing"; command: CommandRecord }
	| { kind: "conflict"; command: CommandRecord };

export interface PrepareAdmissionInput {
	commandId: string;
	admissionId: string;
	boundPlan: BoundPlan;
	continuation: RunContinuation;
	run: RunProjection;
	reservation: Pick<
		ConcurrencyReservation,
		"reservationId" | "admissionId" | "coordinatorEpoch" | "reservedExpiresAt"
	>;
}

export type PrepareAdmissionResult =
	| {
			kind: "prepared";
			command: CommandRecord;
			run: RunProjection;
			projectAdmitCommitSeq: number;
	  }
	| {
			kind: "rebound";
			command: CommandRecord;
			run: RunProjection;
			projectAdmitCommitSeq: number;
	  }
	| {
			kind: "existing";
			command: CommandRecord;
			run: RunProjection;
			projectAdmitCommitSeq: number;
	  };

export interface FinalizeAdmissionInput {
	commandId: string;
	admissionId: string;
	reservationId: string;
	projectAdmitCommitSeq: number;
}

export type FinalizeAdmissionResult =
	| { kind: "committed"; command: CommandRecord; run: RunProjection }
	| { kind: "existing"; command: CommandRecord; run: RunProjection };

/**
 * One journal-authoritative observation of a Run and the durable records that
 * govern its next externally visible action. It deliberately does not read the
 * rebuildable projection/receipt indexes: a reader must never combine an old
 * derived file with a newer journal tail.
 */
export interface JournalRunSnapshot {
	run: RunProjection | null;
	continuation: RunContinuation | null;
	approval: ApprovalRequest | null;
	receipt: Receipt | null;
}

export interface ProjectControlStore {
	readonly projectRoot: string;
	readonly header: ControlStoreHeader;
	/** Atomic commit: exclusive lock + re-read seq + contiguous commitSeq + fsync. */
	commit(batch: CommitBatch): { commitSeqStart: number; commitSeqEnd: number };
	/**
	 * Dual-client first-commit-wins: under exclusive commit lock, re-read run,
	 * check expectedRunVersion + validate, then commit in the same critical section.
	 */
	compareAndCommit(opts: CompareAndCommitOpts): CompareAndCommitResult;
	/**
	 * Hold the same mutation authority + commit.lock used by CancelRequested and
	 * every other Run mutation across one synchronous provider submit critical
	 * section. The callback must not return a Promise: the lock is the C/S
	 * linearization boundary, so an asynchronous side effect cannot escape it.
	 */
	withProviderSubmissionFence<T>(runId: string, operation: () => T): T;
	/** Rebuild projections from journal (also runs on open). */
	recoverFromJournal(): { rebuiltRuns: number; rebuiltCommands: number; rebuiltReceipts: number };
	/**
	 * Atomic command claim under commit.lock — concurrent same commandId:
	 * same hash → existing; different hash → conflict; missing → claim.
	 */
	claimCommand(input: {
		commandId: string;
		requestHash: string;
		callerPrincipal: string;
		kind: string;
		runId: string;
	}):
		| { kind: "claimed" }
		| { kind: "existing"; command: CommandRecord }
		| { kind: "conflict"; command: CommandRecord };
	/**
	 * P16-1: atomically persist or retrieve a same-command admission intent.
	 * A queued intent has a stable run/admission identity but no published Run.
	 */
	claimAdmissionIntent(input: AdmissionIntentClaimInput): AdmissionIntentClaimResult;
	/** Publish a run exactly once after a coordinator slot has been reserved. */
	prepareAdmission(input: PrepareAdmissionInput): PrepareAdmissionResult;
	/** Record the coordinator commit before any provider dispatch may begin. */
	finalizeAdmission(input: FinalizeAdmissionInput): FinalizeAdmissionResult;
	getRun(runId: string): RunProjection | null;
	/** Immutable journaled plan snapshot for a continuation/restart. */
	getBoundPlan(boundPlanHash: string): BoundPlan | null;
	/** Latest journaled scheduler cursor for a Run. */
	getContinuation(runId: string): RunContinuation | null;
	/**
	 * Read a Run's related durable records from one validated journal view. Writer
	 * stores observe under commit.lock; read-only attaches also verify the anchor
	 * did not advance while they read, otherwise they fail closed.
	 */
	getJournalRunSnapshot(runId: string): JournalRunSnapshot;
	/** Latest journaled approval authority record for a Run. */
	getApprovalForRun(runId: string): ApprovalRequest | null;
	listRuns(): RunProjection[];
	getReceipt(receiptId: string): Receipt | null;
	getReceiptForRun(runId: string): Receipt | null;
	getCommand(commandId: string): CommandRecord | null;
	/** Resolve runId for a prior command (idempotent disclosure). */
	getRunIdForCommand(commandId: string): string | null;
	nextCommitSeq(): number;
	/** Events in [start, end] inclusive by commitSeq. */
	readEvents(startCommitSeq: number, endCommitSeq: number): ControlEvent[];
	/** Durable, journal-derived cursor horizon; never reads a loose cache file. */
	getCompactionState(): ControlCompactionState;
	/**
	 * Append one monotonic journal-bound checkpoint. This is logical cursor
	 * compaction only; it never authorizes physical segment deletion.
	 */
	advanceCompactionCursor(throughCommitSeq: number): ControlCompactionState | { error: string };
}

export interface OpenProjectStoreOptions {
	/**
	 * How to treat a ControlStore whose directoryBinding.path differs from open root.
	 * Default **strict**: refuse clone/worktree silent domain share (TF_IDENTITY_MISMATCH).
	 * - rebind: keep projectId/domainId, update path (explicit project move)
	 * - new-identity: mint new projectId/controlDomainId at this path
	 */
	identityPolicy?: IdentityOpenPolicy;
	/**
	 * Optional host authority fence. Public durable mutations execute inside it
	 * so a replaced singleton epoch cannot write after takeover.
	 */
	mutationFence?: <T>(fn: () => T) => T;
	/**
	 * Observe an already initialized ControlStore without creating directories,
	 * acquiring writer locks, rebuilding indexes, or refreshing identity state.
	 * This is used by singleton attach clients: an incomplete durable commit must
	 * fail closed for the observer rather than be repaired by an observer.
	 */
	readOnly?: boolean;
}

/**
 * Open or create the project ControlStore at projectRoot.
 * Registry is NOT authoritative — header is the source of projectId/domainId.
 *
 * Header create/open is under exclusive lock so concurrent first-opens
 * (cross-process) mint a single projectId/controlDomainId.
 *
 * Path mismatch (copy/clone/worktree) is fail-closed unless identityPolicy allows rebind/mint.
 */
export function openProjectControlStore(
	projectRoot: string,
	opts?: OpenProjectStoreOptions,
): ProjectControlStore {
	const root = path.resolve(projectRoot);
	const identityPolicy = opts?.identityPolicy ?? "strict";
	const mutationFence = opts?.mutationFence;
	const readOnly = opts?.readOnly === true;
	const controlRoot = projectControlRoot(root);
	const rootAnchorPath = projectControlRootAnchorPath(root);

	const headerPath = projectHeaderPath(root);
	const headerLockPath = path.join(controlRoot, "header.lock");
	const journalDir = projectJournalDir(root);
	const journalAnchorPath = projectJournalAnchorPath(root);
	const seqPath = path.join(controlRoot, "commit-seq.json");
	const commitLockPath = path.join(controlRoot, "commit.lock");
	const streamSeqPath = path.join(controlRoot, "stream-seq.json");
	/** Reserved stream for journal-bound cursor checkpoints. */
	const COMPACTION_STREAM_ID = "system-compaction";

	function failDurability(message: string, filePath?: string): never {
		throw new ControlStoreDurabilityError(`ControlStore ${root}: ${message}`, filePath);
	}

	/**
	 * The project root is the caller-selected trust boundary. Durable control
	 * paths below it must never escape through a pre-existing symlink, whether
	 * the target is an authority file, a journal directory, or a lock path.
	 */
	function assertControlLayoutHasNoSymlinks(): void {
		for (const durablePath of [
			rootAnchorPath,
			controlRoot,
			headerPath,
			headerLockPath,
			journalDir,
			journalAnchorPath,
			seqPath,
			commitLockPath,
			streamSeqPath,
			projectProjectionsDir(root),
			projectCommandsDir(root),
			projectReceiptsDir(root),
		]) {
			assertNoSymbolicLinkBelow(root, durablePath);
		}
	}

	function requireExistingDirectory(dir: string, label: string): void {
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(dir);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			failDurability(`${label} directory is unavailable: ${detail}`, dir);
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			failDurability(`${label} path must be a directory`, dir);
		}
	}

	function existingDirectory(dir: string): boolean {
		try {
			const stat = fs.lstatSync(dir);
			if (stat.isSymbolicLink()) {
				failDurability("directory must not be a symbolic link", dir);
			}
			return stat.isDirectory();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			const detail = error instanceof Error ? error.message : String(error);
			failDurability(`cannot inspect directory: ${detail}`, dir);
		}
	}

	function existingPath(filePath: string): boolean {
		try {
			fs.lstatSync(filePath);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			const detail = error instanceof Error ? error.message : String(error);
			failDurability(`cannot inspect durable path: ${detail}`, filePath);
		}
	}

	/**
	 * Singleton publication deliberately precedes the writer's first project
	 * open. A concurrent attach therefore may see the writer's epoch during the
	 * short, monotonic directory-initialization window. It can wait for that
	 * state without taking a writer lock or creating any durable path. Once the
	 * layout exists, the normal integrity checks below decide whether it is valid.
	 */
	function waitForReadOnlyInitialization(): void {
		const requiredDirectories = [
			controlRoot,
			journalDir,
			projectProjectionsDir(root),
			projectCommandsDir(root),
			projectReceiptsDir(root),
		];
		const deadline = Date.now() + READ_ONLY_OPEN_TIMEOUT_MS;
		let attempt = 0;
		while (Date.now() <= deadline) {
			if (fs.existsSync(headerPath) && requiredDirectories.every(existingDirectory)) return;
			Atomics.wait(READ_ONLY_OPEN_RETRY_SIGNAL, 0, 0, 2 + (attempt % 5));
			attempt += 1;
		}
		failDurability(
			`read-only open timed out waiting for writer initialization within ${READ_ONLY_OPEN_TIMEOUT_MS}ms`,
			controlRoot,
		);
	}

	assertControlLayoutHasNoSymlinks();
	const preexistingRootAnchor = readJsonFileStrict<unknown>(rootAnchorPath);
	if (preexistingRootAnchor !== null && !existingPath(controlRoot)) {
		failDurability(
			"project-root anchor exists but the control subtree is missing; refusing to mint a new authority",
			controlRoot,
		);
	}
	if (readOnly) {
		waitForReadOnlyInitialization();
		assertControlLayoutHasNoSymlinks();
	} else {
		ensureDir(controlRoot);
		assertControlLayoutHasNoSymlinks();
	}

	function withMutationFence<T>(fn: () => T): T {
		return mutationFence ? mutationFence(fn) : fn();
	}

	/**
	 * A journal segment is published after its new anchor. That ordering makes a
	 * crash between the two writes observable and fail-closed, but an ordinary
	 * concurrent writer must not mistake that tiny publication window for a
	 * crash. All mutable-host journal reads therefore share commit.lock with
	 * commits. Read-only singleton attaches deliberately retain their strict
	 * observer semantics: they never acquire a writer lock and fail closed if
	 * they observe an incomplete publish.
	 *
	 * `withExclusiveLockFile` is not re-entrant. Keep a synchronous depth so a
	 * compare-and-commit validator can inspect the journal under its already
	 * held lock without deadlocking itself.
	 */
	let commitLockDepth = 0;
	function withCommitLock<T>(fn: () => T): T {
		if (commitLockDepth > 0) return fn();
		assertControlLayoutHasNoSymlinks();
		return withExclusiveLockFile(commitLockPath, () => {
			commitLockDepth += 1;
			try {
				return fn();
			} finally {
				commitLockDepth -= 1;
			}
		});
	}

	function readConsistentJournal<T>(fn: () => T): T {
		assertControlLayoutHasNoSymlinks();
		return readOnly ? fn() : withCommitLock(fn);
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	function isNonEmptyString(value: unknown): value is string {
		return typeof value === "string" && value.length > 0;
	}

	function isPositiveSafeInteger(value: unknown): value is number {
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
	}

	function isNonNegativeSafeInteger(value: unknown): value is number {
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	}

	interface ProjectRootAnchor {
		schemaVersion: 1;
		projectId: string;
		controlDomainId: string;
		createdAt: number;
	}

	function validateProjectRootAnchor(value: unknown, filePath: string): ProjectRootAnchor {
		if (
			!isRecord(value) ||
			!Object.keys(value).every((key) =>
				["schemaVersion", "projectId", "controlDomainId", "createdAt"].includes(key),
			) ||
			value.schemaVersion !== 1 ||
			!isNonEmptyString(value.projectId) ||
			!isNonEmptyString(value.controlDomainId) ||
			!isNonNegativeSafeInteger(value.createdAt)
		) {
			failDurability("project-root anchor has an invalid shape", filePath);
		}
		return value as unknown as ProjectRootAnchor;
	}

	function readProjectRootAnchor(): ProjectRootAnchor | null {
		const raw = readJsonFileStrict<unknown>(rootAnchorPath);
		return raw === null ? null : validateProjectRootAnchor(raw, rootAnchorPath);
	}

	function assertProjectRootAnchorMatches(
		anchor: ProjectRootAnchor,
		header: ControlStoreHeader,
	): void {
		if (
			anchor.projectId !== header.projectId ||
			anchor.controlDomainId !== header.controlDomainId
		) {
			failDurability("project-root anchor does not match the durable header identity", rootAnchorPath);
		}
	}

	/**
	 * Once a header exists, absence of its project-root identity evidence is not
	 * indistinguishable from first use. Treat it as a legacy/missing-evidence
	 * boundary and fail closed rather than letting normal open silently continue.
	 * A future explicit migration must carry its own approved trust protocol.
	 */
	function requireProjectRootAnchor(
		anchor: ProjectRootAnchor | null,
		header: ControlStoreHeader,
	): void {
		if (anchor === null) {
			failDurability(
				"project-root identity anchor is missing for an existing header; explicit migration is required",
				rootAnchorPath,
			);
		}
		assertProjectRootAnchorMatches(anchor, header);
	}

	function writeProjectRootAnchor(header: ControlStoreHeader): void {
		const anchor: ProjectRootAnchor = {
			schemaVersion: 1,
			projectId: header.projectId,
			controlDomainId: header.controlDomainId,
			createdAt: Date.now(),
		};
		// Anchor first. A crash before header publication denies the open rather
		// than treating a previously named project root as a fresh authority.
		writeFileAtomic(rootAnchorPath, JSON.stringify(anchor, null, 2));
	}

	function validateHeader(value: unknown, filePath: string): ControlStoreHeader {
		if (!isRecord(value)) failDurability("header must be a JSON object", filePath);
		const binding = value.directoryBinding;
		if (
			value.schemaVersion !== CONTROL_STORE_SCHEMA_VERSION ||
			!isNonEmptyString(value.projectId) ||
			!isNonEmptyString(value.controlDomainId) ||
			!isRecord(binding) ||
			!isNonEmptyString(binding.path) ||
			!path.isAbsolute(binding.path) ||
			!isNonNegativeSafeInteger(value.createdAt) ||
			!isNonNegativeSafeInteger(value.updatedAt) ||
			(binding.inode !== undefined && typeof binding.inode !== "string") ||
			(binding.dev !== undefined && typeof binding.dev !== "string")
		) {
			failDurability("header has an unsupported or invalid shape", filePath);
		}
		return value as unknown as ControlStoreHeader;
	}

	// A singleton attach must never acquire a writer lock or mint/rebind an
	// identity. Its only safe open is an already persisted, same-root header.
	const header = readOnly
		? (() => {
				const rootAnchor = readProjectRootAnchor();
				const rawExisting = readJsonFileStrict<unknown>(headerPath);
				if (rawExisting === null) {
					failDurability("read-only open requires an existing header", headerPath);
				}
				const existing = validateHeader(rawExisting, headerPath);
				requireProjectRootAnchor(rootAnchor, existing);
				const decision = resolveIdentityOnOpen(existing, root, identityPolicy);
				if (decision.action !== "keep") {
					failDurability(
						"read-only open cannot rebind or mint a control-domain identity",
						headerPath,
					);
				}
				return existing;
			})()
		: withExclusiveLockFile(headerLockPath, () => {
		const rootAnchor = readProjectRootAnchor();
		const rawExisting = readJsonFileStrict<unknown>(headerPath);
		if (rawExisting !== null) {
			const existing = validateHeader(rawExisting, headerPath);
			requireProjectRootAnchor(rootAnchor, existing);
			const decision = resolveIdentityOnOpen(existing, root, identityPolicy);
			if (decision.action === "mint-new") {
				const now = Date.now();
				const created: ControlStoreHeader = {
					schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
					projectId: newId("proj"),
					controlDomainId: newId("dom"),
					directoryBinding: decision.binding,
					createdAt: now,
					updatedAt: now,
				};
				// `new-identity` is the explicit authority to replace a copied
				// root anchor. Publish it before its matching header.
				writeProjectRootAnchor(created);
				writeFileAtomic(headerPath, JSON.stringify(created, null, 2));
				const persisted = readJsonFileStrict<unknown>(headerPath);
				if (persisted === null) failDurability("header disappeared after atomic write", headerPath);
				return validateHeader(persisted, headerPath);
			}
			// A normal same-path open is observation, not a header mutation. This
			// preserves the header bytes when subsequent journal validation fails.
			if (decision.action === "keep") return existing;
			// Explicit rebind (path move with the same identity) is the only
			// existing-header path that refreshes its directory binding.
			const refreshed: ControlStoreHeader = {
				...existing,
				directoryBinding: decision.binding,
				updatedAt: Date.now(),
			};
			writeFileAtomic(headerPath, JSON.stringify(refreshed, null, 2));
			return refreshed;
		}
		if (rootAnchor !== null) {
			failDurability("project-root anchor exists but header is missing", headerPath);
		}
		const now = Date.now();
		const created: ControlStoreHeader = {
			schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
			projectId: newId("proj"),
			controlDomainId: newId("dom"),
			directoryBinding: bindDirectory(root),
			createdAt: now,
			updatedAt: now,
		};
		writeProjectRootAnchor(created);
		writeFileAtomic(headerPath, JSON.stringify(created, null, 2));
		const persisted = readJsonFileStrict<unknown>(headerPath);
		if (persisted === null) failDurability("header disappeared after atomic write", headerPath);
		return validateHeader(persisted, headerPath);
		});

	// The journal directory is authoritative, unlike projections and indexes. Do
	// not recreate it after an anchored/numbered store loses it: doing so would
	// turn evidence loss into a plausible fresh empty journal.
	if (readOnly) {
		requireExistingDirectory(journalDir, "journal");
		requireExistingDirectory(projectProjectionsDir(root), "projections");
		requireExistingDirectory(projectCommandsDir(root), "commands");
		requireExistingDirectory(projectReceiptsDir(root), "receipts");
	} else {
		if (!fs.existsSync(journalDir)) {
			if (fs.existsSync(journalAnchorPath) || fs.existsSync(seqPath) || fs.existsSync(streamSeqPath)) {
				failDurability("journal directory is missing after durable journal initialization", journalDir);
			}
			ensureDir(journalDir);
		}
		// These are derived from the journal and may be regenerated under commit.lock.
		ensureDir(projectProjectionsDir(root));
		ensureDir(projectCommandsDir(root));
		ensureDir(projectReceiptsDir(root));
	}

	// Mutable local cache; identity fields never change after first create.
	let headerCache = header;

	function readPersistedCommitSeq(): number | null {
		const raw = readJsonFileStrict<unknown>(seqPath);
		if (raw === null) return null;
		if (!isRecord(raw) || !isPositiveSafeInteger(raw.next)) {
			failDurability("commit-seq.json must contain a positive integer next", seqPath);
		}
		return raw.next;
	}

	function readSeqNext(): number {
		return readPersistedCommitSeq() ?? 1;
	}

	function isSafeCommandId(id: unknown): id is string {
		return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
	}

	function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
		return Object.keys(value).every((key) => allowed.includes(key));
	}

	function isOptionalString(value: unknown): boolean {
		return value === undefined || typeof value === "string";
	}

	function isOptionalSafeId(value: unknown): boolean {
		return value === undefined || isSafeCommandId(value);
	}

	/**
	 * `providerClass` is an E-1 in-memory fact. Schema-1 readers do not know this
	 * field; only a future schema-2 DispatchAttemptPlanned record may persist the
	 * full provider route contract.
	 */
	function serializeSchema1BoundPlan(boundPlan: BoundPlan): BoundPlan {
		const { providerClass: _providerClass, ...schema1BoundPlan } = boundPlan;
		return schema1BoundPlan;
	}

	const runStatuses = new Set<string>(RUN_STATUSES);
	const runStages = new Set<string>(RUN_STAGES);
	const terminalStatuses = new Set<string>(["completed", "failed", "blocked", "cancelled"]);
	const commandStatuses = new Set<string>(["queued", "accepted", "completed", "failed", "rejected"]);
	const admissionIntentStates = new Set<string>(["queued", "project-prepared", "slot-committed"]);
	const approvalStatuses = new Set<string>([
		"pending",
		"approved",
		"rejected",
		"edited",
		"expired",
		"cancelled",
	]);
	const approvalDecisions = new Set<string>(["approve", "reject", "edit"]);
	const continuationStatuses = new Set<string>(["active", "parked", "approved", "terminal"]);
	const phaseAttemptStatuses = new Set<string>(["completed", "failed", "skipped", "still-running"]);
	const dispatchStates = new Set<string>(["prepared", "intent-recorded", "acknowledged", "ambiguous"]);
	const cancelStates = new Set<string>(["requested", "signalling", "ambiguous"]);

	function validateBoundPlan(value: unknown, filePath: string): BoundPlan {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, [
				"boundPlanHash",
				"executionSemanticHash",
				"programName",
				"program",
				"irHash",
				"createdAt",
				"approvalMode",
				"grantRefs",
			]) ||
			!isNonEmptyString(value.boundPlanHash) ||
			!isNonEmptyString(value.executionSemanticHash) ||
			!isNonEmptyString(value.programName) ||
			!isRecord(value.program) ||
			(value.irHash !== undefined && !isNonEmptyString(value.irHash)) ||
			!isNonNegativeSafeInteger(value.createdAt) ||
			(value.approvalMode !== "compat-auto-reject" &&
				value.approvalMode !== "durable-optional" &&
				value.approvalMode !== "durable-required") ||
			!Array.isArray(value.grantRefs) ||
			!value.grantRefs.every((grant) => isNonEmptyString(grant))
		) {
			failDurability("BoundPlan event has an invalid durable shape", filePath);
		}
		return value as unknown as BoundPlan;
	}

	/** `createdAt` is audit metadata, not part of the immutable plan identity. */
	function sameBoundPlan(left: BoundPlan, right: BoundPlan): boolean {
		const { createdAt: _leftCreatedAt, ...leftIdentity } = left;
		const { createdAt: _rightCreatedAt, ...rightIdentity } = right;
		return isDeepStrictEqual(leftIdentity, rightIdentity);
	}

	function validateDurablePhaseAttempt(value: unknown, filePath: string): DurablePhaseAttempt {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, ["phaseId", "type", "status", "attemptId", "output", "error", "providerName", "handle"]) ||
			!isSafeCommandId(value.phaseId) ||
			!isNonEmptyString(value.type) ||
			!phaseAttemptStatuses.has(String(value.status)) ||
			!isSafeCommandId(value.attemptId) ||
			!isOptionalString(value.output) ||
			!isOptionalString(value.error) ||
			!isOptionalString(value.providerName) ||
			!isOptionalString(value.handle)
		) {
			failDurability("durable phase attempt has an invalid shape", filePath);
		}
		return value as unknown as DurablePhaseAttempt;
	}

	function validateDurableDispatchAttempt(value: unknown, filePath: string): DurableDispatchAttempt {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, [
				"attemptId",
				"phaseId",
				"type",
				"idempotencyKey",
				"providerName",
				"state",
				"providerHandle",
				"createdAt",
				"updatedAt",
			]) ||
			!isSafeCommandId(value.attemptId) ||
			!isSafeCommandId(value.phaseId) ||
			!isNonEmptyString(value.type) ||
			!isNonEmptyString(value.idempotencyKey) ||
			!isNonEmptyString(value.providerName) ||
			!dispatchStates.has(String(value.state)) ||
			!isOptionalString(value.providerHandle) ||
			!isNonNegativeSafeInteger(value.createdAt) ||
			!isNonNegativeSafeInteger(value.updatedAt) ||
			value.updatedAt < value.createdAt
		) {
			failDurability("durable dispatch attempt has an invalid shape", filePath);
		}
		if (
			(value.state === "acknowledged" || value.state === "ambiguous") &&
			value.providerHandle === undefined
		) {
			failDurability("acknowledged/ambiguous dispatch requires a provider handle", filePath);
		}
		return value as unknown as DurableDispatchAttempt;
	}

	function validateDurableCancelRequest(value: unknown, filePath: string): DurableCancelRequest {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, [
				"commandId",
				"requestHash",
				"principal",
					"state",
					"providerHandle",
					"providerName",
					"continuationId",
					"continuationVersion",
					"attemptId",
					"phaseId",
					"fencingEpoch",
					"requestedAt",
					"updatedAt",
			]) ||
			!isSafeCommandId(value.commandId) ||
			!isNonEmptyString(value.requestHash) ||
			!isNonEmptyString(value.principal) ||
				!cancelStates.has(String(value.state)) ||
				!isOptionalString(value.providerHandle) ||
				!isOptionalString(value.providerName) ||
				!isOptionalSafeId(value.continuationId) ||
				(value.continuationVersion !== undefined && !isPositiveSafeInteger(value.continuationVersion)) ||
				!isOptionalSafeId(value.attemptId) ||
				!isOptionalSafeId(value.phaseId) ||
				(value.fencingEpoch !== undefined && !isNonNegativeSafeInteger(value.fencingEpoch)) ||
			!isNonNegativeSafeInteger(value.requestedAt) ||
			!isNonNegativeSafeInteger(value.updatedAt) ||
			value.updatedAt < value.requestedAt
		) {
			failDurability("durable cancel request has an invalid shape", filePath);
		}
		return value as unknown as DurableCancelRequest;
	}

	function validateRunContinuation(value: unknown, filePath: string): RunContinuation {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, [
				"schemaVersion",
				"continuationId",
				"runId",
				"projectId",
				"controlDomainId",
				"boundPlanHash",
				"status",
				"nextPhaseId",
				"phaseAttempts",
				"phaseOutputs",
				"activeAttempt",
				"approvalPhaseId",
				"approvalRequestId",
				"createdAt",
				"updatedAt",
				"version",
			]) ||
			value.schemaVersion !== CONTROL_STORE_SCHEMA_VERSION ||
			!isSafeCommandId(value.continuationId) ||
			!isSafeCommandId(value.runId) ||
			value.projectId !== headerCache.projectId ||
			value.controlDomainId !== headerCache.controlDomainId ||
			!isNonEmptyString(value.boundPlanHash) ||
			!continuationStatuses.has(String(value.status)) ||
			!isOptionalSafeId(value.nextPhaseId) ||
			!Array.isArray(value.phaseAttempts) ||
			!isRecord(value.phaseOutputs) ||
			!isOptionalSafeId(value.approvalPhaseId) ||
			!isOptionalSafeId(value.approvalRequestId) ||
			!isNonNegativeSafeInteger(value.createdAt) ||
			!isNonNegativeSafeInteger(value.updatedAt) ||
			value.updatedAt < value.createdAt ||
			!isPositiveSafeInteger(value.version)
		) {
			failDurability("RunContinuation has an invalid or cross-domain durable shape", filePath);
		}
		const attempts = value.phaseAttempts.map((attempt) => validateDurablePhaseAttempt(attempt, filePath));
		if (new Set(attempts.map((attempt) => attempt.phaseId)).size !== attempts.length) {
			failDurability("RunContinuation has duplicate settled phase ids", filePath);
		}
		for (const [phaseId, output] of Object.entries(value.phaseOutputs)) {
			const attempt = attempts.find((candidate) => candidate.phaseId === phaseId);
			if (!isSafeCommandId(phaseId) || typeof output !== "string" || attempt?.status !== "completed") {
				failDurability("RunContinuation output does not match a completed phase", filePath);
			}
		}
		if (value.activeAttempt !== undefined) {
			const active = validateDurableDispatchAttempt(value.activeAttempt, filePath);
			if (attempts.some((attempt) => attempt.phaseId === active.phaseId)) {
				failDurability("RunContinuation active attempt is already settled", filePath);
			}
		}
		if (value.status === "parked" && (!value.approvalPhaseId || !value.approvalRequestId)) {
			failDurability("parked continuation must identify its approval phase and request", filePath);
		}
		return value as unknown as RunContinuation;
	}

	function validateApprovalRequest(value: unknown, filePath: string): ApprovalRequest {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, [
				"approvalRequestId",
				"runId",
				"projectId",
				"controlDomainId",
				"status",
				"allowedDecisions",
				"createdAt",
				"deadline",
				"decidedAt",
				"decision",
				"decisionCommandId",
				"deciderPrincipal",
				"expectedRunVersion",
				"note",
				"continuationId",
				"phaseId",
				"message",
			]) ||
			!isSafeCommandId(value.approvalRequestId) ||
			!isSafeCommandId(value.runId) ||
			value.projectId !== headerCache.projectId ||
			value.controlDomainId !== headerCache.controlDomainId ||
			!approvalStatuses.has(String(value.status)) ||
			!Array.isArray(value.allowedDecisions) ||
			value.allowedDecisions.length === 0 ||
			!value.allowedDecisions.every((decision) => approvalDecisions.has(String(decision))) ||
			new Set(value.allowedDecisions).size !== value.allowedDecisions.length ||
			!isNonNegativeSafeInteger(value.createdAt) ||
			(value.deadline !== undefined && !isNonNegativeSafeInteger(value.deadline)) ||
			(value.decidedAt !== undefined && !isNonNegativeSafeInteger(value.decidedAt)) ||
			(value.decision !== undefined && !approvalDecisions.has(String(value.decision))) ||
			!isOptionalSafeId(value.decisionCommandId) ||
			!isOptionalString(value.deciderPrincipal) ||
			!isPositiveSafeInteger(value.expectedRunVersion) ||
			!isOptionalString(value.note) ||
			!isOptionalSafeId(value.continuationId) ||
			!isOptionalSafeId(value.phaseId) ||
			!isOptionalString(value.message)
		) {
			failDurability("ApprovalRequest has an invalid or cross-domain durable shape", filePath);
		}
		if (
			(value.status === "pending" && value.decision !== undefined) ||
			(value.status !== "pending" && value.status !== "expired" && value.status !== "cancelled" && value.decision === undefined)
		) {
			failDurability("ApprovalRequest decision/status relationship is invalid", filePath);
		}
		return value as unknown as ApprovalRequest;
	}

	function validateAdmissionIntent(value: unknown, filePath: string): AdmissionIntent {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, [
				"schemaVersion",
				"admissionId",
				"runId",
				"continuationId",
				"boundPlanHash",
				"state",
				"reservationId",
				"reservationGeneration",
				"createdAt",
				"updatedAt",
			]) ||
			value.schemaVersion !== 1 ||
			!isSafeCommandId(value.admissionId) ||
			!isSafeCommandId(value.runId) ||
			!isSafeCommandId(value.continuationId) ||
			!isNonEmptyString(value.boundPlanHash) ||
			!admissionIntentStates.has(String(value.state)) ||
			!isOptionalSafeId(value.reservationId) ||
			(value.reservationGeneration !== undefined && !isNonNegativeSafeInteger(value.reservationGeneration)) ||
			!isNonNegativeSafeInteger(value.createdAt) ||
			!isNonNegativeSafeInteger(value.updatedAt) ||
			value.updatedAt < value.createdAt ||
			(value.state === "queued" && value.reservationId !== undefined) ||
			(value.state === "queued" &&
				value.reservationGeneration !== undefined &&
				value.reservationGeneration !== 0) ||
			(value.state !== "queued" && value.reservationId === undefined)
		) {
			failDurability("AdmissionIntent has an invalid durable shape or transition state", filePath);
		}
		return value as unknown as AdmissionIntent;
	}

	function validateEventPayload(value: unknown, filePath: string): ControlEvent["payload"] {
		if (!isRecord(value) || !isNonEmptyString(value.type)) {
			failDurability("event payload must be a typed JSON object", filePath);
		}
		switch (value.type) {
			case "AdmissionIntentRecorded":
				if (
					!hasOnlyKeys(value, ["type", "commandId", "admission"]) ||
					!isSafeCommandId(value.commandId)
				) {
					failDurability("AdmissionIntentRecorded payload has an invalid shape", filePath);
				}
				validateAdmissionIntent(value.admission, filePath);
				break;
			case "SlotReserved":
				if (
					!hasOnlyKeys(value, [
						"type",
						"runId",
						"admissionId",
						"reservationId",
						"coordinatorEpoch",
						"reservedExpiresAt",
					]) ||
					!isSafeCommandId(value.runId) ||
					!isSafeCommandId(value.admissionId) ||
					!isSafeCommandId(value.reservationId) ||
					!isNonNegativeSafeInteger(value.coordinatorEpoch) ||
					!isPositiveSafeInteger(value.reservedExpiresAt)
				) {
					failDurability("SlotReserved payload has an invalid shape", filePath);
				}
				break;
			case "AdmissionReservationRebound":
				if (
					!hasOnlyKeys(value, [
						"type",
						"runId",
						"admissionId",
						"fromReservationId",
						"reservationId",
						"reservationGeneration",
						"coordinatorEpoch",
						"reservedExpiresAt",
					]) ||
					!isSafeCommandId(value.runId) ||
					!isSafeCommandId(value.admissionId) ||
					!isSafeCommandId(value.fromReservationId) ||
					!isSafeCommandId(value.reservationId) ||
					value.fromReservationId === value.reservationId ||
					!isPositiveSafeInteger(value.reservationGeneration) ||
					!isNonNegativeSafeInteger(value.coordinatorEpoch) ||
					!isPositiveSafeInteger(value.reservedExpiresAt)
				) {
					failDurability("AdmissionReservationRebound payload has an invalid shape", filePath);
				}
				break;
			case "ProjectRunPrepared":
				if (
					!hasOnlyKeys(value, ["type", "runId", "admissionId", "reservationId"]) ||
					!isSafeCommandId(value.runId) ||
					!isSafeCommandId(value.admissionId) ||
					!isSafeCommandId(value.reservationId)
				) {
					failDurability("ProjectRunPrepared payload has an invalid shape", filePath);
				}
				break;
			case "SlotCommitted":
				if (
					!hasOnlyKeys(value, [
						"type",
						"runId",
						"admissionId",
						"reservationId",
						"projectAdmitCommitSeq",
					]) ||
					!isSafeCommandId(value.runId) ||
					!isSafeCommandId(value.admissionId) ||
					!isSafeCommandId(value.reservationId) ||
					!isPositiveSafeInteger(value.projectAdmitCommitSeq)
				) {
					failDurability("SlotCommitted payload has an invalid shape", filePath);
				}
				break;
			case "RunReceived":
				if (
					!hasOnlyKeys(value, ["type", "runId", "boundPlanHash"]) ||
					!isSafeCommandId(value.runId) ||
					!isNonEmptyString(value.boundPlanHash)
				) {
					failDurability("RunReceived payload has an invalid shape", filePath);
				}
				break;
			case "RunAdmitted":
				if (
					!hasOnlyKeys(value, ["type", "runId", "reservationId"]) ||
					!isSafeCommandId(value.runId) ||
					!isSafeCommandId(value.reservationId)
				) {
					failDurability("RunAdmitted payload has an invalid shape", filePath);
				}
				break;
			case "RunStatusChanged":
				if (
					!hasOnlyKeys(value, ["type", "runId", "status", "stage", "reason"]) ||
					!isSafeCommandId(value.runId) ||
					!runStatuses.has(String(value.status)) ||
					!runStages.has(String(value.stage)) ||
					!isOptionalString(value.reason)
				) {
					failDurability("RunStatusChanged payload has an invalid shape", filePath);
				}
				break;
			case "ReconcileStarted":
				if (
					!hasOnlyKeys(value, ["type", "runId", "attempt"]) ||
					!isSafeCommandId(value.runId) ||
					!isPositiveSafeInteger(value.attempt)
				) {
					failDurability("ReconcileStarted payload has an invalid shape", filePath);
				}
				break;
			case "ReconcileSettled":
				if (
					!hasOnlyKeys(value, ["type", "runId", "outcome"]) ||
					!isSafeCommandId(value.runId) ||
					(value.outcome !== "terminal" && value.outcome !== "still-running" && value.outcome !== "exhausted")
				) {
					failDurability("ReconcileSettled payload has an invalid shape", filePath);
				}
				break;
			case "NeedsOperator":
				if (
					!hasOnlyKeys(value, ["type", "runId", "code"]) ||
					!isSafeCommandId(value.runId) ||
					value.code !== "TF_RECONCILE_REQUIRED"
				) {
					failDurability("NeedsOperator payload has an invalid shape", filePath);
				}
				break;
			case "ReceiptIssued":
				if (
					!hasOnlyKeys(value, ["type", "runId", "receiptId"]) ||
					!isSafeCommandId(value.runId) ||
					!isSafeCommandId(value.receiptId)
				) {
					failDurability("ReceiptIssued payload has an invalid shape", filePath);
				}
				break;
			case "ApprovalParked":
				if (
					!hasOnlyKeys(value, ["type", "runId", "approvalRequestId"]) ||
					!isSafeCommandId(value.runId) ||
					!isSafeCommandId(value.approvalRequestId)
				) {
					failDurability("ApprovalParked payload has an invalid shape", filePath);
				}
				break;
			case "ApprovalDecided":
				if (
					!hasOnlyKeys(value, ["type", "runId", "approvalRequestId", "decision"]) ||
					!isSafeCommandId(value.runId) ||
					!isSafeCommandId(value.approvalRequestId) ||
					!isNonEmptyString(value.decision)
				) {
					failDurability("ApprovalDecided payload has an invalid shape", filePath);
				}
				break;
			case "BoundPlanStored":
				if (
					!hasOnlyKeys(value, ["type", "runId", "boundPlan"]) ||
					!isSafeCommandId(value.runId)
				) {
					failDurability("BoundPlanStored payload has an invalid shape", filePath);
				}
				validateBoundPlan(value.boundPlan, filePath);
				break;
			case "ContinuationStored":
				if (!hasOnlyKeys(value, ["type", "continuation"])) {
					failDurability("ContinuationStored payload has an invalid shape", filePath);
				}
				validateRunContinuation(value.continuation, filePath);
				break;
			case "AttemptPrepared":
			case "DispatchIntentRecorded":
			case "DispatchAcknowledged":
				if (
					!hasOnlyKeys(value, ["type", "runId", "continuationId", "attempt"]) ||
					!isSafeCommandId(value.runId) ||
					!isSafeCommandId(value.continuationId)
				) {
					failDurability(`${value.type} payload has an invalid shape`, filePath);
				}
				validateDurableDispatchAttempt(value.attempt, filePath);
				break;
			case "ApprovalRequestStored":
				if (!hasOnlyKeys(value, ["type", "approval"])) {
					failDurability("ApprovalRequestStored payload has an invalid shape", filePath);
				}
				validateApprovalRequest(value.approval, filePath);
				break;
			case "CompactionCheckpoint":
				if (
					!hasOnlyKeys(value, ["type", "throughCommitSeq"]) ||
					!isPositiveSafeInteger(value.throughCommitSeq)
				) {
					failDurability("CompactionCheckpoint payload has an invalid shape", filePath);
				}
				break;
			case "Generic":
				if (
					!hasOnlyKeys(value, ["type", "kind", "data"]) ||
					!isNonEmptyString(value.kind) ||
					(value.data !== undefined && !isRecord(value.data))
				) {
					failDurability("Generic event payload has an invalid shape", filePath);
				}
				break;
			default:
				failDurability(`unsupported event payload type ${JSON.stringify(value.type)}`, filePath);
		}
		return value as unknown as ControlEvent["payload"];
	}

	function validateControlEvent(value: unknown, filePath: string): ControlEvent {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, [
				"eventId",
				"schemaVersion",
				"controlDomainId",
				"streamId",
				"streamSeq",
				"commitSeq",
				"commandId",
				"commandEventIndex",
				"causationId",
				"correlationId",
				"projectId",
				"recordedAt",
				"payload",
			]) ||
			!isSafeCommandId(value.eventId) ||
			value.schemaVersion !== CONTROL_STORE_SCHEMA_VERSION ||
			value.projectId !== headerCache.projectId ||
			value.controlDomainId !== headerCache.controlDomainId ||
			!isSafeCommandId(value.streamId) ||
			!isPositiveSafeInteger(value.streamSeq) ||
			!isPositiveSafeInteger(value.commitSeq) ||
			!isOptionalSafeId(value.commandId) ||
			(value.commandEventIndex !== undefined && !isNonNegativeSafeInteger(value.commandEventIndex)) ||
			!isOptionalSafeId(value.causationId) ||
			!isOptionalSafeId(value.correlationId) ||
			!isNonNegativeSafeInteger(value.recordedAt)
		) {
			failDurability("event has an invalid or cross-domain durable shape", filePath);
		}
		validateEventPayload(value.payload, filePath);
		return value as unknown as ControlEvent;
	}

	function validateCommandRecord(value: unknown, filePath: string): CommandRecord {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, [
				"commandId",
				"requestHash",
				"callerPrincipal",
				"authorizationContextHash",
				"projectId",
				"controlDomainId",
				"kind",
				"status",
				"firstCommitSeq",
				"lastCommitSeq",
				"runId",
				"admission",
				"responseArtifactRef",
				"recordedAt",
			]) ||
			!isSafeCommandId(value.commandId) ||
			!isNonEmptyString(value.requestHash) ||
			!isNonEmptyString(value.callerPrincipal) ||
			!isNonEmptyString(value.authorizationContextHash) ||
			value.projectId !== headerCache.projectId ||
			value.controlDomainId !== headerCache.controlDomainId ||
			!isNonEmptyString(value.kind) ||
			!commandStatuses.has(String(value.status)) ||
			!isPositiveSafeInteger(value.firstCommitSeq) ||
			!isPositiveSafeInteger(value.lastCommitSeq) ||
			value.lastCommitSeq < value.firstCommitSeq ||
			!isOptionalSafeId(value.runId) ||
			(value.responseArtifactRef !== undefined && !isNonEmptyString(value.responseArtifactRef)) ||
			!isNonNegativeSafeInteger(value.recordedAt)
		) {
			failDurability("command record has an invalid or cross-domain durable shape", filePath);
		}
		if (value.admission !== undefined) {
			const admission = validateAdmissionIntent(value.admission, filePath);
			if (
				value.kind !== "admitAndRun" ||
				value.runId !== admission.runId ||
				(value.status === "queued" && admission.state !== "queued") ||
				(value.status !== "queued" && admission.state === "queued")
			) {
				failDurability("admission command state does not match its durable admission intent", filePath);
			}
		} else if (value.status === "queued") {
			failDurability("only an admission command may use queued status", filePath);
		}
		return value as unknown as CommandRecord;
	}

	function validateRunProjection(value: unknown, filePath: string): RunProjection {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, [
				"runId",
				"projectId",
				"controlDomainId",
				"status",
				"stage",
				"boundPlanHash",
				"boundFragmentHash",
				"needsOperator",
				"admissionId",
				"reservationId",
				"createdAt",
				"updatedAt",
				"finalOutput",
				"receiptId",
				"runVersion",
				"error",
				"approvalRequestId",
				"providerHandle",
				"providerLeaseEpoch",
				"providerName",
				"cancelRequest",
				"continuationId",
			]) ||
			!isSafeCommandId(value.runId) ||
			value.projectId !== headerCache.projectId ||
			value.controlDomainId !== headerCache.controlDomainId ||
			!runStatuses.has(String(value.status)) ||
			!runStages.has(String(value.stage)) ||
			!isNonEmptyString(value.boundPlanHash) ||
			(value.boundFragmentHash !== undefined && !isNonEmptyString(value.boundFragmentHash)) ||
			typeof value.needsOperator !== "boolean" ||
			!isOptionalSafeId(value.admissionId) ||
			!isOptionalSafeId(value.reservationId) ||
			!isNonNegativeSafeInteger(value.createdAt) ||
			!isNonNegativeSafeInteger(value.updatedAt) ||
			value.updatedAt < value.createdAt ||
			!isOptionalString(value.finalOutput) ||
			!isOptionalSafeId(value.receiptId) ||
			!isPositiveSafeInteger(value.runVersion) ||
			!isOptionalString(value.error) ||
			!isOptionalSafeId(value.approvalRequestId) ||
			!isOptionalString(value.providerHandle) ||
			(value.providerLeaseEpoch !== undefined && !isPositiveSafeInteger(value.providerLeaseEpoch)) ||
			!isOptionalString(value.providerName) ||
			(value.cancelRequest !== undefined && !isRecord(value.cancelRequest)) ||
			!isOptionalSafeId(value.continuationId)
		) {
			failDurability("run projection has an invalid or cross-domain durable shape", filePath);
		}
		const cancelRequest =
			value.cancelRequest === undefined
				? undefined
				: validateDurableCancelRequest(value.cancelRequest, filePath);
		const isTerminal = terminalStatuses.has(String(value.status));
		if ((value.stage === "terminal") !== isTerminal) {
			failDurability("run terminal status and stage disagree", filePath);
		}
		if (value.receiptId !== undefined && (value.status !== "completed" || value.stage !== "terminal")) {
			failDurability("run with a Receipt must be completed and terminal", filePath);
		}
		if (cancelRequest) {
			if (value.status !== "unknown" || value.stage !== "reconciling") {
				failDurability("pending cancel request must retain an unknown/reconciling run", filePath);
			}
		}
		// `needsOperator` is an auditable recovery flag, not a terminal-state
		// proof. Approval/lifecycle transitions must clear or reconcile it through
		// the real provider protocol; that P15 rule cannot be inferred from a
		// standalone projection schema without masking the still-open lifecycle
		// defect in this branch.
		return value as unknown as RunProjection;
	}

	function validateReceipt(value: unknown, filePath: string): Receipt {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, [
				"receiptId",
				"controlDomainId",
				"projectId",
				"runId",
				"boundPlanHash",
				"boundFragmentHash",
				"eventManifest",
				"startCommitSeq",
				"endCommitSeq",
				"artifactRefs",
				"assurance",
				"buildInfo",
				"issuedAt",
			]) ||
			!isSafeCommandId(value.receiptId) ||
			value.projectId !== headerCache.projectId ||
			value.controlDomainId !== headerCache.controlDomainId ||
			!isSafeCommandId(value.runId) ||
			!isNonEmptyString(value.boundPlanHash) ||
			(value.boundFragmentHash !== undefined && !isNonEmptyString(value.boundFragmentHash)) ||
			!Array.isArray(value.eventManifest) ||
			value.eventManifest.length === 0 ||
			!value.eventManifest.every((eventId) => isSafeCommandId(eventId)) ||
			new Set(value.eventManifest).size !== value.eventManifest.length ||
			!isPositiveSafeInteger(value.startCommitSeq) ||
			!isPositiveSafeInteger(value.endCommitSeq) ||
			value.endCommitSeq < value.startCommitSeq ||
			!Array.isArray(value.artifactRefs) ||
			!value.artifactRefs.every((ref) => isNonEmptyString(ref)) ||
			!isRecord(value.assurance) ||
			!hasOnlyKeys(value.assurance, ["journalContinuity", "providerOutcome", "artifactIntegrity", "provenance"]) ||
			(value.assurance.journalContinuity !== "ok" && value.assurance.journalContinuity !== "unknown") ||
			(value.assurance.providerOutcome !== "ok" &&
				value.assurance.providerOutcome !== "failed" &&
				value.assurance.providerOutcome !== "cancelled" &&
				value.assurance.providerOutcome !== "unknown") ||
			(value.assurance.artifactIntegrity !== "ok" && value.assurance.artifactIntegrity !== "unknown") ||
			(value.assurance.provenance !== "ok" && value.assurance.provenance !== "unknown") ||
			!isRecord(value.buildInfo) ||
			!hasOnlyKeys(value.buildInfo, ["packageVersion", "controlSchemaVersion"]) ||
			!isNonEmptyString(value.buildInfo.packageVersion) ||
			value.buildInfo.controlSchemaVersion !== CONTROL_STORE_SCHEMA_VERSION ||
			!isNonNegativeSafeInteger(value.issuedAt)
		) {
			failDurability("receipt has an invalid or cross-domain durable shape", filePath);
		}
		return value as unknown as Receipt;
	}

	function readRunFromDisk(runId: string): RunProjection | null {
		assertControlLayoutHasNoSymlinks();
		if (!isSafeCommandId(runId)) return null;
		const filePath = path.join(projectProjectionsDir(root), `run-${runId}.json`);
		const raw = readJsonFileStrict<unknown>(filePath);
		return raw === null ? null : validateRunProjection(raw, filePath);
	}

	function readContinuationFromJournal(runId: string): RunContinuation | null {
		let found: RunContinuation | null = null;
		for (const { entry } of readJournalIntegrity().segments) {
			for (const event of entry.events) {
				if (
					event.payload.type === "ContinuationStored" &&
					event.payload.continuation.runId === runId
				) {
					found = event.payload.continuation;
				}
			}
		}
		return found;
	}

	function readCommandFromDisk(commandId: string): CommandRecord | null {
		assertControlLayoutHasNoSymlinks();
		if (!isSafeCommandId(commandId)) return null;
		const filePath = path.join(projectCommandsDir(root), `${commandId}.json`);
		const raw = readJsonFileStrict<unknown>(filePath);
		return raw === null ? null : validateCommandRecord(raw, filePath);
	}

	function makeStoreEvent(
		streamId: string,
		payload: ControlEvent["payload"],
		commandId?: string,
	): ControlEvent {
		return {
			eventId: newId("ev"),
			schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
			controlDomainId: headerCache.controlDomainId,
			streamId,
			streamSeq: 0,
			commitSeq: 0,
			projectId: headerCache.projectId,
			recordedAt: Date.now(),
			payload,
			...(commandId === undefined ? {} : { commandId }),
		};
	}

	function findRunAdmittedEvidence(
		runId: string,
		reservationId: string,
	): number | null {
		for (const { entry } of readJournalIntegrity().segments) {
			for (const event of entry.events) {
				if (
					event.payload.type === "RunAdmitted" &&
					event.payload.runId === runId &&
					event.payload.reservationId === reservationId
				) {
					return event.commitSeq;
				}
			}
		}
		return null;
	}

	/**
	 * A replacement reservation is safe only before the project journal has
	 * authorized any provider-facing attempt. Even an unacknowledged dispatch
	 * intent is enough to make retry ambiguous, so recovery stops fail-closed.
	 */
	function hasProviderDispatchEvidence(runId: string): boolean {
		for (const { entry } of readJournalIntegrity().segments) {
			for (const event of entry.events) {
				if (
					eventPayloadRunId(event.payload) === runId &&
					(event.payload.type === "AttemptPrepared" ||
						event.payload.type === "DispatchIntentRecorded" ||
						event.payload.type === "DispatchAcknowledged")
				) {
					return true;
				}
			}
		}
		return false;
	}

	interface JournalEntryBase {
		commitSeqStart: number;
		commitSeqEnd: number;
		command?: CommandRecord;
		events: ControlEvent[];
		run?: RunProjection;
		receipt?: Receipt;
		recordedAt: number;
		/** Digest of the immediately preceding segment, or null for genesis. */
		previousSegmentHash: string | null;
	}

	interface JournalEntry extends JournalEntryBase {
		/** SHA-256 of the canonical on-disk JournalEntryBase payload. */
		segmentHash: string;
	}

	interface JournalAnchor {
		schemaVersion: 1;
		projectId: string;
		controlDomainId: string;
		firstCommitSeq: number;
		lastCommitSeq: number;
		tailSegmentHash: string;
		createdAt: number;
		updatedAt: number;
	}

	interface JournalSegment {
		entry: JournalEntry;
	}

	function isSha256(value: unknown): value is string {
		return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
	}

	/**
	 * Keep a deterministic wire shape for the segment hash. We deliberately hash
	 * the exact JSON serialization we write, including the previous-link value;
	 * reformatting or reordering an on-disk segment is therefore an integrity
	 * failure rather than a silent semantic change.
	 */
	function serializeJournalEntryBase(entry: JournalEntryBase): string {
		return JSON.stringify(
			{
				commitSeqStart: entry.commitSeqStart,
				commitSeqEnd: entry.commitSeqEnd,
				...(entry.command === undefined ? {} : { command: entry.command }),
				events: entry.events,
				...(entry.run === undefined ? {} : { run: entry.run }),
				...(entry.receipt === undefined ? {} : { receipt: entry.receipt }),
				recordedAt: entry.recordedAt,
				previousSegmentHash: entry.previousSegmentHash,
			},
			null,
			2,
		);
	}

	function hashJournalEntryBase(entry: JournalEntryBase): string {
		return createHash("sha256").update(serializeJournalEntryBase(entry), "utf-8").digest("hex");
	}

	function validateJournalAnchor(value: unknown, filePath: string): JournalAnchor {
		if (
			!isRecord(value) ||
			value.schemaVersion !== 1 ||
			value.projectId !== headerCache.projectId ||
			value.controlDomainId !== headerCache.controlDomainId ||
			!isPositiveSafeInteger(value.firstCommitSeq) ||
			!isPositiveSafeInteger(value.lastCommitSeq) ||
			value.lastCommitSeq < value.firstCommitSeq ||
			!isSha256(value.tailSegmentHash) ||
			!isNonNegativeSafeInteger(value.createdAt) ||
			!isNonNegativeSafeInteger(value.updatedAt)
		) {
			failDurability("journal.anchor.json has an invalid or cross-domain shape", filePath);
		}
		return value as unknown as JournalAnchor;
	}

	function readJournalAnchor(): JournalAnchor | null {
		const raw = readJsonFileStrict<unknown>(journalAnchorPath);
		return raw === null ? null : validateJournalAnchor(raw, journalAnchorPath);
	}

	function parseJournalFileName(fileName: string, dir: string): { start: number; end: number } {
		const match = /^(\d{12})-(\d{12})\.json$/.exec(fileName);
		if (!match) {
			failDurability(`unexpected journal file name ${JSON.stringify(fileName)}`, path.join(dir, fileName));
		}
		const start = Number(match[1]);
		const end = Number(match[2]);
		if (!isPositiveSafeInteger(start) || !isPositiveSafeInteger(end) || end < start) {
			failDurability(`invalid journal range in ${JSON.stringify(fileName)}`, path.join(dir, fileName));
		}
		return { start, end };
	}

	function validateJournalEntry(
		value: unknown,
		filePath: string,
		fileRange: { start: number; end: number },
	): JournalEntry {
		if (!isRecord(value)) failDurability("journal segment must be a JSON object", filePath);
		if (
			!hasOnlyKeys(value, [
				"commitSeqStart",
				"commitSeqEnd",
				"command",
				"events",
				"run",
				"receipt",
				"recordedAt",
				"previousSegmentHash",
				"segmentHash",
			]) ||
			!isPositiveSafeInteger(value.commitSeqStart) ||
			!isPositiveSafeInteger(value.commitSeqEnd) ||
			value.commitSeqStart !== fileRange.start ||
			value.commitSeqEnd !== fileRange.end ||
			!Array.isArray(value.events) ||
			!isNonNegativeSafeInteger(value.recordedAt) ||
			(value.previousSegmentHash !== null && !isSha256(value.previousSegmentHash)) ||
			!isSha256(value.segmentHash)
		) {
			failDurability("journal segment range, chain link, or events do not match its file name", filePath);
		}
		const commitSeqStart = value.commitSeqStart as number;
		const commitSeqEnd = value.commitSeqEnd as number;
		const span = commitSeqEnd - commitSeqStart + 1;
		if ((value.events.length === 0 && span !== 1) || (value.events.length > 0 && span !== value.events.length)) {
			failDurability("journal segment has a non-contiguous commit range", filePath);
		}
		const events = value.events.map((rawEvent, index) => {
			const event = validateControlEvent(rawEvent, filePath);
			if (event.commitSeq !== commitSeqStart + index) {
				failDurability(`invalid or cross-domain event at index ${index}`, filePath);
			}
			return event;
		});
		const command = value.command === undefined ? undefined : validateCommandRecord(value.command, filePath);
		const run = value.run === undefined ? undefined : validateRunProjection(value.run, filePath);
		const receipt = value.receipt === undefined ? undefined : validateReceipt(value.receipt, filePath);
		const base: JournalEntryBase = {
			commitSeqStart,
			commitSeqEnd,
			...(command === undefined ? {} : { command }),
			events,
			...(run === undefined ? {} : { run }),
			...(receipt === undefined ? {} : { receipt }),
			recordedAt: value.recordedAt,
			previousSegmentHash: value.previousSegmentHash as string | null,
		};
		const expectedHash = hashJournalEntryBase(base);
		if (expectedHash !== value.segmentHash) {
			failDurability("journal segment hash does not match its contents", filePath);
		}
		return { ...base, segmentHash: value.segmentHash };
	}

	function readJournalSegments(): JournalSegment[] {
		const dir = journalDir;
		if (!fs.existsSync(dir)) return [];
		const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
		const segments: JournalSegment[] = [];
		let priorEnd: number | undefined;
		for (const fileName of files) {
			const filePath = path.join(dir, fileName);
			const fileRange = parseJournalFileName(fileName, dir);
			const raw = readJsonFileStrict<unknown>(filePath);
			if (raw === null) failDurability("journal segment disappeared while recovery held commit lock", filePath);
			const entry = validateJournalEntry(raw, filePath, fileRange);
			if (priorEnd !== undefined && entry.commitSeqStart !== priorEnd + 1) {
				failDurability(
					`journal discontinuity: expected ${priorEnd + 1}, found ${entry.commitSeqStart}`,
					filePath,
				);
			}
			priorEnd = entry.commitSeqEnd;
			segments.push({ entry });
		}
		return segments;
	}

	function eventPayloadRunId(payload: ControlEvent["payload"]): string | undefined {
		if ("runId" in payload) return payload.runId;
		if (payload.type === "AdmissionIntentRecorded") return payload.admission.runId;
		if (payload.type === "ContinuationStored") return payload.continuation.runId;
		if (payload.type === "ApprovalRequestStored") return payload.approval.runId;
		return undefined;
	}

	/**
	 * Hash continuity alone proves that bytes form a chain, not that they form a
	 * coherent control history. Derive the authoritative stream watermark while
	 * checking entity identity, event uniqueness, and receipt/run relationships.
	 */
	function validateJournalHistory(segments: readonly JournalSegment[]): Record<string, number> {
		const streamSeq: Record<string, number> = {};
		const eventsById = new Map<string, ControlEvent>();
		const latestRuns = new Map<string, RunProjection>();
		const commandsById = new Map<string, CommandRecord>();
		const receiptsById = new Map<string, Receipt>();
		const plansByHash = new Map<string, BoundPlan>();
			const continuationsByRun = new Map<string, RunContinuation>();
			const approvalsByRun = new Map<string, ApprovalRequest>();
			const admissionIntentsById = new Map<
				string,
				{ commandId: string; admission: AdmissionIntent; event: ControlEvent }
			>();
			const slotReservationsByAdmissionId = new Map<string, ControlEvent>();
			const preparedRunsByAdmissionId = new Map<string, ControlEvent>();
			const reservationReboundsByAdmissionId = new Map<string, ControlEvent[]>();
			const runAdmittedEvidenceByReservation = new Map<string, ControlEvent>();
			const slotCommitsByAdmissionId = new Map<string, ControlEvent>();
			const admissionStateOrder: Record<AdmissionIntent["state"], number> = {
				queued: 0,
				"project-prepared": 1,
				"slot-committed": 2,
			};
			const admissionReservationGeneration = (admission: AdmissionIntent): number =>
				admission.reservationGeneration ?? 0;
			const hasExactRebound = (
				events: readonly ControlEvent[],
				prior: AdmissionIntent,
				next: AdmissionIntent,
			): boolean => {
				const matches = events.filter(
					(event) =>
						event.payload.type === "AdmissionReservationRebound" &&
						event.payload.runId === next.runId &&
						event.payload.admissionId === next.admissionId &&
						event.payload.fromReservationId === prior.reservationId &&
						event.payload.reservationId === next.reservationId &&
						event.payload.reservationGeneration === admissionReservationGeneration(next),
				);
				return matches.length === 1;
			};
			const hasValidReservationTransition = (
				prior: AdmissionIntent,
				next: AdmissionIntent,
				events: readonly ControlEvent[],
			): boolean => {
				const priorGeneration = admissionReservationGeneration(prior);
				const nextGeneration = admissionReservationGeneration(next);
				if (prior.reservationId === next.reservationId) return priorGeneration === nextGeneration;
				if (
					prior.state === "queued" &&
					next.state === "project-prepared" &&
					prior.reservationId === undefined &&
					next.reservationId !== undefined
				) {
					return priorGeneration === 0 && nextGeneration === 0;
				}
				return (
					prior.state === "project-prepared" &&
					next.state === "project-prepared" &&
					prior.reservationId !== undefined &&
					next.reservationId !== undefined &&
					nextGeneration === priorGeneration + 1 &&
					hasExactRebound(events, prior, next)
				);
			};
			let compactedThroughCommitSeq = 0;

		for (const { entry } of segments) {
			if (entry.command) {
				if (
					entry.command.firstCommitSeq > entry.commitSeqStart ||
					entry.command.lastCommitSeq !== entry.commitSeqEnd
				) {
					failDurability(
						`command ${entry.command.commandId} does not describe its journal range`,
						journalDir,
					);
				}
				if (entry.command.runId && entry.run && entry.command.runId !== entry.run.runId) {
					failDurability(
						`command ${entry.command.commandId} and run projection disagree`,
						journalDir,
					);
				}
				const priorCommand = commandsById.get(entry.command.commandId);
				if (
					priorCommand &&
					(priorCommand.requestHash !== entry.command.requestHash ||
						priorCommand.callerPrincipal !== entry.command.callerPrincipal ||
						priorCommand.kind !== entry.command.kind ||
						priorCommand.runId !== entry.command.runId)
				) {
					failDurability(
						`command ${entry.command.commandId} changed immutable idempotency identity`,
						journalDir,
					);
				}
				if (priorCommand && (priorCommand.admission || entry.command.admission)) {
					const priorAdmission = priorCommand?.admission;
					const nextAdmission = entry.command.admission;
					if (
						!priorAdmission ||
						!nextAdmission ||
						priorAdmission.admissionId !== nextAdmission.admissionId ||
						priorAdmission.runId !== nextAdmission.runId ||
						priorAdmission.continuationId !== nextAdmission.continuationId ||
						priorAdmission.boundPlanHash !== nextAdmission.boundPlanHash ||
						admissionStateOrder[nextAdmission.state] < admissionStateOrder[priorAdmission.state] ||
						!hasValidReservationTransition(priorAdmission, nextAdmission, entry.events)
					) {
						failDurability(
							`command ${entry.command.commandId} regressed or changed its immutable admission identity`,
							journalDir,
						);
					}
				}
				commandsById.set(entry.command.commandId, entry.command);
			}
			if (entry.run) latestRuns.set(entry.run.runId, entry.run);
			if (entry.receipt) {
				if (receiptsById.has(entry.receipt.receiptId)) {
					failDurability(`duplicate receipt ${entry.receipt.receiptId} in journal`, journalDir);
				}
				if (
					entry.run &&
					(entry.run.runId !== entry.receipt.runId || entry.run.receiptId !== entry.receipt.receiptId)
				) {
					failDurability(
						`receipt ${entry.receipt.receiptId} and same-batch run projection disagree`,
						journalDir,
					);
				}
				receiptsById.set(entry.receipt.receiptId, entry.receipt);
			}
			for (const event of entry.events) {
				if (eventsById.has(event.eventId)) {
					failDurability(`duplicate eventId ${event.eventId} in journal`, journalDir);
				}
				const expectedStreamSeq = (streamSeq[event.streamId] ?? 0) + 1;
				if (event.streamSeq !== expectedStreamSeq) {
					failDurability(
						`stream ${event.streamId} expected sequence ${expectedStreamSeq}, found ${event.streamSeq}`,
						journalDir,
					);
				}
				streamSeq[event.streamId] = event.streamSeq;
				eventsById.set(event.eventId, event);

					switch (event.payload.type) {
						case "AdmissionIntentRecorded": {
							const payload = event.payload;
							if (
								event.streamId !== payload.admission.runId ||
								event.commandId !== payload.commandId ||
								admissionIntentsById.has(payload.admission.admissionId)
							) {
								failDurability("AdmissionIntentRecorded event has an invalid stream, command, or duplicate identity", journalDir);
							}
							admissionIntentsById.set(payload.admission.admissionId, {
								commandId: payload.commandId,
								admission: payload.admission,
								event,
							});
							break;
						}
						case "SlotReserved": {
							const payload = event.payload;
							if (
								event.streamId !== payload.runId ||
								slotReservationsByAdmissionId.has(payload.admissionId)
							) {
								failDurability("SlotReserved event has an invalid stream or duplicate admission identity", journalDir);
							}
							slotReservationsByAdmissionId.set(payload.admissionId, event);
							break;
						}
						case "AdmissionReservationRebound": {
							const payload = event.payload;
							if (event.streamId !== payload.runId) {
								failDurability("AdmissionReservationRebound event has an invalid stream", journalDir);
							}
							const rebounds = reservationReboundsByAdmissionId.get(payload.admissionId) ?? [];
							rebounds.push(event);
							reservationReboundsByAdmissionId.set(payload.admissionId, rebounds);
							break;
						}
						case "ProjectRunPrepared": {
							const payload = event.payload;
							if (
								event.streamId !== payload.runId ||
								preparedRunsByAdmissionId.has(payload.admissionId)
							) {
								failDurability("ProjectRunPrepared event has an invalid stream or duplicate admission identity", journalDir);
							}
							preparedRunsByAdmissionId.set(payload.admissionId, event);
							break;
						}
						case "RunAdmitted": {
							const payload = event.payload;
							const key = `${payload.runId}\u0000${payload.reservationId}`;
							if (runAdmittedEvidenceByReservation.has(key)) {
								failDurability("RunAdmitted evidence is duplicated for a reservation", journalDir);
							}
							runAdmittedEvidenceByReservation.set(key, event);
							break;
						}
						case "SlotCommitted": {
							const payload = event.payload;
							if (
								event.streamId !== payload.runId ||
								slotCommitsByAdmissionId.has(payload.admissionId)
							) {
								failDurability("SlotCommitted event has an invalid stream or duplicate admission identity", journalDir);
							}
							slotCommitsByAdmissionId.set(payload.admissionId, event);
							break;
						}
						case "CompactionCheckpoint": {
							if (event.streamId !== COMPACTION_STREAM_ID) {
								failDurability("CompactionCheckpoint event uses an unexpected stream", journalDir);
							}
							if (event.payload.throughCommitSeq <= compactedThroughCommitSeq) {
								failDurability("CompactionCheckpoint did not advance the cursor floor", journalDir);
							}
							if (event.payload.throughCommitSeq >= event.commitSeq) {
								failDurability("CompactionCheckpoint cannot compact itself or a future commit", journalDir);
							}
							compactedThroughCommitSeq = event.payload.throughCommitSeq;
							break;
						}
						case "BoundPlanStored": {
						if (event.payload.runId !== event.streamId) {
							failDurability("BoundPlanStored event stream does not match its run", journalDir);
						}
						const prior = plansByHash.get(event.payload.boundPlan.boundPlanHash);
						if (prior && !sameBoundPlan(prior, event.payload.boundPlan)) {
							failDurability(
								`bound plan ${event.payload.boundPlan.boundPlanHash} has divergent snapshots`,
								journalDir,
							);
						}
						plansByHash.set(event.payload.boundPlan.boundPlanHash, event.payload.boundPlan);
						break;
					}
					case "ContinuationStored": {
						const continuation = event.payload.continuation;
						if (continuation.runId !== event.streamId) {
							failDurability("ContinuationStored event stream does not match its run", journalDir);
						}
						const prior = continuationsByRun.get(continuation.runId);
						if (prior) {
							if (
								prior.continuationId !== continuation.continuationId ||
								prior.boundPlanHash !== continuation.boundPlanHash ||
								continuation.version !== prior.version + 1
							) {
								failDurability("RunContinuation identity or version regressed", journalDir);
							}
						} else if (continuation.version !== 1) {
							failDurability("first RunContinuation snapshot must have version 1", journalDir);
						}
						continuationsByRun.set(continuation.runId, continuation);
						break;
					}
					case "ApprovalRequestStored": {
						const approval = event.payload.approval;
						if (approval.runId !== event.streamId) {
							failDurability("ApprovalRequestStored event stream does not match its run", journalDir);
						}
						const prior = approvalsByRun.get(approval.runId);
						if (prior) {
							if (
								prior.approvalRequestId !== approval.approvalRequestId ||
								prior.continuationId !== approval.continuationId ||
								prior.phaseId !== approval.phaseId ||
								prior.status !== "pending"
							) {
								failDurability("ApprovalRequest identity or transition is invalid", journalDir);
							}
						}
						approvalsByRun.set(approval.runId, approval);
						break;
					}
					case "AttemptPrepared":
					case "DispatchIntentRecorded":
					case "DispatchAcknowledged":
						if (event.payload.runId !== event.streamId) {
							failDurability(`${event.payload.type} event stream does not match its run`, journalDir);
						}
						break;
					default:
						break;
				}
			}
		}

		for (const run of latestRuns.values()) {
				if (run.cancelRequest) {
					const command = commandsById.get(run.cancelRequest.commandId);
					if (
						!command ||
						command.kind !== "cancel" ||
						command.runId !== run.runId ||
						command.requestHash !== run.cancelRequest.requestHash ||
						command.callerPrincipal !== run.cancelRequest.principal
					) {
						failDurability(
							`run ${run.runId} has no matching durable cancel command`,
							journalDir,
						);
					}
				}
				if (run.receiptId && !receiptsById.has(run.receiptId)) {
				failDurability(`run ${run.runId} references missing Receipt ${run.receiptId}`, journalDir);
			}
			if (run.continuationId) {
				const continuation = continuationsByRun.get(run.runId);
				if (
					!continuation ||
					continuation.continuationId !== run.continuationId ||
					continuation.boundPlanHash !== run.boundPlanHash ||
					!plansByHash.has(run.boundPlanHash)
				) {
					failDurability(`run ${run.runId} has no matching plan/continuation checkpoint`, journalDir);
				}
			}
			const continuation = continuationsByRun.get(run.runId);
			if (run.approvalRequestId && (continuation?.approvalRequestId || continuation?.status === "parked")) {
				const approval = approvalsByRun.get(run.runId);
				if (!approval || approval.approvalRequestId !== run.approvalRequestId) {
					failDurability(`run ${run.runId} has no matching ApprovalRequest`, journalDir);
				}
			}
			}
			for (const command of commandsById.values()) {
				const admission = command.admission;
				if (!admission) continue;
				const intent = admissionIntentsById.get(admission.admissionId);
				if (
					!intent ||
					intent.commandId !== command.commandId ||
					intent.admission.admissionId !== admission.admissionId ||
					intent.admission.runId !== admission.runId ||
					intent.admission.continuationId !== admission.continuationId ||
					intent.admission.boundPlanHash !== admission.boundPlanHash ||
					intent.event.commitSeq > command.firstCommitSeq
				) {
					failDurability(`admission command ${command.commandId} lacks its immutable intent event`, journalDir);
				}
				const rebounds = reservationReboundsByAdmissionId.get(admission.admissionId) ?? [];
				if (admission.state === "queued") {
					if (
						rebounds.length > 0 ||
						slotReservationsByAdmissionId.has(admission.admissionId) ||
						preparedRunsByAdmissionId.has(admission.admissionId) ||
						slotCommitsByAdmissionId.has(admission.admissionId)
					) {
						failDurability(`queued admission ${admission.admissionId} has project reservation evidence`, journalDir);
					}
					continue;
				}
				const slotReserved = slotReservationsByAdmissionId.get(admission.admissionId);
				const prepared = preparedRunsByAdmissionId.get(admission.admissionId);
				const run = latestRuns.get(admission.runId);
				if (
					!slotReserved ||
					!prepared ||
					!run ||
					run.admissionId !== admission.admissionId ||
					slotReserved.payload.type !== "SlotReserved" ||
					prepared.payload.type !== "ProjectRunPrepared" ||
					slotReserved.payload.reservationId !== prepared.payload.reservationId ||
					slotReserved.commitSeq > prepared.commitSeq
				) {
					failDurability(`admission ${admission.admissionId} has incomplete or reordered project evidence`, journalDir);
				}
				let reservationId = slotReserved.payload.reservationId;
				let reservationGeneration = 0;
				let admitted = runAdmittedEvidenceByReservation.get(
					`${admission.runId}\u0000${reservationId}`,
				);
				if (!admitted || prepared.commitSeq > admitted.commitSeq) {
					failDurability(`admission ${admission.admissionId} lacks ordered initial RunAdmitted evidence`, journalDir);
				}
				for (const rebound of rebounds) {
					if (rebound.payload.type !== "AdmissionReservationRebound") {
						failDurability(`admission ${admission.admissionId} has an invalid rebound record`, journalDir);
					}
					const reboundPayload = rebound.payload;
					if (
						reboundPayload.runId !== admission.runId ||
						reboundPayload.fromReservationId !== reservationId ||
						reboundPayload.reservationGeneration !== reservationGeneration + 1 ||
						rebound.commitSeq <= admitted.commitSeq
					) {
						failDurability(`admission ${admission.admissionId} has a non-monotonic reservation rebound`, journalDir);
					}
					const reboundAdmitted = runAdmittedEvidenceByReservation.get(
						`${admission.runId}\u0000${reboundPayload.reservationId}`,
					);
					if (!reboundAdmitted || reboundAdmitted.commitSeq <= rebound.commitSeq) {
						failDurability(`admission ${admission.admissionId} rebound lacks subsequent RunAdmitted evidence`, journalDir);
					}
					reservationId = reboundPayload.reservationId;
					reservationGeneration = reboundPayload.reservationGeneration;
					admitted = reboundAdmitted;
				}
				if (
					admission.reservationId !== reservationId ||
					admissionReservationGeneration(admission) !== reservationGeneration ||
					(admission.state === "project-prepared" && run.reservationId !== reservationId)
				) {
					failDurability(`admission ${admission.admissionId} final reservation binding disagrees with journal evidence`, journalDir);
				}
				if (admission.state === "slot-committed") {
					const slotCommitted = slotCommitsByAdmissionId.get(admission.admissionId);
					if (
						!slotCommitted ||
						slotCommitted.payload.type !== "SlotCommitted" ||
						slotCommitted.payload.reservationId !== reservationId ||
						slotCommitted.payload.projectAdmitCommitSeq !== admitted.commitSeq ||
						slotCommitted.commitSeq <= admitted.commitSeq
					) {
						failDurability(`admission ${admission.admissionId} lacks an ordered SlotCommitted record`, journalDir);
					}
				}
			}
			for (const admissionId of reservationReboundsByAdmissionId.keys()) {
				if (!admissionIntentsById.has(admissionId)) {
					failDurability(`reservation rebound references an unknown admission ${admissionId}`, journalDir);
				}
			}
			for (const continuation of continuationsByRun.values()) {
			if (!plansByHash.has(continuation.boundPlanHash)) {
				failDurability(
					`continuation ${continuation.continuationId} references unknown BoundPlan`,
					journalDir,
				);
			}
			if (continuation.approvalRequestId) {
				const approval = approvalsByRun.get(continuation.runId);
				if (
					!approval ||
					approval.approvalRequestId !== continuation.approvalRequestId ||
					approval.continuationId !== continuation.continuationId
				) {
					failDurability(`continuation ${continuation.continuationId} approval link is invalid`, journalDir);
				}
			}
			}
			for (const command of commandsById.values()) {
				if (command.kind !== "cancel" || command.status !== "accepted") continue;
				const run = command.runId ? latestRuns.get(command.runId) : undefined;
				if (
					!run ||
					!run.cancelRequest ||
					run.cancelRequest.commandId !== command.commandId ||
					run.cancelRequest.requestHash !== command.requestHash ||
					run.cancelRequest.principal !== command.callerPrincipal
				) {
					failDurability(
						`accepted cancel command ${command.commandId} has no matching durable cancel lifecycle`,
						journalDir,
					);
				}
			}
			for (const receipt of receiptsById.values()) {
			const run = latestRuns.get(receipt.runId);
			if (!run || run.receiptId !== receipt.receiptId || run.boundPlanHash !== receipt.boundPlanHash) {
				failDurability(`Receipt ${receipt.receiptId} has no matching completed run projection`, journalDir);
			}
			const manifestEvents = receipt.eventManifest.map((eventId) => {
				const event = eventsById.get(eventId);
				if (!event) {
					failDurability(`Receipt ${receipt.receiptId} references unknown event ${eventId}`, journalDir);
				}
				const payloadRunId = eventPayloadRunId(event.payload);
				if (event.streamId !== receipt.runId && payloadRunId !== receipt.runId) {
					failDurability(`Receipt ${receipt.receiptId} references another run's event`, journalDir);
				}
				return event;
			});
			const manifestStart = Math.min(...manifestEvents.map((event) => event.commitSeq));
			const manifestEnd = Math.max(...manifestEvents.map((event) => event.commitSeq));
			if (receipt.startCommitSeq !== manifestStart || receipt.endCommitSeq !== manifestEnd) {
				failDurability(`Receipt ${receipt.receiptId} event range does not match its manifest`, journalDir);
			}
			const hasReceiptIssuedEvent = manifestEvents.some(
				(event) =>
					event.payload.type === "ReceiptIssued" &&
					event.payload.runId === receipt.runId &&
					event.payload.receiptId === receipt.receiptId,
			);
			if (!hasReceiptIssuedEvent) {
				failDurability(`Receipt ${receipt.receiptId} has no matching ReceiptIssued event`, journalDir);
			}
		}
		return streamSeq;
	}

	/**
	 * Verify that the durable anchor, filename ranges, and hash chain describe
	 * exactly the same history. An anchor is written before its corresponding
	 * segment, so an interrupted write becomes a fail-closed repair case rather
	 * than a reason to accept truncated or substituted history.
	 */
	function readJournalIntegrity(): {
		anchor: JournalAnchor | null;
		segments: JournalSegment[];
		persistedNext: number | null;
		streamSeq: Record<string, number>;
	} {
		const anchor = readJournalAnchor();
		const segments = readJournalSegments();
		const persistedNext = readPersistedCommitSeq();
		if (anchor === null) {
			if (segments.length > 0 || persistedNext !== null || fs.existsSync(streamSeqPath)) {
				failDurability(
					"populated journal/sequence state has no durable journal.anchor.json; explicit migration is required",
					journalAnchorPath,
				);
			}
			return { anchor: null, segments, persistedNext, streamSeq: {} };
		}
		if (segments.length === 0) {
			failDurability("anchored journal has no retained segments", journalDir);
		}
		const first = segments[0]!.entry;
		const last = segments[segments.length - 1]!.entry;
		if (
			first.commitSeqStart !== anchor.firstCommitSeq ||
			last.commitSeqEnd !== anchor.lastCommitSeq ||
			last.segmentHash !== anchor.tailSegmentHash
		) {
			failDurability("journal.anchor.json does not match retained journal boundaries", journalAnchorPath);
		}
		let previousHash: string | null = null;
		for (const { entry } of segments) {
			if (entry.previousSegmentHash !== previousHash) {
				failDurability(
					`journal hash chain discontinuity at commitSeq ${entry.commitSeqStart}`,
					journalDir,
				);
			}
			previousHash = entry.segmentHash;
		}
			return { anchor, segments, persistedNext, streamSeq: validateJournalHistory(segments) };
		}

	function sameJournalAnchor(left: JournalAnchor | null, right: JournalAnchor | null): boolean {
		if (left === null || right === null) return left === right;
		return (
			left.schemaVersion === right.schemaVersion &&
			left.projectId === right.projectId &&
			left.controlDomainId === right.controlDomainId &&
			left.firstCommitSeq === right.firstCommitSeq &&
			left.lastCommitSeq === right.lastCommitSeq &&
			left.tailSegmentHash === right.tailSegmentHash &&
			left.createdAt === right.createdAt &&
			left.updatedAt === right.updatedAt
		);
	}

	/**
	 * Mutable hosts serialize a complete journal observation with commit.lock.
	 * Attach hosts deliberately do not acquire that writer lock, so they must
	 * reject an observation whose anchor advanced before it was complete. This
	 * keeps a normal concurrent publication from being silently composed with a
	 * stale derived index.
	 */
	function readStableJournal<T>(derive: (journal: ReturnType<typeof readJournalIntegrity>) => T): T {
		assertControlLayoutHasNoSymlinks();
		if (!readOnly) return withCommitLock(() => derive(readJournalIntegrity()));
		const before = readJournalAnchor();
		const journal = readJournalIntegrity();
		const after = readJournalAnchor();
		if (!sameJournalAnchor(before, journal.anchor) || !sameJournalAnchor(journal.anchor, after)) {
			failDurability(
				"read-only observer saw the journal anchor advance during one snapshot; retry after the writer commit settles",
				journalAnchorPath,
			);
		}
		return derive(journal);
	}

	function journalRunSnapshot(
		journal: ReturnType<typeof readJournalIntegrity>,
		runId: string,
	): JournalRunSnapshot {
		let run: RunProjection | null = null;
		let continuation: RunContinuation | null = null;
		let approval: ApprovalRequest | null = null;
		let receipt: Receipt | null = null;
		for (const { entry } of journal.segments) {
			if (entry.run?.runId === runId) run = entry.run;
			if (entry.receipt?.runId === runId) receipt = entry.receipt;
			for (const event of entry.events) {
				if (event.payload.type === "ContinuationStored" && event.payload.continuation.runId === runId) {
					continuation = event.payload.continuation;
				}
				if (event.payload.type === "ApprovalRequestStored" && event.payload.approval.runId === runId) {
					approval = event.payload.approval;
				}
			}
		}
		return { run, continuation, approval, receipt };
	}

		/**
		 * Cursor retention is derived only from validated, hash-linked journal
		 * events. A loose file could be deleted, rolled back, or forged without
		 * changing this result, so no such file participates in the decision.
		 */
		function deriveCompactionState(segments: readonly JournalSegment[]): ControlCompactionState {
			let throughCommitSeq = 0;
			let lastCheckpointCommitSeq: number | undefined;
			let updatedAt = 0;
			for (const { entry } of segments) {
				for (const event of entry.events) {
					if (event.payload.type !== "CompactionCheckpoint") continue;
					throughCommitSeq = event.payload.throughCommitSeq;
					lastCheckpointCommitSeq = event.commitSeq;
					updatedAt = event.recordedAt;
				}
			}
			const maxCommitSeq = segments.length === 0 ? 0 : segments[segments.length - 1]!.entry.commitSeqEnd;
			return {
				minAvailableCommitSeq: throughCommitSeq + 1,
				maxCommitSeq,
				...(lastCheckpointCommitSeq === undefined ? {} : { lastCheckpointCommitSeq }),
				updatedAt,
			};
		}

		function readStreamSeqMap(): Record<string, number> {
		const raw = readJsonFileStrict<unknown>(streamSeqPath);
		if (raw === null) return {};
		if (!isRecord(raw)) failDurability("stream-seq.json must be a JSON object", streamSeqPath);
		const streamMap: Record<string, number> = {};
		for (const [streamId, streamSeq] of Object.entries(raw)) {
			if (!isSafeCommandId(streamId) || !isPositiveSafeInteger(streamSeq)) {
				failDurability("stream-seq.json contains an invalid stream sequence", streamSeqPath);
			}
			streamMap[streamId] = streamSeq;
		}
		return streamMap;
	}

	function sameStreamSeqMap(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
		const leftKeys = Object.keys(left).sort();
		const rightKeys = Object.keys(right).sort();
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
		);
	}

	/**
	 * Attach clients are forbidden to repair the materialized indexes. They must
	 * either observe the exact journal-derived view or stop: otherwise a missing
	 * projection can silently turn an observer into a second recovery writer (or
	 * serve an old state as though it were current).
	 */
	function validateReadOnlyDerivedState(segments: readonly JournalSegment[]): void {
		const expectedRuns = new Map<string, RunProjection>();
		const expectedCommands = new Map<string, CommandRecord>();
		const expectedReceipts = new Map<string, Receipt>();
		for (const { entry } of segments) {
			if (entry.run) expectedRuns.set(entry.run.runId, entry.run);
			if (entry.command) expectedCommands.set(entry.command.commandId, entry.command);
			if (entry.receipt) expectedReceipts.set(entry.receipt.receiptId, entry.receipt);
		}

		function requireEquivalent<T>(
			filePath: string,
			expected: T,
			validate: (value: unknown, filePath: string) => T,
			description: string,
		): void {
			const raw = readJsonFileStrict<unknown>(filePath);
			if (raw === null) failDurability(`read-only open found missing ${description}`, filePath);
			const actual = validate(raw, filePath);
			if (!isDeepStrictEqual(actual, expected)) {
				failDurability(`read-only open found stale ${description}`, filePath);
			}
		}

		const projectionDir = projectProjectionsDir(root);
		const expectedProjectionFiles = new Set<string>();
		for (const [runId, run] of expectedRuns) {
			const fileName = `run-${runId}.json`;
			expectedProjectionFiles.add(fileName);
			requireEquivalent(
				path.join(projectionDir, fileName),
				run,
				validateRunProjection,
				`run projection ${runId}`,
			);
		}
		for (const fileName of fs.readdirSync(projectionDir)) {
			if (fileName.startsWith("run-") && fileName.endsWith(".json") && !expectedProjectionFiles.has(fileName)) {
				failDurability("read-only open found an unjournaled run projection", path.join(projectionDir, fileName));
			}
		}

		const commandsDir = projectCommandsDir(root);
		const expectedCommandFiles = new Set<string>();
		for (const [commandId, command] of expectedCommands) {
			const commandFile = `${commandId}.json`;
			expectedCommandFiles.add(commandFile);
			requireEquivalent(
				path.join(commandsDir, commandFile),
				command,
				validateCommandRecord,
				`command record ${commandId}`,
			);
			if (command.runId) {
				const indexFile = `by-cmd-${commandId}.json`;
				expectedCommandFiles.add(indexFile);
				const indexPath = path.join(commandsDir, indexFile);
				const raw = readJsonFileStrict<unknown>(indexPath);
				if (
					raw === null ||
					!isRecord(raw) ||
					!hasOnlyKeys(raw, ["runId"]) ||
					raw.runId !== command.runId
				) {
					failDurability(`read-only open found stale command index ${commandId}`, indexPath);
				}
			}
		}
		for (const fileName of fs.readdirSync(commandsDir)) {
			if (fileName.endsWith(".json") && !expectedCommandFiles.has(fileName)) {
				failDurability("read-only open found an unjournaled command index", path.join(commandsDir, fileName));
			}
		}

		const receiptsDir = projectReceiptsDir(root);
		const expectedReceiptFiles = new Set<string>();
		for (const [receiptId, receipt] of expectedReceipts) {
			const receiptFile = `${receiptId}.json`;
			expectedReceiptFiles.add(receiptFile);
			requireEquivalent(
				path.join(receiptsDir, receiptFile),
				receipt,
				validateReceipt,
				`Receipt ${receiptId}`,
			);
			const indexFile = `by-run-${receipt.runId}.json`;
			expectedReceiptFiles.add(indexFile);
			const indexPath = path.join(receiptsDir, indexFile);
			const raw = readJsonFileStrict<unknown>(indexPath);
			if (
				raw === null ||
				!isRecord(raw) ||
				!hasOnlyKeys(raw, ["receiptId"]) ||
				raw.receiptId !== receipt.receiptId
			) {
				failDurability(`read-only open found stale Receipt index ${receipt.runId}`, indexPath);
			}
		}
		for (const fileName of fs.readdirSync(receiptsDir)) {
			if (fileName.endsWith(".json") && !expectedReceiptFiles.has(fileName)) {
				failDurability("read-only open found an unjournaled Receipt index", path.join(receiptsDir, fileName));
			}
		}
	}

	/** Remove only generated JSON indexes that the authoritative journal did not rebuild. */
	function removeStaleDerivedFiles(
		dir: string,
		expected: ReadonlySet<string>,
		isGeneratedFile: (fileName: string) => boolean,
	): void {
		ensureDir(dir);
		let removed = false;
		for (const fileName of fs.readdirSync(dir)) {
			if (!isGeneratedFile(fileName) || expected.has(fileName)) continue;
			const filePath = path.join(dir, fileName);
			let st: fs.Stats;
			try {
				st = fs.lstatSync(filePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (!st.isFile()) {
				failDurability("derived index path is not a removable file", filePath);
			}
			fs.unlinkSync(filePath);
			removed = true;
		}
		if (removed) fsyncDirectory(dir);
	}

	/**
	 * Journal is authoritative: validate continuity, repair only derived state
	 * (projections / lagging sequence files), then rebuild indexes. This function
	 * is always called under commit.lock, including startup, so recovery cannot
	 * roll a concurrent writer's projections backward.
	 */
	function rebuildFromJournal(): { rebuiltRuns: number; rebuiltCommands: number; rebuiltReceipts: number } {
		let rebuiltRuns = 0;
		let rebuiltCommands = 0;
		let rebuiltReceipts = 0;
		const { segments, persistedNext, streamSeq } = readJournalIntegrity();
		const persistedStreamMap = readStreamSeqMap();

		if (segments.length > 0) {
			const expectedNext = segments[segments.length - 1]!.entry.commitSeqEnd + 1;
			if (persistedNext === null || persistedNext < expectedNext) {
				// Journal fsync happens before commit-seq write; a lower/missing seq is
				// a recoverable half-commit, not permission to reuse a committed range.
				writeFileAtomic(seqPath, JSON.stringify({ next: expectedNext }, null, 2));
			} else if (persistedNext > expectedNext) {
				failDurability(
					`commit-seq next=${persistedNext} is ahead of journal end ${expectedNext - 1}`,
					seqPath,
				);
			}
		}

		if (!sameStreamSeqMap(persistedStreamMap, streamSeq)) {
			writeFileAtomic(streamSeqPath, JSON.stringify(streamSeq, null, 2));
		}

		const expectedRunFiles = new Set<string>();
		const expectedCommandFiles = new Set<string>();
		const expectedReceiptFiles = new Set<string>();
		for (const { entry } of segments) {
			if (entry.command && isSafeCommandId(entry.command.commandId)) {
				expectedCommandFiles.add(`${entry.command.commandId}.json`);
				// Later segments overwrite earlier (journal order = authority)
				writeFileAtomic(
					path.join(projectCommandsDir(root), `${entry.command.commandId}.json`),
					JSON.stringify(entry.command, null, 2),
				);
				if (entry.command.runId && isSafeCommandId(entry.command.runId)) {
					expectedCommandFiles.add(`by-cmd-${entry.command.commandId}.json`);
					writeFileAtomic(
						path.join(projectCommandsDir(root), `by-cmd-${entry.command.commandId}.json`),
						JSON.stringify({ runId: entry.command.runId }, null, 2),
					);
				}
				rebuiltCommands += 1;
			}
			if (entry.run && isSafeCommandId(entry.run.runId)) {
				expectedRunFiles.add(`run-${entry.run.runId}.json`);
				// Always write: later journal segments win (full rebuild to latest)
				writeFileAtomic(
					path.join(projectProjectionsDir(root), `run-${entry.run.runId}.json`),
					JSON.stringify(entry.run, null, 2),
				);
				rebuiltRuns += 1;
			}
			if (entry.receipt && isSafeCommandId(entry.receipt.receiptId)) {
				expectedReceiptFiles.add(`${entry.receipt.receiptId}.json`);
				writeFileAtomic(
					path.join(projectReceiptsDir(root), `${entry.receipt.receiptId}.json`),
					JSON.stringify(entry.receipt, null, 2),
				);
				if (isSafeCommandId(entry.receipt.runId)) {
					expectedReceiptFiles.add(`by-run-${entry.receipt.runId}.json`);
					writeFileAtomic(
						path.join(projectReceiptsDir(root), `by-run-${entry.receipt.runId}.json`),
						JSON.stringify({ receiptId: entry.receipt.receiptId }, null, 2),
					);
				}
				rebuiltReceipts += 1;
			}
		}
		removeStaleDerivedFiles(
			projectProjectionsDir(root),
			expectedRunFiles,
			(fileName) => fileName.startsWith("run-") && fileName.endsWith(".json"),
		);
		removeStaleDerivedFiles(
			projectCommandsDir(root),
			expectedCommandFiles,
			(fileName) => fileName.endsWith(".json"),
		);
		removeStaleDerivedFiles(
			projectReceiptsDir(root),
			expectedReceiptFiles,
			(fileName) => fileName.endsWith(".json"),
		);
		return { rebuiltRuns, rebuiltCommands, rebuiltReceipts };
	}

	// Writer opens repair only derived files under commit.lock. Attach opens are
	// strictly observational: any half-commit or stale derived watermark is a
	// durable failure rather than a reason for the observer to write evidence.
	if (readOnly) {
		const journal = readJournalIntegrity();
		if (journal.segments.length > 0) {
			const expectedNext = journal.segments[journal.segments.length - 1]!.entry.commitSeqEnd + 1;
			if (journal.persistedNext !== expectedNext) {
				failDurability(
					`read-only open found commit-seq next=${journal.persistedNext ?? "missing"}; expected ${expectedNext}`,
					seqPath,
				);
			}
		}
		const persistedStreamMap = readStreamSeqMap();
		if (!sameStreamSeqMap(persistedStreamMap, journal.streamSeq)) {
			failDurability("read-only open found a stale stream-seq index", streamSeqPath);
		}
		validateReadOnlyDerivedState(journal.segments);
	} else {
		withCommitLock(() => rebuildFromJournal());
	}

	/** Caller MUST hold commitLockPath. */
		function commitUnlocked(batch: CommitBatch): { commitSeqStart: number; commitSeqEnd: number } {
			const events = batch.events;
			const journal = readJournalIntegrity();
			const currentCompactionState = deriveCompactionState(journal.segments);
			let next = readSeqNext();
		if (events.length === 0 && !batch.command && !batch.run && !batch.receipt) {
			return { commitSeqStart: next, commitSeqEnd: next - 1 };
		}
		const start = next;
		if (journal.anchor === null) {
			if (start !== 1) {
				failDurability("unanchored first journal commit must start at commitSeq 1", seqPath);
			}
		} else if (start !== journal.anchor.lastCommitSeq + 1) {
			failDurability(
				`commit-seq ${start} does not extend anchored tail ${journal.anchor.lastCommitSeq}`,
				seqPath,
			);
		}
		let seq = start;
		// streamSeq is a derived index. Rebuild its exact journal watermark before
		// using it, so a stale/forged index cannot create a gap in new events.
		const persistedStreamMap = readStreamSeqMap();
		const streamMap = { ...journal.streamSeq };
		if (!sameStreamSeqMap(persistedStreamMap, streamMap)) {
			writeFileAtomic(streamSeqPath, JSON.stringify(streamMap, null, 2));
		}
			const stamped: ControlEvent[] = events.map((ev) => {
			const streamId = ev.streamId || "default";
			const nextStream = (streamMap[streamId] ?? 0) + 1;
			streamMap[streamId] = nextStream;
			const e: ControlEvent = {
				...ev,
				commitSeq: seq,
				streamSeq: nextStream,
				streamId,
				controlDomainId: headerCache.controlDomainId,
				projectId: headerCache.projectId,
			};
			seq += 1;
				return e;
			});
			let compactedThroughCommitSeq = currentCompactionState.minAvailableCommitSeq - 1;
			for (const event of stamped) {
				if (event.payload.type !== "CompactionCheckpoint") continue;
				if (event.streamId !== COMPACTION_STREAM_ID) {
					failDurability("CompactionCheckpoint must use the reserved compaction stream", journalDir);
				}
				if (event.payload.throughCommitSeq <= compactedThroughCommitSeq) {
					failDurability("CompactionCheckpoint must advance the existing cursor floor", journalDir);
				}
				if (event.payload.throughCommitSeq > currentCompactionState.maxCommitSeq) {
					failDurability("CompactionCheckpoint cannot compact beyond the current journal tail", journalDir);
				}
				if (event.payload.throughCommitSeq >= event.commitSeq) {
					failDurability("CompactionCheckpoint cannot compact itself or a future commit", journalDir);
				}
				compactedThroughCommitSeq = event.payload.throughCommitSeq;
			}
			if (stamped.length === 0) {
			seq += 1;
		}
		const end = seq - 1;
		next = seq;

		const command: CommandRecord | undefined = batch.command
			? {
					...batch.command,
					firstCommitSeq: batch.command.firstCommitSeq || start,
					lastCommitSeq: end,
					projectId: headerCache.projectId,
					controlDomainId: headerCache.controlDomainId,
				}
				: undefined;
		const run: RunProjection | undefined = batch.run
			? {
					...batch.run,
					projectId: headerCache.projectId,
					controlDomainId: headerCache.controlDomainId,
				}
			: undefined;
			const receipt: Receipt | undefined = batch.receipt
			? {
					...batch.receipt,
					projectId: headerCache.projectId,
					controlDomainId: headerCache.controlDomainId,
				}
				: undefined;
			const priorRun = run
				? [...journal.segments]
						.reverse()
						.map(({ entry }) => entry.run)
						.find((candidate): candidate is RunProjection => candidate?.runId === run.runId)
				: undefined;
			if (priorRun?.cancelRequest) {
				const priorCancel = priorRun.cancelRequest;
				const nextCancel = run?.cancelRequest;
					if (
						!nextCancel ||
						nextCancel.commandId !== priorCancel.commandId ||
						nextCancel.requestHash !== priorCancel.requestHash ||
						nextCancel.principal !== priorCancel.principal ||
						nextCancel.providerHandle !== priorCancel.providerHandle ||
						nextCancel.providerName !== priorCancel.providerName ||
						nextCancel.continuationId !== priorCancel.continuationId ||
						nextCancel.continuationVersion !== priorCancel.continuationVersion ||
						nextCancel.attemptId !== priorCancel.attemptId ||
						nextCancel.phaseId !== priorCancel.phaseId
					) {
						failDurability(
							`pending cancel command ${priorCancel.commandId} cannot be erased, replaced, or rerouted`,
						journalDir,
					);
				}
				if (
					run.status !== "unknown" ||
					run.stage !== "reconciling" ||
					run.receiptId !== undefined ||
					run.reservationId !== priorRun.reservationId
				) {
					failDurability(
						`pending cancel command ${priorCancel.commandId} must retain unknown/reconciling state and its reservation`,
						journalDir,
					);
				}
				const cancelOrder = { requested: 0, signalling: 1, ambiguous: 2 } as const;
				if (cancelOrder[nextCancel.state] < cancelOrder[priorCancel.state]) {
					failDurability(
						`pending cancel command ${priorCancel.commandId} cannot regress its durable state`,
						journalDir,
					);
				}
			}

			const recordedAt = Date.now();
		const journalEntryBase: JournalEntryBase = {
			commitSeqStart: start,
			commitSeqEnd: end,
			...(command === undefined ? {} : { command }),
			events: stamped,
			...(run === undefined ? {} : { run }),
			...(receipt === undefined ? {} : { receipt }),
			recordedAt,
			previousSegmentHash: journal.anchor?.tailSegmentHash ?? null,
		};
		const segmentHash = hashJournalEntryBase(journalEntryBase);
		const journalEntry: JournalEntry = { ...journalEntryBase, segmentHash };
		const journalFile = path.join(
			journalDir,
			`${String(start).padStart(12, "0")}-${String(end).padStart(12, "0")}.json`,
		);
		if (fs.existsSync(journalFile)) {
			throw new Error(
				`journal segment collision at commitSeq ${start}-${end} — commit lock / seq broken`,
			);
		}
		// Refuse to serialize a locally malformed durable entity even before the
		// next full-history recovery pass.
		validateJournalEntry(journalEntry, journalFile, { start, end });
		const anchor: JournalAnchor = {
			schemaVersion: 1,
			projectId: headerCache.projectId,
			controlDomainId: headerCache.controlDomainId,
			firstCommitSeq: journal.anchor?.firstCommitSeq ?? start,
			lastCommitSeq: end,
			tailSegmentHash: segmentHash,
			createdAt: journal.anchor?.createdAt ?? recordedAt,
			updatedAt: recordedAt,
		};
		// Publish the exact intended tail before its segment. A crash in this
		// window is deliberately fail-closed on reopen, never treated as a
		// permission to drop history or reuse the commit range.
		writeFileAtomic(journalAnchorPath, JSON.stringify(anchor, null, 2));
		writeFileAtomic(journalFile, JSON.stringify(journalEntry, null, 2));
		writeFileAtomic(seqPath, JSON.stringify({ next }, null, 2));
		writeFileAtomic(streamSeqPath, JSON.stringify(streamMap, null, 2));

		if (command) {
			writeFileAtomic(
				path.join(projectCommandsDir(root), `${command.commandId}.json`),
				JSON.stringify(command, null, 2),
			);
			if (command.runId) {
				writeFileAtomic(
					path.join(projectCommandsDir(root), `by-cmd-${command.commandId}.json`),
					JSON.stringify({ runId: command.runId }, null, 2),
				);
			}
		}
		if (run) {
			writeFileAtomic(
				path.join(projectProjectionsDir(root), `run-${run.runId}.json`),
				JSON.stringify(run, null, 2),
			);
		}
		if (receipt) {
			writeFileAtomic(
				path.join(projectReceiptsDir(root), `${receipt.receiptId}.json`),
				JSON.stringify(receipt, null, 2),
			);
			writeFileAtomic(
				path.join(projectReceiptsDir(root), `by-run-${receipt.runId}.json`),
				JSON.stringify({ receiptId: receipt.receiptId }, null, 2),
			);
		}

		headerCache = { ...headerCache, updatedAt: Date.now() };
		writeFileAtomic(headerPath, JSON.stringify(headerCache, null, 2));

		return { commitSeqStart: start, commitSeqEnd: end };
	}

	const store: ProjectControlStore = {
		projectRoot: root,
		get header() {
			return headerCache;
		},

		nextCommitSeq() {
			// Always durable view — never a stale in-memory counter.
			assertControlLayoutHasNoSymlinks();
			return readSeqNext();
		},

		getCompactionState() {
			return readConsistentJournal(() => deriveCompactionState(readJournalIntegrity().segments));
		},

		advanceCompactionCursor(throughCommitSeq: number) {
			return withMutationFence(() =>
				withCommitLock(() => {
					if (!isPositiveSafeInteger(throughCommitSeq)) {
						return { error: "throughCommitSeq must be a positive safe integer" };
					}
					const before = deriveCompactionState(readJournalIntegrity().segments);
					const alreadyThrough = before.minAvailableCommitSeq - 1;
					if (throughCommitSeq < alreadyThrough) {
						return { error: "throughSeq below already-compacted range" };
					}
					if (throughCommitSeq === alreadyThrough) return before;
					if (throughCommitSeq > before.maxCommitSeq) {
						return { error: "cannot compact past the current journal tail" };
					}

					const recordedAt = Date.now();
					const range = commitUnlocked({
						events: [
							{
								eventId: newId("compaction"),
								schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
								controlDomainId: headerCache.controlDomainId,
								streamId: COMPACTION_STREAM_ID,
								streamSeq: 0,
								commitSeq: 0,
								projectId: headerCache.projectId,
								recordedAt,
								payload: { type: "CompactionCheckpoint", throughCommitSeq },
							},
						],
					});
					return {
						minAvailableCommitSeq: throughCommitSeq + 1,
						maxCommitSeq: range.commitSeqEnd,
						lastCheckpointCommitSeq: range.commitSeqEnd,
						updatedAt: recordedAt,
					};
				}),
			);
		},

		commit(batch: CommitBatch) {
			return withMutationFence(() =>
				withCommitLock(() => commitUnlocked(batch)),
			);
		},

		withProviderSubmissionFence(runId, operation) {
			if (!isSafeCommandId(runId)) {
				failDurability(`provider submission fence has an unsafe run id ${JSON.stringify(runId)}`);
			}
			if (readOnly) {
				failDurability("read-only ControlStore cannot enter a provider submission fence");
			}
			return withMutationFence(() =>
				withCommitLock(() => {
					const result = operation();
					if (
						result !== null &&
						typeof result === "object" &&
						typeof (result as { then?: unknown }).then === "function"
					) {
						failDurability(
							"provider submission fence callback returned a Promise; async side effects cannot be linearized",
						);
					}
					return result;
				}),
			);
		},

		compareAndCommit(opts: CompareAndCommitOpts): CompareAndCommitResult {
			return withMutationFence(() =>
				withCommitLock(() => {
					// Re-read durable projection under the same lock as commit (P15 first-commit-wins).
					const current = readRunFromDisk(opts.runId);
					if (!current) {
						return {
							ok: false as const,
							code: "TF_NOT_FOUND" as const,
							message: `run ${opts.runId} not found`,
						};
					}
					// Version check first so concurrent CAS losers report TF_STALE_VERSION
					// (not terminal/INVALID) when the winner already advanced runVersion.
					if (
						opts.expectedRunVersion !== undefined &&
						current.runVersion !== opts.expectedRunVersion
					) {
						return {
							ok: false as const,
							code: "TF_STALE_VERSION" as const,
							message: `expected runVersion ${opts.expectedRunVersion}, have ${current.runVersion}`,
							run: current,
						};
					}
					// Defense: durable receipt index wins even if projection lag.
					const existingRcpt = readJsonFileStrict<{ receiptId: string }>(
						path.join(projectReceiptsDir(root), `by-run-${opts.runId}.json`),
					);
					if (existingRcpt?.receiptId || current.receiptId || current.stage === "terminal") {
						return {
							ok: false as const,
							code: "TF_INVALID_ARGUMENT" as const,
							message: `run is terminal/has Receipt (status=${current.status} stage=${current.stage}); cannot mutate`,
							run: current,
						};
					}
					if (opts.validate) {
						const msg = opts.validate(current);
						if (msg) {
							return {
								ok: false as const,
								code: "TF_INVALID_ARGUMENT" as const,
								message: msg,
								run: current,
							};
						}
					}
					const built = opts.build(current);
					const ranges = commitUnlocked({
						command: built.command,
						events: built.events,
						run: built.run,
						receipt: built.receipt,
					});
					return {
						ok: true as const,
						run: built.run,
						receipt: built.receipt,
						commitSeqStart: ranges.commitSeqStart,
						commitSeqEnd: ranges.commitSeqEnd,
					};
				}),
			);
		},

		recoverFromJournal() {
			return withMutationFence(() =>
				withCommitLock(() => rebuildFromJournal()),
			);
		},

		claimCommand(input) {
			return withMutationFence(() =>
				withCommitLock(() => {
					// A command index is derived only. Rebuild before idempotency
					// comparison so an orphan file cannot claim command authority.
					rebuildFromJournal();
					const existing = readJsonFileStrict<CommandRecord>(
						path.join(projectCommandsDir(root), `${input.commandId}.json`),
					);
					if (existing) {
						if (existing.requestHash === input.requestHash) {
							return { kind: "existing" as const, command: existing };
						}
						return { kind: "conflict" as const, command: existing };
					}
					const cmd: CommandRecord = {
						commandId: input.commandId,
						requestHash: input.requestHash,
						callerPrincipal: input.callerPrincipal,
						authorizationContextHash: input.requestHash,
						projectId: headerCache.projectId,
						controlDomainId: headerCache.controlDomainId,
						kind: input.kind,
						status: "accepted",
						firstCommitSeq: 0,
						lastCommitSeq: 0,
						runId: input.runId,
						recordedAt: Date.now(),
					};
					commitUnlocked({ command: cmd, events: [] });
					return { kind: "claimed" as const };
				}),
			);
		},

		claimAdmissionIntent(input) {
			return withMutationFence(() =>
				withCommitLock(() => {
					rebuildFromJournal();
					if (
						!isSafeCommandId(input.commandId) ||
						!isNonEmptyString(input.requestHash) ||
						!isNonEmptyString(input.callerPrincipal) ||
						!isNonEmptyString(input.authorizationContextHash)
					) {
						failDurability("admission intent has an invalid command identity", journalDir);
					}
					const admission = validateAdmissionIntent(input.admission, journalDir);
					if (admission.state !== "queued") {
						failDurability("new admission intent must begin in queued state", journalDir);
					}
					const existing = readCommandFromDisk(input.commandId);
					if (existing) {
						if (existing.requestHash !== input.requestHash) {
							return { kind: "conflict" as const, command: existing };
						}
						return { kind: "existing" as const, command: existing };
					}
					const command: CommandRecord = {
						commandId: input.commandId,
						requestHash: input.requestHash,
						callerPrincipal: input.callerPrincipal,
						authorizationContextHash: input.authorizationContextHash,
						projectId: headerCache.projectId,
						controlDomainId: headerCache.controlDomainId,
						kind: "admitAndRun",
						status: "queued",
						firstCommitSeq: 0,
						lastCommitSeq: 0,
						runId: admission.runId,
						admission,
						recordedAt: Date.now(),
					};
					const range = commitUnlocked({
						command,
						events: [
							makeStoreEvent(
								admission.runId,
								{ type: "AdmissionIntentRecorded", commandId: input.commandId, admission },
								input.commandId,
							),
						],
					});
					return {
						kind: "claimed" as const,
						command: {
							...command,
							firstCommitSeq: range.commitSeqStart,
							lastCommitSeq: range.commitSeqEnd,
						},
					};
				}),
			);
		},

		prepareAdmission(input) {
			return withMutationFence(() =>
				withCommitLock(() => {
					rebuildFromJournal();
					const command = readCommandFromDisk(input.commandId);
					if (!command?.admission) {
						failDurability(`admission command ${input.commandId} is missing its durable intent`, journalDir);
					}
					const admission = command.admission;
					if (
						admission.admissionId !== input.admissionId ||
						admission.runId !== input.run.runId ||
						admission.continuationId !== input.continuation.continuationId ||
						admission.boundPlanHash !== input.boundPlan.boundPlanHash ||
						input.run.admissionId !== input.admissionId ||
						input.run.continuationId !== input.continuation.continuationId ||
						input.run.boundPlanHash !== input.boundPlan.boundPlanHash ||
						input.reservation.admissionId !== input.admissionId ||
						!isSafeCommandId(input.reservation.reservationId) ||
						!isNonNegativeSafeInteger(input.reservation.coordinatorEpoch)
					) {
						failDurability(`admission ${input.admissionId} has mismatched prepare identity`, journalDir);
					}

					const existingRun = readRunFromDisk(admission.runId);
					if (existingRun) {
						const sameReservation = existingRun.reservationId === input.reservation.reservationId;
						if (sameReservation) {
							if (
								existingRun.admissionId !== admission.admissionId ||
								existingRun.continuationId !== admission.continuationId ||
								existingRun.boundPlanHash !== admission.boundPlanHash
							) {
								failDurability(`admission ${input.admissionId} Run disagrees with its intent`, journalDir);
							}
							const projectAdmitCommitSeq = findRunAdmittedEvidence(
								admission.runId,
								input.reservation.reservationId,
							);
							if (projectAdmitCommitSeq === null) {
								failDurability(`admission ${input.admissionId} Run lacks RunAdmitted evidence`, journalDir);
							}
							return {
								kind: "existing" as const,
								command,
								run: existingRun,
								projectAdmitCommitSeq,
							};
						}

						// A reserved coordinator lease can expire after this project has
						// journaled its pre-provider Run but before the coordinator commit.
						// The durable admission identity owns recovery: it may replace that
						// lease only while the Run has never reached a provider-facing state.
						if (
							admission.state !== "project-prepared" ||
							command.status !== "accepted" ||
							existingRun.admissionId !== admission.admissionId ||
							existingRun.reservationId !== admission.reservationId ||
							existingRun.continuationId !== admission.continuationId ||
							existingRun.boundPlanHash !== admission.boundPlanHash ||
							existingRun.status !== "running" ||
							existingRun.stage !== "queued" ||
							existingRun.needsOperator ||
							existingRun.receiptId !== undefined ||
							existingRun.providerHandle !== undefined ||
							!admission.reservationId ||
							!isPositiveSafeInteger(input.reservation.reservedExpiresAt) ||
							hasProviderDispatchEvidence(existingRun.runId)
						) {
							failDurability(
								`admission ${input.admissionId} cannot safely replace its prepared reservation`,
								journalDir,
							);
						}
						const priorProjectAdmitCommitSeq = findRunAdmittedEvidence(
							existingRun.runId,
							admission.reservationId,
						);
						if (priorProjectAdmitCommitSeq === null) {
							failDurability(
								`admission ${input.admissionId} has no prior RunAdmitted evidence to rebind`,
								journalDir,
							);
						}
						const reservationGeneration = (admission.reservationGeneration ?? 0) + 1;
						const reboundAdmission: AdmissionIntent = {
							...admission,
							reservationId: input.reservation.reservationId,
							reservationGeneration,
							updatedAt: Date.now(),
						};
						const reboundCommand: CommandRecord = {
							...command,
							admission: reboundAdmission,
							recordedAt: Date.now(),
						};
						const reboundRun: RunProjection = {
							...existingRun,
							reservationId: input.reservation.reservationId,
							updatedAt: Date.now(),
							runVersion: existingRun.runVersion + 1,
						};
						const range = commitUnlocked({
							command: reboundCommand,
							events: [
								makeStoreEvent(
									reboundRun.runId,
									{
										type: "AdmissionReservationRebound",
										runId: reboundRun.runId,
										admissionId: admission.admissionId,
										fromReservationId: admission.reservationId,
										reservationId: input.reservation.reservationId,
										reservationGeneration,
										coordinatorEpoch: input.reservation.coordinatorEpoch,
										reservedExpiresAt: input.reservation.reservedExpiresAt,
									},
									input.commandId,
								),
								makeStoreEvent(
									reboundRun.runId,
									{
										type: "RunAdmitted",
										runId: reboundRun.runId,
										reservationId: input.reservation.reservationId,
									},
									input.commandId,
								),
							],
							run: reboundRun,
						});
						return {
							kind: "rebound" as const,
							command: {
								...reboundCommand,
								firstCommitSeq: command.firstCommitSeq,
								lastCommitSeq: range.commitSeqEnd,
							},
							run: reboundRun,
							projectAdmitCommitSeq: range.commitSeqEnd,
						};
					}
					if (command.status !== "queued" || admission.state !== "queued") {
						failDurability(
							`admission ${input.admissionId} is ${admission.state} without its prepared Run`,
							journalDir,
						);
					}
					if (!isPositiveSafeInteger(input.reservation.reservedExpiresAt)) {
						failDurability(`admission ${input.admissionId} has no live reserved slot to prepare`, journalDir);
					}

					const preparedAdmission: AdmissionIntent = {
						...admission,
						state: "project-prepared",
						reservationId: input.reservation.reservationId,
						reservationGeneration: admission.reservationGeneration ?? 0,
						updatedAt: Date.now(),
					};
					const preparedCommand: CommandRecord = {
						...command,
						status: "accepted",
						admission: preparedAdmission,
						recordedAt: Date.now(),
					};
					const preparedRun: RunProjection = {
						...input.run,
						status: "running",
						stage: "queued",
						admissionId: admission.admissionId,
						reservationId: input.reservation.reservationId,
					};
					const range = commitUnlocked({
						command: preparedCommand,
						events: [
							makeStoreEvent(preparedRun.runId, {
								type: "SlotReserved",
								runId: preparedRun.runId,
								admissionId: admission.admissionId,
								reservationId: input.reservation.reservationId,
								coordinatorEpoch: input.reservation.coordinatorEpoch,
								reservedExpiresAt: input.reservation.reservedExpiresAt,
							}, input.commandId),
							makeStoreEvent(
								preparedRun.runId,
								{
									type: "BoundPlanStored",
									runId: preparedRun.runId,
									boundPlan: serializeSchema1BoundPlan(input.boundPlan),
								},
								input.commandId,
							),
							makeStoreEvent(
								preparedRun.runId,
								{ type: "ContinuationStored", continuation: input.continuation },
								input.commandId,
							),
							makeStoreEvent(
								preparedRun.runId,
								{
									type: "RunReceived",
									runId: preparedRun.runId,
									boundPlanHash: input.boundPlan.boundPlanHash,
								},
								input.commandId,
							),
							makeStoreEvent(
								preparedRun.runId,
								{
									type: "ProjectRunPrepared",
									runId: preparedRun.runId,
									admissionId: admission.admissionId,
									reservationId: input.reservation.reservationId,
								},
								input.commandId,
							),
							// This immutable project record is the evidence referenced by the
							// subsequent coordinator commit. Dispatch remains prohibited until
							// SlotCommitted is journaled in a later project mutation.
							makeStoreEvent(
								preparedRun.runId,
								{
									type: "RunAdmitted",
									runId: preparedRun.runId,
									reservationId: input.reservation.reservationId,
								},
								input.commandId,
							),
						],
						run: preparedRun,
					});
					return {
						kind: "prepared" as const,
						command: {
							...preparedCommand,
							firstCommitSeq: command.firstCommitSeq,
							lastCommitSeq: range.commitSeqEnd,
						},
						run: preparedRun,
						projectAdmitCommitSeq: range.commitSeqEnd,
					};
				}),
			);
		},

		finalizeAdmission(input) {
			return withMutationFence(() =>
				withCommitLock(() => {
					rebuildFromJournal();
					const command = readCommandFromDisk(input.commandId);
					const admission = command?.admission;
					if (!command || !admission) {
						failDurability(`admission command ${input.commandId} is missing during slot commit`, journalDir);
					}
					const run = readRunFromDisk(admission.runId);
					if (
						!run ||
						admission.admissionId !== input.admissionId ||
						admission.reservationId !== input.reservationId ||
						run.admissionId !== input.admissionId ||
						run.reservationId !== input.reservationId
					) {
						failDurability(`admission ${input.admissionId} has no matching prepared Run`, journalDir);
					}
					const evidence = findRunAdmittedEvidence(run.runId, input.reservationId);
					if (evidence !== input.projectAdmitCommitSeq) {
						failDurability(`admission ${input.admissionId} coordinator proof does not match RunAdmitted`, journalDir);
					}
					if (admission.state === "slot-committed") {
						return { kind: "existing" as const, command, run };
					}
					if (admission.state !== "project-prepared") {
						failDurability(`admission ${input.admissionId} cannot commit from ${admission.state}`, journalDir);
					}
					const committedAdmission: AdmissionIntent = {
						...admission,
						state: "slot-committed",
						updatedAt: Date.now(),
					};
					const committedCommand: CommandRecord = {
						...command,
						admission: committedAdmission,
						recordedAt: Date.now(),
					};
					const committedRun: RunProjection = {
						...run,
						status: "running",
						stage: "admitted",
						updatedAt: Date.now(),
						runVersion: run.runVersion + 1,
					};
					commitUnlocked({
						command: committedCommand,
						events: [
							makeStoreEvent(
								committedRun.runId,
								{
									type: "SlotCommitted",
									runId: committedRun.runId,
									admissionId: input.admissionId,
									reservationId: input.reservationId,
									projectAdmitCommitSeq: input.projectAdmitCommitSeq,
								},
								input.commandId,
							),
						],
						run: committedRun,
					});
					return { kind: "committed" as const, command: committedCommand, run: committedRun };
				}),
			);
		},

		getRun(runId: string) {
			return readRunFromDisk(runId);
		},

		getBoundPlan(boundPlanHash: string) {
			if (!isNonEmptyString(boundPlanHash)) return null;
			return readConsistentJournal(() => {
				let found: BoundPlan | null = null;
				for (const { entry } of readJournalIntegrity().segments) {
					for (const event of entry.events) {
						if (
							event.payload.type === "BoundPlanStored" &&
							event.payload.boundPlan.boundPlanHash === boundPlanHash
						) {
							if (found && !sameBoundPlan(found, event.payload.boundPlan)) {
								failDurability(`bound plan ${boundPlanHash} has divergent journal snapshots`, journalDir);
							}
							found = event.payload.boundPlan;
						}
					}
				}
				return found;
			});
		},

		getContinuation(runId: string) {
			if (!isSafeCommandId(runId)) return null;
			return readConsistentJournal(() => readContinuationFromJournal(runId));
		},

		getJournalRunSnapshot(runId: string) {
			if (!isSafeCommandId(runId)) {
				return { run: null, continuation: null, approval: null, receipt: null };
			}
			return readStableJournal((journal) => journalRunSnapshot(journal, runId));
		},

		getApprovalForRun(runId: string) {
			if (!isSafeCommandId(runId)) return null;
			return readConsistentJournal(() => {
				let found: ApprovalRequest | null = null;
				for (const { entry } of readJournalIntegrity().segments) {
					for (const event of entry.events) {
						if (
							event.payload.type === "ApprovalRequestStored" &&
							event.payload.approval.runId === runId
						) {
							found = event.payload.approval;
						}
					}
				}
				return found;
			});
		},

		listRuns() {
			assertControlLayoutHasNoSymlinks();
			const dir = projectProjectionsDir(root);
			if (!fs.existsSync(dir)) return [];
			const out: RunProjection[] = [];
			for (const f of fs.readdirSync(dir)) {
				if (!f.startsWith("run-") || !f.endsWith(".json")) continue;
				const runId = f.slice("run-".length, -".json".length);
				if (!isSafeCommandId(runId)) {
					failDurability("projection file has an unsafe run id", path.join(dir, f));
				}
				const r = readRunFromDisk(runId);
				if (r) out.push(r);
			}
			return out.sort((a, b) => b.updatedAt - a.updatedAt);
		},

		getReceipt(receiptId: string) {
			assertControlLayoutHasNoSymlinks();
			if (!isSafeCommandId(receiptId)) return null;
			const filePath = path.join(projectReceiptsDir(root), `${receiptId}.json`);
			const raw = readJsonFileStrict<unknown>(filePath);
			return raw === null ? null : validateReceipt(raw, filePath);
		},

		getReceiptForRun(runId: string) {
			assertControlLayoutHasNoSymlinks();
			if (!isSafeCommandId(runId)) return null;
			const indexPath = path.join(projectReceiptsDir(root), `by-run-${runId}.json`);
			const idx = readJsonFileStrict<unknown>(indexPath);
			if (idx === null) return null;
			if (!isRecord(idx) || !hasOnlyKeys(idx, ["receiptId"]) || !isSafeCommandId(idx.receiptId)) {
				failDurability("receipt by-run index has an invalid shape", indexPath);
			}
			const receipt = store.getReceipt(idx.receiptId);
			if (receipt && receipt.runId !== runId) {
				failDurability("receipt by-run index points to another run", indexPath);
			}
			return receipt;
		},

		getCommand(commandId: string) {
			assertControlLayoutHasNoSymlinks();
			if (!isSafeCommandId(commandId)) return null;
			const filePath = path.join(projectCommandsDir(root), `${commandId}.json`);
			const raw = readJsonFileStrict<unknown>(filePath);
			return raw === null ? null : validateCommandRecord(raw, filePath);
		},

		getRunIdForCommand(commandId: string) {
			assertControlLayoutHasNoSymlinks();
			if (!isSafeCommandId(commandId)) return null;
			const indexPath = path.join(projectCommandsDir(root), `by-cmd-${commandId}.json`);
			const idx = readJsonFileStrict<unknown>(indexPath);
			if (idx !== null) {
				if (!isRecord(idx) || !hasOnlyKeys(idx, ["runId"]) || !isSafeCommandId(idx.runId)) {
					failDurability("command by-cmd index has an invalid shape", indexPath);
				}
				const command = store.getCommand(commandId);
				if (command && command.runId !== idx.runId) {
					failDurability("command by-cmd index points to another run", indexPath);
				}
				return idx.runId;
			}
			const cmd = store.getCommand(commandId);
			return cmd?.runId ?? null;
		},

		readEvents(startCommitSeq: number, endCommitSeq: number) {
			return readConsistentJournal(() => {
				const events: ControlEvent[] = [];
				for (const { entry } of readJournalIntegrity().segments) {
					if (entry.commitSeqEnd < startCommitSeq || entry.commitSeqStart > endCommitSeq) continue;
					for (const ev of entry.events) {
						if (ev.commitSeq >= startCommitSeq && ev.commitSeq <= endCommitSeq) {
							events.push(ev);
						}
					}
				}
				return events.sort((a, b) => a.commitSeq - b.commitSeq);
			});
		},
	};

	return store;
}
