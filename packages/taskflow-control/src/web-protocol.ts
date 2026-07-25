/**
 * P17 browser protocol wire.
 *
 * This module is deliberately browser-safe: TypeBox only, no node:* imports,
 * stores, providers, daemon code, or executable control-plane semantics.
 */
import { type Static, type TLiteral, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
	FORCE_RELEASE_ACKNOWLEDGEMENT,
	RunStageSchema,
	RunStatusSchema,
} from "./types.ts";
import {
	SAFE_ID_MAX_LENGTH,
	SAFE_ID_PATTERN,
} from "./validate-ids.ts";
import {
	WEB_COMMAND_KINDS,
	WEB_CONTENT_CATALOG_VERSION,
	WEB_DEFAULT_LOCALE,
	WEB_FEATURE_IDS,
	WEB_SUPPORTED_LOCALES,
	type WebFeatureId,
	WebAvailableActionSchema,
	WebCommandKindSchema,
	WebControlErrorSchema,
	WebContentMessageSchema,
	WebDecisionPresentationSchema,
	WebFeatureIdSchema,
	WebRegistryContextSchema,
	WebSourceObservationSchema,
	WebTaskPresentationSchema,
	WebTaskPresentationConsumerSchema,
	WebTaskPresentationSummarySchema,
	WebTaskPresentationSummaryConsumerSchema,
	WebVerificationCheckStateSchema,
	WebVerificationPresentationSchema,
	webAdditiveConsumerSchema,
} from "./web-presentation-schema.ts";
import {
	WebCommitSeqSchema,
	WebNonNegativeSafeIntegerSchema,
	WebPositiveSafeIntegerSchema,
	WebTimestampSchema,
} from "./web-schema-primitives.ts";

export { FORCE_RELEASE_ACKNOWLEDGEMENT } from "./types.ts";
export * from "./web-presentation-schema.ts";

export const WEB_PROTOCOL_MAJOR = 1 as const;
export const WEB_PROTOCOL_MINOR = 0 as const;
export const WEB_SCHEMA_VERSION = "web.v1" as const;
export const WEB_DEFAULT_PAGE_LIMIT = 50 as const;
export const WEB_MAX_PAGE_LIMIT = 200 as const;
export const WEB_GRAPH_DEFAULT_PAGE_LIMIT = 500 as const;
export const WEB_GRAPH_MAX_PAGE_LIMIT = 2_000 as const;
export const WEB_GRAPH_MAX_EDGES_PER_PAGE = 4_000 as const;
export const WEB_CURSOR_MAX_BYTES = 8_192 as const;
export const WEB_POLLING_MIN_INTERVAL_MS = 3_000 as const;
export const WEB_POLLING_MAX_INTERVAL_MS = 60_000 as const;
export const WEB_RESPONSE_BUDGET = {
	ordinaryJson: 2 * 1024 * 1024,
	runDetail: 4 * 1024 * 1024,
	graph: 8 * 1024 * 1024,
	analysis: 4 * 1024 * 1024,
	absoluteJson: 8 * 1024 * 1024,
} as const;

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

function webLiteralUnion<
	const Values extends readonly [string, ...string[]],
>(values: Values) {
	return Type.Union(
		values.map((value) => Type.Literal(value)) as [
			TLiteral<Values[number]>,
			...TLiteral<Values[number]>[],
		],
	);
}

export const WebSafeIdSchema = Type.String({
	minLength: 1,
	maxLength: SAFE_ID_MAX_LENGTH,
	pattern: SAFE_ID_PATTERN,
});
const IdSchema = WebSafeIdSchema;
const TimestampSchema = WebTimestampSchema;
const CommitSeqSchema = WebCommitSeqSchema;
const NonNegativeIntSchema = WebNonNegativeSafeIntegerSchema;
const PositiveIntSchema = WebPositiveSafeIntegerSchema;
const WEB_DIGEST_PATTERN = "^[a-z0-9][a-z0-9+.-]*:[A-Fa-f0-9]{16,}$";
const DigestSchema = Type.String({
	minLength: 18,
	maxLength: 256,
	pattern: WEB_DIGEST_PATTERN,
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
		error: WebControlErrorSchema,
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

export const WebProjectPageAfterSchema = Type.Object(
	{ projectId: IdSchema, controlDomainId: IdSchema },
	{ additionalProperties: false },
);
export const WebFragmentPageAfterSchema = Type.Object(
	{
		createdAtCommitSeq: CommitSeqSchema,
		boundFragmentHash: DigestSchema,
	},
	{ additionalProperties: false },
);
export const WebGraphPageAfterSchema = Type.Object(
	{ nodeInstanceId: IdSchema },
	{ additionalProperties: false },
);
export const WebTimelinePageAfterSchema = Type.Object(
	{ commitSeq: CommitSeqSchema, eventId: IdSchema },
	{ additionalProperties: false },
);
export const WebAttemptPageAfterSchema = Type.Object(
	{ attemptOrdinal: NonNegativeIntSchema, attemptId: IdSchema },
	{ additionalProperties: false },
);
export const WebArtifactPageAfterSchema = Type.Object(
	{ role: IdSchema, digest: DigestSchema, artifactId: IdSchema },
	{ additionalProperties: false },
);
export const WebReceiptManifestPageAfterSchema = Type.Object(
	{ commitSeq: CommitSeqSchema, eventId: IdSchema },
	{ additionalProperties: false },
);
export const WebApprovalPageAfterSchema = Type.Object(
	{
		createdAt: TimestampSchema,
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		approvalRequestId: IdSchema,
	},
	{ additionalProperties: false },
);
export const WebAttentionPageAfterSchema = Type.Object(
	{ observedAt: TimestampSchema, attentionId: IdSchema },
	{ additionalProperties: false },
);

const WebPageCursorCommon = {
	version: Type.Literal(1),
	kind: Type.Literal("page"),
	listenerId: IdSchema,
	principalHash: DigestSchema,
	queryHash: DigestSchema,
	registryMode: Type.Union([
		Type.Literal("auto"),
		Type.Literal("standalone"),
	]),
	registryRevision: IdSchema,
	registryContextHash: DigestSchema,
	visibleMountsHash: DigestSchema,
	projectWatermarksHash: DigestSchema,
	resourceVersion: Type.Optional(
		Type.Object(
			{
				runId: IdSchema,
				runVersion: NonNegativeIntSchema,
				receiptId: Type.Optional(IdSchema),
			},
			{ additionalProperties: false },
		),
	),
	issuedAt: TimestampSchema,
	expiresAt: TimestampSchema,
};

function webPageCursorVariant<
	const Collection extends string,
	const SortKey extends string,
	const Direction extends "asc" | "desc",
	const After extends TSchema,
>(
	collection: Collection,
	sortKey: SortKey,
	sortDirection: Direction | TSchema,
	after: After,
) {
	return Type.Object(
		{
			...WebPageCursorCommon,
			collection: Type.Literal(collection),
			sortKey: Type.Literal(sortKey),
			sortDirection:
				typeof sortDirection === "string"
					? Type.Literal(sortDirection)
					: sortDirection,
			after: Type.Optional(after),
		},
		{ additionalProperties: false },
	);
}

/**
 * Signed server-internal keyset page cursor; the browser receives opaque text.
 * The discriminant closes every collection over its own total-order keyset.
 */
export const WebPageCursorPayloadSchema = Type.Union([
	webPageCursorVariant(
		"projects",
		"project-id",
		"asc",
		WebProjectPageAfterSchema,
	),
	Type.Object(
		{
			...WebPageCursorCommon,
			collection: Type.Literal("runs"),
			sortKey: webLiteralUnion(WEB_RUN_SORT_KEYS),
			sortDirection: webLiteralUnion(WEB_SORT_DIRECTIONS),
			after: Type.Optional(WebRunPageAfterSchema),
		},
		{ additionalProperties: false },
	),
	webPageCursorVariant(
		"fragments",
		"created-commit",
		"asc",
		WebFragmentPageAfterSchema,
	),
	webPageCursorVariant(
		"graph",
		"node-instance-id",
		"asc",
		WebGraphPageAfterSchema,
	),
	webPageCursorVariant(
		"timeline",
		"commit-seq",
		"asc",
		WebTimelinePageAfterSchema,
	),
	webPageCursorVariant(
		"attempts",
		"attempt-ordinal",
		"asc",
		WebAttemptPageAfterSchema,
	),
	webPageCursorVariant(
		"artifacts",
		"role-digest-artifact",
		"asc",
		WebArtifactPageAfterSchema,
	),
	webPageCursorVariant(
		"receipt-manifest",
		"commit-seq",
		"asc",
		WebReceiptManifestPageAfterSchema,
	),
	webPageCursorVariant(
		"approvals",
		"created-at",
		"desc",
		WebApprovalPageAfterSchema,
	),
	webPageCursorVariant(
		"attention",
		"observed-at",
		"desc",
		WebAttentionPageAfterSchema,
	),
]);

/** Signed server-internal SSE resume cursor; deliberately has no page keyset. */
export const WebStreamCursorPayloadSchema = Type.Object(
	{
		version: Type.Literal(1),
		kind: Type.Literal("stream"),
		listenerId: IdSchema,
		principalHash: DigestSchema,
		registryMode: Type.Union([
			Type.Literal("auto"),
			Type.Literal("standalone"),
		]),
		registryRevision: IdSchema,
		registryContextHash: DigestSchema,
		visibleMountsHash: DigestSchema,
		projectIdentityHash: DigestSchema,
		projectPositions: Type.Array(NonNegativeIntSchema, {
			maxItems: WEB_MAX_PAGE_LIMIT,
		}),
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
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
	},
	{ additionalProperties: false },
);

export const WebRunListQuerySchema = Type.Object(
	{
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: WEB_MAX_PAGE_LIMIT }),
		),
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
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
		sortKey: Type.Optional(webLiteralUnion(WEB_RUN_SORT_KEYS)),
		sortDirection: Type.Optional(
			webLiteralUnion(WEB_SORT_DIRECTIONS),
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
		browserProtocolMinor: Type.Literal(WEB_PROTOCOL_MINOR),
		protocolConsumerRange: Type.Object(
			{
				major: Type.Literal(WEB_PROTOCOL_MAJOR),
				minMinor: NonNegativeIntSchema,
				maxMinor: NonNegativeIntSchema,
			},
			{ additionalProperties: false },
		),
		schemaVersion: Type.Literal(WEB_SCHEMA_VERSION),
		contentCatalogVersion: Type.Literal(WEB_CONTENT_CATALOG_VERSION),
		defaultLocale: Type.Literal(WEB_DEFAULT_LOCALE),
		supportedLocales: Type.Tuple([
			Type.Literal(WEB_SUPPORTED_LOCALES[0]),
			Type.Literal(WEB_SUPPORTED_LOCALES[1]),
		]),
		contentKeysetDigests: Type.Object(
			{
				projected: DigestSchema,
				static: DigestSchema,
				combined: DigestSchema,
			},
			{ additionalProperties: false },
		),
		listenerId: IdSchema,
		mode: Type.Union([Type.Literal("auto"), Type.Literal("standalone")]),
		role: Type.Union([
			Type.Literal("writer"),
			Type.Literal("attach"),
			Type.Literal("standalone-local"),
		]),
		principalId: IdSchema,
		principalDisplayName: Type.String({ minLength: 1, maxLength: 512 }),
		csrfToken: Type.String({ minLength: 32, maxLength: 4096 }),
		sessionIdleExpiresAt: TimestampSchema,
		sessionAbsoluteExpiresAt: TimestampSchema,
		buildInfo: Type.Object(
			{
				packageVersion: Type.String({ minLength: 1 }),
				gitCommit: Type.Optional(Type.String({ minLength: 1 })),
				controlSchemaVersion: PositiveIntSchema,
			},
			{ additionalProperties: false },
		),
		supportedFeatures: Type.Array(WebFeatureIdSchema, {
			uniqueItems: true,
			maxItems: WEB_FEATURE_IDS.length,
		}),
		supportedCommands: Type.Array(WebCommandKindSchema, {
			uniqueItems: true,
			maxItems: WEB_COMMAND_KINDS.length,
		}),
		pollingMinIntervalMs: Type.Integer({
			minimum: WEB_POLLING_MIN_INTERVAL_MS,
			maximum: WEB_POLLING_MAX_INTERVAL_MS,
		}),
		registryContext: WebRegistryContextSchema,
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false },
);

