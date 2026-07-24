/**
 * Project ControlStore — sole Run/Command/Approval/Receipt authority (D6).
 * Files-only engine (P14): atomic batch commits under exclusive lock, fsync,
 * rebuildable indexes. commitSeq is re-read from disk inside the lock so two
 * open handles cannot mint the same sequence.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONTROL_STORE_SCHEMA_VERSION,
	type ArtifactRecord,
	type ArtifactRedactionClass,
	type BoundFragment,
	type BoundFragmentLink,
	type BoundPlan,
	type CommandRecord,
	type ControlEvent,
	type ControlStoreHeader,
	type Receipt,
	type RunProjection,
} from "../types.ts";
import {
	newId,
	sha256Hex,
	stableStringify,
} from "../hash.ts";
import { assertSafeId, isSafeId } from "../validate-ids.ts";
import { loadCompactionState } from "../compaction.ts";
import type { ApprovalRequest } from "../approval.ts";
import {
	approvalContinuationMatchesRun,
	decodeApprovalContinuationCheckpoint,
} from "../approval-continuation.ts";
import {
	bindDirectory,
	resolveIdentityOnOpen,
	type IdentityOpenPolicy,
} from "../identity.ts";
import {
	ensureDir,
	projectApprovalRecoveryIndexPath,
	projectApprovalsDir,
	projectArtifactBlobsDir,
	projectArtifactMetadataDir,
	projectBoundFragmentLinksDir,
	projectBoundFragmentsDir,
	projectCommandsDir,
	projectControlRoot,
	projectBoundPlansDir,
	projectHeaderPath,
	projectJournalDir,
	projectProjectionsDir,
	projectReceiptsDir,
	projectRunIndexPath,
	readJsonFile,
	withExclusiveLockFile,
	writeFileAtomic,
} from "../paths.ts";

export interface CommitBatch {
	command?: CommandRecord;
	events: ControlEvent[];
	run?: RunProjection;
	receipt?: Receipt;
	boundPlan?: BoundPlan;
	boundFragment?: BoundFragment;
	boundFragmentLink?: BoundFragmentLink;
}

interface ApprovalRecoveryIndex {
	readonly schemaVersion: 1;
	readonly throughCommitSeq: number;
	readonly runIds: readonly string[];
}

interface ProjectRunIndex {
	readonly schemaVersion: 1;
	readonly throughCommitSeq: number;
	readonly projectionCount: number;
	readonly runs: readonly RunProjection[];
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
	/**
	 * Permit a metadata-only settlement commit against a terminal Run.
	 *
	 * Callers must still supply a validate predicate. Receipts remain immutable
	 * and always block this path. This exists for a two-phase command whose
	 * domain transition is terminal before its external sidecar settles.
	 */
	allowTerminalCommandSettlement?: boolean;
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

export interface ProjectControlStore {
	readonly projectRoot: string;
	readonly header: ControlStoreHeader;
	/** Atomic commit: exclusive lock + re-read seq + contiguous commitSeq + fsync. */
	commit(batch: CommitBatch): {
		commitSeqStart: number;
		commitSeqEnd: number;
		/** Wall-clock publication origin recorded immediately before the journal write. */
		committedAt: number;
	};
	/**
	 * Dual-client first-commit-wins: under exclusive commit lock, re-read run,
	 * check expectedRunVersion + validate, then commit in the same critical section.
	 */
	compareAndCommit(opts: CompareAndCommitOpts): CompareAndCommitResult;
	/** Rebuild projections from journal (also runs on open). */
	recoverFromJournal(): {
		rebuiltRuns: number;
		rebuiltCommands: number;
		rebuiltReceipts: number;
		rebuiltBoundPlans: number;
		rebuiltBoundFragments: number;
		rebuiltBoundFragmentLinks: number;
	};
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
	getRun(runId: string): RunProjection | null;
	listRuns(): RunProjection[];
	/**
	 * Current unsettled approve handoffs. The rebuildable index is trusted only
	 * when its watermark matches the project ledger.
	 */
	listApprovalRecoveryRuns(): RunProjection[];
	getBoundPlan(boundPlanHash: string): BoundPlan | null;
	getBoundFragment(boundFragmentHash: string): BoundFragment | null;
	listBoundFragmentsForRun(runId: string): Array<{
		fragment: BoundFragment;
		link: BoundFragmentLink;
	}>;
	getReceipt(receiptId: string): Receipt | null;
	getReceiptForRun(runId: string): Receipt | null;
	getCommand(commandId: string): CommandRecord | null;
	putArtifact(input: {
		bytes: Uint8Array;
		mediaType: string;
		role: string;
		redactionClass: ArtifactRedactionClass;
		runId?: string;
		receiptId?: string;
		fileName?: string;
		artifactId?: string;
	}): ArtifactRecord;
	getArtifact(artifactId: string): ArtifactRecord | null;
	listArtifactsForRun(runId: string): ArtifactRecord[];
	listArtifactsByDigest(digest: string): ArtifactRecord[];
	readArtifactBytes(digest: string): Uint8Array | null;
	/** Resolve runId for a prior command (idempotent disclosure). */
	getRunIdForCommand(commandId: string): string | null;
	nextCommitSeq(): number;
	/** Events in [start, end] inclusive by commitSeq. */
	readEvents(startCommitSeq: number, endCommitSeq: number): ControlEvent[];
}

export interface OpenProjectStoreOptions {
	/**
	 * How to treat a ControlStore whose directoryBinding.path differs from open root.
	 * Default **strict**: refuse clone/worktree silent domain share (TF_IDENTITY_MISMATCH).
	 * - rebind: keep projectId/domainId, update path (explicit project move)
	 * - new-identity: mint new projectId/controlDomainId at this path
	 */
	identityPolicy?: IdentityOpenPolicy;
}

export interface ProjectControlReadSnapshot {
	header: ControlStoreHeader;
	runs: RunProjection[];
	boundPlans: BoundPlan[];
	boundFragments: BoundFragment[];
	boundFragmentLinks: BoundFragmentLink[];
	receipts: Receipt[];
	approvals: ApprovalRequest[];
	artifacts: ArtifactRecord[];
	nextCommitSeq: number;
	minAvailableCommitSeq: number;
}

export type InspectProjectControlStoreResult =
	| { ok: true; snapshot: ProjectControlReadSnapshot }
	| {
			ok: false;
			reason:
				| "missing"
				| "header-invalid"
				| "identity-mismatch"
				| "projection-invalid"
				| "bound-plan-invalid"
				| "bound-fragment-invalid"
				| "receipt-invalid"
				| "approval-invalid"
				| "artifact-invalid"
				| "watermark-invalid"
				| "unavailable";
			detail: string;
	  };

export type InspectProjectControlEventsResult =
	| { ok: true; events: ControlEvent[] }
	| {
			ok: false;
			reason:
				| "missing"
				| "identity-mismatch"
				| "journal-invalid"
				| "unavailable";
			detail: string;
	  };

function boundFragmentFileName(boundFragmentHash: string): string | null {
	const match = /^bf:([a-f0-9]{64})$/u.exec(boundFragmentHash);
	return match ? `bf-${match[1]}.json` : null;
}

function boundFragmentLinkFileName(
	link: Pick<BoundFragmentLink, "linkId">,
): string {
	return `${link.linkId}.json`;
}

/**
 * Read an immutable journal prefix without opening/recovering the store.
 * Callers bind `endCommitSeq` to a separately inspected watermark so a
 * concurrent later commit cannot leak into an older page snapshot.
 */
export function inspectProjectControlEvents(
	projectRoot: string,
	expected: {
		projectId: string;
		controlDomainId: string;
		endCommitSeq: number;
	},
): InspectProjectControlEventsResult {
	const root = path.resolve(projectRoot);
	const controlRoot = projectControlRoot(root);
	if (!fs.existsSync(controlRoot)) {
		return { ok: false, reason: "missing", detail: "control store is missing" };
	}
	try {
		return withExclusiveLockFile(
			path.join(controlRoot, "commit.lock"),
			() => {
				const header = readJsonFile<ControlStoreHeader>(
					projectHeaderPath(root),
				);
				if (
					!header ||
					header.projectId !== expected.projectId ||
					header.controlDomainId !== expected.controlDomainId
				) {
					return {
						ok: false as const,
						reason: "identity-mismatch" as const,
						detail:
							"requested identity does not match the control store header",
					};
				}
				if (
					!Number.isSafeInteger(expected.endCommitSeq) ||
					expected.endCommitSeq < 0
				) {
					return {
						ok: false as const,
						reason: "journal-invalid" as const,
						detail: "requested journal watermark is invalid",
					};
				}
				const events: ControlEvent[] = [];
				for (const file of fs
					.readdirSync(projectJournalDir(root))
					.filter((candidate) => candidate.endsWith(".json"))
					.sort()) {
					const entry = readJsonFile<{
						commitSeqStart: number;
						commitSeqEnd: number;
						events: ControlEvent[];
					}>(path.join(projectJournalDir(root), file));
					if (
						!entry ||
						!Number.isSafeInteger(entry.commitSeqStart) ||
						!Number.isSafeInteger(entry.commitSeqEnd) ||
						entry.commitSeqStart < 1 ||
						entry.commitSeqEnd < entry.commitSeqStart ||
						!Array.isArray(entry.events)
					) {
						return {
							ok: false as const,
							reason: "journal-invalid" as const,
							detail: "a journal segment is missing or invalid",
						};
					}
					if (entry.commitSeqStart > expected.endCommitSeq) break;
					for (const event of entry.events) {
						if (
							!event ||
							!isSafeId(event.eventId) ||
							event.projectId !== expected.projectId ||
							event.controlDomainId !==
								expected.controlDomainId ||
							!Number.isSafeInteger(event.commitSeq) ||
							event.commitSeq < entry.commitSeqStart ||
							event.commitSeq > entry.commitSeqEnd
						) {
							return {
								ok: false as const,
								reason: "journal-invalid" as const,
								detail:
									"a journal event violates segment or domain identity",
							};
						}
						if (event.commitSeq <= expected.endCommitSeq) {
							events.push(event);
						}
					}
				}
				events.sort(
					(left, right) =>
						left.commitSeq - right.commitSeq ||
						left.eventId.localeCompare(right.eventId, "en"),
				);
				return { ok: true as const, events };
			},
		);
	} catch {
		return {
			ok: false,
			reason: "unavailable",
			detail: "control journal could not be inspected consistently",
		};
	}
}

