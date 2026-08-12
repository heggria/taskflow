/**
 * ControlDomain / ControlStore / Registry / Bootstrap wire types (🟥 NEW).
 *
 * Decisions: P3 (domain + registry identity), P14 (store header), P13
 * (bootstrap manifest + layout). The store header is the authoritative
 * identity source; the registry is a rebuildable non-authoritative projection.
 */

import { Type } from "typebox";
import { CONTROL_WIRE_SCHEMA_VERSION, UuidSchema } from "./common.ts";

// ---------------------------------------------------------------------------
// Scalars (P3: UUID 标量约定)
// ---------------------------------------------------------------------------

/** 1:1 with a project ledger; stable across daemon restarts and mode switches. */
export const ControlDomainIdSchema = UuidSchema;
export type ControlDomainId = string;

/** Stable project UUID; lives in the ControlStore header and the registry. */
export const ProjectIdSchema = UuidSchema;
export type ProjectId = string;

/** Directory binding evidence for swap/move detection (P3 move/rebind). */
export const DirectoryBindingSchema = Type.Object(
	{
		canonicalPath: Type.String({ minLength: 1 }),
		device: Type.String({ minLength: 1 }),
		inode: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type DirectoryBinding = {
	canonicalPath: string;
	device: string;
	inode: string;
};

// ---------------------------------------------------------------------------
// ControlStoreHeader (P14) — authoritative identity source
// ---------------------------------------------------------------------------

export const ControlStoreHeaderSchema = Type.Object(
	{
		projectId: ProjectIdSchema,
		controlDomainId: ControlDomainIdSchema,
		schemaVersion: Type.Literal(CONTROL_WIRE_SCHEMA_VERSION),
		directoryBinding: DirectoryBindingSchema,
	},
	{ additionalProperties: false },
);
export type ControlStoreHeader = {
	projectId: ProjectId;
	controlDomainId: ControlDomainId;
	schemaVersion: typeof CONTROL_WIRE_SCHEMA_VERSION;
	directoryBinding: DirectoryBinding;
};

// ---------------------------------------------------------------------------
// ControlRegistryEntry (P3) — non-authoritative discovery/projection
// ---------------------------------------------------------------------------

export const MountStateSchema = Type.Union([
	Type.Literal("unmounted"),
	Type.Literal("mounting"),
	Type.Literal("mounted"),
	Type.Literal("drained"),
]);
export type MountState = "unmounted" | "mounting" | "mounted" | "drained";

export const ControlRegistryEntrySchema = Type.Object(
	{
		projectId: ProjectIdSchema,
		controlDomainId: ControlDomainIdSchema,
		storePath: Type.String({ minLength: 1 }),
		directoryBinding: DirectoryBindingSchema,
		mountState: MountStateSchema,
		summary: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type ControlRegistryEntry = {
	projectId: ProjectId;
	controlDomainId: ControlDomainId;
	storePath: string;
	directoryBinding: DirectoryBinding;
	mountState: MountState;
	summary?: string;
};

// ---------------------------------------------------------------------------
// ControlStoreStatus (P14) — store health/recovery state
// ---------------------------------------------------------------------------

export const ControlStoreStatusSchema = Type.Union([
	Type.Literal("healthy"),
	Type.Literal("recovering"),
	Type.Literal("fail-closed"),
]);
export type ControlStoreStatus = "healthy" | "recovering" | "fail-closed";

// ---------------------------------------------------------------------------
// BootstrapManifest (P13) — install/start contract
// ---------------------------------------------------------------------------

export const BootstrapManifestSchema = Type.Object(
	{
		controlBinaryPath: Type.String({ minLength: 1 }),
		controlHome: Type.String({ minLength: 1 }),
		singletonEndpoint: Type.String({ minLength: 1 }),
		fencingEpoch: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type BootstrapManifest = {
	controlBinaryPath: string;
	controlHome: string;
	singletonEndpoint: string;
	fencingEpoch: number;
};
