/**
 * P17 browser protocol wire.
 *
 * This module is deliberately browser-safe: TypeBox only, no node:* imports,
 * stores, providers, daemon code, or executable control-plane semantics.
 */
import { type Static, type TSchema, Type } from "typebox";
import {
	ControlErrorSchema,
	ControlModeSchema,
	FORCE_RELEASE_ACKNOWLEDGEMENT,
	RunStageSchema,
	RunStatusSchema,
} from "./types.ts";
import {
	SAFE_ID_MAX_LENGTH,
	SAFE_ID_PATTERN,
} from "./validate-ids.ts";

export { FORCE_RELEASE_ACKNOWLEDGEMENT } from "./types.ts";

export const WEB_PROTOCOL_MAJOR = 1 as const;
export const WEB_SCHEMA_VERSION = "web.v1" as const;
export const WEB_DEFAULT_PAGE_LIMIT = 50 as const;
export const WEB_MAX_PAGE_LIMIT = 200 as const;

export const WEB_STREAM_STATES = [
	"connected",
	"catching-up",
	"disconnected",
] as const;
export const WEB_COVERAGE_STATES = ["complete", "partial"] as const;
export const WEB_AUTHORITY_STATES = ["verified", "unverified"] as const;
export const WEB_SORT_DIRECTIONS = ["asc", "desc"] as const;
export const WEB_RUN_SORT_KEYS = ["createdAt", "updatedAt", "status"] as const;
export const WEB_COMMAND_OUTCOMES = [
	"pending",
	"completed",
	"failed",
	"rejected",
	"not-found",
] as const;

export const WebSafeIdSchema = Type.String({
	minLength: 1,
	maxLength: SAFE_ID_MAX_LENGTH,
	pattern: SAFE_ID_PATTERN,
});
const IdSchema = WebSafeIdSchema;
const TimestampSchema = Type.Integer({ minimum: 0 });
const CommitSeqSchema = Type.Integer({ minimum: 0 });
const NonNegativeIntSchema = Type.Integer({ minimum: 0 });
const PositiveIntSchema = Type.Integer({ minimum: 1 });
const DigestSchema = Type.String({
	pattern: "^[a-z0-9][a-z0-9+.-]*:[A-Fa-f0-9]{16,}$",
});
const RequestHashSchema = Type.String({ pattern: "^[A-Fa-f0-9]{64}$" });

export function webSuccessSchema<const Data extends TSchema>(data: Data) {
	return Type.Object(
		{
			ok: Type.Literal(true),
			requestId: IdSchema,
			schemaVersion: Type.Literal(WEB_SCHEMA_VERSION),
			data,
		},
		{ additionalProperties: false },
	);
}

export const WebApiErrorResponseSchema = Type.Object(
	{
		ok: Type.Literal(false),
		requestId: IdSchema,
		schemaVersion: Type.Literal(WEB_SCHEMA_VERSION),
		error: ControlErrorSchema,
	},
	{ additionalProperties: false },
);

export const WebObservationStateSchema = Type.Object(
	{
		streamState: Type.Union(
			WEB_STREAM_STATES.map((value) => Type.Literal(value)),
		),
		coverage: Type.Union(
			WEB_COVERAGE_STATES.map((value) => Type.Literal(value)),
		),
		authority: Type.Union(
			WEB_AUTHORITY_STATES.map((value) => Type.Literal(value)),
		),
		observedAt: TimestampSchema,
		registryRevision: Type.Optional(IdSchema),
	},
	{ additionalProperties: false },
);

export const WebProjectWatermarkSchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		nextCommitSeq: CommitSeqSchema,
		minAvailableCommitSeq: CommitSeqSchema,
	},
	{ additionalProperties: false },
);

export const WEB_STATUS_SORT_RANK = {
	running: 0,
	paused: 1,
	blocked: 2,
	unknown: 3,
	failed: 4,
	cancelled: 5,
	completed: 6,
} as const;

