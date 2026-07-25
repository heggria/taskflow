/**
 * Authoritative server-side read adapters for the first P17 handler slice.
 *
 * This module may use ControlHost/Store APIs and node-backed persistence. It is
 * deliberately separate from browser-safe schemas, clients, and projections.
 */
import * as path from "node:path";
import type { Static } from "typebox";
import { loadApprovalForRun } from "./approval.ts";
import { loadCompactionState } from "./compaction.ts";
import { sha256Hex, stableStringify } from "./hash.ts";
import { compilePolicy } from "./policy.ts";
import {
	CAPACITY_OCCUPYING_STATES,
	type ArtifactRecord,
	type ControlError,
	type RunProjection,
} from "./types.ts";
import type { ControlHost } from "./control-host.ts";
import {
	inspectProjectControlStore,
	inspectProjectControlEvents,
	type InspectProjectControlStoreResult,
	type ProjectControlReadSnapshot,
} from "./store/project-store.ts";
import type { RegistryEntry } from "./store/registry.ts";
import type {
	WebAvailableAction,
	WebCommandKind,
	WebContentMessage,
	WebSourceObservation,
} from "./web-presentation-schema.ts";
import { WEB_CONTENT_CATALOG_VERSION } from "./web-presentation-schema.ts";
import {
	projectTaskPresentation,
	summarizeTaskPresentation,
} from "./web-presentation-server.ts";
import {
	buildBoundedWebPage,
	strictlyAfterKeyset,
} from "./web-pagination.ts";
import type { WebCursorCodec } from "./web-cursor.ts";
import {
	WEB_ENDPOINTS,
	WEB_GRAPH_DEFAULT_PAGE_LIMIT,
	WEB_GRAPH_MAX_EDGES_PER_PAGE,
	WEB_GRAPH_MAX_PAGE_LIMIT,
	WEB_STATUS_SORT_RANK,
	type WebHandlerMap,
	type WebHandlerContext,
	type WebPageRequest,
	type WebRunListQuery,
	type WebTimelineQuery,
	WebApprovalDetailSchema,
	WebApprovalPageSchema,
	WebAttentionPageSchema,
	WebArtifactPageSchema,
	WebAttemptPageSchema,
	WebBoundFragmentPageSchema,
	WebCoordinatorSummarySchema,
	WebNodeDetailSchema,
	WebOverviewViewSchema,
	WebReceiptViewSchema,
	WebReservationDetailSchema,
	WebProjectDetailSchema,
	WebProjectPageSchema,
	WebPolicyExplanationSchema,
	WebRunDetailSchema,
	WebRunGraphViewSchema,
	WebRunPageSchema,
	WebTimelineEventPageSchema,
	WebWhyStaleViewSchema,
	type WebEndpointId,
} from "./web-protocol.ts";

type WebOverviewView = Static<typeof WebOverviewViewSchema>;
type WebCoordinatorSummary = Static<typeof WebCoordinatorSummarySchema>;
type WebReservationDetail = Static<typeof WebReservationDetailSchema>;
type WebProjectDetail = Static<typeof WebProjectDetailSchema>;
type WebProjectPage = Static<typeof WebProjectPageSchema>;
type WebRunPage = Static<typeof WebRunPageSchema>;
type WebRunDetail = Static<typeof WebRunDetailSchema>;
type WebBoundFragmentPage = Static<typeof WebBoundFragmentPageSchema>;
type WebRunGraphView = Static<typeof WebRunGraphViewSchema>;
type WebTimelineEventPage = Static<typeof WebTimelineEventPageSchema>;
type WebNodeDetail = Static<typeof WebNodeDetailSchema>;
type WebAttemptPage = Static<typeof WebAttemptPageSchema>;
type WebArtifactPage = Static<typeof WebArtifactPageSchema>;
type WebReceiptView = Static<typeof WebReceiptViewSchema>;
type WebWhyStaleView = Static<typeof WebWhyStaleViewSchema>;
type WebApprovalPage = Static<typeof WebApprovalPageSchema>;
type WebApprovalDetail = Static<typeof WebApprovalDetailSchema>;
type WebAttentionPage = Static<typeof WebAttentionPageSchema>;
type WebPolicyExplanation = Static<typeof WebPolicyExplanationSchema>;
type WebGraphQuery = Static<
	(typeof WEB_ENDPOINTS)["runGraph"]["querySchema"]
>;
type WebFragmentListQuery = Static<
	(typeof WEB_ENDPOINTS)["runFragments"]["querySchema"]
>;
type WebAttemptListQuery = Static<
	(typeof WEB_ENDPOINTS)["nodeAttempts"]["querySchema"]
>;
type WebArtifactListQuery = Static<
	(typeof WEB_ENDPOINTS)["runArtifacts"]["querySchema"]
>;
type WebReceiptQuery = Static<
	(typeof WEB_ENDPOINTS)["runReceipt"]["querySchema"]
>;
type WebWhyStaleQuery = Static<
	(typeof WEB_ENDPOINTS)["runWhyStale"]["querySchema"]
>;
type WebApprovalListQuery = Static<
	(typeof WEB_ENDPOINTS)["approvals"]["querySchema"]
>;
type WebAttentionQuery = Static<
	(typeof WEB_ENDPOINTS)["attention"]["querySchema"]
>;
type WebPolicyExplanationQuery = Static<
	(typeof WEB_ENDPOINTS)["policyExplanation"]["querySchema"]
>;

export class WebReadServiceError extends Error {
	readonly controlError: ControlError;

	constructor(controlError: ControlError) {
		super(controlError.message);
		this.name = "WebReadServiceError";
		this.controlError = controlError;
	}
}

export type WebReadServiceOptions = {
	readonly now?: () => number;
	readonly cursorCodec?: WebCursorCodec;
	/**
	 * Reuse one immutable, honestly timestamped aggregate snapshot across a
	 * short burst of browser reads (for example Home overview/runs/approvals).
	 * Zero keeps the service fully uncached for deterministic unit fixtures.
	 */
	readonly snapshotCacheMs?: number;
	/** Resolve the exact mounted mutation authority for a projected project. */
	readonly resolveHost?: (
		projectId: string,
		controlDomainId: string,
	) => ControlHost | null;
	/**
	 * Durable command kinds implemented by the packaged backend.
	 * Resource actions are a server capability projection, not a UI guess.
	 */
	readonly supportedCommands?: readonly WebCommandKind[];
};

function contentMessage(
	key: WebContentMessage["key"],
): WebContentMessage {
	return {
		catalogVersion: WEB_CONTENT_CATALOG_VERSION,
		key,
		args: [],
	};
}

export function projectWebArtifactRef(
	artifact: ArtifactRecord,
	receiptId?: string,
) {
	const disclosure =
		artifact.redactionClass === "secret"
			? {
					access: "blocked" as const,
					headline: contentMessage(
						"artifact.secret.headline",
					),
					detail: contentMessage(
						"artifact.secret.detail",
					),
				}
			: artifact.redactionClass === "sensitive"
				? {
						access:
							"acknowledgement-required" as const,
						question: contentMessage(
							"artifact.sensitive.question",
						),
						impact: contentMessage(
							"artifact.sensitive.impact",
						),
						confirm: contentMessage(
							"artifact.sensitive.confirm",
						),
						decline: contentMessage(
							"artifact.sensitive.decline",
						),
					}
				: {
						access: "direct" as const,
						action: contentMessage(
							"artifact.download.action",
						),
					};
	return {
		artifactId: artifact.artifactId,
		role: artifact.role,
		digest: artifact.digest,
		size: artifact.size,
		mediaType: artifact.mediaType,
		storageClass: artifact.storageClass,
		redactionClass: artifact.redactionClass,
		...(receiptId ? { receiptId } : {}),
		integrity: "ok" as const,
		disclosure,
	};
}

type InspectedProject = {
	entry: RegistryEntry;
	result: InspectProjectControlStoreResult;
};

type ReadContext = {
	observedAt: number;
	projects: InspectedProject[];
	sourceObservation: WebSourceObservation;
};

type WatermarkProbe =
	| {
			readonly projectId: string;
			readonly controlDomainId: string;
			readonly nextCommitSeq: number;
			readonly minAvailableCommitSeq: number;
	  }
	| {
			readonly projectId: string;
			readonly controlDomainId: string;
			readonly unavailable: true;
	  };

function countBy<T extends string>(
	values: readonly T[],
	keys: readonly T[],
): Record<T, number> {
	return Object.fromEntries(
		keys.map((key) => [key, values.filter((value) => value === key).length]),
	) as Record<T, number>;
}

function successfulSnapshots(
	projects: readonly InspectedProject[],
): ProjectControlReadSnapshot[] {
	return projects.flatMap((project) =>
		project.result.ok ? [project.result.snapshot] : [],
	);
}

function allRuns(projects: readonly InspectedProject[]): RunProjection[] {
	return successfulSnapshots(projects).flatMap((snapshot) => snapshot.runs);
}

const RUN_STATUSES = [
	"running",
	"completed",
	"failed",
	"paused",
	"blocked",
	"cancelled",
	"unknown",
] as const;
const RUN_STAGES = [
	"received",
	"compiled",
	"linked",
	"queued",
	"admitted",
	"executing",
	"parked",
	"reconciling",
	"terminal",
] as const;

export interface WebReadService {
	readOverview(): WebOverviewView;
	readCoordinator(): WebCoordinatorSummary;
	readReservationDetail(reservationId: string): WebReservationDetail;
	readProjects(
		query: WebPageRequest,
		requestContext: WebHandlerContext,
	): WebProjectPage;
	readProjectDetail(
		projectId: string,
		controlDomainId: string,
		requestContext: WebHandlerContext,
	): WebProjectDetail;
	readRuns(
		query: WebRunListQuery,
		requestContext: WebHandlerContext,
	): WebRunPage;
	readRunDetail(
		projectId: string,
		controlDomainId: string,
		runId: string,
		requestContext: WebHandlerContext,
	): WebRunDetail;
	readRunFragments(
		projectId: string,
		controlDomainId: string,
		runId: string,
		query: WebFragmentListQuery,
		requestContext: WebHandlerContext,
	): WebBoundFragmentPage;
	readRunGraph(
		projectId: string,
		controlDomainId: string,
		runId: string,
		query: WebGraphQuery,
		requestContext: WebHandlerContext,
	): WebRunGraphView;
	readRunTimeline(
		projectId: string,
		controlDomainId: string,
		runId: string,
		query: WebTimelineQuery,
		requestContext: WebHandlerContext,
	): WebTimelineEventPage;
	readNodeDetail(
		projectId: string,
		controlDomainId: string,
		runId: string,
		nodeInstanceId: string,
		requestContext: WebHandlerContext,
	): WebNodeDetail;
	readNodeAttempts(
		projectId: string,
		controlDomainId: string,
		runId: string,
		nodeInstanceId: string,
		query: WebAttemptListQuery,
		requestContext: WebHandlerContext,
	): WebAttemptPage;
	readRunArtifacts(
		projectId: string,
		controlDomainId: string,
		runId: string,
		query: WebArtifactListQuery,
		requestContext: WebHandlerContext,
	): WebArtifactPage;
	readRunReceipt(
		projectId: string,
		controlDomainId: string,
		runId: string,
		query: WebReceiptQuery,
		requestContext: WebHandlerContext,
	): WebReceiptView;
	readRunWhyStale(
		projectId: string,
		controlDomainId: string,
		runId: string,
		query: WebWhyStaleQuery,
		requestContext: WebHandlerContext,
	): WebWhyStaleView;
	readApprovals(
		query: WebApprovalListQuery,
		requestContext: WebHandlerContext,
	): WebApprovalPage;
	readApprovalDetail(
		projectId: string,
		controlDomainId: string,
		runId: string,
		approvalRequestId: string,
		requestContext: WebHandlerContext,
	): WebApprovalDetail;
	readAttention(
		query: WebAttentionQuery,
		requestContext: WebHandlerContext,
	): WebAttentionPage;
	readPolicyExplanation(
		query: WebPolicyExplanationQuery,
		requestContext: WebHandlerContext,
	): WebPolicyExplanation;
}
export type InitialWebReadService = WebReadService;

export type WebReadHandlerMap = Pick<
	WebHandlerMap,
	| "overview"
	| "projects"
	| "projectDetail"
	| "coordinator"
	| "reservationDetail"
	| "runs"
	| "runDetail"
	| "runFragments"
	| "runGraph"
	| "runTimeline"
	| "nodeDetail"
	| "nodeAttempts"
	| "runArtifacts"
	| "runReceipt"
	| "runWhyStale"
	| "approvals"
	| "approvalDetail"
	| "attention"
	| "policyExplanation"
>;
export type InitialWebReadHandlerMap = WebReadHandlerMap;

/**
 * Honest implementation coverage for the current authoritative handler slice.
 *
 * Generated routes exist for all P17 endpoints, but only these ids currently
 * have behavior backed by live ControlHost/ControlStore authority.
 */
export const WEB_IMPLEMENTED_READ_HANDLER_IDS = [
	"overview",
	"projects",
	"projectDetail",
	"coordinator",
	"reservationDetail",
	"runs",
	"runDetail",
	"runFragments",
	"runGraph",
	"runTimeline",
	"nodeDetail",
	"nodeAttempts",
	"runArtifacts",
	"runReceipt",
	"runWhyStale",
	"approvals",
	"approvalDetail",
	"attention",
	"policyExplanation",
] as const satisfies readonly WebEndpointId[];
export const INITIAL_WEB_READ_HANDLER_IDS =
	WEB_IMPLEMENTED_READ_HANDLER_IDS;

type RunSortKey = "createdAt" | "updatedAt" | "status";
type RunSortDirection = "asc" | "desc";
type RunPageKey = {
	sortValue: number;
	projectId: string;
	controlDomainId: string;
	runId: string;
};

function digestCanonical(value: unknown): string {
	return `sha256:${sha256Hex(stableStringify(value))}`;
}

function sanitizeDisplayText(value: string, fallback: string): string {
	const normalized = value
		.normalize("NFC")
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 512);
	return normalized || fallback.slice(0, 512);
}

function normalizeRunListQuery(query: WebRunListQuery) {
	return {
		limit: query.limit ?? 50,
		projectIds: [...(query.projectIds ?? [])].sort((a, b) =>
			a.localeCompare(b, "en"),
		),
		statuses: [...(query.statuses ?? [])].sort((a, b) =>
			a.localeCompare(b, "en"),
		),
		stages: [...(query.stages ?? [])].sort((a, b) =>
			a.localeCompare(b, "en"),
		),
		...(query.needsOperator === undefined
			? {}
			: { needsOperator: query.needsOperator }),
		...(query.provider === undefined
			? {}
			: { provider: query.provider.normalize("NFC") }),
		...(query.query === undefined
			? {}
			: {
					query: query.query
						.normalize("NFC")
						.trim()
						.toLocaleLowerCase("en"),
				}),
		...(query.createdAfter === undefined
			? {}
			: { createdAfter: query.createdAfter }),
		...(query.createdBefore === undefined
			? {}
			: { createdBefore: query.createdBefore }),
		sortKey: query.sortKey ?? ("updatedAt" as const),
		sortDirection: query.sortDirection ?? ("desc" as const),
	};
}

function runPageKey(
	run: RunProjection,
	sortKey: RunSortKey,
): RunPageKey {
	return {
		sortValue:
			sortKey === "status"
				? WEB_STATUS_SORT_RANK[run.status]
				: run[sortKey],
		projectId: run.projectId,
		controlDomainId: run.controlDomainId,
		runId: run.runId,
	};
}

