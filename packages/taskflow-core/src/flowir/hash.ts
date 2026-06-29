/**
 * Content-addressed hashing for flow definitions.
 *
 * The canonical-JSON + SHA-256-truncation algorithm here is **vendored from
 * overstory `packages/core/src/ir/hash.ts`** (pinned commit) so that
 * pi-taskflow and overstory share one byte-identical hashing contract. This is
 * the `M1` slice of the overstory-convergence roadmap: we are *not* compiling
 * to overstory FlowIR yet (the IR compiler expects an explicit inject/emits
 * model pi-taskflow doesn't have), but we share the **hash algorithm** now —
 * the cheapest, lowest-risk piece of the contract — and put it to immediate
 * work folding the flow *definition* into the cross-run cache key (M2).
 *
 * Why this matters: previously the cache key folded only the flow **name**
 * (`flow:${flowName}`), so two structurally-different flows that happened to
 * share a name + phase id + task could collide in the cross-run cache, and a
 * flow that changed structure (but not name) could serve a stale hit. Folding
 * `flowDefHash` (a content fingerprint of the desugared definition) closes
 * that hole and is the foundation of "identical re-run is free ($0.00)".
 *
 * Pure module: no IO. Uses Web Crypto (`globalThis.crypto.subtle`) — therefore
 * async — exactly like overstory's `hashIR`, so the contract is identical.
 *
 * @see docs/internal/overstory-convergence-roadmap.md §3 (M1, "cut B")
 * @see docs/internal/rfc-flowir-compilation.md
 */

import type { Taskflow } from "../schema.ts";

// ---------------------------------------------------------------------------
// Canonical JSON (vendored from overstory ir/hash.ts — byte-identical)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: recursively key-sorted (UTF-16 code units), no
 * whitespace, `undefined` values dropped. Arrays keep their order (the
 * desugared Taskflow is already in a canonical shape). Byte-identical to
 * overstory's `canonicalJson` — do not diverge without bumping the contract
 * and updating the parity test.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
		return `{${body.join(",")}}`;
	}
	// undefined / function / symbol at the top level — not representable.
	return "null";
}

// ---------------------------------------------------------------------------
// Hashing (vendored from overstory ir/hash.ts — byte-identical)
// ---------------------------------------------------------------------------

/** SHA-256 of the canonical serialization, first 16 bytes, lowercase hex.
 *  Same shape as overstory's `hashCanonical` / RFC-001 content hashes. */
export async function hashCanonical(canonical: string): Promise<string> {
	const bytes = new TextEncoder().encode(canonical);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	const view = new Uint8Array(digest).slice(0, 16);
	let hex = "";
	for (const byte of view) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

// ---------------------------------------------------------------------------
// Flow-definition fingerprint
// ---------------------------------------------------------------------------

/**
 * Content fingerprint of a desugared `Taskflow` definition.
 *
 * Hashes the **definition** (structure + task text + declared deps), NOT the
 * runtime `args` values — args vary per invocation and are already folded into
 * each phase's `inputHash` via the interpolated task. `flowDefHash` answers a
 * different question: "did the flow *itself* change?" Two flows are
 * definitionally identical ⟺ this hash matches (key order / whitespace /
 * optional-field presence do not affect it).
 *
 * Deterministic and async (Web Crypto), matching overstory's `hashIR` shape.
 */
export async function flowDefHash(def: Taskflow): Promise<string> {
	return hashCanonical(canonicalJson(def));
}
