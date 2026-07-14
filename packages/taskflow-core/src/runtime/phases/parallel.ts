/**
 * Parallel phase — wait for all branches (static fan-out).
 * Scheduling stays injected (`runFanout`); this module only shapes the call.
 */

import type { Phase } from "../../schema.ts";
import type { RunResult } from "../../runner-core.ts";
import type { PhaseState } from "../../store.ts";

export interface ParallelBranch {
	agent: string;
	task: string;
	/** Per-branch literal cwd (a workspace keyword is rejected by validation).
	 *  When set, overrides the phase-level effective cwd for this branch only. */
	cwd?: string;
}

export interface ParallelFanout {
	(branches: ParallelBranch[]): Promise<RunResult[]>;
}

export interface ParallelMerge {
	(phaseId: string, results: RunResult[], inputHash: string, parseJson: boolean): PhaseState;
}

/**
 * Run all parallel branches and merge into one PhaseState.
 */
export async function executeParallelBranches(
	phase: Phase,
	branches: ParallelBranch[],
	runFanout: ParallelFanout,
	mergePhaseState: ParallelMerge,
	opts: {
		inputHash: string;
		parseJson: boolean;
		reads?: PhaseState["reads"];
	},
): Promise<PhaseState> {
	const results = await runFanout(branches);
	const ps = mergePhaseState(phase.id, results, opts.inputHash, opts.parseJson);
	if (opts.reads) ps.reads = opts.reads;
	return ps;
}