function compareRunPageKey(
	left: RunPageKey,
	right: RunPageKey,
	direction: RunSortDirection,
): number {
	const sign = direction === "asc" ? 1 : -1;
	const primary =
		left.sortValue === right.sortValue
			? 0
			: left.sortValue < right.sortValue
				? -1
				: 1;
	if (primary !== 0) return primary * sign;
	const project = left.projectId.localeCompare(right.projectId, "en");
	if (project !== 0) return project * sign;
	const domain = left.controlDomainId.localeCompare(
		right.controlDomainId,
		"en",
	);
	if (domain !== 0) return domain * sign;
	return left.runId.localeCompare(right.runId, "en") * sign;
}

function webTimelineKind(
	payload: import("./types.ts").ControlEvent["payload"],
): string {
	return payload.type === "Generic" ? payload.kind : payload.type;
}

function webTimelineSummary(
	payload: import("./types.ts").ControlEvent["payload"],
): WebContentMessage {
	switch (payload.type) {
		case "RunReceived":
			return contentMessage("timeline.run-received");
		case "RunAdmitted":
			return contentMessage("timeline.run-admitted");
		case "BoundFragmentLinked":
			return contentMessage("timeline.bound-fragment-linked");
		case "RunStatusChanged":
			return contentMessage("timeline.run-status-changed");
		case "ReconcileStarted":
			return contentMessage("timeline.reconcile-started");
		case "ReconcileSettled":
			return contentMessage("timeline.reconcile-settled");
		case "NeedsOperator":
			return contentMessage("timeline.needs-operator");
		case "ReceiptIssued":
			return contentMessage("timeline.receipt-issued");
		case "ApprovalParked":
			return contentMessage("timeline.approval-parked");
		case "ApprovalDecided":
			return contentMessage("timeline.approval-decided");
		case "CancelRequested":
			return contentMessage("timeline.cancel-requested");
		case "Generic":
			return contentMessage("timeline.progress-recorded");
	}
}

