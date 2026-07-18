/**
 * Static DAG verification — zero-token structural analysis.
 *
 * Runs *before* any agent is spawned. Catches dead-end phases, unreachable
 * paths, gate exhaustion, budget overflow, and reference integrity issues
 * purely through graph algorithms on the DAG — no LLM required.
 *
 * Caller-supplied `TaskflowVerifier`s may also run, after the built-in
 * detectors; they are pure by contract (no I/O, no LLM) — see TaskflowVerifier.
 */

import type { Phase } from "./schema.ts";
import { asArray, dependenciesOf, LOOP_DEFAULT_MAX_ITERATIONS } from "./schema.ts";
import { type OutputContract } from "./contract.ts";

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
	| "guard-contradiction"
	| "contract"
	| "plugin";

export interface VerificationIssue {
	/** Affected phase id, if applicable. */
	phaseId?: string;
	message: string;
	severity: "error" | "warning";
	category: IssueCategory;
	/** Name of the verifier that produced this issue. Undefined for the built-in
	 *  structural detectors; set to the verifier's `name` on every issue emitted
	 *  by a caller-supplied verifier (category "plugin"). */
	source?: string;
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

/** A single finding from a caller-supplied verifier. The engine stamps
 *  `category: "plugin"` and `source: <verifier.name>`; a verifier only supplies
 *  what it actually knows — where, what, and how bad. */
export interface VerifierIssue {
	/** Affected phase id, if applicable. */
	phaseId?: string;
	message: string;
	severity: "error" | "warning";
}

/** A caller-supplied, zero-token static check plugged into `verifyTaskflow`.
 *
 * A verifier runs AFTER the built-in structural detectors, against the SAME
 * sanitized flow, and its issues merge into the single `VerificationResult`.
 * A verifier MUST be a pure function — no I/O, no LLM, zero tokens — matching
 * this module's "no I/O" contract. A throwing or malformed verifier is
 * fail-closed: normalized into a single `error`/`plugin` issue naming the
 * verifier, and the remaining verifiers still run. */
export interface TaskflowVerifier {
	/** Stable, human-readable name. Attributes every issue the verifier emits
	 *  (VerificationIssue.source) and appears in the fail-closed error message. */
	name: string;
	/** Inspect the sanitized flow and return zero or more findings. Should not
	 *  throw on well-formed input — if it cannot decide, return no issue. */
	verify: (flow: VerifiableFlow) => VerifierIssue[];
}

/** Options for {@link verifyTaskflow}. */
export interface VerifyOptions {
	/** Caller-supplied verifiers. Run after the built-in detectors, in array
	 *  order, against the same sanitized flow; built-in issues always come first. */
	verifiers?: TaskflowVerifier[];
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
		if (typeof p.when !== "string" || !p.when) continue;
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
/** #7 Contract refs: a `{steps.X.json.field}` ref whose target phase X declares
 *  an `expect` object contract that provably lacks `field`. Only the first path
 *  segment is checked, and only against object contracts with `properties` —
 *  a contract without `properties` (or a non-object contract) claims nothing
 *  about keys, so no issue is raised (no false positives). */
function detectContractRefMismatches(phases: Phase[]): VerificationIssue[] {
	const issues: VerificationIssue[] = [];
	const contracts = new Map<string, OutputContract>();
	for (const p of phases) {
		const c = (p as { expect?: unknown }).expect;
		if (c && typeof c === "object" && !Array.isArray(c)) contracts.set(p.id, c as OutputContract);
	}
	if (contracts.size === 0) return issues;

	const REF = /\{steps\.([a-zA-Z0-9_-]+)\.json\.([a-zA-Z0-9_-]+)/g;
	for (const p of phases) {
		const withValues = p.with && typeof p.with === "object" ? Object.values(p.with).filter((v): v is string => typeof v === "string") : [];
		const sources: Array<string | undefined> = [
			p.task,
			p.when,
			p.until,
			p.over,
			p.input,
			p.judge,
			...asArray<string>(p.eval as string[] | undefined),
			...asArray<string>(p.context as string[] | undefined),
			...withValues,
			...(Array.isArray(p.run) ? p.run : []),
			...(Array.isArray(p.branches) ? p.branches.map((b) => b?.task) : []),
		];
		for (const src of sources) {
			if (typeof src !== "string") continue;
			for (const m of src.matchAll(REF)) {
				const [, target, field] = m;
				const c = contracts.get(target);
				if (!c) continue;
				const isObj = c.type === "object" || (c.type === undefined && c.properties !== undefined);
				if (!isObj || !c.properties || typeof c.properties !== "object") continue;
				if (!(field in c.properties)) {
					issues.push({
						phaseId: p.id,
						message:
							`Phase '${p.id}' references {steps.${target}.json.${field}} but '${target}' declares an ` +
							`output contract without a '${field}' property. The ref will resolve empty at runtime. ` +
							`Add '${field}' to the contract's properties or fix the ref.`,
						severity: "warning",
						category: "contract",
					});
				}
			}
		}
	}
	return issues;
}

// ---------------------------------------------------------------------------

/**
 * Run all static verification passes against a parsed taskflow.
 *
 * Returns issues found; `ok === true` means no errors (warnings are ok).
 * The built-in detectors are pure (no I/O, no LLM, zero tokens); caller-supplied
 * verifiers run after them and are pure by contract (see TaskflowVerifier).
 */
export function verifyTaskflow(flow: VerifiableFlow, options?: VerifyOptions): VerificationResult {
	// Tolerate malformed phase lists: null/non-object elements (validateTaskflow
	// reports them) would otherwise crash the graph helpers on `p.id`. Filter to
	// well-formed phase objects so verification degrades gracefully.
	const phases = asArray<Phase>(flow.phases).filter((p): p is Phase => !!p && typeof p === "object");
	// Detectors that take the whole flow must see the sanitized phase list too.
	const safeFlow = { ...flow, phases };
	const succ = successors(phases);
	const issues: VerificationIssue[] = [];

	issues.push(...detectDeadEnds(phases, succ));
	issues.push(...detectUnreachable(phases, succ));
	issues.push(...detectGateExhaustion(phases, succ));
	issues.push(...detectBudgetOverflow(safeFlow));
	issues.push(...detectConcurrencyWarnings(safeFlow, succ));
	issues.push(...detectGuardContradictions(phases));
	issues.push(...detectContractRefMismatches(phases));

	// Caller-supplied verifiers run last, against the same sanitized safeFlow, in
	// registration order. Fail-closed: a throwing or malformed verifier (e.g. a
	// non-array return) is normalized to one error-severity "plugin" issue naming
	// it, and the remaining verifiers still run. A verifier can never impersonate
	// a built-in category — its findings are always stamped category "plugin" with
	// source = its name.
	const verifiers = options?.verifiers;
	if (verifiers) {
		for (const v of verifiers) {
			try {
				const out = v.verify(safeFlow);
				if (!Array.isArray(out)) {
					throw new Error(`returned a non-array (${typeof out})`);
				}
				for (const issue of out) {
					issues.push({
						phaseId: issue?.phaseId,
						message:
							typeof issue?.message === "string" && issue.message
								? issue.message
								: "(verifier emitted an issue with no message)",
						// Default to "error" (fail-closed) when a verifier omits severity.
						severity: issue?.severity === "warning" ? "warning" : "error",
						category: "plugin",
						source: v.name,
					});
				}
			} catch (e) {
				issues.push({
					message: `verifier '${v.name}' failed: ${e instanceof Error ? e.message : String(e)}`,
					severity: "error",
					category: "plugin",
					source: v.name,
				});
			}
		}
	}

	const ok = !issues.some((i) => i.severity === "error");
	return { ok, issues };
}
