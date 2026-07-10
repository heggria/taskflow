/**
 * Feature gates and shared helpers for the S2 event kernel.
 * Keeps the kernel from silently accepting DSL it cannot implement safely.
 */

import type { Budget, Phase, Taskflow } from "../schema.ts";
import { dependenciesOf, topoLayers } from "../schema.ts";
import { emptyUsage, type UsageStats } from "../usage.ts";
import type { RunState } from "../store.ts";
import { overBudget } from "../deterministic.ts";

/**
 * If the definition needs imperative-only features, return a short reason.
 * When set, executeTaskflow must NOT enter the event kernel (even if enabled).
 */
export function kernelUnsupportedReason(def: Taskflow): string | undefined {
	// Flow-level: incremental default cross-run is not implemented on the kernel path.
	if ((def as { incremental?: boolean }).incremental === true) {
		return `flow incremental:true requires the imperative runtime`;
	}
	for (const p of def.phases ?? []) {
		const id = p.id;
		if (p.type === "gate" && (p as { score?: unknown }).score !== undefined) {
			return `phase '${id}': score gates require the imperative runtime`;
		}
		if (p.onBlock === "retry") {
			return `phase '${id}': onBlock:retry requires the imperative runtime`;
		}
		if (p.reflexion === true) {
			return `phase '${id}': reflexion loops require the imperative runtime`;
		}
		// Explicit multi-attempt retry / expect contracts: kernel lacks full policy yet.
		if (p.retry && typeof p.retry === "object" && (p.retry.max ?? 0) > 0) {
			return `phase '${id}': retry requires the imperative runtime`;
		}
		if (p.expect !== undefined) {
			return `phase '${id}': expect contracts require the imperative runtime`;
		}
		if (p.cache && typeof p.cache === "object") {
			const scope = (p.cache as { scope?: string }).scope;
			if (scope === "cross-run") {
				return `phase '${id}': cross-run cache requires the imperative runtime`;
			}
		}
		if (p.shareContext === true || def.contextSharing === true) {
			return `phase '${id}': Shared Context Tree requires the imperative runtime`;
		}
		if (p.context && p.context.length > 0) {
			return `phase '${id}': context pre-read requires the imperative runtime`;
		}
		// Every phase-local cwd (literal or isolated keyword) is imperative-only.
		// The kernel currently has only one flow-level cwd; accepting a literal
		// override would silently run in the wrong workspace.
		const cwd = p.cwd;
		if (typeof cwd === "string") {
			return `phase '${id}': workspace cwd '${cwd}' requires the imperative runtime`;
		}
		if ((p.type ?? "agent") === "script" && p.input !== undefined) {
			return `phase '${id}': script stdin input requires the imperative runtime`;
		}
		if ((p.type ?? "agent") === "script" && Array.isArray(p.run) && p.run.some((arg) => /\{[^}]+\}/.test(arg))) {
			return `phase '${id}': interpolated script argv requires the imperative runtime`;
		}
	}
	// The imperative scheduler runs independent phases concurrently. Until the
	// event driver has an atomic layer commit, admit only linear layers; this
	// prevents a completed gate/budget decision from incorrectly skipping an
	// independent sibling that should already have been in flight.
	const layers = topoLayers(def.phases ?? []);
	if (layers.some((layer) => layer.length > 1)) {
		return "concurrent DAG layers require the imperative runtime";
	}
	// A fan-out budget guard must stop spawning items as spend accumulates. The
	// kernel aggregates only after the whole node today, so budgeted fan-out is
	// deliberately routed to the imperative implementation.
	if (def.budget && (def.phases ?? []).some((p) => p.type === "map" || p.type === "parallel")) {
		return "budgeted fan-out requires the imperative runtime";
	}
	// Loop/tournament perform multiple logical calls inside one uncommitted phase.
	// Until their handlers expose phase-local cumulative usage to every call,
	// route budgeted variants to the imperative scheduler. Single-call advanced
	// kinds (gate/reduce) use kernelAttemptsOverBudget between retries.
	if (def.budget && (def.phases ?? []).some((p) => p.type === "loop" || p.type === "tournament")) {
		return "budgeted multi-call advanced phases require the imperative runtime";
	}
	return undefined;
}

/** Dependency satisfaction matching imperative runtime (join + optional). */
export function depsSatisfied(
	phase: Phase,
	phases: Record<string, { status: string } | undefined>,
	byId: Map<string, Phase>,
): { ok: boolean; skipReason?: string } {
	const deps = dependenciesOf(phase);
	const join = phase.join ?? "all";
	const depOk = (d: string): boolean => {
		const s = phases[d]?.status;
		if (s === "done") return true;
		if (s === "failed" && byId.get(d)?.optional) return true;
		return false;
	};
	if (deps.length === 0) return { ok: true };
	const ok = join === "any" ? deps.some(depOk) : deps.every(depOk);
	if (ok) return { ok: true };
	return {
		ok: false,
		skipReason: join === "any" ? "All dependencies failed or were skipped" : "Upstream dependency not satisfied",
	};
}

/** Clamp child budget to the parent's remaining run-wide allowance. */
export function clampSubFlowBudget(
	sub: Taskflow,
	parentBudget: Budget | undefined,
	spent: UsageStats = emptyUsage(),
): Taskflow {
	if (!parentBudget) return sub;
	const child = sub.budget;
	const remainingUSD =
		parentBudget.maxUSD === undefined ? Infinity : Math.max(0, parentBudget.maxUSD - spent.cost);
	const spentTokens = spent.input + spent.output;
	const remainingTokens =
		parentBudget.maxTokens === undefined ? Infinity : Math.max(0, parentBudget.maxTokens - spentTokens);
	const clamped: Budget = {
		maxUSD: Math.min(child?.maxUSD ?? Infinity, remainingUSD),
		maxTokens: Math.min(child?.maxTokens ?? Infinity, remainingTokens),
	};
	const budget: Budget = {};
	if (Number.isFinite(clamped.maxUSD)) budget.maxUSD = clamped.maxUSD;
	if (Number.isFinite(clamped.maxTokens)) budget.maxTokens = clamped.maxTokens;
	return {
		...sub,
		budget: budget.maxUSD === undefined && budget.maxTokens === undefined ? undefined : budget,
	};
}

/** Check a kernel phase's in-flight retry attempts against the run-wide cap.
 * The driver has not folded the current phase into state yet, so callers must
 * supply the cumulative usage of attempts made so far. Prior completed phase
 * usage comes from state; the current running placeholder is excluded. */
export function kernelAttemptsOverBudget(
	state: RunState,
	phaseId: string,
	attemptUsage: readonly UsageStats[],
): boolean {
	const budget = state.def.budget;
	if (!budget) return false;
	return overBudget({
		maxUSD: budget.maxUSD,
		maxTokens: budget.maxTokens,
		usages: [
			...Object.entries(state.phases)
				.filter(([id]) => id !== phaseId)
				.map(([, phase]) => phase.usage ?? emptyUsage()),
			...attemptUsage,
		],
	}).over;
}
