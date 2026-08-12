/**
 * Transport wire types (🟥 NEW): negotiation handshake, unified error
 * envelope + the closed TF_* code set (P4), and the ExecutionProvider DTO
 * group (RFC §16) as discriminated accepted|rejected|ambiguous unions.
 */

import { Type } from "typebox";
import { StringEnum } from "taskflow-core/typebox-helpers";
import { UuidSchema } from "./common.ts";
import { EnforcementCapabilitiesSchema, type EnforcementCapabilities } from "./policy.ts";
import { ExecutionOwnerSchema, type ExecutionOwner } from "./te-mirrors.ts";
import { BoundPlanSchema, type BoundPlan } from "./plan.ts";

// ---------------------------------------------------------------------------
// NegotiationHandshake (P4 / RFC §18)
// ---------------------------------------------------------------------------

export const PROTOCOL_MAJOR = 1;

export const NegotiationHandshakeSchema = Type.Object(
	{
		protocolMajor: Type.Literal(PROTOCOL_MAJOR),
		supportedReadSchemas: Type.Array(Type.String({ minLength: 1 })),
		supportedWriteSchemas: Type.Array(Type.String({ minLength: 1 })),
		requiredFeatures: Type.Array(Type.String({ minLength: 1 })),
		offeredFeatures: Type.Array(Type.String({ minLength: 1 })),
		buildInfo: Type.Object(
			{
				packageVersion: Type.String({ minLength: 1 }),
				gitCommit: Type.String({ minLength: 1 }),
				schemaVersion: Type.Integer({ minimum: 0 }),
				buildTime: Type.Optional(Type.Integer({ minimum: 0 })),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type NegotiationHandshake = {
	protocolMajor: typeof PROTOCOL_MAJOR;
	supportedReadSchemas: string[];
	supportedWriteSchemas: string[];
	requiredFeatures: string[];
	offeredFeatures: string[];
	buildInfo: {
		packageVersion: string;
		gitCommit: string;
		schemaVersion: number;
		buildTime?: number;
	};
};

// ---------------------------------------------------------------------------
// ErrorEnvelope + closed TF_* code set (P4)
// ---------------------------------------------------------------------------

export const CONTROL_ERROR_CODES = [
	"TF_PROTOCOL_INCOMPATIBLE",
	"TF_SCHEMA_UNSUPPORTED",
	"TF_FEATURE_REQUIRED",
	"TF_POLICY_DENIED",
	"TF_AUTHORITY_REVOKED",
	"TF_STALE_VERSION",
	"TF_IDEMPOTENCY_CONFLICT",
	"TF_CROSS_PRINCIPAL_COMMAND",
	"TF_LEGACY_CONFLICT",
	"TF_PROVIDER_AMBIGUOUS",
	"TF_JOURNAL_UNAVAILABLE",
	"TF_DURABILITY_FAILED",
	"TF_CURSOR_EXPIRED",
	"TF_COMMAND_FAILED",
	"TF_BOOTSTRAP_FAILED",
	"TF_RECONCILE_REQUIRED",
	"TF_ADMISSION_BINDING_CONFLICT",
	"TF_CAPACITY_EXCEEDED",
] as const;
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

export const RecoveryActionSchema = StringEnum([
	"retry-same-command",
	"retry-new-command",
	"refresh",
	"reconcile",
	"operator",
	"none",
]);
export type RecoveryAction = "retry-same-command" | "retry-new-command" | "refresh" | "reconcile" | "operator" | "none";

export const SideEffectsSchema = StringEnum(["none", "possible", "unknown"]);
export type SideEffects = "none" | "possible" | "unknown";

export const ErrorEnvelopeSchema = Type.Object(
	{
		code: StringEnum(CONTROL_ERROR_CODES),
		message: Type.String({ minLength: 1 }),
		recoveryAction: RecoveryActionSchema,
		sideEffects: SideEffectsSchema,
		commandId: Type.Optional(UuidSchema),
		commitSeq: Type.Optional(Type.Integer({ minimum: 1 })),
		controlDomainId: Type.Optional(UuidSchema),
		projectId: Type.Optional(UuidSchema),
	},
	{ additionalProperties: false },
);
export type ErrorEnvelope = {
	code: ControlErrorCode;
	message: string;
	recoveryAction: RecoveryAction;
	sideEffects: SideEffects;
	commandId?: string;
	commitSeq?: number;
	controlDomainId?: string;
	projectId?: string;
};

// ---------------------------------------------------------------------------
// ExecutionProvider DTO group (RFC §16) — 0.3-C's only provider is TE
// resources, but the wire keeps the async provider contract.
// ---------------------------------------------------------------------------

export const ProviderRequestBaseSchema = Type.Object(
	{
		runId: UuidSchema,
		owner: ExecutionOwnerSchema,
		controlDomainId: UuidSchema,
	},
	{ additionalProperties: false },
);

export const ProviderAcceptedSchema = <T extends { [K in "outcome"]: "accepted" }>(fields: T) =>
	Type.Object({ ...fields, outcome: Type.Literal("accepted") }, { additionalProperties: false });

export const ProviderRejectedSchema = Type.Object(
	{
		outcome: Type.Literal("rejected"),
		error: Type.Object(
			{
				code: StringEnum(CONTROL_ERROR_CODES),
				message: Type.String({ minLength: 1 }),
				recoveryAction: RecoveryActionSchema,
				sideEffects: SideEffectsSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const ProviderAmbiguousSchema = Type.Object(
	{
		outcome: Type.Literal("ambiguous"),
		message: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const ProviderCapabilitiesSchema = Type.Object(
	{
		processIsolation: StringEnum(["none", "sandboxed"]),
		resolution: Type.Literal("contained"),
		mutationMediation: Type.Literal("brokered"),
		revocation: Type.Literal("admission-only"),
		baselinePolicyId: Type.String({ minLength: 1 }),
		hostProbeSha256: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type ProviderCapabilities = {
	processIsolation: "none" | "sandboxed";
	resolution: "contained";
	mutationMediation: "brokered";
	revocation: "admission-only";
	baselinePolicyId: string;
	hostProbeSha256: string;
};

export const ProbeResultSchema = Type.Object(
	{
		outcome: Type.Literal("accepted"),
		capabilities: ProviderCapabilitiesSchema,
	},
	{ additionalProperties: false },
);
export type ProbeResult = { outcome: "accepted"; capabilities: ProviderCapabilities };

export const PrepareRequestSchema = Type.Object(
	{
		plan: BoundPlanSchema,
		owner: ExecutionOwnerSchema,
		controlDomainId: UuidSchema,
	},
	{ additionalProperties: false },
);
export type PrepareRequest = { plan: BoundPlan; owner: ExecutionOwner; controlDomainId: string };

export const FulfillmentPlanSchema = Type.Object(
	{
		preparationId: UuidSchema,
		enforcementCapabilities: EnforcementCapabilitiesSchema,
	},
	{ additionalProperties: false },
);
export type FulfillmentPlan = { preparationId: string; enforcementCapabilities: EnforcementCapabilities };

export const PrepareResultSchema = Type.Union([
	Type.Object(
		{ outcome: Type.Literal("accepted"), fulfillment: FulfillmentPlanSchema },
		{ additionalProperties: false },
	),
	ProviderRejectedSchema,
	ProviderAmbiguousSchema,
]);
export type PrepareResult =
	| { outcome: "accepted"; fulfillment: FulfillmentPlan }
	| { outcome: "rejected"; error: ErrorEnvelope }
	| { outcome: "ambiguous"; message?: string };

export const SubmitRequestSchema = Type.Object(
	{
		preparationId: UuidSchema,
		owner: ExecutionOwnerSchema,
		controlDomainId: UuidSchema,
	},
	{ additionalProperties: false },
);
export type SubmitRequest = { preparationId: string; owner: ExecutionOwner; controlDomainId: string };

export const SubmitResultSchema = Type.Union([
	Type.Object(
		{ outcome: Type.Literal("accepted"), providerJobHandle: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	ProviderRejectedSchema,
	ProviderAmbiguousSchema,
]);
export type SubmitResult =
	| { outcome: "accepted"; providerJobHandle: string }
	| { outcome: "rejected"; error: ErrorEnvelope }
	| { outcome: "ambiguous"; message?: string };

export const ProviderEventSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("progress"), message: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("heartbeat"), at: Type.Integer({ minimum: 0 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("terminal"),
			outcome: StringEnum(["completed", "failed", "ambiguous"]),
		},
		{ additionalProperties: false },
	),
]);
export type ProviderEvent =
	| { kind: "progress"; message: string }
	| { kind: "heartbeat"; at: number }
	| { kind: "terminal"; outcome: "completed" | "failed" | "ambiguous" };

export const PollResultSchema = Type.Union([
	Type.Object(
		{
			outcome: Type.Literal("accepted"),
			status: StringEnum(["running", "completed", "failed", "ambiguous"]),
		},
		{ additionalProperties: false },
	),
	ProviderRejectedSchema,
	ProviderAmbiguousSchema,
]);
export type PollResult =
	| { outcome: "accepted"; status: "running" | "completed" | "failed" | "ambiguous" }
	| { outcome: "rejected"; error: ErrorEnvelope }
	| { outcome: "ambiguous"; message?: string };

export const CancelResultSchema = Type.Union([
	Type.Object(
		{
			outcome: Type.Literal("accepted"),
			cancelled: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
	ProviderRejectedSchema,
	ProviderAmbiguousSchema,
]);
export type CancelResult =
	| { outcome: "accepted"; cancelled: boolean }
	| { outcome: "rejected"; error: ErrorEnvelope }
	| { outcome: "ambiguous"; message?: string };

export const ReconcileResultSchema = Type.Union([
	Type.Object(
		{
			outcome: Type.Literal("accepted"),
			providerState: StringEnum(["running", "terminal", "exhausted"]),
		},
		{ additionalProperties: false },
	),
	ProviderRejectedSchema,
	ProviderAmbiguousSchema,
]);
export type ReconcileResult =
	| { outcome: "accepted"; providerState: "running" | "terminal" | "exhausted" }
	| { outcome: "rejected"; error: ErrorEnvelope }
	| { outcome: "ambiguous"; message?: string };

export const CollectResultSchema = Type.Union([
	Type.Object(
		{
			outcome: Type.Literal("accepted"),
			providerJobHandle: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	ProviderRejectedSchema,
	ProviderAmbiguousSchema,
]);
export type CollectResult =
	| { outcome: "accepted"; providerJobHandle: string }
	| { outcome: "rejected"; error: ErrorEnvelope }
	| { outcome: "ambiguous"; message?: string };

/** TE capabilities are the only 0.3-C capabilities (P8 default package). */
export function capabilitiesFromEnforcement(capabilities: ProviderCapabilities): EnforcementCapabilities {
	return {
		resolution: capabilities.resolution,
		mutationMediation: capabilities.mutationMediation,
		processIsolation: capabilities.processIsolation,
		revocation: capabilities.revocation,
		baselinePolicyId: capabilities.baselinePolicyId,
		hostProbeSha256: capabilities.hostProbeSha256,
	};
}
