/**
 * taskflow-control wire schema barrel — the single source of truth for the
 * 0.3-C frozen TypeBox contracts (wire-freeze §3).
 *
 * REUSE (TE, import read-only): EffectDeclSchema / EffectIRSchema come from
 * `taskflow-core/effects/schema`; SecretRef / ServiceRef / labels from
 * `taskflow-core/effects/types`; canonical-hash from
 * `taskflow-core/flowir/canonical-hash`. The `resources/*` shapes that
 * taskflow-core deliberately does not export are mirrored in
 * `./te-mirrors.ts` (TE remains the authority).
 *
 * Every top-level document carries `schemaVersion` where the ADR pins it
 * (ControlStoreHeader, ControlEvent, BoundPlan, BoundFragment, Receipt) and
 * closed `additionalProperties: false` objects throughout.
 */

export {
	CONTROL_WIRE_SCHEMA_VERSION,
	UuidSchema,
	Sha256HexSchema,
	CanonicalHashRefSchema,
	StringEnum,
} from "./common.ts";
export type { ControlWireSchemaVersion } from "./common.ts";

export * from "./te-mirrors.ts";
export * from "./header.ts";
export * from "./commands.ts";
export * from "./plan.ts";
export * from "./run.ts";
export * from "./approval.ts";
export * from "./coordinator.ts";
export * from "./policy.ts";
export * from "./evidence.ts";
export * from "./transport.ts";

// REUSE re-exports from taskflow-core (TE schemas are the authority; the
// control wire references them as read-only evidence).
export { EffectDeclSchema, EffectIRSchema } from "taskflow-core/effects/schema";
export type { EffectDecl, EffectIR, EffectKind, ConfidentialityLabel, IntegrityLabel, SecretRef, ServiceRef } from "taskflow-core/effects/types";
export { hashFlowIR, hashNode, canonicalizeFlowIR, canonicalizeNode } from "taskflow-core/flowir/canonical-hash";