export const WebProjectSummarySchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		displayName: Type.String({ minLength: 1, maxLength: 512 }),
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
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false, "x-web-additive": true },
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
		sourceObservation: WebSourceObservationSchema,
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
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false },
);

export const WebRunSummarySchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		workspaceDisplayName: Type.String({ minLength: 1, maxLength: 512 }),
		displayTitle: Type.String({ minLength: 1, maxLength: 512 }),
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
		presentation: WebTaskPresentationSummarySchema,
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false, "x-web-additive": true },
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

export const WebArtifactDisclosureSchema = Type.Union([
	Type.Object(
		{
			access: Type.Literal("direct"),
			action: WebContentMessageSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			access: Type.Literal("acknowledgement-required"),
			question: WebContentMessageSchema,
			impact: WebContentMessageSchema,
			confirm: WebContentMessageSchema,
			decline: WebContentMessageSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			access: Type.Literal("blocked"),
			headline: WebContentMessageSchema,
			detail: WebContentMessageSchema,
		},
		{ additionalProperties: false },
	),
]);

export const WebArtifactRefSchema = Type.Object(
	{
		artifactId: IdSchema,
		role: IdSchema,
		digest: DigestSchema,
		size: NonNegativeIntSchema,
		mediaType: Type.String({ minLength: 1, maxLength: 512 }),
		storageClass: Type.Literal("control-store"),
		redactionClass: webLiteralUnion([
			"public",
			"project",
			"sensitive",
			"secret",
		]),
		receiptId: Type.Optional(IdSchema),
		integrity: WebVerificationCheckStateSchema,
		disclosure: WebArtifactDisclosureSchema,
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
		summary: WebContentMessageSchema,
		artifactRefs: Type.Array(WebArtifactRefSchema, { maxItems: 200 }),
	},
	{ additionalProperties: false },
);

export const WebTimelinePageSchema = Type.Object(
	{
		items: Type.Array(WebTimelineEventSchema, {
			maxItems: WEB_MAX_PAGE_LIMIT,
		}),
		nextCursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
		sourceObservation: WebSourceObservationSchema,
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
		eventManifest: Type.Array(IdSchema, { maxItems: 200 }),
		startCommitSeq: CommitSeqSchema,
		endCommitSeq: CommitSeqSchema,
		artifactRefs: Type.Array(WebArtifactRefSchema, { maxItems: 200 }),
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

const WebWhyStaleReasonSchema = Type.Object(
	{
		code: Type.String({ minLength: 1, maxLength: 128 }),
		message: Type.String({ minLength: 1, maxLength: 8192 }),
		phaseId: Type.Optional(IdSchema),
	},
	{ additionalProperties: false },
);

/**
 * Run-detail why-stale summary.
 *
 * Absence of cache fingerprint evidence is not evidence that a Run is fresh.
 * Keep that state explicit so the Simple projection cannot turn an
 * implementation gap into a false reusable/fresh claim.
 */
export const WebWhyStaleSchema = Type.Union([
	Type.Object(
		{
			availability: Type.Literal("available"),
			stale: Type.Boolean(),
			reasons: Type.Array(WebWhyStaleReasonSchema, { maxItems: 200 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			availability: Type.Literal("unavailable"),
			unavailableReason: Type.String({ minLength: 1, maxLength: 8192 }),
			reasons: Type.Array(WebWhyStaleReasonSchema, {
				maxItems: 0,
			}),
		},
		{ additionalProperties: false },
	),
]);

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
		workspaceDisplayName: Type.String({ minLength: 1, maxLength: 512 }),
		displayTitle: Type.String({ minLength: 1, maxLength: 512 }),
		boundPlan: WebBoundPlanProvenanceSchema,
		boundFragments: Type.Array(WebBoundFragmentProvenanceSchema, {
			maxItems: 200,
		}),
		nodes: Type.Array(WebNodeSummarySchema, {
			maxItems: WEB_GRAPH_MAX_PAGE_LIMIT,
		}),
		edges: Type.Array(WebGraphEdgeSchema, {
			maxItems: WEB_GRAPH_MAX_EDGES_PER_PAGE,
		}),
		attempts: Type.Array(WebAttemptSummarySchema, { maxItems: 200 }),
		timeline: WebTimelinePageSchema,
		artifacts: Type.Array(WebArtifactRefSchema, { maxItems: 200 }),
		receipt: Type.Optional(WebReceiptDetailSchema),
		whyStale: WebWhyStaleSchema,
		replay: WebReplaySummarySchema,
		presentation: WebTaskPresentationSchema,
		sourceObservation: WebSourceObservationSchema,
		availableActions: Type.Array(WebAvailableActionSchema, { maxItems: 18 }),
	},
	{ additionalProperties: false, "x-web-additive": true },
);

export const WebApprovalSummarySchema = Type.Object(
	{
		approvalRequestId: IdSchema,
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		nodeInstanceId: Type.Optional(IdSchema),
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
		deadline: Type.Optional(TimestampSchema),
		authorityVerified: Type.Boolean(),
		sourceObservation: WebSourceObservationSchema,
		availableActions: Type.Array(WebAvailableActionSchema, { maxItems: 18 }),
	},
	{ additionalProperties: false, "x-web-additive": true },
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
		message: WebContentMessageSchema,
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
		disposition: Type.Union([
			Type.Literal("needs-user-input"),
			Type.Literal("status-only"),
			Type.Literal("diagnostic"),
		]),
		authorityVerified: Type.Boolean(),
		observedAt: TimestampSchema,
		sourceObservation: WebSourceObservationSchema,
		availableActions: Type.Array(WebAvailableActionSchema, { maxItems: 18 }),
	},
	{ additionalProperties: false, "x-web-additive": true },
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
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false, "x-web-additive": true },
);

