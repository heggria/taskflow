/**
 * Feature gates and shared helpers for the S2 event kernel.
 * Keeps the kernel from silently accepting DSL it cannot implement safely.
 */

import type { Budget, Phase, Taskflow } from "../schema.ts";
import { dependenciesOf } from "../schema.ts";

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
		// Workspace isolation keywords are imperative-only today.
		const cwd = p.cwd;
		if (typeof cwd === "string" && (cwd === "temp" || cwd === "dedicated" || cwd === "worktree")) {
			return `phase '${id}': workspace cwd '${cwd}' requires the imperative runtime`;
		}
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

/** Clamp child sub-flow budget so it cannot raise the parent cap. */
export function clampSubFlowBudget(sub: Taskflow, parentBudget: Budget | undefined): Taskflow {
	if (!parentBudget) return sub;
	const child = sub.budget;
	const clamped: Budget = {
		maxUSD: Math.min(child?.maxUSD ?? Infinity, parentBudget.maxUSD ?? Infinity),
		maxTokens: Math.min(child?.maxTokens ?? Infinity, parentBudget.maxTokens ?? Infinity),
	};
	const budget: Budget = {};
	if (Number.isFinite(clamped.maxUSD)) budget.maxUSD = clamped.maxUSD;
	if (Number.isFinite(clamped.maxTokens)) budget.maxTokens = clamped.maxTokens;
	return {
		...sub,
		budget: budget.maxUSD === undefined && budget.maxTokens === undefined ? undefined : budget,
	};
}
