/**
 * Browser-wire numeric primitives.
 *
 * JSON numbers cross the JavaScript boundary as IEEE-754 doubles. Every
 * integer used for identity, ordering, CAS, timestamps, sizes, or counts must
 * therefore remain within the exactly representable safe-integer range.
 */
import { Type } from "typebox";

export const WebNonNegativeSafeIntegerSchema = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER,
});

export const WebPositiveSafeIntegerSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});

export const WebTimestampSchema = WebNonNegativeSafeIntegerSchema;
export const WebCommitSeqSchema = WebNonNegativeSafeIntegerSchema;
