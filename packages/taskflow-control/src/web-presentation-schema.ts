/**
 * Browser-safe P17 v5 presentation schemas.
 *
 * This is the shared TypeBox vocabulary for the fixed server/browser
 * projection boundary. It deliberately contains no projection logic and no
 * node:* imports.
 */
import {
	type Static,
	type TLiteral,
	type TObject,
	type TProperties,
	type TSchema,
	Type,
} from "typebox";
import {
	FORCE_RELEASE_ACKNOWLEDGEMENT,
	RECOVERY_ACTIONS,
	RunStageSchema,
	RunStatusSchema,
	SIDE_EFFECT_LEVELS,
	TF_ERROR_CODES,
} from "./types.ts";
import { SAFE_ID_MAX_LENGTH, SAFE_ID_PATTERN } from "./validate-ids.ts";

const IdSchema = Type.String({
	minLength: 1,
	maxLength: SAFE_ID_MAX_LENGTH,
	pattern: SAFE_ID_PATTERN,
});
const TimestampSchema = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER,
});
const NonNegativeIntSchema = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER,
});
const PositiveIntSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});
const DigestSchema = Type.String({
	minLength: 16,
	maxLength: 256,
	pattern: "^[a-z0-9][a-z0-9+.-]*:[A-Fa-f0-9]{16,}$",
});
const DisplayTextSchema = Type.String({ minLength: 1, maxLength: 512 });
const PreviewTextSchema = Type.String({ maxLength: 32_768 });
const OpaqueCursorSchema = Type.String({ minLength: 1, maxLength: 8_192 });

function literalUnion<const Values extends readonly [string, ...string[]]>(
	values: Values,
) {
	return Type.Union(
		values.map((value) => Type.Literal(value)) as [
			TLiteral<Values[number]>,
			...TLiteral<Values[number]>[],
		],
	);
}

export function webAdditiveConsumerSchema<const Properties extends TProperties>(
	producer: TObject<Properties>,
) {
	return Type.Object(producer.properties, {
		additionalProperties: true,
		"x-web-additive": true,
	});
}

const WebControlErrorSchema = Type.Object(
	{
		code: literalUnion(TF_ERROR_CODES),
		message: Type.String({ maxLength: 8_192 }),
		recoveryAction: literalUnion(RECOVERY_ACTIONS),
		sideEffects: literalUnion(SIDE_EFFECT_LEVELS),
		commandId: Type.Optional(IdSchema),
		commitSeq: Type.Optional(NonNegativeIntSchema),
		controlDomainId: Type.Optional(IdSchema),
		projectId: Type.Optional(IdSchema),
	},
	{ additionalProperties: false },
);

export const WEB_CONTENT_CATALOG_VERSION = "taskflow-content.v1" as const;
export const WEB_SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export const WEB_DEFAULT_LOCALE = "en" as const;

export const WEB_FEATURE_IDS = [
	"overview",
	"project-detail",
	"run-detail",
	"run-timeline",
	"run-graph",
	"node-detail",
	"approval-detail",
	"attention",
	"artifacts",
	"why-stale",
	"replay",
	"policy-explanation",
	"sse",
	"polling-fallback",
	"recompute-preview",
	"approval-decision",
	"edit-approval",
	"resume-run",
	"recompute-run",
	"reconcile-run",
	"set-max-active-runs",
	"force-release",
	"rerun-saved-program",
] as const;
export const WebFeatureIdSchema = literalUnion(WEB_FEATURE_IDS);
export type WebFeatureId = (typeof WEB_FEATURE_IDS)[number];

export const WEB_COMMAND_KINDS = [
	"approve",
	"reject",
	"edit-approval",
	"cancel-run",
	"resume-run",
	"recompute-run",
	"reconcile-run",
	"set-max-active-runs",
	"force-release",
] as const;
export const WebCommandKindSchema = literalUnion(WEB_COMMAND_KINDS);
export type WebCommandKind = (typeof WEB_COMMAND_KINDS)[number];

export const WebVisibleMountSchema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
	},
	{ additionalProperties: false },
);