function isRunProjectionIndexEntry(
	value: unknown,
	header: ControlStoreHeader,
	nextCommitSeq: number,
): value is RunProjection {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		return false;
	}
	const run = value as Partial<RunProjection>;
	return (
		typeof run.runId === "string" &&
		isSafeId(run.runId) &&
		run.projectId === header.projectId &&
		run.controlDomainId === header.controlDomainId &&
		typeof run.lastCommitSeq === "number" &&
		Number.isSafeInteger(run.lastCommitSeq) &&
		run.lastCommitSeq >= 1 &&
		run.lastCommitSeq < nextCommitSeq
	);
}

function runProjectionFileNames(projectRoot: string): string[] {
	const dir = projectProjectionsDir(projectRoot);
	return fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter(
					(file) =>
						file.startsWith("run-") &&
						file.endsWith(".json"),
				)
				.sort()
		: [];
}

function readCurrentProjectRunIndex(
	projectRoot: string,
	header: ControlStoreHeader,
	nextCommitSeq: number,
): ProjectRunIndex | null {
	const value = readJsonFile<Partial<ProjectRunIndex>>(
		projectRunIndexPath(projectRoot),
	);
	const fileCount =
		runProjectionFileNames(projectRoot).length;
	if (
		value?.schemaVersion !== 1 ||
		value.throughCommitSeq !== nextCommitSeq - 1 ||
		value.projectionCount !== fileCount ||
		!Array.isArray(value.runs) ||
		value.runs.length !== fileCount ||
		!value.runs.every((run) =>
			isRunProjectionIndexEntry(
				run,
				header,
				nextCommitSeq,
			),
		)
	) {
		return null;
	}
	const runIds = value.runs.map((run) => run.runId);
	if (new Set(runIds).size !== runIds.length) return null;
	return {
		schemaVersion: 1,
		throughCommitSeq: value.throughCommitSeq,
		projectionCount: value.projectionCount,
		runs: [...value.runs].sort(
			(left, right) =>
				right.updatedAt - left.updatedAt ||
				left.runId.localeCompare(
					right.runId,
					"en",
				),
		),
	};
}

function buildProjectRunIndexFromProjections(
	projectRoot: string,
	header: ControlStoreHeader,
	nextCommitSeq: number,
): ProjectRunIndex | null {
	const files = runProjectionFileNames(projectRoot);
	const runs: RunProjection[] = [];
	for (const file of files) {
		const run = readJsonFile<RunProjection>(
			path.join(projectProjectionsDir(projectRoot), file),
		);
		if (
			!isRunProjectionIndexEntry(
				run,
				header,
				nextCommitSeq,
			)
		) {
			return null;
		}
		runs.push(run);
	}
	if (
		new Set(runs.map((run) => run.runId)).size !==
		runs.length
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		throughCommitSeq: nextCommitSeq - 1,
		projectionCount: files.length,
		runs: runs.sort(
			(left, right) =>
				right.updatedAt - left.updatedAt ||
				left.runId.localeCompare(
					right.runId,
					"en",
				),
		),
	};
}

function writeProjectRunIndex(
	projectRoot: string,
	index: ProjectRunIndex,
): void {
	writeFileAtomic(
		projectRunIndexPath(projectRoot),
		JSON.stringify(index, null, 2),
	);
}

/**
 * Read-only, lock-consistent inspection for WebGateway aggregate reads.
 *
 * Registry paths are discovery hints only. The authoritative header is
 * re-read under the project's commit lock, its identity/path binding is
 * verified, and every Run projection must agree with that header. No recovery,
 * header refresh, projection rewrite, or registry mutation is performed.
 */
