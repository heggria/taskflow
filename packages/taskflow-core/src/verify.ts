/**
 * Static DAG verification — zero-token structural analysis.
 *
 * Runs *before* any agent is spawned. Catches dead-end phases, unreachable
 * paths, gate exhaustion, budget overflow, and reference integrity issues
 * purely through graph algorithms on the DAG — no LLM required.
 */

import type { Phase } from "./schema.ts";
import { asArray, dependenciesOf, LOOP_DEFAULT_MAX_ITERATIONS } from "./schema.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IssueCategory =
	| "dead-end"
	| "unreachable"
	| "gate-exhaustion"
	| "budget-overflow"
	| "concurrency"
	| "ref-integrity"
	| "guard-contradiction";

export interface VerificationIssue {
	/** Affected phase id, if applicable. */
	phaseId?: string;
	message: string;
	severity: "error" | "warning";
	category: IssueCategory;
}

export interface VerificationResult {
	ok: boolean;
	issues: VerificationIssue[];
}

/** A lightweight Taskflow shape for verification (accepts parsed Phase[] + name). */
export interface VerifiableFlow {
	name: string;
	phases: Phase[];
	budget?: { maxUSD?: number; maxTokens?: number };
	concurrency?: number;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

function successors(phases: Phase[]): Map<string, string[]> {
	const m = new Map<string, string[]>();
	for (const p of phases) m.set(p.id, []);
	for (const p of phases) {
		// dependenciesOf = dependsOn ∪ from, matching runtime + topo-sort. A reduce
		// phase's `from` edges are real edges, so an upstream phase feeding only a
		// reduce is NOT terminal.
		for (const d of dependenciesOf(p)) {
			const s = m.get(d);
			if (s) s.push(p.id);
		}
	}
	return m;
}

function descendants(phaseId: string, succ: Map<string, string[]>): Set<string> {
	const visited = new Set<string>();
	const queue = [phaseId];
	while (queue.length) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		for (const s of succ.get(id) ?? []) queue.push(s);
	}
	return visited;
}

/** Phases with NO `dependsOn` — the DAG entry points. */
function entryPhases(phases: Phase[]): Phase[] {
	return phases.filter((p) => dependenciesOf(p).length === 0);
}

/** Phases with NO dependents (no one waits for them). */
function terminalPhases(phases: Phase[], succ: Map<string, string[]>): string[] {
	const hasDependents = new Set<string>();
	for (const p of phases) {
		for (const d of dependenciesOf(p)) hasDependents.add(d);
	}
	return phases.filter((p) => !hasDependents.has(p.id)).map((p) => p.id);
}

// ---------------------------------------------------------------------------
// Analyzers
// ---------------------------------------------------------------------------

/** #1 Dead-end: a phase with no dependents that is neither `final` nor the last phase. */
function detectDeadEnds(phases: Phase[], succ: Map<string, string[]>): VerificationIssue[] {
	const issues: VerificationIssue[] = [];
	const terminal = new Set(terminalPhases(phases, succ));
	const hasFinal = phases.some((p) => p.final);
	const lastId = phases[phases.length - 1]?.id;

	for (const p of phases) {
		if (!terminal.has(p.id)) continue;
		if (p.final) continue;
		if (!hasFinal && p.id === lastId) continue;

		issues.push({
			phaseId: p.id,
			message:
				`Phase '${p.id}' is a terminal phase (no dependents) but not marked as 'final'. ` +
				`Its output will be discarded. Add "final": true or a downstream phase that depends on it.`,
			severity: "warning",
			category: "dead-end",
		});
	}
	return issues;
}

