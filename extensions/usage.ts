/**
 * Usage accounting — token/cost stats shared across the runner (producer),
 * runtime (aggregation), store (persistence), and render (display).
 *
 * Kept in its own leaf module so persistence and TUI don't have to depend on
 * the process-spawning layer (`runner.ts`) just for these types/helpers.
 */

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Sum numeric usage fields across runs. `contextTokens` is intentionally excluded (it is a point-in-time gauge, not additive). */
export function aggregateUsage(usages: UsageStats[]): UsageStats {
	const total = emptyUsage();
	for (const u of usages) {
		total.input += u.input;
		total.output += u.output;
		total.cacheRead += u.cacheRead;
		total.cacheWrite += u.cacheWrite;
		total.cost += u.cost;
		total.turns += u.turns;
	}
	return total;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
