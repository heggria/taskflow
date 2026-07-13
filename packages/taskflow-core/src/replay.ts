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

interface RunGroup {
	runId: string;
	minStart: number;
	maxEnd: number;
	completeLifecycle: boolean;
	innerFlowMarkers: number;
}

/** Select the outer run from a legacy mixed-run trace without trusting append
 * order. Nested buffers may flush before their parent's phase batch, so the
 * first JSONL record can belong to a child. Prefer a unique temporal envelope,
 * then explicit inner-flow markers and earliest start time. Lifecycle
 * completeness is a validity gate, never evidence that a run is outer: a
 * child can be complete while its parent trace is truncated. If no signal is
 * decisive, return a deterministic candidate with `ambiguous:true`; replay
 * will fail safe to needs-live-rerun. */
function selectOuterRun(events: readonly Event[]): { runId?: string; ambiguous: boolean } {
	const byRun = new Map<string, Event[]>();
	for (const event of events) {
		if (!event.runId) continue;
		byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), event]);
	}
	if (byRun.size === 0) return { ambiguous: false };
	const groups: RunGroup[] = [...byRun].map(([runId, groupEvents]) => {
		const starts = groupEvents.filter((e) => e.kind === "phase-start");
		const ends = groupEvents.filter((e) => e.kind === "phase-end");
		const openStarts = new Map<string, number[]>();
		let lifecycleValid = starts.length > 0;
		for (const event of groupEvents) {
			if (event.kind === "phase-start") {
				openStarts.set(event.phaseId, [...(openStarts.get(event.phaseId) ?? []), event.ts]);
			} else if (event.kind === "phase-end") {
				const queue = openStarts.get(event.phaseId) ?? [];
				const startedAt = queue.shift();
				if (startedAt === undefined || event.ts < startedAt) lifecycleValid = false;
				openStarts.set(event.phaseId, queue);
			}
		}
		if ([...openStarts.values()].some((queue) => queue.length > 0)) lifecycleValid = false;
		return {
			runId,
			minStart: Math.min(...(starts.length ? starts : groupEvents).map((e) => e.ts)),
			maxEnd: Math.max(...(ends.length ? ends : groupEvents).map((e) => e.ts)),
			completeLifecycle: lifecycleValid,
			innerFlowMarkers: groupEvents.filter(
				(e) => e.kind === "decision" && e.decision?.type === "unreplayable" && e.decision.reason === "inner-flow",
			).length,
		};
	});
	const selected = (group: RunGroup): { runId: string; ambiguous: boolean } => ({
		runId: group.runId,
		// A truncated selected run cannot support reuse even when its identity is
		// otherwise obvious: missing phase-end means output/status may be partial.
		ambiguous: !group.completeLifecycle,
	});
	if (groups.length === 1) return selected(groups[0]);
	const envelopes = groups.filter((g) =>
		groups.every((other) => g.minStart <= other.minStart && g.maxEnd >= other.maxEnd),
	);
	if (envelopes.length === 1) return selected(envelopes[0]);
	const markerMax = Math.max(...groups.map((g) => g.innerFlowMarkers));
	if (markerMax > 0) {
		const marked = groups.filter((g) => g.innerFlowMarkers === markerMax);
		if (marked.length === 1) return selected(marked[0]);
	}
	const earliest = Math.min(...groups.map((g) => g.minStart));
	const earliestGroups = groups.filter((g) => g.minStart === earliest);
	if (earliestGroups.length === 1) return selected(earliestGroups[0]);
	return {
		runId: [...groups].sort((a, b) => a.runId.localeCompare(b.runId))[0].runId,
		ambiguous: true,
	};
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
	// A trace file is scoped to one run. Older traces could contain nested-flow
	// events with a different runId; identify the outer run defensively so phase
	// ids/usages from children cannot corrupt the replay snapshot.
	const selectedRun = selectOuterRun(events);
	const rootRunId = selectedRun.runId;
	const rootEvents = rootRunId ? events.filter((e) => e.runId === rootRunId) : [...events];
	const baseline = foldEvents(rootEvents);
	const baselineIncomplete = Object.values(baseline.phases).some(
		(phase) =>
			phase.status === "pending" ||
			phase.status === "running" ||
			(phase.startedAt !== undefined && phase.endedAt !== undefined && phase.endedAt < phase.startedAt),
	);
	const totalUsage = sumUsage(baseline);
	const replayed: FoldedRun = {
		...baseline,
		phases: Object.fromEntries(
			Object.entries(baseline.phases).map(([id, p]) => [
				id,
				{ ...p, usage: { ...p.usage }, decision: p.decision ? { ...p.decision } : undefined },
			]),
		),
	};
	const byDecision = new Map<string, ReplayDecision>();
	let needsLiveRerun = false;

	const hasModelOverride = overrides.models && Object.keys(overrides.models).length > 0;
	const hasArgsOverride = overrides.args && Object.keys(overrides.args).length > 0;
	const hasThresholdOverride = overrides.thresholds !== undefined && Object.keys(overrides.thresholds).length > 0;
	const hasBudgetOverride = overrides.budgetMaxUSD !== undefined || overrides.budgetMaxTokens !== undefined;
	const order: string[] = [];
	const seen = new Set<string>();
	const deps = new Map<string, string[]>();
	const dependencyRecorded = new Set<string>();
	const phaseStart = new Map<string, { ts: number; index: number }>();
	const decisionHistory = new Map<string, EventDecision[]>();
	const unreplayable = new Map<string, string>();
	for (const [eventIndex, e] of rootEvents.entries()) {
		if (!seen.has(e.phaseId)) {
			seen.add(e.phaseId);
			order.push(e.phaseId);
		}
		if (e.kind === "phase-start") {
			if (!phaseStart.has(e.phaseId)) phaseStart.set(e.phaseId, { ts: e.ts, index: eventIndex });
			if (e.dependencies !== undefined) {
				deps.set(e.phaseId, [...e.dependencies]);
				dependencyRecorded.add(e.phaseId);
			}
		}
		if (e.kind === "decision" && e.decision?.type === "unreplayable") {
			unreplayable.set(e.phaseId, e.decision.reason);
		}
		if (e.kind === "decision" && e.decision) {
			decisionHistory.set(e.phaseId, [...(decisionHistory.get(e.phaseId) ?? []), e.decision]);
		}
	}
	for (const id of Object.keys(baseline.phases)) if (!seen.has(id)) order.push(id);
	const lastGateScore = (phaseId: string): Extract<EventDecision, { type: "gate-score" }> | undefined => {
		const history = decisionHistory.get(phaseId) ?? [];
		for (let i = history.length - 1; i >= 0; i--) {
			const decision = history[i];
			if (decision.type === "gate-score") return decision;
		}
		return undefined;
	};

	const children = new Map<string, string[]>();
	for (const [id, parents] of deps) {
		for (const parent of parents) children.set(parent, [...(children.get(parent) ?? []), id]);
	}
	const descendants = (root: string): string[] => {
		const out: string[] = [];
		const queue = [...(children.get(root) ?? [])];
		const visited = new Set<string>();
		while (queue.length) {
			const id = queue.shift()!;
			if (visited.has(id)) continue;
			visited.add(id);
			out.push(id);
			queue.push(...(children.get(id) ?? []));
		}
		return out;
	};
	const graphIds = Object.keys(baseline.phases);
	const graphIdSet = new Set(graphIds);
	const missingDependencyMetadata =
		graphIds.length > 1 && graphIds.some((id) => !dependencyRecorded.has(id));
	let graphTopologyAmbiguous = missingDependencyMetadata;
	const layerMemo = new Map<string, number>();
	const layerOf = (id: string, visiting = new Set<string>()): number | undefined => {
		const memo = layerMemo.get(id);
		if (memo !== undefined) return memo;
		if (!dependencyRecorded.has(id) || visiting.has(id)) {
			graphTopologyAmbiguous = true;
			return undefined;
		}
		const nextVisiting = new Set(visiting).add(id);
		let layer = 0;
		for (const parent of deps.get(id) ?? []) {
			if (!graphIdSet.has(parent)) {
				graphTopologyAmbiguous = true;
				return undefined;
			}
			const parentLayer = layerOf(parent, nextVisiting);
			if (parentLayer === undefined) return undefined;
			layer = Math.max(layer, parentLayer + 1);
		}
		layerMemo.set(id, layer);
		return layer;
	};
	for (const id of graphIds) layerOf(id);
	const blockRoots: string[] = [];
	const unblockRoots: string[] = [];
	const liveRoots: string[] = [];
	const markNeedsLive = (phaseId: string, reason: string, causedBy?: readonly string[]): void => {
		const phase = baseline.phases[phaseId];
		if (!phase) return;
		const current = byDecision.get(phaseId)?.outcome;
		// A phase deterministically prevented from running needs no model call, and
		// a recorded failure remains a recorded failure unless another decision
		// proves it would not have run.
		if (current === "needs-live-rerun" || current === "would-skip" || current === "would-block" || current === "failed") return;
		needsLiveRerun = true;
		byDecision.set(phaseId, {
			phaseId,
			outcome: "needs-live-rerun",
			reason,
			priorOutcome: phase.status,
			replayedOutcome: "pending",
			...(causedBy?.length ? { causedBy } : {}),
		});
		replayed.phases[phaseId]!.status = "pending";
	};
	const forceNeedsLive = (phaseId: string, reason: string): void => {
		const phase = baseline.phases[phaseId];
		if (!phase) return;
		needsLiveRerun = true;
		byDecision.set(phaseId, {
			phaseId,
			outcome: "needs-live-rerun",
			reason,
			priorOutcome: phase.status,
			replayedOutcome: "pending",
		});
		replayed.phases[phaseId]!.status = "pending";
	};
	const markWouldSkip = (phaseId: string, reason: string, causedBy: readonly string[]): void => {
		const phase = baseline.phases[phaseId];
		if (!phase) return;
		byDecision.set(phaseId, {
			phaseId,
			outcome: "would-skip",
			reason,
			priorOutcome: phase.status,
			replayedOutcome: "skipped",
			causedBy,
		});
		replayed.phases[phaseId]!.status = "skipped";
	};

	for (const phaseId of order) {
		const phase = baseline.phases[phaseId];
		if (!phase) continue;
		const prior = phase.status;
		if (prior === "failed") {
			byDecision.set(phaseId, {
				phaseId,
				outcome: "failed",
				reason: phase.error ?? "recorded failure",
				priorOutcome: prior,
				replayedOutcome: prior,
			});
			continue;
		}
		const unrep = unreplayable.get(phaseId);
		if (unrep) {
			needsLiveRerun = true;
			liveRoots.push(phaseId);
			byDecision.set(phaseId, {
				phaseId,
				outcome: "needs-live-rerun",
				reason: `recorded phase is unreplayable offline: ${unrep}`,
				priorOutcome: prior,
				replayedOutcome: "pending",
			});
			replayed.phases[phaseId]!.status = "pending";
			continue;
		}

		if (hasModelOverride && overrides.models?.[phaseId]) {
			needsLiveRerun = true;
			liveRoots.push(phaseId);
			byDecision.set(phaseId, {
				phaseId,
				outcome: "needs-live-rerun",
				reason: `model override ${overrides.models[phaseId]} cannot be quality-replayed offline`,
				priorOutcome: prior,
				replayedOutcome: "pending",
			});
			replayed.phases[phaseId]!.status = "pending";
			continue;
		}
		if (hasArgsOverride) {
			// Args may change interpolated task text for any phase — conservative.
			needsLiveRerun = true;
			liveRoots.push(phaseId);
			byDecision.set(phaseId, {
				phaseId,
				outcome: "needs-live-rerun",
				reason: "args override may change interpolated task text",
				priorOutcome: prior,
				replayedOutcome: "pending",
			});
			replayed.phases[phaseId]!.status = "pending";
			continue;
		}

		// FoldedPhase retains only the last decision. A later budget/cache marker
		// must not erase the recorded gate score needed by threshold replay.
		const score = lastGateScore(phaseId) ?? gateScoreDecision(phase.decision);
		const newThreshold = overrides.thresholds?.[phaseId];
		if (score && newThreshold !== undefined) {
			const oldThreshold = score.threshold ?? 0.7;
			const oldVerdict = score.verdict;
			const newVerdict: "pass" | "block" = score.combined >= newThreshold ? "pass" : "block";
			replayed.phases[phaseId]!.decision = { ...score, threshold: newThreshold, verdict: newVerdict };
			if (oldVerdict !== newVerdict) {
				byDecision.set(phaseId, {
					phaseId,
					outcome: newVerdict === "block" ? "would-block" : "verdict-flipped",
					reason: `threshold ${oldThreshold}→${newThreshold}; combined=${score.combined} → ${newVerdict}`,
					priorOutcome: oldVerdict,
					replayedOutcome: newVerdict,
				});
				replayed.phases[phaseId]!.status = newVerdict === "block" ? "blocked" : "done";
				if (newVerdict === "block") {
					blockRoots.push(phaseId);
				} else if (oldVerdict === "block") {
					// Recorded descendants were skipped and therefore have no output to
					// reuse. A BLOCK→PASS flip opens a previously unexecuted graph branch;
					// every transitive consumer must run live.
					unblockRoots.push(phaseId);
				}
			} else if (oldThreshold !== newThreshold) {
				byDecision.set(phaseId, {
					phaseId,
					outcome: "threshold-changed",
					reason: `threshold ${oldThreshold}→${newThreshold}; verdict still ${oldVerdict}`,
					priorOutcome: oldVerdict,
					replayedOutcome: newVerdict,
				});
			} else {
				byDecision.set(phaseId, {
					phaseId,
					outcome: "reused",
					reason: "gate-score unchanged under same threshold",
					priorOutcome: prior,
					replayedOutcome: prior,
				});
			}
			continue;
		}

		byDecision.set(phaseId, {
			phaseId,
			outcome: "reused",
			reason: "no applicable overrides; recorded outcome kept",
			priorOutcome: prior,
			replayedOutcome: prior,
		});
	}

	// Runtime gate admission is global, not descendant-local. A PASS→BLOCK flip
	// keeps siblings that had already started in the gate's layer, but prevents
	// later admissions in that layer and every subsequent layer — including
	// independent branches. If recorded timing/topology cannot prove admission,
	// fail safe live rather than claiming a skip.
	for (const root of blockRoots) {
		const rootLayer = layerOf(root);
		// Runtime sets gateBlocked only after executePhase returns. phase-end is the
		// recorded scheduler-completion boundary; the earlier gate-score/verdict
		// decision is not an admission cutoff.
		const admissionCutoff = baseline.phases[root]?.endedAt;
		for (const id of graphIds) {
			if (id === root) continue;
			const candidateLayer = layerOf(id);
			if (graphTopologyAmbiguous || rootLayer === undefined || candidateLayer === undefined || admissionCutoff === undefined) {
				markNeedsLive(id, `gate '${root}' would block but recorded admission timing is incomplete`, [root]);
				continue;
			}
			if (candidateLayer > rootLayer) {
				markWouldSkip(id, `gate '${root}' would globally stop subsequent layers`, [root]);
				continue;
			}
			if (candidateLayer === rootLayer) {
				const startedAt = baseline.phases[id]?.startedAt;
				if (startedAt === undefined) {
					markNeedsLive(id, `gate '${root}' would block but sibling admission timing is missing`, [root]);
				} else if (startedAt >= admissionCutoff) {
					// phase-end is the closest legacy trace boundary, but gateBlocked is
					// assigned immediately after executePhase returns. Another worker may
					// claim a same-layer slot in that microtask gap, so a start at or after
					// phase-end is ambiguous without an explicit scheduler-admission event.
					markNeedsLive(id, `gate '${root}' and sibling admission order cannot be proven`, [root]);
				}
			}
		}
	}
	// The inverse gate flip revives every phase the runtime actually labelled as
	// globally gate-blocked, including independent branches. For older traces
	// without the error reason, a skipped graph descendant is the conservative
	// fallback unless another explicit skip decision explains it.
	for (const root of unblockRoots) {
		const revived: string[] = [];
		for (const id of graphIds) {
			if (id === root) continue;
			const phase = baseline.phases[id];
			const recordedGateSkip = phase?.status === "skipped" && /^gate blocked/i.test(phase.error ?? "");
			if (!recordedGateSkip) continue;
			markNeedsLive(id, `gate '${root}' would now pass and make this recorded gate-skip reachable`, [root]);
			revived.push(id);
		}
		for (const revivedRoot of revived) {
			for (const id of descendants(revivedRoot)) {
				markNeedsLive(id, `newly reachable phase '${revivedRoot}' requires a live result`, [revivedRoot]);
			}
		}
	}
	// A live-rerun root makes every transitive consumer non-replayable too: its
	// interpolated input may change even when the consumer itself had no marker.
	for (const root of liveRoots) {
		for (const id of descendants(root)) {
			markNeedsLive(id, `upstream phase '${root}' requires a live rerun`, [root]);
		}
	}

	// Re-tally by recorded DAG layers, not flat append order. Runtime starts a
	// whole dependency layer concurrently; a sibling already started when one
	// completion crosses the cap cannot retrospectively become a budget skip.
	// Within each layer, phase-start time (then append index) gives a stable cause
	// for reporting. Missing/cyclic dependency metadata fails safe to live rerun
	// instead of inventing a sequential schedule.
	if (hasBudgetOverride) {
		const ids = Object.keys(baseline.phases);
		const idSet = new Set(ids);
		let topologyAmbiguous = ids.length > 1 && ids.some((id) => !dependencyRecorded.has(id));
		const indegree = new Map(ids.map((id) => [id, 0]));
		const topoChildren = new Map<string, string[]>();
		for (const id of ids) {
			for (const parent of deps.get(id) ?? []) {
				if (!idSet.has(parent) || parent === id) {
					topologyAmbiguous = true;
					continue;
				}
				indegree.set(id, (indegree.get(id) ?? 0) + 1);
				topoChildren.set(parent, [...(topoChildren.get(parent) ?? []), id]);
			}
		}
		const startCompare = (a: string, b: string): number => {
			const sa = phaseStart.get(a);
			const sb = phaseStart.get(b);
			return (sa?.ts ?? Infinity) - (sb?.ts ?? Infinity) || (sa?.index ?? Infinity) - (sb?.index ?? Infinity) || a.localeCompare(b);
		};
		const layers: string[][] = [];
		let ready = ids.filter((id) => indegree.get(id) === 0).sort(startCompare);
		let visited = 0;
		while (ready.length > 0) {
			const layer = ready;
			layers.push(layer);
			visited += layer.length;
			const next: string[] = [];
			for (const id of layer) {
				for (const child of topoChildren.get(id) ?? []) {
					const n = (indegree.get(child) ?? 0) - 1;
					indegree.set(child, n);
					if (n === 0) next.push(child);
				}
			}
			ready = next.sort(startCompare);
		}
		if (visited !== ids.length) topologyAmbiguous = true;

		if (topologyAmbiguous) {
			for (const id of ids) {
				markNeedsLive(id, "recorded dependency layers are incomplete; budget replay requires a live rerun");
			}
		} else {
			const knownUsage: UsageStats[] = [];
			let budgetCause: string | undefined;
			let uncertainRoots: string[] = [];
			for (const layer of layers) {
				if (budgetCause) {
					for (const id of layer) {
						markWouldSkip(id, `budget was exceeded after '${budgetCause}'`, [budgetCause]);
					}
					continue;
				}
				if (uncertainRoots.length > 0) {
					for (const id of layer) {
						if (replayed.phases[id]?.status !== "skipped") {
							markNeedsLive(id, "earlier live-rerun spend makes the replay budget boundary uncertain", uncertainRoots);
						}
					}
					continue;
				}

				const layerUncertain: string[] = [];
				for (const phaseId of layer) {
					const phase = baseline.phases[phaseId];
					if (!phase || replayed.phases[phaseId]?.status === "skipped") continue;
					if (byDecision.get(phaseId)?.outcome === "needs-live-rerun") {
						layerUncertain.push(phaseId);
						continue;
					}
					knownUsage.push(phase.usage);
					const input: BudgetCheckInput = {
						usages: knownUsage,
						maxUSD: overrides.budgetMaxUSD,
						maxTokens: overrides.budgetMaxTokens,
					};
					if (!budgetCause && overBudget(input).over) {
						budgetCause = phaseId;
						const current = byDecision.get(phaseId)?.outcome;
						if (current !== "would-block" && current !== "failed") {
							byDecision.set(phaseId, {
								phaseId,
								outcome: "would-exceed-budget",
								reason: "this phase's recorded spend crosses the replay budget cap",
								priorOutcome: phase.status,
								replayedOutcome: phase.status,
							});
						}
					}
				}
				// All members of this layer were already admitted, so none is skipped
				// even when one crossed the cap. Unknown model/arg spend only makes
				// subsequent layers uncertain when no known lower bound already crossed.
				if (!budgetCause && layerUncertain.length > 0) uncertainRoots = layerUncertain;
			}
		}
	}
	// A looser replay budget can remove a recorded budget stop. Those skipped
	// phases have no output to reuse: if the new budget analysis did not still
	// deterministically skip them, they (and their consumers) require live work.
	// Apply this after budget composition so it cannot overwrite a valid new
	// would-skip from a tighter cap or an earlier gate.
	if (hasBudgetOverride) {
		const revivedBudgetSkips: string[] = [];
		for (const id of graphIds) {
			const phase = baseline.phases[id];
			const recordedBudgetSkip =
				phase?.status === "skipped" &&
				((decisionHistory.get(id) ?? []).some((decision) => decision.type === "budget-hit") ||
					/budget exceeded/i.test(phase.error ?? ""));
			if (!recordedBudgetSkip || byDecision.get(id)?.outcome === "would-skip") continue;
			markNeedsLive(id, "replay budget makes a recorded budget-skipped phase reachable", [id]);
			if (byDecision.get(id)?.outcome === "needs-live-rerun") revivedBudgetSkips.push(id);
		}
		for (const root of revivedBudgetSkips) {
			for (const id of descendants(root)) {
				markNeedsLive(id, `newly reachable budget-skipped phase '${root}' requires a live result`, [root]);
			}
		}
	}
	// Legacy multi-phase traces omitted phase-start.dependencies. Any local knob
	// whose effect can propagate through the graph is unsafe to localize against
	// an invented empty graph. Preserve a threshold root's directly computable
	// verdict only when it is the sole override; every other potentially related
	// phase (or every phase for model/args/budget combinations) fails safe live.
	const phaseIds = Object.keys(baseline.phases);
	const hasGraphSensitiveOverride = hasThresholdOverride || hasModelOverride || hasArgsOverride || hasBudgetOverride;
	if (missingDependencyMetadata && hasGraphSensitiveOverride) {
		const thresholdRoots = new Set(Object.keys(overrides.thresholds ?? {}));
		const singleThresholdOnly =
			hasThresholdOverride && thresholdRoots.size === 1 && !hasModelOverride && !hasArgsOverride && !hasBudgetOverride;
		for (const id of phaseIds) {
			const directlyReplayableThresholdRoot =
				singleThresholdOnly && thresholdRoots.has(id) && lastGateScore(id) !== undefined;
			if (directlyReplayableThresholdRoot) continue;
			forceNeedsLive(
				id,
				"legacy trace lacks dependency metadata; refusing local override propagation against an empty graph",
			);
		}
	}
	if (selectedRun.ambiguous || baselineIncomplete) {
		needsLiveRerun = true;
		for (const id of order) {
			const phase = baseline.phases[id];
			if (!phase) continue;
			byDecision.set(id, {
				phaseId: id,
				outcome: "needs-live-rerun",
				reason: "mixed trace run identity is ambiguous; refusing offline reuse",
				priorOutcome: phase.status,
				replayedOutcome: "pending",
			});
			replayed.phases[id]!.status = "pending";
		}
	}
	// Derive the flag from the final composed decisions. A model override that is
	// deterministically skipped by an earlier gate/budget no longer requires a
	// live call after precedence has been resolved.
	needsLiveRerun = [...byDecision.values()].some((d) => d.outcome === "needs-live-rerun");

	return {
		decisions: order.flatMap((id) => (byDecision.has(id) ? [byDecision.get(id)!] : [])),
		baseline,
		replayed,
		needsLiveRerun,
		totalUsage,
	};
}

/** @deprecated kept for 0.1.7 callers that checked the sentinel string */
export const REPLAY_NOT_YET_IMPLEMENTED =
	"replayRun() is implemented in 0.2.0; this sentinel remains for back-compat string checks.";
