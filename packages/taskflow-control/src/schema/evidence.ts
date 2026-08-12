/**
 * Evidence wire types (🟥 NEW): ArtifactRef, Receipt, ReceiptAssurance.
 *
 * Decisions: P6 (digest is not a bearer token; ledger reachability authorizes
 * read), P11 (Receipt survives compaction; manifests issued at receipt time
 * remain valid), P14 (receipts dir under the store), P8 (assurance.enforcement
 * records the promise; observedRevocationLatencyMs optional).
 */

import { Type } from "typebox";
import { StringEnum } from "taskflow-core/typebox-helpers";
import { CONTROL_WIRE_SCHEMA_VERSION, Sha256HexSchema, UuidSchema } from "./common.ts";
import type { ConfidentialityLabel, IntegrityLabel } from "taskflow-core/effects/types";
import { EnforcementCapabilitiesSchema, type EnforcementCapabilities } from "./policy.ts";

// ---------------------------------------------------------------------------
// ArtifactRef (P6 / RFC §12)
// ---------------------------------------------------------------------------

export const ArtifactRefSchema = Type.Object(
	{
		digest: Sha256HexSchema,
		size: Type.Integer({ minimum: 0 }),
		mediaType: Type.String({ minLength: 1 }),
		storageClass: Type.String({ minLength: 1 }),
		redactionClass: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type ArtifactRef = {
	digest: string;
	size: number;
	mediaType: string;
	storageClass: string;
	redactionClass: string;
};

// ---------------------------------------------------------------------------
// ReceiptAssurance (P8/P11)
// ---------------------------------------------------------------------------

export const ProviderOutcomeSchema = StringEnum(["completed", "failed", "ambiguous", "operator-intervened"]);
export type ProviderOutcome = "completed" | "failed" | "ambiguous" | "operator-intervened";

export const ArtifactIntegritySchema = StringEnum(["verified", "unknown"]);
export type ArtifactIntegrity = "verified" | "unknown";

export const ReceiptAssuranceSchema = Type.Object(
	{
		journalContinuity: Type.Boolean(),
		providerOutcome: ProviderOutcomeSchema,
		artifactIntegrity: ArtifactIntegritySchema,
		provenance: Type.Object(
			{
				confidentiality: StringEnum(["public", "internal", "secret"]),
				integrity: StringEnum(["untrusted", "project", "verified"]),
			},
			{ additionalProperties: false },
		),
		enforcement: Type.Object(
			{
				capabilities: EnforcementCapabilitiesSchema,
				observedRevocationLatencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type ReceiptAssurance = {
	journalContinuity: boolean;
	providerOutcome: ProviderOutcome;
	artifactIntegrity: ArtifactIntegrity;
	provenance: { confidentiality: ConfidentialityLabel; integrity: IntegrityLabel };
	enforcement: {
		capabilities: EnforcementCapabilities;
		observedRevocationLatencyMs?: number;
	};
};

// ---------------------------------------------------------------------------
// Receipt (P11/P14) — issued once, immutable
// ---------------------------------------------------------------------------

export const BuildInfoWireSchema = Type.Object(
	{
		packageVersion: Type.String({ minLength: 1 }),
		gitCommit: Type.String({ minLength: 1 }),
		schemaVersion: Type.Integer({ minimum: 0 }),
		buildTime: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
export type BuildInfoWire = {
	packageVersion: string;
	gitCommit: string;
	schemaVersion: number;
	buildTime?: number;
};

export const ReceiptSchema = Type.Object(
	{
		schemaVersion: Type.Literal(CONTROL_WIRE_SCHEMA_VERSION),
		controlDomainId: UuidSchema,
		runId: UuidSchema,
		boundPlanHash: Type.Optional(Type.String({ minLength: 1 })),
		boundFragmentHash: Type.Optional(Type.String({ minLength: 1 })),
		eventManifest: Type.Array(UuidSchema),
		manifestRoot: Sha256HexSchema,
		startCommitSeq: Type.Integer({ minimum: 1 }),
		endCommitSeq: Type.Integer({ minimum: 1 }),
		artifactRefs: Type.Array(ArtifactRefSchema),
		assurance: ReceiptAssuranceSchema,
		buildInfo: BuildInfoWireSchema,
	},
	{ additionalProperties: false },
);
export type Receipt = {
	schemaVersion: typeof CONTROL_WIRE_SCHEMA_VERSION;
	controlDomainId: string;
	runId: string;
	boundPlanHash?: string;
	boundFragmentHash?: string;
	eventManifest: string[];
	manifestRoot: string;
	startCommitSeq: number;
	endCommitSeq: number;
	artifactRefs: ArtifactRef[];
	assurance: ReceiptAssurance;
	buildInfo: BuildInfoWire;
};
