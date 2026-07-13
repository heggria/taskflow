/**
 * Public entry point for the FlowIR compile seam.
 *
 * `compileTaskflowToIR` is the content-addressed IR projection used by:
 *   - `/tf ir <flow>` / `action=ir`     — render the compiled IR + hash (0 tokens)
 *   - the runtime (`runTaskflowLayers`) — fold `ir.hash` into the cache key
 *
 * **S0 (0.2.0):** the genuine compiler (`./compile.ts`) emits canonical FlowIR
 * and content-addresses it with {@link hashFlowIR}. `usedFallbackHash` is
 * **false** when IR is produced. The DSL-level `flowDefHash` remains available
 * for the v2 cache tier (`v2:flowdef:`) during the migration window.
 *
 * Pure + async-compatible API (sync body; async retained for callers). Never
 * throws — a hash failure leaves `hash` unset and `usedFallbackHash` true.
 *
 * @see docs/rfc-0.2.0-architecture.md §5, §9 (S0)
 */

import type { Taskflow } from "../schema.ts";
import { compileTaskflowToFlowIR } from "./compile.ts";
import { hashFlowIR } from "./canonical-hash.ts";
import type { TaskflowIR } from "./meta.ts";

/**
 * Compile a (desugared) `Taskflow` into its content-addressed IR.
 *
 * The returned `hash` is `ir:<64-hex>` from {@link hashFlowIR} over the
 * **canonical** FlowIR (key-order / node-order / condition-normalization
 * invariant). `usedFallbackHash` is false when compilation produced nodes.
 *
 * Never throws.
 */
export async function compileTaskflowToIR(def: Taskflow): Promise<TaskflowIR> {
	const c = compileTaskflowToFlowIR(def);
	let hash: string | undefined;
	try {
		if (c.canonical.nodes.length > 0) {
			hash = hashFlowIR(c.canonical);
		}
	} catch {
		hash = undefined;
	}
	return {
		ir: c.ir,
		meta: c.meta,
		hash,
		warnings: c.warnings,
		errors: c.errors,
		// Fallback only when we could not content-address the IR.
		usedFallbackHash: c.usedFallbackHash || hash === undefined,
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
export { compileTaskflowToFlowIR, type CompileTaskflowToFlowIRResult } from "./compile.ts";
export { translateTaskflow } from "./translate.ts";

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
//                                          (schema.ts); the shape the compiler
//                                          emits and `hashFlowIR` content-addresses.
//
// The canonical names are re-exported under `Canonical*` aliases to avoid a
// duplicate-export clash with meta.ts's stub `FlowIR`/`FlowIRNode`.

export { FlowIRNodeKind } from "./schema.ts";
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

export type { NormalizedCond } from "./cond.ts";
export { normalizeCond } from "./cond.ts";

export { canonicalizeFlowIR, hashFlowIR, hashNode } from "./canonical-hash.ts";
