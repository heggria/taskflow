/**
 * Canonical hashing for BoundPlan / command request hashes (P6).
 * Single library — Node crypto only.
 */
import * as crypto from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
	return crypto.createHash("sha256").update(input).digest("hex");
}

/** Content-addressed bound plan hash: `bp:<64-hex>`. */
export function hashBoundPlan(program: unknown, meta: Record<string, unknown> = {}): string {
	const body = stableStringify({ program, ...meta });
	return `bp:${sha256Hex(body)}`;
}

/** Execution semantic hash: `es:<64-hex>`. */
export function hashExecutionSemantic(descriptor: unknown): string {
	return `es:${sha256Hex(stableStringify(descriptor))}`;
}

/** Request hash for CommandRecord idempotency. */
export function hashRequest(body: unknown): string {
	return sha256Hex(stableStringify(body));
}

export function newId(prefix = ""): string {
	const id = crypto.randomUUID();
	return prefix ? `${prefix}_${id}` : id;
}

/** Deterministic JSON stringify (sorted object keys). */
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sortKeys);
	const obj = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(obj).sort()) {
		out[k] = sortKeys(obj[k]);
	}
	return out;
}
