/**
 * Policy + enforcement capability wire types (🟥 NEW).
 *
 * Decisions: P1/P2 (PolicyBundle with explicit inheritance + fail-closed empty
 * baseline; authorizationContextHash records the decision), P8 (orthogonal
 * EnforcementCapabilities bound to TE evidence surfaces; `unsupported` host
 * probe fails closed; 0.3-C does not offer unbound / per-mutation).
 */

import { Type } from "typebox";
import { StringEnum } from "taskflow-core/typebox-helpers";
import { Sha256HexSchema } from "./common.ts";

// ---------------------------------------------------------------------------
// PolicyBundle (P1/P2)
// ---------------------------------------------------------------------------

export const PolicyCeilingSchema = Type.Object(
	{
		maxActiveRuns: Type.Optional(Type.Integer({ minimum: 1 })),
		maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
		maxUSD: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
export type PolicyCeiling = { maxActiveRuns?: number; maxTokens?: number; maxUSD?: number };

export const PolicyBundleSchema = Type.Object(
	{
		hostCeiling: PolicyCeilingSchema,
		userCeiling: Type.Optional(PolicyCeilingSchema),
		projectCeiling: Type.Optional(PolicyCeilingSchema),
		invocationCeiling: Type.Optional(PolicyCeilingSchema),
		authorizationContextHash: Sha256HexSchema,
	},
	{ additionalProperties: false },
);
export type PolicyBundle = {
	hostCeiling: PolicyCeiling;
	userCeiling?: PolicyCeiling;
	projectCeiling?: PolicyCeiling;
	invocationCeiling?: PolicyCeiling;
	authorizationContextHash: string;
};

// ---------------------------------------------------------------------------
// EnforcementCapabilities (P8) — four orthogonal dimensions + evidence
// ---------------------------------------------------------------------------

export const ResolutionCapabilitySchema = StringEnum(["contained", "unbound"]);
export type ResolutionCapability = "contained" | "unbound";

export const MutationMediationCapabilitySchema = StringEnum(["none", "brokered"]);
export type MutationMediationCapability = "none" | "brokered";

export const ProcessIsolationCapabilitySchema = StringEnum(["none", "sandboxed"]);
export type ProcessIsolationCapability = "none" | "sandboxed";

export const RevocationCapabilitySchema = Type.Union([
	Type.Literal("admission-only"),
	Type.Literal("per-mutation"),
	Type.Object(
		{
			mode: Type.Literal("bounded-latency"),
			maxLatencyMs: Type.Integer({ minimum: 1 }),
		},
		{ additionalProperties: false },
	),
]);
export type RevocationCapability =
	| "admission-only"
	| "per-mutation"
	| { mode: "bounded-latency"; maxLatencyMs: number };

/**
 * P8 default capability package (wire-frozen values): resolution contained,
 * mutationMediation brokered, revocation admission-only, processIsolation
 * host-probe-derived (no baseline evidence ⇒ resolve-only ⇒ `none`).
 */
export const DEFAULT_ENFORCEMENT_CAPABILITIES = {
	resolution: "contained",
	mutationMediation: "brokered",
	processIsolation: "none",
	revocation: "admission-only",
} as const;

export const EnforcementCapabilitiesSchema = Type.Object(
	{
		resolution: ResolutionCapabilitySchema,
		mutationMediation: MutationMediationCapabilitySchema,
		processIsolation: ProcessIsolationCapabilitySchema,
		revocation: RevocationCapabilitySchema,
		// Evidence provenance (P8): baseline policy + host probe digest.
		baselinePolicyId: Type.String({ minLength: 1 }),
		hostProbeSha256: Sha256HexSchema,
	},
	{ additionalProperties: false },
);
export type EnforcementCapabilities = {
	resolution: ResolutionCapability;
	mutationMediation: MutationMediationCapability;
	processIsolation: ProcessIsolationCapability;
	revocation: RevocationCapability;
	baselinePolicyId: string;
	hostProbeSha256: string;
};

/** A flow requesting a capability 0.3-C does not offer → TF_FEATURE_REQUIRED. */
export function capabilityDemandsUnavailable(capabilities: Pick<EnforcementCapabilities, "resolution" | "mutationMediation" | "processIsolation" | "revocation">): boolean {
	if (capabilities.resolution === "unbound") return true;
	if (capabilities.mutationMediation === "none") return true;
	if (capabilities.processIsolation === "sandboxed") return true; // no approved host baseline in 0.3-C
	if (capabilities.revocation !== "admission-only") return true;
	return false;
}
