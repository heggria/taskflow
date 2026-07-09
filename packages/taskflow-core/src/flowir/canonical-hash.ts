/**
 * # Genuine content-addressed hash over canonical FlowIR
 *
 * This is pi-taskflow's **own** content-addressed hash (Q5=own) over the
 * canonical {@link FlowIR} type contract defined in `./schema.ts`. Unlike
 * `./hash.ts`'s `flowDefHash` — which fingerprints the *DSL Taskflow
 * definition* (vendored from overstory, async Web Crypto, truncated to 16
 * bytes / 32 hex) — this module hashes the *compiled IR* synchronously with
 * `node:crypto` SHA-256 (full 64-hex-char digest). The two answer different
 * questions:
 *
 * - `flowDefHash(def)`  — "did the *flow definition* change?" (DSL-level)
 * - `hashFlowIR(ir)`    — "is this *compiled IR* the same IR?" (IR-level)
 *
 * The IR-level hash is the content-addressed key the event-sourced kernel
 * (batch 2, `flowir/compile.ts`) will use to deduplicate compiled graphs and
 * to key per-phase fingerprints (`hashNode`) independent of surface formatting.
 *
 * ## Canonicalization guarantees
 *
 * {@link canonicalizeFlowIR} produces a DETERMINISTIC serialization that is
 * invariant under the cosmetic differences two logically-equivalent IRs may
 * differ by:
 *
 * - **Object key order** — all object keys are stable-sorted (UTF-16 code
 *   units), so reordering fields on a node or on the IR object does not
 *   change the canonical form.
 * - **Node array order** — `nodes` is re-sorted by `id` (stable), so two IRs
 *   that list the same nodes in different order canonicalize identically.
 *   Other arrays (`inject`, `emits`, `deps`, `edges`) keep their order —
 *   their ordering is semantically meaningful (declared-read order, edge
 *   declaration order) and must be preserved.
 * - **Condition spelling** — a node's `when` guard is canonicalized via
 *   {@link normalizeCond} (`./cond.ts`), which collapses whitespace, operator
 *   spacing, and redundant enclosing parens while preserving string-literal
 *   contents. Equivalent conditions canonicalize identically.
 * - **Insignificant formatting** — `undefined` optional fields are dropped,
 *   so their presence/absence does not change the hash.
 *
 * Two logically-equivalent FlowIRs (key reorder, whitespace, equivalent
 * condition spelling) MUST canonicalize to the same string.
 *
 * ## Domain-separated digests
 *
 * Return values are prefixed:
 * - `hashFlowIR` → `ir:<64-hex>`
 * - `hashNode`   → `node:<64-hex>`
 *
 * so IR-level and node-level digests never collide in a shared cache key
 * namespace.
 *
 * ## Purity
 *
 * Zero runtime deps besides `node:crypto`. No IO, no `Date`, no randomness,
 * never throws. The hash is synchronous (unlike `flowDefHash`).
 *
 * Exported from the FlowIR barrel (`./index.ts`) for consumers; **not yet
 * wired** into runtime/cache — `usedFallbackHash` is untouched. Wiring
 * happens in batch 2.
 *
 * @see ./schema.ts for the canonical FlowIR type contract.
 * @see ./cond.ts for condition normalization (`normalizeCond`).
 * @see ./hash.ts for the DSL-level `flowDefHash` (vendored from overstory).
 */

import { createHash } from "node:crypto";
import type { FlowIR, FlowIRNode } from "./schema.ts";
import { normalizeCond } from "./cond.ts";

// ---------------------------------------------------------------------------
// Canonical serializer (key-sorted, undefined-dropped, array-order-preserving)
// ---------------------------------------------------------------------------

/**
 * Deterministic serialization of a plain-JSON-compatible value: recursively
 * key-sorts objects (UTF-16 code units), drops `undefined` values, preserves
 * array order, and uses `JSON.stringify` for primitives/null. This mirrors
 * the canonical-JSON convention used by `./hash.ts`'s `canonicalJson` (itself
 * vendored from overstory) so the two hashes share the same primitive
 * encoding — but this serializer is local to the IR hash so the IR-level
 * contract can evolve independently of the overstory-vendored DSL hash.
 *
 * The value passed in MUST be pre-canonicalized (nodes sorted by id, `when`
 * normalized) — this function does not know about FlowIR semantics, it only
 * guarantees key-order independence and `undefined`-dropping.
 */
