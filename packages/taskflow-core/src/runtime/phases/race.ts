/**
 * Race phase — first **successful** branch wins (not first-settled).
 */

import type { Phase } from "../../schema.ts";
import type { RunResult } from "../../runner-core.ts";
import type { PhaseState } from "../../store.ts";
import { emptyUsage, aggregateUsage } from "../../usage.ts";
import { safeParse } from "../../interpolate.ts";

/**
 * A race cannot return a successful result while loser usage is still unknown:
 * doing so lets the next phase spend against an incomplete budget snapshot.
 * Give every branch the same finite accounting window as an ordinary agent
 * call (60s by default), capped so a hostile/injected runner can never strand
 * the workflow forever even when it ignores AbortSignal.
 */
const DEFAULT_ACCOUNTING_TIMEOUT_MS = 60_000;
const MAX_ACCOUNTING_TIMEOUT_MS = 300_000;

function accountingTimeoutMs(phase: Phase): number {
	const configured = phase.timeout;
	if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 1000) {
		return DEFAULT_ACCOUNTING_TIMEOUT_MS;
	}
	return Math.min(configured, MAX_ACCOUNTING_TIMEOUT_MS);
}

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
 * Final usage aggregates every branch result. A non-cooperative branch that
 * ignores abort is bounded by a finite accounting deadline; if it remains
 * outstanding the race fails closed with budgetTruncated so no downstream
 * phase can run against an incomplete usage snapshot.
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
	const accountingTimeout = accountingTimeoutMs(phase);
	const accountingDeadline = Date.now() + accountingTimeout;

	type Settled = { i: number; result: RunResult };
	const settled: Settled[] = [];
	let winner: Settled | undefined;
	let accountingTimedOut = false;
	let wake!: () => void;
	const gate = new Promise<void>((r) => {
		wake = r;
	});

	const onParentAbort = () => {
		for (const c of controllers) {
			try {
				c.abort();
			} catch {
				/* ignore */
			}
		}
		// Unblock the wait loop so non-cooperative runners hit the accounting deadline
		// instead of hanging forever (AGENTS: never hang forever).
		wake();
	};
	if (opts.parentSignal) {
		if (opts.parentSignal.aborted) onParentAbort();
		else opts.parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}

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
			// Parent cancellation wins over a late branch success. The branch still
			// enters `settled` so its usage is accounted, but it can never revive the
			// cancelled run or provide a successful race output.
			if (!winner && opts.parentSignal?.aborted !== true && !isFailed(result)) {
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

		const allSettled = Promise.allSettled(branchPromises).then(() => undefined);
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<void>((resolve) => {
			deadlineTimer = setTimeout(() => {
				accountingTimedOut = true;
				for (const c of controllers) {
					try {
						c.abort();
					} catch {
						/* ignore */
					}
				}
				resolve();
			}, Math.max(0, accountingDeadline - Date.now()));
		});
		try {
			// First wait for a winner, complete failure, parent abort, or the finite
			// deadline. Then keep the phase quarantined until every branch reports
			// its usage. This preserves honest budgets without an unbounded wait.
			await Promise.race([gate, allSettled, deadline]);
			if (settled.length < branches.length && !accountingTimedOut) {
				await Promise.race([allSettled, deadline]);
			}
		} finally {
			if (deadlineTimer) clearTimeout(deadlineTimer);
		}

		const totalUsage = aggregateUsage(settled.map((s) => s.result.usage ?? emptyUsage()));
		const outstanding = branches.length - settled.length;
		const parentAborted = opts.parentSignal?.aborted === true;

		if (parentAborted) {
			const warnings = ["race: parent run aborted; branch successes were discarded"];
			if (outstanding > 0) {
				warnings.push(
					`race: ${outstanding} branch(es) did not report usage within ${accountingTimeout}ms; downstream execution is disabled`,
				);
			}
			return {
				id: phase.id,
				status: "failed",
				error: `race phase '${phase.id}' aborted by parent`,
				usage: totalUsage,
				inputHash: opts.inputHash,
				endedAt: Date.now(),
				budgetTruncated: outstanding > 0 || undefined,
				warnings,
				...(opts.readRefs ? { reads: opts.readRefs } : {}),
			};
		}

		if (outstanding > 0) {
			return {
				id: phase.id,
				status: "failed",
				error: `race phase '${phase.id}': ${outstanding} branch(es) did not report usage within ${accountingTimeout}ms; refusing to continue with incomplete budget accounting`,
				usage: totalUsage,
				inputHash: opts.inputHash,
				endedAt: Date.now(),
				budgetTruncated: true,
				warnings: [
					`race: accounting deadline reached with ${outstanding} outstanding branch(es); downstream execution is disabled`,
				],
				...(opts.readRefs ? { reads: opts.readRefs } : {}),
			};
		}

		if (!winner) {
			const errs = settled
				.map((s) => s.result.errorMessage || s.result.stderr || `branch ${s.i + 1} failed`)
				.filter(Boolean);
			const warnings = ["race: all branches failed"];
			return {
				id: phase.id,
				status: "failed",
				error: `race phase '${phase.id}': all ${branches.length} branches failed${errs.length ? `: ${errs.slice(0, 3).join("; ")}` : ""}`,
				usage: totalUsage,
				inputHash: opts.inputHash,
				endedAt: Date.now(),
				warnings,
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