export const WebProjectWatermarkV5Schema = Type.Object(
	{
		projectId: IdSchema,
		controlDomainId: IdSchema,
		nextCommitSeq: NonNegativeIntSchema,
		minAvailableCommitSeq: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

export const WebRegistryContextSchema = Type.Union([
	Type.Object(
		{
			mode: Type.Literal("auto"),
			registryRevision: IdSchema,
			visibleMounts: Type.Array(WebVisibleMountSchema, {
				maxItems: 200,
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			mode: Type.Literal("standalone"),
			registryRevision: Type.Literal("standalone"),
			visibleMounts: Type.Tuple([WebVisibleMountSchema]),
		},
		{ additionalProperties: false },
	),
]);

export const WebSourceObservationSchema = Type.Object(
	{
		coverage: literalUnion(["complete", "partial"]),
		authority: literalUnion(["verified", "unverified"]),
		observedAt: TimestampSchema,
		registryContext: WebRegistryContextSchema,
		watermarks: Type.Array(WebProjectWatermarkV5Schema, { maxItems: 200 }),
	},
	{ additionalProperties: false },
);

export const WEB_TASK_HEADLINE_KEYS = [
	"task.working",
	"task.working-multiple",
	"task.waiting-to-start",
	"task.needs-input",
	"task.stopping",
	"task.checking-execution",
	"task.could-not-continue",
	"task.failed",
	"task.cancelled",
	"task.completed",
] as const;

export const WEB_TASK_DETAIL_KEYS = [
	"task.working.one.detail",
	"task.working.many.detail",
	"task.waiting.generic.detail",
	"task.waiting.capacity.detail",
	"task.waiting.policy.detail",
	"task.approval-required.detail",
	"task.stopping.confirmation.detail",
	"task.reconciling.ambiguous.detail",
	"task.blocked.reason.detail",
	"task.failed.terminal.detail",
	"task.cancelled.quiescent.detail",
	"task.completed.verification.detail",
] as const;

export const WEB_OBSERVATION_KEYS = [
	"observation.live-updates-paused",
	"observation.source-coverage-partial",
	"observation.source-authority-unverified",
	"observation.source-ready",
] as const;

export const WEB_VERIFICATION_STATES = [
	"verified",
	"partially-verified",
	"verification-unavailable",
	"verification-failed",
	"not-yet-verified",
	"not-applicable",
] as const;
export const WebVerificationStateSchema = literalUnion(WEB_VERIFICATION_STATES);

export const WEB_VERIFICATION_CHECK_STATES = [
	"ok",
	"not-applicable",
	"unknown",
	"unavailable",
	"mismatch",
	"in-progress",
] as const;
export const WebVerificationCheckStateSchema = literalUnion(
	WEB_VERIFICATION_CHECK_STATES,
);

export const WEB_VERIFICATION_REASON_CODES = [
	"all-required-checks-ok",
	"required-check-unknown",
	"artifact-retained-without-blob",
	"receipt-missing",
	"verifier-unavailable",
	"no-required-check-completed",
	"manifest-mismatch",
	"artifact-digest-mismatch",
	"provenance-mismatch",
	"provider-outcome-mismatch",
	"run-non-terminal",
	"verification-in-progress",
	"lifecycle-not-applicable",
] as const;
export const WebVerificationReasonCodeSchema = literalUnion(
	WEB_VERIFICATION_REASON_CODES,
);

export const WEB_VERIFICATION_CONTENT_KEYS = [
	"verification.verified",
	"verification.verified.detail",
	"verification.partially-verified",
	"verification.partially-verified.detail",
	"verification.unavailable",
	"verification.unavailable.detail",
	"verification.failed",
	"verification.failed.detail",
	"verification.not-yet-verified",
	"verification.not-yet-verified.detail",
	"verification.not-applicable",
	"verification.not-applicable.detail",
] as const;

export const WEB_DECISION_OPERATION_CLASSES = [
	"publish-files",
	"change-files",
	"use-network",
	"run-tool",
	"spend-budget",
	"continue-task",
	"apply-edit",
	"generic-action",
] as const;
export const WebDecisionOperationClassSchema = literalUnion(
	WEB_DECISION_OPERATION_CLASSES,
);

const decisionContentKeys = WEB_DECISION_OPERATION_CLASSES.flatMap((operation) => [
	`decision.${operation}.question`,
	`decision.${operation}.impact`,
	`decision.${operation}.allow-label`,
	`decision.${operation}.do-not-allow-label`,
	`decision.${operation}.allow-consequence`,
	`decision.${operation}.do-not-allow-consequence`,
]);
const errorContentKeys = TF_ERROR_CODES.flatMap((code) => [
	`error.${code}.headline`,
	`error.${code}.detail`,
]);

export const WEB_RECOVERY_CONTENT_KEYS = [
	"recovery.retry-same-command",
	"recovery.retry-new-command",
	"recovery.refresh",
	"recovery.reconcile",
	"recovery.operator",
	"recovery.none",
] as const;
export const WEB_RISK_CONTENT_KEYS = [
	"risk.none",
	"risk.possible-live-side-effects",
	"risk.unknown-side-effects",
] as const;
export const WEB_ATTENTION_CONTENT_KEYS = [
	"attention.project-unavailable",
	"attention.decision-required",
	"attention.execution-unconfirmed",
	"attention.review-required",
	"attention.execution-place-held",
] as const;
export const WEB_EMPTY_SYSTEM_CONTENT_KEYS = [
	"empty.home.no-tasks",
	"empty.task.no-result",
	"empty.tasks.no-results",
	"empty.needs-input.none",
	"empty.workspaces.none",
	"system.cursor-expired",
	"system.cursor-expired.refresh",
	"system.partial-workspaces",
	"system.no-action-required",
] as const;

export const WEB_PROJECTED_CONTENT_KEYS = [
	...WEB_TASK_HEADLINE_KEYS,
	...WEB_TASK_DETAIL_KEYS,
	...WEB_OBSERVATION_KEYS,
	...WEB_VERIFICATION_CONTENT_KEYS,
	...decisionContentKeys,
	...errorContentKeys,
	...WEB_RECOVERY_CONTENT_KEYS,
	...WEB_RISK_CONTENT_KEYS,
	...WEB_ATTENTION_CONTENT_KEYS,
	...WEB_EMPTY_SYSTEM_CONTENT_KEYS,
] as const;
export type WebProjectedContentKey =
	(typeof WEB_PROJECTED_CONTENT_KEYS)[number];
export const WebProjectedContentKeySchema = literalUnion(
	WEB_PROJECTED_CONTENT_KEYS,
);

export const WEB_CAPACITY_REASON_CODES = [
	"capacity-full",
	"waiting-for-reservation",
	"coordinator-unavailable",
] as const;
export const WEB_BLOCKING_REASON_CODES = [
	"policy-denied",
	"dependency-failed",
	"approval-expired",
	"provider-failed",
	"verification-required",
	"unknown",
] as const;

const SanitizedStringSchema = Type.String({ maxLength: 512 });
const webContentArgSchemas = {
	activeStepLabel: Type.Object(
		{ name: Type.Literal("activeStepLabel"), value: SanitizedStringSchema },
		{ additionalProperties: false },
	),
	taskDisplayTitle: Type.Object(
		{ name: Type.Literal("taskDisplayTitle"), value: SanitizedStringSchema },
		{ additionalProperties: false },
	),
	workspaceDisplayName: Type.Object(
		{
			name: Type.Literal("workspaceDisplayName"),
			value: SanitizedStringSchema,
		},
		{ additionalProperties: false },
	),
	activeStepCount: Type.Object(
		{ name: Type.Literal("activeStepCount"), value: NonNegativeIntSchema },
		{ additionalProperties: false },
	),
	completedStepCount: Type.Object(
		{ name: Type.Literal("completedStepCount"), value: NonNegativeIntSchema },
		{ additionalProperties: false },
	),
	workspaceCount: Type.Object(
		{ name: Type.Literal("workspaceCount"), value: NonNegativeIntSchema },
		{ additionalProperties: false },
	),
	omittedWorkspaceCount: Type.Object(
		{
			name: Type.Literal("omittedWorkspaceCount"),
			value: NonNegativeIntSchema,
		},
		{ additionalProperties: false },
	),
	preservedResultCount: Type.Object(
		{
			name: Type.Literal("preservedResultCount"),
			value: NonNegativeIntSchema,
		},
		{ additionalProperties: false },
	),
	activeStepLabels: Type.Object(
		{
			name: Type.Literal("activeStepLabels"),
			value: Type.Array(SanitizedStringSchema, { maxItems: 20 }),
		},
		{ additionalProperties: false },
	),
	deadline: Type.Object(
		{ name: Type.Literal("deadline"), value: TimestampSchema },
		{ additionalProperties: false },
	),
	capacityReason: Type.Object(
		{
			name: Type.Literal("capacityReason"),
			value: literalUnion(WEB_CAPACITY_REASON_CODES),
		},
		{ additionalProperties: false },
	),
	blockingReason: Type.Object(
		{
			name: Type.Literal("blockingReason"),
			value: literalUnion(WEB_BLOCKING_REASON_CODES),
		},
		{ additionalProperties: false },
	),
	recoveryLabel: Type.Object(
		{
			name: Type.Literal("recoveryLabel"),
			value: literalUnion(RECOVERY_ACTIONS),
		},
		{ additionalProperties: false },
	),
	verificationReason: Type.Object(
		{
			name: Type.Literal("verificationReason"),
			value: WebVerificationReasonCodeSchema,
		},
		{ additionalProperties: false },
	),
} as const;

export type WebContentArgName = keyof typeof webContentArgSchemas;
export const WEB_CONTENT_ARG_NAMES = Object.freeze(
	Object.keys(webContentArgSchemas).sort((a, b) =>
		a.localeCompare(b, "en"),
	) as WebContentArgName[],
);

export type WebContentArg = Static<
	(typeof webContentArgSchemas)[keyof typeof webContentArgSchemas]
>;
const webContentArgUnionSchema = Type.Union(
	Object.values(webContentArgSchemas) as unknown as [
		TSchema,
		TSchema,
		...TSchema[],
	],
);
export const WebContentArgSchema =
	Type.Unsafe<WebContentArg>(webContentArgUnionSchema);

const projectedContentArguments = Object.fromEntries(
	WEB_PROJECTED_CONTENT_KEYS.map((key) => [key, [] as WebContentArgName[]]),
) as Record<WebProjectedContentKey, WebContentArgName[]>;
projectedContentArguments["task.working.one.detail"] = [
	"activeStepCount",
	"activeStepLabels",
];
projectedContentArguments["task.working.many.detail"] = [
	"activeStepCount",
	"activeStepLabels",
];
projectedContentArguments["task.waiting.capacity.detail"] = ["capacityReason"];
projectedContentArguments["task.blocked.reason.detail"] = ["blockingReason"];
projectedContentArguments["task.failed.terminal.detail"] = [
	"preservedResultCount",
];
projectedContentArguments["task.completed.verification.detail"] = [
	"verificationReason",
];
projectedContentArguments["system.partial-workspaces"] = [
	"omittedWorkspaceCount",
];
for (const key of WEB_VERIFICATION_CONTENT_KEYS) {
	projectedContentArguments[key] = ["verificationReason"];
}
for (const key of WEB_PROJECTED_CONTENT_KEYS) {
	projectedContentArguments[key].sort((a, b) => a.localeCompare(b, "en"));
	Object.freeze(projectedContentArguments[key]);
}

export const WEB_PROJECTED_CONTENT_ARGUMENTS = Object.freeze(
	projectedContentArguments,
) as Readonly<
	Record<WebProjectedContentKey, readonly WebContentArgName[]>
>;

const contentMessageSchemas = WEB_PROJECTED_CONTENT_KEYS.map((key) =>
	Type.Object(
		{
			catalogVersion: Type.Literal(WEB_CONTENT_CATALOG_VERSION),
			key: Type.Literal(key),
			args: Type.Tuple(
				WEB_PROJECTED_CONTENT_ARGUMENTS[key].map(
					(name) => webContentArgSchemas[name],
				),
			),
		},
		{ additionalProperties: false },
	),
);

/**
 * A key-specific closed message codec. Each key admits exactly its registered
 * arguments in canonical name order; a missing, extra, duplicated, or
 * out-of-order argument therefore fails at the wire boundary.
 */
export type WebContentMessage = {
	catalogVersion: typeof WEB_CONTENT_CATALOG_VERSION;
	key: WebProjectedContentKey;
	args: WebContentArg[];
};
const webContentMessageUnionSchema = Type.Union(
	contentMessageSchemas as unknown as [TSchema, TSchema, ...TSchema[]],
);
export const WebContentMessageSchema =
	Type.Unsafe<WebContentMessage>(webContentMessageUnionSchema);

const ProjectRunActionBase = {
	projectId: IdSchema,
	controlDomainId: IdSchema,
	runId: IdSchema,
	expectedRunVersion: NonNegativeIntSchema,
};

const actionBaseSchemas = {
	approve: Type.Object(
		{
			kind: Type.Literal("approve"),
			...ProjectRunActionBase,
			approvalRequestId: IdSchema,
		},
		{ additionalProperties: false },
	),
	reject: Type.Object(
		{
			kind: Type.Literal("reject"),
			...ProjectRunActionBase,
			approvalRequestId: IdSchema,
		},
		{ additionalProperties: false },
	),
	"edit-approval": Type.Object(
		{
			kind: Type.Literal("edit-approval"),
			...ProjectRunActionBase,
			approvalRequestId: IdSchema,
		},
		{ additionalProperties: false },
	),
	"cancel-run": Type.Object(
		{ kind: Type.Literal("cancel-run"), ...ProjectRunActionBase },
		{ additionalProperties: false },
	),
	"resume-run": Type.Object(
		{ kind: Type.Literal("resume-run"), ...ProjectRunActionBase },
		{ additionalProperties: false },
	),
	"recompute-run": Type.Object(
		{ kind: Type.Literal("recompute-run"), ...ProjectRunActionBase },
		{ additionalProperties: false },
	),
	"reconcile-run": Type.Object(
		{ kind: Type.Literal("reconcile-run"), ...ProjectRunActionBase },
		{ additionalProperties: false },
	),
	"set-max-active-runs": Type.Object(
		{
			kind: Type.Literal("set-max-active-runs"),
			expectedMaxActiveRuns: PositiveIntSchema,
			expectedCoordinatorEpoch: NonNegativeIntSchema,
		},
		{ additionalProperties: false },
	),
	"force-release": Type.Object(
		{
			kind: Type.Literal("force-release"),
			reservationId: IdSchema,
			expectedState: literalUnion(["committed", "orphan-suspect"]),
			expectedRevision: PositiveIntSchema,
			expectedCoordinatorEpoch: NonNegativeIntSchema,
			expectedProjectId: IdSchema,
			expectedControlDomainId: IdSchema,
			expectedRunId: IdSchema,
			acknowledgement: Type.Literal(FORCE_RELEASE_ACKNOWLEDGEMENT),
		},
		{ additionalProperties: false },
	),
} as const;

export const WebActionRequestBaseSchema = Type.Union(
	Object.values(actionBaseSchemas),
);

const availableActionSchemas = WEB_COMMAND_KINDS.map((kind) =>
	Type.Object(
		{
			kind: Type.Literal(kind),
			state: Type.Literal("available"),
			requestBase: actionBaseSchemas[kind],
		},
		{ additionalProperties: false },
	),
);
const unavailableActionSchemas = WEB_COMMAND_KINDS.map((kind) =>
	Type.Object(
		{
			kind: Type.Literal(kind),
			state: Type.Literal("unavailable"),
			reason: WebControlErrorSchema,
		},
		{ additionalProperties: false },
	),
);

export const WebAvailableActionSchema = Type.Union([
	Type.Union([
		availableActionSchemas[0]!,
		...availableActionSchemas.slice(1),
	]),
	Type.Union([
		unavailableActionSchemas[0]!,
		...unavailableActionSchemas.slice(1),
	]),
]);

export const WebProviderConsistencySchema = Type.Object(
	{
		expected: Type.Union([
			Type.Object(
				{
					kind: Type.Literal("exact"),
					outcome: literalUnion(["completed", "failed", "cancelled"]),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{ kind: Type.Literal("not-admitted"), evidenceRef: IdSchema },
				{ additionalProperties: false },
			),
		]),
		observed: Type.Optional(
			literalUnion(["completed", "failed", "cancelled"]),
		),
		check: WebVerificationCheckStateSchema,
		sourceEventRefs: Type.Array(IdSchema, { maxItems: 200 }),
	},
	{ additionalProperties: false },
);

export const WebArtifactVerificationCheckSchema = Type.Object(
	{
		artifactId: IdSchema,
		digest: DigestSchema,
		required: Type.Boolean(),
		state: WebVerificationCheckStateSchema,
	},
	{ additionalProperties: false },
);

export const WebVerificationProjectionInputSchema = Type.Object(
	{
		runStatus: RunStatusSchema,
		checkedAt: TimestampSchema,
		lifecycleRequiresVerification: Type.Boolean(),
		receiptId: Type.Optional(IdSchema),
		verifierAvailable: Type.Boolean(),
		eventManifest: WebVerificationCheckStateSchema,
		journalContinuity: WebVerificationCheckStateSchema,
		provenance: WebVerificationCheckStateSchema,
		artifactIntegrity: WebVerificationCheckStateSchema,
		providerConsistency: WebProviderConsistencySchema,
		artifactChecks: Type.Array(WebArtifactVerificationCheckSchema, {
			maxItems: 200,
		}),
		artifactCheckCount: NonNegativeIntSchema,
		requiredArtifactCheckCount: NonNegativeIntSchema,
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false },
);

export const WebVerificationPresentationSchema = Type.Object(
	{
		state: WebVerificationStateSchema,
		reason: WebVerificationReasonCodeSchema,
		label: WebContentMessageSchema,
		detail: WebContentMessageSchema,
		checkedAt: TimestampSchema,
		receiptId: Type.Optional(IdSchema),
		providerConsistency: WebProviderConsistencySchema,
		eventManifest: WebVerificationCheckStateSchema,
		journalContinuity: WebVerificationCheckStateSchema,
		provenance: WebVerificationCheckStateSchema,
		artifactIntegrity: WebVerificationCheckStateSchema,
		artifactCheckCount: NonNegativeIntSchema,
		requiredArtifactCheckCount: NonNegativeIntSchema,
		artifactChecks: Type.Array(WebArtifactVerificationCheckSchema, {
			maxItems: 200,
		}),
		sourceObservation: WebSourceObservationSchema,
	},
	{ additionalProperties: false },
);

export const WebDecisionProjectionInputSchema = Type.Object(
	{
		operationClass: WebDecisionOperationClassSchema,
		deadline: Type.Optional(TimestampSchema),
		quotedContext: Type.Optional(PreviewTextSchema),
		projectId: IdSchema,
		controlDomainId: IdSchema,
		runId: IdSchema,
		approvalRequestId: IdSchema,
		runVersion: NonNegativeIntSchema,
		approvalVersion: NonNegativeIntSchema,
		availableActions: Type.Array(WebAvailableActionSchema, { maxItems: 18 }),
	},
	{ additionalProperties: false },
);

export const WebDecisionPresentationSchema = Type.Object(
	{
		projectionVersion: Type.Literal("decision-presentation.v1"),
		operationClass: WebDecisionOperationClassSchema,
		question: WebContentMessageSchema,
		impact: WebContentMessageSchema,
		deadline: Type.Optional(TimestampSchema),
		quotedContext: Type.Optional(PreviewTextSchema),
		choices: Type.Tuple([
			Type.Object(
				{
					kind: Type.Literal("approve"),
					label: WebContentMessageSchema,
					consequence: WebContentMessageSchema,
					semanticWeight: Type.Literal("equal"),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("reject"),
					label: WebContentMessageSchema,
					consequence: WebContentMessageSchema,
					semanticWeight: Type.Literal("equal"),
				},
				{ additionalProperties: false },
			),
		]),
		noDefault: Type.Literal(true),
		source: Type.Object(
			{
				projectId: IdSchema,
				controlDomainId: IdSchema,
				runId: IdSchema,
				approvalRequestId: IdSchema,
				runVersion: NonNegativeIntSchema,
				approvalVersion: NonNegativeIntSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const WebDecisionSetSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("actionable"),
			presentation: WebDecisionPresentationSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			status: Type.Literal("status-only"),
			reason: WebControlErrorSchema,
		},
		{ additionalProperties: false },
	),
]);

export const WebNodePresentationSourceSchema = Type.Object(
	{
		authoredPhaseId: IdSchema,
		groupId: IdSchema,
		role: literalUnion(["step", "implementation"]),
		ordinal: NonNegativeIntSchema,
		label: DisplayTextSchema,
	},
	{ additionalProperties: false },
);

export const WebTaskProjectionNodeSchema = Type.Object(
	{
		nodeInstanceId: IdSchema,
		status: literalUnion([
			"pending",
			"running",
			"waiting",
			"completed",
			"failed",
			"cancelled",
			"blocked",
		]),
		origin: literalUnion(["static", "dynamic"]),
		presentation: WebNodePresentationSourceSchema,
	},
	{ additionalProperties: false },
);

export const WebPresentedStepSchema = Type.Object(
	{
		nodeInstanceId: IdSchema,
		groupId: IdSchema,
		label: DisplayTextSchema,
		status: literalUnion([
			"pending",
			"running",
			"waiting",
			"completed",
			"failed",
			"cancelled",
			"blocked",
		]),
		ordinal: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

export const WebPresentedStepGroupSchema = Type.Object(
	{
		groupId: IdSchema,
		label: DisplayTextSchema,
		state: literalUnion([
			"pending",
			"running",
			"waiting",
			"completed",
			"failed",
			"cancelled",
			"blocked",
		]),
		origin: literalUnion(["static", "dynamic", "mixed"]),
		memberCount: PositiveIntSchema,
		memberNodeInstanceIds: Type.Array(IdSchema, { maxItems: 200 }),
		helperNodesCollapsed: Type.Boolean(),
		membersTruncated: Type.Boolean(),
		ordinal: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

export const WebTaskProgressSchema = Type.Union([
	Type.Object(
		{
			semantics: Type.Literal("exact"),
			completed: NonNegativeIntSchema,
			total: NonNegativeIntSchema,
			inventorySealed: Type.Literal(true),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			semantics: Type.Literal("lower-bound"),
			completed: NonNegativeIntSchema,
			inventorySealed: Type.Literal(false),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			semantics: Type.Literal("indeterminate"),
			reason: literalUnion([
				"source-unverified",
				"inventory-missing",
				"presentation-metadata-invalid",
			]),
		},
		{ additionalProperties: false },
	),
]);

const ResultSourceSchema = Type.Object(
	{
		sourceId: IdSchema,
		sourceKind: literalUnion(["phase", "node", "artifact", "runtime"]),
	},
	{ additionalProperties: false },
);
const ResultArtifactSchema = Type.Object(
	{
		artifactId: IdSchema,
		digest: DigestSchema,
		mediaType: Type.String({ minLength: 1, maxLength: 512 }),
		size: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

export const WebTaskResultPresentationSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("none") },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("text"),
			source: ResultSourceSchema,
			preview: PreviewTextSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("json"),
			source: ResultSourceSchema,
			preview: PreviewTextSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("artifact"),
			source: ResultSourceSchema,
			artifacts: Type.Array(ResultArtifactSchema, {
				minItems: 1,
				maxItems: 200,
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("error"),
			source: ResultSourceSchema,
			preview: PreviewTextSchema,
		},
		{ additionalProperties: false },
	),
]);

export const WebPresentationActionSchema = Type.Object(
	{
		kind: literalUnion([
			"open-required-input",
			"refresh-authority",
			"open-result",
			"open-error-details",
			"none",
		]),
	},
	{ additionalProperties: false },
);

export const WebTaskDecisionProvenanceSchema = Type.Object(
	{
		runStatus: RunStatusSchema,
		runStage: RunStageSchema,
		runVersion: NonNegativeIntSchema,
		needsOperator: Type.Boolean(),
		sideEffects: literalUnion(SIDE_EFFECT_LEVELS),
		activeNodeIds: Type.Array(IdSchema, { maxItems: 20 }),
		activeGroupIds: Type.Array(IdSchema, { maxItems: 20 }),
		finalResultSourceId: Type.Optional(IdSchema),
		finalResultKind: literalUnion(["text", "json", "artifact", "error", "none"]),
		verificationReceiptId: Type.Optional(IdSchema),
		verificationCheck: WebVerificationStateSchema,
		primaryActionSource: literalUnion([
			"decision-disposition",
			"source-observation",
			"result",
			"error",
			"none",
		]),
	},
	{ additionalProperties: false },
);

export const WebPresentationWarningSchema = Type.Object(
	{
		code: literalUnion([
			"source-unverified",
			"presentation-metadata-invalid",
			"step-inventory-truncated",
			"group-members-truncated",
		]),
		nodeInstanceId: Type.Optional(IdSchema),
	},
	{ additionalProperties: false },
);

export const WebTaskPresentationSchema = Type.Object(
	{
		projectionVersion: Type.Literal("task-presentation.v1"),
		source: Type.Object(
			{
				runVersion: NonNegativeIntSchema,
				boundPlanHash: DigestSchema,
				observedAt: TimestampSchema,
				sourceObservation: WebSourceObservationSchema,
			},
			{ additionalProperties: false },
		),
		headline: WebContentMessageSchema,
		detail: WebContentMessageSchema,
		activeStepCount: NonNegativeIntSchema,
		activeSteps: Type.Array(WebPresentedStepSchema, { maxItems: 20 }),
		stepGroupCount: NonNegativeIntSchema,
		stepGroups: Type.Array(WebPresentedStepGroupSchema, { maxItems: 200 }),
		progress: WebTaskProgressSchema,
		result: WebTaskResultPresentationSchema,
		verification: WebVerificationPresentationSchema,
		primaryAction: WebPresentationActionSchema,
		decisionSet: Type.Optional(WebDecisionSetSchema),
		decisionProvenance: WebTaskDecisionProvenanceSchema,
		warnings: Type.Array(WebPresentationWarningSchema, { maxItems: 200 }),
	},
	{
		additionalProperties: false,
		"x-web-additive": true,
	},
);

export const WebTaskPresentationSummarySchema = Type.Object(
	{
		projectionVersion: Type.Literal("task-presentation.v1"),
		runVersion: NonNegativeIntSchema,
		headline: WebContentMessageSchema,
		detail: WebContentMessageSchema,
		activeStepCount: NonNegativeIntSchema,
		activeStepLabels: Type.Array(DisplayTextSchema, { maxItems: 3 }),
		progress: WebTaskProgressSchema,
		verificationState: WebVerificationStateSchema,
		verificationReason: WebVerificationReasonCodeSchema,
		navigationAction: WebPresentationActionSchema,
	},
	{
		additionalProperties: false,
		"x-web-additive": true,
	},
);
export const WebTaskPresentationConsumerSchema = webAdditiveConsumerSchema(
	WebTaskPresentationSchema,
);
export const WebTaskPresentationSummaryConsumerSchema =
	webAdditiveConsumerSchema(WebTaskPresentationSummarySchema);

const WebTaskRunCommonProperties = {
	runVersion: NonNegativeIntSchema,
	boundPlanHash: DigestSchema,
	needsOperator: Type.Boolean(),
	sideEffects: literalUnion(SIDE_EFFECT_LEVELS),
	displayTitle: DisplayTextSchema,
	workspaceDisplayName: DisplayTextSchema,
};

function taskRunStateSchema<
	const Status extends Static<typeof RunStatusSchema>,
	const Stage extends Static<typeof RunStageSchema>,
	const Stopping extends boolean,
>(status: Status, stage: Stage, stopping: Stopping) {
	return Type.Object(
		{
			status: Type.Literal(status),
			stage: Type.Literal(stage),
			stopping: Type.Literal(stopping),
			...WebTaskRunCommonProperties,
		},
		{ additionalProperties: false },
	);
}

/**
 * D31/D33/D38 reachable RunStatus × RunStage pairs.
 *
 * The explicit union keeps impossible presentation branches out of fixtures
 * and generated schemas. In particular, terminal statuses are terminal-stage
 * only, cancel-in-flight is exactly paused/executing/stopping, approval
 * quiescence is paused/parked, and provider ambiguity is unknown/reconciling.
 */
export const WebReachableTaskRunStateSchema = Type.Union([
	taskRunStateSchema("running", "received", false),
	taskRunStateSchema("running", "compiled", false),
	taskRunStateSchema("running", "linked", false),
	taskRunStateSchema("running", "queued", false),
	taskRunStateSchema("running", "admitted", false),
	taskRunStateSchema("running", "executing", false),
	taskRunStateSchema("paused", "parked", false),
	taskRunStateSchema("paused", "executing", true),
	taskRunStateSchema("unknown", "reconciling", false),
	taskRunStateSchema("completed", "terminal", false),
	taskRunStateSchema("failed", "terminal", false),
	taskRunStateSchema("blocked", "terminal", false),
	taskRunStateSchema("cancelled", "terminal", false),
]);

const WebTaskProjectionInputShapeSchema = Type.Object(
	{
		run: Type.Object(
			{
				status: RunStatusSchema,
				stage: RunStageSchema,
				stopping: Type.Boolean(),
				...WebTaskRunCommonProperties,
			},
			{ additionalProperties: false },
		),
		observedAt: TimestampSchema,
		sourceObservation: WebSourceObservationSchema,
		nodes: Type.Array(WebTaskProjectionNodeSchema, { maxItems: 2_000 }),
		inventorySealed: Type.Boolean(),
		presentationMetadataValid: Type.Boolean(),
		result: WebTaskResultPresentationSchema,
		verification: WebVerificationProjectionInputSchema,
		decision: Type.Optional(WebDecisionProjectionInputSchema),
		availableActions: Type.Array(WebAvailableActionSchema, { maxItems: 18 }),
		capacityReason: Type.Optional(literalUnion(WEB_CAPACITY_REASON_CODES)),
		blockingReason: Type.Optional(literalUnion(WEB_BLOCKING_REASON_CODES)),
		preservedResultCount: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

const WebTaskProjectionInputExecutableSchema = Type.Object(
	{
		...WebTaskProjectionInputShapeSchema.properties,
		run: WebReachableTaskRunStateSchema,
	},
	{ additionalProperties: false },
);

/**
 * The executable schema is stricter than the broad TypeScript construction
 * type so adapters can project a durably read RunProjection without unsafe
 * casts. Cross-field status/verification/decision invariants are asserted by
 * projectTaskPresentation at the pure projection boundary.
 */
export const WebTaskProjectionInputSchema = Type.Unsafe<
	Static<typeof WebTaskProjectionInputShapeSchema>
>(WebTaskProjectionInputExecutableSchema);

export const WebLiveStateSchema = Type.Object(
	{
		streamState: literalUnion([
			"connected",
			"catching-up",
			"disconnected",
		]),
		lastFrameAt: Type.Optional(TimestampSchema),
		resyncState: literalUnion(["idle", "required", "refreshing", "failed"]),
		invalidationEpoch: NonNegativeIntSchema,
	},
	{ additionalProperties: false },
);

export const WebAuthoritativeResourceIdentitySchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("project"),
			projectId: IdSchema,
			controlDomainId: IdSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("run"),
			projectId: IdSchema,
			controlDomainId: IdSchema,
			runId: IdSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("approval"),
			projectId: IdSchema,
			controlDomainId: IdSchema,
			runId: IdSchema,
			approvalRequestId: IdSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("reservation"), reservationId: IdSchema },
		{ additionalProperties: false },
	),
]);

export const WebAuthorityRefreshStampSchema = Type.Object(
	{
		resource: WebAuthoritativeResourceIdentitySchema,
		invalidationEpoch: NonNegativeIntSchema,
		requestId: IdSchema,
		observedAt: TimestampSchema,
	},
	{ additionalProperties: false },
);

export const WebLiveEventSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("stream-connected"), at: Type.Optional(TimestampSchema) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("stream-catching-up"), at: Type.Optional(TimestampSchema) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("stream-disconnected"), at: Type.Optional(TimestampSchema) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("reset-required"), at: Type.Optional(TimestampSchema) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("principal-capability-changed") },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("resync-started") },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("resync-succeeded") },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("resync-failed") },
		{ additionalProperties: false },
	),
]);