function canonicalSerialize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalSerialize(item)).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`);
		return `{${body.join(",")}}`;
	}
	// undefined / function / symbol / bigint at this layer — not representable.
	return "null";
}

// ---------------------------------------------------------------------------
// Canonical node object (drops undefined, normalizes `when`)
// ---------------------------------------------------------------------------

/**
 * Project a {@link FlowIRNode} into a plain canonical object form: fields are
 * emitted in a fixed order (order is irrelevant — `canonicalSerialize`
 * re-sorts keys, but emitting canonically makes the intermediate form
 * human-inspectable), `when` is normalized via {@link normalizeCond} so
 * equivalent condition spellings collapse, and `undefined` optionals are
 * omitted so their presence/absence does not affect the hash.
 *
 * `inject`/`emits`/`deps` arrays are preserved verbatim (order is semantic —
 * declared-read order matters for fingerprinting).
 */
function canonicalNodeObject(node: FlowIRNode): Record<string, unknown> {
	const obj: Record<string, unknown> = {
		id: node.id,
		kind: node.kind,
		inject: node.inject,
		emits: node.emits,
	};
	if (node.when !== undefined) {
		obj.when = normalizeCond(node.when).canonical;
	}
	if (node.task !== undefined) obj.task = node.task;
	if (node.condRef !== undefined) obj.condRef = node.condRef;
	if (node.deps !== undefined) obj.deps = node.deps;
	if (node.join !== undefined) obj.join = node.join;
	if (node.timeout !== undefined) obj.timeout = node.timeout;
	return obj;
}

// ---------------------------------------------------------------------------
// Public canonicalization
// ---------------------------------------------------------------------------

/**
 * Deterministic, order- and whitespace-independent canonical serialization of
 * a {@link FlowIR}.
 *
 * - `nodes` is re-sorted by `id` (stable) so node-list order does not affect
 *   the result.
 * - Each node's `when` guard is canonicalized via {@link normalizeCond}.
 * - All object keys are stable-sorted; `undefined` optionals are dropped.
 * - `inject`/`emits`/`deps`/`edges` arrays keep their order (semantic).
 *
 * Two logically-equivalent FlowIRs MUST canonicalize to the same string.
 * Never throws.
 */
export function canonicalizeFlowIR(ir: FlowIR): string {
	// Stable sort by node id — node-list order is not semantic.
	const sortedNodes = [...ir.nodes].sort((a, b) => {
		if (a.id < b.id) return -1;
		if (a.id > b.id) return 1;
		return 0;
	});

	const obj: Record<string, unknown> = {
		name: ir.name,
		nodes: sortedNodes.map((n) => canonicalNodeObject(n)),
	};
	if (ir.version !== undefined) obj.version = ir.version;
	if (ir.edges !== undefined) obj.edges = ir.edges;
	if (ir.args !== undefined) obj.args = ir.args;
	if (ir.budget !== undefined) obj.budget = ir.budget;
	if (ir.concurrency !== undefined) obj.concurrency = ir.concurrency;
	if (ir.meta !== undefined) obj.meta = ir.meta;

	return canonicalSerialize(obj);
}

/**
 * Deterministic canonical serialization of a single {@link FlowIRNode}, for
 * per-node content addressing. Same canonicalization rules as
 * {@link canonicalizeFlowIR} applied to one node (`when` normalized, keys
 * sorted, `undefined` optionals dropped, `inject`/`emits`/`deps` order
 * preserved). Never throws.
 */
export function canonicalizeNode(node: FlowIRNode): string {
	return canonicalSerialize(canonicalNodeObject(node));
}

// ---------------------------------------------------------------------------
// Content-addressed hashing (node:crypto SHA-256, domain-prefixed)
// ---------------------------------------------------------------------------

/**
 * Domain-separated content hash of a compiled FlowIR.
 * Returns `ir:<64 lowercase hex SHA-256 chars>` over {@link canonicalizeFlowIR}.
 * Synchronous. Never throws.
 */
export function hashFlowIR(ir: FlowIR): string {
	const hex = createHash("sha256").update(canonicalizeFlowIR(ir), "utf8").digest("hex");
	return `ir:${hex}`;
}

/**
 * Domain-separated per-node content hash.
 * Returns `node:<64 lowercase hex SHA-256 chars>` over {@link canonicalizeNode}.
 * Synchronous. Never throws.
 */
export function hashNode(node: FlowIRNode): string {
	const hex = createHash("sha256").update(canonicalizeNode(node), "utf8").digest("hex");
	return `node:${hex}`;
}