export function webPageSchema<const Item extends TSchema>(item: Item) {
	return Type.Object(
		{
			items: Type.Array(item, { maxItems: WEB_MAX_PAGE_LIMIT }),
			nextCursor: Type.Optional(
				Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
			),
			sourceObservation: WebSourceObservationSchema,
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

export const WebNoRequestSchema = Type.Object(
	{},
	{ additionalProperties: false },
);

export const WebCsrfRequestSchema = Type.Object(
	{ csrfToken: Type.String({ minLength: 32, maxLength: 4096 }) },
	{ additionalProperties: false },
);

export const WebSessionRevocationViewSchema = Type.Object(
	{
		revokedAt: TimestampSchema,
		revokedSessionCount: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

const WebRunStatusCountsSchema = Type.Object(
	{
		running: NonNegativeIntSchema,
		completed: NonNegativeIntSchema,
		failed: NonNegativeIntSchema,
		paused: NonNegativeIntSchema,
		blocked: NonNegativeIntSchema,
		cancelled: NonNegativeIntSchema,
		unknown: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

const WebRunStageCountsSchema = Type.Object(
	{
		received: NonNegativeIntSchema,
		compiled: NonNegativeIntSchema,
		linked: NonNegativeIntSchema,
		queued: NonNegativeIntSchema,
		admitted: NonNegativeIntSchema,
		executing: NonNegativeIntSchema,
		parked: NonNegativeIntSchema,
		reconciling: NonNegativeIntSchema,
		terminal: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

export const WebOverviewViewSchema = Type.Object(
	{
		sourceObservation: WebSourceObservationSchema,
		coordinatorCapacity: Type.Object(
			{
				maxActiveRuns: PositiveIntSchema,
				occupied: NonNegativeIntSchema,
				available: NonNegativeIntSchema,
				fencingEpoch: NonNegativeIntSchema,
			},
			{ additionalProperties: false },
		),
		runCounts: Type.Object(
			{
				byStatus: WebRunStatusCountsSchema,
				byStage: WebRunStageCountsSchema,
				needsOperator: NonNegativeIntSchema,
			},
			{ additionalProperties: false },
		),
		attentionCounts: Type.Object(
			{
				needsUserInput: NonNegativeIntSchema,
				statusOnly: NonNegativeIntSchema,
				diagnostic: NonNegativeIntSchema,
				pendingApprovals: NonNegativeIntSchema,
			},
			{ additionalProperties: false },
		),
		usage: Type.Union([
			Type.Object(
				{
					availability: Type.Literal("measured"),
					startAt: TimestampSchema,
					endAt: TimestampSchema,
					inputTokens: NonNegativeIntSchema,
					outputTokens: NonNegativeIntSchema,
					cost: Type.Number({ minimum: 0 }),
					currency: Type.String({ minLength: 3, maxLength: 16 }),
					methodology: Type.String({ minLength: 1, maxLength: 512 }),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					availability: Type.Literal("unavailable"),
					startAt: TimestampSchema,
					endAt: TimestampSchema,
					methodology: Type.String({ minLength: 1, maxLength: 512 }),
					unavailableReason: Type.String({
						minLength: 1,
						maxLength: 512,
					}),
				},
				{ additionalProperties: false },
			),
		]),
		reuse: Type.Object(
			{
				estimatedReusedNodes: NonNegativeIntSchema,
				methodology: Type.String({ minLength: 1, maxLength: 512 }),
				unavailableReason: Type.Optional(
					Type.String({ minLength: 1, maxLength: 512 }),
				),
			},
			{ additionalProperties: false },
		),
		projectHealth: Type.Object(
			{
				healthy: NonNegativeIntSchema,
				warning: NonNegativeIntSchema,
				unavailable: NonNegativeIntSchema,
				warnings: Type.Array(
					Type.Object(
						{
							projectId: IdSchema,
							controlDomainId: IdSchema,
							code: Type.String({ minLength: 1, maxLength: 128 }),
						},
						{ additionalProperties: false },
					),
					{ maxItems: 200 },
				),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false, "x-web-additive": true },
);

export const WebProjectParamsSchema = Type.Object(
	{ projectId: IdSchema, controlDomainId: IdSchema },
	{ additionalProperties: false },
);

export const WebProjectDetailSchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		displayName: Type.String({ minLength: 1, maxLength: 512 }),
		displayRoot: Type.String({ minLength: 1, maxLength: 2048 }),
		registryRevision: Type.Union([IdSchema, Type.Literal("standalone")]),
		bindingState: Type.Union([
			Type.Literal("bound"),
			Type.Literal("moved"),
			Type.Literal("copied"),
			Type.Literal("conflict"),
		]),
		mountState: Type.Union([
			Type.Literal("mounted"),
			Type.Literal("unmounted"),
			Type.Literal("missing"),
			Type.Literal("conflict"),
		]),
		header: Type.Object(
			{
				schemaVersion: PositiveIntSchema,
				projectId: IdSchema,
				controlDomainId: IdSchema,
				verified: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		watermark: WebProjectWatermarkSchema,
		warnings: Type.Array(
			Type.Object(
				{
					code: Type.String({ minLength: 1, maxLength: 128 }),
					detail: Type.String({ minLength: 1, maxLength: 8_192 }),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 200 },
		),
		effectivePolicyHash: DigestSchema,
		policyExplanationAvailable: Type.Boolean(),
		runCount: NonNegativeIntSchema,
		recentRuns: Type.Array(WebRunSummarySchema, { maxItems: 20 }),
		recentRunsTruncated: Type.Boolean(),
		sourceObservation: WebSourceObservationSchema,
		availableActions: Type.Array(WebAvailableActionSchema, { maxItems: 18 }),
	},
	{ additionalProperties: false, "x-web-additive": true },
);

export const WebBoundFragmentSummarySchema = Type.Object(
	{
		boundFragmentHash: DigestSchema,
		parentNodeInstanceId: IdSchema,
		originPhaseId: IdSchema,
		causationId: Type.Optional(IdSchema),
		linkKind: Type.Union([
			Type.Literal("nested-flow"),
			Type.Literal("graft-promote"),
		]),
		createdAtCommitSeq: CommitSeqSchema,
		dynamicNodeCount: NonNegativeIntSchema,
		staticNodeCount: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

export const WebFragmentListQuerySchema = Type.Object(
	{
		expectedRunVersion: NonNegativeIntSchema,
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: WEB_MAX_PAGE_LIMIT }),
		),
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
	},
	{ additionalProperties: false },
);

export const WebGraphQuerySchema = Type.Object(
	{
		expectedRunVersion: NonNegativeIntSchema,
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: WEB_GRAPH_MAX_PAGE_LIMIT,
			}),
		),
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
		statuses: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
				maxItems: 32,
				uniqueItems: true,
			}),
		),
		phaseKinds: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
				maxItems: 32,
				uniqueItems: true,
			}),
		),
		origins: Type.Optional(
			Type.Array(
				Type.Union([Type.Literal("bound-plan"), Type.Literal("bound-fragment")]),
				{ maxItems: 2, uniqueItems: true },
			),
		),
		query: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
		scope: Type.Optional(
			Type.Union([
				Type.Object(
					{ kind: Type.Literal("run") },
					{ additionalProperties: false },
				),
				Type.Object(
					{ kind: Type.Literal("fragment"), boundFragmentHash: DigestSchema },
					{ additionalProperties: false },
				),
				Type.Object(
					{ kind: Type.Literal("dynamic-parent"), nodeInstanceId: IdSchema },
					{ additionalProperties: false },
				),
			]),
		),
	},
	{ additionalProperties: false },
);

export const WebRunGraphViewSchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		runVersion: NonNegativeIntSchema,
		query: WebGraphQuerySchema,
		totalNodeCount: NonNegativeIntSchema,
		matchedNodeCount: NonNegativeIntSchema,
		totalEdgeCount: NonNegativeIntSchema,
		matchedEdgeCount: NonNegativeIntSchema,
		nodes: Type.Array(WebNodeSummarySchema, {
			maxItems: WEB_GRAPH_MAX_PAGE_LIMIT,
		}),
		edges: Type.Array(WebGraphEdgeSchema, {
			maxItems: WEB_GRAPH_MAX_EDGES_PER_PAGE,
		}),
		boundaryEdges: Type.Array(
			Type.Object(
				{
					includedNodeInstanceId: IdSchema,
					omittedNodeInstanceId: IdSchema,
					kind: Type.Union([
						Type.Literal("depends-on"),
						Type.Literal("dynamic-child"),
						Type.Literal("retry-of"),
					]),
				},
				{ additionalProperties: false },
			),
			{ maxItems: WEB_GRAPH_MAX_EDGES_PER_PAGE },
		),
		nextCursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false },
);

