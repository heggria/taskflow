/**
 * Type definitions for the FlowIR compile seam.
 *
 * This is the **stub/projection** layer of the overstory-convergence roadmap's
 * M1 slice: we project a pi-taskflow `Taskflow` into a `FlowIR` shape that
 * mirrors overstory's IR contract *structurally* (nodes with `inject`/`emits`)
 * without yet compiling to overstory's native inject/emits model. The hash
 * contract (overstory's `hashIR` algorithm) is shared via `flowDefHash` — see
 * `./hash.ts`. When the genuine overstory compiler is vendored later, the
 * `usedFallbackHash` flag flips to `false` and `ir` becomes the canonical IR;
 * until then this seam is read-only, pure, and never throws.
 *
 * Pure module: no IO, no Date, no randomness. Type-only where possible.
 *
 * @see docs/internal/overstory-convergence-roadmap.md §3 (M1)
 * @see docs/internal/rfc-flowir-compilation.md
 */

import type { Budget, Taskflow } from "../schema.ts";

// ---------------------------------------------------------------------------
// Declared dependency plane (compile-time, M2)
// ---------------------------------------------------------------------------

/**
 * A phase's *declared* (static) dependency footprint, synthesized at compile
 * time from `{steps.X}` interpolation refs (via `collectRefs`) plus `dependsOn`.
 * `reads` = the upstream step ids this phase's task/when/branches/with/context
 * statically reference; `writes` = the step id this phase emits (itself).
 *
 * This is the *declared* plane — distinct from the *observed* readSet captured
 * at runtime (M3 `PhaseState.reads`). The two are reconciled by a **union**
 * (`observed ∪ declared`) in `computeStaleFrontier` / `recomputeTaskflow` so a
 * declared-but-unobserved edge (e.g. a `when` ref that never fired) is still
 * treated as a dependency for staleness propagation. JSON-safe `Record` shape
 * (not `Map`) so it round-trips through `RunState` persistence.
 */
export interface DeclaredDeps {
	/** Upstream step ids statically referenced by this phase's interpolation. */
	reads: string[];
	/** Step id(s) this phase emits — currently `[phase.id]` (1:1 projection). */
	writes: string[];
}

// ---------------------------------------------------------------------------
// FlowIR (1:1 projection of a Taskflow)
// ---------------------------------------------------------------------------

/**
 * A single IR node — one per pi-taskflow phase. `kind` is the native phase type
 * (a 1:1 projection; the overstory-native kind lowering is deferred per roadmap
 * §6.1). `inject`/`emits` mirror overstory's contract: a node *injects*
 * (reads) the outputs of its upstream nodes and *emits* (writes) its own.
 */
export interface FlowIRNode {
	id: string;
	/** pi-taskflow phase type (1:1 projection; `agent`|`parallel`|`map`|…). */
	kind: string;
	/** Synthesized declared reads: the `{steps.X}` refs this node's task
	 *  interpolates. (overstory-native `inject` lowering is deferred.) */
	inject: string[];
	/** What this node emits — currently `[id]` (1:1 projection). */
	emits: string[];
	/** Raw `when` guard passthrough (stub: not rewritten to IR conditions). */
	when?: string;
}

/** The compiled IR: a flat list of nodes plus flow-level metadata. */
export interface FlowIR {
	name: string;
	nodes: FlowIRNode[];
	args?: Taskflow["args"];
	budget?: Budget;
	concurrency?: number;
}

// ---------------------------------------------------------------------------
// Compile diagnostics
// ---------------------------------------------------------------------------

/** A hard compile error (none in the stub; reserved for the genuine compiler). */
export interface CompileError {
	phaseId?: string;
	code: string;
	message: string;
}

/** A non-fatal advisory (e.g. a `{steps.X}` ref not reachable via dependsOn). */
export interface CompileWarning {
	phaseId?: string;
	message: string;
}

// ---------------------------------------------------------------------------
// Meta + composite return type
// ---------------------------------------------------------------------------

/**
 * Compile-time metadata attached to the IR. `declaredDeps` is the M2 declared
 * plane (per-phase `DeclaredDeps`); `sidecar` carries every pi-taskflow-specific
 * field not represented in `FlowIRNode` so the projection is lossless and can
 * round-trip back to a runnable `Taskflow`.
 */
export interface TaskflowIRMeta {
	sourceFlowName: string;
	/** Per-phase declared dependency footprint (M2). JSON-safe. */
	declaredDeps: Record<string, DeclaredDeps>;
	/** Pi-taskflow-specific fields preserved verbatim for round-trip. */
	sidecar: Record<string, unknown>;
}

/**
 * The composite compile result (RFC §5). `ir`/`hash` are present unless
 * synthesis failed. `usedFallbackHash` is `false` once the genuine compiler
 * (S0 / `flowir/compile.ts`) content-addresses the IR via `hashFlowIR`; it is
 * `true` only when IR could not be produced (empty phases / hard errors).
 */
export interface TaskflowIR {
	ir?: FlowIR;
	meta: TaskflowIRMeta;
	/** Content-addressed IR hash: `ir:<64-hex>` from `hashFlowIR` (S0). */
	hash?: string;
	warnings: CompileWarning[];
	errors: CompileError[];
	usedFallbackHash: boolean;
}