export function createWebReadService(
	host: ControlHost,
	options: WebReadServiceOptions = {},
): WebReadService {
	const now = options.now ?? Date.now;
	const snapshotCacheMs = Math.max(
		0,
		Math.min(10 * 60_000, options.snapshotCacheMs ?? 0),
	);
	let cachedContext:
		| {
				readonly registryRevision: string;
				readonly watermarkFingerprint?: string;
				readonly expiresAt: number;
				readonly value: ReadContext;
		  }
		| undefined;
	const supportedCommands = new Set<WebCommandKind>(
		options.supportedCommands ?? ["cancel-run"],
	);

	function context(explicitObservedAt?: number): ReadContext {
		const observedAt = explicitObservedAt ?? now();
		const registryRevision =
			host.controlMode === "standalone"
				? "standalone"
				: host.registry.revision;
		const registryEntries =
			host.controlMode === "standalone"
				? [
						{
							projectId: host.projectId,
							controlDomainId: host.controlDomainId,
							storePath: host.store.projectRoot,
							projectRoot: host.store.projectRoot,
							directoryBinding: host.store.header.directoryBinding,
							mountState: "mounted" as const,
							registeredAt: host.store.header.createdAt,
							updatedAt: host.store.header.updatedAt,
						},
					]
				: host.registry
						.list()
						.sort(
							(a, b) =>
								a.projectId.localeCompare(b.projectId, "en") ||
								a.controlDomainId.localeCompare(b.controlDomainId, "en"),
						);
		const boundedEntries = registryEntries.slice(0, 200);
		const watermarkProbes: WatermarkProbe[] | undefined =
			options.resolveHost
				? boundedEntries.map((entry) => {
							const mounted = options.resolveHost?.(
								entry.projectId,
							entry.controlDomainId,
						);
						return mounted
							? {
									projectId: entry.projectId,
									controlDomainId:
										entry.controlDomainId,
									nextCommitSeq:
										mounted.store.nextCommitSeq(),
									minAvailableCommitSeq:
										loadCompactionState(
											mounted.store.projectRoot,
										).minAvailableCommitSeq,
								}
							: {
									projectId: entry.projectId,
									controlDomainId:
										entry.controlDomainId,
										unavailable: true,
									};
						})
				: undefined;
		const watermarkFingerprint = watermarkProbes
			? digestCanonical(watermarkProbes)
			: undefined;
		if (
			snapshotCacheMs > 0 &&
			cachedContext &&
			cachedContext.registryRevision === registryRevision &&
			(watermarkFingerprint === undefined ||
				cachedContext.watermarkFingerprint ===
					watermarkFingerprint) &&
			observedAt <= cachedContext.expiresAt
		) {
			return cachedContext.value;
		}
		const incrementalBase =
			cachedContext &&
			cachedContext.registryRevision === registryRevision &&
			observedAt <= cachedContext.expiresAt
				? cachedContext.value
				: undefined;
		const priorProjects = new Map(
			(incrementalBase?.projects ?? []).map((project) => [
				`${project.entry.projectId}\u0000${project.entry.controlDomainId}`,
				project,
			]),
		);
		const projects = boundedEntries.map((entry, index) => {
			const prior = priorProjects.get(
				`${entry.projectId}\u0000${entry.controlDomainId}`,
			);
			const probe = watermarkProbes?.[index];
			const sameRoot =
				prior?.entry.projectRoot === entry.projectRoot;
			const unchanged =
				sameRoot &&
				probe !== undefined &&
				(("unavailable" in probe &&
					prior !== undefined &&
					!prior.result.ok) ||
					(!("unavailable" in probe) &&
						prior?.result.ok === true &&
						prior.result.snapshot.nextCommitSeq ===
							probe.nextCommitSeq &&
						prior.result.snapshot
							.minAvailableCommitSeq ===
							probe.minAvailableCommitSeq));
			if (unchanged && prior) {
				return {
					entry,
					result: prior.result,
				};
			}
			return {
				entry,
				result: inspectProjectControlStore(
					entry.projectRoot,
					{
						projectId: entry.projectId,
						controlDomainId:
							entry.controlDomainId,
					},
				),
			};
		});
		const allInspected =
			registryEntries.length <= 200 &&
			projects.every((project) => project.result.ok);
		const visibleMounts = boundedEntries.map((entry) => ({
			projectId: entry.projectId,
			controlDomainId: entry.controlDomainId,
		}));
		const watermarks = projects.flatMap((project) =>
			project.result.ok
				? [
						{
							projectId: project.result.snapshot.header.projectId,
							controlDomainId:
								project.result.snapshot.header.controlDomainId,
							nextCommitSeq: project.result.snapshot.nextCommitSeq,
							minAvailableCommitSeq:
								project.result.snapshot.minAvailableCommitSeq,
						},
					]
				: [],
		);
		const sourceObservation: WebSourceObservation = {
			coverage: allInspected ? "complete" : "partial",
			authority: allInspected ? "verified" : "unverified",
			observedAt,
			registryContext:
				host.controlMode === "standalone"
					? {
							mode: "standalone",
							registryRevision: "standalone",
							visibleMounts: [
								{
									projectId: host.projectId,
									controlDomainId: host.controlDomainId,
								},
							],
						}
					: {
							mode: "auto",
							registryRevision: host.registry.revision,
							visibleMounts,
						},
			watermarks,
		};
		const value = { observedAt, projects, sourceObservation };
		if (snapshotCacheMs > 0) {
			cachedContext = {
				registryRevision,
				...(watermarkFingerprint === undefined
					? {}
					: { watermarkFingerprint }),
				// The reuse window begins only after the expensive immutable
				// snapshot has finished. Its own observedAt remains unchanged.
				expiresAt: now() + snapshotCacheMs,
				value,
			};
		}
		return value;
	}

	function availableActions(
		run: RunProjection,
		projectRoot: string,
		observedAt = now(),
	) {
		const actions: WebAvailableAction[] = [];
		const homeHost =
			options.resolveHost?.(
				run.projectId,
				run.controlDomainId,
			) ??
			(run.projectId === host.projectId &&
			run.controlDomainId === host.controlDomainId
				? host
				: null);
		const isHomeAuthority =
			homeHost?.projectId === run.projectId &&
			homeHost.controlDomainId === run.controlDomainId;
		if (
			isHomeAuthority &&
			homeHost?.canMutate === true &&
			supportedCommands.has("cancel-run") &&
			run.stage !== "terminal" &&
			run.status !== "cancelled" &&
			run.status !== "completed" &&
			run.status !== "failed"
		) {
			actions.push({
				kind: "cancel-run",
				state: "available",
				requestBase: {
					kind: "cancel-run",
					projectId: run.projectId,
					controlDomainId: run.controlDomainId,
					runId: run.runId,
					expectedRunVersion: run.runVersion,
				},
			});
		}
		const approval = loadApprovalForRun(projectRoot, run.runId);
		const approvalContinuationReady =
			approval?.nodeInstanceId !== undefined &&
			approval.boundPlanHash === run.boundPlanHash &&
			approval.continuationArtifactId !== undefined &&
			approval.continuationArtifactId ===
				run.approvalContinuationArtifactId;
		if (
			isHomeAuthority &&
			homeHost?.canMutate === true &&
			approval?.status === "pending" &&
			(approval.deadline === undefined ||
				approval.deadline >= observedAt) &&
			approval.approvalRequestId === run.approvalRequestId
		) {
			for (const decision of ["approve", "reject"] as const) {
				if (!supportedCommands.has(decision)) continue;
				if (!approval.allowedDecisions.includes(decision)) continue;
				if (
					decision === "approve" &&
					!approvalContinuationReady
				) {
					continue;
				}
				actions.push({
					kind: decision,
					state: "available",
					requestBase: {
						kind: decision,
						projectId: run.projectId,
						controlDomainId: run.controlDomainId,
						runId: run.runId,
						expectedRunVersion: run.runVersion,
						approvalRequestId: approval.approvalRequestId,
					},
				});
			}
		}
		return { actions, approval };
	}

	function resolveReceiptArtifacts(
		snapshot: ProjectControlReadSnapshot,
		receipt: ProjectControlReadSnapshot["receipts"][number],
	): ArtifactRecord[] {
		if (receipt.artifactRefs.length > 200) {
			throw new WebReadServiceError({
				code: "TF_DURABILITY_FAILED",
				message: "Receipt artifact manifest exceeds the Web protocol bound",
				recoveryAction: "operator",
				sideEffects: "none",
				projectId: receipt.projectId,
				controlDomainId: receipt.controlDomainId,
			});
		}
		const artifactById = new Map(
			snapshot.artifacts.map((artifact) => [
				artifact.artifactId,
				artifact,
			]),
		);
		return receipt.artifactRefs.map((artifactId) => {
			const artifact = artifactById.get(artifactId);
			if (
				!artifact ||
				artifact.runId !== receipt.runId ||
				(artifact.receiptId !== undefined &&
					artifact.receiptId !== receipt.receiptId)
			) {
				throw new WebReadServiceError({
					code: "TF_DURABILITY_FAILED",
					message:
						"Receipt artifact reference is missing or has conflicting provenance",
					recoveryAction: "operator",
					sideEffects: "none",
					projectId: receipt.projectId,
					controlDomainId: receipt.controlDomainId,
				});
			}
			return artifact;
		});
	}

	function replaySummary(
		snapshot: ProjectControlReadSnapshot,
		run: ProjectControlReadSnapshot["runs"][number],
		receipt:
			| ProjectControlReadSnapshot["receipts"][number]
			| undefined,
	) {
		if (!receipt) {
			return {
				replayable: false as const,
				unreplayableReasons: [
					"A terminal Receipt is required before offline replay is available.",
				],
			};
		}
		const traceArtifact = resolveReceiptArtifacts(
			snapshot,
			receipt,
		).find(
			(artifact) =>
				artifact.role === "replay-trace" &&
				artifact.runId === run.runId,
		);
		if (!traceArtifact) {
			return {
				replayable: false as const,
				unreplayableReasons: [
					"The current Receipt does not contain a replay trace.",
				],
			};
		}
		return {
			replayable: true as const,
			traceArtifact: projectWebArtifactRef(
				traceArtifact,
				receipt.receiptId,
			),
			unreplayableReasons: [],
		};
	}

	function projectScopedObservation(
		sourceObservation: WebSourceObservation,
		projectId: string,
		controlDomainId: string,
	): WebSourceObservation {
		const visibleMount = {
			projectId,
			controlDomainId,
		};
		const watermark = sourceObservation.watermarks.find(
			(candidate) =>
				candidate.projectId === projectId &&
				candidate.controlDomainId === controlDomainId,
		);
		return {
			coverage: watermark ? "complete" : "partial",
			authority: watermark ? "verified" : "unverified",
			observedAt: sourceObservation.observedAt,
			registryContext:
				sourceObservation.registryContext.mode ===
				"standalone"
					? {
							mode: "standalone",
							registryRevision: "standalone",
							visibleMounts: [visibleMount],
						}
					: {
							mode: "auto",
							registryRevision:
								sourceObservation.registryContext
									.registryRevision,
							visibleMounts: [visibleMount],
						},
			watermarks: watermark ? [watermark] : [],
		};
	}

	function projectRun(
		project: InspectedProject,
		run: RunProjection,
		sourceObservation: WebSourceObservation,
		observedAt: number,
	) {
		if (!project.result.ok) {
			throw new WebReadServiceError({
				code: "TF_DURABILITY_FAILED",
				message: "project snapshot is not authoritative",
				recoveryAction: "refresh",
				sideEffects: "none",
			});
		}
		const snapshot = project.result.snapshot;
		const boundPlan = snapshot.boundPlans.find(
			(candidate) => candidate.boundPlanHash === run.boundPlanHash,
		);
		if (!boundPlan || run.lastCommitSeq === undefined) {
			throw new WebReadServiceError({
				code: "TF_DURABILITY_FAILED",
				message: "Run provenance is incomplete",
				recoveryAction: "operator",
				sideEffects: "none",
			});
		}
		const receipt = snapshot.receipts.find(
			(candidate) => candidate.receiptId === run.receiptId,
		);
		const receiptArtifacts = receipt
			? resolveReceiptArtifacts(snapshot, receipt)
			: [];
		const workspaceDisplayName = sanitizeDisplayText(
			path.basename(project.entry.projectRoot),
			run.projectId.slice(0, 12),
		);
		const displayTitle = sanitizeDisplayText(
			boundPlan.programName,
			run.runId.slice(0, 12),
		);
		const resourceObservation =
			projectScopedObservation(
				sourceObservation,
				run.projectId,
				run.controlDomainId,
			);
			const { actions, approval } = availableActions(
				run,
				project.entry.projectRoot,
				observedAt,
			);
		const providerOutcome =
			receipt?.assurance.providerOutcome === "ok"
				? "completed"
				: receipt?.assurance.providerOutcome === "failed"
					? "failed"
					: receipt?.assurance.providerOutcome === "cancelled"
						? "cancelled"
						: undefined;
		const expectedProviderOutcome =
			run.status === "failed"
				? "failed"
				: run.status === "cancelled"
					? "cancelled"
					: "completed";
		const finalPreview = run.finalOutput
			? sanitizeDisplayText(run.finalOutput, "Result available").slice(
					0,
					32_768,
				)
			: undefined;
		const errorPreview = run.error
			? sanitizeDisplayText(run.error, "Task failed").slice(0, 32_768)
			: undefined;
		const nodes = (run.nodes ?? []).map((node) => ({
			nodeInstanceId: node.nodeInstanceId,
			status: node.status,
			origin:
				node.origin === "bound-plan"
					? ("static" as const)
					: ("dynamic" as const),
			presentation: {
				authoredPhaseId: node.phaseId,
				groupId: node.phaseId,
				role: "step" as const,
				ordinal: node.ordinal,
				label: sanitizeDisplayText(
					node.displayLabel,
					node.phaseId,
				),
			},
		}));
		const inventorySealed =
			run.nodes !== undefined &&
			run.boundFragmentHash === undefined &&
			run.stage === "terminal";
		const presentation = projectTaskPresentation({
			run: {
				status: run.status,
				stage: run.stage,
				runVersion: run.runVersion,
				boundPlanHash: run.boundPlanHash,
				needsOperator: run.needsOperator,
				stopping:
					run.status === "paused" &&
					run.stage === "executing",
				sideEffects:
					run.needsOperator || run.status === "unknown"
						? "unknown"
						: run.stage === "terminal"
							? "none"
							: "possible",
				displayTitle,
				workspaceDisplayName,
			},
			observedAt,
			sourceObservation: resourceObservation,
			nodes,
			inventorySealed,
			presentationMetadataValid: run.nodes !== undefined,
			result: finalPreview
				? {
						kind: "text",
						source: {
							sourceId: run.runId,
							sourceKind: "runtime",
						},
						preview: finalPreview,
					}
				: errorPreview
					? {
							kind: "error",
							source: {
								sourceId: run.runId,
								sourceKind: "runtime",
							},
							preview: errorPreview,
						}
					: { kind: "none" },
			verification: {
				runStatus: run.status,
				checkedAt: observedAt,
				lifecycleRequiresVerification: true,
				...(receipt ? { receiptId: receipt.receiptId } : {}),
				verifierAvailable: receipt !== undefined,
				eventManifest: receipt ? "unknown" : "unavailable",
				journalContinuity:
					receipt?.assurance.journalContinuity ?? "unknown",
				provenance: receipt?.assurance.provenance ?? "unknown",
				artifactIntegrity:
					receipt?.assurance.artifactIntegrity ?? "unknown",
				providerConsistency: {
					expected: {
						kind: "exact",
						outcome: expectedProviderOutcome,
					},
					...(providerOutcome
						? { observed: providerOutcome }
						: {}),
					check:
						providerOutcome === undefined
							? run.stage === "terminal"
								? "unavailable"
								: "in-progress"
							: providerOutcome === expectedProviderOutcome
								? "ok"
								: "mismatch",
					sourceEventRefs: [],
				},
				artifactChecks: receiptArtifacts.map((artifact) => ({
					artifactId: artifact.artifactId,
					digest: artifact.digest,
					required: true,
					state: "ok" as const,
				})),
				artifactCheckCount: receiptArtifacts.length,
				requiredArtifactCheckCount:
					receiptArtifacts.length,
				sourceObservation: resourceObservation,
			},
			...(approval?.status === "pending" &&
			approval.approvalRequestId === run.approvalRequestId
				? {
						decision: {
							operationClass: "generic-action" as const,
							...(approval.deadline === undefined
								? {}
								: { deadline: approval.deadline }),
							projectId: run.projectId,
							controlDomainId: run.controlDomainId,
							runId: run.runId,
							approvalRequestId:
								approval.approvalRequestId,
							runVersion: run.runVersion,
							approvalVersion: approval.version,
							availableActions: actions,
						},
					}
				: {}),
			availableActions: actions,
			preservedResultCount: finalPreview ? 1 : 0,
		});
			const summary = {
				projectId: run.projectId,
				controlDomainId: run.controlDomainId,
				runId: run.runId,
			workspaceDisplayName,
			displayTitle,
			status: run.status,
			stage: run.stage,
			boundPlanHash: run.boundPlanHash,
			...(run.boundFragmentHash
				? { boundFragmentHash: run.boundFragmentHash }
				: {}),
			...(run.providerName ? { provider: run.providerName } : {}),
			needsOperator: run.needsOperator,
			runVersion: run.runVersion,
			createdAt: run.createdAt,
			updatedAt: run.updatedAt,
			commitSeq: run.lastCommitSeq,
			...(run.receiptId ? { receiptId: run.receiptId } : {}),
				presentation: summarizeTaskPresentation(presentation),
				sourceObservation: resourceObservation,
			};
			return {
				summary,
				presentation,
				boundPlan,
				receipt,
				actions,
				approval,
				workspaceDisplayName,
				displayTitle,
			};
		}

		function summarizeRun(
			project: InspectedProject,
			run: RunProjection,
			sourceObservation: WebSourceObservation,
			observedAt: number,
		) {
			return projectRun(
				project,
				run,
				sourceObservation,
				observedAt,
			).summary;
		}

		function resolveRun(
			ctx: ReadContext,
			projectId: string,
			controlDomainId: string,
			runId: string,
		) {
			const project = ctx.projects.find(
				(candidate) =>
					candidate.entry.projectId === projectId &&
					candidate.entry.controlDomainId === controlDomainId,
			);
			if (!project) {
				throw new WebReadServiceError({
					code: "TF_NOT_FOUND",
					message: "project control domain not found",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			if (!project.result.ok) {
				throw new WebReadServiceError({
					code:
						project.result.reason === "identity-mismatch"
							? "TF_IDENTITY_MISMATCH"
							: "TF_DURABILITY_FAILED",
					message: project.result.detail,
					recoveryAction:
						project.result.reason === "identity-mismatch"
							? "operator"
							: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const run = project.result.snapshot.runs.find(
				(candidate) => candidate.runId === runId,
			);
			if (!run) {
				throw new WebReadServiceError({
					code: "TF_NOT_FOUND",
					message: "Run not found",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			return { project, snapshot: project.result.snapshot, run };
		}

		function assertRunVersion(
			run: RunProjection,
			expectedRunVersion: number,
		): void {
			if (run.runVersion === expectedRunVersion) return;
			throw new WebReadServiceError({
				code: "TF_STALE_VERSION",
				message: `expected runVersion ${expectedRunVersion}, have ${run.runVersion}`,
				recoveryAction: "refresh",
				sideEffects: "none",
				projectId: run.projectId,
				controlDomainId: run.controlDomainId,
			});
		}

		type WebPhaseDefinition = {
			id: string;
			type?: string;
			dependsOn?: string[];
			from?: string[];
		};

		function phaseDefinitions(program: unknown): WebPhaseDefinition[] {
			if (!program || typeof program !== "object") return [];
			const phases = (program as { phases?: unknown }).phases;
			if (!Array.isArray(phases)) return [];
			return phases.filter(
				(value): value is WebPhaseDefinition =>
					!!value &&
					typeof value === "object" &&
					typeof (value as { id?: unknown }).id === "string",
			);
		}

		function webNodes(run: RunProjection) {
			return [...(run.nodes ?? [])]
				.sort(
					(left, right) =>
						left.ordinal - right.ordinal ||
						left.nodeInstanceId.localeCompare(
							right.nodeInstanceId,
							"en",
						),
				)
				.map((node) => ({
					nodeInstanceId: node.nodeInstanceId,
					phaseId: node.phaseId,
					phaseType: node.phaseType,
					origin: node.origin,
					...(node.boundFragmentHash
						? { boundFragmentHash: node.boundFragmentHash }
						: {}),
					status: node.status,
					attemptCount: node.attemptCount,
				}));
		}

		function graphEdges(
			run: RunProjection,
			program: unknown,
			snapshot?: ProjectControlReadSnapshot,
		) {
			const nodeIds = new Set(
				(run.nodes ?? []).map((node) => node.nodeInstanceId),
			);
			const staticEdges = phaseDefinitions(program).flatMap((phase) => {
				const dependencies = [
					...(Array.isArray(phase.dependsOn)
						? phase.dependsOn
						: []),
					...(Array.isArray(phase.from) ? phase.from : []),
				].filter(
					(value): value is string =>
						typeof value === "string" &&
						nodeIds.has(value) &&
						nodeIds.has(phase.id),
				);
				return [...new Set(dependencies)].map(
					(dependencyNodeInstanceId) => ({
						fromNodeInstanceId: dependencyNodeInstanceId,
						toNodeInstanceId: phase.id,
						kind: "depends-on" as const,
					}),
				);
			});
			if (!snapshot) return staticEdges;
			const links = snapshot.boundFragmentLinks.filter(
				(link) => link.runId === run.runId,
			);
			const fragmentByHash = new Map(
				snapshot.boundFragments.map((fragment) => [
					fragment.boundFragmentHash,
					fragment,
				]),
			);
			const dynamicNodes = (run.nodes ?? []).filter(
				(node) =>
					node.origin === "bound-fragment" &&
					node.boundFragmentHash,
			);
			const dynamicChildEdges = links.flatMap((link) =>
				dynamicNodes
					.filter(
						(node) =>
							node.boundFragmentHash ===
							link.boundFragmentHash,
					)
					.map((node) => ({
						fromNodeInstanceId:
							link.parentNodeInstanceId,
						toNodeInstanceId:
							node.nodeInstanceId,
						kind: "dynamic-child" as const,
					})),
			);
			const internalDynamicEdges = links.flatMap((link) => {
				const fragment = fragmentByHash.get(
					link.boundFragmentHash,
				);
				if (!fragment) return [];
				const nodeByPhase = new Map(
					dynamicNodes
						.filter(
							(node) =>
								node.boundFragmentHash ===
								link.boundFragmentHash,
						)
						.map((node) => [node.phaseId, node]),
				);
				return phaseDefinitions(fragment.fragment).flatMap(
					(phase) => {
						const target = nodeByPhase.get(phase.id);
						if (!target) return [];
						const dependencies = [
							...(Array.isArray(phase.dependsOn)
								? phase.dependsOn
								: []),
							...(Array.isArray(phase.from)
								? phase.from
								: []),
						];
						return [
							...new Set(
								dependencies.filter(
									(value): value is string =>
										typeof value ===
											"string" &&
										nodeByPhase.has(
											value,
										),
								),
							),
						].map((dependency) => ({
							fromNodeInstanceId:
								nodeByPhase.get(
									dependency,
								)!.nodeInstanceId,
							toNodeInstanceId:
								target.nodeInstanceId,
							kind: "depends-on" as const,
						}));
					},
				);
			});
			return [
				...staticEdges,
				...dynamicChildEdges,
				...internalDynamicEdges,
			];
		}

		function webAttempts(
			run: RunProjection,
			nodeInstanceId?: string,
		) {
			return [...(run.attempts ?? [])]
				.filter(
					(attempt) =>
						nodeInstanceId === undefined ||
						attempt.nodeInstanceId === nodeInstanceId,
				)
				.sort(
					(left, right) =>
						left.attemptOrdinal - right.attemptOrdinal ||
						left.attemptId.localeCompare(right.attemptId, "en"),
				)
				.map((attempt) => ({
					attemptId: attempt.attemptId,
					nodeInstanceId: attempt.nodeInstanceId,
					provider: sanitizeDisplayText(
						attempt.provider ?? "unavailable",
						"unavailable",
					),
					status: attempt.status,
					...(attempt.startedAt === undefined
						? {}
						: { startedAt: attempt.startedAt }),
					...(attempt.endedAt === undefined
						? {}
						: { endedAt: attempt.endedAt }),
					providerJobHandlePresent:
						attempt.providerJobHandlePresent,
				}));
		}

		function webReceipt(
			receipt: ProjectControlReadSnapshot["receipts"][number],
			snapshot: ProjectControlReadSnapshot,
		) {
			const artifactRefs = resolveReceiptArtifacts(
				snapshot,
				receipt,
			).map((artifact) =>
				projectWebArtifactRef(artifact, receipt.receiptId),
			);
			if (receipt.eventManifest.length > 200) {
				throw new WebReadServiceError({
					code: "TF_DURABILITY_FAILED",
					message:
						"Receipt identity manifest exceeds the Web receipt-detail bound",
					recoveryAction: "none",
					sideEffects: "none",
					projectId: receipt.projectId,
					controlDomainId: receipt.controlDomainId,
				});
			}
			return {
				receiptId: receipt.receiptId,
				projectId: receipt.projectId,
				controlDomainId: receipt.controlDomainId,
				runId: receipt.runId,
				boundPlanHash: receipt.boundPlanHash,
				...(receipt.boundFragmentHash
					? { boundFragmentHash: receipt.boundFragmentHash }
					: {}),
				eventManifest: [...receipt.eventManifest],
				startCommitSeq: receipt.startCommitSeq,
				endCommitSeq: receipt.endCommitSeq,
				artifactRefs,
				issuedAt: receipt.issuedAt,
				assurance: receipt.assurance,
				buildInfo: receipt.buildInfo,
			};
		}

		function projectApproval(
			project: InspectedProject,
			approval: ProjectControlReadSnapshot["approvals"][number],
			sourceObservation: WebSourceObservation,
			observedAt: number,
		) {
			if (!project.result.ok) {
				throw new WebReadServiceError({
					code: "TF_DURABILITY_FAILED",
					message: "Approval source is not authoritative",
					recoveryAction: "refresh",
					sideEffects: "none",
				});
			}
			const run = project.result.snapshot.runs.find(
				(candidate) => candidate.runId === approval.runId,
			);
			if (!run) {
				throw new WebReadServiceError({
					code: "TF_DURABILITY_FAILED",
					message: "Approval Run is not durably available",
					recoveryAction: "operator",
					sideEffects: "none",
					projectId: approval.projectId,
					controlDomainId: approval.controlDomainId,
				});
			}
			const projected = projectRun(
				project,
				run,
				sourceObservation,
				observedAt,
			);
			const summary = {
				approvalRequestId: approval.approvalRequestId,
				projectId: approval.projectId,
				controlDomainId: approval.controlDomainId,
				runId: approval.runId,
				...(approval.nodeInstanceId
					? {
							nodeInstanceId:
								approval.nodeInstanceId,
						}
					: {}),
				status: approval.status,
				message:
					approval.message ??
					(approval.status === "pending"
						? "Task is waiting for a decision."
						: "The task decision has been recorded."),
				allowedDecisions: [...approval.allowedDecisions],
				expectedRunVersion: run.runVersion,
				createdAt: approval.createdAt,
				...(approval.deadline === undefined
					? {}
					: { deadline: approval.deadline }),
				authorityVerified: true,
				sourceObservation,
				availableActions: projected.actions,
			};
			return { summary, run, projected };
		}

	function readCoordinatorWithContext(ctx: ReadContext): WebCoordinatorSummary {
		const reservations = host.coordinator.listReservations();
		const counts = countBy(
			reservations.map((reservation) => reservation.state),
			["reserved", "committed", "released", "expired", "orphan-suspect"] as const,
		);
		const lease = host.coordinator.getLease();
		return {
			maxActiveRuns: host.coordinator.maxActiveRuns,
			occupyingCount: reservations.filter((reservation) =>
				(CAPACITY_OCCUPYING_STATES as readonly string[]).includes(
					reservation.state,
				),
			).length,
			coordinatorEpoch: lease?.fencingEpoch ?? 0,
			...(lease ? { leaseHolderId: lease.holderId, leaseExpiresAt: lease.expiresAt } : {}),
			reservationCounts: {
				reserved: counts.reserved,
				committed: counts.committed,
				released: counts.released,
				expired: counts.expired,
				orphanSuspect: counts["orphan-suspect"],
			},
			sourceObservation: ctx.sourceObservation,
		};
	}

	const service: WebReadService = {
		readOverview() {
			const ctx = context();
			const runs = allRuns(ctx.projects);
			const coordinator = readCoordinatorWithContext(ctx);
			const pendingApprovals = runs.filter(
				(run) =>
					run.status === "paused" &&
					run.stage === "parked" &&
					run.approvalRequestId !== undefined,
			).length;
			const needsOperator = runs.filter((run) => run.needsOperator).length;
			const ambiguous = runs.filter(
				(run) => run.status === "unknown" || run.stage === "reconciling",
			).length;
			const reservationDiagnostics = host.coordinator
				.listReservations()
				.filter((reservation) => reservation.state === "orphan-suspect")
				.length;
			const unavailable = ctx.projects.filter(
				(project) => !project.result.ok,
			);
			const timestamps = runs.map((run) => run.createdAt);
			return {
				sourceObservation: ctx.sourceObservation,
				coordinatorCapacity: {
					maxActiveRuns: coordinator.maxActiveRuns,
					occupied: coordinator.occupyingCount,
					available: Math.max(
						0,
						coordinator.maxActiveRuns - coordinator.occupyingCount,
					),
					fencingEpoch: coordinator.coordinatorEpoch,
				},
				runCounts: {
					byStatus: countBy(
						runs.map((run) => run.status),
						RUN_STATUSES,
					),
					byStage: countBy(
						runs.map((run) => run.stage),
						RUN_STAGES,
					),
					needsOperator,
				},
				attentionCounts: {
					needsUserInput: pendingApprovals,
					statusOnly: ambiguous,
					diagnostic:
						needsOperator + reservationDiagnostics + unavailable.length,
					pendingApprovals,
				},
				usage:
					runs.length === 0
						? {
								availability: "measured",
								startAt: ctx.observedAt,
								endAt: ctx.observedAt,
								inputTokens: 0,
								outputTokens: 0,
								cost: 0,
								currency: "USD",
								methodology:
									"No Tasks exist in the selected source snapshot.",
							}
						: {
								availability: "unavailable",
								startAt:
									timestamps.length > 0
										? Math.min(...timestamps)
										: ctx.observedAt,
								endAt: ctx.observedAt,
								methodology:
									"Usage is aggregated only from durable Receipt usage records.",
								unavailableReason:
									"Current Receipt records do not contain token or cost totals.",
							},
				reuse: {
					estimatedReusedNodes: 0,
					methodology:
						"Current ControlStore projections do not persist node-level cache decisions.",
					unavailableReason:
						"Node-level reuse evidence is not available in this build.",
				},
				projectHealth: {
					healthy: ctx.projects.length - unavailable.length,
					warning: 0,
					unavailable: unavailable.length,
					warnings: unavailable.map((project) => ({
						projectId: project.entry.projectId,
						controlDomainId: project.entry.controlDomainId,
						code: project.result.ok
							? "unavailable"
							: project.result.reason,
					})),
				},
			};
		},

		readProjects(query, requestContext) {
			const ctx = context(requestContext.observedAt);
			const limit = query.limit ?? 50;
			const normalizedQuery = { limit };
			const queryHash = digestCanonical(normalizedQuery);
			const visibleMountsHash = digestCanonical(
				ctx.sourceObservation.registryContext.visibleMounts,
			);
			const binding = {
				collection: "projects" as const,
				listenerId: requestContext.listenerId,
				principalHash: requestContext.principalHash,
				queryHash,
				sortKey: "project-id" as const,
				sortDirection: "asc" as const,
				registryContext: ctx.sourceObservation.registryContext,
				visibleMountsHash,
				projectWatermarks: ctx.sourceObservation.watermarks,
				resourceVersion: undefined,
			};
			let after:
				| { projectId: string; controlDomainId: string }
				| undefined;
			if (query.cursor) {
				if (!options.cursorCodec) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message: "page cursor verification is unavailable",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				const decoded = options.cursorCodec.decodePage(
					query.cursor,
					binding,
				);
				if (decoded.collection !== "projects") {
					throw new WebReadServiceError({
						code: "TF_INVALID_ARGUMENT",
						message:
							"cursor does not belong to the Project collection",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				after = decoded.after;
			}
			const ordered = [...ctx.projects].sort(
				(left, right) =>
					left.entry.projectId.localeCompare(
						right.entry.projectId,
						"en",
					) ||
					left.entry.controlDomainId.localeCompare(
						right.entry.controlDomainId,
						"en",
					),
			);
			const remaining = strictlyAfterKeyset(
				ordered,
				after,
				(project) => ({
					projectId: project.entry.projectId,
					controlDomainId: project.entry.controlDomainId,
				}),
				(left, right) =>
					left.projectId.localeCompare(right.projectId, "en") ||
					left.controlDomainId.localeCompare(
						right.controlDomainId,
						"en",
					),
			);
			const summaries = remaining.map((project) => {
				const snapshot = project.result.ok
					? project.result.snapshot
					: undefined;
				const lastActivityAt = snapshot
					? Math.max(
							snapshot.header.updatedAt,
							...snapshot.runs.map((run) => run.updatedAt),
						)
					: project.entry.updatedAt;
				const mountState = project.result.ok
					? project.entry.mountState === "mounted"
						? ("mounted" as const)
						: ("unmounted" as const)
					: project.result.reason === "missing"
						? ("missing" as const)
						: project.result.reason === "identity-mismatch"
							? ("conflict" as const)
							: ("unmounted" as const);
				const displayName = sanitizeDisplayText(
					path.basename(project.entry.projectRoot),
					project.entry.projectId.slice(0, 12),
				);
				return {
					projectId: project.entry.projectId,
					controlDomainId: project.entry.controlDomainId,
					displayName,
					directoryBindingLabel: displayName,
					mountState,
					lastActivityAt,
					...(snapshot
						? {
								nextCommitSeq: snapshot.nextCommitSeq,
								minAvailableCommitSeq:
									snapshot.minAvailableCommitSeq,
							}
						: {}),
					authorityVerified: project.result.ok,
					sourceObservation: ctx.sourceObservation,
				};
			});
			const built = buildBoundedWebPage({
				orderedItems: summaries,
				limit,
				maximumLimit: 200,
				responseBudgetBytes:
					WEB_ENDPOINTS.projects.responseBudgetBytes,
				keyOf: (summary) => ({
					projectId: summary.projectId,
					controlDomainId: summary.controlDomainId,
				}),
				cursorAfter: (lastReturnedKey) => {
					if (!options.cursorCodec) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message: "page cursor signing is unavailable",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					const expiresAt = Math.min(
						ctx.observedAt + 10 * 60_000,
						requestContext.sessionAbsoluteExpiresAt,
					);
					if (expiresAt <= ctx.observedAt) {
						throw new WebReadServiceError({
							code: "TF_CURSOR_EXPIRED",
							message:
								"browser session expired before page creation",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					return options.cursorCodec.encodePage({
						version: 1,
						kind: "page",
						collection: "projects",
						listenerId: requestContext.listenerId,
						principalHash: requestContext.principalHash,
						queryHash,
						sortKey: "project-id",
						sortDirection: "asc",
						registryContext:
							ctx.sourceObservation.registryContext,
						visibleMountsHash,
						projectWatermarks:
							ctx.sourceObservation.watermarks,
						after: lastReturnedKey,
						issuedAt: ctx.observedAt,
						expiresAt,
					});
				},
				envelope: (items, nextCursor) => ({
					ok: true as const,
					requestId: requestContext.requestId,
					schemaVersion: "web.v1" as const,
					data: {
						items: [...items],
						...(nextCursor ? { nextCursor } : {}),
						sourceObservation: ctx.sourceObservation,
					},
				}),
			});
			return built.envelope.data;
		},

		readProjectDetail(projectId, controlDomainId, requestContext) {
			const ctx = context(requestContext.observedAt);
			const project = ctx.projects.find(
				(candidate) =>
					candidate.entry.projectId === projectId &&
					candidate.entry.controlDomainId === controlDomainId,
			);
			if (!project) {
				throw new WebReadServiceError({
					code: "TF_NOT_FOUND",
					message: "project control domain not found",
					recoveryAction: "refresh",
					sideEffects: "none",
				});
			}
			if (!project.result.ok) {
				throw new WebReadServiceError({
					code:
						project.result.reason === "identity-mismatch"
							? "TF_IDENTITY_MISMATCH"
							: "TF_DURABILITY_FAILED",
					message: project.result.detail,
					recoveryAction:
						project.result.reason === "identity-mismatch"
							? "operator"
							: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const snapshot = project.result.snapshot;
			const displayName = sanitizeDisplayText(
				path.basename(project.entry.projectRoot),
				projectId.slice(0, 12),
			);
			const sortedRuns = [...snapshot.runs].sort(
				(left, right) =>
					right.updatedAt - left.updatedAt ||
					left.runId.localeCompare(right.runId, "en"),
			);
			const recentRuns = sortedRuns
				.slice(0, 20)
				.map((run) =>
					summarizeRun(
						project,
						run,
						ctx.sourceObservation,
						ctx.observedAt,
					),
				);
			return {
				projectId,
				controlDomainId,
				displayName,
				displayRoot: displayName,
				registryRevision:
					ctx.sourceObservation.registryContext.registryRevision,
				bindingState: "bound",
				mountState:
					project.entry.mountState === "mounted"
						? "mounted"
						: "unmounted",
				header: {
					schemaVersion: snapshot.header.schemaVersion,
					projectId: snapshot.header.projectId,
					controlDomainId: snapshot.header.controlDomainId,
					verified: true,
				},
				watermark: {
					projectId,
					controlDomainId,
					nextCommitSeq: snapshot.nextCommitSeq,
					minAvailableCommitSeq:
						snapshot.minAvailableCommitSeq,
				},
				warnings: [],
				effectivePolicyHash: compilePolicy({}).exposure.policyHash,
				policyExplanationAvailable: false,
				runCount: sortedRuns.length,
				recentRuns,
				recentRunsTruncated: sortedRuns.length > recentRuns.length,
				sourceObservation: ctx.sourceObservation,
				availableActions: [],
			};
		},

		readRuns(query, requestContext) {
			const ctx = context(requestContext.observedAt);
			const normalized = normalizeRunListQuery(query);
			const queryHash = digestCanonical(normalized);
			const visibleMountsHash = digestCanonical(
				ctx.sourceObservation.registryContext.visibleMounts,
			);
			const binding = {
				collection: "runs" as const,
				listenerId: requestContext.listenerId,
				principalHash: requestContext.principalHash,
				queryHash,
				sortKey: normalized.sortKey,
				sortDirection: normalized.sortDirection,
				registryContext: ctx.sourceObservation.registryContext,
				visibleMountsHash,
				projectWatermarks: ctx.sourceObservation.watermarks,
				resourceVersion: undefined,
			};
			let after: RunPageKey | undefined;
			if (query.cursor) {
				if (!options.cursorCodec) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message: "page cursor verification is unavailable",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				const decoded = options.cursorCodec.decodePage(
					query.cursor,
					binding,
				);
				if (decoded.collection !== "runs") {
					throw new WebReadServiceError({
						code: "TF_INVALID_ARGUMENT",
						message: "cursor does not belong to the Run collection",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				after = decoded.after;
			}

			const candidates = ctx.projects.flatMap((project) =>
				project.result.ok
					? project.result.snapshot.runs.map((run) => ({
							project,
							run,
						}))
					: [],
			);
			const filtered = candidates.filter(({ project, run }) => {
				if (
					normalized.projectIds.length > 0 &&
					!normalized.projectIds.includes(run.projectId)
				) {
					return false;
				}
				if (
					normalized.statuses.length > 0 &&
					!normalized.statuses.includes(run.status)
				) {
					return false;
				}
				if (
					normalized.stages.length > 0 &&
					!normalized.stages.includes(run.stage)
				) {
					return false;
				}
				if (
					normalized.needsOperator !== undefined &&
					run.needsOperator !== normalized.needsOperator
				) {
					return false;
				}
				if (
					normalized.provider !== undefined &&
					run.providerName !== normalized.provider
				) {
					return false;
				}
				if (
					normalized.createdAfter !== undefined &&
					run.createdAt < normalized.createdAfter
				) {
					return false;
				}
				if (
					normalized.createdBefore !== undefined &&
					run.createdAt > normalized.createdBefore
				) {
					return false;
				}
				if (normalized.query !== undefined) {
					const plan = project.result.ok
						? project.result.snapshot.boundPlans.find(
								(candidate) =>
									candidate.boundPlanHash ===
									run.boundPlanHash,
							)
						: undefined;
					const haystack = [
						run.runId,
						run.providerName ?? "",
						plan?.programName ?? "",
						path.basename(project.entry.projectRoot),
					]
						.join("\n")
						.normalize("NFC")
						.toLocaleLowerCase("en");
					if (!haystack.includes(normalized.query)) return false;
				}
				return true;
			});
			filtered.sort((left, right) =>
				compareRunPageKey(
					runPageKey(left.run, normalized.sortKey),
					runPageKey(right.run, normalized.sortKey),
					normalized.sortDirection,
				),
			);
			const remaining = strictlyAfterKeyset(
				filtered,
				after,
				(item) => runPageKey(item.run, normalized.sortKey),
				(left, right) =>
					compareRunPageKey(
						left,
						right,
						normalized.sortDirection,
					),
			);
			/*
			 * Keyset order/filtering uses the compact durable projections. Full
			 * presentation is intentionally delayed until the only candidates
			 * that can enter this response: at most limit + one omitted row.
			 */
			const summaries = remaining
				.slice(0, normalized.limit + 1)
				.map(({ project, run }) =>
				summarizeRun(
					project,
					run,
					ctx.sourceObservation,
					ctx.observedAt,
				),
				);
			const built = buildBoundedWebPage({
				orderedItems: summaries,
				limit: normalized.limit,
				maximumLimit: 200,
				responseBudgetBytes:
					WEB_ENDPOINTS.runs.responseBudgetBytes,
				keyOf: (summary) => ({
					sortValue:
						normalized.sortKey === "status"
							? WEB_STATUS_SORT_RANK[summary.status]
							: summary[normalized.sortKey],
					projectId: summary.projectId,
					controlDomainId: summary.controlDomainId,
					runId: summary.runId,
				}),
				cursorAfter: (lastReturnedKey) => {
					if (!options.cursorCodec) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message: "page cursor signing is unavailable",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					const expiresAt = Math.min(
						ctx.observedAt + 10 * 60_000,
						requestContext.sessionAbsoluteExpiresAt,
					);
					if (expiresAt <= ctx.observedAt) {
						throw new WebReadServiceError({
							code: "TF_CURSOR_EXPIRED",
							message: "browser session expired before page creation",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					return options.cursorCodec.encodePage({
						version: 1,
						kind: "page",
						collection: "runs",
						listenerId: requestContext.listenerId,
						principalHash: requestContext.principalHash,
						queryHash,
						sortKey: normalized.sortKey,
						sortDirection: normalized.sortDirection,
						registryContext:
							ctx.sourceObservation.registryContext,
						visibleMountsHash,
						projectWatermarks:
							ctx.sourceObservation.watermarks,
						after: lastReturnedKey,
						issuedAt: ctx.observedAt,
						expiresAt,
					});
				},
				envelope: (items, nextCursor) => ({
					ok: true as const,
					requestId: requestContext.requestId,
					schemaVersion: "web.v1" as const,
					data: {
						items: [...items],
						...(nextCursor ? { nextCursor } : {}),
						sourceObservation: ctx.sourceObservation,
					},
				}),
			});
			return built.envelope.data;
		},

		readRunDetail(
			projectId,
			controlDomainId,
			runId,
			requestContext,
		) {
			const ctx = context(requestContext.observedAt);
			const resolved = resolveRun(
				ctx,
				projectId,
				controlDomainId,
				runId,
			);
			const projected = projectRun(
				resolved.project,
				resolved.run,
				ctx.sourceObservation,
				ctx.observedAt,
			);
			const receipt = projected.receipt
				? webReceipt(projected.receipt, resolved.snapshot)
				: undefined;
			const timeline = service.readRunTimeline(
				projectId,
				controlDomainId,
				runId,
				{
					expectedRunVersion: resolved.run.runVersion,
					limit: 50,
				},
				requestContext,
			);
			const artifactPage = service.readRunArtifacts(
				projectId,
				controlDomainId,
				runId,
				{
					expectedRunVersion: resolved.run.runVersion,
					...(projected.receipt
						? {
								expectedReceiptId:
									projected.receipt.receiptId,
							}
						: {}),
					limit: 50,
				},
				requestContext,
			);
			return {
				run: projected.summary,
				workspaceDisplayName: projected.workspaceDisplayName,
				displayTitle: projected.displayTitle,
				boundPlan: {
					boundPlanHash: projected.boundPlan.boundPlanHash,
					executionSemanticHash:
						projected.boundPlan.executionSemanticHash,
					programName: sanitizeDisplayText(
						projected.boundPlan.programName,
						resolved.run.runId,
					),
					...(projected.boundPlan.irHash
						? { irHash: projected.boundPlan.irHash }
						: {}),
					approvalMode: projected.boundPlan.approvalMode,
					grantRefs: [...projected.boundPlan.grantRefs],
					createdAt: projected.boundPlan.createdAt,
				},
				boundFragments:
					resolved.snapshot.boundFragmentLinks
						.filter(
							(link) =>
								link.runId ===
								resolved.run.runId,
						)
						.sort(
							(left, right) =>
								left.createdAtCommitSeq -
									right.createdAtCommitSeq ||
								left.boundFragmentHash.localeCompare(
									right.boundFragmentHash,
									"en",
								),
						)
						.slice(0, 200)
						.map((link) => ({
							boundFragmentHash:
								link.boundFragmentHash,
							parentNodeInstanceId:
								link.parentNodeInstanceId,
							originPhaseId:
								link.originPhaseId,
							createdAtCommitSeq:
								link.createdAtCommitSeq,
						})),
				nodes: webNodes(resolved.run).slice(
					0,
					WEB_GRAPH_MAX_PAGE_LIMIT,
				),
				edges: graphEdges(
					resolved.run,
					projected.boundPlan.program,
					resolved.snapshot,
				).slice(0, WEB_GRAPH_MAX_EDGES_PER_PAGE),
				attempts: webAttempts(resolved.run).slice(0, 200),
				timeline,
				artifacts: artifactPage.items,
				...(receipt ? { receipt } : {}),
				whyStale: {
					availability: "unavailable",
					unavailableReason:
						"Durable cache fingerprints are not retained by this ControlStore schema.",
					reasons: [],
				},
				replay: replaySummary(
					resolved.snapshot,
					resolved.run,
					projected.receipt,
				),
				presentation: projected.presentation,
				sourceObservation: ctx.sourceObservation,
				availableActions: projected.actions,
			};
		},

		readRunFragments(
			projectId,
			controlDomainId,
			runId,
			query,
			requestContext,
		) {
			const ctx = context(requestContext.observedAt);
			const resolved = resolveRun(
				ctx,
				projectId,
				controlDomainId,
				runId,
			);
			assertRunVersion(
				resolved.run,
				query.expectedRunVersion,
			);
			const limit = query.limit ?? 50;
			const normalizedQuery = {
				expectedRunVersion: query.expectedRunVersion,
				limit,
			};
			const items = resolved.snapshot.boundFragmentLinks
				.filter((link) => link.runId === runId)
				.sort(
					(left, right) =>
						left.createdAtCommitSeq -
							right.createdAtCommitSeq ||
						left.boundFragmentHash.localeCompare(
							right.boundFragmentHash,
							"en",
						),
				)
				.map((link) => ({
					boundFragmentHash: link.boundFragmentHash,
					parentNodeInstanceId:
						link.parentNodeInstanceId,
					originPhaseId: link.originPhaseId,
					...(link.causationId
						? { causationId: link.causationId }
						: {}),
					linkKind: link.linkKind,
					createdAtCommitSeq:
						link.createdAtCommitSeq,
					dynamicNodeCount:
						link.dynamicNodeCount,
					staticNodeCount: link.staticNodeCount,
				}));
			const queryHash = digestCanonical(normalizedQuery);
			const visibleMountsHash = digestCanonical(
				ctx.sourceObservation.registryContext.visibleMounts,
			);
			const resourceVersion = {
				runId,
				runVersion: resolved.run.runVersion,
			};
			const binding = {
				collection: "fragments" as const,
				listenerId: requestContext.listenerId,
				principalHash: requestContext.principalHash,
				queryHash,
				sortKey: "created-commit" as const,
				sortDirection: "asc" as const,
				registryContext:
					ctx.sourceObservation.registryContext,
				visibleMountsHash,
				projectWatermarks:
					ctx.sourceObservation.watermarks,
				resourceVersion,
			};
			let after:
				| {
						createdAtCommitSeq: number;
						boundFragmentHash: string;
				  }
				| undefined;
			if (query.cursor) {
				if (!options.cursorCodec) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message:
							"page cursor verification is unavailable",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				const decoded = options.cursorCodec.decodePage(
					query.cursor,
					binding,
				);
				if (decoded.collection !== "fragments") {
					throw new WebReadServiceError({
						code: "TF_INVALID_ARGUMENT",
						message:
							"cursor does not belong to the fragments collection",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				after = decoded.after;
			}
			const compareKey = (
				left: {
					createdAtCommitSeq: number;
					boundFragmentHash: string;
				},
				right: {
					createdAtCommitSeq: number;
					boundFragmentHash: string;
				},
			) =>
				left.createdAtCommitSeq -
					right.createdAtCommitSeq ||
				left.boundFragmentHash.localeCompare(
					right.boundFragmentHash,
					"en",
				);
			const remaining = strictlyAfterKeyset(
				items,
				after,
				(item) => ({
					createdAtCommitSeq:
						item.createdAtCommitSeq,
					boundFragmentHash:
						item.boundFragmentHash,
				}),
				compareKey,
			);
			const built = buildBoundedWebPage({
				orderedItems: remaining,
				limit,
				maximumLimit: 200,
				responseBudgetBytes:
					WEB_ENDPOINTS.runFragments
						.responseBudgetBytes,
				keyOf: (item) => ({
					createdAtCommitSeq:
						item.createdAtCommitSeq,
					boundFragmentHash:
						item.boundFragmentHash,
				}),
				cursorAfter: (lastReturnedKey) => {
					if (!options.cursorCodec) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message:
								"page cursor signing is unavailable",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					const expiresAt = Math.min(
						ctx.observedAt + 10 * 60_000,
						requestContext.sessionAbsoluteExpiresAt,
					);
					return options.cursorCodec.encodePage({
						version: 1,
						kind: "page",
						collection: "fragments",
						listenerId:
							requestContext.listenerId,
						principalHash:
							requestContext.principalHash,
						queryHash,
						sortKey: "created-commit",
						sortDirection: "asc",
						registryContext:
							ctx.sourceObservation
								.registryContext,
						visibleMountsHash,
						projectWatermarks:
							ctx.sourceObservation.watermarks,
						resourceVersion,
						after: lastReturnedKey,
						issuedAt: ctx.observedAt,
						expiresAt,
					});
				},
				envelope: (pageItems, nextCursor) => ({
					ok: true as const,
					requestId: requestContext.requestId,
					schemaVersion: "web.v1" as const,
					data: {
						items: [...pageItems],
						...(nextCursor
							? { nextCursor }
							: {}),
						sourceObservation:
							ctx.sourceObservation,
					},
				}),
			});
			return built.envelope.data;
		},

		readRunGraph(
			projectId,
			controlDomainId,
			runId,
			query,
			requestContext,
		) {
			const ctx = context(requestContext.observedAt);
			const resolved = resolveRun(
				ctx,
				projectId,
				controlDomainId,
				runId,
			);
			assertRunVersion(
				resolved.run,
				query.expectedRunVersion,
			);
			const boundPlan = resolved.snapshot.boundPlans.find(
				(candidate) =>
					candidate.boundPlanHash ===
					resolved.run.boundPlanHash,
			);
			if (!boundPlan) {
				throw new WebReadServiceError({
					code: "TF_DURABILITY_FAILED",
					message: "Run BoundPlan is not available",
					recoveryAction: "operator",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const limit =
				query.limit ?? WEB_GRAPH_DEFAULT_PAGE_LIMIT;
			const normalizedQuery = {
				expectedRunVersion: query.expectedRunVersion,
				limit,
				statuses: [...(query.statuses ?? [])].sort((a, b) =>
					a.localeCompare(b, "en"),
				),
				phaseKinds: [...(query.phaseKinds ?? [])].sort(
					(a, b) => a.localeCompare(b, "en"),
				),
				origins: [...(query.origins ?? [])].sort((a, b) =>
					a.localeCompare(b, "en"),
				),
				...(query.query
					? {
							query: query.query
								.normalize("NFC")
								.trim()
								.toLocaleLowerCase("en"),
						}
					: {}),
				...(query.scope ? { scope: query.scope } : {}),
			};
			const nodeProjectionById = new Map(
				(resolved.run.nodes ?? []).map((node) => [
					node.nodeInstanceId,
					node,
				]),
			);
			const allNodes = webNodes(resolved.run);
			const matchedNodes = allNodes.filter((node) => {
				const projected = nodeProjectionById.get(
					node.nodeInstanceId,
				);
				if (!projected) return false;
				if (
					normalizedQuery.statuses.length > 0 &&
					!normalizedQuery.statuses.includes(node.status)
				) {
					return false;
				}
				if (
					normalizedQuery.phaseKinds.length > 0 &&
					!normalizedQuery.phaseKinds.includes(
						node.phaseType,
					)
				) {
					return false;
				}
				if (
					normalizedQuery.origins.length > 0 &&
					!normalizedQuery.origins.includes(node.origin)
				) {
					return false;
				}
				if (
					normalizedQuery.query &&
					!`${node.phaseId}\n${projected.displayLabel}`
						.normalize("NFC")
						.toLocaleLowerCase("en")
						.includes(normalizedQuery.query)
				) {
					return false;
				}
				if (normalizedQuery.scope?.kind === "fragment") {
					return (
						node.boundFragmentHash ===
						normalizedQuery.scope.boundFragmentHash
					);
				}
				if (
					normalizedQuery.scope?.kind === "dynamic-parent"
				) {
					return false;
				}
				return true;
			}).sort((left, right) =>
				left.nodeInstanceId.localeCompare(
					right.nodeInstanceId,
					"en",
				),
			);
			const allEdges = graphEdges(
				resolved.run,
				boundPlan.program,
				resolved.snapshot,
			);
			const matchedIds = new Set(
				matchedNodes.map((node) => node.nodeInstanceId),
			);
			const matchedEdges = allEdges.filter(
				(edge) =>
					matchedIds.has(edge.fromNodeInstanceId) &&
					matchedIds.has(edge.toNodeInstanceId),
			);
			const queryHash = digestCanonical(normalizedQuery);
			const visibleMountsHash = digestCanonical(
				ctx.sourceObservation.registryContext.visibleMounts,
			);
			const resourceVersion = {
				runId,
				runVersion: resolved.run.runVersion,
			};
			const binding = {
				collection: "graph" as const,
				listenerId: requestContext.listenerId,
				principalHash: requestContext.principalHash,
				queryHash,
				sortKey: "node-instance-id" as const,
				sortDirection: "asc" as const,
				registryContext:
					ctx.sourceObservation.registryContext,
				visibleMountsHash,
				projectWatermarks: ctx.sourceObservation.watermarks,
				resourceVersion,
			};
			let after: { nodeInstanceId: string } | undefined;
			if (query.cursor) {
				if (!options.cursorCodec) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message: "page cursor verification is unavailable",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				const decoded = options.cursorCodec.decodePage(
					query.cursor,
					binding,
				);
				if (decoded.collection !== "graph") {
					throw new WebReadServiceError({
						code: "TF_INVALID_ARGUMENT",
						message:
							"cursor does not belong to the graph collection",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				after = decoded.after;
			}
			const remaining = strictlyAfterKeyset(
				matchedNodes,
				after,
				(node) => ({
					nodeInstanceId: node.nodeInstanceId,
				}),
				(left, right) =>
					left.nodeInstanceId.localeCompare(
						right.nodeInstanceId,
						"en",
					),
			);
			const built = buildBoundedWebPage({
				orderedItems: remaining,
				limit,
				maximumLimit: 2_000,
				responseBudgetBytes:
					WEB_ENDPOINTS.runGraph.responseBudgetBytes,
				keyOf: (node) => ({
					nodeInstanceId: node.nodeInstanceId,
				}),
				cursorAfter: (lastReturnedKey) => {
					if (!options.cursorCodec) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message: "page cursor signing is unavailable",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					const expiresAt = Math.min(
						ctx.observedAt + 10 * 60_000,
						requestContext.sessionAbsoluteExpiresAt,
					);
					return options.cursorCodec.encodePage({
						version: 1,
						kind: "page",
						collection: "graph",
						listenerId: requestContext.listenerId,
						principalHash: requestContext.principalHash,
						queryHash,
						sortKey: "node-instance-id",
						sortDirection: "asc",
						registryContext:
							ctx.sourceObservation.registryContext,
						visibleMountsHash,
						projectWatermarks:
							ctx.sourceObservation.watermarks,
						resourceVersion,
						after: lastReturnedKey,
						issuedAt: ctx.observedAt,
						expiresAt,
					});
				},
				envelope: (pageNodes, nextCursor) => {
					const includedIds = new Set(
						pageNodes.map((node) => node.nodeInstanceId),
					);
					const pageEdges = matchedEdges.filter(
						(edge) =>
							includedIds.has(
								edge.fromNodeInstanceId,
							) &&
							includedIds.has(edge.toNodeInstanceId),
					);
					const boundaryEdges = matchedEdges.flatMap(
						(edge) => {
							const fromIncluded = includedIds.has(
								edge.fromNodeInstanceId,
							);
							const toIncluded = includedIds.has(
								edge.toNodeInstanceId,
							);
							if (fromIncluded === toIncluded) return [];
							return [
								{
									includedNodeInstanceId:
										fromIncluded
											? edge.fromNodeInstanceId
											: edge.toNodeInstanceId,
									omittedNodeInstanceId:
										fromIncluded
											? edge.toNodeInstanceId
											: edge.fromNodeInstanceId,
									kind: edge.kind,
								},
							];
						},
					);
					return {
						ok: true as const,
						requestId: requestContext.requestId,
						schemaVersion: "web.v1" as const,
						data: {
							projectId,
							controlDomainId,
							runId,
							runVersion: resolved.run.runVersion,
							query: normalizedQuery,
							totalNodeCount: allNodes.length,
							matchedNodeCount: matchedNodes.length,
							totalEdgeCount: allEdges.length,
							matchedEdgeCount: matchedEdges.length,
							nodes: [...pageNodes],
							edges: pageEdges,
							boundaryEdges,
							...(nextCursor ? { nextCursor } : {}),
							sourceObservation:
								ctx.sourceObservation,
						},
					};
				},
			});
			return built.envelope.data;
		},

		readRunTimeline(
			projectId,
			controlDomainId,
			runId,
			query,
			requestContext,
		) {
			const ctx = context(requestContext.observedAt);
			const project = ctx.projects.find(
				(candidate) =>
					candidate.entry.projectId === projectId &&
					candidate.entry.controlDomainId === controlDomainId,
			);
			if (!project) {
				throw new WebReadServiceError({
					code: "TF_NOT_FOUND",
					message: "project control domain not found",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			if (!project.result.ok) {
				throw new WebReadServiceError({
					code: "TF_DURABILITY_FAILED",
					message: project.result.detail,
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const run = project.result.snapshot.runs.find(
				(candidate) => candidate.runId === runId,
			);
			if (!run) {
				throw new WebReadServiceError({
					code: "TF_NOT_FOUND",
					message: "Run not found",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			if (run.runVersion !== query.expectedRunVersion) {
				throw new WebReadServiceError({
					code: "TF_STALE_VERSION",
					message: `expected runVersion ${query.expectedRunVersion}, have ${run.runVersion}`,
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const inspected = inspectProjectControlEvents(
				project.entry.projectRoot,
				{
					projectId,
					controlDomainId,
					endCommitSeq:
						project.result.snapshot.nextCommitSeq - 1,
				},
			);
			if (!inspected.ok) {
				throw new WebReadServiceError({
					code:
						inspected.reason === "identity-mismatch"
							? "TF_IDENTITY_MISMATCH"
							: "TF_DURABILITY_FAILED",
					message: inspected.detail,
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const runEvents = inspected.events.filter((event) => {
				const payloadRunId = (
					event.payload as { runId?: string }
				).runId;
				return event.streamId === runId || payloadRunId === runId;
			});
			if (
				!runEvents.some(
					(event) => event.payload.type === "RunReceived",
				)
			) {
				throw new WebReadServiceError({
					code:
						project.result.snapshot.minAvailableCommitSeq > 1
							? "TF_CURSOR_EXPIRED"
							: "TF_DURABILITY_FAILED",
					message:
						"complete Run timeline is not available at the bound watermark",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const limit = query.limit ?? 50;
			const kinds = [...(query.kinds ?? [])].sort((left, right) =>
				left.localeCompare(right, "en"),
			);
			const normalizedQuery = {
				expectedRunVersion: query.expectedRunVersion,
				limit,
				kinds,
			};
			const queryHash = digestCanonical(normalizedQuery);
			const visibleMountsHash = digestCanonical(
				ctx.sourceObservation.registryContext.visibleMounts,
			);
			const resourceVersion = {
				runId,
				runVersion: run.runVersion,
			};
			const binding = {
				collection: "timeline" as const,
				listenerId: requestContext.listenerId,
				principalHash: requestContext.principalHash,
				queryHash,
				sortKey: "commit-seq" as const,
				sortDirection: "asc" as const,
				registryContext: ctx.sourceObservation.registryContext,
				visibleMountsHash,
				projectWatermarks: ctx.sourceObservation.watermarks,
				resourceVersion,
			};
			let after:
				| { commitSeq: number; eventId: string }
				| undefined;
			if (query.cursor) {
				if (!options.cursorCodec) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message: "page cursor verification is unavailable",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				const decoded = options.cursorCodec.decodePage(
					query.cursor,
					binding,
				);
				if (decoded.collection !== "timeline") {
					throw new WebReadServiceError({
						code: "TF_INVALID_ARGUMENT",
						message:
							"cursor does not belong to the timeline collection",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				after = decoded.after;
			}
			const filtered = runEvents.filter(
				(event) =>
					kinds.length === 0 ||
					kinds.includes(webTimelineKind(event.payload)),
			);
			const remaining = strictlyAfterKeyset(
				filtered,
				after,
				(event) => ({
					commitSeq: event.commitSeq,
					eventId: event.eventId,
				}),
				(left, right) =>
					left.commitSeq - right.commitSeq ||
					left.eventId.localeCompare(right.eventId, "en"),
			);
			const items = remaining.map((event) => ({
				eventId: event.eventId,
				streamId: event.streamId,
				streamSeq: event.streamSeq,
				commitSeq: event.commitSeq,
				...(event.commandId
					? { commandId: event.commandId }
					: {}),
				recordedAt: event.recordedAt,
				kind: webTimelineKind(event.payload),
				summary: webTimelineSummary(event.payload),
				artifactRefs: [],
			}));
			const built = buildBoundedWebPage({
				orderedItems: items,
				limit,
				maximumLimit: 200,
				responseBudgetBytes:
					WEB_ENDPOINTS.runTimeline.responseBudgetBytes,
				keyOf: (event) => ({
					commitSeq: event.commitSeq,
					eventId: event.eventId,
				}),
				cursorAfter: (lastReturnedKey) => {
					if (!options.cursorCodec) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message: "page cursor signing is unavailable",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					const expiresAt = Math.min(
						ctx.observedAt + 10 * 60_000,
						requestContext.sessionAbsoluteExpiresAt,
					);
					if (expiresAt <= ctx.observedAt) {
						throw new WebReadServiceError({
							code: "TF_CURSOR_EXPIRED",
							message:
								"browser session expired before page creation",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					return options.cursorCodec.encodePage({
						version: 1,
						kind: "page",
						collection: "timeline",
						listenerId: requestContext.listenerId,
						principalHash: requestContext.principalHash,
						queryHash,
						sortKey: "commit-seq",
						sortDirection: "asc",
						registryContext:
							ctx.sourceObservation.registryContext,
						visibleMountsHash,
						projectWatermarks:
							ctx.sourceObservation.watermarks,
						resourceVersion,
						after: lastReturnedKey,
						issuedAt: ctx.observedAt,
						expiresAt,
					});
				},
				envelope: (pageItems, nextCursor) => ({
					ok: true as const,
					requestId: requestContext.requestId,
					schemaVersion: "web.v1" as const,
					data: {
						items: [...pageItems],
						...(nextCursor ? { nextCursor } : {}),
						sourceObservation: ctx.sourceObservation,
					},
				}),
			});
			return built.envelope.data;
		},

		readNodeDetail(
			projectId,
			controlDomainId,
			runId,
			nodeInstanceId,
			requestContext,
		) {
			const ctx = context(requestContext.observedAt);
			const resolved = resolveRun(
				ctx,
				projectId,
				controlDomainId,
				runId,
			);
			const projectedNode = (resolved.run.nodes ?? []).find(
				(node) => node.nodeInstanceId === nodeInstanceId,
			);
			const node = webNodes(resolved.run).find(
				(candidate) =>
					candidate.nodeInstanceId === nodeInstanceId,
			);
			if (!projectedNode || !node) {
				throw new WebReadServiceError({
					code: "TF_NOT_FOUND",
					message: "Run node not found",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const boundPlan = resolved.snapshot.boundPlans.find(
				(candidate) =>
					candidate.boundPlanHash ===
					resolved.run.boundPlanHash,
			);
			if (!boundPlan) {
				throw new WebReadServiceError({
					code: "TF_DURABILITY_FAILED",
					message: "Run BoundPlan is not available",
					recoveryAction: "operator",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const definition = phaseDefinitions(
				boundPlan.program,
			).find((phase) => phase.id === projectedNode.phaseId);
			if (!definition) {
				throw new WebReadServiceError({
					code: "TF_DURABILITY_FAILED",
					message: "Run node definition is not available",
					recoveryAction: "operator",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const attempts = webAttempts(
				resolved.run,
				nodeInstanceId,
			);
			const latestAttempt =
				attempts.length > 0
					? attempts[attempts.length - 1]
					: undefined;
			const edges = graphEdges(
				resolved.run,
				boundPlan.program,
				resolved.snapshot,
			);
			const timeline = service.readRunTimeline(
				projectId,
				controlDomainId,
				runId,
				{
					expectedRunVersion: resolved.run.runVersion,
					limit: 200,
				},
				requestContext,
			);
			const outcome =
				resolved.run.status === "unknown" ||
				resolved.run.stage === "reconciling"
					? ("ambiguous" as const)
					: resolved.run.status === "cancelled"
						? ("cancelled" as const)
						: latestAttempt?.status === "still-running"
							? ("running" as const)
							: latestAttempt?.status === "completed"
								? ("completed" as const)
								: latestAttempt?.status === "failed"
									? ("failed" as const)
									: undefined;
			return {
				projectId,
				controlDomainId,
				runId,
				runVersion: resolved.run.runVersion,
				node,
				definitionId: definition.id,
				dependencyNodeInstanceIds: edges
					.filter(
						(edge) =>
							edge.toNodeInstanceId ===
							nodeInstanceId,
					)
					.map((edge) => edge.fromNodeInstanceId),
				attemptCount: attempts.length,
				attempts: {
					items: attempts.slice(0, 200),
					sourceObservation: ctx.sourceObservation,
				},
				providerObservation: {
					...(latestAttempt?.provider === undefined
						? {}
						: { provider: latestAttempt.provider }),
					jobHandlePresent:
						latestAttempt?.providerJobHandlePresent ??
						false,
					...(outcome ? { outcome } : {}),
				},
				...(latestAttempt?.startedAt === undefined
					? {}
					: { startedAt: latestAttempt.startedAt }),
				...(latestAttempt?.endedAt === undefined
					? {}
					: { endedAt: latestAttempt.endedAt }),
				inputRefs: [],
				outputRefs: [],
				cacheExplanation:
					"No durable node-level cache decision is available in this ControlStore schema.",
				linkedFragmentHashes: [],
				childNodeInstanceIds: edges
					.filter(
						(edge) =>
							edge.fromNodeInstanceId ===
							nodeInstanceId,
					)
					.map((edge) => edge.toNodeInstanceId),
				timelineEventIds: timeline.items.map(
					(event) => event.eventId,
				),
				sourceObservation: ctx.sourceObservation,
				availableActions: [],
			};
		},

		readNodeAttempts(
			projectId,
			controlDomainId,
			runId,
			nodeInstanceId,
			query,
			requestContext,
		) {
			const ctx = context(requestContext.observedAt);
			const { run } = resolveRun(
				ctx,
				projectId,
				controlDomainId,
				runId,
			);
			assertRunVersion(run, query.expectedRunVersion);
			if (
				!(run.nodes ?? []).some(
					(node) => node.nodeInstanceId === nodeInstanceId,
				)
			) {
				throw new WebReadServiceError({
					code: "TF_NOT_FOUND",
					message: "Run node not found",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const limit = query.limit ?? 50;
			const normalizedQuery = {
				expectedRunVersion: query.expectedRunVersion,
				limit,
			};
			const queryHash = digestCanonical(normalizedQuery);
			const visibleMountsHash = digestCanonical(
				ctx.sourceObservation.registryContext.visibleMounts,
			);
			const resourceVersion = {
				runId,
				runVersion: run.runVersion,
			};
			const binding = {
				collection: "attempts" as const,
				listenerId: requestContext.listenerId,
				principalHash: requestContext.principalHash,
				queryHash,
				sortKey: "attempt-ordinal" as const,
				sortDirection: "asc" as const,
				registryContext:
					ctx.sourceObservation.registryContext,
				visibleMountsHash,
				projectWatermarks: ctx.sourceObservation.watermarks,
				resourceVersion,
			};
			let after:
				| { attemptOrdinal: number; attemptId: string }
				| undefined;
			if (query.cursor) {
				if (!options.cursorCodec) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message: "page cursor verification is unavailable",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				const decoded = options.cursorCodec.decodePage(
					query.cursor,
					binding,
				);
				if (decoded.collection !== "attempts") {
					throw new WebReadServiceError({
						code: "TF_INVALID_ARGUMENT",
						message:
							"cursor does not belong to the Attempt collection",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				after = decoded.after;
			}
			const projectedAttempts = [...(run.attempts ?? [])]
				.filter(
					(attempt) =>
						attempt.nodeInstanceId === nodeInstanceId,
				)
				.sort(
					(left, right) =>
						left.attemptOrdinal - right.attemptOrdinal ||
						left.attemptId.localeCompare(
							right.attemptId,
							"en",
						),
				);
			const remaining = strictlyAfterKeyset(
				projectedAttempts,
				after,
				(attempt) => ({
					attemptOrdinal: attempt.attemptOrdinal,
					attemptId: attempt.attemptId,
				}),
				(left, right) =>
					left.attemptOrdinal - right.attemptOrdinal ||
					left.attemptId.localeCompare(
						right.attemptId,
						"en",
					),
			);
			const built = buildBoundedWebPage({
				orderedItems: remaining,
				limit,
				maximumLimit: 200,
				responseBudgetBytes:
					WEB_ENDPOINTS.nodeAttempts.responseBudgetBytes,
				keyOf: (attempt) => ({
					attemptOrdinal: attempt.attemptOrdinal,
					attemptId: attempt.attemptId,
				}),
				cursorAfter: (lastReturnedKey) => {
					if (!options.cursorCodec) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message: "page cursor signing is unavailable",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					return options.cursorCodec.encodePage({
						version: 1,
						kind: "page",
						collection: "attempts",
						listenerId: requestContext.listenerId,
						principalHash: requestContext.principalHash,
						queryHash,
						sortKey: "attempt-ordinal",
						sortDirection: "asc",
						registryContext:
							ctx.sourceObservation.registryContext,
						visibleMountsHash,
						projectWatermarks:
							ctx.sourceObservation.watermarks,
						resourceVersion,
						after: lastReturnedKey,
						issuedAt: ctx.observedAt,
						expiresAt: Math.min(
							ctx.observedAt + 10 * 60_000,
							requestContext.sessionAbsoluteExpiresAt,
						),
					});
				},
				envelope: (pageAttempts, nextCursor) => ({
					ok: true as const,
					requestId: requestContext.requestId,
					schemaVersion: "web.v1" as const,
					data: {
						items: pageAttempts.map((attempt) => ({
							attemptId: attempt.attemptId,
							nodeInstanceId:
								attempt.nodeInstanceId,
							provider: sanitizeDisplayText(
								attempt.provider ??
									"unavailable",
								"unavailable",
							),
							status: attempt.status,
							...(attempt.startedAt === undefined
								? {}
								: {
										startedAt:
											attempt.startedAt,
									}),
							...(attempt.endedAt === undefined
								? {}
								: { endedAt: attempt.endedAt }),
							providerJobHandlePresent:
								attempt.providerJobHandlePresent,
						})),
						...(nextCursor ? { nextCursor } : {}),
						sourceObservation: ctx.sourceObservation,
					},
				}),
			});
			return built.envelope.data;
		},

		readRunArtifacts(
			projectId,
			controlDomainId,
			runId,
			query,
			requestContext,
		) {
			const ctx = context(requestContext.observedAt);
			const { snapshot, run } = resolveRun(
				ctx,
				projectId,
				controlDomainId,
				runId,
			);
			assertRunVersion(run, query.expectedRunVersion);
			const receipt = snapshot.receipts.find(
				(candidate) => candidate.receiptId === run.receiptId,
			);
			if (
				query.expectedReceiptId !== undefined &&
				receipt?.receiptId !== query.expectedReceiptId
			) {
				throw new WebReadServiceError({
					code: "TF_STALE_VERSION",
					message: "expected Receipt is no longer current",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const limit = query.limit ?? 50;
			const roles = [...(query.roles ?? [])].sort((left, right) =>
				left.localeCompare(right, "en"),
			);
			const integrity = [...(query.integrity ?? [])].sort(
				(left, right) => left.localeCompare(right, "en"),
			);
			const normalizedQuery = {
				expectedRunVersion: query.expectedRunVersion,
				...(query.expectedReceiptId
					? { expectedReceiptId: query.expectedReceiptId }
					: {}),
				limit,
				roles,
				integrity,
			};
			const queryHash = digestCanonical(normalizedQuery);
			const visibleMountsHash = digestCanonical(
				ctx.sourceObservation.registryContext.visibleMounts,
			);
			const resourceVersion = {
				runId,
				runVersion: run.runVersion,
				...(receipt ? { receiptId: receipt.receiptId } : {}),
			};
			const binding = {
				collection: "artifacts" as const,
				listenerId: requestContext.listenerId,
				principalHash: requestContext.principalHash,
				queryHash,
				sortKey: "role-digest-artifact" as const,
				sortDirection: "asc" as const,
				registryContext:
					ctx.sourceObservation.registryContext,
				visibleMountsHash,
				projectWatermarks:
					ctx.sourceObservation.watermarks,
				resourceVersion,
			};
			let after:
				| {
						role: string;
						digest: string;
						artifactId: string;
				  }
				| undefined;
			if (query.cursor) {
				if (!options.cursorCodec) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message:
							"page cursor verification is unavailable",
						recoveryAction: "refresh",
						sideEffects: "none",
						projectId,
						controlDomainId,
					});
				}
				const decoded = options.cursorCodec.decodePage(
					query.cursor,
					binding,
				);
				if (decoded.collection !== "artifacts") {
					throw new WebReadServiceError({
						code: "TF_INVALID_ARGUMENT",
						message:
							"cursor does not belong to the Run artifact collection",
						recoveryAction: "refresh",
						sideEffects: "none",
						projectId,
						controlDomainId,
					});
				}
				after = decoded.after;
			}
			const refs = receipt
				? resolveReceiptArtifacts(snapshot, receipt)
						.map((artifact) =>
							projectWebArtifactRef(
								artifact,
								receipt.receiptId,
							),
						)
						.filter(
							(artifact) =>
								(roles.length === 0 ||
									roles.includes(
										artifact.role,
									)) &&
								(integrity.length === 0 ||
									integrity.includes(
										artifact.integrity,
									)),
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
						)
				: [];
			const remaining = strictlyAfterKeyset(
				refs,
				after,
				(artifact) => ({
					role: artifact.role,
					digest: artifact.digest,
					artifactId: artifact.artifactId,
				}),
				(left, right) =>
					left.role.localeCompare(right.role, "en") ||
					left.digest.localeCompare(
						right.digest,
						"en",
					) ||
					left.artifactId.localeCompare(
						right.artifactId,
						"en",
					),
			);
			const built = buildBoundedWebPage({
				orderedItems: remaining,
				limit,
				maximumLimit: 200,
				responseBudgetBytes:
					WEB_ENDPOINTS.runArtifacts.responseBudgetBytes,
				keyOf: (artifact) => ({
					role: artifact.role,
					digest: artifact.digest,
					artifactId: artifact.artifactId,
				}),
				cursorAfter: (lastReturnedKey) => {
					if (!options.cursorCodec) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message:
								"page cursor signing is unavailable",
							recoveryAction: "refresh",
							sideEffects: "none",
							projectId,
							controlDomainId,
						});
					}
					return options.cursorCodec.encodePage({
						version: 1,
						kind: "page",
						collection: "artifacts",
						listenerId:
							requestContext.listenerId,
						principalHash:
							requestContext.principalHash,
						queryHash,
						sortKey: "role-digest-artifact",
						sortDirection: "asc",
						registryContext:
							ctx.sourceObservation
								.registryContext,
						visibleMountsHash,
						projectWatermarks:
							ctx.sourceObservation.watermarks,
						resourceVersion,
						after: lastReturnedKey,
						issuedAt: ctx.observedAt,
						expiresAt: Math.min(
							ctx.observedAt + 10 * 60_000,
							requestContext.sessionAbsoluteExpiresAt,
						),
					});
				},
				envelope: (items, nextCursor) => ({
					ok: true as const,
					requestId: requestContext.requestId,
					schemaVersion: "web.v1" as const,
					data: {
						items: [...items],
						...(nextCursor
							? { nextCursor }
							: {}),
						sourceObservation:
							ctx.sourceObservation,
					},
				}),
			});
			return built.envelope.data;
		},

		readRunReceipt(
			projectId,
			controlDomainId,
			runId,
			query,
			requestContext,
		) {
			const ctx = context(requestContext.observedAt);
			const resolved = resolveRun(
				ctx,
				projectId,
				controlDomainId,
				runId,
			);
			assertRunVersion(
				resolved.run,
				query.expectedRunVersion,
			);
			const receipt = resolved.snapshot.receipts.find(
				(candidate) =>
					candidate.receiptId === query.expectedReceiptId &&
					candidate.runId === runId,
			);
			if (!receipt || resolved.run.receiptId !== receipt.receiptId) {
				throw new WebReadServiceError({
					code: "TF_STALE_VERSION",
					message: "expected Receipt is no longer current",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const inspected = inspectProjectControlEvents(
				resolved.project.entry.projectRoot,
				{
					projectId,
					controlDomainId,
					endCommitSeq:
						resolved.snapshot.nextCommitSeq - 1,
				},
			);
			if (!inspected.ok) {
				throw new WebReadServiceError({
					code: "TF_DURABILITY_FAILED",
					message: inspected.detail,
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const eventById = new Map(
				inspected.events.map((event) => [event.eventId, event]),
			);
			const manifestEvents = receipt.eventManifest.map(
				(eventId) => {
					const event = eventById.get(eventId);
					if (
						!event ||
						event.commitSeq < receipt.startCommitSeq ||
						event.commitSeq > receipt.endCommitSeq
					) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message:
								"Receipt manifest does not resolve within its committed range",
							recoveryAction: "operator",
							sideEffects: "none",
							projectId,
							controlDomainId,
						});
					}
					return event;
				},
			);
			const limit = query.limit ?? 100;
			const normalizedQuery = {
				expectedRunVersion: query.expectedRunVersion,
				expectedReceiptId: query.expectedReceiptId,
				limit,
			};
			const queryHash = digestCanonical(normalizedQuery);
			const visibleMountsHash = digestCanonical(
				ctx.sourceObservation.registryContext.visibleMounts,
			);
			const resourceVersion = {
				runId,
				runVersion: resolved.run.runVersion,
				receiptId: receipt.receiptId,
			};
			const binding = {
				collection: "receipt-manifest" as const,
				listenerId: requestContext.listenerId,
				principalHash: requestContext.principalHash,
				queryHash,
				sortKey: "commit-seq" as const,
				sortDirection: "asc" as const,
				registryContext:
					ctx.sourceObservation.registryContext,
				visibleMountsHash,
				projectWatermarks: ctx.sourceObservation.watermarks,
				resourceVersion,
			};
			let after:
				| { commitSeq: number; eventId: string }
				| undefined;
			if (query.cursor) {
				if (!options.cursorCodec) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message: "page cursor verification is unavailable",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				const decoded = options.cursorCodec.decodePage(
					query.cursor,
					binding,
				);
				if (decoded.collection !== "receipt-manifest") {
					throw new WebReadServiceError({
						code: "TF_INVALID_ARGUMENT",
						message:
							"cursor does not belong to the Receipt manifest",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				after = decoded.after;
			}
			const remaining = strictlyAfterKeyset(
				manifestEvents,
				after,
				(event) => ({
					commitSeq: event.commitSeq,
					eventId: event.eventId,
				}),
				(left, right) =>
					left.commitSeq - right.commitSeq ||
					left.eventId.localeCompare(
						right.eventId,
						"en",
					),
			);
			const projected = projectRun(
				resolved.project,
				resolved.run,
				ctx.sourceObservation,
				ctx.observedAt,
			);
			const built = buildBoundedWebPage({
				orderedItems: remaining,
				limit,
				maximumLimit: 200,
				responseBudgetBytes:
					WEB_ENDPOINTS.runReceipt.responseBudgetBytes,
				keyOf: (event) => ({
					commitSeq: event.commitSeq,
					eventId: event.eventId,
				}),
				cursorAfter: (lastReturnedKey) => {
					if (!options.cursorCodec) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message: "page cursor signing is unavailable",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					return options.cursorCodec.encodePage({
						version: 1,
						kind: "page",
						collection: "receipt-manifest",
						listenerId: requestContext.listenerId,
						principalHash: requestContext.principalHash,
						queryHash,
						sortKey: "commit-seq",
						sortDirection: "asc",
						registryContext:
							ctx.sourceObservation.registryContext,
						visibleMountsHash,
						projectWatermarks:
							ctx.sourceObservation.watermarks,
						resourceVersion,
						after: lastReturnedKey,
						issuedAt: ctx.observedAt,
						expiresAt: Math.min(
							ctx.observedAt + 10 * 60_000,
							requestContext.sessionAbsoluteExpiresAt,
						),
					});
				},
				envelope: (pageEvents, nextCursor) => ({
					ok: true as const,
					requestId: requestContext.requestId,
					schemaVersion: "web.v1" as const,
					data: {
						receipt: webReceipt(
							receipt,
							resolved.snapshot,
						),
						verification:
							projected.presentation.verification,
						artifactCount:
							receipt.artifactRefs.length,
						eventManifest: {
							items: pageEvents.map((event) => ({
								eventId: event.eventId,
								commitSeq: event.commitSeq,
								eventKind:
									webTimelineKind(
										event.payload,
									),
								eventDigest:
									digestCanonical(event),
							})),
							...(nextCursor
								? { nextCursor }
								: {}),
							sourceObservation:
								ctx.sourceObservation,
						},
						sourceObservation: ctx.sourceObservation,
					},
				}),
			});
			return built.envelope.data;
		},

		readRunWhyStale(
			projectId,
			controlDomainId,
			runId,
			query,
			requestContext,
		) {
			const ctx = context(requestContext.observedAt);
			resolveRun(ctx, projectId, controlDomainId, runId);
			return {
				targets: query.targetIds.map((targetId) => ({
					targetId,
					changedComponents: [],
					reuseDecision: "unavailable" as const,
					provenanceRefs: [],
					unavailableReason:
						"Durable cache fingerprints are not retained by this ControlStore schema.",
				})),
				sourceObservation: ctx.sourceObservation,
			};
		},

		readApprovals(query, requestContext) {
			const ctx = context(requestContext.observedAt);
			const limit = query.limit ?? 50;
			const normalizedQuery = {
				projectIds: [...(query.projectIds ?? [])].sort(
					(left, right) => left.localeCompare(right, "en"),
				),
				statuses: [...(query.statuses ?? [])].sort(
					(left, right) => left.localeCompare(right, "en"),
				),
				limit,
			};
			const queryHash = digestCanonical(normalizedQuery);
			const visibleMountsHash = digestCanonical(
				ctx.sourceObservation.registryContext.visibleMounts,
			);
			const binding = {
				collection: "approvals" as const,
				listenerId: requestContext.listenerId,
				principalHash: requestContext.principalHash,
				queryHash,
				sortKey: "created-at" as const,
				sortDirection: "desc" as const,
				registryContext:
					ctx.sourceObservation.registryContext,
				visibleMountsHash,
				projectWatermarks: ctx.sourceObservation.watermarks,
				resourceVersion: undefined,
			};
			type ApprovalKey = {
				createdAt: number;
				projectId: string;
				controlDomainId: string;
				runId: string;
				approvalRequestId: string;
			};
			const compareApprovalKey = (
				left: ApprovalKey,
				right: ApprovalKey,
			) =>
				right.createdAt - left.createdAt ||
				right.projectId.localeCompare(left.projectId, "en") ||
				right.controlDomainId.localeCompare(
					left.controlDomainId,
					"en",
				) ||
				right.runId.localeCompare(left.runId, "en") ||
				right.approvalRequestId.localeCompare(
					left.approvalRequestId,
					"en",
				);
			let after: ApprovalKey | undefined;
			if (query.cursor) {
				if (!options.cursorCodec) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message: "page cursor verification is unavailable",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				const decoded = options.cursorCodec.decodePage(
					query.cursor,
					binding,
				);
				if (decoded.collection !== "approvals") {
					throw new WebReadServiceError({
						code: "TF_INVALID_ARGUMENT",
						message:
							"cursor does not belong to the Approval collection",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				after = decoded.after;
			}
			const approvals = ctx.projects.flatMap((project) =>
				project.result.ok
					? project.result.snapshot.approvals.map(
							(approval) => ({ project, approval }),
						)
					: [],
			);
			const filtered = approvals
				.filter(({ approval }) => {
					if (
						normalizedQuery.projectIds.length > 0 &&
						!normalizedQuery.projectIds.includes(
							approval.projectId,
						)
					) {
						return false;
					}
					return (
						normalizedQuery.statuses.length === 0 ||
						normalizedQuery.statuses.includes(
							approval.status,
						)
					);
				})
				.sort((left, right) =>
					compareApprovalKey(
						{
							createdAt: left.approval.createdAt,
							projectId: left.approval.projectId,
							controlDomainId:
								left.approval.controlDomainId,
							runId: left.approval.runId,
							approvalRequestId:
								left.approval.approvalRequestId,
						},
						{
							createdAt: right.approval.createdAt,
							projectId: right.approval.projectId,
							controlDomainId:
								right.approval.controlDomainId,
							runId: right.approval.runId,
							approvalRequestId:
								right.approval.approvalRequestId,
						},
					),
				);
			const remaining = strictlyAfterKeyset(
				filtered,
				after,
				({ approval }) => ({
					createdAt: approval.createdAt,
					projectId: approval.projectId,
					controlDomainId: approval.controlDomainId,
					runId: approval.runId,
					approvalRequestId:
						approval.approvalRequestId,
				}),
				compareApprovalKey,
			);
			const summaries = remaining.map(({ project, approval }) =>
				projectApproval(
					project,
					approval,
					ctx.sourceObservation,
					ctx.observedAt,
				).summary,
			);
			const built = buildBoundedWebPage({
				orderedItems: summaries,
				limit,
				maximumLimit: 200,
				responseBudgetBytes:
					WEB_ENDPOINTS.approvals.responseBudgetBytes,
				keyOf: (summary) => ({
					createdAt: summary.createdAt,
					projectId: summary.projectId,
					controlDomainId: summary.controlDomainId,
					runId: summary.runId,
					approvalRequestId: summary.approvalRequestId,
				}),
				cursorAfter: (lastReturnedKey) => {
					if (!options.cursorCodec) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message: "page cursor signing is unavailable",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					return options.cursorCodec.encodePage({
						version: 1,
						kind: "page",
						collection: "approvals",
						listenerId: requestContext.listenerId,
						principalHash: requestContext.principalHash,
						queryHash,
						sortKey: "created-at",
						sortDirection: "desc",
						registryContext:
							ctx.sourceObservation.registryContext,
						visibleMountsHash,
						projectWatermarks:
							ctx.sourceObservation.watermarks,
						after: lastReturnedKey,
						issuedAt: ctx.observedAt,
						expiresAt: Math.min(
							ctx.observedAt + 10 * 60_000,
							requestContext.sessionAbsoluteExpiresAt,
						),
					});
				},
				envelope: (items, nextCursor) => ({
					ok: true as const,
					requestId: requestContext.requestId,
					schemaVersion: "web.v1" as const,
					data: {
						items: [...items],
						...(nextCursor ? { nextCursor } : {}),
						sourceObservation: ctx.sourceObservation,
					},
				}),
			});
			return built.envelope.data;
		},

		readApprovalDetail(
			projectId,
			controlDomainId,
			runId,
			approvalRequestId,
			requestContext,
		) {
			const ctx = context(requestContext.observedAt);
			const resolved = resolveRun(
				ctx,
				projectId,
				controlDomainId,
				runId,
			);
			const approval = resolved.snapshot.approvals.find(
				(candidate) =>
					candidate.approvalRequestId ===
						approvalRequestId &&
					candidate.runId === runId,
			);
			if (!approval) {
				throw new WebReadServiceError({
					code: "TF_NOT_FOUND",
					message: "ApprovalRequest not found",
					recoveryAction: "refresh",
					sideEffects: "none",
					projectId,
					controlDomainId,
				});
			}
			const projected = projectApproval(
				resolved.project,
				approval,
				ctx.sourceObservation,
				ctx.observedAt,
			);
			const decisionRaceState =
				approval.status === "pending"
					? ("open" as const)
					: approval.status === "expired"
						? ("expired" as const)
						: ("won" as const);
			const dispatcherHandoff =
				approval.status !== "approved"
					? ("not-started" as const)
					: resolved.run.needsOperator
						? ("failed" as const)
						: resolved.run.stage === "terminal"
							? ("accepted" as const)
							: ("pending" as const);
			return {
				summary: projected.summary,
				approvalVersion: approval.version,
				audience: [],
				decisionRaceState,
				operationClass: "generic-action",
				boundPlanHash: resolved.run.boundPlanHash,
				evidenceRefs: [],
				policyExplanation:
					"This decision was created by the durable ControlHost park-for-approval path.",
				dispatcherHandoff,
				...(projected.projected.presentation.decisionSet?.status ===
				"actionable"
					? {
							decisionPresentation:
								projected.projected.presentation.decisionSet
									.presentation,
						}
					: {}),
				sourceObservation: ctx.sourceObservation,
				availableActions: projected.projected.actions,
			};
		},

		readAttention(query, requestContext) {
			const ctx = context(requestContext.observedAt);
			const items: WebAttentionPage["items"] = [];
			for (const project of ctx.projects) {
				if (!project.result.ok) {
					items.push({
						attentionId: `attn-project-${project.entry.projectId}`,
						kind: "project-unavailable",
						projectId: project.entry.projectId,
						controlDomainId:
							project.entry.controlDomainId,
						message: contentMessage(
							"attention.project-unavailable",
						),
						recoveryAction: "refresh",
						sideEffects: "none",
						disposition: "diagnostic",
						authorityVerified: false,
						observedAt: ctx.observedAt,
						sourceObservation:
							ctx.sourceObservation,
						availableActions: [],
					});
					continue;
				}
				const pendingByRun = new Map(
					project.result.snapshot.approvals
						.filter(
							(approval) =>
								approval.status === "pending",
						)
						.map((approval) => [
							approval.runId,
							approval,
						]),
				);
				for (const run of project.result.snapshot.runs) {
					const approval = pendingByRun.get(run.runId);
					if (approval) {
						const projected = projectApproval(
							project,
							approval,
							ctx.sourceObservation,
							ctx.observedAt,
						);
						items.push({
							attentionId: `attn-${approval.approvalRequestId}`,
							kind: "needs-operator",
							projectId: run.projectId,
							controlDomainId:
								run.controlDomainId,
							runId: run.runId,
							message: contentMessage(
								"attention.decision-required",
							),
							recoveryAction: "operator",
							sideEffects: "none",
							disposition: "needs-user-input",
							authorityVerified: true,
							observedAt: ctx.observedAt,
							sourceObservation:
								ctx.sourceObservation,
							availableActions:
								projected.projected.actions,
						});
						continue;
					}
					if (
						run.status === "unknown" ||
						run.stage === "reconciling"
					) {
						items.push({
							attentionId: `attn-run-${run.runId}`,
							kind: "provider-ambiguous",
							projectId: run.projectId,
							controlDomainId:
								run.controlDomainId,
							runId: run.runId,
							message: contentMessage(
								"attention.execution-unconfirmed",
							),
							recoveryAction: "reconcile",
							sideEffects: "unknown",
							disposition: "status-only",
							authorityVerified: true,
							observedAt: ctx.observedAt,
							sourceObservation:
								ctx.sourceObservation,
							availableActions: [],
						});
					} else if (run.needsOperator) {
						items.push({
							attentionId: `attn-run-${run.runId}`,
							kind: "needs-operator",
							projectId: run.projectId,
							controlDomainId:
								run.controlDomainId,
							runId: run.runId,
							message: contentMessage(
								"attention.review-required",
							),
							recoveryAction: "operator",
							sideEffects: "unknown",
							disposition: "diagnostic",
							authorityVerified: true,
							observedAt: ctx.observedAt,
							sourceObservation:
								ctx.sourceObservation,
							availableActions: [],
						});
					}
				}
			}
			for (const reservation of host.coordinator.listReservations()) {
				if (reservation.state !== "orphan-suspect") continue;
				items.push({
					attentionId: `attn-reservation-${reservation.reservationId}`,
					kind: "orphan-suspect",
					...(reservation.projectId
						? { projectId: reservation.projectId }
						: {}),
					...(reservation.projectControlDomainId
						? {
								controlDomainId:
									reservation.projectControlDomainId,
							}
						: {}),
					...(reservation.runId
						? { runId: reservation.runId }
						: {}),
					reservationId: reservation.reservationId,
					message: contentMessage(
						"attention.execution-place-held",
					),
					recoveryAction: "operator",
					sideEffects: "unknown",
					disposition: "diagnostic",
					authorityVerified: true,
					observedAt: ctx.observedAt,
					sourceObservation: ctx.sourceObservation,
					availableActions: [],
				});
			}
			const dispositions = [...(query.dispositions ?? [])].sort(
				(left, right) => left.localeCompare(right, "en"),
			);
			const limit = query.limit ?? 50;
			const normalizedQuery = { dispositions, limit };
			const filtered = items
				.filter(
					(item) =>
						dispositions.length === 0 ||
						dispositions.includes(item.disposition),
				)
				.sort(
					(left, right) =>
						right.observedAt - left.observedAt ||
						right.attentionId.localeCompare(
							left.attentionId,
							"en",
						),
				);
			const queryHash = digestCanonical(normalizedQuery);
			const visibleMountsHash = digestCanonical(
				ctx.sourceObservation.registryContext.visibleMounts,
			);
			const binding = {
				collection: "attention" as const,
				listenerId: requestContext.listenerId,
				principalHash: requestContext.principalHash,
				queryHash,
				sortKey: "observed-at" as const,
				sortDirection: "desc" as const,
				registryContext:
					ctx.sourceObservation.registryContext,
				visibleMountsHash,
				projectWatermarks: ctx.sourceObservation.watermarks,
				resourceVersion: undefined,
			};
			let after:
				| { observedAt: number; attentionId: string }
				| undefined;
			if (query.cursor) {
				if (!options.cursorCodec) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message: "page cursor verification is unavailable",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				const decoded = options.cursorCodec.decodePage(
					query.cursor,
					binding,
				);
				if (decoded.collection !== "attention") {
					throw new WebReadServiceError({
						code: "TF_INVALID_ARGUMENT",
						message:
							"cursor does not belong to the Attention collection",
						recoveryAction: "refresh",
						sideEffects: "none",
					});
				}
				after = decoded.after;
			}
			const remaining = strictlyAfterKeyset(
				filtered,
				after,
				(item) => ({
					observedAt: item.observedAt,
					attentionId: item.attentionId,
				}),
				(left, right) =>
					right.observedAt - left.observedAt ||
					right.attentionId.localeCompare(
						left.attentionId,
						"en",
					),
			);
			const built = buildBoundedWebPage({
				orderedItems: remaining,
				limit,
				maximumLimit: 200,
				responseBudgetBytes:
					WEB_ENDPOINTS.attention.responseBudgetBytes,
				keyOf: (item) => ({
					observedAt: item.observedAt,
					attentionId: item.attentionId,
				}),
				cursorAfter: (lastReturnedKey) => {
					if (!options.cursorCodec) {
						throw new WebReadServiceError({
							code: "TF_DURABILITY_FAILED",
							message: "page cursor signing is unavailable",
							recoveryAction: "refresh",
							sideEffects: "none",
						});
					}
					return options.cursorCodec.encodePage({
						version: 1,
						kind: "page",
						collection: "attention",
						listenerId: requestContext.listenerId,
						principalHash: requestContext.principalHash,
						queryHash,
						sortKey: "observed-at",
						sortDirection: "desc",
						registryContext:
							ctx.sourceObservation.registryContext,
						visibleMountsHash,
						projectWatermarks:
							ctx.sourceObservation.watermarks,
						after: lastReturnedKey,
						issuedAt: ctx.observedAt,
						expiresAt: Math.min(
							ctx.observedAt + 10 * 60_000,
							requestContext.sessionAbsoluteExpiresAt,
						),
					});
				},
				envelope: (pageItems, nextCursor) => ({
					ok: true as const,
					requestId: requestContext.requestId,
					schemaVersion: "web.v1" as const,
					data: {
						items: [...pageItems],
						...(nextCursor ? { nextCursor } : {}),
						sourceObservation: ctx.sourceObservation,
					},
				}),
			});
			return built.envelope.data;
		},

		readPolicyExplanation(query, requestContext) {
			const ctx = context(requestContext.observedAt);
			if (query.projectId) {
				const project = ctx.projects.find(
					(candidate) =>
						candidate.entry.projectId === query.projectId,
				);
				if (!project) {
					throw new WebReadServiceError({
						code: "TF_NOT_FOUND",
						message: "project not found",
						recoveryAction: "refresh",
						sideEffects: "none",
						projectId: query.projectId,
					});
				}
				if (!project.result.ok) {
					throw new WebReadServiceError({
						code: "TF_DURABILITY_FAILED",
						message: project.result.detail,
						recoveryAction: "refresh",
						sideEffects: "none",
						projectId: query.projectId,
					});
				}
			}
			const compiled = compilePolicy({});
			const alwaysDenied = [
				"domain-transfer",
				"network",
				"cross-project",
			] as const;
			return {
				...(query.projectId
					? { projectId: query.projectId }
					: {}),
				policyHash: compiled.exposure.policyHash,
				layers: [
					{ layer: "host", present: false },
					{ layer: "user", present: false },
					{ layer: "project", present: false },
					{ layer: "invocation", present: false },
				],
				decisions: [
					...compiled.exposure.allowed.map(
						(capability) => ({
							capability,
							operation: "allow" as const,
							reason:
								"Allowed by the built-in attenuated host-default exposure.",
							sourceLayer: "host" as const,
						}),
					),
					...alwaysDenied.map((capability) => ({
						capability,
						operation: "deny" as const,
						reason:
							"Denied by the control-plane hard safety boundary.",
						sourceLayer: "host" as const,
					})),
				],
				authorityVerified: true,
				sourceObservation: ctx.sourceObservation,
			};
		},

		readCoordinator() {
			const ctx = context();
			return readCoordinatorWithContext(ctx);
		},

		readReservationDetail(reservationId) {
			const ctx = context();
			const reservation = host.coordinator.getReservation(reservationId);
			if (!reservation) {
				throw new WebReadServiceError({
					code: "TF_NOT_FOUND",
					message: "reservation not found",
					recoveryAction: "refresh",
					sideEffects: "none",
				});
			}
			return {
				reservationId: reservation.reservationId,
				state: reservation.state,
				revision: reservation.revision,
				slots: reservation.slots,
				coordinatorEpoch: reservation.coordinatorEpoch,
				...(reservation.projectId
					? { projectId: reservation.projectId }
					: {}),
				...(reservation.projectControlDomainId
					? { controlDomainId: reservation.projectControlDomainId }
					: {}),
				...(reservation.runId ? { runId: reservation.runId } : {}),
				...(reservation.projectAdmitCommitSeq
					? { projectAdmitCommitSeq: reservation.projectAdmitCommitSeq }
					: {}),
				...(reservation.attemptId
					? { attemptId: reservation.attemptId }
					: {}),
				providerJobHandlePresent:
					reservation.providerJobHandle !== undefined,
				...(reservation.reservedExpiresAt
					? { reservedExpiresAt: reservation.reservedExpiresAt }
					: {}),
				createdAt: reservation.createdAt,
				updatedAt: reservation.updatedAt,
				operatorOverridden: reservation.operatorOverridden ?? false,
				sourceObservation: ctx.sourceObservation,
			};
		},
	};
	return service;
}

export function createWebReadHandlers(
	host: ControlHost,
	options: WebReadServiceOptions = {},
): WebReadHandlerMap {
	const service = createWebReadService(host, options);
	return {
		overview: () => service.readOverview(),
		projects: ({ query }, requestContext) =>
			service.readProjects(query, requestContext),
		projectDetail: ({ params }, requestContext) =>
			service.readProjectDetail(
				params.projectId,
				params.controlDomainId,
				requestContext,
			),
		coordinator: () => service.readCoordinator(),
		reservationDetail: ({ params }) =>
			service.readReservationDetail(params.reservationId),
		runs: ({ query }, requestContext) =>
			service.readRuns(query, requestContext),
		runDetail: ({ params }, requestContext) =>
			service.readRunDetail(
				params.projectId,
				params.controlDomainId,
				params.runId,
				requestContext,
			),
		runFragments: ({ params, query }, requestContext) =>
			service.readRunFragments(
				params.projectId,
				params.controlDomainId,
				params.runId,
				query,
				requestContext,
			),
		runGraph: ({ params, query }, requestContext) =>
			service.readRunGraph(
				params.projectId,
				params.controlDomainId,
				params.runId,
				query,
				requestContext,
			),
		runTimeline: ({ params, query }, requestContext) =>
			service.readRunTimeline(
				params.projectId,
				params.controlDomainId,
				params.runId,
				query,
				requestContext,
			),
		nodeDetail: ({ params }, requestContext) =>
			service.readNodeDetail(
				params.projectId,
				params.controlDomainId,
				params.runId,
				params.nodeInstanceId,
				requestContext,
			),
		nodeAttempts: ({ params, query }, requestContext) =>
			service.readNodeAttempts(
				params.projectId,
				params.controlDomainId,
				params.runId,
				params.nodeInstanceId,
				query,
				requestContext,
			),
		runArtifacts: ({ params, query }, requestContext) =>
			service.readRunArtifacts(
				params.projectId,
				params.controlDomainId,
				params.runId,
				query,
				requestContext,
			),
		runReceipt: ({ params, query }, requestContext) =>
			service.readRunReceipt(
				params.projectId,
				params.controlDomainId,
				params.runId,
				query,
				requestContext,
			),
		runWhyStale: ({ params, query }, requestContext) =>
			service.readRunWhyStale(
				params.projectId,
				params.controlDomainId,
				params.runId,
				query,
				requestContext,
			),
		approvals: ({ query }, requestContext) =>
			service.readApprovals(query, requestContext),
		approvalDetail: ({ params }, requestContext) =>
			service.readApprovalDetail(
				params.projectId,
				params.controlDomainId,
				params.runId,
				params.approvalRequestId,
				requestContext,
			),
		attention: ({ query }, requestContext) =>
			service.readAttention(query, requestContext),
		policyExplanation: ({ query }, requestContext) =>
			service.readPolicyExplanation(query, requestContext),
	};
}

export const createInitialWebReadService = createWebReadService;
export const createInitialWebReadHandlers = createWebReadHandlers;