export const WebTimelineQuerySchema = Type.Object(
	{
		expectedRunVersion: NonNegativeIntSchema,
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: WEB_MAX_PAGE_LIMIT }),
		),
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
		kinds: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
				maxItems: 64,
				uniqueItems: true,
			}),
		),
	},
	{ additionalProperties: false },
);

export const WebNodeParamsSchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		nodeInstanceId: IdSchema,
	},
	{ additionalProperties: false },
);

export const WebNodeDetailSchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		runVersion: NonNegativeIntSchema,
		node: WebNodeSummarySchema,
		definitionId: IdSchema,
		dependencyNodeInstanceIds: Type.Array(IdSchema, { maxItems: 200 }),
		attemptCount: NonNegativeIntSchema,
		attempts: webPageSchema(WebAttemptSummarySchema),
		providerObservation: Type.Object(
			{
				provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
				jobHandlePresent: Type.Boolean(),
				outcome: Type.Optional(
					Type.Union([
						Type.Literal("running"),
						Type.Literal("completed"),
						Type.Literal("failed"),
						Type.Literal("cancelled"),
						Type.Literal("ambiguous"),
					]),
				),
			},
			{ additionalProperties: false },
		),
		startedAt: Type.Optional(TimestampSchema),
		endedAt: Type.Optional(TimestampSchema),
		inputRefs: Type.Array(WebArtifactRefSchema, { maxItems: 200 }),
		outputRefs: Type.Array(WebArtifactRefSchema, { maxItems: 200 }),
		cacheExplanation: Type.String({ maxLength: 8_192 }),
		linkedFragmentHashes: Type.Array(DigestSchema, { maxItems: 200 }),
		childNodeInstanceIds: Type.Array(IdSchema, { maxItems: 200 }),
		timelineEventIds: Type.Array(IdSchema, { maxItems: 200 }),
		sourceObservation: WebSourceObservationSchema,
		availableActions: Type.Array(WebAvailableActionSchema, { maxItems: 18 }),
	},
	{ additionalProperties: false, "x-web-additive": true },
);

export const WebAttemptListQuerySchema = Type.Object(
	{
		expectedRunVersion: NonNegativeIntSchema,
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: WEB_MAX_PAGE_LIMIT }),
		),
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
	},
	{ additionalProperties: false },
);

export const WebArtifactListQuerySchema = Type.Object(
	{
		expectedRunVersion: NonNegativeIntSchema,
		expectedReceiptId: Type.Optional(IdSchema),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: WEB_MAX_PAGE_LIMIT }),
		),
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
		roles: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
				maxItems: 32,
				uniqueItems: true,
			}),
		),
		integrity: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Literal("ok"),
					Type.Literal("unknown"),
					Type.Literal("unavailable"),
					Type.Literal("mismatch"),
					Type.Literal("in-progress"),
				]),
				{ maxItems: 5, uniqueItems: true },
			),
		),
	},
	{ additionalProperties: false },
);

export const WebReceiptQuerySchema = Type.Object(
	{
		expectedRunVersion: NonNegativeIntSchema,
		expectedReceiptId: IdSchema,
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: WEB_MAX_PAGE_LIMIT }),
		),
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
	},
	{ additionalProperties: false },
);

export const WebReceiptManifestEntrySchema = Type.Object(
	{
		eventId: IdSchema,
		commitSeq: CommitSeqSchema,
		eventKind: Type.String({ minLength: 1, maxLength: 256 }),
		eventDigest: DigestSchema,
	},
	{ additionalProperties: false },
);

export const WebReceiptViewSchema = Type.Object(
	{
		receipt: WebReceiptDetailSchema,
		verification: WebVerificationPresentationSchema,
		artifactCount: NonNegativeIntSchema,
		eventManifest: webPageSchema(WebReceiptManifestEntrySchema),
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false, "x-web-additive": true },
);

export const WebWhyStaleQuerySchema = Type.Object(
	{
		targetIds: Type.Array(IdSchema, {
			minItems: 1,
			maxItems: 200,
			uniqueItems: true,
		}),
	},
	{ additionalProperties: false },
);

export const WebWhyStaleViewSchema = Type.Object(
	{
		targets: Type.Array(
			Type.Object(
				{
					targetId: IdSchema,
					recordedFingerprint: Type.Optional(DigestSchema),
					currentFingerprint: Type.Optional(DigestSchema),
					changedComponents: Type.Array(
						Type.String({ minLength: 1, maxLength: 512 }),
						{ maxItems: 200 },
					),
					reuseDecision: Type.Union([
						Type.Literal("reusable"),
						Type.Literal("stale"),
						Type.Literal("unavailable"),
					]),
					provenanceRefs: Type.Array(IdSchema, { maxItems: 200 }),
					unavailableReason: Type.Optional(
						Type.String({ minLength: 1, maxLength: 8_192 }),
					),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 200 },
		),
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false },
);

export const WebReplayRequestSchema = Type.Object(
	{
		traceArtifactDigest: DigestSchema,
		overrides: Type.Array(
			Type.Union([
				Type.Object(
					{
						targetId: IdSchema,
						kind: Type.Literal("gate-verdict"),
						value: Type.Union([
							Type.Literal("pass"),
							Type.Literal("block"),
						]),
					},
					{ additionalProperties: false },
				),
				Type.Object(
					{
						targetId: IdSchema,
						kind: Type.Literal("condition-result"),
						value: Type.Boolean(),
					},
					{ additionalProperties: false },
				),
				Type.Object(
					{
						targetId: IdSchema,
						kind: Type.Literal("cache-decision"),
						value: Type.Union([
							Type.Literal("hit"),
							Type.Literal("miss"),
						]),
					},
					{ additionalProperties: false },
				),
			]),
			{ maxItems: 200 },
		),
	},
	{ additionalProperties: false },
);

export const WebReplayResultSchema = Type.Object(
	{
		sourceTraceDigest: DigestSchema,
		overridesHash: DigestSchema,
		decisionFold: Type.Array(Type.String({ maxLength: 8_192 }), {
			maxItems: 200,
		}),
		resultPreview: Type.Optional(Type.String({ maxLength: 32_768 })),
		warnings: Type.Array(Type.String({ maxLength: 8_192 }), { maxItems: 200 }),
		unreplayableBranches: Type.Array(IdSchema, { maxItems: 200 }),
		proof: Type.Object(
			{ providerCalls: Type.Literal(0), durableWrites: Type.Literal(0) },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const WebRecomputePreviewRequestSchema = Type.Object(
	{
		expectedRunVersion: NonNegativeIntSchema,
		phaseIds: Type.Array(IdSchema, {
			minItems: 1,
			maxItems: 200,
			uniqueItems: true,
		}),
	},
	{ additionalProperties: false },
);

export const WebRecomputePreviewSchema = Type.Object(
	{
		requestedPhaseIds: Type.Array(IdSchema, { maxItems: 200 }),
		affectedPhaseIds: Type.Array(IdSchema, { maxItems: 200 }),
		affectedNodeInstanceIds: Type.Array(IdSchema, { maxItems: 200 }),
		cacheExplanation: Type.String({ maxLength: 8_192 }),
		reAdmissionRequired: Type.Boolean(),
		estimatedCost: Type.Optional(Type.Number({ minimum: 0 })),
		estimatedTokens: Type.Optional(NonNegativeIntSchema),
		uncertainty: Type.Optional(Type.String({ minLength: 1, maxLength: 8_192 })),
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false },
);

export const WebApprovalListQuerySchema = Type.Object(
	{
		projectIds: Type.Optional(
			Type.Array(IdSchema, { maxItems: 200, uniqueItems: true }),
		),
		statuses: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Literal("pending"),
					Type.Literal("approved"),
					Type.Literal("rejected"),
					Type.Literal("edited"),
					Type.Literal("expired"),
					Type.Literal("cancelled"),
				]),
				{ maxItems: 6, uniqueItems: true },
			),
		),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: WEB_MAX_PAGE_LIMIT }),
		),
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
	},
	{ additionalProperties: false },
);

