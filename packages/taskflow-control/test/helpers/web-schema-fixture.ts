import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export type SchemaRecord = TSchema & Record<string, unknown>;

export function asSchema(value: unknown): SchemaRecord {
	return value as SchemaRecord;
}

function synthesizeString(schema: SchemaRecord, salt: number): string {
	const minimum = Number(schema.minLength ?? 0);
	const maximum = Number(schema.maxLength ?? Number.MAX_SAFE_INTEGER);
	const candidates = [
		`id-${salt}`,
		"x",
		"a",
		`sha256:${"a".repeat(64)}`,
		`sha256:${"a".repeat(16)}`,
		"a".repeat(64),
		"a".repeat(43),
		"a".repeat(26),
		"a".repeat(Math.max(1, minimum)),
	];
	const pattern =
		typeof schema.pattern === "string"
			? new RegExp(schema.pattern, "u")
			: undefined;
	for (const candidate of candidates) {
		if (
			candidate.length >= minimum &&
			candidate.length <= maximum &&
			(!pattern || pattern.test(candidate))
		) {
			return candidate;
		}
	}
	throw new Error(
		`could not synthesize string for ${JSON.stringify(schema.pattern)}`,
	);
}

export function synthesize(schemaValue: TSchema, salt = 1): unknown {
	const schema = asSchema(schemaValue);
	if ("default" in schema) return structuredClone(schema.default);
	if ("const" in schema) return structuredClone(schema.const);
	const alternatives = schema.anyOf;
	if (Array.isArray(alternatives)) {
		for (const alternative of alternatives) {
			try {
				const candidate = synthesize(asSchema(alternative), salt);
				if (Value.Check(schemaValue, candidate)) return candidate;
			} catch {
				// Try the next closed branch.
			}
		}
		throw new Error("could not synthesize any union branch");
	}
	const intersections = schema.allOf;
	if (Array.isArray(intersections)) {
		const merged: Record<string, unknown> = {};
		for (const intersection of intersections) {
			const candidate = synthesize(asSchema(intersection), salt);
			if (
				typeof candidate !== "object" ||
				candidate === null ||
				Array.isArray(candidate)
			) {
				throw new Error("non-object intersection is not supported");
			}
			Object.assign(merged, candidate);
		}
		if (!Value.Check(schemaValue, merged)) {
			throw new Error("synthesized intersection did not validate");
		}
		return merged;
	}
	switch (schema.type) {
		case "object": {
			const properties = asSchema(schema.properties ?? {}) as Record<
				string,
				TSchema
			>;
			const required = Array.isArray(schema.required)
				? (schema.required as string[])
				: [];
			const result: Record<string, unknown> = {};
			for (const [index, key] of required.entries()) {
				const property = properties[key];
				if (!property) {
					throw new Error(`required property has no schema: ${key}`);
				}
				result[key] = synthesize(property, salt + index + 1);
			}
			if (!Value.Check(schemaValue, result)) {
				throw new Error("synthesized object did not validate");
			}
			return result;
		}
		case "array": {
			const tupleItems = Array.isArray(schema.prefixItems)
				? schema.prefixItems
				: Array.isArray(schema.items)
					? schema.items
					: undefined;
			if (tupleItems) {
				const tuple = tupleItems.map((item, index) =>
					synthesize(asSchema(item), salt + index + 1),
				);
				if (!Value.Check(schemaValue, tuple)) {
					throw new Error("synthesized tuple did not validate");
				}
				return tuple;
			}
			const count = Number(schema.minItems ?? 0);
			if (count === 0 && schema.items === undefined) return [];
			const itemSchema = asSchema(schema.items);
			const items = Array.from({ length: count }, (_, index) =>
				synthesize(itemSchema, salt + index + 1),
			);
			if (!Value.Check(schemaValue, items)) {
				throw new Error("synthesized array did not validate");
			}
			return items;
		}
		case "integer":
		case "number":
			return Number(schema.minimum ?? 0);
		case "boolean":
			return false;
		case "null":
			return null;
		case "string":
			return synthesizeString(schema, salt);
		default:
			throw new Error(`unsupported schema type: ${String(schema.type)}`);
	}
}
