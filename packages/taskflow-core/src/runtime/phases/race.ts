/**
 * Race phase — first **successful** branch wins (not first-settled).
 */

import type { Phase } from "../../schema.ts";
import type { RunResult } from "../../runner-core.ts";
import type { PhaseState } from "../../store.ts";
import { emptyUsage, aggregateUsage } from "../../usage.ts";
import { safeParse } from "../../interpolate.ts";

export interface RaceBranch {
	agent: string;
	task: string;
}

export interface RaceRunOne {
	(agent: string, task: string, signal?: AbortSignal): Promise<RunResult>;
}

export interface RaceIsFailed {
	(r: RunResult): boolean;
}

/**
 * First **successful** branch wins. Failed settles do not terminate the race.
 * If all fail → race fails. cancelLosers aborts others after a success (best-effort).
 * Final usage aggregates all branch results (including aborted partials).
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

	type Settled = { i: number; result: RunResult };
	const settled: Settled[] = [];
	let winner: Settled | undefined;
	let wake!: () => void;
	const gate = new Promise<void>((r) => {
		wake = r;
	});

	try {
		const branchPromises = branches.map(async (b, i) => {
			let result: RunResult;
			try {
				result = await runOne(b.agent, b.task, controllers[i]!.signal);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				result = {
					agent: b.agent,
					task: b.task,
					exitCode: 1,
					output: "",
					stderr: msg,
					usage: emptyUsage(),
					stopReason: "error",
					errorMessage: msg,
				};
			}
			const entry: Settled = { i, result };
			settled.push(entry);
			if (!winner && !isFailed(result)) {
				winner = entry;
				if (cancelLosers) {
					for (let j = 0; j < controllers.length; j++) {
						if (j !== i) {
							try {
								controllers[j]!.abort();
							} catch {
								/* ignore */
							}
						}
					}
				}
				wake();
			} else if (settled.length >= branches.length) {
				wake();
			}
			return entry;
		});

		await Promise.race([gate, Promise.allSettled(branchPromises).then(() => undefined)]);
		await Promise.allSettled(branchPromises);

		const totalUsage = aggregateUsage(settled.map((s) => s.result.usage ?? emptyUsage()));

		if (!winner) {
			const errs = settled
				.map((s) => s.result.errorMessage || s.result.stderr || `branch ${s.i + 1} failed`)
				.filter(Boolean);
			return {
				id: phase.id,
				status: "failed",
				error: `race phase '${phase.id}': all ${branches.length} branches failed${errs.length ? `: ${errs.slice(0, 3).join("; ")}` : ""}`,
				usage: totalUsage,
				inputHash: opts.inputHash,
				endedAt: Date.now(),
				warnings: ["race: all branches failed"],
				...(opts.readRefs ? { reads: opts.readRefs } : {}),
			};
		}

		const w = winner.result;
		const warnings = [`race: branch ${winner.i + 1}/${branches.length} won (first success)`];
		if (cancelLosers && branches.length > 1) {
			warnings.push(
				`race: cancelLosers aborted ${branches.length - 1} loser branch(es) (best-effort AbortSignal)`,
			);
		}
		return {
			id: phase.id,
			status: "done",
			output: w.output,
			json: opts.parseJson ? safeParse(w.output) : undefined,
			usage: totalUsage,
			model: w.model,
			inputHash: opts.inputHash,
			endedAt: Date.now(),
			warnings,
			...(opts.readRefs ? { reads: opts.readRefs } : {}),
		};
	} finally {
		if (opts.parentSignal) {
			opts.parentSignal.removeEventListener("abort", onParentAbort);
		}
	}
}
