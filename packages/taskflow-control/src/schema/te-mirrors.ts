/**
 * TE wire mirrors (🟩 REUSE per wire-freeze §3.1).
 *
 * The wire-freeze reuses eleven Trusted Effects shapes. Most of them are
 * importable from `taskflow-core`'s package surface (`effects/*`, `flowir/*`);
 * the `resources/*` shapes are deliberately NOT exported by taskflow-core
 * (the workspace-capability freeze blocks `taskflow-core/resources/*` — see
 * scripts/smoke-packed-packages.mjs), so this module carries closed TypeBox
 * mirrors of exactly those shapes. TE remains the authority that produces and
 * consumes these values; 0.3-C only references them as evidence.
 *
 * Mirrors are kept field-for-field identical to the TE interfaces; any drift
 * fails the closed-contract tests in this package.
 */

import { Type, type Static } from "typebox";
import { StringEnum } from "taskflow-core/typebox-helpers";

// ---------------------------------------------------------------------------
// PathRef (resources/schema.ts) — literalPath/argPath/segments + PathIntent
// ---------------------------------------------------------------------------

export const WorkspaceAccessSchema = Type.Union([
	Type.Literal("read-only"),
	Type.Literal("read-write"),
]);
export type WorkspaceAccess = "read-only" | "read-write";

export const PathIntentSchema = Type.Union([
	Type.Literal("existing-file"),
	Type.Literal("existing-directory"),
	Type.Literal("create-file"),
	Type.Literal("create-directory"),
	Type.Literal("executable"),
]);
export type PathIntent =
	| "existing-file"
	| "existing-directory"
	| "create-file"
	| "create-directory"
	| "executable";

const LiteralPathExprSchema = Type.Object(
	{
		literalPath: Type.String({ minLength: 1 }),
		argPath: Type.Optional(Type.Never()),
		segments: Type.Optional(Type.Never()),
	},
	{ additionalProperties: false },
);

const ArgPathExprSchema = Type.Object(
	{
		argPath: Type.String({ minLength: 1 }),
		literalPath: Type.Optional(Type.Never()),
		segments: Type.Optional(Type.Never()),
	},
	{ additionalProperties: false },
);

const SegmentExprSchema = Type.Union([
	Type.Object(
		{ segment: Type.String({ minLength: 1 }), argSegment: Type.Optional(Type.Never()) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ argSegment: Type.String({ minLength: 1 }), segment: Type.Optional(Type.Never()) },
		{ additionalProperties: false },
	),
]);

const SegmentsExprSchema = Type.Object(
	{
		segments: Type.Array(SegmentExprSchema, { minItems: 1 }),
		literalPath: Type.Optional(Type.Never()),
		argPath: Type.Optional(Type.Never()),
	},
	{ additionalProperties: false },
);

const RelativePathExprSchema = Type.Union([LiteralPathExprSchema, ArgPathExprSchema, SegmentsExprSchema]);

const pathRefBase = {
	subpath: Type.Optional(RelativePathExprSchema),
	access: Type.Optional(WorkspaceAccessSchema),
	maxLifetime: Type.Optional(
		Type.Union(
			["phase", "run", "external"].map((scope) =>
				Type.Object({ scope: Type.Literal(scope as "phase" | "run" | "external") }, { additionalProperties: false }),
			),
		),
	),
	intent: PathIntentSchema,
};

export const PathRefSchema = Type.Union([
	Type.Object(
		{ ...pathRefBase, workspace: Type.String({ minLength: 1 }), handle: Type.Optional(Type.Never()) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...pathRefBase,
			handle: Type.Object(
				{
					producerPhaseId: Type.String({ minLength: 1 }),
					exportName: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
			workspace: Type.Optional(Type.Never()),
		},
		{ additionalProperties: false },
	),
]);
export type PathRef = Static<typeof PathRefSchema>;

// ---------------------------------------------------------------------------
// BoundCapabilityLifetime (resources/schema.ts)
// ---------------------------------------------------------------------------

export const BoundCapabilityLifetimeSchema = Type.Union([
	Type.Object(
		{
			scope: Type.Literal("phase"),
			runId: Type.String({ minLength: 1 }),
			phaseId: Type.String({ minLength: 1 }),
			attemptId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ scope: Type.Literal("run"), runId: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			scope: Type.Literal("external"),
			bindingId: Type.String({ minLength: 1 }),
			providerInstanceId: Type.Optional(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	),
]);
export type BoundCapabilityLifetime = Static<typeof BoundCapabilityLifetimeSchema>;

// ---------------------------------------------------------------------------
// ExecutionOwner (resources/types.ts)
// ---------------------------------------------------------------------------

export const ExecutionOwnerSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1 }),
		phaseId: Type.String({ minLength: 1 }),
		attemptId: Type.String({ minLength: 1 }),
		unitId: Type.String({ minLength: 1 }),
		ancestry: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);
export type ExecutionOwner = Static<typeof ExecutionOwnerSchema>;

// ---------------------------------------------------------------------------
// ScopedContentEvidence (resources/types.ts)
// ---------------------------------------------------------------------------

export const ScopedContentEvidenceSchema = Type.Object(
	{
		canonicalPrefix: Type.String({ minLength: 1 }),
		scopeDigest: Type.String({ minLength: 1 }),
		effectId: Type.Optional(Type.String({ minLength: 1 })),
		capabilityBindingId: Type.Optional(Type.String({ minLength: 1 })),
		beforeContentId: Type.Optional(Type.String({ minLength: 1 })),
		afterContentId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// WriteIntentRecord / WriteIntentStatus (resources/journal.ts)
// ---------------------------------------------------------------------------

export const WriteIntentStatusSchema = StringEnum([
	"pending",
	"committed-content",
	"committed-generation",
	"aborted-restored",
	"dirty-unknown",
	"reconciled",
]);
export type WriteIntentStatus =
	| "pending"
	| "committed-content"
	| "committed-generation"
	| "aborted-restored"
	| "dirty-unknown"
	| "reconciled";

export const WriteIntentRecordSchema = Type.Object(
	{
		journalVersion: Type.Literal(1),
		intentId: Type.String({ minLength: 1 }),
		resourceDomainId: Type.String({ minLength: 1 }),
		providerInstanceId: Type.Optional(Type.String({ minLength: 1 })),
		scopes: Type.Array(ScopedContentEvidenceSchema),
		owner: ExecutionOwnerSchema,
		beforeGeneration: Type.Integer({ minimum: 0 }),
		intentSequence: Type.Integer({ minimum: 1 }),
		commitGeneration: Type.Optional(Type.Integer({ minimum: 0 })),
		journalEpoch: Type.Integer({ minimum: 1 }),
		commitMode: StringEnum(["content-snapshot", "generation-only", "unavailable"]),
		externalMutation: StringEnum(["taskflow-managed", "externally-mutable"]),
		status: WriteIntentStatusSchema,
		restorableSnapshotArtifactIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		terminalReason: Type.Optional(Type.String()),
		authorizationPrincipalId: Type.Optional(Type.String({ minLength: 1 })),
		authorizationScopeRoot: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// HostProbeClassification (resources/baseline.ts) — enforcement evidence
// ---------------------------------------------------------------------------

export const HostProbeClassificationSchema = StringEnum([
	"sandboxed-single-root",
	"sandboxed-multi-root",
	"resolve-only",
	"unsupported",
]);
export type HostProbeClassification =
	| "sandboxed-single-root"
	| "sandboxed-multi-root"
	| "resolve-only"
	| "unsupported";
