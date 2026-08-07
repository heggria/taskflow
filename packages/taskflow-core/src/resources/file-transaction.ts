/**
 * Resource-controlled file mutation transaction.
 *
 * This module is deliberately internal to `resources/execution.ts`: callers
 * receive transactions only after host authority and PathRef resolution. It
 * owns the data-plane sequence beneath that boundary:
 *
 *   durable snapshots -> atomic multi-scope lease -> durable intent/permit
 *   -> stage -> promote -> commit-content | restore + abort-restored
 *
 * The local backend provides taskflow-exclusive isolation. It does not claim
 * hostile external-process fencing; concurrent Taskflow writers are excluded
 * by the persistent lease and unexpected external changes fail closed.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedPathRef } from "./resolve.ts";
import type { WriteIntentJournal, PreparedMutation, WriteIntentRecord } from "./journal.ts";
import type { LeaseHandle, PersistentLeaseCoordinator } from "./leases.ts";
import { ensureDirectory, fsyncDirectory, writeJsonAtomicDurable } from "./persistence.ts";
import type { ExecutionOwner, ScopedContentEvidence } from "./types.ts";

export interface ResolvedFileWriteTarget {
	effectId: string;
	ref: ResolvedPathRef;
}

export interface FileWritePayload {
	effectId: string;
	content: string | Buffer;
}

export type FileTransactionResult =
	| {
			ok: true;
			intentId: string;
			committedPaths: string[];
			commitGeneration: number;
	  }
	| {
			ok: false;
			intentId: string;
			code: "declared-path-bypass" | "commit-rejected";
			reason: string;
			restored: true;
	  };

interface SnapshotManifest {
	version: 1;
	artifactId: string;
	effectId: string;
	physicalPath: string;
	logicalSubpath: string;
	exists: boolean;
	contentId: string;
	mode?: number;
	nearestExistingAncestor: string;
	blobPath?: string;
}

interface Snapshot extends SnapshotManifest {
	capabilityBindingId: string;
	scopeDigest: string;
}

export interface ResourceFileTransactionOptions {
	controlDirectory: string;
	resourceDomainId: string;
	owner: ExecutionOwner;
	targets: readonly ResolvedFileWriteTarget[];
	leases: PersistentLeaseCoordinator;
	journal: WriteIntentJournal;
	leaseTimeoutMs: number;
	permitTtlMs: number;
	signal?: AbortSignal;
	authorizationPrincipalId?: string;
	authorizationScopeRoot: string;
	/** Preserve a failed authenticated release for the session's next-admission drain. */
	onDeferredLeaseRelease?: (lease: LeaseHandle) => void;
}

function hash(parts: readonly (string | Buffer)[]): string {
	const digest = crypto.createHash("sha256");
	for (const part of parts) digest.update(part);
	return `sha256:${digest.digest("hex")}`;
}

function contentId(content: Buffer | undefined): string {
	return content === undefined ? hash(["missing\0"]) : hash(["regular-file\0", content]);
}

