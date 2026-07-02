/**
 * Output schema contracts (`expect`) — a zero-dependency structural validator.
 *
 * A phase may declare `expect`: a small JSON-Schema-like contract its parsed
 * JSON output must satisfy. The runtime validates the output the moment the
 * subagent finishes; a violation fails the phase with a precise diagnostic
 * (eligible for the phase's explicit `retry` policy) instead of letting a
 * mis-shaped output propagate downstream and break interpolation silently.
 *
 * Supported contract surface (deliberately small, statically checkable):
 *   type:       "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
 *   properties: { key: <contract> }         (object)
 *   required:   ["key", …]                  (object)
 *   items:      <contract>                  (array)
 *   enum:       [literal, …]                (any)
 */

export interface OutputContract {
	type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
	properties?: Record<string, OutputContract>;
	required?: string[];
	items?: OutputContract;
	enum?: unknown[];
}

const CONTRACT_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const CONTRACT_KEYS = new Set(["type", "properties", "required", "items", "enum"]);

/** Max violations reported per validation (diagnostics stay readable). */
export const CONTRACT_MAX_VIOLATIONS = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Statically check that an author-written `expect` value is a well-formed
 * contract. Returns human-readable shape errors ([] = valid). Total: never
 * throws on arbitrary JSON-valid input.
 */
export function contractShapeErrors(schema: unknown, path = "expect"): string[] {
	if (!isPlainObject(schema)) return [`${path}: must be an object (a contract like {"type":"object","required":[…]})`];
	const errors: string[] = [];
	for (const k of Object.keys(schema)) {
		if (!CONTRACT_KEYS.has(k)) errors.push(`${path}.${k}: unknown contract keyword (supported: type, properties, required, items, enum)`);
	}
	if (schema.type !== undefined && (typeof schema.type !== "string" || !CONTRACT_TYPES.has(schema.type)))
		errors.push(`${path}.type: must be one of object|array|string|number|integer|boolean|null`);
	if (schema.required !== undefined) {
		if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string"))
			errors.push(`${path}.required: must be an array of strings`);
	}
	if (schema.properties !== undefined) {
		if (!isPlainObject(schema.properties)) {
			errors.push(`${path}.properties: must be an object of sub-contracts`);
		} else {
			for (const [k, sub] of Object.entries(schema.properties)) {
				errors.push(...contractShapeErrors(sub, `${path}.properties.${k}`));
			}
		}
	}
	if (schema.items !== undefined) errors.push(...contractShapeErrors(schema.items, `${path}.items`));
	if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0))
		errors.push(`${path}.enum: must be a non-empty array of literals`);
	return errors;
}

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value; // object | string | number | boolean | undefined
}

/** Structural equality for enum literals — key-order-insensitive for objects
 *  (unlike JSON.stringify comparison). Total on JSON-shaped values. */
function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	const ka = Object.keys(a as Record<string, unknown>);
	const kb = Object.keys(b as Record<string, unknown>);
	if (ka.length !== kb.length) return false;
	return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Validate a parsed JSON value against a contract. Returns violation messages
 * with JSON-path-ish locations ([] = the value satisfies the contract). Total:
 * a malformed contract never throws — unknown constructs are skipped (the
 * shape is validated separately at flow-validation time).
 */
export function contractViolations(value: unknown, schema: unknown, path = "$"): string[] {
	if (!isPlainObject(schema)) return [];
	const out: string[] = [];
	const push = (msg: string) => {
		if (out.length < CONTRACT_MAX_VIOLATIONS) out.push(msg);
	};

	// Implicit type: a contract with properties/required is an object contract,
	// one with items is an array contract — even when `type` was omitted.
	const declaredType =
		typeof schema.type === "string" && CONTRACT_TYPES.has(schema.type)
			? schema.type
			: schema.properties !== undefined || schema.required !== undefined
				? "object"
				: schema.items !== undefined
					? "array"
					: undefined;

	if (declaredType) {
		const actual = typeOf(value);
		const matches =
			declaredType === "integer"
				? actual === "number" && Number.isInteger(value)
				: actual === declaredType;
		if (!matches) {
			push(`${path}: expected ${declaredType}, got ${actual === "undefined" ? "nothing (not valid JSON?)" : actual}`);
			return out; // structural mismatch — deeper checks would be noise
		}
	}

	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const hit = schema.enum.some((e) => deepEqual(e, value));
		if (!hit) push(`${path}: value is not one of the allowed enum literals`);
	}

	if (isPlainObject(value)) {
		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (typeof key === "string" && !(key in value)) push(`${path}.${key}: required key is missing`);
			}
		}
		if (isPlainObject(schema.properties)) {
			for (const [key, sub] of Object.entries(schema.properties)) {
				if (key in value) {
					for (const v of contractViolations(value[key], sub, `${path}.${key}`)) push(v);
				}
			}
		}
	}

	if (Array.isArray(value) && isPlainObject(schema.items)) {
		for (let i = 0; i < value.length; i++) {
			for (const v of contractViolations(value[i], schema.items, `${path}[${i}]`)) push(v);
			if (out.length >= CONTRACT_MAX_VIOLATIONS) break;
		}
	}

	return out;
}