/** #2 Unreachable: phases not in the largest connected component. */
function detectUnreachable(phases: Phase[], succ: Map<string, string[]>): VerificationIssue[] {
	const issues: VerificationIssue[] = [];

	// Build undirected adjacency (dependency edges are bidirectional for
	// connectivity analysis). dependenciesOf = dependsOn ∪ from, so a reduce's
	// `from`-only upstream stays connected and isn't falsely unreachable.
	const adj = new Map<string, Set<string>>();
	for (const p of phases) adj.set(p.id, new Set());
	for (const p of phases) {
		for (const d of dependenciesOf(p)) {
			if (!adj.has(d)) continue; // ref to non-existent phase (schema catches)
			adj.get(p.id)!.add(d);
			adj.get(d)!.add(p.id);
		}
	}

	// Find connected components via BFS.
	const visited = new Set<string>();
	const components: Set<string>[] = [];
	for (const p of phases) {
		if (visited.has(p.id)) continue;
		const comp = new Set<string>();
		const queue = [p.id];
		while (queue.length) {
			const id = queue.shift()!;
			if (visited.has(id)) continue;
			visited.add(id);
			comp.add(id);
			for (const nb of adj.get(id) ?? []) {
				if (!visited.has(nb)) queue.push(nb);
			}
		}
		components.push(comp);
	}

	if (components.length <= 1) return issues;

	// The largest component is the main DAG; flag the rest — but only if they
	// have edges (dependsOn or successors). A standalone phase with no edges is
	// a valid independent entry, not unreachable.
	const succMap2 = successors(phases);
	const largest = components.reduce((a, b) => (a.size >= b.size ? a : b));
	for (const comp of components) {
		if (comp === largest) continue;
		for (const id of comp) {
			const p = phases.find((ph) => ph.id === id);
			const hasEdges = (p && (p.dependsOn?.length || 0) > 0) || (succMap2.get(id)?.length || 0) > 0;
			if (!hasEdges) continue; // standalone entry — valid
			issues.push({
				phaseId: id,
				message:
					`Phase '${id}' is disconnected from the main DAG. ` +
					`Add a 'dependsOn' edge to connect it, or remove it.`,
				severity: "error",
				category: "unreachable",
			});
		}
	}
	return issues;
}

/** True if there exists a path from `src` to `dst` that does NOT pass through `avoidId`. */
function hasBypassPath(
	src: string,
	dst: string,
	avoidId: string,
	succ: Map<string, string[]>,
	visited: Set<string>,
): boolean {
	if (src === dst) return true;
	if (visited.has(src)) return false;
	visited.add(src);
	for (const s of succ.get(src) ?? []) {
		if (s === avoidId) continue;
		if (hasBypassPath(s, dst, avoidId, succ, visited)) return true;
	}
	return false;
}

/** #3 Gate exhaustion: detect gates that are the sole path to a final phase. */
function detectGateExhaustion(phases: Phase[], succ: Map<string, string[]>): VerificationIssue[] {
	const issues: VerificationIssue[] = [];
	const gates = phases.filter((p) => p.type === "gate" || p.type === "approval");
	const fp = phases.filter((p) => p.final);

	for (const g of gates) {
		const desc = descendants(g.id, succ);
		const finalsDownstream = fp.filter((p) => desc.has(p.id));
		if (finalsDownstream.length === 0) continue;

		// Check: is there at least ONE path from an entry to each final
		// that BYPASSES this gate?
		let allBypassable = true;
		for (const f of finalsDownstream) {
			const bypassable = entryPhases(phases).some((entry) => {
				const entryDesc = descendants(entry.id, succ);
				if (!entryDesc.has(f.id)) return false;
				return hasBypassPath(entry.id, f.id, g.id, succ, new Set());
			});
			if (!bypassable) {
				allBypassable = false;
				break;
			}
		}

		if (!allBypassable) {
			issues.push({
				phaseId: g.id,
				message:
					`Gate '${g.id}' is the sole path to final phase(s) ` +
					`${finalsDownstream.map((p) => "'" + p.id + "'").join(", ")}. ` +
					`A block here halts the entire flow with no alternative route. ` +
					`Consider adding a bypass or marking the flow's structure as intentional.`,
				severity: "warning",
				category: "gate-exhaustion",
			});
		}
	}
	return issues;
}