function isWithin(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function nearestExistingAncestor(candidate: string): string {
	let current = path.dirname(candidate);
	while (true) {
		try {
			const real = fs.realpathSync(current);
			if (!fs.statSync(real).isDirectory()) throw new Error(`ancestor is not a directory: ${current}`);
			return real;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(current);
			if (parent === current) throw new Error(`no existing ancestor for ${candidate}`);
			current = parent;
		}
	}
}

function inspectRegularFile(filePath: string): { exists: false } | { exists: true; content: Buffer; mode: number } {
	try {
		const stat = fs.lstatSync(filePath);
		if (!stat.isFile()) throw new Error(`TFWS_INVALID_PATH: target is not a regular file: ${filePath}`);
		const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
		const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
		try {
			return { exists: true, content: fs.readFileSync(fd), mode: stat.mode & 0o777 };
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
		throw error;
	}
}

function writeBufferDurable(filePath: string, content: Buffer, mode = 0o600): void {
	ensureDirectory(path.dirname(filePath));
	const fd = fs.openSync(filePath, "wx", mode);
	try {
		let offset = 0;
		while (offset < content.length) offset += fs.writeSync(fd, content, offset, content.length - offset);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fsyncDirectory(path.dirname(filePath));
}

function replaceFileAtomic(filePath: string, content: Buffer, mode = 0o600): void {
	const parent = path.dirname(filePath);
	ensureDirectory(parent);
	const temp = path.join(parent, `.taskflow-write-${process.pid}-${crypto.randomUUID()}`);
	try {
		writeBufferDurable(temp, content, mode);
		fs.renameSync(temp, filePath);
		if (process.platform !== "win32") fs.chmodSync(filePath, mode);
		fsyncDirectory(parent);
	} catch (error) {
		try { fs.unlinkSync(temp); } catch { /* best effort; transaction restore remains authoritative */ }
		throw error;
	}
}

function pruneCreatedParents(snapshot: Snapshot): void {
	let current = path.dirname(snapshot.physicalPath);
	while (current !== snapshot.nearestExistingAncestor && isWithin(snapshot.nearestExistingAncestor, current)) {
		try {
			fs.rmdirSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				current = path.dirname(current);
				continue;
			}
			break;
		}
		current = path.dirname(current);
	}
}

function currentContentId(snapshot: Snapshot): string {
	const current = inspectRegularFile(snapshot.physicalPath);
	return contentId(current.exists ? current.content : undefined);
}

function restoreSnapshot(snapshot: Snapshot): void {
	if (!snapshot.exists) {
		try {
			const stat = fs.lstatSync(snapshot.physicalPath);
			if (stat.isDirectory()) throw new Error(`cannot restore over directory target: ${snapshot.physicalPath}`);
			fs.unlinkSync(snapshot.physicalPath);
			fsyncDirectory(path.dirname(snapshot.physicalPath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		pruneCreatedParents(snapshot);
		return;
	}
	if (!snapshot.blobPath || snapshot.mode === undefined) throw new Error(`snapshot artifact is incomplete: ${snapshot.artifactId}`);
	const bytes = fs.readFileSync(snapshot.blobPath);
	if (contentId(bytes) !== snapshot.contentId) throw new Error(`snapshot artifact hash mismatch: ${snapshot.artifactId}`);
	replaceFileAtomic(snapshot.physicalPath, bytes, snapshot.mode);
}

function restoredEvidence(snapshots: readonly Snapshot[]): ScopedContentEvidence[] {
	return snapshots.map((snapshot) => ({
		canonicalPrefix: snapshot.physicalPath,
		scopeDigest: snapshot.scopeDigest,
		effectId: snapshot.effectId,
		capabilityBindingId: snapshot.capabilityBindingId,
		beforeContentId: snapshot.contentId,
		afterContentId: currentContentId(snapshot),
	}));
}

function assertExactPreState(snapshots: readonly Snapshot[]): void {
	for (const snapshot of snapshots) {
		if (currentContentId(snapshot) !== snapshot.contentId) {
			throw new Error(`declared final path '${snapshot.logicalSubpath}' changed outside the resource transaction`);
		}
	}
}

function assertExactPostState(snapshots: readonly Snapshot[], expected: ReadonlyMap<string, string>): void {
	for (const snapshot of snapshots) {
		if (currentContentId(snapshot) !== expected.get(snapshot.effectId)) {
			throw new Error(`post-state changed before durable commit for '${snapshot.logicalSubpath}'`);
		}
	}
}

async function releaseBestEffort(lease: LeaseHandle): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await lease.release();
			return true;
		} catch {
			// A terminal journal record must remain the operation result. Keep the
			// authenticated handle for a later admission drain instead of making a
			// committed mutation appear retryable.
		}
	}
	return false;
}

function readManifestFile(filePath: string): unknown {
	const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
	const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024) {
			throw new Error(`invalid snapshot manifest: ${filePath}`);
		}
		return JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
	} finally {
		fs.closeSync(fd);
	}
}