export const WebApprovalParamsSchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		approvalRequestId: IdSchema,
	},
	{ additionalProperties: false },
);

export const WebApprovalDetailSchema = Type.Object(
	{
		summary: WebApprovalSummarySchema,
		approvalVersion: NonNegativeIntSchema,
		audience: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
			maxItems: 200,
		}),
		decisionRaceState: Type.Union([
			Type.Literal("open"),
			Type.Literal("won"),
			Type.Literal("lost"),
			Type.Literal("expired"),
		]),
		operationClass: Type.Union([
			Type.Literal("publish-files"),
			Type.Literal("change-files"),
			Type.Literal("use-network"),
			Type.Literal("run-tool"),
			Type.Literal("spend-budget"),
			Type.Literal("continue-task"),
			Type.Literal("apply-edit"),
			Type.Literal("generic-action"),
		]),
		boundPlanHash: DigestSchema,
		editArtifactDigest: Type.Optional(DigestSchema),
		evidenceRefs: Type.Array(WebArtifactRefSchema, { maxItems: 200 }),
		policyExplanation: Type.String({ maxLength: 8_192 }),
		dispatcherHandoff: Type.Union([
			Type.Literal("not-started"),
			Type.Literal("pending"),
			Type.Literal("accepted"),
			Type.Literal("failed"),
		]),
		decisionPresentation: Type.Optional(
			WebDecisionPresentationSchema,
		),
		sourceObservation: WebSourceObservationSchema,
		availableActions: Type.Array(WebAvailableActionSchema, { maxItems: 18 }),
	},
	{ additionalProperties: false, "x-web-additive": true },
);

export const WebAttentionQuerySchema = Type.Object(
	{
		dispositions: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Literal("needs-user-input"),
					Type.Literal("status-only"),
					Type.Literal("diagnostic"),
				]),
				{ maxItems: 3, uniqueItems: true },
			),
		),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: WEB_MAX_PAGE_LIMIT }),
		),
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
	},
	{ additionalProperties: false },
);

export const WebCommandParamsSchema = Type.Object(
	{ commandId: IdSchema },
	{ additionalProperties: false },
);

export const WebBoundFragmentPageSchema = webPageSchema(
	WebBoundFragmentSummarySchema,
);
export const WebAttemptPageSchema = webPageSchema(WebAttemptSummarySchema);
export const WebArtifactPageSchema = webPageSchema(WebArtifactRefSchema);
export const WebTimelineEventPageSchema = webPageSchema(WebTimelineEventSchema);

export const WebSessionRevocationResponseSchema = webSuccessSchema(
	WebSessionRevocationViewSchema,
);
export const WebOverviewResponseSchema = webSuccessSchema(WebOverviewViewSchema);
export const WebProjectDetailResponseSchema = webSuccessSchema(
	WebProjectDetailSchema,
);
export const WebBoundFragmentPageResponseSchema = webSuccessSchema(
	WebBoundFragmentPageSchema,
);
export const WebRunGraphResponseSchema = webSuccessSchema(
	WebRunGraphViewSchema,
);
export const WebTimelineEventPageResponseSchema = webSuccessSchema(
	WebTimelineEventPageSchema,
);
export const WebNodeDetailResponseSchema = webSuccessSchema(
	WebNodeDetailSchema,
);
export const WebAttemptPageResponseSchema =
	webSuccessSchema(WebAttemptPageSchema);
export const WebArtifactPageResponseSchema =
	webSuccessSchema(WebArtifactPageSchema);
export const WebReceiptViewResponseSchema =
	webSuccessSchema(WebReceiptViewSchema);
export const WebWhyStaleViewResponseSchema =
	webSuccessSchema(WebWhyStaleViewSchema);
export const WebReplayResultResponseSchema =
	webSuccessSchema(WebReplayResultSchema);
export const WebRecomputePreviewResponseSchema = webSuccessSchema(
	WebRecomputePreviewSchema,
);
export const WebApprovalDetailResponseSchema = webSuccessSchema(
	WebApprovalDetailSchema,
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
		error: WebControlErrorSchema,
		run: Type.Optional(WebRunSummarySchema),
	},
	{ additionalProperties: false },
);

export const WebRejectedCommandOutcomeSchema = Type.Object(
	{
		...WebKnownCommandIdentity,
		status: Type.Literal("rejected"),
		error: WebControlErrorSchema,
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
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: WEB_CURSOR_MAX_BYTES }),
		),
		projectIds: Type.Optional(
			Type.Array(IdSchema, { maxItems: 200, uniqueItems: true }),
		),
	},
	{ additionalProperties: false },
);

const WebStreamEventIdSchema = Type.String({
	minLength: 1,
	maxLength: WEB_CURSOR_MAX_BYTES,
	pattern: "^[^\\r\\n\\u0000]+$",
});

const WebStreamFrameBase = {
	id: WebStreamEventIdSchema,
	cursor: WebStreamEventIdSchema,
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
		kind: webLiteralUnion([
			"created",
			"updated",
			"deleted",
			"invalidated",
		]),
		resourceType: webLiteralUnion([
			"overview",
			"project",
			"coordinator",
			"reservation",
			"run",
			"graph",
			"timeline",
			"node",
			"approval",
			"attention",
			"policy",
			"artifact",
			"command",
		]),
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
		error: WebControlErrorSchema,
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
		redactionClass: webLiteralUnion([
			"public",
			"project",
			"sensitive",
			"secret",
		]),
		contentDisposition: Type.Union([
			Type.Literal("inline"),
			Type.Literal("attachment"),
		]),
	},
	{ additionalProperties: false },
);

export const WebOverviewViewConsumerSchema = webAdditiveConsumerSchema(
	WebOverviewViewSchema,
);
export const WebProjectSummaryConsumerSchema = webAdditiveConsumerSchema(
	WebProjectSummarySchema,
);
export const WebRunSummaryConsumerSchema = Type.Object(
	{
		...WebRunSummarySchema.properties,
		presentation: WebTaskPresentationSummaryConsumerSchema,
	},
	{ additionalProperties: true, "x-web-additive": true },
);
export const WebProjectDetailConsumerSchema = Type.Object(
	{
		...WebProjectDetailSchema.properties,
		recentRuns: Type.Array(WebRunSummaryConsumerSchema, { maxItems: 20 }),
	},
	{ additionalProperties: true, "x-web-additive": true },
);
export const WebRunDetailConsumerSchema = Type.Object(
	{
		...WebRunDetailSchema.properties,
		run: WebRunSummaryConsumerSchema,
		presentation: WebTaskPresentationConsumerSchema,
	},
	{ additionalProperties: true, "x-web-additive": true },
);
export const WebNodeDetailConsumerSchema =
	webAdditiveConsumerSchema(WebNodeDetailSchema);
export const WebApprovalSummaryConsumerSchema = webAdditiveConsumerSchema(
	WebApprovalSummarySchema,
);
export const WebApprovalDetailConsumerSchema = Type.Object(
	{
		...WebApprovalDetailSchema.properties,
		summary: WebApprovalSummaryConsumerSchema,
	},
	{ additionalProperties: true, "x-web-additive": true },
);
export const WebAttentionItemConsumerSchema = webAdditiveConsumerSchema(
	WebAttentionItemSchema,
);
export const WebReceiptViewConsumerSchema =
	webAdditiveConsumerSchema(WebReceiptViewSchema);
export const WebPolicyExplanationConsumerSchema = webAdditiveConsumerSchema(
	WebPolicyExplanationSchema,
);
export const WebProjectPageConsumerSchema = webPageSchema(
	WebProjectSummaryConsumerSchema,
);
export const WebRunPageConsumerSchema = webPageSchema(
	WebRunSummaryConsumerSchema,
);
export const WebApprovalPageConsumerSchema = webPageSchema(
	WebApprovalSummaryConsumerSchema,
);
export const WebAttentionPageConsumerSchema = webPageSchema(
	WebAttentionItemConsumerSchema,
);