/** #4 Budget overflow: minimum possible cost exceeds budget. */
function detectBudgetOverflow(flow: VerifiableFlow): VerificationIssue[] {
	const issues: VerificationIssue[] = [];
	const budget = flow.budget;
	if (!budget) return issues;

	let minTokens = 0;
	for (const p of flow.phases) {
		if (p.type === "loop") {
			const iters = p.maxIterations ?? LOOP_DEFAULT_MAX_ITERATIONS;
			minTokens += Math.min(iters, 10);
		} else if (p.type === "tournament") {
			const variants = p.variants ?? 3;
			minTokens += Math.min(variants + 1, 10);
		} else {
			minTokens += 1;
		}
	}

	const ESTIMATED_COST_PER_PHASE = 0.001; // $0.001 minimum per subagent call
	if (budget.maxTokens !== undefined && budget.maxTokens > 0 && minTokens > budget.maxTokens) {
		issues.push({
			message:
				`Budget cap (${budget.maxTokens} tokens) is below the estimated minimum of ~${minTokens} tokens ` +
				`for ${flow.phases.length} phase(s). The flow will likely be truncated before completion. ` +
				`Increase maxTokens or reduce the number of phases.`,
			severity: "warning",
			category: "budget-overflow",
		});
	}
	if (budget.maxUSD !== undefined && budget.maxUSD > 0 && minTokens * ESTIMATED_COST_PER_PHASE > budget.maxUSD) {
		issues.push({
			message:
				`Budget cap ($${budget.maxUSD}) is below the estimated minimum of ~$${(minTokens * ESTIMATED_COST_PER_PHASE).toFixed(3)} ` +
				`for ${flow.phases.length} phase(s). The flow will likely be truncated before completion. ` +
				`Increase maxUSD or reduce the number of phases.`,
			severity: "warning",
			category: "budget-overflow",
		});
	}

	return issues;
}

/** #5 Concurrency warnings. */
function detectConcurrencyWarnings(flow: VerifiableFlow, _succ: Map<string, string[]>): VerificationIssue[] {
	const issues: VerificationIssue[] = [];

	for (const p of flow.phases) {
		if (p.type === "parallel" && p.branches && p.branches.length > (flow.concurrency ?? 8)) {
			if (!p.concurrency) {
				issues.push({
					phaseId: p.id,
					message:
						`Parallel phase '${p.id}' has ${p.branches.length} branches but the flow concurrency ` +
						`is ${flow.concurrency ?? 8}. Consider adding a per-phase 'concurrency' cap.`,
					severity: "warning",
					category: "concurrency",
				});
			}
		}
	}

	// Self-dependency
	for (const p of flow.phases) {
		if (asArray<string>(p.dependsOn).includes(p.id)) {
			issues.push({
				phaseId: p.id,
				message: `Phase '${p.id}' depends on itself — remove self-reference from 'dependsOn'.`,
				severity: "error",
				category: "ref-integrity",
			});
		}
	}

	return issues;
}

/** #6 Guard contradictions (simple static analysis of `when` conditions). */
function detectGuardContradictions(phases: Phase[]): VerificationIssue[] {
	const issues: VerificationIssue[] = [];

	const groups = new Map<string, Phase[]>();
	for (const p of phases) {
		if (!p.when) continue;
		const key = asArray<string>(p.dependsOn).slice().sort().join(",");
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(p);
	}

	for (const [, group] of groups) {
		if (group.length < 2) continue;
		// Extract the ref keys from when conditions (to check same reference)
		const refs = group.map((p) => {
			const m = p.when!.match(/\{([^}]+)\}/g);
			return m ? m.join(",") : "";
		});
		const uniqueRefs = new Set(refs.filter((r) => r.length > 0));
		if (uniqueRefs.size === 1 && refs.every((r) => r.length > 0)) {
			// Check the ORIGINAL when strings for opposing operators
			const hasEq = group.some((p) => p.when!.includes("=="));
			const hasNeq = group.some((p) => p.when!.includes("!="));
			if (hasEq && hasNeq) {
				issues.push({
					message:
						`Phases ${group.map((p) => `'${p.id}'`).join(", ")} have ` +
						`the same dependency set and opposing 'when' conditions. ` +
						`One branch will always be skipped. Verify this is intentional.`,
					severity: "warning",
					category: "guard-contradiction",
				});
			}
		}
	}
	return issues;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run all static verification passes against a parsed taskflow.
 *
 * Returns issues found; `ok === true` means no errors (warnings are ok).
 * This is a pure function — no I/O, no LLM, zero tokens.
 */
export function verifyTaskflow(flow: VerifiableFlow): VerificationResult {
	const phases = flow.phases;
	const succ = successors(phases);
	const issues: VerificationIssue[] = [];

	issues.push(...detectDeadEnds(phases, succ));
	issues.push(...detectUnreachable(phases, succ));
	issues.push(...detectGateExhaustion(phases, succ));
	issues.push(...detectBudgetOverflow(flow));
	issues.push(...detectConcurrencyWarnings(flow, succ));
	issues.push(...detectGuardContradictions(phases));

	const ok = !issues.some((i) => i.severity === "error");
	return { ok, issues };
}
