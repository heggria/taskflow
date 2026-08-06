/**
 * Read-only cross-run analytics for a saved flow name.
 * Aggregates last N runs from the project store — no writes, no auto-tune.
 */

import { listRuns, type RunState } from "./store.ts";
import { countPhaseOutcomes } from "./savings.ts";

export interface FlowAnalytics {
	flowName: string;
	window: { last: number };
	runs: number;
	statusHistogram: Record<string, number>;
	p50DurationMs?: number;
	p95DurationMs?: number;
	totalCostUSD?: number;
	perPhase: Array<{
		phaseId: string;
		runs: number;
		failRate: number;
		p50DurationMs?: number;
		cacheHitRate?: number;
	}>;
}

function percentile(sorted: number[], p: number): number | undefined {
	if (!sorted.length) return undefined;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[idx];
}

function durationMs(run: RunState): number | undefined {
	const start = run.createdAt;
	const end = run.updatedAt;
	if (typeof start !== "number" || typeof end !== "number" || end < start) return undefined;
	return end - start;
}

function phaseDuration(ps: { startedAt?: number; endedAt?: number }): number | undefined {
	if (typeof ps.startedAt !== "number" || typeof ps.endedAt !== "number" || ps.endedAt < ps.startedAt) {
		return undefined;
	}
	return ps.endedAt - ps.startedAt;
}

/**
 * Aggregate analytics for runs of `flowName` (exact match on RunState.flowName).
 */
export function analyzeFlowRuns(cwd: string, flowName: string, opts: { last?: number } = {}): FlowAnalytics {
	const last = Math.min(100, Math.max(1, opts.last ?? 20));
	// listRuns returns recent across all flows; filter + re-cap
	const all = listRuns(cwd, Math.max(last * 5, 50));
	const runs = all.filter((r) => r.flowName === flowName).slice(0, last);

	const statusHistogram: Record<string, number> = {};
	const durations: number[] = [];
	let totalCostUSD = 0;
	let costAny = false;

	type PhaseAcc = {
		runs: number;
		fails: number;
		cacheHits: number;
		durations: number[];
	};
	const byPhase = new Map<string, PhaseAcc>();

	for (const run of runs) {
		statusHistogram[run.status] = (statusHistogram[run.status] ?? 0) + 1;
		const d = durationMs(run);
		if (d !== undefined) durations.push(d);

		for (const [id, ps] of Object.entries(run.phases ?? {})) {
			let acc = byPhase.get(id);
			if (!acc) {
				acc = { runs: 0, fails: 0, cacheHits: 0, durations: [] };
				byPhase.set(id, acc);
			}
			acc.runs++;
			if (ps.status === "failed") acc.fails++;
			if (ps.cacheHit) acc.cacheHits++;
			const pd = phaseDuration(ps);
			if (pd !== undefined) acc.durations.push(pd);
			const cost = (ps.usage as { cost?: number } | undefined)?.cost;
			if (typeof cost === "number") {
				totalCostUSD += cost;
				costAny = true;
			}
		}
	}

	durations.sort((a, b) => a - b);
	const perPhase = [...byPhase.entries()]
		.map(([phaseId, acc]) => {
			acc.durations.sort((a, b) => a - b);
			return {
				phaseId,
				runs: acc.runs,
				failRate: acc.runs ? acc.fails / acc.runs : 0,
				p50DurationMs: percentile(acc.durations, 0.5),
				cacheHitRate: acc.runs ? acc.cacheHits / acc.runs : undefined,
			};
		})
		.sort((a, b) => b.runs - a.runs);

	return {
		flowName,
		window: { last },
		runs: runs.length,
		statusHistogram,
		p50DurationMs: percentile(durations, 0.5),
		p95DurationMs: percentile(durations, 0.95),
		totalCostUSD: costAny ? totalCostUSD : undefined,
		perPhase,
	};
}

export function formatAnalyticsReport(a: FlowAnalytics, json = false): string {
	if (json) return JSON.stringify(a, null, 2);
	if (a.runs === 0) {
		return `analytics — flow "${a.flowName}" · no runs in last ${a.window.last}`;
	}
	const lines: string[] = [
		`analytics — flow "${a.flowName}" · last ${a.window.last} · ${a.runs} run(s)`,
		`status: ${Object.entries(a.statusHistogram)
			.map(([k, v]) => `${k}=${v}`)
			.join(" · ")}`,
	];
	if (a.p50DurationMs !== undefined) {
		lines.push(
			`duration: p50=${formatMs(a.p50DurationMs)}${a.p95DurationMs !== undefined ? ` · p95=${formatMs(a.p95DurationMs)}` : ""}`,
		);
	}
	if (a.totalCostUSD !== undefined) {
		lines.push(`totalCostUSD (sum of phase costs): ${a.totalCostUSD.toFixed(4)}`);
	}
	if (a.perPhase.length) {
		lines.push("");
		lines.push("per phase:");
		for (const p of a.perPhase.slice(0, 30)) {
			const fail = `fail=${(p.failRate * 100).toFixed(0)}%`;
			const cache =
				p.cacheHitRate !== undefined ? ` · cache=${(p.cacheHitRate * 100).toFixed(0)}%` : "";
			const dur = p.p50DurationMs !== undefined ? ` · p50=${formatMs(p.p50DurationMs)}` : "";
			lines.push(`  · ${p.phaseId}: n=${p.runs} · ${fail}${cache}${dur}`);
		}
	}
	void countPhaseOutcomes;
	return lines.join("\n");
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}
