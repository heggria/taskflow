/**
 * Deterministic replay — re-fold a recorded event log under alternate **decision
 * knobs** without calling the model (RFC §7, S3).
 *
 * **Import graph guard (structural):** this module imports only pure packages
 * (`exec/events`, `exec/fold`, `deterministic`, `scorers`). It must NEVER import
 * `runtime.ts` or `exec/driver` / `exec/step` (those drag process-spawning).
 *
 * 0.1.7 shipped types only. 0.2.0 implements {@link replayRun}.
 */

import { overBudget, type BudgetCheckInput } from "./deterministic.ts";
import type { Event, EventDecision } from "./exec/events.ts";
import { foldEvents, type FoldedRun } from "./exec/fold.ts";
import { emptyUsage, type UsageStats } from "./usage.ts";

/**
 * Per-phase outcome of a replay. Distinct from `RecomputeDecision` (which
 * describes a *live* recompute): only `"reused"` overlaps.
 */
export interface ReplayDecision {
	readonly phaseId: string;
	readonly outcome:
		| "reused"
		| "verdict-flipped"
		| "would-block"
		| "would-exceed-budget"
		| "needs-live-rerun"
		| "would-skip"
		| "threshold-changed"
		| "failed";
	readonly reason: string;
	readonly priorOutcome?: string;
	readonly replayedOutcome?: string;
	readonly causedBy?: readonly string[];
}

/**
 * Knobs a replay may override on a *copy* of the recorded definition (never the
 * stored run).
 */
export interface ReplayOverrides {
	budgetMaxUSD?: number;
	budgetMaxTokens?: number;
	/** `phases.<id>.score.threshold` — re-judge recorded gate-score events. */
	thresholds?: Record<string, number>;
	/** `phases.<id>.model` — cost delta only (needs rates; otherwise needs-live-rerun). */
	models?: Record<string, string>;
	/** `args.*` — text-changing args → needs-live-rerun for affected phases. */
	args?: Record<string, unknown>;
}

/** Result of {@link replayRun}. */
export interface ReplayReport {
	readonly decisions: ReplayDecision[];
	/** Fold under recorded knobs (baseline). */
	readonly baseline: FoldedRun;
	/** Fold after applying overrides (may equal baseline when no knobs change). */
	readonly replayed: FoldedRun;
	/** True if any phase needs a live model call. */
	readonly needsLiveRerun: boolean;
	/** Aggregate recorded usage (for budget re-check). */
	readonly totalUsage: UsageStats;
}

function sumUsage(run: FoldedRun): UsageStats {
	const u = emptyUsage();
	for (const p of Object.values(run.phases)) {
		u.input += p.usage.input;
		u.output += p.usage.output;
		u.cacheRead += p.usage.cacheRead;
		u.cacheWrite += p.usage.cacheWrite;
		u.cost += p.usage.cost;
		u.turns += p.usage.turns;
	}
	return u;
}

function gateScoreDecision(d: EventDecision | undefined): Extract<EventDecision, { type: "gate-score" }> | undefined {
	return d?.type === "gate-score" ? d : undefined;
}

/**
 * Re-evaluate a recorded event log under optional decision overrides.
 *
 * - **No overrides** → every completed phase is `"reused"` (consistency oracle).
 * - **thresholds[phaseId]** → re-compare recorded `gate-score.combined` to the
 *   new threshold; emit `verdict-flipped` / `would-block` / `threshold-changed`.
 * - **budgetMax*** → re-tally recorded usage; phases that would not have run
 *   under a tighter cap → `would-exceed-budget`.
 * - **models / args** → currently `needs-live-rerun` for any phase (cannot
 *   re-judge quality offline without more instrumentation).
 *
 * Never calls a model. Never throws.
 */