export type WebApiErrorResponse = Static<typeof WebApiErrorResponseSchema>;
export type WebProjectWatermark = Static<
	typeof WebProjectWatermarkSchema
>;
export type WebPageCursorPayload = Static<typeof WebPageCursorPayloadSchema>;
export type WebStreamCursorPayload = Static<typeof WebStreamCursorPayloadSchema>;
export type WebPageRequest = Static<typeof WebPageRequestSchema>;
export type WebRunListQuery = Static<typeof WebRunListQuerySchema>;
export type WebTimelineQuery = Static<typeof WebTimelineQuerySchema>;
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

export type WebEndpointMethod = "GET" | "POST";
export type WebEndpointResponseKind = "json" | "bytes" | "event-stream";
export type WebEndpointOperationClass =
	| "Ephemeral security"
	| "Live host read"
	| "Derived aggregate read"
	| "Registry + verified headers"
	| "Home-project read"
	| "Coordinator read"
	| "Bounded home-project read"
	| "Home-project journal read"
	| "Derived refs + home refresh"
	| "Pure analysis"
	| "Pure analysis, capability-gated"
	| "Current read-only evaluation"
	| "Authorized artifact read"
	| "Resumable observation"
	| "Durable domain mutation"
	| "Live-reauthorized recovery read";

export type WebEndpointPagination = {
	readonly collection: string;
	readonly itemsPath: readonly string[];
	readonly nextCursorPath: readonly string[];
	readonly maximumLimit: number;
};

export type WebRouteToken =
	| { kind: "literal"; value: string }
	| { kind: "safe-id"; name: string }
	| { kind: "digest"; name: "digest" };

function webRouteTokens(path: string): readonly WebRouteToken[] {
	return path
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => {
			if (!segment.startsWith(":")) {
				return { kind: "literal" as const, value: segment };
			}
			const name = segment.slice(1);
			return name === "digest"
				? { kind: "digest" as const, name }
				: { kind: "safe-id" as const, name };
		});
}

function defineWebEndpoint<
	const Params extends TSchema,
	const Query extends TSchema,
	const Body extends TSchema,
	const Success extends TSchema,
	const ResponseKind extends WebEndpointResponseKind,
>(definition: {
	method: WebEndpointMethod;
	path: string;
	paramsSchema: Params;
	querySchema: Query;
	bodySchema: Body;
	requestSchemaName: string;
	successDataSchema: Success;
	consumerSuccessDataSchema?: TSchema;
	successDataName: string;
	responseKind: ResponseKind;
	operationClass: WebEndpointOperationClass;
	responseBudgetBytes: number;
	capability: WebFeatureId | null;
	pagination?: WebEndpointPagination;
}) {
	const consumerSuccessDataSchema =
		definition.consumerSuccessDataSchema ?? definition.successDataSchema;
	return {
		...definition,
		routeTokens: webRouteTokens(definition.path),
		successResponseSchema: webSuccessSchema(definition.successDataSchema),
		consumerSuccessDataSchema,
		consumerSuccessResponseSchema: webSuccessSchema(consumerSuccessDataSchema),
	};
}

const ordinary = WEB_RESPONSE_BUDGET.ordinaryJson;
const analysis = WEB_RESPONSE_BUDGET.analysis;

/**
 * Sole executable P17 v5 endpoint inventory.
 *
 * Router bindings, generated clients, handler maps, and the RFC inventory
 * drift check consume this object. Endpoint ids are internal generated names;
 * method/path and schema names are the wire contract.
 */