export const WebObservationPresentationInputSchema = Type.Object(
	{
		sourceObservation: WebSourceObservationSchema,
		liveState: WebLiveStateSchema,
		scope: Type.Union([
			Type.Object(
				{ kind: Type.Literal("aggregate") },
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("authoritative-detail"),
					resource: WebAuthoritativeResourceIdentitySchema,
					refreshStamp: Type.Optional(WebAuthorityRefreshStampSchema),
				},
				{ additionalProperties: false },
			),
		]),
	},
	{ additionalProperties: false },
);

export const WebObservationPresentationSchema = Type.Object(
	{
		projectionVersion: Type.Literal("observation-presentation.v1"),
		message: WebContentMessageSchema,
		severity: literalUnion(["neutral", "warning"]),
		stateSensitiveActionsAllowed: Type.Boolean(),
		source: Type.Object(
			{
				scope: literalUnion(["aggregate", "authoritative-detail"]),
				invalidationEpoch: NonNegativeIntSchema,
				authorityRefreshEpoch: Type.Optional(NonNegativeIntSchema),
				streamState: literalUnion([
					"connected",
					"catching-up",
					"disconnected",
				]),
				resyncState: literalUnion([
					"idle",
					"required",
					"refreshing",
					"failed",
				]),
				coverage: literalUnion(["complete", "partial"]),
				authority: literalUnion(["verified", "unverified"]),
				observedAt: TimestampSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const WebFailureSchema = Type.Object(
	{
		ok: Type.Literal(false),
		requestId: IdSchema,
		schemaVersion: Type.Literal("web.v1"),
		error: WebControlErrorSchema,
	},
	{ additionalProperties: false },
);

const WebFailureResourceStateSchema = Type.Union([
	Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
	Type.Object(
		{
			kind: Type.Literal("run"),
			status: RunStatusSchema,
			stage: RunStageSchema,
			runVersion: NonNegativeIntSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("approval"),
			status: literalUnion([
				"pending",
				"approved",
				"rejected",
				"edited",
				"expired",
				"cancelled",
			]),
			approvalVersion: NonNegativeIntSchema,
			runVersion: NonNegativeIntSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("reservation"),
			state: literalUnion([
				"reserved",
				"committed",
				"released",
				"expired",
				"orphan-suspect",
			]),
			revision: NonNegativeIntSchema,
			coordinatorEpoch: NonNegativeIntSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("command"),
			commandId: IdSchema,
			outcome: literalUnion([
				"pending",
				"completed",
				"failed",
				"rejected",
				"not-found",
			]),
		},
		{ additionalProperties: false },
	),
]);

export const WebFailurePresentationInputSchema = Type.Object(
	{
		failure: WebFailureSchema,
		context: Type.Object(
			{
				surface: literalUnion([
					"bootstrap",
					"aggregate-list",
					"authoritative-detail",
					"command-submit",
					"command-recovery",
					"artifact",
					"analysis",
					"session",
				]),
				operation: Type.Union([
					WebCommandKindSchema,
					Type.Literal("none"),
				]),
				resourceState: WebFailureResourceStateSchema,
				sourceAuthority: literalUnion(["verified", "unverified"]),
				commandBodyState: literalUnion([
					"not-applicable",
					"present-in-current-tab-memory",
					"unavailable",
				]),
				supportedFeatures: Type.Array(WebFeatureIdSchema, {
					maxItems: WEB_FEATURE_IDS.length,
					uniqueItems: true,
				}),
				supportedCommands: Type.Array(WebCommandKindSchema, {
					maxItems: WEB_COMMAND_KINDS.length,
					uniqueItems: true,
				}),
				availableActions: Type.Array(WebAvailableActionSchema, {
					maxItems: 18,
				}),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const WebFailurePresentationSchema = Type.Object(
	{
		projectionVersion: Type.Literal("failure-presentation.v1"),
		headline: WebContentMessageSchema,
		detail: WebContentMessageSchema,
		risk: WebContentMessageSchema,
		nextAction: WebContentMessageSchema,
		actionKind: literalUnion([
			"refresh",
			"retry-same-command",
			"retry-new-command",
			"open-reconcile",
			"contact-operator",
			"none",
		]),
		technical: Type.Object(
			{
				code: literalUnion(TF_ERROR_CODES),
				sanitizedMessage: Type.String({ maxLength: 8_192 }),
				requestId: IdSchema,
				commandId: Type.Optional(IdSchema),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type WebSourceObservation = Static<typeof WebSourceObservationSchema>;
export type WebRegistryContext = Static<typeof WebRegistryContextSchema>;
export type WebAvailableAction = Static<typeof WebAvailableActionSchema>;
export type WebVerificationProjectionInput = Static<
	typeof WebVerificationProjectionInputSchema
>;
export type WebVerificationPresentation = Static<
	typeof WebVerificationPresentationSchema
>;
export type WebDecisionProjectionInput = Static<
	typeof WebDecisionProjectionInputSchema
>;
export type WebDecisionPresentation = Static<
	typeof WebDecisionPresentationSchema
>;
export type WebDecisionSet = Static<typeof WebDecisionSetSchema>;
export type WebTaskProjectionInput = Static<typeof WebTaskProjectionInputSchema>;
export type WebTaskPresentation = Static<typeof WebTaskPresentationSchema>;
export type WebTaskPresentationSummary = Static<
	typeof WebTaskPresentationSummarySchema
>;
export type WebLiveState = Static<typeof WebLiveStateSchema>;
export type WebLiveEvent = Static<typeof WebLiveEventSchema>;
export type WebAuthoritativeResourceIdentity = Static<
	typeof WebAuthoritativeResourceIdentitySchema
>;
export type WebAuthorityRefreshStamp = Static<
	typeof WebAuthorityRefreshStampSchema
>;
export type WebObservationPresentationInput = Static<
	typeof WebObservationPresentationInputSchema
>;
export type WebObservationPresentation = Static<
	typeof WebObservationPresentationSchema
>;
export type WebFailurePresentationInput = Static<
	typeof WebFailurePresentationInputSchema
>;
export type WebFailurePresentation = Static<
	typeof WebFailurePresentationSchema
>;

export { OpaqueCursorSchema as WebOpaqueCursorSchema };