export function replayRun(events: readonly Event[], overrides: ReplayOverrides = {}): ReplayReport {
	const baseline = foldEvents(events);
	const totalUsage = sumUsage(baseline);
	const decisions: ReplayDecision[] = [];
	let needsLiveRerun = false;

	const hasModelOverride = overrides.models && Object.keys(overrides.models).length > 0;
	const hasArgsOverride = overrides.args && Object.keys(overrides.args).length > 0;

	// Budget re-check against full-run usage (coarse: if over, every non-failed
	// phase that finished after budget would have been hit is flagged).
	let budgetBlocked = false;
	if (overrides.budgetMaxUSD !== undefined || overrides.budgetMaxTokens !== undefined) {
		const input: BudgetCheckInput = {
			usages: [totalUsage],
			maxUSD: overrides.budgetMaxUSD,
			maxTokens: overrides.budgetMaxTokens,
		};
		const check = overBudget(input);
		budgetBlocked = check.over;
	}

	for (const [phaseId, phase] of Object.entries(baseline.phases)) {
		const prior = phase.status;
		if (prior === "failed") {
			decisions.push({
				phaseId,
				outcome: "failed",
				reason: phase.error ?? "recorded failure",
				priorOutcome: prior,
				replayedOutcome: prior,
			});
			continue;
		}

		if (hasModelOverride && overrides.models?.[phaseId]) {
			needsLiveRerun = true;
			decisions.push({
				phaseId,
				outcome: "needs-live-rerun",
				reason: `model override ${overrides.models[phaseId]} cannot be quality-replayed offline`,
				priorOutcome: prior,
			});
			continue;
		}
		if (hasArgsOverride) {
			// Args may change interpolated task text for any phase — conservative.
			needsLiveRerun = true;
			decisions.push({
				phaseId,
				outcome: "needs-live-rerun",
				reason: "args override may change interpolated task text",
				priorOutcome: prior,
			});
			continue;
		}

		const score = gateScoreDecision(phase.decision);
		const newThreshold = overrides.thresholds?.[phaseId];
		if (score && newThreshold !== undefined) {
			const oldThreshold = score.threshold ?? 0.7;
			const oldVerdict = score.verdict;
			const newVerdict: "pass" | "block" = score.combined >= newThreshold ? "pass" : "block";
			if (oldVerdict !== newVerdict) {
				decisions.push({
					phaseId,
					outcome: newVerdict === "block" ? "would-block" : "verdict-flipped",
					reason: `threshold ${oldThreshold}→${newThreshold}; combined=${score.combined} → ${newVerdict}`,
					priorOutcome: oldVerdict,
					replayedOutcome: newVerdict,
				});
			} else if (oldThreshold !== newThreshold) {
				decisions.push({
					phaseId,
					outcome: "threshold-changed",
					reason: `threshold ${oldThreshold}→${newThreshold}; verdict still ${oldVerdict}`,
					priorOutcome: oldVerdict,
					replayedOutcome: newVerdict,
				});
			} else {
				decisions.push({
					phaseId,
					outcome: "reused",
					reason: "gate-score unchanged under same threshold",
					priorOutcome: prior,
					replayedOutcome: prior,
				});
			}
			continue;
		}

		if (budgetBlocked && (prior === "done" || prior === "running")) {
			decisions.push({
				phaseId,
				outcome: "would-exceed-budget",
				reason: "recorded run usage exceeds replay budget caps",
				priorOutcome: prior,
				replayedOutcome: "skipped",
			});
			continue;
		}

		decisions.push({
			phaseId,
			outcome: "reused",
			reason: "no applicable overrides; recorded outcome kept",
			priorOutcome: prior,
			replayedOutcome: prior,
		});
	}

	// Replayed fold is baseline for now (we don't rewrite events under overrides;
	// decisions carry the counterfactual). Future: emit synthetic decision events.
	return {
		decisions,
		baseline,
		replayed: baseline,
		needsLiveRerun,
		totalUsage,
	};
}

/** @deprecated kept for 0.1.7 callers that checked the sentinel string */
export const REPLAY_NOT_YET_IMPLEMENTED =
	"replayRun() is implemented in 0.2.0; this sentinel remains for back-compat string checks.";