export const WEB_ENDPOINTS = {
	sessionExchange: defineWebEndpoint({
		method: "POST",
		path: "/api/v1/session/exchange",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebSessionExchangeRequestSchema,
		requestSchemaName: "WebSessionExchangeRequest",
		successDataSchema: WebSessionViewSchema,
		successDataName: "WebSessionView",
		responseKind: "json",
		operationClass: "Ephemeral security",
		responseBudgetBytes: ordinary,
		capability: null,
	}),
	sessionLogout: defineWebEndpoint({
		method: "POST",
		path: "/api/v1/session/logout",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebCsrfRequestSchema,
		requestSchemaName: "WebCsrfRequest",
		successDataSchema: WebSessionRevocationViewSchema,
		successDataName: "WebSessionRevocationView",
		responseKind: "json",
		operationClass: "Ephemeral security",
		responseBudgetBytes: ordinary,
		capability: null,
	}),
	sessionsRevokeAll: defineWebEndpoint({
		method: "POST",
		path: "/api/v1/sessions/revoke-all",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebCsrfRequestSchema,
		requestSchemaName: "WebCsrfRequest",
		successDataSchema: WebSessionRevocationViewSchema,
		successDataName: "WebSessionRevocationView",
		responseKind: "json",
		operationClass: "Ephemeral security",
		responseBudgetBytes: ordinary,
		capability: null,
	}),
	bootstrap: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/bootstrap",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "none",
		successDataSchema: WebBootstrapViewSchema,
		successDataName: "WebBootstrapView",
		responseKind: "json",
		operationClass: "Live host read",
		responseBudgetBytes: ordinary,
		capability: null,
	}),
	overview: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/overview",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "none",
		successDataSchema: WebOverviewViewSchema,
		consumerSuccessDataSchema: WebOverviewViewConsumerSchema,
		successDataName: "WebOverviewView",
		responseKind: "json",
		operationClass: "Derived aggregate read",
		responseBudgetBytes: ordinary,
		capability: "overview",
	}),
	projects: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebPageRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebPageRequest query",
		successDataSchema: WebProjectPageSchema,
		consumerSuccessDataSchema: WebProjectPageConsumerSchema,
		successDataName: "WebPage<WebProjectSummary>",
		responseKind: "json",
		operationClass: "Registry + verified headers",
		responseBudgetBytes: ordinary,
		capability: "project-detail",
		pagination: {
			collection: "projects",
			itemsPath: ["items"],
			nextCursorPath: ["nextCursor"],
			maximumLimit: WEB_MAX_PAGE_LIMIT,
		},
	}),
	projectDetail: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId",
		paramsSchema: WebProjectParamsSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebProjectParams",
		successDataSchema: WebProjectDetailSchema,
		consumerSuccessDataSchema: WebProjectDetailConsumerSchema,
		successDataName: "WebProjectDetail",
		responseKind: "json",
		operationClass: "Home-project read",
		responseBudgetBytes: ordinary,
		capability: "project-detail",
	}),
	coordinator: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/coordinator",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "none",
		successDataSchema: WebCoordinatorSummarySchema,
		successDataName: "WebCoordinatorSummary",
		responseKind: "json",
		operationClass: "Coordinator read",
		responseBudgetBytes: ordinary,
		capability: "overview",
	}),
	reservationDetail: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/coordinator/reservations/:reservationId",
		paramsSchema: WebReservationParamsSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebReservationParams",
		successDataSchema: WebReservationDetailSchema,
		successDataName: "WebReservationDetail",
		responseKind: "json",
		operationClass: "Coordinator read",
		responseBudgetBytes: ordinary,
		capability: "overview",
	}),
	runs: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/runs",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebRunListQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebRunListQuery",
		successDataSchema: WebRunPageSchema,
		consumerSuccessDataSchema: WebRunPageConsumerSchema,
		successDataName: "WebPage<WebRunSummary>",
		responseKind: "json",
		operationClass: "Derived aggregate read",
		responseBudgetBytes: ordinary,
		capability: "run-detail",
		pagination: {
			collection: "runs",
			itemsPath: ["items"],
			nextCursorPath: ["nextCursor"],
			maximumLimit: WEB_MAX_PAGE_LIMIT,
		},
	}),
	runDetail: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId",
		paramsSchema: WebProjectRunParamsSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebProjectRunParams",
		successDataSchema: WebRunDetailSchema,
		consumerSuccessDataSchema: WebRunDetailConsumerSchema,
		successDataName: "WebRunDetail",
		responseKind: "json",
		operationClass: "Home-project read",
		responseBudgetBytes: WEB_RESPONSE_BUDGET.runDetail,
		capability: "run-detail",
	}),
	runFragments: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/fragments",
		paramsSchema: WebProjectRunParamsSchema,
		querySchema: WebFragmentListQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebFragmentListQuery",
		successDataSchema: WebBoundFragmentPageSchema,
		successDataName: "WebPage<WebBoundFragmentSummary>",
		responseKind: "json",
		operationClass: "Bounded home-project read",
		responseBudgetBytes: ordinary,
		capability: "run-detail",
		pagination: {
			collection: "fragments",
			itemsPath: ["items"],
			nextCursorPath: ["nextCursor"],
			maximumLimit: WEB_MAX_PAGE_LIMIT,
		},
	}),
	runGraph: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/graph",
		paramsSchema: WebProjectRunParamsSchema,
		querySchema: WebGraphQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebGraphQuery",
		successDataSchema: WebRunGraphViewSchema,
		successDataName: "WebRunGraphView",
		responseKind: "json",
		operationClass: "Bounded home-project read",
		responseBudgetBytes: WEB_RESPONSE_BUDGET.graph,
		capability: "run-graph",
		pagination: {
			collection: "graph",
			itemsPath: ["nodes"],
			nextCursorPath: ["nextCursor"],
			maximumLimit: 2_000,
		},
	}),
	runTimeline: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/timeline",
		paramsSchema: WebProjectRunParamsSchema,
		querySchema: WebTimelineQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebTimelineQuery",
		successDataSchema: WebTimelineEventPageSchema,
		successDataName: "WebPage<WebTimelineEvent>",
		responseKind: "json",
		operationClass: "Home-project journal read",
		responseBudgetBytes: ordinary,
		capability: "run-timeline",
		pagination: {
			collection: "timeline",
			itemsPath: ["items"],
			nextCursorPath: ["nextCursor"],
			maximumLimit: WEB_MAX_PAGE_LIMIT,
		},
	}),
	nodeDetail: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/nodes/:nodeInstanceId",
		paramsSchema: WebNodeParamsSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebNodeParams",
		successDataSchema: WebNodeDetailSchema,
		consumerSuccessDataSchema: WebNodeDetailConsumerSchema,
		successDataName: "WebNodeDetail",
		responseKind: "json",
		operationClass: "Home-project read",
		responseBudgetBytes: ordinary,
		capability: "node-detail",
	}),
	nodeAttempts: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/nodes/:nodeInstanceId/attempts",
		paramsSchema: WebNodeParamsSchema,
		querySchema: WebAttemptListQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebAttemptListQuery",
		successDataSchema: WebAttemptPageSchema,
		successDataName: "WebPage<WebAttemptSummary>",
		responseKind: "json",
		operationClass: "Bounded home-project read",
		responseBudgetBytes: ordinary,
		capability: "node-detail",
		pagination: {
			collection: "attempts",
			itemsPath: ["items"],
			nextCursorPath: ["nextCursor"],
			maximumLimit: WEB_MAX_PAGE_LIMIT,
		},
	}),
	runArtifacts: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/artifacts",
		paramsSchema: WebProjectRunParamsSchema,
		querySchema: WebArtifactListQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebArtifactListQuery",
		successDataSchema: WebArtifactPageSchema,
		successDataName: "WebPage<WebArtifactRef>",
		responseKind: "json",
		operationClass: "Bounded home-project read",
		responseBudgetBytes: ordinary,
		capability: "artifacts",
		pagination: {
			collection: "artifacts",
			itemsPath: ["items"],
			nextCursorPath: ["nextCursor"],
			maximumLimit: WEB_MAX_PAGE_LIMIT,
		},
	}),
	runReceipt: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/receipt",
		paramsSchema: WebProjectRunParamsSchema,
		querySchema: WebReceiptQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebReceiptQuery",
		successDataSchema: WebReceiptViewSchema,
		consumerSuccessDataSchema: WebReceiptViewConsumerSchema,
		successDataName: "WebReceiptView",
		responseKind: "json",
		operationClass: "Bounded home-project read",
		responseBudgetBytes: ordinary,
		capability: "artifacts",
		pagination: {
			collection: "receipt-manifest",
			itemsPath: ["eventManifest", "items"],
			nextCursorPath: ["eventManifest", "nextCursor"],
			maximumLimit: WEB_MAX_PAGE_LIMIT,
		},
	}),
	runWhyStale: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/why-stale",
		paramsSchema: WebProjectRunParamsSchema,
		querySchema: WebWhyStaleQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebWhyStaleQuery",
		successDataSchema: WebWhyStaleViewSchema,
		successDataName: "WebWhyStaleView",
		responseKind: "json",
		operationClass: "Pure analysis",
		responseBudgetBytes: analysis,
		capability: "why-stale",
	}),
	runReplay: defineWebEndpoint({
		method: "POST",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/replay",
		paramsSchema: WebProjectRunParamsSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebReplayRequestSchema,
		requestSchemaName: "WebReplayRequest",
		successDataSchema: WebReplayResultSchema,
		successDataName: "WebReplayResult",
		responseKind: "json",
		operationClass: "Pure analysis",
		responseBudgetBytes: analysis,
		capability: "replay",
	}),
	runRecomputePreview: defineWebEndpoint({
		method: "POST",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/recompute-preview",
		paramsSchema: WebProjectRunParamsSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebRecomputePreviewRequestSchema,
		requestSchemaName: "WebRecomputePreviewRequest",
		successDataSchema: WebRecomputePreviewSchema,
		successDataName: "WebRecomputePreview",
		responseKind: "json",
		operationClass: "Pure analysis, capability-gated",
		responseBudgetBytes: analysis,
		capability: "recompute-preview",
	}),
	approvals: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/approvals",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebApprovalListQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebApprovalListQuery",
		successDataSchema: WebApprovalPageSchema,
		consumerSuccessDataSchema: WebApprovalPageConsumerSchema,
		successDataName: "WebPage<WebApprovalSummary>",
		responseKind: "json",
		operationClass: "Derived refs + home refresh",
		responseBudgetBytes: ordinary,
		capability: "approval-detail",
		pagination: {
			collection: "approvals",
			itemsPath: ["items"],
			nextCursorPath: ["nextCursor"],
			maximumLimit: WEB_MAX_PAGE_LIMIT,
		},
	}),
	approvalDetail: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/approvals/:approvalRequestId",
		paramsSchema: WebApprovalParamsSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebApprovalParams",
		successDataSchema: WebApprovalDetailSchema,
		consumerSuccessDataSchema: WebApprovalDetailConsumerSchema,
		successDataName: "WebApprovalDetail",
		responseKind: "json",
		operationClass: "Home-project read",
		responseBudgetBytes: ordinary,
		capability: "approval-detail",
	}),
	attention: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/attention",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebAttentionQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebAttentionQuery",
		successDataSchema: WebAttentionPageSchema,
		consumerSuccessDataSchema: WebAttentionPageConsumerSchema,
		successDataName: "WebPage<WebAttentionItem>",
		responseKind: "json",
		operationClass: "Derived aggregate read",
		responseBudgetBytes: ordinary,
		capability: "attention",
		pagination: {
			collection: "attention",
			itemsPath: ["items"],
			nextCursorPath: ["nextCursor"],
			maximumLimit: WEB_MAX_PAGE_LIMIT,
		},
	}),
	policyExplanation: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/policy/explanation",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebPolicyExplanationQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebPolicyExplanationQuery",
		successDataSchema: WebPolicyExplanationSchema,
		consumerSuccessDataSchema: WebPolicyExplanationConsumerSchema,
		successDataName: "WebPolicyExplanation",
		responseKind: "json",
		operationClass: "Current read-only evaluation",
		responseBudgetBytes: ordinary,
		capability: "policy-explanation",
	}),
	artifact: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/projects/:projectId/domains/:controlDomainId/artifacts/:digest",
		paramsSchema: WebArtifactParamsSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebArtifactParams",
		successDataSchema: WebArtifactMetadataSchema,
		successDataName: "bytes",
		responseKind: "bytes",
		operationClass: "Authorized artifact read",
		responseBudgetBytes: 100 * 1024 * 1024,
		capability: "artifacts",
	}),
	events: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/events",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebEventStreamQuerySchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebEventStreamQuery",
		successDataSchema: WebStreamFrameSchema,
		successDataName: "text/event-stream",
		responseKind: "event-stream",
		operationClass: "Resumable observation",
		responseBudgetBytes: 64 * 1024,
		capability: "sse",
	}),
	commands: defineWebEndpoint({
		method: "POST",
		path: "/api/v1/commands",
		paramsSchema: WebNoRequestSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebCommandRequestSchema,
		requestSchemaName: "WebCommandRequest",
		successDataSchema: WebCommandOutcomeSchema,
		successDataName: "WebCommandOutcome",
		responseKind: "json",
		operationClass: "Durable domain mutation",
		responseBudgetBytes: ordinary,
		capability: null,
	}),
	command: defineWebEndpoint({
		method: "GET",
		path: "/api/v1/commands/:commandId",
		paramsSchema: WebCommandParamsSchema,
		querySchema: WebNoRequestSchema,
		bodySchema: WebNoRequestSchema,
		requestSchemaName: "WebCommandParams",
		successDataSchema: WebCommandOutcomeSchema,
		successDataName: "WebCommandOutcome",
		responseKind: "json",
		operationClass: "Live-reauthorized recovery read",
		responseBudgetBytes: ordinary,
		capability: null,
	}),
} as const;

