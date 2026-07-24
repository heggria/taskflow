/**
 * Bounded auto-reconcile (D33). Exhaustion → unknown + needs-operator,
 * no fake terminal, no final Receipt, slot held (orphan-suspect).
 */
import type { ExecutionProvider, ReconcileResult } from "./provider.ts";
import type {
	RunNodeProjection,
	RunProjection,
	RunStage,
	RunStatus,
} from "./types.ts";

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
 * A proven terminal provider outcome settles only work that was active at the
 * boundary. Pending downstream nodes remain pending so the projection does not
 * pretend they ran; already-terminal nodes retain their stronger evidence.
 */
export function settleTerminalNodes(
	nodes: readonly RunNodeProjection[],
	terminal: "completed" | "failed" | "cancelled",
): RunNodeProjection[] {
	return nodes.map((node) =>
		node.status === "running" ||
		node.status === "waiting"
			? { ...node, status: terminal }
			: node,
	);
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
			return {
				status: "cancelled",
				stage: "terminal",
				needsOperator: false,
				terminal: "cancelled",
				attempts,
				exhausted: false,
			};
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
		...(outcome.terminal && run.nodes
			? {
					nodes: settleTerminalNodes(
						run.nodes,
						outcome.terminal,
					),
				}
			: {}),
		status: outcome.status,
		stage: outcome.stage,
		needsOperator: outcome.needsOperator,
		finalOutput: outcome.output ?? run.finalOutput,
		error: outcome.error ?? run.error,
		updatedAt: Date.now(),
		runVersion: run.runVersion + 1,
	};
}