export const WebRunPageAfterSchema = Type.Object(
	{
		/** createdAt/updatedAt milliseconds, or WEB_STATUS_SORT_RANK[status]. */
		sortValue: NonNegativeIntSchema,
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
	},
	{ additionalProperties: false },
);

/** Signed server-internal keyset page cursor; the browser receives opaque text. */
export const WebPageCursorPayloadSchema = Type.Object(
	{
		version: Type.Literal(1),
		principalHash: DigestSchema,
		registryRevision: IdSchema,
		queryHash: DigestSchema,
		sortKey: Type.Union(WEB_RUN_SORT_KEYS.map((value) => Type.Literal(value))),
		sortDirection: Type.Union(
			WEB_SORT_DIRECTIONS.map((value) => Type.Literal(value)),
		),
		projectWatermarks: Type.Array(WebProjectWatermarkSchema),
		after: Type.Optional(WebRunPageAfterSchema),
		issuedAt: TimestampSchema,
		expiresAt: TimestampSchema,
	},
	{ additionalProperties: false },
);

/** Signed server-internal SSE resume cursor; deliberately has no page keyset. */
export const WebStreamCursorPayloadSchema = Type.Object(
	{
		version: Type.Literal(1),
		principalHash: DigestSchema,
		registryRevision: IdSchema,
		projectWatermarks: Type.Array(WebProjectWatermarkSchema),
		issuedAt: TimestampSchema,
		expiresAt: TimestampSchema,
	},
	{ additionalProperties: false },
);

export const WebPageRequestSchema = Type.Object(
	{
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: WEB_MAX_PAGE_LIMIT }),
		),
		cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
	},
	{ additionalProperties: false },
);

export const WebRunListQuerySchema = Type.Object(
	{
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: WEB_MAX_PAGE_LIMIT }),
		),
		cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
		projectIds: Type.Optional(
			Type.Array(IdSchema, { maxItems: 200, uniqueItems: true }),
		),
		statuses: Type.Optional(Type.Array(RunStatusSchema, { uniqueItems: true })),
		stages: Type.Optional(Type.Array(RunStageSchema, { uniqueItems: true })),
		needsOperator: Type.Optional(Type.Boolean()),
		provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		query: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
		createdAfter: Type.Optional(TimestampSchema),
		createdBefore: Type.Optional(TimestampSchema),
		sortKey: Type.Optional(
			Type.Union(WEB_RUN_SORT_KEYS.map((value) => Type.Literal(value))),
		),
		sortDirection: Type.Optional(
			Type.Union(WEB_SORT_DIRECTIONS.map((value) => Type.Literal(value))),
		),
	},
	{ additionalProperties: false },
);

export const WebSessionExchangeRequestSchema = Type.Object(
	{
		launchToken: Type.String({
			minLength: 43,
			maxLength: 43,
			pattern: "^[A-Za-z0-9_-]{43}$",
		}),
	},
	{ additionalProperties: false },
);

export const WebSessionViewSchema = Type.Object(
	{
		csrfToken: Type.String({ minLength: 32, maxLength: 4096 }),
		idleExpiresAt: TimestampSchema,
		absoluteExpiresAt: TimestampSchema,
		hostNonce: Type.String({
			minLength: 26,
			maxLength: 26,
			pattern: "^[a-z2-7]{26}$",
		}),
	},
	{ additionalProperties: false },
);

export const WebSessionExchangeResponseSchema =
	webSuccessSchema(WebSessionViewSchema);

export const WebBootstrapViewSchema = Type.Object(
	{
		browserProtocolMajor: Type.Literal(WEB_PROTOCOL_MAJOR),
		schemaVersion: Type.Literal(WEB_SCHEMA_VERSION),
		controlMode: ControlModeSchema,
		role: Type.Union([
			Type.Literal("writer"),
			Type.Literal("attach"),
			Type.Literal("standalone-local"),
		]),
		principalId: IdSchema,
		buildInfo: Type.Object(
			{
				packageVersion: Type.String({ minLength: 1 }),
				gitCommit: Type.Optional(Type.String({ minLength: 1 })),
				controlSchemaVersion: PositiveIntSchema,
			},
			{ additionalProperties: false },
		),
		offeredFeatures: Type.Array(Type.String({ minLength: 1 }), {
			uniqueItems: true,
		}),
		observation: WebObservationStateSchema,
	},
	{ additionalProperties: false },
);

