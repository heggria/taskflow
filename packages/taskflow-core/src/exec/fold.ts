/**
 * fold(event log) → RunState-shaped phase snapshot (RFC §6.4, S1).
 *
 * Pure reduce over {@link Event} / legacy TraceEvent-compatible records.
 * Does **not** spawn processes or touch disk. Used by:
 *  - S1 differential: assert fold(log) matches phase statuses the imperative
 *    runtime would have left in RunState
 *  - S3 replay: re-fold under alternate knobs (thresholds/budget) without
 *    re-entering the driver
 *
 * Never throws.
 */

import type { Event, EventDecision } from "./events.ts";
import type { UsageStats } from "../usage.ts";
import { emptyUsage } from "../usage.ts";

/** Per-phase folded snapshot (subset of PhaseState the runtime persists). */
export interface FoldedPhase {
	phaseId: string;
	status: "pending" | "running" | "done" | "failed" | "blocked" | "skipped" | "timedOut";
	/** Last recorded text output (subagent or decision summary). */
	output?: string;
	error?: string;
	/** Accumulated usage from subagent-call events. */
	usage: UsageStats;
	/** Last decision event for this phase (gate / when / cache / …). */
	decision?: EventDecision;
	/** Number of subagent-call events seen. */
	subagentCalls: number;
	startedAt?: number;
	endedAt?: number;
}

/** Whole-run fold result. */
export interface FoldedRun {
	runId: string;
	phases: Record<string, FoldedPhase>;
	/** Events that could not be associated with a phaseId (malformed). */
	orphans: number;
	/** Total events folded. */
	eventCount: number;
}

function emptyPhase(phaseId: string): FoldedPhase {
	return {
		phaseId,
		status: "pending",
		usage: emptyUsage(),
		subagentCalls: 0,
	};
}

function ensurePhase(map: Record<string, FoldedPhase>, phaseId: string): FoldedPhase {
	if (!map[phaseId]) map[phaseId] = emptyPhase(phaseId);
	return map[phaseId];
}

function addUsage(a: UsageStats, b: UsageStats | undefined): void {
	if (!b) return;
	a.input += b.input ?? 0;
	a.output += b.output ?? 0;
	a.cacheRead += b.cacheRead ?? 0;
	a.cacheWrite += b.cacheWrite ?? 0;
	a.cost += b.cost ?? 0;
	a.turns += b.turns ?? 0;
	if (typeof b.contextTokens === "number") a.contextTokens = b.contextTokens;
}

/**
 * Reduce an ordered event list into a per-phase snapshot.
 * Accepts {@link Event} (with `v`) or plain TraceEvent-shaped records.
 */
export function foldEvents(events: readonly Event[]): FoldedRun {
	const phases: Record<string, FoldedPhase> = {};
	let runId = "";
	let orphans = 0;

	for (const ev of events) {
		if (!ev || typeof ev !== "object") {
			orphans++;
			continue;
		}
		if (typeof ev.runId === "string" && ev.runId) runId = ev.runId;
		const phaseId = typeof ev.phaseId === "string" ? ev.phaseId : "";
		if (!phaseId) {
			orphans++;
			continue;
		}
		const p = ensurePhase(phases, phaseId);
		const kind = ev.kind;

		if (kind === "phase-start") {
			p.status = "running";
			if (typeof ev.ts === "number") p.startedAt = ev.ts;
		} else if (kind === "phase-end") {
			if (ev.status && ev.status !== "pending" && ev.status !== "running") {
				p.status = ev.status;
			} else if (p.status === "running" || p.status === "pending") {
				p.status = "done";
			}
			if (typeof ev.error === "string") p.error = ev.error;
			if (typeof ev.ts === "number") p.endedAt = ev.ts;
			// phase-end may carry decision / output on some hosts
			if (ev.decision) p.decision = ev.decision;
			if (ev.output?.text) p.output = ev.output.text;
			if (ev.output?.usage) addUsage(p.usage, ev.output.usage);
		} else if (kind === "subagent-call") {
			p.subagentCalls++;
			if (p.status === "pending") p.status = "running";
			if (ev.output?.text) p.output = ev.output.text;
			if (ev.output?.usage) addUsage(p.usage, ev.output.usage);
			if (typeof ev.ts === "number" && p.startedAt === undefined) p.startedAt = ev.ts;
		} else if (kind === "decision") {
			if (ev.decision) {
				p.decision = ev.decision;
				if (ev.decision.type === "gate-verdict" || ev.decision.type === "gate-score") {
					const v =
						ev.decision.type === "gate-verdict"
							? ev.decision.value
							: ev.decision.verdict;
					if (v === "block") p.status = "blocked";
				}
				if (ev.decision.type === "when-guard" && ev.decision.result === false) {
					p.status = "skipped";
				}
				if (ev.decision.type === "budget-hit") {
					// A budget decision can be emitted either on the phase whose
					// completion crossed the cap (already terminal: keep it done) or
					// on a later phase that was prevented from running.
					if (p.status === "pending" || p.status === "running") p.status = "skipped";
					p.error = ev.decision.reason ?? ev.decision.value;
				}
			}
		}
	}

	return { runId, phases, orphans, eventCount: events.length };
}
