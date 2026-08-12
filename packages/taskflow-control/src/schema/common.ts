/**
 * Shared 0.3-C wire conventions: schema version, scalar formats, and the
 * closed-enum helper. Follows the TE convention (`taskflow-core/typebox-helpers`
 * StringEnum) so providers that do not support anyOf/const keep working.
 */

import { Type } from "typebox";
import { StringEnum } from "taskflow-core/typebox-helpers";

/**
 * Single wire schema version for the 0.3-C control plane. Every top-level wire
 * document that carries `schemaVersion` uses this constant; additive evolution
 * bumps it (wire-freeze rule 4: freeze allows only additive changes + bump).
 */
export const CONTROL_WIRE_SCHEMA_VERSION = 1;

/** UUID v4 scalar convention (ControlDomainId, projectId, eventId, ...). */
export const UuidSchema = Type.String({
	minLength: 36,
	maxLength: 36,
	pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
	description: "UUID v4 scalar",
});

/** 64-lowercase-hex SHA-256 digest (the only hash family, P6). */
export const Sha256HexSchema = Type.String({
	minLength: 64,
	maxLength: 64,
	pattern: "^[0-9a-f]{64}$",
	description: "SHA-256 digest as 64 lowercase hex chars",
});

/** Canonical (key-sorted, undefined-dropped) hash over a wire document. */
export const CanonicalHashRefSchema = Type.String({
	minLength: 66,
	maxLength: 96,
	pattern: "^[a-z0-9]+:[0-9a-f]{64}$",
	description: "Domain-separated content hash, e.g. ir:<64-hex> or plan:<64-hex>",
});

export type ControlWireSchemaVersion = typeof CONTROL_WIRE_SCHEMA_VERSION;

export { StringEnum };