export function inspectProjectControlStore(
	projectRoot: string,
	expected?: { projectId: string; controlDomainId: string },
): InspectProjectControlStoreResult {
	const root = path.resolve(projectRoot);
	const controlRoot = projectControlRoot(root);
	if (!fs.existsSync(controlRoot)) {
		return { ok: false, reason: "missing", detail: "control store is missing" };
	}
	const lockPath = path.join(controlRoot, "commit.lock");
	try {
		return withExclusiveLockFile(lockPath, () => {
			const header = readJsonFile<ControlStoreHeader>(projectHeaderPath(root));
			if (
				!header ||
				!Number.isInteger(header.schemaVersion) ||
				header.schemaVersion < 1 ||
				!isSafeId(header.projectId) ||
				!isSafeId(header.controlDomainId)
			) {
				return {
					ok: false as const,
					reason: "header-invalid" as const,
					detail: "control store header is missing or invalid",
				};
			}
			if (
				expected &&
				(header.projectId !== expected.projectId ||
					header.controlDomainId !== expected.controlDomainId)
			) {
				return {
					ok: false as const,
					reason: "identity-mismatch" as const,
					detail: "registry identity does not match the control store header",
				};
			}
			if (path.resolve(header.directoryBinding.path) !== root) {
				return {
					ok: false as const,
					reason: "identity-mismatch" as const,
					detail: "control store directory binding does not match the mounted root",
				};
			}

			const seq = readJsonFile<{ next: number }>(
				path.join(controlRoot, "commit-seq.json"),
			);
			const nextCommitSeq = seq?.next ?? 1;
			const compaction = loadCompactionState(root);
			if (
				!Number.isSafeInteger(nextCommitSeq) ||
				nextCommitSeq < 1 ||
				!Number.isSafeInteger(compaction.minAvailableCommitSeq) ||
				compaction.minAvailableCommitSeq < 1 ||
				compaction.minAvailableCommitSeq > nextCommitSeq
			) {
				return {
					ok: false as const,
					reason: "watermark-invalid" as const,
					detail: "control store commit watermark is invalid",
				};
			}

			const persistedRunIndex =
				readCurrentProjectRunIndex(
					root,
					header,
					nextCommitSeq,
				);
			const runIndex =
				persistedRunIndex ??
				(fs.existsSync(projectRunIndexPath(root))
					? null
					: buildProjectRunIndexFromProjections(
							root,
							header,
							nextCommitSeq,
						));
			if (!runIndex) {
				return {
					ok: false as const,
					reason: "projection-invalid" as const,
					detail:
						"a Run projection or its project-local index is missing, invalid, or belongs to another control domain",
				};
			}
			const runs = [...runIndex.runs];
			const boundPlans: BoundPlan[] = [];
			const boundPlanByHash = new Map<string, BoundPlan>();
			for (const file of fs
				.readdirSync(projectBoundPlansDir(root))
				.filter((candidate) => candidate.endsWith(".json"))
				.sort()) {
				const boundPlan = readJsonFile<BoundPlan>(
					path.join(projectBoundPlansDir(root), file),
				);
				if (
					!boundPlan ||
					!/^bp:[a-f0-9]{64}$/u.test(boundPlan.boundPlanHash) ||
					!/^es:[a-f0-9]{64}$/u.test(
						boundPlan.executionSemanticHash,
					) ||
					typeof boundPlan.programName !== "string" ||
					boundPlan.programName.length === 0 ||
					!Number.isSafeInteger(boundPlan.createdAt) ||
					file !==
						`${boundPlan.boundPlanHash.replace(":", "-")}.json` ||
					boundPlanByHash.has(boundPlan.boundPlanHash)
				) {
					return {
						ok: false as const,
						reason: "bound-plan-invalid" as const,
						detail:
							"a durable BoundPlan is missing, invalid, or conflicts with its content address",
					};
				}
				boundPlans.push(boundPlan);
				boundPlanByHash.set(boundPlan.boundPlanHash, boundPlan);
			}
			if (
				runs.some((run) => !boundPlanByHash.has(run.boundPlanHash))
			) {
				return {
					ok: false as const,
					reason: "bound-plan-invalid" as const,
					detail:
						"a Run projection references a BoundPlan that is not durably available",
				};
			}

			const runById = new Map(runs.map((run) => [run.runId, run]));
			const boundFragments: BoundFragment[] = [];
			const boundFragmentByHash = new Map<string, BoundFragment>();
			const boundFragmentsDir = projectBoundFragmentsDir(root);
			if (fs.existsSync(boundFragmentsDir)) {
				for (const file of fs
					.readdirSync(boundFragmentsDir)
					.filter((candidate) => candidate.endsWith(".json"))
					.sort()) {
					const fragment = readJsonFile<BoundFragment>(
						path.join(boundFragmentsDir, file),
					);
					if (
						!fragment ||
						file !==
							boundFragmentFileName(
								fragment.boundFragmentHash,
							) ||
						!/^es:[a-f0-9]{64}$/u.test(
							fragment.executionSemanticHash,
						) ||
						(fragment.parentBoundPlanHash !== undefined &&
							!boundPlanByHash.has(
								fragment.parentBoundPlanHash,
							)) ||
						!Number.isSafeInteger(fragment.createdAt) ||
						fragment.createdAt < 0 ||
						boundFragmentByHash.has(
							fragment.boundFragmentHash,
						)
					) {
						return {
							ok: false as const,
							reason:
								"bound-fragment-invalid" as const,
							detail:
								"a durable BoundFragment is missing, invalid, or conflicts with its content address",
						};
					}
					boundFragments.push(fragment);
					boundFragmentByHash.set(
						fragment.boundFragmentHash,
						fragment,
					);
				}
			}

			const boundFragmentLinks: BoundFragmentLink[] = [];
			const fragmentLinksDir =
				projectBoundFragmentLinksDir(root);
			if (fs.existsSync(fragmentLinksDir)) {
				for (const file of fs
					.readdirSync(fragmentLinksDir)
					.filter((candidate) => candidate.endsWith(".json"))
					.sort()) {
					const link = readJsonFile<BoundFragmentLink>(
						path.join(fragmentLinksDir, file),
					);
					const run = link
						? runById.get(link.runId)
						: undefined;
					const fragment = link
						? boundFragmentByHash.get(
								link.boundFragmentHash,
							)
						: undefined;
					if (
						!link ||
						file !== boundFragmentLinkFileName(link) ||
						link.projectId !== header.projectId ||
						link.controlDomainId !==
							header.controlDomainId ||
						!run ||
						!fragment ||
						!isSafeId(link.linkId) ||
						fragment.parentBoundPlanHash !==
							run.boundPlanHash ||
						!isSafeId(link.parentNodeInstanceId) ||
						!isSafeId(link.originPhaseId) ||
						(link.causationId !== undefined &&
							!isSafeId(link.causationId)) ||
						![
							"nested-flow",
							"graft-promote",
						].includes(link.linkKind) ||
						!Number.isSafeInteger(
							link.createdAtCommitSeq,
						) ||
						link.createdAtCommitSeq < 1 ||
						link.createdAtCommitSeq >= nextCommitSeq ||
						!Number.isSafeInteger(
							link.dynamicNodeCount,
						) ||
						link.dynamicNodeCount < 0 ||
						!Number.isSafeInteger(
							link.staticNodeCount,
						) ||
						link.staticNodeCount < 0 ||
						!Number.isSafeInteger(link.createdAt) ||
						link.createdAt < 0
					) {
						return {
							ok: false as const,
							reason:
								"bound-fragment-invalid" as const,
							detail:
								"a BoundFragment link is missing, invalid, or disagrees with its Run provenance",
						};
					}
					boundFragmentLinks.push(link);
				}
			}
			const linksByRunAndHash = new Set(
				boundFragmentLinks.map(
					(link) =>
						`${link.runId}\u0000${link.boundFragmentHash}`,
				),
			);
			if (
				runs.some(
					(run) =>
						(run.boundFragmentHash !== undefined &&
							!linksByRunAndHash.has(
								`${run.runId}\u0000${run.boundFragmentHash}`,
							)) ||
						(run.nodes ?? []).some(
							(node) =>
								node.origin === "bound-fragment" &&
								(!node.boundFragmentHash ||
									!linksByRunAndHash.has(
										`${run.runId}\u0000${node.boundFragmentHash}`,
									)),
						),
				)
			) {
				return {
					ok: false as const,
					reason: "bound-fragment-invalid" as const,
					detail:
						"a Run projection references dynamic inventory without a durable BoundFragment link",
				};
			}

			const artifacts: ArtifactRecord[] = [];
			const artifactById = new Map<string, ArtifactRecord>();
			const artifactMetadataDir =
				projectArtifactMetadataDir(root);
			if (fs.existsSync(artifactMetadataDir)) {
				for (const file of fs
					.readdirSync(artifactMetadataDir)
					.filter((candidate) =>
						candidate.endsWith(".json"),
					)
					.sort()) {
					const artifact = readJsonFile<ArtifactRecord>(
						path.join(artifactMetadataDir, file),
					);
					const digestMatch = artifact
						? /^sha256:([a-f0-9]{64})$/u.exec(
								artifact.digest,
							)
						: null;
					const blobPath = digestMatch
						? path.join(
								projectArtifactBlobsDir(root),
								digestMatch[1]!,
							)
						: "";
					const bytes =
						blobPath && fs.existsSync(blobPath)
							? fs.readFileSync(blobPath)
							: null;
					if (
						!artifact ||
						!isSafeId(artifact.artifactId) ||
						file !== `${artifact.artifactId}.json` ||
						artifact.projectId !== header.projectId ||
						artifact.controlDomainId !==
							header.controlDomainId ||
						!digestMatch ||
						!Number.isSafeInteger(artifact.size) ||
						artifact.size < 0 ||
						!bytes ||
						bytes.byteLength !== artifact.size ||
						sha256Hex(bytes) !== digestMatch[1] ||
						typeof artifact.mediaType !== "string" ||
						artifact.mediaType.length === 0 ||
						artifact.mediaType.length > 512 ||
						!isSafeId(artifact.role) ||
						artifact.storageClass !== "control-store" ||
						![
							"public",
							"project",
							"sensitive",
							"secret",
						].includes(artifact.redactionClass) ||
						!Number.isSafeInteger(artifact.createdAt) ||
						artifact.createdAt < 0 ||
						(artifact.runId !== undefined &&
							!runById.has(artifact.runId)) ||
						artifactById.has(artifact.artifactId)
					) {
						return {
							ok: false as const,
							reason: "artifact-invalid" as const,
							detail:
								"an artifact record or content-addressed blob is missing, invalid, or disagrees with its project identity",
						};
					}
					artifacts.push(artifact);
					artifactById.set(
						artifact.artifactId,
						artifact,
					);
				}
			}
			if (
				runs.some((run) => {
					if (
						run.approvalContinuationArtifactId ===
						undefined
					) {
						return false;
					}
					const artifact = artifactById.get(
						run.approvalContinuationArtifactId,
					);
					return (
						!isSafeId(
							run.approvalContinuationArtifactId,
						) ||
						!artifact ||
						artifact.runId !== run.runId ||
						artifact.role !==
							"approval-continuation" ||
						artifact.redactionClass !== "secret"
					);
				})
			) {
				return {
					ok: false as const,
					reason: "artifact-invalid" as const,
					detail:
						"a Run projection references an invalid approval continuation artifact",
				};
			}
			const receipts: Receipt[] = [];
			const receiptById = new Map<string, Receipt>();
			for (const file of fs
				.readdirSync(projectReceiptsDir(root))
				.filter(
					(candidate) =>
						candidate.endsWith(".json") &&
						!candidate.startsWith("by-run-"),
				)
				.sort()) {
				const receipt = readJsonFile<Receipt>(
					path.join(projectReceiptsDir(root), file),
				);
				const run = receipt ? runById.get(receipt.runId) : undefined;
				if (
					!receipt ||
					!isSafeId(receipt.receiptId) ||
					file !== `${receipt.receiptId}.json` ||
					receipt.projectId !== header.projectId ||
					receipt.controlDomainId !== header.controlDomainId ||
					!run ||
					run.boundPlanHash !== receipt.boundPlanHash ||
					receipt.startCommitSeq < 1 ||
					receipt.endCommitSeq < receipt.startCommitSeq ||
					receipt.endCommitSeq >= nextCommitSeq ||
					receipt.artifactRefs.some((artifactId) => {
						const artifact =
							artifactById.get(artifactId);
						return (
							!artifact ||
							artifact.runId !== receipt.runId ||
							artifact.role ===
								"approval-continuation" ||
							(artifact.receiptId !== undefined &&
								artifact.receiptId !==
									receipt.receiptId)
						);
					}) ||
					receiptById.has(receipt.receiptId)
				) {
					return {
						ok: false as const,
						reason: "receipt-invalid" as const,
						detail:
							"a durable Receipt is missing, invalid, or disagrees with its Run identity",
					};
				}
				receipts.push(receipt);
				receiptById.set(receipt.receiptId, receipt);
			}
			if (
				runs.some(
					(run) =>
						run.receiptId !== undefined &&
						!receiptById.has(run.receiptId),
				)
			) {
				return {
					ok: false as const,
					reason: "receipt-invalid" as const,
					detail:
						"a Run projection references a Receipt that is not durably available",
				};
			}
			const approvals: ApprovalRequest[] = [];
			const approvalById = new Map<string, ApprovalRequest>();
			for (const file of fs
				.readdirSync(projectApprovalsDir(root))
				.filter(
					(candidate) =>
						candidate.endsWith(".json") &&
						!candidate.startsWith("by-run-"),
				)
				.sort()) {
				const approval = readJsonFile<ApprovalRequest>(
					path.join(projectApprovalsDir(root), file),
				);
				const run = approval
					? runById.get(approval.runId)
					: undefined;
				const hasContinuationIdentity =
					approval !== null &&
					approval !== undefined &&
					(approval.nodeInstanceId !== undefined ||
						approval.boundPlanHash !== undefined ||
						approval.continuationArtifactId !==
							undefined);
				let continuationIdentityValid = true;
				if (
					approval &&
					run &&
					hasContinuationIdentity
				) {
					const artifact =
						approval.continuationArtifactId
							? artifactById.get(
									approval.continuationArtifactId,
								)
							: undefined;
					const bytes = artifact
						? (() => {
								const match =
									/^sha256:([a-f0-9]{64})$/u.exec(
										artifact.digest,
									);
								return match
									? fs.readFileSync(
											path.join(
												projectArtifactBlobsDir(
													root,
												),
												match[1]!,
											),
										)
									: null;
							})()
						: null;
					try {
						const checkpoint = bytes
							? decodeApprovalContinuationCheckpoint(
									bytes,
								)
							: null;
						continuationIdentityValid =
							Boolean(
								approval.nodeInstanceId &&
									isSafeId(
										approval.nodeInstanceId,
									) &&
									approval.boundPlanHash &&
									/^bp:[a-f0-9]{64}$/u.test(
										approval.boundPlanHash,
									) &&
									approval.continuationArtifactId &&
									isSafeId(
										approval.continuationArtifactId,
									) &&
									boundPlanByHash.has(
										approval.boundPlanHash,
									) &&
									approval.boundPlanHash ===
										run.boundPlanHash &&
									artifact &&
									artifact.runId ===
										run.runId &&
									artifact.role ===
										"approval-continuation" &&
									artifact.redactionClass ===
										"secret" &&
									artifact.mediaType ===
										"application/vnd.taskflow.approval-continuation+json" &&
									checkpoint &&
									checkpoint.runId ===
										run.runId &&
									checkpoint.boundPlanHash ===
										approval.boundPlanHash &&
									checkpoint.approvalPhaseId ===
										approval.nodeInstanceId &&
									approvalContinuationMatchesRun(
										checkpoint,
										run,
										{
											exact:
												approval.status ===
													"pending" &&
												run.approvalRequestId ===
													approval.approvalRequestId,
										},
									),
							);
						if (
							continuationIdentityValid &&
							approval.status === "pending" &&
							run.approvalRequestId ===
								approval.approvalRequestId
						) {
							continuationIdentityValid =
								run.approvalContinuationArtifactId ===
								approval.continuationArtifactId;
						}
					} catch {
						continuationIdentityValid = false;
					}
				}
				if (
					!approval ||
					!isSafeId(approval.approvalRequestId) ||
					file !== `${approval.approvalRequestId}.json` ||
					approval.projectId !== header.projectId ||
					approval.controlDomainId !==
						header.controlDomainId ||
					!run ||
					!Number.isSafeInteger(approval.version ?? 1) ||
					(approval.version ?? 1) < 1 ||
					!Number.isSafeInteger(approval.expectedRunVersion) ||
					approval.expectedRunVersion < 0 ||
					!Number.isSafeInteger(approval.createdAt) ||
					!continuationIdentityValid ||
					approvalById.has(approval.approvalRequestId)
				) {
					return {
						ok: false as const,
						reason: "approval-invalid" as const,
						detail:
							"a durable ApprovalRequest is missing, invalid, or disagrees with its Run identity",
					};
				}
				const normalized = {
					...approval,
					version: approval.version ?? 1,
				};
				approvals.push(normalized);
				approvalById.set(
					normalized.approvalRequestId,
					normalized,
				);
			}
			if (
				runs.some(
					(run) =>
						run.approvalRequestId !== undefined &&
						!approvalById.has(run.approvalRequestId),
				)
			) {
				return {
					ok: false as const,
					reason: "approval-invalid" as const,
					detail:
						"a Run projection references an ApprovalRequest that is not durably available",
				};
			}
			return {
				ok: true as const,
				snapshot: {
					header,
					runs,
					boundPlans,
					boundFragments,
					boundFragmentLinks,
					receipts,
					approvals,
					artifacts,
					nextCommitSeq,
					minAvailableCommitSeq: compaction.minAvailableCommitSeq,
				},
			};
		});
	} catch {
		return {
			ok: false,
			reason: "unavailable",
			detail: "control store could not be inspected consistently",
		};
	}
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
	ensureDir(projectControlRoot(root));
	ensureDir(projectJournalDir(root));
	ensureDir(projectProjectionsDir(root));
	ensureDir(projectBoundPlansDir(root));
	ensureDir(projectBoundFragmentsDir(root));
	ensureDir(projectBoundFragmentLinksDir(root));
	ensureDir(projectCommandsDir(root));
	ensureDir(projectReceiptsDir(root));
	ensureDir(projectApprovalsDir(root));
	ensureDir(projectArtifactMetadataDir(root));
	ensureDir(projectArtifactBlobsDir(root));

	const headerPath = projectHeaderPath(root);
	const headerLockPath = path.join(projectControlRoot(root), "header.lock");

	// Cross-process identity mint: lock → re-read → create-if-missing → write.
	const header = withExclusiveLockFile(headerLockPath, () => {
		const existing = readJsonFile<ControlStoreHeader>(headerPath);
		if (existing) {
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
				writeFileAtomic(headerPath, JSON.stringify(created, null, 2));
				return readJsonFile<ControlStoreHeader>(headerPath) ?? created;
			}
			const bindingUnchanged =
				existing.directoryBinding.path === decision.binding.path &&
				existing.directoryBinding.inode === decision.binding.inode &&
				existing.directoryBinding.dev === decision.binding.dev;
			if (decision.action === "keep" && bindingUnchanged) {
				return existing;
			}
			// Refresh changed inode evidence or persist an explicit path rebind.
			const refreshed: ControlStoreHeader = {
				...existing,
				directoryBinding: decision.binding,
				updatedAt: Date.now(),
			};
			writeFileAtomic(headerPath, JSON.stringify(refreshed, null, 2));
			return refreshed;
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
		writeFileAtomic(headerPath, JSON.stringify(created, null, 2));
		// Re-read after write in case another process won a rare race after unlock
		// (should not happen under lock; defensive).
		return readJsonFile<ControlStoreHeader>(headerPath) ?? created;
	});

	const seqPath = path.join(projectControlRoot(root), "commit-seq.json");
	const commitLockPath = path.join(projectControlRoot(root), "commit.lock");

	function readSeqNext(): number {
		return readJsonFile<{ next: number }>(seqPath)?.next ?? 1;
	}

	// Mutable local cache; identity fields never change after first create.
	let headerCache = header;

	function readRunFromDisk(runId: string): RunProjection | null {
		if (!isSafeId(runId)) return null;
		return readJsonFile<RunProjection>(
			path.join(projectProjectionsDir(root), `run-${runId}.json`),
		);
	}

	function boundPlanFilePath(boundPlanHash: string): string | null {
		const match = /^bp:([a-f0-9]{64})$/u.exec(boundPlanHash);
		return match
			? path.join(projectBoundPlansDir(root), `bp-${match[1]}.json`)
			: null;
	}

	function boundFragmentFilePath(
		boundFragmentHash: string,
	): string | null {
		const file = boundFragmentFileName(boundFragmentHash);
		return file
			? path.join(projectBoundFragmentsDir(root), file)
			: null;
	}

	function boundFragmentLinkFilePath(
		link: Pick<BoundFragmentLink, "linkId">,
	): string {
		return path.join(
			projectBoundFragmentLinksDir(root),
			boundFragmentLinkFileName(link),
		);
	}

	function artifactBlobPath(digest: string): string | null {
		const match = /^sha256:([a-f0-9]{64})$/u.exec(digest);
		return match
			? path.join(projectArtifactBlobsDir(root), match[1]!)
			: null;
	}

	function listArtifactRecords(): ArtifactRecord[] {
		const dir = projectArtifactMetadataDir(root);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.flatMap((file) => {
				const artifact = readJsonFile<ArtifactRecord>(
					path.join(dir, file),
				);
				return artifact ? [artifact] : [];
			});
	}

	function sameBoundPlanSemantics(left: BoundPlan, right: BoundPlan): boolean {
		const withoutCreatedAt = (plan: BoundPlan) => ({
			...plan,
			createdAt: 0,
		});
		return (
			stableStringify(withoutCreatedAt(left)) ===
			stableStringify(withoutCreatedAt(right))
		);
	}

	/**
	 * A semantic BoundPlan hash may be linked more than once at different times.
	 * The first durable object wins; later copies must match all hashed and
	 * execution-relevant fields, while `createdAt` remains first-link provenance.
	 */
	function persistBoundPlan(boundPlan: BoundPlan): boolean {
		const file = boundPlanFilePath(boundPlan.boundPlanHash);
		if (!file) throw new Error("invalid BoundPlan hash");
		const existing = readJsonFile<BoundPlan>(file);
		if (existing) {
			if (!sameBoundPlanSemantics(existing, boundPlan)) {
				throw new Error(
					`BoundPlan hash collision or semantic mismatch: ${boundPlan.boundPlanHash}`,
				);
			}
			return false;
		}
		writeFileAtomic(file, JSON.stringify(boundPlan, null, 2));
		return true;
	}

	function sameBoundFragmentSemantics(
		left: BoundFragment,
		right: BoundFragment,
	): boolean {
		const withoutCreatedAt = (fragment: BoundFragment) => ({
			...fragment,
			createdAt: 0,
		});
		return (
			stableStringify(withoutCreatedAt(left)) ===
			stableStringify(withoutCreatedAt(right))
		);
	}

	function persistBoundFragment(
		fragment: BoundFragment,
	): boolean {
		const file = boundFragmentFilePath(fragment.boundFragmentHash);
		if (!file) throw new Error("invalid BoundFragment hash");
		const existing = readJsonFile<BoundFragment>(file);
		if (existing) {
			if (!sameBoundFragmentSemantics(existing, fragment)) {
				throw new Error(
					`BoundFragment hash collision or semantic mismatch: ${fragment.boundFragmentHash}`,
				);
			}
			return false;
		}
		writeFileAtomic(file, JSON.stringify(fragment, null, 2));
		return true;
	}

	function persistBoundFragmentLink(
		link: BoundFragmentLink,
	): boolean {
		const file = boundFragmentLinkFilePath(link);
		const existing = readJsonFile<BoundFragmentLink>(file);
		if (existing) {
			if (
				stableStringify(existing) !== stableStringify(link)
			) {
				throw new Error(
					`BoundFragment link collision or provenance mismatch: ${link.runId}/${link.parentNodeInstanceId}`,
				);
			}
			return false;
		}
		writeFileAtomic(file, JSON.stringify(link, null, 2));
		return true;
	}

	/**
	 * Journal is authoritative: rebuild run projections / command indexes / receipt
	 * indexes from journal segments when projections are missing (half-commit recovery).
	 */
	function rebuildFromJournal(): {
		rebuiltRuns: number;
		rebuiltCommands: number;
		rebuiltReceipts: number;
		rebuiltBoundPlans: number;
		rebuiltBoundFragments: number;
		rebuiltBoundFragmentLinks: number;
	} {
		const dir = projectJournalDir(root);
		let rebuiltRuns = 0;
		let rebuiltCommands = 0;
		let rebuiltReceipts = 0;
		let rebuiltBoundPlans = 0;
		let rebuiltBoundFragments = 0;
		let rebuiltBoundFragmentLinks = 0;
		const latestCommands = new Map<
			string,
			CommandRecord
		>();
		const latestRuns = new Map<string, RunProjection>();
		const latestReceipts = new Map<string, Receipt>();
		const latestReceiptBindings = new Map<
			string,
			string
		>();
		if (!fs.existsSync(dir)) {
			return {
				rebuiltRuns,
				rebuiltCommands,
				rebuiltReceipts,
				rebuiltBoundPlans,
				rebuiltBoundFragments,
				rebuiltBoundFragmentLinks,
			};
		}
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
		for (const f of files) {
			const entry = readJsonFile<{
				commitSeqEnd?: number;
				command?: CommandRecord;
				run?: RunProjection;
				receipt?: Receipt;
				boundPlan?: BoundPlan;
				boundFragment?: BoundFragment;
				boundFragmentLink?: BoundFragmentLink;
				events?: ControlEvent[];
			}>(path.join(dir, f));
			if (!entry) continue; // corrupt segment: skip (fail-open recover other segments)
			if (entry.boundPlan && persistBoundPlan(entry.boundPlan)) {
				rebuiltBoundPlans += 1;
			}
			if (
				entry.boundFragment &&
				persistBoundFragment(entry.boundFragment)
			) {
				rebuiltBoundFragments += 1;
			}
			if (
				entry.boundFragmentLink &&
				persistBoundFragmentLink(entry.boundFragmentLink)
			) {
				rebuiltBoundFragmentLinks += 1;
			}
			if (entry.command && isSafeId(entry.command.commandId)) {
				latestCommands.set(
					entry.command.commandId,
					entry.command,
				);
			}
			if (entry.run && isSafeId(entry.run.runId)) {
				const segmentLastCommitSeq =
					Number.isSafeInteger(entry.commitSeqEnd) &&
					(entry.commitSeqEnd ?? 0) >= 1
						? entry.commitSeqEnd
						: entry.events
								?.map((event) => event.commitSeq)
								.filter(
									(commitSeq) =>
										Number.isSafeInteger(commitSeq) &&
										commitSeq >= 1,
								)
								.reduce<number | undefined>(
									(maximum, commitSeq) =>
										maximum === undefined ||
										commitSeq > maximum
											? commitSeq
											: maximum,
									undefined,
								);
				const recoveredRun: RunProjection =
					Number.isSafeInteger(
						entry.run.lastCommitSeq,
					) &&
					(entry.run.lastCommitSeq ?? 0) >= 1
						? entry.run
						: segmentLastCommitSeq !== undefined
							? {
									...entry.run,
									lastCommitSeq:
										segmentLastCommitSeq,
								}
							: entry.run;
				// Defer projection writes until every segment has been folded so an
				// already-current store is not rewritten through each historical
				// version on every open. Journal order remains authoritative.
				latestRuns.set(
					recoveredRun.runId,
					recoveredRun,
				);
			}
			if (entry.receipt && isSafeId(entry.receipt.receiptId)) {
				latestReceipts.set(
					entry.receipt.receiptId,
					entry.receipt,
				);
				if (isSafeId(entry.receipt.runId)) {
					latestReceiptBindings.set(
						entry.receipt.runId,
						entry.receipt.receiptId,
					);
				}
			}
		}
		for (const command of latestCommands.values()) {
			const recordPath = path.join(
				projectCommandsDir(root),
				`${command.commandId}.json`,
			);
			const bindingPath = path.join(
				projectCommandsDir(root),
				`by-cmd-${command.commandId}.json`,
			);
			const existing =
				readJsonFile<CommandRecord>(
					recordPath,
				);
			const expectedBinding =
				command.runId &&
				isSafeId(command.runId)
					? { runId: command.runId }
					: undefined;
			const existingBinding =
				readJsonFile<{ runId: string }>(
					bindingPath,
				);
			let changed =
				!existing ||
				stableStringify(existing) !==
					stableStringify(command);
			if (changed) {
				writeFileAtomic(
					recordPath,
					JSON.stringify(command, null, 2),
				);
			}
			if (
				expectedBinding &&
				(!existingBinding ||
					stableStringify(
						existingBinding,
					) !==
						stableStringify(
							expectedBinding,
						))
			) {
				writeFileAtomic(
					bindingPath,
					JSON.stringify(
						expectedBinding,
						null,
						2,
					),
				);
				changed = true;
			} else if (
				!expectedBinding &&
				fs.existsSync(bindingPath)
			) {
				fs.unlinkSync(bindingPath);
				changed = true;
			}
			if (changed) rebuiltCommands += 1;
		}
		for (const run of latestRuns.values()) {
			const file = path.join(
				projectProjectionsDir(root),
				`run-${run.runId}.json`,
			);
			const existing = readJsonFile<RunProjection>(file);
			if (
				existing &&
				stableStringify(existing) ===
					stableStringify(run)
			) {
				continue;
			}
			writeFileAtomic(file, JSON.stringify(run, null, 2));
			rebuiltRuns += 1;
		}
		const changedReceiptIds = new Set<string>();
		for (const receipt of latestReceipts.values()) {
			const recordPath = path.join(
				projectReceiptsDir(root),
				`${receipt.receiptId}.json`,
			);
			const existing = readJsonFile<Receipt>(
				recordPath,
			);
			const changed =
				!existing ||
				stableStringify(existing) !==
					stableStringify(receipt);
			if (changed) {
				writeFileAtomic(
					recordPath,
					JSON.stringify(receipt, null, 2),
				);
				changedReceiptIds.add(
					receipt.receiptId,
				);
			}
		}
		for (const [
			runId,
			receiptId,
		] of latestReceiptBindings) {
			const bindingPath = path.join(
				projectReceiptsDir(root),
				`by-run-${runId}.json`,
			);
			const expectedBinding = { receiptId };
			const existingBinding =
				readJsonFile<{ receiptId: string }>(
					bindingPath,
				);
			if (
				!existingBinding ||
				stableStringify(existingBinding) !==
					stableStringify(
						expectedBinding,
					)
			) {
				writeFileAtomic(
					bindingPath,
					JSON.stringify(
						expectedBinding,
						null,
						2,
					),
				);
				changedReceiptIds.add(receiptId);
			}
		}
		rebuiltReceipts = changedReceiptIds.size;
		return {
			rebuiltRuns,
			rebuiltCommands,
			rebuiltReceipts,
			rebuiltBoundPlans,
			rebuiltBoundFragments,
			rebuiltBoundFragmentLinks,
		};
	}

	let projectRunIndexCache: ProjectRunIndex | undefined;

	function currentProjectRunIndexUnlocked(): ProjectRunIndex {
		const nextCommitSeq = readSeqNext();
		if (
			projectRunIndexCache?.throughCommitSeq ===
				nextCommitSeq - 1 &&
			projectRunIndexCache.projectionCount ===
				runProjectionFileNames(root).length
		) {
			return projectRunIndexCache;
		}
		const persisted = readCurrentProjectRunIndex(
			root,
			headerCache,
			nextCommitSeq,
		);
		if (persisted) {
			projectRunIndexCache = persisted;
			return persisted;
		}
		const rebuilt =
			buildProjectRunIndexFromProjections(
				root,
				headerCache,
				nextCommitSeq,
			);
		if (!rebuilt) {
			throw new Error(
				"ControlStore Run projections cannot rebuild the project-local Run index",
			);
		}
		writeProjectRunIndex(root, rebuilt);
		projectRunIndexCache = rebuilt;
		return rebuilt;
	}

	function updateProjectRunIndexUnlocked(
		previous: ProjectRunIndex,
		run: RunProjection | undefined,
		throughCommitSeq: number,
	): void {
		const byRunId = new Map(
			previous.runs.map((candidate) => [
				candidate.runId,
				candidate,
			]),
		);
		if (run) byRunId.set(run.runId, run);
		const runs = [...byRunId.values()].sort(
			(left, right) =>
				right.updatedAt - left.updatedAt ||
				left.runId.localeCompare(
					right.runId,
					"en",
				),
		);
		const next: ProjectRunIndex = {
			schemaVersion: 1,
			throughCommitSeq,
			projectionCount: runs.length,
			runs,
		};
		writeProjectRunIndex(root, next);
		projectRunIndexCache = next;
	}

	function isApprovalRecoveryCandidate(
		run: RunProjection,
	): boolean {
		return (
			run.status === "running" &&
			(run.stage === "queued" ||
				run.stage === "executing") &&
			run.approvalRequestId !== undefined &&
			run.reservationId !== undefined &&
			run.receiptId === undefined
		);
	}

	function readApprovalRecoveryIndexUnlocked(
		expectedThroughCommitSeq: number,
	): ApprovalRecoveryIndex | null {
		const value = readJsonFile<Partial<ApprovalRecoveryIndex>>(
			projectApprovalRecoveryIndexPath(root),
		);
		if (
			value?.schemaVersion !== 1 ||
			value.throughCommitSeq !==
				expectedThroughCommitSeq ||
			!Array.isArray(value.runIds) ||
			!value.runIds.every(
				(runId) =>
					typeof runId === "string" &&
					isSafeId(runId),
			) ||
			new Set(value.runIds).size !==
				value.runIds.length
		) {
			return null;
		}
		return {
			schemaVersion: 1,
			throughCommitSeq:
				value.throughCommitSeq,
			runIds: [...value.runIds].sort((left, right) =>
				left.localeCompare(right, "en"),
			),
		};
	}

	function rebuildApprovalRecoveryIndexUnlocked(
		throughCommitSeq = readSeqNext() - 1,
	): ApprovalRecoveryIndex {
		const runIds = currentProjectRunIndexUnlocked()
			.runs.filter(isApprovalRecoveryCandidate)
			.map((run) => run.runId)
			.sort((left, right) =>
				left.localeCompare(right, "en"),
			);
		const index: ApprovalRecoveryIndex = {
			schemaVersion: 1,
			throughCommitSeq,
			runIds: [...new Set(runIds)],
		};
		writeFileAtomic(
			projectApprovalRecoveryIndexPath(root),
			JSON.stringify(index, null, 2),
		);
		return index;
	}

	function currentApprovalRecoveryIndexUnlocked(): ApprovalRecoveryIndex {
		const throughCommitSeq = readSeqNext() - 1;
		return (
			readApprovalRecoveryIndexUnlocked(
				throughCommitSeq,
			) ??
			rebuildApprovalRecoveryIndexUnlocked(
				throughCommitSeq,
			)
		);
	}

	function updateApprovalRecoveryIndexUnlocked(
		run: RunProjection | undefined,
		previousCommitSeq: number,
		throughCommitSeq: number,
	): void {
		const previous =
			readApprovalRecoveryIndexUnlocked(
				previousCommitSeq,
			);
		if (!previous) {
			rebuildApprovalRecoveryIndexUnlocked(
				throughCommitSeq,
			);
			return;
		}
		const runIds = new Set(previous.runIds);
		if (run) {
			if (isApprovalRecoveryCandidate(run)) {
				runIds.add(run.runId);
			} else {
				runIds.delete(run.runId);
			}
		}
		const next: ApprovalRecoveryIndex = {
			schemaVersion: 1,
			throughCommitSeq,
			runIds: [...runIds].sort((left, right) =>
				left.localeCompare(right, "en"),
			),
		};
		writeFileAtomic(
			projectApprovalRecoveryIndexPath(root),
			JSON.stringify(next, null, 2),
		);
	}

	function recoverAndRefreshIndexesUnlocked(): ReturnType<
		typeof rebuildFromJournal
	> {
		const recovery = rebuildFromJournal();
		if (recovery.rebuiltRuns > 0) {
			projectRunIndexCache = undefined;
			const rebuilt =
				buildProjectRunIndexFromProjections(
					root,
					headerCache,
					readSeqNext(),
				);
			if (!rebuilt) {
				throw new Error(
					"Recovered Run projections cannot rebuild the project-local Run index",
				);
			}
			writeProjectRunIndex(root, rebuilt);
			projectRunIndexCache = rebuilt;
			rebuildApprovalRecoveryIndexUnlocked(
				rebuilt.throughCommitSeq,
			);
		} else {
			currentProjectRunIndexUnlocked();
			currentApprovalRecoveryIndexUnlocked();
		}
		return recovery;
	}

	// Recover half-commits before serving reads. This must share the commit lock:
	// an unlocked open-time rebuild can replay an older projection over a newer
	// concurrent CAS commit and roll runVersion backwards, admitting two winners.
	withExclusiveLockFile(commitLockPath, () => {
		recoverAndRefreshIndexesUnlocked();
	});

	const streamSeqPath = path.join(projectControlRoot(root), "stream-seq.json");

	function readStreamSeqMap(): Record<string, number> {
		return readJsonFile<Record<string, number>>(streamSeqPath) ?? {};
	}

	/** Caller MUST hold commitLockPath. */
	function commitUnlocked(batch: CommitBatch): {
		commitSeqStart: number;
		commitSeqEnd: number;
		committedAt: number;
	} {
		if (batch.command) {
			assertSafeId(batch.command.commandId, "commandId");
			if (batch.command.runId) assertSafeId(batch.command.runId, "runId");
		}
		if (batch.run) assertSafeId(batch.run.runId, "runId");
		if (batch.receipt) {
			assertSafeId(batch.receipt.receiptId, "receiptId");
			assertSafeId(batch.receipt.runId, "runId");
		}
		if (batch.boundPlan) {
			if (
				batch.run &&
				batch.run.boundPlanHash !== batch.boundPlan.boundPlanHash
			) {
				throw new Error("Run and BoundPlan hashes do not match");
			}
			// Validate immutability before publishing the journal entry.
			const file = boundPlanFilePath(batch.boundPlan.boundPlanHash);
			if (!file) throw new Error("invalid BoundPlan hash");
			const existing = readJsonFile<BoundPlan>(file);
			if (
				existing &&
				!sameBoundPlanSemantics(existing, batch.boundPlan)
			) {
				throw new Error(
					`BoundPlan hash collision or semantic mismatch: ${batch.boundPlan.boundPlanHash}`,
				);
			}
		}
		if (
			(batch.boundFragment === undefined) !==
			(batch.boundFragmentLink === undefined)
		) {
			throw new Error(
				"BoundFragment and BoundFragmentLink must be committed together",
			);
		}
		if (batch.boundFragment && batch.boundFragmentLink) {
			if (!batch.run) {
				throw new Error(
					"BoundFragment link requires a Run projection",
				);
			}
			if (
				batch.boundFragmentLink.runId !== batch.run.runId ||
				batch.boundFragmentLink.boundFragmentHash !==
					batch.boundFragment.boundFragmentHash ||
				batch.boundFragment.parentBoundPlanHash !==
					batch.run.boundPlanHash
			) {
				throw new Error(
					"BoundFragment link does not match its Run or parent BoundPlan",
				);
			}
			if (
				!isSafeId(
					batch.boundFragmentLink.parentNodeInstanceId,
				) ||
				!isSafeId(batch.boundFragmentLink.linkId) ||
				!isSafeId(batch.boundFragmentLink.originPhaseId) ||
				(batch.boundFragmentLink.causationId !== undefined &&
					!isSafeId(
						batch.boundFragmentLink.causationId,
					))
			) {
				throw new Error(
					"BoundFragment link contains an invalid provenance id",
				);
			}
			if (
				!boundFragmentFileName(
					batch.boundFragment.boundFragmentHash,
				) ||
				!/^es:[a-f0-9]{64}$/u.test(
					batch.boundFragment.executionSemanticHash,
				) ||
				!Number.isSafeInteger(
					batch.boundFragment.createdAt,
				) ||
				batch.boundFragment.createdAt < 0 ||
				![
					"nested-flow",
					"graft-promote",
				].includes(batch.boundFragmentLink.linkKind) ||
				!Number.isSafeInteger(
					batch.boundFragmentLink.dynamicNodeCount,
				) ||
				batch.boundFragmentLink.dynamicNodeCount < 0 ||
				!Number.isSafeInteger(
					batch.boundFragmentLink.staticNodeCount,
				) ||
				batch.boundFragmentLink.staticNodeCount < 0 ||
				!Number.isSafeInteger(
					batch.boundFragmentLink.createdAt,
				) ||
				batch.boundFragmentLink.createdAt < 0
			) {
				throw new Error(
					"BoundFragment body or link metadata is invalid",
				);
			}
			const existingFragment = readJsonFile<BoundFragment>(
				boundFragmentFilePath(
					batch.boundFragment.boundFragmentHash,
				)!,
			);
			if (
				existingFragment &&
				!sameBoundFragmentSemantics(
					existingFragment,
					batch.boundFragment,
				)
			) {
				throw new Error(
					`BoundFragment hash collision or semantic mismatch: ${batch.boundFragment.boundFragmentHash}`,
				);
			}
			if (
				readJsonFile<BoundFragmentLink>(
					boundFragmentLinkFilePath(
						batch.boundFragmentLink,
					),
				)
			) {
				throw new Error(
					`BoundFragment link already exists: ${batch.boundFragmentLink.runId}/${batch.boundFragmentLink.parentNodeInstanceId}`,
				);
			}
		}
		const events = batch.events;
		let next = readSeqNext();
		if (
			events.length === 0 &&
			!batch.command &&
			!batch.run &&
			!batch.receipt &&
			!batch.boundPlan &&
			!batch.boundFragment
		) {
			return {
				commitSeqStart: next,
				commitSeqEnd: next - 1,
				committedAt: Date.now(),
			};
		}
		const start = next;
		const previousProjectRunIndex =
			currentProjectRunIndexUnlocked();
		let seq = start;
		// streamSeq monotonic + unique per streamId within the domain
		const streamMap = readStreamSeqMap();
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
		if (stamped.length === 0) {
			seq += 1;
		}
		const end = seq - 1;
		next = seq;
		writeFileAtomic(streamSeqPath, JSON.stringify(streamMap, null, 2));

		const command: CommandRecord | undefined = batch.command
			? {
					...batch.command,
					firstCommitSeq: batch.command.firstCommitSeq || start,
					lastCommitSeq: end,
					projectId: headerCache.projectId,
					controlDomainId: headerCache.controlDomainId,
				}
			: undefined;

		const committedRun: RunProjection | undefined = batch.run
			? {
					...batch.run,
					projectId: headerCache.projectId,
					controlDomainId: headerCache.controlDomainId,
					lastCommitSeq: end,
				}
			: undefined;
		const committedBoundFragmentLink:
			| BoundFragmentLink
			| undefined = batch.boundFragmentLink
			? (() => {
					const linkedEvent = stamped.find(
						(event) =>
							event.payload.type ===
								"BoundFragmentLinked" &&
							event.payload.runId ===
								batch.boundFragmentLink!.runId &&
							event.payload.boundFragmentHash ===
								batch.boundFragmentLink!
									.boundFragmentHash,
					);
					if (!linkedEvent) {
						throw new Error(
							"BoundFragment commit requires a matching BoundFragmentLinked event",
						);
					}
					return {
						...batch.boundFragmentLink!,
						projectId: headerCache.projectId,
						controlDomainId:
							headerCache.controlDomainId,
						createdAtCommitSeq:
							linkedEvent.commitSeq,
					};
				})()
			: undefined;
		const committedAt = Date.now();
		const journalEntry = {
			commitSeqStart: start,
			commitSeqEnd: end,
			command,
			events: stamped,
			run: committedRun,
			receipt: batch.receipt,
			boundPlan: batch.boundPlan,
			boundFragment: batch.boundFragment,
			boundFragmentLink: committedBoundFragmentLink,
			recordedAt: committedAt,
		};
		const journalFile = path.join(
			projectJournalDir(root),
			`${String(start).padStart(12, "0")}-${String(end).padStart(12, "0")}.json`,
		);
		if (fs.existsSync(journalFile)) {
			throw new Error(
				`journal segment collision at commitSeq ${start}-${end} — commit lock / seq broken`,
			);
		}
		writeFileAtomic(journalFile, JSON.stringify(journalEntry, null, 2));
		writeFileAtomic(seqPath, JSON.stringify({ next }, null, 2));

		if (batch.boundPlan) persistBoundPlan(batch.boundPlan);
		if (batch.boundFragment) {
			persistBoundFragment(batch.boundFragment);
		}
		if (committedBoundFragmentLink) {
			persistBoundFragmentLink(committedBoundFragmentLink);
		}
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
		if (committedRun) {
			writeFileAtomic(
				path.join(
					projectProjectionsDir(root),
					`run-${committedRun.runId}.json`,
				),
				JSON.stringify(committedRun, null, 2),
			);
		}
		if (batch.receipt) {
			const receipt = {
				...batch.receipt,
				projectId: headerCache.projectId,
				controlDomainId: headerCache.controlDomainId,
			};
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
		updateProjectRunIndexUnlocked(
			previousProjectRunIndex,
			committedRun,
			end,
		);
		updateApprovalRecoveryIndexUnlocked(
			committedRun,
			start - 1,
			end,
		);

		return {
			commitSeqStart: start,
			commitSeqEnd: end,
			committedAt,
		};
	}

	const store: ProjectControlStore = {
		projectRoot: root,
		get header() {
			return headerCache;
		},

		nextCommitSeq() {
			// Always durable view — never a stale in-memory counter.
			return readSeqNext();
		},

		commit(batch: CommitBatch) {
			return withExclusiveLockFile(commitLockPath, () => commitUnlocked(batch));
		},

		compareAndCommit(opts: CompareAndCommitOpts): CompareAndCommitResult {
			return withExclusiveLockFile(commitLockPath, () => {
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
				const existingRcpt = readJsonFile<{ receiptId: string }>(
					path.join(projectReceiptsDir(root), `by-run-${opts.runId}.json`),
				);
				if (
					existingRcpt?.receiptId ||
					current.receiptId ||
					(current.stage === "terminal" &&
						!opts.allowTerminalCommandSettlement)
				) {
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
					run: readRunFromDisk(opts.runId) ?? built.run,
					receipt: built.receipt,
					commitSeqStart: ranges.commitSeqStart,
					commitSeqEnd: ranges.commitSeqEnd,
				};
			});
		},

		recoverFromJournal() {
			return withExclusiveLockFile(
				commitLockPath,
				() =>
					recoverAndRefreshIndexesUnlocked(),
			);
		},

		claimCommand(input) {
			assertSafeId(input.commandId, "commandId");
			assertSafeId(input.runId, "runId");
			return withExclusiveLockFile(commitLockPath, () => {
				const existing = readJsonFile<CommandRecord>(
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
				writeFileAtomic(
					path.join(projectCommandsDir(root), `${input.commandId}.json`),
					JSON.stringify(cmd, null, 2),
				);
				writeFileAtomic(
					path.join(projectCommandsDir(root), `by-cmd-${input.commandId}.json`),
					JSON.stringify({ runId: input.runId }, null, 2),
				);
				return { kind: "claimed" as const };
			});
		},

		getRun(runId: string) {
			return readRunFromDisk(runId);
		},

		listRuns() {
			return withExclusiveLockFile(
				commitLockPath,
				() => [
					...currentProjectRunIndexUnlocked()
						.runs,
				],
			);
		},

		listApprovalRecoveryRuns() {
			return withExclusiveLockFile(
				commitLockPath,
				() => {
					let index =
						currentApprovalRecoveryIndexUnlocked();
					let runs = index.runIds.flatMap(
						(runId) => {
							const run =
								readRunFromDisk(runId);
							return run &&
								isApprovalRecoveryCandidate(run)
								? [run]
								: [];
						},
					);
					if (runs.length !== index.runIds.length) {
						index =
							rebuildApprovalRecoveryIndexUnlocked();
						runs = index.runIds.flatMap(
							(runId) => {
								const run =
									readRunFromDisk(
										runId,
									);
								return run &&
									isApprovalRecoveryCandidate(
										run,
									)
									? [run]
									: [];
							},
						);
					}
					return runs.sort(
						(left, right) =>
							left.updatedAt -
								right.updatedAt ||
							left.runId.localeCompare(
								right.runId,
								"en",
							),
					);
				},
			);
		},

		getBoundPlan(boundPlanHash: string) {
			const file = boundPlanFilePath(boundPlanHash);
			return file ? readJsonFile<BoundPlan>(file) : null;
		},

		getBoundFragment(boundFragmentHash: string) {
			const file = boundFragmentFilePath(boundFragmentHash);
			return file ? readJsonFile<BoundFragment>(file) : null;
		},

		listBoundFragmentsForRun(runId: string) {
			if (!isSafeId(runId)) return [];
			const dir = projectBoundFragmentLinksDir(root);
			if (!fs.existsSync(dir)) return [];
			return fs
				.readdirSync(dir)
				.filter((file) => file.endsWith(".json"))
				.sort()
				.flatMap((file) => {
					const link = readJsonFile<BoundFragmentLink>(
						path.join(dir, file),
					);
					if (!link || link.runId !== runId) return [];
					const fragment = store.getBoundFragment(
						link.boundFragmentHash,
					);
					return fragment ? [{ fragment, link }] : [];
				})
				.sort(
					(left, right) =>
						left.link.createdAtCommitSeq -
							right.link.createdAtCommitSeq ||
						left.fragment.boundFragmentHash.localeCompare(
							right.fragment.boundFragmentHash,
							"en",
						),
				);
		},

		getReceipt(receiptId: string) {
			if (!isSafeId(receiptId)) return null;
			return readJsonFile<Receipt>(path.join(projectReceiptsDir(root), `${receiptId}.json`));
		},

		getReceiptForRun(runId: string) {
			if (!isSafeId(runId)) return null;
			const idx = readJsonFile<{ receiptId: string }>(
				path.join(projectReceiptsDir(root), `by-run-${runId}.json`),
			);
			if (!idx) return null;
			return store.getReceipt(idx.receiptId);
		},

		getCommand(commandId: string) {
			if (!isSafeId(commandId)) return null;
			return readJsonFile<CommandRecord>(
				path.join(projectCommandsDir(root), `${commandId}.json`),
			);
		},

		putArtifact(input) {
			const bytes = Buffer.from(input.bytes);
			if (bytes.byteLength > 100 * 1024 * 1024) {
				throw new RangeError(
					"artifact exceeds the 100 MiB browser/control-store limit",
				);
			}
			if (
				!input.mediaType ||
				input.mediaType.length > 512 ||
				/[\r\n\u0000]/u.test(input.mediaType)
			) {
				throw new TypeError("invalid artifact mediaType");
			}
			assertSafeId(input.role, "artifact role");
			if (input.runId) assertSafeId(input.runId, "runId");
			if (input.receiptId) {
				assertSafeId(input.receiptId, "receiptId");
			}
			const artifactId =
				input.artifactId ?? newId("art");
			assertSafeId(artifactId, "artifactId");
			const digest = `sha256:${sha256Hex(bytes)}`;
			const fileName = input.fileName
				?.normalize("NFC")
				.replace(/[\p{Cc}\p{Cf}\\/]+/gu, " ")
				.replace(/\s+/gu, " ")
				.trim()
				.slice(0, 1_024);
			return withExclusiveLockFile(commitLockPath, () => {
				if (
					input.runId &&
					!readRunFromDisk(input.runId)
				) {
					throw new Error(
						`artifact Run not found: ${input.runId}`,
					);
				}
				const metadataPath = path.join(
					projectArtifactMetadataDir(root),
					`${artifactId}.json`,
				);
				const existing =
					readJsonFile<ArtifactRecord>(metadataPath);
				if (existing) {
					const candidate = {
						...existing,
						createdAt: 0,
					};
					const intended = {
						artifactId,
						projectId: headerCache.projectId,
						controlDomainId:
							headerCache.controlDomainId,
						digest,
						size: bytes.byteLength,
						mediaType: input.mediaType,
						role: input.role,
						storageClass:
							"control-store" as const,
						redactionClass:
							input.redactionClass,
						...(input.runId
							? { runId: input.runId }
							: {}),
						...(input.receiptId
							? {
									receiptId:
										input.receiptId,
								}
							: {}),
						...(fileName ? { fileName } : {}),
						createdAt: 0,
					};
					if (
						stableStringify(candidate) !==
						stableStringify(intended)
					) {
						throw new Error(
							`artifactId conflict: ${artifactId}`,
						);
					}
					return existing;
				}
				const blobPath = artifactBlobPath(digest);
				if (!blobPath) {
					throw new Error(
						"internal artifact digest is invalid",
					);
				}
				if (fs.existsSync(blobPath)) {
					const existingBytes =
						fs.readFileSync(blobPath);
					if (
						existingBytes.byteLength !==
							bytes.byteLength ||
						sha256Hex(existingBytes) !==
							digest.slice("sha256:".length)
					) {
						throw new Error(
							"content-addressed artifact blob mismatch",
						);
					}
				} else {
					writeFileAtomic(blobPath, bytes);
				}
				const artifact: ArtifactRecord = {
					artifactId,
					projectId: headerCache.projectId,
					controlDomainId:
						headerCache.controlDomainId,
					digest,
					size: bytes.byteLength,
					mediaType: input.mediaType,
					role: input.role,
					storageClass: "control-store",
					redactionClass: input.redactionClass,
					...(input.runId
						? { runId: input.runId }
						: {}),
					...(input.receiptId
						? { receiptId: input.receiptId }
						: {}),
					...(fileName ? { fileName } : {}),
					createdAt: Date.now(),
				};
				writeFileAtomic(
					metadataPath,
					JSON.stringify(artifact, null, 2),
				);
				return artifact;
			});
		},

		getArtifact(artifactId) {
			if (!isSafeId(artifactId)) return null;
			return readJsonFile<ArtifactRecord>(
				path.join(
					projectArtifactMetadataDir(root),
					`${artifactId}.json`,
				),
			);
		},

		listArtifactsForRun(runId) {
			if (!isSafeId(runId)) return [];
			return listArtifactRecords()
				.filter(
					(artifact) => artifact.runId === runId,
				)
				.sort(
					(left, right) =>
						left.role.localeCompare(
							right.role,
							"en",
						) ||
						left.digest.localeCompare(
							right.digest,
							"en",
						) ||
						left.artifactId.localeCompare(
							right.artifactId,
							"en",
						),
				);
		},

		listArtifactsByDigest(digest) {
			if (!artifactBlobPath(digest)) return [];
			return listArtifactRecords()
				.filter(
					(artifact) => artifact.digest === digest,
				)
				.sort((left, right) =>
					left.artifactId.localeCompare(
						right.artifactId,
						"en",
					),
				);
		},

		readArtifactBytes(digest) {
			const blobPath = artifactBlobPath(digest);
			if (!blobPath || !fs.existsSync(blobPath)) return null;
			const bytes = fs.readFileSync(blobPath);
			if (
				sha256Hex(bytes) !==
				digest.slice("sha256:".length)
			) {
				return null;
			}
			return bytes;
		},

		getRunIdForCommand(commandId: string) {
			if (!isSafeId(commandId)) return null;
			const idx = readJsonFile<{ runId: string }>(
				path.join(projectCommandsDir(root), `by-cmd-${commandId}.json`),
			);
			if (idx?.runId) return idx.runId;
			const cmd = store.getCommand(commandId);
			return cmd?.runId ?? null;
		},

		readEvents(startCommitSeq: number, endCommitSeq: number) {
			const dir = projectJournalDir(root);
			if (!fs.existsSync(dir)) return [];
			const events: ControlEvent[] = [];
			for (const f of fs.readdirSync(dir).sort()) {
				if (!f.endsWith(".json")) continue;
				const entry = readJsonFile<{
					commitSeqStart: number;
					commitSeqEnd: number;
					events: ControlEvent[];
				}>(path.join(dir, f));
				if (!entry) continue;
				if (entry.commitSeqEnd < startCommitSeq || entry.commitSeqStart > endCommitSeq) continue;
				for (const ev of entry.events) {
					if (ev.commitSeq >= startCommitSeq && ev.commitSeq <= endCommitSeq) {
						events.push(ev);
					}
				}
			}
			return events.sort((a, b) => a.commitSeq - b.commitSeq);
		},
	};

	return store;
}
