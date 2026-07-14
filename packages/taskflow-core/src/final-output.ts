/**
 * Final-phase selection + output source attribution (0.2.0 dogfood issue 6).
 *
 * Pure, total, host-neutral. Shared by the imperative runtime (`runtime.ts` →
 * `runTaskflowLayers`) and the event kernel (`exec/driver.ts`) so the two paths
 * agree on which phase's output becomes `finalOutput`, the fallback when the
 * designated final phase didn't complete, the no-output default, and the
 * `outputSourcePhaseId` attribution reported to hosts.
 *
 * Kept in its own module (rather than inlined in `runtime.ts`) so the event
 * kernel can import it without pulling the rest of the runtime into its module
 * graph — avoiding a static `runtime ↔ exec/driver` import cycle (runtime
 * already loads driver lazily via a dynamic `import()`).
 */

import { finalPhase, type Phase } from "./schema.ts";
import type { RunState } from "./store.ts";

/** The run's final output + the id of the phase whose output supplied it. */
export interface FinalOutputResolution {
	finalOutput: string;
	/** Id of the phase whose output supplied `finalOutput`; `undefined` when no
	 *  phase output is available. See `RuntimeResult.outputSourcePhaseId`. */
	outputSourcePhaseId: string | undefined;
}

/** Blocking-context inputs to {@link resolveFinalOutput}. */
export interface FinalOutputBlockedCtx {
	gate: boolean;
	gateReason: string;
	/** The blocking gate/approval phase's output (included in the gate prefix). */
	gateOutput: string;
	/** Id of the blocking gate/approval phase (the source of `gateOutput`). */
	gatePhaseId: string | undefined;
	budget: boolean;
	budgetReason: string;
}

/**
 * Resolve the run's final output + the id of the phase whose output supplied it.
 *
 * Selection uses `finalPhase()` (the designated `final: true` phase, else the
 * last phase in definition order). When that phase didn't complete (skipped /
 * blocked / failed), falls back to the last `done` phase in definition order.
 *
 * Source attribution (the phase whose output appears in `finalOutput`):
 * - Normal: the fallback final phase (when it has output).
 * - Gate blocked: the blocking gate/approval phase (when its output is included
 *   in the prefix), else `undefined`.
 * - Budget blocked: the fallback final phase (when its output is included),
 *   else `undefined`.
 * `undefined` whenever no phase output is available. Never the designated
 * skipped/failed final phase — attribution tracks the phase whose output is
 * actually present in `finalOutput`.
 */
export function resolveFinalOutput(
	phases: Phase[],
	state: RunState,
	blocked: FinalOutputBlockedCtx,
): FinalOutputResolution {
	const fp = finalPhase(phases);
	let finalState = state.phases[fp.id];
	if (!finalState || finalState.status !== "done") {
		const doneInOrder = phases.map((p) => state.phases[p.id]).filter((p) => p?.status === "done");
		if (doneInOrder.length) finalState = doneInOrder[doneInOrder.length - 1];
	}
	let finalOutput: string;
	let sourceId: string | undefined;
	if (blocked.gate) {
		finalOutput = `Gate blocked the workflow.${blocked.gateReason ? `\nReason: ${blocked.gateReason}` : ""}${blocked.gateOutput ? `\n\n${blocked.gateOutput}` : ""}`;
		// The gate prefix surfaces the blocking gate/approval phase's output.
		// Attribute to that phase when its output is included; otherwise no
		// phase output is available. In the common case the blocking phase is
		// also the fallback final phase (downstream is skipped), so this
		// coincides with the fallback source id.
		sourceId = blocked.gateOutput ? blocked.gatePhaseId : undefined;
	} else if (blocked.budget) {
		finalOutput = `Budget exceeded — run halted.${blocked.budgetReason ? `\nReason: ${blocked.budgetReason}` : ""}${finalState?.output ? `\n\n${finalState.output}` : ""}`;
		sourceId = finalState?.output ? finalState.id : undefined;
	} else {
		finalOutput = finalState?.output ?? "(no output)";
		// Attribute to a completed phase whenever its output field supplied the
		// result, including the valid empty-string output. `undefined` means no
		// phase output existed at all.
		sourceId = finalState && finalState.status === "done" && finalState.output !== undefined ? finalState.id : undefined;
	}
	return { finalOutput, outputSourcePhaseId: sourceId };
}