export const WebProjectSummarySchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		name: Type.String({ minLength: 1, maxLength: 512 }),
		directoryBindingLabel: Type.String({ minLength: 1, maxLength: 2048 }),
		mountState: Type.Union([
			Type.Literal("mounted"),
			Type.Literal("unmounted"),
			Type.Literal("missing"),
			Type.Literal("conflict"),
		]),
		lastActivityAt: Type.Optional(TimestampSchema),
		nextCommitSeq: Type.Optional(CommitSeqSchema),
		minAvailableCommitSeq: Type.Optional(CommitSeqSchema),
		authorityVerified: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const WebCoordinatorSummarySchema = Type.Object(
	{
		maxActiveRuns: PositiveIntSchema,
		occupyingCount: NonNegativeIntSchema,
		coordinatorEpoch: NonNegativeIntSchema,
		leaseHolderId: Type.Optional(IdSchema),
		leaseExpiresAt: Type.Optional(TimestampSchema),
		reservationCounts: Type.Object(
			{
				reserved: NonNegativeIntSchema,
				committed: NonNegativeIntSchema,
				released: NonNegativeIntSchema,
				expired: NonNegativeIntSchema,
				orphanSuspect: NonNegativeIntSchema,
			},
			{ additionalProperties: false },
		),
		observation: WebObservationStateSchema,
	},
	{ additionalProperties: false },
);

export const WebReservationDetailSchema = Type.Object(
	{
		reservationId: IdSchema,
		state: Type.Union([
			Type.Literal("reserved"),
			Type.Literal("committed"),
			Type.Literal("released"),
			Type.Literal("expired"),
			Type.Literal("orphan-suspect"),
		]),
		revision: PositiveIntSchema,
		slots: Type.Literal(1),
		coordinatorEpoch: NonNegativeIntSchema,
		projectId: Type.Optional(IdSchema),
		controlDomainId: Type.Optional(IdSchema),
		runId: Type.Optional(IdSchema),
		projectAdmitCommitSeq: Type.Optional(CommitSeqSchema),
		attemptId: Type.Optional(IdSchema),
		providerJobHandlePresent: Type.Boolean(),
		reservedExpiresAt: Type.Optional(TimestampSchema),
		createdAt: TimestampSchema,
		updatedAt: TimestampSchema,
		operatorOverridden: Type.Boolean(),
		observation: WebObservationStateSchema,
	},
	{ additionalProperties: false },
);

export const WebRunSummarySchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		status: RunStatusSchema,
		stage: RunStageSchema,
		boundPlanHash: DigestSchema,
		boundFragmentHash: Type.Optional(DigestSchema),
		provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		needsOperator: Type.Boolean(),
		runVersion: NonNegativeIntSchema,
		createdAt: TimestampSchema,
		updatedAt: TimestampSchema,
		commitSeq: CommitSeqSchema,
		receiptId: Type.Optional(IdSchema),
	},
	{ additionalProperties: false },
);

export const WebNodeSummarySchema = Type.Object(
	{
		nodeInstanceId: IdSchema,
		phaseId: IdSchema,
		phaseType: Type.String({ minLength: 1, maxLength: 128 }),
		origin: Type.Union([
			Type.Literal("bound-plan"),
			Type.Literal("bound-fragment"),
		]),
		boundFragmentHash: Type.Optional(DigestSchema),
		status: Type.String({ minLength: 1, maxLength: 128 }),
		attemptCount: NonNegativeIntSchema,
		cacheState: Type.Optional(
			Type.Union([
				Type.Literal("hit"),
				Type.Literal("miss"),
				Type.Literal("bypassed"),
			]),
		),
	},
	{ additionalProperties: false },
);

