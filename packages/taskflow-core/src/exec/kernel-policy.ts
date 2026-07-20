/**
 * Feature gates and shared helpers for the S2 event kernel.
 * Keeps the kernel from silently accepting DSL it cannot implement safely.
 */

import type { Budget, Phase, Taskflow } from "../schema.ts";
import { dependenciesOf } from "../schema.ts";
import { emptyUsage, type UsageStats } from "../usage.ts";
import type { RunState } from "../store.ts";
import { overBudget } from "../deterministic.ts";

/** Linear-time placeholder detection for untrusted DSL strings.
 *
 * A placeholder body is a non-empty Taskflow-style path made only of the
 * identifier/path characters accepted by interpolation. Resetting on a nested
 * opening brace keeps the scan O(n), even for adversarial strings containing
 * thousands of `{` characters. JSON object braces are ignored because their
 * bodies contain quotes, colons, commas, or whitespace. */
export function containsInterpolationPlaceholder(value: string): boolean {
	let open = false;
	let valid = false;
	let length = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === 123) { // {
			open = true;
			valid = true;
			length = 0;
			continue;
		}
		if (!open) continue;
		if (code === 125) { // }
			if (valid && length > 0) return true;
			open = false;
			continue;
		}
		length++;
		const allowed =
			(code >= 48 && code <= 57) || // 0-9
			(code >= 65 && code <= 90) || // A-Z
			(code >= 97 && code <= 122) || // a-z
			code === 45 || code === 46 || code === 95; // - . _
		if (!allowed) valid = false;
	}
	return false;
}

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
		// Tree reduction (`reduceStrategy: "tree"`) runs batched intermediate reducer
		// calls with full retry/timeout/budget/prompt-stats wiring. Rather than
		// duplicate that complex multi-round logic on the kernel path, force the
		// imperative runtime (which owns it). One-shot reduce stays on the kernel.
		if ((p.type ?? "agent") === "reduce" && (p as { reduceStrategy?: string }).reduceStrategy === "tree") {
			return `phase '${id}': reduceStrategy 'tree' requires the imperative runtime`;
		}
		// Explicit multi-attempt retry: now supported on the kernel path (0.2.4).
		// The retry curve is handled in step-kinds.ts runAgentCall.

		// expect contracts: now supported on the kernel path (0.2.4).
		// Contract checks run after the agent call in step-kinds.ts.
		if (p.cache && typeof p.cache === "object") {
			const scope = (p.cache as { scope?: string }).scope;
			if (scope === "cross-run") {
				return `phase '${id}': cross-run cache requires the imperative runtime`;
			}
		}
		if (p.shareContext === true || def.contextSharing === true) {
			return `phase '${id}': Shared Context Tree requires the imperative runtime`;
		}
		// Context pre-read: now supported on the kernel path (0.2.4).
		// step-kinds.ts reads context files and prepends them to the prompt.
		// Per-phase cwd: literal string cwd is now supported on the kernel path
		// (0.2.4). Interpolation placeholder cwds ({args.*}, {steps.*}) and
		// workspace keywords (temp/dedicated/worktree) remain imperative-only.
		const cwd = p.cwd;
		if (typeof cwd === "string" && (containsInterpolationPlaceholder(cwd) || /^(temp|dedicated|worktree)$/.test(cwd))) {
			return `phase '${id}': workspace cwd '${cwd}' requires the imperative runtime`;
		}
		// Per-branch cwd remains imperative-only (the kernel has no branch-level
		// cwd resolution for parallel/tournament/race branches).
		if (Array.isArray(p.branches) && p.branches.some((branch) => typeof branch.cwd === "string")) {
			return `phase '${id}': per-branch cwd requires the imperative runtime`;
		}

		// Script stdin input and interpolated script argv remain imperative-only
		// (they require the full interpolation + spawn pipeline).
		if ((p.type ?? "agent") === "script" && p.input !== undefined) {
			return `phase '${id}': script stdin input requires the imperative runtime`;
		}
		if ((p.type ?? "agent") === "script" && Array.isArray(p.run) && p.run.some(containsInterpolationPlaceholder)) {
			return `phase '${id}': interpolated script argv requires the imperative runtime`;
		}
	}
	// Concurrent DAG layers are now supported (0.2.4): the driver executes
	// phases within a layer concurrently via Promise.all and commits atomically
	// at layer boundaries. Gate/budget decisions are checked between layers.

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
