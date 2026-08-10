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

const IdSchema = Type.String({ minLength: 1, maxLength: 256 });
const TimestampSchema = Type.Integer({ minimum: 0 });
const CommitSeqSchema = Type.Integer({ minimum: 0 });
const NonNegativeIntSchema = Type.Integer({ minimum: 0 });
const PositiveIntSchema = Type.Integer({ minimum: 1 });
const DigestSchema = Type.String({
	pattern: "^[a-z0-9][a-z0-9+.-]*:[A-Fa-f0-9]{16,}$",
});

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

/** Server-internal signed payload; the browser only receives its opaque encoding. */
export const WebAggregateCursorPayloadSchema = Type.Object(
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

export const WebRunSummarySchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		status: RunStatusSchema,
		stage: RunStageSchema,
		boundPlanHash: IdSchema,
		boundFragmentHash: Type.Optional(IdSchema),
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
		boundFragmentHash: Type.Optional(IdSchema),
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

export const WebReceiptSummarySchema = Type.Object(
	{
		receiptId: IdSchema,
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		boundPlanHash: IdSchema,
		boundFragmentHash: Type.Optional(IdSchema),
		startCommitSeq: CommitSeqSchema,
		endCommitSeq: CommitSeqSchema,
		issuedAt: TimestampSchema,
		providerOutcome: Type.Union([
			Type.Literal("ok"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
			Type.Literal("unknown"),
		]),
		artifactIntegrity: Type.Union([
			Type.Literal("ok"),
			Type.Literal("unknown"),
		]),
	},
	{ additionalProperties: false },
);

export const WebRunDetailSchema = Type.Object(
	{
		run: WebRunSummarySchema,
		nodes: Type.Array(WebNodeSummarySchema),
		attempts: Type.Array(WebAttemptSummarySchema),
		receipt: Type.Optional(WebReceiptSummarySchema),
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

export const WebPolicyExplanationQuerySchema = Type.Object(
	{ projectId: Type.Optional(IdSchema) },
	{ additionalProperties: false },
);

export const WebBootstrapResponseSchema = webSuccessSchema(
	WebBootstrapViewSchema,
);
export const WebProjectPageResponseSchema =
	webSuccessSchema(WebProjectPageSchema);
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

export const WebCommandOutcomeSchema = Type.Object(
	{
		commandId: IdSchema,
		status: Type.Union(
			WEB_COMMAND_OUTCOMES.map((value) => Type.Literal(value)),
		),
		requestHash: Type.Optional(DigestSchema),
		kind: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		projectId: Type.Optional(IdSchema),
		controlDomainId: Type.Optional(IdSchema),
		runId: Type.Optional(IdSchema),
		firstCommitSeq: Type.Optional(CommitSeqSchema),
		lastCommitSeq: Type.Optional(CommitSeqSchema),
		run: Type.Optional(WebRunSummarySchema),
		error: Type.Optional(ControlErrorSchema),
		observedAt: TimestampSchema,
	},
	{ additionalProperties: false },
);

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
export type WebAggregateCursorPayload = Static<
	typeof WebAggregateCursorPayloadSchema
>;
export type WebRunListQuery = Static<typeof WebRunListQuerySchema>;
export type WebSessionExchangeRequest = Static<
	typeof WebSessionExchangeRequestSchema
>;
export type WebSessionView = Static<typeof WebSessionViewSchema>;
export type WebBootstrapView = Static<typeof WebBootstrapViewSchema>;
export type WebProjectSummary = Static<typeof WebProjectSummarySchema>;
export type WebRunSummary = Static<typeof WebRunSummarySchema>;
export type WebRunDetail = Static<typeof WebRunDetailSchema>;
export type WebApprovalSummary = Static<typeof WebApprovalSummarySchema>;
export type WebAttentionItem = Static<typeof WebAttentionItemSchema>;
export type WebPolicyExplanation = Static<typeof WebPolicyExplanationSchema>;
export type WebCommandRequest = Static<typeof WebCommandRequestSchema>;
export type WebCommandOutcome = Static<typeof WebCommandOutcomeSchema>;
export type WebStreamFrame = Static<typeof WebStreamFrameSchema>;
export type WebArtifactMetadata = Static<typeof WebArtifactMetadataSchema>;