export const WebGraphEdgeSchema = Type.Object(
	{
		fromNodeInstanceId: IdSchema,
		toNodeInstanceId: IdSchema,
		kind: Type.Union([
			Type.Literal("depends-on"),
			Type.Literal("dynamic-child"),
			Type.Literal("retry-of"),
		]),
	},
	{ additionalProperties: false },
);

export const WebBoundPlanProvenanceSchema = Type.Object(
	{
		boundPlanHash: DigestSchema,
		executionSemanticHash: DigestSchema,
		programName: Type.String({ minLength: 1, maxLength: 512 }),
		irHash: Type.Optional(DigestSchema),
		approvalMode: Type.Union([
			Type.Literal("compat-auto-reject"),
			Type.Literal("durable-optional"),
			Type.Literal("durable-required"),
		]),
		grantRefs: Type.Array(IdSchema),
		createdAt: TimestampSchema,
	},
	{ additionalProperties: false },
);

export const WebBoundFragmentProvenanceSchema = Type.Object(
	{
		boundFragmentHash: DigestSchema,
		parentNodeInstanceId: IdSchema,
		originPhaseId: IdSchema,
		createdAtCommitSeq: CommitSeqSchema,
	},
	{ additionalProperties: false },
);

export const WebArtifactRefSchema = Type.Object(
	{
		digest: DigestSchema,
		size: NonNegativeIntSchema,
		mediaType: Type.String({ minLength: 1, maxLength: 512 }),
		storageClass: Type.String({ minLength: 1, maxLength: 128 }),
		redactionClass: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);

export const WebTimelineEventSchema = Type.Object(
	{
		eventId: IdSchema,
		streamId: IdSchema,
		streamSeq: PositiveIntSchema,
		commitSeq: CommitSeqSchema,
		commandId: Type.Optional(IdSchema),
		recordedAt: TimestampSchema,
		kind: Type.String({ minLength: 1, maxLength: 256 }),
		summary: Type.String({ maxLength: 32_768 }),
		artifactRefs: Type.Array(WebArtifactRefSchema),
	},
	{ additionalProperties: false },
);

export const WebTimelinePageSchema = Type.Object(
	{
		items: Type.Array(WebTimelineEventSchema),
		nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
		observation: WebObservationStateSchema,
	},
	{ additionalProperties: false },
);

export const WebAttemptSummarySchema = Type.Object(
	{
		attemptId: IdSchema,
		nodeInstanceId: IdSchema,
		provider: Type.String({ minLength: 1, maxLength: 256 }),
		status: Type.String({ minLength: 1, maxLength: 128 }),
		startedAt: Type.Optional(TimestampSchema),
		endedAt: Type.Optional(TimestampSchema),
		providerJobHandlePresent: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const WebReceiptDetailSchema = Type.Object(
	{
		receiptId: IdSchema,
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		boundPlanHash: DigestSchema,
		boundFragmentHash: Type.Optional(DigestSchema),
		eventManifest: Type.Array(IdSchema),
		startCommitSeq: CommitSeqSchema,
		endCommitSeq: CommitSeqSchema,
		artifactRefs: Type.Array(WebArtifactRefSchema),
		issuedAt: TimestampSchema,
		assurance: Type.Object(
			{
				journalContinuity: Type.Union([Type.Literal("ok"), Type.Literal("unknown")]),
				providerOutcome: Type.Union([
					Type.Literal("ok"),
					Type.Literal("failed"),
					Type.Literal("cancelled"),
					Type.Literal("unknown"),
				]),
				artifactIntegrity: Type.Union([Type.Literal("ok"), Type.Literal("unknown")]),
				provenance: Type.Union([Type.Literal("ok"), Type.Literal("unknown")]),
			},
			{ additionalProperties: false },
		),
		buildInfo: Type.Object(
			{
				packageVersion: Type.String({ minLength: 1 }),
				controlSchemaVersion: PositiveIntSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const WebWhyStaleSchema = Type.Object(
	{
		stale: Type.Boolean(),
		reasons: Type.Array(
			Type.Object(
				{
					code: Type.String({ minLength: 1, maxLength: 128 }),
					message: Type.String({ minLength: 1, maxLength: 8192 }),
					phaseId: Type.Optional(IdSchema),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const WebReplaySummarySchema = Type.Object(
	{
		replayable: Type.Boolean(),
		traceArtifact: Type.Optional(WebArtifactRefSchema),
		unreplayableReasons: Type.Array(Type.String({ minLength: 1, maxLength: 8192 })),
	},
	{ additionalProperties: false },
);

export const WebRunDetailSchema = Type.Object(
	{
		run: WebRunSummarySchema,
		boundPlan: WebBoundPlanProvenanceSchema,
		boundFragments: Type.Array(WebBoundFragmentProvenanceSchema),
		nodes: Type.Array(WebNodeSummarySchema),
		edges: Type.Array(WebGraphEdgeSchema),
		attempts: Type.Array(WebAttemptSummarySchema),
		timeline: WebTimelinePageSchema,
		artifacts: Type.Array(WebArtifactRefSchema),
		receipt: Type.Optional(WebReceiptDetailSchema),
		whyStale: WebWhyStaleSchema,
		replay: WebReplaySummarySchema,
		observation: WebObservationStateSchema,
	},
	{ additionalProperties: false },
);

export const WebApprovalSummarySchema = Type.Object(
	{
		approvalRequestId: IdSchema,
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		nodeInstanceId: IdSchema,
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("approved"),
			Type.Literal("rejected"),
			Type.Literal("edited"),
			Type.Literal("expired"),
			Type.Literal("cancelled"),
		]),
		message: Type.String({ maxLength: 32_768 }),
		allowedDecisions: Type.Array(
			Type.Union([
				Type.Literal("approve"),
				Type.Literal("reject"),
				Type.Literal("edit"),
			]),
			{ minItems: 1, uniqueItems: true },
		),
		expectedRunVersion: NonNegativeIntSchema,
		createdAt: TimestampSchema,
		deadline: TimestampSchema,
		authorityVerified: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const WebAttentionItemSchema = Type.Object(
	{
		attentionId: IdSchema,
		kind: Type.Union([
			Type.Literal("needs-operator"),
			Type.Literal("orphan-suspect"),
			Type.Literal("project-unavailable"),
			Type.Literal("provider-ambiguous"),
		]),
		projectId: Type.Optional(IdSchema),
		controlDomainId: Type.Optional(IdSchema),
		runId: Type.Optional(IdSchema),
		reservationId: Type.Optional(IdSchema),
		message: Type.String({ minLength: 1, maxLength: 32_768 }),
		recoveryAction: Type.Union([
			Type.Literal("refresh"),
			Type.Literal("reconcile"),
			Type.Literal("operator"),
			Type.Literal("none"),
		]),
		sideEffects: Type.Union([
			Type.Literal("none"),
			Type.Literal("possible"),
			Type.Literal("unknown"),
		]),
		authorityVerified: Type.Boolean(),
		observedAt: TimestampSchema,
	},
	{ additionalProperties: false },
);

export const WebPolicyExplanationSchema = Type.Object(
	{
		projectId: Type.Optional(IdSchema),
		policyHash: DigestSchema,
		layers: Type.Array(
			Type.Object(
				{
					layer: Type.Union([
						Type.Literal("host"),
						Type.Literal("user"),
						Type.Literal("project"),
						Type.Literal("invocation"),
					]),
					present: Type.Boolean(),
					digest: Type.Optional(DigestSchema),
				},
				{ additionalProperties: false },
			),
		),
		decisions: Type.Array(
			Type.Object(
				{
					capability: Type.String({ minLength: 1, maxLength: 1024 }),
					operation: Type.Union([
						Type.Literal("allow"),
						Type.Literal("deny"),
						Type.Literal("substitute"),
						Type.Literal("attenuate"),
					]),
					reason: Type.String({ minLength: 1, maxLength: 8192 }),
					sourceLayer: Type.Union([
						Type.Literal("host"),
						Type.Literal("user"),
						Type.Literal("project"),
						Type.Literal("invocation"),
					]),
				},
				{ additionalProperties: false },
			),
		),
		authorityVerified: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export function webPageSchema<const Item extends TSchema>(item: Item) {
	return Type.Object(
		{
			items: Type.Array(item),
			nextCursor: Type.Optional(
				Type.String({ minLength: 1, maxLength: 16_384 }),
			),
			observation: WebObservationStateSchema,
		},
		{ additionalProperties: false },
	);
}

export const WebProjectPageSchema = webPageSchema(WebProjectSummarySchema);
export const WebRunPageSchema = webPageSchema(WebRunSummarySchema);
export const WebApprovalPageSchema = webPageSchema(WebApprovalSummarySchema);
export const WebAttentionPageSchema = webPageSchema(WebAttentionItemSchema);

export const WebProjectRunParamsSchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
	},
	{ additionalProperties: false },
);

export const WebReservationParamsSchema = Type.Object(
	{ reservationId: IdSchema },
	{ additionalProperties: false },
);

export const WebPolicyExplanationQuerySchema = Type.Object(
	{ projectId: Type.Optional(IdSchema) },
	{ additionalProperties: false },
);

export const WebBootstrapResponseSchema = webSuccessSchema(
	WebBootstrapViewSchema,
);
export const WebProjectPageResponseSchema =
	webSuccessSchema(WebProjectPageSchema);
export const WebCoordinatorSummaryResponseSchema = webSuccessSchema(
	WebCoordinatorSummarySchema,
);
export const WebReservationDetailResponseSchema = webSuccessSchema(
	WebReservationDetailSchema,
);
export const WebRunPageResponseSchema = webSuccessSchema(WebRunPageSchema);
export const WebRunDetailResponseSchema = webSuccessSchema(WebRunDetailSchema);
export const WebApprovalPageResponseSchema = webSuccessSchema(
	WebApprovalPageSchema,
);
export const WebAttentionPageResponseSchema = webSuccessSchema(
	WebAttentionPageSchema,
);
export const WebPolicyExplanationResponseSchema = webSuccessSchema(
	WebPolicyExplanationSchema,
);

const ProjectCommandIdentity = {
	commandId: IdSchema,
	projectId: IdSchema,
	controlDomainId: IdSchema,
	runId: IdSchema,
	expectedRunVersion: NonNegativeIntSchema,
};

export const WebApproveCommandSchema = Type.Object(
	{
		...ProjectCommandIdentity,
		kind: Type.Literal("approve"),
		approvalRequestId: IdSchema,
	},
	{ additionalProperties: false },
);

export const WebRejectCommandSchema = Type.Object(
	{
		...ProjectCommandIdentity,
		kind: Type.Literal("reject"),
		approvalRequestId: IdSchema,
		reason: Type.Optional(Type.String({ maxLength: 8192 })),
	},
	{ additionalProperties: false },
);

export const WebEditApprovalCommandSchema = Type.Object(
	{
		...ProjectCommandIdentity,
		kind: Type.Literal("edit-approval"),
		approvalRequestId: IdSchema,
		editKind: Type.Union([Type.Literal("output"), Type.Literal("plan")]),
		editArtifactDigest: DigestSchema,
	},
	{ additionalProperties: false },
);

export const WebCancelRunCommandSchema = Type.Object(
	{
		...ProjectCommandIdentity,
		kind: Type.Literal("cancel-run"),
		reason: Type.Optional(Type.String({ maxLength: 8192 })),
	},
	{ additionalProperties: false },
);

export const WebResumeRunCommandSchema = Type.Object(
	{
		...ProjectCommandIdentity,
		kind: Type.Literal("resume-run"),
	},
	{ additionalProperties: false },
);

export const WebRecomputeRunCommandSchema = Type.Object(
	{
		...ProjectCommandIdentity,
		kind: Type.Literal("recompute-run"),
		phaseIds: Type.Array(IdSchema, {
			minItems: 1,
			maxItems: 1024,
			uniqueItems: true,
		}),
	},
	{ additionalProperties: false },
);

export const WebReconcileRunCommandSchema = Type.Object(
	{
		...ProjectCommandIdentity,
		kind: Type.Literal("reconcile-run"),
	},
	{ additionalProperties: false },
);

export const WebSetMaxActiveRunsCommandSchema = Type.Object(
	{
		commandId: IdSchema,
		kind: Type.Literal("set-max-active-runs"),
		value: PositiveIntSchema,
		expectedMaxActiveRuns: PositiveIntSchema,
		expectedCoordinatorEpoch: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

export const WebForceReleaseCommandSchema = Type.Object(
	{
		commandId: IdSchema,
		kind: Type.Literal("force-release"),
		reservationId: IdSchema,
		expectedState: Type.Union([
			Type.Literal("committed"),
			Type.Literal("orphan-suspect"),
		]),
		expectedRevision: PositiveIntSchema,
		expectedCoordinatorEpoch: NonNegativeIntSchema,
		expectedProjectId: IdSchema,
		expectedControlDomainId: IdSchema,
		expectedRunId: IdSchema,
		acknowledgement: Type.Literal(FORCE_RELEASE_ACKNOWLEDGEMENT),
	},
	{ additionalProperties: false },
);

export const WebCommandRequestSchema = Type.Union([
	WebApproveCommandSchema,
	WebRejectCommandSchema,
	WebEditApprovalCommandSchema,
	WebCancelRunCommandSchema,
	WebResumeRunCommandSchema,
	WebRecomputeRunCommandSchema,
	WebReconcileRunCommandSchema,
	WebSetMaxActiveRunsCommandSchema,
	WebForceReleaseCommandSchema,
]);

const WebKnownCommandIdentity = {
	commandId: IdSchema,
	requestHash: RequestHashSchema,
	kind: Type.String({ minLength: 1, maxLength: 256 }),
	projectId: Type.Optional(IdSchema),
	controlDomainId: Type.Optional(IdSchema),
	runId: Type.Optional(IdSchema),
	firstCommitSeq: CommitSeqSchema,
	lastCommitSeq: CommitSeqSchema,
	observedAt: TimestampSchema,
};

export const WebPendingCommandOutcomeSchema = Type.Object(
	{
		...WebKnownCommandIdentity,
		status: Type.Literal("pending"),
	},
	{ additionalProperties: false },
);

export const WebCompletedCommandOutcomeSchema = Type.Object(
	{
		...WebKnownCommandIdentity,
		status: Type.Literal("completed"),
		run: Type.Optional(WebRunSummarySchema),
	},
	{ additionalProperties: false },
);

export const WebFailedCommandOutcomeSchema = Type.Object(
	{
		...WebKnownCommandIdentity,
		status: Type.Literal("failed"),
		error: ControlErrorSchema,
		run: Type.Optional(WebRunSummarySchema),
	},
	{ additionalProperties: false },
);

export const WebRejectedCommandOutcomeSchema = Type.Object(
	{
		...WebKnownCommandIdentity,
		status: Type.Literal("rejected"),
		error: ControlErrorSchema,
	},
	{ additionalProperties: false },
);

export const WebCommandNotFoundOutcomeSchema = Type.Object(
	{
		commandId: IdSchema,
		status: Type.Literal("not-found"),
		observedAt: TimestampSchema,
	},
	{ additionalProperties: false },
);

export const WebCommandOutcomeSchema = Type.Union([
	WebPendingCommandOutcomeSchema,
	WebCompletedCommandOutcomeSchema,
	WebFailedCommandOutcomeSchema,
	WebRejectedCommandOutcomeSchema,
	WebCommandNotFoundOutcomeSchema,
]);

export const WebCommandResponseSchema = webSuccessSchema(
	WebCommandOutcomeSchema,
);
export const WebCommandQueryParamsSchema = Type.Object(
	{ commandId: IdSchema },
	{ additionalProperties: false },
);

export const WebEventStreamQuerySchema = Type.Object(
	{
		cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
		projectIds: Type.Optional(
			Type.Array(IdSchema, { maxItems: 200, uniqueItems: true }),
		),
	},
	{ additionalProperties: false },
);

const WebStreamFrameBase = {
	id: Type.String({ minLength: 1, maxLength: 16_384 }),
	cursor: Type.String({ minLength: 1, maxLength: 16_384 }),
	observedAt: TimestampSchema,
};

export const WebStreamCheckpointFrameSchema = Type.Object(
	{
		...WebStreamFrameBase,
		type: Type.Literal("checkpoint"),
		registryRevision: IdSchema,
		projectWatermarks: Type.Array(WebProjectWatermarkSchema),
	},
	{ additionalProperties: false },
);

export const WebStreamChangeFrameSchema = Type.Object(
	{
		...WebStreamFrameBase,
		type: Type.Literal("change"),
		kind: Type.String({ minLength: 1, maxLength: 256 }),
		resourceType: Type.String({ minLength: 1, maxLength: 128 }),
		resourceId: IdSchema,
		projectId: Type.Optional(IdSchema),
		controlDomainId: Type.Optional(IdSchema),
		commitSeq: Type.Optional(CommitSeqSchema),
		registryRevision: Type.Optional(IdSchema),
	},
	{ additionalProperties: false },
);

export const WebStreamHeartbeatFrameSchema = Type.Object(
	{
		...WebStreamFrameBase,
		type: Type.Literal("heartbeat"),
	},
	{ additionalProperties: false },
);

export const WebStreamResetFrameSchema = Type.Object(
	{
		...WebStreamFrameBase,
		type: Type.Literal("reset-required"),
		error: ControlErrorSchema,
	},
	{ additionalProperties: false },
);

export const WebStreamFrameSchema = Type.Union([
	WebStreamCheckpointFrameSchema,
	WebStreamChangeFrameSchema,
	WebStreamHeartbeatFrameSchema,
	WebStreamResetFrameSchema,
]);

export const WebArtifactParamsSchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		digest: DigestSchema,
	},
	{ additionalProperties: false },
);

export const WebArtifactMetadataSchema = Type.Object(
	{
		digest: DigestSchema,
		size: NonNegativeIntSchema,
		mediaType: Type.String({ minLength: 1, maxLength: 512 }),
		fileName: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
		redactionClass: Type.String({ minLength: 1, maxLength: 128 }),
		contentDisposition: Type.Union([
			Type.Literal("inline"),
			Type.Literal("attachment"),
		]),
	},
	{ additionalProperties: false },
);

export type WebApiErrorResponse = Static<typeof WebApiErrorResponseSchema>;
export type WebObservationState = Static<typeof WebObservationStateSchema>;
export type WebPageCursorPayload = Static<typeof WebPageCursorPayloadSchema>;
export type WebStreamCursorPayload = Static<typeof WebStreamCursorPayloadSchema>;
export type WebRunListQuery = Static<typeof WebRunListQuerySchema>;
export type WebSessionExchangeRequest = Static<
	typeof WebSessionExchangeRequestSchema
>;
export type WebSessionView = Static<typeof WebSessionViewSchema>;
export type WebBootstrapView = Static<typeof WebBootstrapViewSchema>;
export type WebProjectSummary = Static<typeof WebProjectSummarySchema>;
export type WebCoordinatorSummary = Static<typeof WebCoordinatorSummarySchema>;
export type WebReservationDetail = Static<typeof WebReservationDetailSchema>;
export type WebRunSummary = Static<typeof WebRunSummarySchema>;
export type WebRunDetail = Static<typeof WebRunDetailSchema>;
export type WebApprovalSummary = Static<typeof WebApprovalSummarySchema>;
export type WebAttentionItem = Static<typeof WebAttentionItemSchema>;
export type WebPolicyExplanation = Static<typeof WebPolicyExplanationSchema>;
export type WebCommandRequest = Static<typeof WebCommandRequestSchema>;
export type WebCommandOutcome = Static<typeof WebCommandOutcomeSchema>;
export type WebStreamFrame = Static<typeof WebStreamFrameSchema>;
export type WebArtifactMetadata = Static<typeof WebArtifactMetadataSchema>;
