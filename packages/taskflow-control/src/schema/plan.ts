/**
 * BoundPlan / BoundFragment / SpawnTemplate wire types (🟥 NEW).
 *
 * Decisions: P1/P7 (immutable BoundPlan template, evidence-not-bearer), P7
 * (BoundFragment dual hashes + parent chain + authorityEpoch), P8
 * (enforcementCapabilities required — no holes), P6 (single hash family).
 */

import { Type } from "typebox";
import { CONTROL_WIRE_SCHEMA_VERSION, CanonicalHashRefSchema, UuidSchema } from "./common.ts";
import { PathRefSchema, type PathRef } from "./te-mirrors.ts";
import { EnforcementCapabilitiesSchema, type EnforcementCapabilities, PolicyBundleSchema, type PolicyBundle } from "./policy.ts";

// ---------------------------------------------------------------------------
// SpawnTemplate (P7 §7.4) — dynamic expansion ceilings
// ---------------------------------------------------------------------------

export const SpawnTemplateSchema = Type.Object(
	{
		allowedAgentClasses: Type.Array(Type.String({ minLength: 1 })),
		allowedProviderClasses: Type.Array(Type.String({ minLength: 1 })),
		maxToolCallsPerStep: Type.Integer({ minimum: 0 }),
		maxEffectsPerNode: Type.Integer({ minimum: 0 }),
		maxChildren: Type.Integer({ minimum: 1 }),
		maxDepth: Type.Integer({ minimum: 1 }),
		budgetShare: Type.Number({ minimum: 0, maximum: 1 }),
	},
	{ additionalProperties: false },
);
export type SpawnTemplate = {
	allowedAgentClasses: string[];
	allowedProviderClasses: string[];
	maxToolCallsPerStep: number;
	maxEffectsPerNode: number;
	maxChildren: number;
	maxDepth: number;
	budgetShare: number;
};

// ---------------------------------------------------------------------------
// Plan bindings / saved-flow pins / grants / claims
// ---------------------------------------------------------------------------

export const PlanBindingSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		path: PathRefSchema,
	},
	{ additionalProperties: false },
);
export type PlanBinding = { name: string; path: PathRef };

export const SavedFlowPinSchema = Type.Object(
	{
		flowId: Type.String({ minLength: 1 }),
		irHash: CanonicalHashRefSchema,
		boundPlanHash: CanonicalHashRefSchema,
	},
	{ additionalProperties: false },
);
export type SavedFlowPin = { flowId: string; irHash: string; boundPlanHash: string };

export const GrantRefSchema = Type.Object(
	{
		grantId: Type.String({ minLength: 1 }),
		bindingId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export type GrantRef = { grantId: string; bindingId?: string };

export const ClaimSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		value: Type.Union([Type.String(), Type.Boolean(), Type.Number()]),
	},
	{ additionalProperties: false },
);
export type Claim = { name: string; value: string | boolean | number };

// ---------------------------------------------------------------------------
// BoundPlan (P1/P7/P8) — immutable template; evidence-not-bearer
// ---------------------------------------------------------------------------

export const BoundPlanSchema = Type.Object(
	{
		schemaVersion: Type.Literal(CONTROL_WIRE_SCHEMA_VERSION),
		projectId: UuidSchema,
		controlDomainId: UuidSchema,
		planId: UuidSchema,
		bindings: Type.Array(PlanBindingSchema),
		spawnTemplate: SpawnTemplateSchema,
		savedFlowPins: Type.Array(SavedFlowPinSchema),
		grantRefs: Type.Array(GrantRefSchema),
		claims: Type.Array(ClaimSchema),
		enforcementCapabilities: EnforcementCapabilitiesSchema,
		dynamicPolicy: PolicyBundleSchema,
		boundPlanHash: CanonicalHashRefSchema,
	},
	{ additionalProperties: false },
);
export type BoundPlan = {
	schemaVersion: typeof CONTROL_WIRE_SCHEMA_VERSION;
	projectId: string;
	controlDomainId: string;
	planId: string;
	bindings: PlanBinding[];
	spawnTemplate: SpawnTemplate;
	savedFlowPins: SavedFlowPin[];
	grantRefs: GrantRef[];
	claims: Claim[];
	enforcementCapabilities: EnforcementCapabilities;
	dynamicPolicy: PolicyBundle;
	boundPlanHash: string;
};

// ---------------------------------------------------------------------------
// BoundFragment (P7 §7.2) — dynamic IR product under attenuated authority
// ---------------------------------------------------------------------------

export const BoundFragmentSchema = Type.Object(
	{
		schemaVersion: Type.Literal(CONTROL_WIRE_SCHEMA_VERSION),
		projectId: UuidSchema,
		controlDomainId: UuidSchema,
		fragmentId: UuidSchema,
		parentBoundPlanHash: CanonicalHashRefSchema,
		parentBoundFragmentHash: Type.Optional(CanonicalHashRefSchema),
		sourceEventId: UuidSchema,
		sourceCommitSeq: Type.Integer({ minimum: 1 }),
		fragmentIRHash: CanonicalHashRefSchema,
		fragmentPolicyHash: CanonicalHashRefSchema,
		capabilitySetHash: CanonicalHashRefSchema,
		authorityEpoch: Type.Integer({ minimum: 0 }),
		boundFragmentHash: CanonicalHashRefSchema,
		executionSemanticHash: CanonicalHashRefSchema,
	},
	{ additionalProperties: false },
);
export type BoundFragment = {
	schemaVersion: typeof CONTROL_WIRE_SCHEMA_VERSION;
	projectId: string;
	controlDomainId: string;
	fragmentId: string;
	parentBoundPlanHash: string;
	parentBoundFragmentHash?: string;
	sourceEventId: string;
	sourceCommitSeq: number;
	fragmentIRHash: string;
	fragmentPolicyHash: string;
	capabilitySetHash: string;
	authorityEpoch: number;
	boundFragmentHash: string;
	executionSemanticHash: string;
};
