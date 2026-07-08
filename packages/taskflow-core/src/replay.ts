/**
 * Deterministic replay — **type stub + design contract (0.1.7)**.
 *
 * Replay re-evaluates a recorded run against changed **decision knobs** (gate
 * thresholds, budget caps, model route) by reading the event trace
 * (`trace.ts`) and re-applying deterministic decision logic — **never calling
 * `runTask`**. Zero tokens, offline. Because the DAG and its verdicts are data,
 * you can re-adjudicate them against recorded evidence.
 *
 * **0.1.7 ships the trace foundation + this type only.** The pure `replayRun()`
 * function and the `replay` action land in 0.2.0. The `ReplayDecision` type is
 * defined now so the trace schema and the diff-report contract are fixed before
 * any events are emitted — avoiding a breaking migration later.
 *
 * The 0.2.0 `replayRun()` will import ONLY from pure modules:
 *   `trace.ts` (read), `schema.ts` (topo sort/desugar),
 *   `interpolate.ts` (condition re-eval), `deterministic.ts` (parseGateVerdict,
 *   overBudget), `scorers.ts` (pure scorer re-run).
 * It must NOT import `runtime.ts` (which drags in the process-spawning runner)
 * — the "replay never spends a token" invariant is enforced structurally by the
 * import graph.
 */

/**
 * Per-phase outcome of a replay. Distinct from `RecomputeDecision` (which
 * describes a *live* recompute): only `"reused"` overlaps. Overloading
 * `RecomputeDecision.outcome` with replay-specific values would be a semantic
 * lie — replay and recompute are different operations (recorded vs. live).
 */
export interface ReplayDecision {
	readonly phaseId: string;
	readonly outcome:
		/** Recorded output valid → reused verbatim (zero tokens). */
		| "reused"
		/** A gate verdict flipped under the new threshold/scorers. */
		| "verdict-flipped"
		/** The phase would now BLOCK the flow (e.g. gate under a stricter threshold). */
		| "would-block"
		/** The phase would be skipped by a tighter budget cap. */
		| "would-exceed-budget"
		/** Replay cannot decide — a fresh model call is required. Conservative. */
		| "needs-live-rerun"
		/** A `when` guard now skips a phase that previously ran (or vice-versa). */
		| "would-skip"
		/** A score threshold changed (verdict may or may not have flipped). */
		| "threshold-changed"
		/** The phase failed in the recorded run; replay does not retry. */
		| "failed";
	readonly reason: string;
	/** The phase's outcome in the recorded run. */
	readonly priorOutcome?: string;
	/** The phase's outcome under the replayed knobs. */
	readonly replayedOutcome?: string;
	/** Upstream phases whose change caused this outcome, when applicable. */
	readonly causedBy?: readonly string[];
}

/**
 * Knobs a replay may override on a *copy* of the recorded definition (never the
 * stored run). v1 (0.2.0) supports the deterministic subset; anything that
 * would require re-generation (a changed task prompt) routes to
 * `needs-live-rerun`.
 */
export interface ReplayOverrides {
	/** `budget.maxUSD` / `budget.maxTokens` — re-tally recorded usage. */
	budgetMaxUSD?: number;
	budgetMaxTokens?: number;
	/** `phases.<id>.score.threshold` — re-run scorers against recorded target. */
	thresholds?: Record<string, number>;
	/** `phases.<id>.model` — report a cost delta only (cannot replay quality). */
	models?: Record<string, string>;
	/** `args.*` — only affects interpolation; changed-text phases → needs-live-rerun. */
	args?: Record<string, unknown>;
}

/** Sentinel: this module exports types only in 0.1.7. Implemented in 0.2.0. */
export const REPLAY_NOT_YET_IMPLEMENTED =
	"replayRun() lands in 0.2.0; 0.1.7 ships the trace foundation + this type contract.";