function loadRecoverySnapshots(
	controlDirectory: string,
	intent: WriteIntentRecord,
): Snapshot[] {
	const authorityRoot = intent.authorizationScopeRoot;
	if (!authorityRoot || !path.isAbsolute(authorityRoot)) {
		throw new Error(`intent ${intent.intentId} lacks an authorized recovery root`);
	}
	const canonicalAuthorityRoot = fs.realpathSync(authorityRoot);
	const artifacts = intent.restorableSnapshotArtifactIds;
	if (!artifacts || artifacts.length !== intent.scopes.length) {
		throw new Error(`intent ${intent.intentId} lacks an exact snapshot artifact set`);
	}
	const byEffect = new Map(intent.scopes.map((scope) => [scope.effectId, scope]));
	if (byEffect.size !== intent.scopes.length || byEffect.has(undefined)) {
		throw new Error(`intent ${intent.intentId} lacks unique effect attribution`);
	}
	const snapshots: Snapshot[] = [];
	let expectedTransactionId: string | undefined;
	for (const artifactId of artifacts) {
		const match = /^workspace-snapshot:([0-9a-f-]{36}):([0-9a-f]{64})$/i.exec(artifactId);
		if (!match) throw new Error(`invalid snapshot artifact id: ${artifactId}`);
		const [, transactionId, artifactStem] = match;
		expectedTransactionId ??= transactionId;
		if (transactionId !== expectedTransactionId) throw new Error("snapshot artifacts span multiple transactions");
		const transactionDirectory = path.join(controlDirectory, "file-transactions", transactionId!);
		const canonicalTransactionDirectory = fs.realpathSync(transactionDirectory);
		if (!isWithin(fs.realpathSync(controlDirectory), canonicalTransactionDirectory)) {
			throw new Error("snapshot transaction directory escapes trusted control storage");
		}
		const raw = readManifestFile(path.join(canonicalTransactionDirectory, `${artifactStem}.json`));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid snapshot manifest ${artifactId}`);
		const manifest = raw as Record<string, unknown>;
		if (
			manifest.version !== 1 || manifest.artifactId !== artifactId ||
			typeof manifest.effectId !== "string" || typeof manifest.physicalPath !== "string" ||
			typeof manifest.logicalSubpath !== "string" || typeof manifest.exists !== "boolean" ||
			typeof manifest.contentId !== "string" || typeof manifest.nearestExistingAncestor !== "string" ||
			(manifest.mode !== undefined && (!Number.isInteger(manifest.mode) || Number(manifest.mode) < 0 || Number(manifest.mode) > 0o777))
		) throw new Error(`invalid snapshot manifest ${artifactId}`);
		const scope = byEffect.get(manifest.effectId);
		if (!scope || path.normalize(manifest.physicalPath) !== scope.canonicalPrefix) {
			throw new Error(`snapshot ${artifactId} does not match its durable intent scope`);
		}
		const physicalPath = path.normalize(manifest.physicalPath);
		const ancestor = path.normalize(manifest.nearestExistingAncestor);
		if (!isWithin(canonicalAuthorityRoot, physicalPath) ||
			!isWithin(canonicalAuthorityRoot, ancestor) ||
			!isWithin(ancestor, physicalPath)) {
			throw new Error(`snapshot ${artifactId} escapes its authorized recovery root`);
		}
		const exists = manifest.exists;
		const blobPath = exists ? path.join(canonicalTransactionDirectory, `${artifactStem}.blob`) : undefined;
		const beforeBytes = exists ? fs.readFileSync(blobPath!) : undefined;
		if (contentId(beforeBytes) !== manifest.contentId ||
			hash(["workspace-snapshot\0", physicalPath, "\0", String(manifest.contentId)]) !== `sha256:${artifactStem}`) {
			throw new Error(`snapshot ${artifactId} failed content-address verification`);
		}
		snapshots.push({
			version: 1,
			artifactId,
			effectId: manifest.effectId,
			physicalPath,
			logicalSubpath: manifest.logicalSubpath,
			exists,
			contentId: manifest.contentId,
			...(manifest.mode === undefined ? {} : { mode: Number(manifest.mode) }),
			nearestExistingAncestor: ancestor,
			...(blobPath === undefined ? {} : { blobPath }),
			capabilityBindingId: scope.capabilityBindingId ?? "",
			scopeDigest: scope.scopeDigest,
		});
	}
	return snapshots;
}

/** Restore a stale content intent while journal recovery holds its mutex. */
export async function recoverResourceFileIntent(options: {
	controlDirectory: string;
	intent: WriteIntentRecord;
	leases: PersistentLeaseCoordinator;
	leaseTimeoutMs: number;
	signal?: AbortSignal;
}): Promise<{
	scopes: ScopedContentEvidence[];
	reason: string;
	restorableSnapshotArtifactIds: string[];
} | undefined> {
	const { intent } = options;
	if (intent.commitMode !== "content-snapshot" || intent.externalMutation !== "taskflow-managed") return undefined;
	const snapshots = loadRecoverySnapshots(options.controlDirectory, intent);
	const owner: ExecutionOwner = {
		runId: `recovery-${crypto.randomUUID()}`,
		phaseId: "resource-recovery",
		attemptId: crypto.randomUUID(),
		unitId: intent.intentId,
		ancestry: [],
	};
	const lease = await options.leases.acquire(intent.scopes.map((scope) => ({
		key: { resourceDomainId: intent.resourceDomainId, canonicalPrefix: scope.canonicalPrefix },
		access: "read-write" as const,
		owner,
	})), { timeoutMs: options.leaseTimeoutMs, signal: options.signal });
	try {
		for (const snapshot of snapshots) {
			const currentAncestor = nearestExistingAncestor(snapshot.physicalPath);
			if (!isWithin(intent.authorizationScopeRoot!, currentAncestor)) {
				throw new Error(`recovery parent for '${snapshot.logicalSubpath}' escaped its authorized root`);
			}
		}
		for (const snapshot of [...snapshots].reverse()) restoreSnapshot(snapshot);
		const scopes = restoredEvidence(snapshots);
		if (scopes.some((scope) => scope.afterContentId !== scope.beforeContentId)) {
			throw new Error("crash recovery did not reproduce the durable pre-state");
		}
		return {
			scopes,
			reason: "startup recovery restored durable file-transaction pre-state",
			restorableSnapshotArtifactIds: snapshots.map((snapshot) => snapshot.artifactId),
		};
	} finally {
		if (!(await releaseBestEffort(lease))) {
			console.warn(`[taskflow] resource recovery lease cleanup deferred for lease ${lease.leaseId}`);
		}
	}
}

export class PreparedResourceFileTransaction {
	readonly intentId: string;
	readonly #snapshots: readonly Snapshot[];
	readonly #mutation: PreparedMutation;
	readonly #lease: LeaseHandle;
	readonly #journal: WriteIntentJournal;
	readonly #stagingDirectory: string;
	readonly #onDeferredLeaseRelease?: (lease: LeaseHandle) => void;
	#settled = false;

	constructor(input: {
		snapshots: readonly Snapshot[];
		mutation: PreparedMutation;
		lease: LeaseHandle;
		journal: WriteIntentJournal;
		stagingDirectory: string;
		onDeferredLeaseRelease?: (lease: LeaseHandle) => void;
	}) {
		this.intentId = input.mutation.intent.intentId;
		this.#snapshots = input.snapshots;
		this.#mutation = input.mutation;
		this.#lease = input.lease;
		this.#journal = input.journal;
		this.#stagingDirectory = input.stagingDirectory;
		this.#onDeferredLeaseRelease = input.onDeferredLeaseRelease;
	}

	async commit(payloads: readonly FileWritePayload[]): Promise<FileTransactionResult> {
		this.#assertOpen();
		const byId = new Map(payloads.map((payload) => [payload.effectId, payload]));
		if (byId.size !== this.#snapshots.length || this.#snapshots.some((snapshot) => !byId.has(snapshot.effectId))) {
			return this.#rejectAndFinish("commit-rejected", "payload ids do not exactly match the admitted effects");
		}
		try {
			assertExactPreState(this.#snapshots);
		} catch (error) {
			return this.#rejectAndFinish(
				"declared-path-bypass",
				error instanceof Error ? error.message : String(error),
			);
		}

		const expected = new Map<string, string>();
		try {
			for (const snapshot of this.#snapshots) {
				const payload = byId.get(snapshot.effectId)!;
				const bytes = typeof payload.content === "string" ? Buffer.from(payload.content, "utf8") : payload.content;
				const stagedPath = path.join(this.#stagingDirectory, "staged", `${snapshot.effectId}-${crypto.randomUUID()}.blob`);
				writeBufferDurable(stagedPath, bytes);
				expected.set(snapshot.effectId, contentId(bytes));
			}
			for (const snapshot of this.#snapshots) {
				await this.#journal.assertActive(this.#mutation.permit, this.#mutation.intent.owner);
				const payload = byId.get(snapshot.effectId)!;
				const bytes = typeof payload.content === "string" ? Buffer.from(payload.content, "utf8") : payload.content;
				replaceFileAtomic(snapshot.physicalPath, bytes, snapshot.mode ?? 0o600);
			}
			const evidence = this.#snapshots.map((snapshot) => ({
				canonicalPrefix: snapshot.physicalPath,
				scopeDigest: snapshot.scopeDigest,
				effectId: snapshot.effectId,
				capabilityBindingId: snapshot.capabilityBindingId,
				beforeContentId: snapshot.contentId,
				afterContentId: expected.get(snapshot.effectId)!,
			}));
			const committed = await this.#journal.commitContent(
				this.intentId,
				evidence,
				this.#snapshots.map((snapshot) => snapshot.artifactId),
				{ preCommitGuard: () => assertExactPostState(this.#snapshots, expected) },
			);
			this.#settled = true;
			return {
				ok: true,
				intentId: this.intentId,
				committedPaths: this.#snapshots.map((snapshot) => snapshot.logicalSubpath),
				commitGeneration: committed.commitGeneration!,
			};
		} catch (error) {
			return await this.#rejectAndRestore("commit-rejected", error instanceof Error ? error.message : String(error));
		} finally {
			await this.#finish();
		}
	}

	async reject(reason: string): Promise<FileTransactionResult> {
		this.#assertOpen();
		try {
			return await this.#rejectAndRestore("commit-rejected", reason || "phase rejected");
		} finally {
			await this.#finish();
		}
	}

	async #rejectAndRestore(
		code: "declared-path-bypass" | "commit-rejected",
		reason: string,
	): Promise<FileTransactionResult> {
		try {
			for (const snapshot of [...this.#snapshots].reverse()) restoreSnapshot(snapshot);
			const evidence = restoredEvidence(this.#snapshots);
			if (evidence.some((scope) => scope.afterContentId !== scope.beforeContentId)) {
				throw new Error("restored filesystem state does not match the durable pre-state snapshot");
			}
			await this.#journal.abortRestored(
				this.intentId,
				evidence,
				reason,
				this.#snapshots.map((snapshot) => snapshot.artifactId),
			);
			this.#settled = true;
			return { ok: false, intentId: this.intentId, code, reason, restored: true };
		} catch (restoreError) {
			const current = await this.#journal.getIntent(this.intentId);
			if (current?.status === "pending") {
				await this.#journal.markUnknown(
					this.intentId,
					`restore failed after ${reason}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
				);
			}
			this.#settled = true;
			throw restoreError;
		}
	}

	async #rejectAndFinish(
		code: "declared-path-bypass" | "commit-rejected",
		reason: string,
	): Promise<FileTransactionResult> {
		try {
			return await this.#rejectAndRestore(code, reason);
		} finally {
			await this.#finish();
		}
	}

	#assertOpen(): void {
		if (this.#settled) throw new Error(`resource file transaction ${this.intentId} is already settled`);
	}

	async #finish(): Promise<void> {
		try {
			fs.rmSync(path.join(this.#stagingDirectory, "staged"), { recursive: true, force: true });
		} finally {
			if (!(await releaseBestEffort(this.#lease))) {
				this.#onDeferredLeaseRelease?.(this.#lease);
				console.warn(`[taskflow] resource transaction lease cleanup deferred for lease ${this.#lease.leaseId}`);
			}
		}
	}
}

export async function prepareResourceFileTransaction(
	options: ResourceFileTransactionOptions,
): Promise<PreparedResourceFileTransaction> {
	if (options.targets.length === 0) throw new Error("a resource file transaction requires at least one target");
	const seenEffects = new Set<string>();
	const seenPaths = new Set<string>();
	for (const target of options.targets) {
		if (!target.effectId || seenEffects.has(target.effectId)) throw new Error(`duplicate or empty effect id: ${target.effectId}`);
		if (target.ref.capability.resourceDomainId !== options.resourceDomainId) {
			throw new Error(`TFWS_ACCESS_ESCALATION: effect '${target.effectId}' resolved to a foreign resource domain`);
		}
		if (target.ref.capability.access !== "read-write") {
			throw new Error(`TFWS_ACCESS_ESCALATION: effect '${target.effectId}' lacks read-write capability`);
		}
		if (seenPaths.has(target.ref.physicalPath)) throw new Error(`duplicate file target: ${target.ref.logicalSubpath}`);
		seenEffects.add(target.effectId);
		seenPaths.add(target.ref.physicalPath);
	}

	let lease: LeaseHandle | undefined;
	let mutation: PreparedMutation | undefined;
	const transactionId = crypto.randomUUID();
	const transactionDirectory = path.join(options.controlDirectory, "file-transactions", transactionId);
	try {
		lease = await options.leases.acquire(options.targets.map((target) => ({
			key: { resourceDomainId: options.resourceDomainId, canonicalPrefix: target.ref.physicalPath },
			access: "read-write" as const,
			owner: options.owner,
		})), {
			timeoutMs: options.leaseTimeoutMs,
			signal: options.signal,
		});
		ensureDirectory(transactionDirectory);
		const snapshots: Snapshot[] = [];
		for (const target of options.targets) {
			const inspected = inspectRegularFile(target.ref.physicalPath);
			const before = inspected.exists ? inspected.content : undefined;
			const beforeId = contentId(before);
			const artifactHash = hash(["workspace-snapshot\0", target.ref.physicalPath, "\0", beforeId]);
			const artifactStem = artifactHash.slice("sha256:".length);
			const artifactId = `workspace-snapshot:${transactionId}:${artifactStem}`;
			const blobPath = inspected.exists ? path.join(transactionDirectory, `${artifactStem}.blob`) : undefined;
			if (inspected.exists && blobPath) writeBufferDurable(blobPath, inspected.content);
			const snapshot: Snapshot = {
				version: 1,
				artifactId,
				effectId: target.effectId,
				physicalPath: target.ref.physicalPath,
				logicalSubpath: target.ref.logicalSubpath,
				exists: inspected.exists,
				contentId: beforeId,
				...(inspected.exists ? { mode: inspected.mode } : {}),
				nearestExistingAncestor: nearestExistingAncestor(target.ref.physicalPath),
				...(blobPath ? { blobPath } : {}),
				capabilityBindingId: target.ref.capability.bindingId,
				scopeDigest: hash([
					options.resourceDomainId,
					"\0",
					target.ref.capability.bindingId,
					"\0",
					target.ref.logicalSubpath,
				]),
			};
			writeJsonAtomicDurable(path.join(transactionDirectory, `${artifactStem}.json`), {
				version: snapshot.version,
				artifactId: snapshot.artifactId,
				effectId: snapshot.effectId,
				physicalPath: snapshot.physicalPath,
				logicalSubpath: snapshot.logicalSubpath,
				exists: snapshot.exists,
				contentId: snapshot.contentId,
				...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }),
				nearestExistingAncestor: snapshot.nearestExistingAncestor,
				...(snapshot.blobPath === undefined ? {} : { blobPath: snapshot.blobPath }),
			} satisfies SnapshotManifest);
			snapshots.push(snapshot);
		}
		mutation = await options.journal.prepare({
			resourceDomainId: options.resourceDomainId,
			providerInstanceId: "root",
			scopes: snapshots.map((snapshot) => ({
				canonicalPrefix: snapshot.physicalPath,
				scopeDigest: snapshot.scopeDigest,
				effectId: snapshot.effectId,
				capabilityBindingId: snapshot.capabilityBindingId,
				beforeContentId: snapshot.contentId,
			})),
			owner: options.owner,
			commitMode: "content-snapshot",
			externalMutation: "taskflow-managed",
			restorableSnapshotArtifactIds: snapshots.map((snapshot) => snapshot.artifactId),
			authorizationPrincipalId: options.authorizationPrincipalId,
			authorizationScopeRoot: options.authorizationScopeRoot,
			permitTtlMs: options.permitTtlMs,
		});
		await options.journal.activate([mutation.permit], options.owner);
		return new PreparedResourceFileTransaction({
			snapshots,
			mutation,
			lease,
			journal: options.journal,
			stagingDirectory: transactionDirectory,
			onDeferredLeaseRelease: options.onDeferredLeaseRelease,
		});
	} catch (error) {
		if (mutation) {
			const current = await options.journal.getIntent(mutation.intent.intentId);
			if (current?.status === "pending") await options.journal.markUnknown(current.intentId, "file transaction preparation failed");
		}
		if (lease && !(await releaseBestEffort(lease))) {
			options.onDeferredLeaseRelease?.(lease);
			console.warn(`[taskflow] resource transaction lease cleanup deferred for lease ${lease.leaseId}`);
		}
		throw error;
	}
}