export type WebEndpointId = keyof typeof WEB_ENDPOINTS;
type WebEndpointDefinition = (typeof WEB_ENDPOINTS)[WebEndpointId];
type WebEndpointInput<Endpoint extends WebEndpointDefinition> = {
	params: Static<Endpoint["paramsSchema"]>;
	query: Static<Endpoint["querySchema"]>;
	body: Static<Endpoint["bodySchema"]>;
};

/**
 * Authenticated listener context supplied by WebGateway, never by request JSON.
 * Domain handlers use this for principal binding, cursors, and audit identity.
 */
export type WebHandlerContext = {
	requestId: string;
	listenerId: string;
	principalId: string;
	principalDisplayName: string;
	principalHash: string;
	observedAt: number;
	sessionAbsoluteExpiresAt: number;
	/** Server-internal cancellation only; never serialized onto the wire. */
	signal?: AbortSignal;
};

export type WebBinaryResult = {
	metadata: WebArtifactMetadata;
	body: Uint8Array;
};

type WebEndpointResult<Endpoint extends WebEndpointDefinition> =
	Endpoint["responseKind"] extends "bytes"
		? WebBinaryResult
		: Endpoint["responseKind"] extends "event-stream"
			? AsyncIterable<WebStreamFrame>
			: Static<Endpoint["successDataSchema"]>;

export type WebHandlerMap = {
	[Id in WebEndpointId]: (
		input: WebEndpointInput<(typeof WEB_ENDPOINTS)[Id]>,
		context: WebHandlerContext,
	) =>
		| WebEndpointResult<(typeof WEB_ENDPOINTS)[Id]>
		| Promise<WebEndpointResult<(typeof WEB_ENDPOINTS)[Id]>>;
};

export function defineWebHandlers<const Handlers extends WebHandlerMap>(
	handlers: Handlers,
): Handlers {
	return handlers;
}

export type WebGeneratedHandlerRoute = {
	id: WebEndpointId;
	method: WebEndpointMethod;
	path: string;
	routeTokens: readonly WebRouteToken[];
	handler: WebHandlerMap[WebEndpointId];
};

export function generateWebHandlerRoutes(
	handlers: WebHandlerMap,
): WebGeneratedHandlerRoute[] {
	return (Object.keys(WEB_ENDPOINTS) as WebEndpointId[]).map((id) => {
		const endpoint = WEB_ENDPOINTS[id];
		return {
			id,
			method: endpoint.method,
			path: endpoint.path,
			routeTokens: endpoint.routeTokens,
			handler: handlers[id],
		};
	});
}

export function compileWebEndpointPath(
	id: WebEndpointId,
	params: Readonly<Record<string, string>>,
): string {
	return WEB_ENDPOINTS[id].routeTokens
		.map((token) => {
			if (token.kind === "literal") return token.value;
			const value = params[token.name];
			const valid =
				token.kind === "digest"
					? value !== undefined &&
						value.length <= 256 &&
						new RegExp(WEB_DIGEST_PATTERN, "u").test(value)
					: value !== undefined &&
						value.length <= SAFE_ID_MAX_LENGTH &&
						new RegExp(SAFE_ID_PATTERN, "u").test(value);
			if (!valid) {
				throw new TypeError(`missing or unsafe route parameter: ${token.name}`);
			}
			return encodeURIComponent(value);
		})
		.reduce((path, segment) => `${path}/${segment}`, "");
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

export function encodeWebQuery(
	query: Readonly<Record<string, unknown>>,
): string {
	const pairs: string[] = [];
	for (const key of Object.keys(query).sort()) {
		const value = query[key];
		if (value === undefined) continue;
		const values = Array.isArray(value) ? value : [value];
		for (const item of values) {
			const encoded =
				item !== null && typeof item === "object"
					? stableJson(item)
					: String(item);
			pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(encoded)}`);
		}
	}
	return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

export type WebClientTransportRequest = {
	endpointId: WebEndpointId;
	method: WebEndpointMethod;
	path: string;
	body: unknown;
	responseKind: WebEndpointResponseKind;
	successResponseSchema: TSchema;
	responseBudgetBytes: number;
	signal?: AbortSignal;
	sensitiveArtifactAcknowledgement?: "download";
};

export interface WebClientTransport {
	request(request: WebClientTransportRequest): Promise<unknown>;
}

export class WebClientFailureError extends Error {
	override readonly name = "WebClientFailureError";
	readonly failure: WebApiErrorResponse;

	constructor(failure: WebApiErrorResponse) {
		super(failure.error.message);
		this.failure = failure;
	}
}

export class WebClientCodecError extends Error {
	override readonly name = "WebClientCodecError";
}

export type WebClientRequestOptions = {
	readonly signal?: AbortSignal;
	readonly sensitiveArtifactAcknowledgement?: "download";
};

export type WebGeneratedClient = {
	[Id in WebEndpointId]: (
		input: WebEndpointInput<(typeof WEB_ENDPOINTS)[Id]>,
		options?: WebClientRequestOptions,
	) => Promise<WebEndpointResult<(typeof WEB_ENDPOINTS)[Id]>>;
};

export function createWebClient(
	transport: WebClientTransport,
): WebGeneratedClient {
	const methods = Object.fromEntries(
		(Object.keys(WEB_ENDPOINTS) as WebEndpointId[]).map((id) => {
			const endpoint = WEB_ENDPOINTS[id];
			const method = async (
				input: WebEndpointInput<typeof endpoint>,
				options: WebClientRequestOptions = {},
			): Promise<unknown> => {
				if (
					options.sensitiveArtifactAcknowledgement !== undefined &&
					id !== "artifact"
				) {
					throw new TypeError(
						"Sensitive artifact acknowledgement is valid only for artifact downloads",
					);
				}
				const path =
					compileWebEndpointPath(
						id,
						input.params as Readonly<Record<string, string>>,
					) +
					encodeWebQuery(
						input.query as Readonly<Record<string, unknown>>,
					);
				const response = await transport.request({
					endpointId: id,
					method: endpoint.method,
					path,
					body: input.body,
					responseKind: endpoint.responseKind,
					successResponseSchema:
						endpoint.responseKind ===
						"bytes"
							? endpoint.consumerSuccessDataSchema
							: endpoint.consumerSuccessResponseSchema,
					responseBudgetBytes: endpoint.responseBudgetBytes,
					...(options.signal ? { signal: options.signal } : {}),
					...(options.sensitiveArtifactAcknowledgement
						? {
								sensitiveArtifactAcknowledgement:
									options.sensitiveArtifactAcknowledgement,
							}
						: {}),
				});
				if (endpoint.responseKind === "bytes") {
					const byteResponse = response as {
						metadata?: unknown;
						body?: unknown;
					};
					if (
						response === null ||
						typeof response !== "object" ||
						!Value.Check(
							endpoint.consumerSuccessDataSchema,
							byteResponse.metadata,
						) ||
						!(byteResponse.body instanceof Uint8Array) ||
						byteResponse.body.byteLength !==
							(
								byteResponse.metadata as unknown as WebArtifactMetadata
							).size
					) {
						throw new WebClientCodecError(
							`${id} response did not match its P17 byte codec`,
						);
					}
					return response;
				}
				if (endpoint.responseKind === "event-stream") return response;
				if (Value.Check(endpoint.consumerSuccessResponseSchema, response)) {
					return (response as { data: unknown }).data;
				}
				if (Value.Check(WebApiErrorResponseSchema, response)) {
					throw new WebClientFailureError(
						response as WebApiErrorResponse,
					);
				}
				throw new WebClientCodecError(
					`${id} response did not match its P17 consumer codec`,
				);
			};
			return [id, method];
		}),
	);
	return methods as WebGeneratedClient;
}
