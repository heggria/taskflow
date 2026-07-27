/**
 * Bounded auto-reconcile (D33). Exhaustion → unknown + needs-operator,
 * no fake terminal, no final Receipt, slot held (orphan-suspect).
 */
import type { ExecutionProvider, ReconcileResult } from "./provider.ts";
import type { RunProjection, RunStage, RunStatus } from "./types.ts";

export interface ReconcileBudget {
	/** Max auto-reconcile attempts. */
	maxAttempts: number;
	/** Wall-clock deadline ms from start (optional). */
	deadlineMs?: number;
}

export const DEFAULT_RECONCILE_BUDGET: ReconcileBudget = {
	maxAttempts: 3,
	deadlineMs: 5_000,
};

export interface ReconcileOutcome {
	/** Updated status/stage for the run. */
	status: RunStatus;
	stage: RunStage;
	/** True when automation exhausted — needs operator. */
	needsOperator: boolean;
	/** Terminal proven outcome. */
	terminal?: "completed" | "failed" | "cancelled";
	output?: string;
	error?: string;
	/** Number of reconcile attempts performed. */
	attempts: number;
	/** Provider still ambiguous after budget. */
	exhausted: boolean;
}

/**
 * Run bounded auto-reconcile. Never invents terminal on exhaustion.
 */
export async function boundedReconcile(
	provider: ExecutionProvider,
	handle: string,
	budget: ReconcileBudget = DEFAULT_RECONCILE_BUDGET,
): Promise<ReconcileOutcome> {
	const start = Date.now();
	let attempts = 0;
	let last: ReconcileResult | undefined;

	while (attempts < budget.maxAttempts) {
		if (budget.deadlineMs !== undefined && Date.now() - start > budget.deadlineMs) {
			break;
		}
		attempts += 1;
		last = await provider.reconcile(handle);
		if (last.kind === "completed") {
			return {
				status: "completed",
				stage: "terminal",
				needsOperator: false,
				terminal: "completed",
				output: last.output,
				attempts,
				exhausted: false,
			};
		}
		if (last.kind === "failed") {
			return {
				status: "failed",
				stage: "terminal",
				needsOperator: false,
				terminal: "failed",
				error: last.error,
				attempts,
				exhausted: false,
			};
		}
		if (last.kind === "cancelled") {
			// A provider-local cancelled enum is not a durable, command-bound proof
			// that all external side effects are contained. Treat it exactly like
			// ambiguity until a provider-independent containment protocol exists;
			// otherwise a generic/remote adapter can manufacture a terminal run and
			// release capacity merely by reporting `cancelled` during reconciliation.
			last = {
				kind: "ambiguous",
				reason: "provider reported cancelled without a durable containment proof",
			};
			continue;
		}
		if (last.kind === "running") {
			return {
				status: "running",
				stage: "executing",
				needsOperator: false,
				attempts,
				exhausted: false,
			};
		}
		// ambiguous — continue loop
	}

	// Exhausted — stay unknown / reconciling, needs-operator
	return {
		status: "unknown",
		stage: "reconciling",
		needsOperator: true,
		attempts,
		exhausted: true,
		error: last && last.kind === "ambiguous" ? last.reason : "reconcile budget exhausted",
	};
}

/** Apply reconcile outcome to a run projection (pure). */
export function applyReconcileToRun(
	run: RunProjection,
	outcome: ReconcileOutcome,
): RunProjection {
	return {
		...run,
		status: outcome.status,
		stage: outcome.stage,
		needsOperator: outcome.needsOperator,
		finalOutput: outcome.output ?? run.finalOutput,
		error: outcome.error ?? run.error,
		updatedAt: Date.now(),
		runVersion: run.runVersion + 1,
	};
}
