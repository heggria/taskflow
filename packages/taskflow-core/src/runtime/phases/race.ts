/**
 * Race phase — first completed branch wins.
 *
 * Isolated from the runtime monolith so Horizon B kinds land without growing
 * `runtime.ts` further. Callers inject fan-out primitives (runOne / cache).
 */

import type { Phase } from "../../schema.ts";
import type { RunResult } from "../../runner-core.ts";
import type { PhaseState } from "../../store.ts";
import { emptyUsage } from "../../usage.ts";
import { safeParse } from "../../interpolate.ts";

export interface RaceBranch {
	agent: string;
	task: string;
}

export interface RaceRunOne {
	(agent: string, task: string): Promise<RunResult>;
}

export interface RaceIsFailed {
	(r: RunResult): boolean;
}

/**
 * Execute race branches. Pure w.r.t. scheduling — does not touch RunState.
 */
export async function executeRaceBranches(
	phase: Phase,
	branches: RaceBranch[],
	runOne: RaceRunOne,
	isFailed: RaceIsFailed,
	opts: {
		inputHash: string;
		parseJson: boolean;
		readRefs?: PhaseState["reads"];
	},
): Promise<PhaseState> {
	if (branches.length < 2) {
		return {
			id: phase.id,
			status: "failed",
			error: `race phase '${phase.id}': needs at least 2 branches`,
			endedAt: Date.now(),
			usage: emptyUsage(),
			inputHash: opts.inputHash,
		};
	}

	// cancelLosers reserved for multi-signal abort plumbing
	void (phase as { cancelLosers?: boolean }).cancelLosers;

	const raced = await Promise.race(
		branches.map(async (b, i) => {
			const result = await runOne(b.agent, b.task);
			return { i, result };
		}),
	);

	const winner = raced.result;
	const failed = isFailed(winner);
	return {
		id: phase.id,
		status: failed ? "failed" : "done",
		output: failed
			? winner.errorMessage || winner.stderr || winner.output || `race branch ${raced.i + 1} failed`
			: winner.output,
		json: opts.parseJson ? safeParse(winner.output) : undefined,
		usage: winner.usage ?? emptyUsage(),
		model: winner.model,
		error: failed ? winner.errorMessage ?? winner.stderr : undefined,
		inputHash: opts.inputHash,
		endedAt: Date.now(),
		warnings: [`race: branch ${raced.i + 1}/${branches.length} won`],
		...(opts.readRefs ? { reads: opts.readRefs } : {}),
	};
}
