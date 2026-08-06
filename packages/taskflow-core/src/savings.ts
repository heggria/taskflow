/**
 * Incremental / recompute savings summary — one-line numbers users can see.
 *
 * Pure formatters over RecomputeReport and run phase states. No I/O.
 */

import type { PhaseState, RunState } from "./store.ts";

/** Minimal recompute-shaped input (avoids circular import with runtime). */
export interface SavingsRecomputeInput {
	readonly dryRun?: boolean;
	readonly seeds?: readonly string[];
	readonly rerun: readonly string[];
	readonly reused: readonly string[];
	readonly cutoff: readonly string[];
}

export interface PhaseCountSummary {
	total: number;
	completed: number;
	failed: number;
	skipped: number;
	/** Phases with cacheHit set (cross-run or run-only). */
	cached: number;
	running: number;
	other: number;
}

/** Count phase outcomes from a run state map (status / cache hits). */
export function countPhaseOutcomes(phases: Record<string, PhaseState> | undefined): PhaseCountSummary {
	const out: PhaseCountSummary = {
		total: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		cached: 0,
		running: 0,
		other: 0,
	};
	if (!phases) return out;
	for (const ps of Object.values(phases)) {
		out.total++;
		if (ps.cacheHit) out.cached++;
		switch (ps.status) {
			case "done":
				out.completed++;
				break;
			case "failed":
				out.failed++;
				break;
			case "skipped":
				out.skipped++;
				break;
			case "running":
			case "pending":
				out.running++;
				break;
			default:
				out.other++;
		}
	}
	return out;
}

/**
 * One-line savings for recompute reports.
 * Example: `reused 5 · rerun 2 · cutoff 1 · saved ~71% phases`
 */
export function formatSavingsLine(r: SavingsRecomputeInput): string {
	const reused = r.reused.length;
	const rerun = r.rerun.length;
	const cutoff = r.cutoff.length;
	const total = reused + rerun + cutoff;
	const saved = reused + cutoff;
	const pct = total > 0 ? Math.round((saved / total) * 100) : 0;
	const parts = [
		`reused ${reused}`,
		`rerun ${rerun}`,
		...(r.dryRun ? [] : [`cutoff ${cutoff}`]),
		total > 0 ? `saved ~${pct}% phases` : "saved —",
	];
	return parts.join(" · ");
}

/** One-line run cache summary when any phase was a cache hit. */
export function formatRunCacheLine(state: Pick<RunState, "phases">): string | undefined {
	const c = countPhaseOutcomes(state.phases);
	if (c.cached === 0) return undefined;
	const pct = c.total > 0 ? Math.round((c.cached / c.total) * 100) : 0;
	return `cache hits ${c.cached}/${c.total} (~${pct}%) · completed ${c.completed} · failed ${c.failed} · skipped ${c.skipped}`;
}

/** Prefix block for recompute human output. */
export function formatRecomputeSavingsHeader(r: SavingsRecomputeInput): string {
	const mode = r.dryRun ? "DRY RUN" : "applied";
	const seeds = r.seeds?.length ? r.seeds.join(", ") : "—";
	return `Savings (${mode}, seed: ${seeds}): ${formatSavingsLine(r)}`;
}
