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

/** Optional per-branch AbortSignal — used to cancel losers after a winner settles. */
export interface RaceRunOne {
	(agent: string, task: string, signal?: AbortSignal): Promise<RunResult>;
}

export interface RaceIsFailed {
	(r: RunResult): boolean;
}

/**
 * Execute race branches. Pure w.r.t. scheduling — does not touch RunState.
 *
 * When `cancelLosers` is true (default), abort controllers for non-winning
 * branches fire after the first branch settles (best-effort: depends on the
 * host runner honoring AbortSignal).
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
		/** Parent run abort — chained onto each branch controller. */
		parentSignal?: AbortSignal;
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

	const cancelLosers = (phase as { cancelLosers?: boolean }).cancelLosers !== false;
	const controllers = branches.map(() => new AbortController());

	// Chain parent abort → all branches.
	const onParentAbort = () => {
		for (const c of controllers) {
			try {
				c.abort();
			} catch {
				/* ignore */
			}
		}
	};
	if (opts.parentSignal) {
		if (opts.parentSignal.aborted) onParentAbort();
		else opts.parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}

	const branchPromises = branches.map(async (b, i) => {
		const result = await runOne(b.agent, b.task, controllers[i]!.signal);
		return { i, result };
	});

	const raced = await Promise.race(branchPromises);

	if (cancelLosers) {
		for (let j = 0; j < controllers.length; j++) {
			if (j !== raced.i) {
				try {
					controllers[j]!.abort();
				} catch {
					/* ignore */
				}
			}
		}
	}

	// Let aborted branches settle (avoid unhandled rejections / orphan work).
	await Promise.allSettled(branchPromises);

	if (opts.parentSignal) {
		opts.parentSignal.removeEventListener("abort", onParentAbort);
	}

	const winner = raced.result;
	const failed = isFailed(winner);
	const warnings = [`race: branch ${raced.i + 1}/${branches.length} won`];
	if (cancelLosers) {
		warnings.push(
			`race: cancelLosers aborted ${branches.length - 1} loser branch(es) (best-effort AbortSignal)`,
		);
	}
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
		warnings,
		...(opts.readRefs ? { reads: opts.readRefs } : {}),
	};
}
