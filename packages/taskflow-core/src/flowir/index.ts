/**
 * Public entry point for the FlowIR compile seam.
 *
 * `compileTaskflowToIR` is the read-only, content-addressed IR projection used
 * by:
 *   - `/tf ir <flow>` / `action=ir`     — render the compiled IR + hash (0 tokens)
 *   - the runtime (`runTaskflowLayers`) — fold `ir.hash` into the cache key
 *     (== `flowDefHash` in the stub; the overstory-canonical hash once the
 *     genuine compiler is vendored) and persist `ir.meta.declaredDeps` to
 *     `RunState` (M2 declared plane).
 *
 * The stub hash reuses the already-vendored overstory `flowDefHash` algorithm
 * (./hash.ts) so pi-taskflow and overstory share one byte-identical hashing
 * contract today. `usedFallbackHash` is `true` in the stub (the genuine
 * overstory `hashIR` is not yet wired); it flips to `false` once the compiler
 * is vendored, at which point the cache key's `v2:` prefix advances to `v3:`
 * (see docs/internal/cache-migration.md).
 *
 * Pure + async (Web Crypto). Never throws — a hash failure leaves `hash`
 * unset and `usedFallbackHash` true; the runtime degrades to the safe
 * flowName-only cache key (cross-run disabled for that run).
 *
 * @see docs/internal/overstory-convergence-roadmap.md §3 (M1)
 * @see docs/internal/rfc-flowir-compilation.md
 */

import type { Taskflow } from "../schema.ts";
import { flowDefHash } from "./hash.ts";
import { translateTaskflow } from "./translate.ts";
import type { TaskflowIR } from "./meta.ts";

/**
 * Compile a (desugared) `Taskflow` into its content-addressed IR.
 *
 * The returned `hash` is, in the stub, exactly `flowDefHash(def)` — the
 * overstory-vendored canonical-JSON + SHA-256-truncation contract. The
 * `usedFallbackHash` flag records that this is the *fallback* hash (non-IR-
 * canonical): it is `true` whenever the stub cannot guarantee IR-canonicity
 * (any phase with a `when`, or any hash-compute failure).
 *
 * Never throws. Returns structured diagnostics so `/tf ir` on a broken flow
 * yields a clean error table instead of crashing.
 */
export async function compileTaskflowToIR(def: Taskflow): Promise<TaskflowIR> {
	const t = translateTaskflow(def);
	let hash: string | undefined;
	try {
		hash = await flowDefHash(def);
	} catch {
		hash = undefined;
	}
	return {
		ir: t.ir,
		meta: t.meta,
		hash,
		warnings: t.warnings,
		errors: t.errors,
		// Stub: the fallback hash is used whenever (a) any phase has a `when`
		// (translateTaskflow flags it) OR (b) the hash computation itself failed.
		// Once the genuine overstory compiler is vendored, condition (a) drops.
		usedFallbackHash: t.usedFallbackHash || hash === undefined,
	};
}

export type {
	CompileError,
	CompileWarning,
	DeclaredDeps,
	FlowIR,
	FlowIRNode,
	TaskflowIR,
	TaskflowIRMeta,
} from "./meta.ts";

export { phaseFingerprint } from "./phasefp.ts";

// ---------------------------------------------------------------------------
// Canonical FlowIR type contract + content-addressed hash (batch-1 additions)
// ---------------------------------------------------------------------------
//
// `./meta.ts` exposes the *stub* 1:1 projection (`FlowIR`/`FlowIRNode` with
// `kind: string`) that `translateTaskflow` emits today. `./schema.ts` defines
// the *canonical* contract — a strict superset (extra optional fields) with a
// *closed* `kind` union (`FlowIRNodeKind`). Both are surfaced here:
//
//   - `FlowIR` / `FlowIRNode`           → the stub projection (meta.ts), used by
//                                          `compileTaskflowToIR` / `TaskflowIR`.
//   - `CanonicalFlowIR` / `CanonicalFlowIRNode` → the canonical contract
//                                          (schema.ts); the shape the batch-2
//                                          compiler emits and `hashFlowIR`
//                                          content-addresses.
//
// The canonical names are re-exported under `Canonical*` aliases to avoid a
// duplicate-export clash with meta.ts's stub `FlowIR`/`FlowIRNode`; this keeps
// the batch purely additive (the existing public surface is unchanged) while
// making the canonical contract reachable through the main `taskflow-core`
// barrel. `hashFlowIR`/`hashNode` take the canonical types, so a consumer
// hashing a stub-projection IR must widen via the canonical type (the genuine
// compiler in batch 2 will emit canonical IR directly).

// `./schema.ts` — canonical FlowIR type contract + structural guards.
export { FlowIRNodeKind } from "./schema.ts"; // value (TypeBox schema) + type (literal union)
export type {
	FlowIREdge,
	FlowIRBudget,
	FlowIRMeta,
	FlowIR as CanonicalFlowIR,
	FlowIRNode as CanonicalFlowIRNode,
} from "./schema.ts";
export {
	FlowIRNodeSchema,
	FlowIREdgeSchema,
	FlowIRSchema,
	isFlowIRNode,
	assertFlowIR,
} from "./schema.ts";

// `./cond.ts` — condition-IR normalization (canonical `when` form for hashing + replay refs).
export type { NormalizedCond } from "./cond.ts";
export { normalizeCond } from "./cond.ts";

// `./canonical-hash.ts` — genuine content-addressed hash over canonical FlowIR
// (sync `node:crypto` SHA-256; distinct from the vendored async `flowDefHash`).
export { canonicalizeFlowIR, hashFlowIR, hashNode } from "./canonical-hash.ts";
