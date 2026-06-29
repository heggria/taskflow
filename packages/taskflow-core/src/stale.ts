/**
 * Stale-marking (M4) — conservative transitive invalidation over the observed
 * readSet captured in M3.
 *
 * This is the "mark stale, don't rerun" half of overstory's cost-asymmetric
 * reactivity (VISION §2.3): the cheap effects (figuring out what WOULD be
 * invalidated) run for free; the expensive effects (actually re-running an LLM
 * phase) are gated for M5. Given a run's observed readSets and a set of phases
 * assumed to have changed, `computeStaleFrontier` returns the transitive
 * closure of phases whose recorded dependencies are no longer trustworthy.
 *
 * Pure module: no IO, no Date, no randomness. Deterministic.
 *
 * Scope (honest): this is TOPOLOGICAL propagation only — a changed seed
 * invalidates everything that (transitively) read it. The overstory
 * "early cutoff" refinement (a re-run whose output HASH is unchanged does NOT
 * invalidate, even if the version advanced) needs before/after content hashes,
 * which only exist when a phase is actually re-run — that is the M5
 * recomputation concern, deliberately out of scope here. Marking is the safe,
 * conservative prerequisite that lets M5 rerun with confidence.
 *
 * @see docs/internal/overstory-convergence-roadmap.md §3 (M4)
 */

import type { PhaseState } from "./store.ts";
import { collectRefs, type Taskflow } from "./schema.ts";

// ---------------------------------------------------------------------------
// Read graph
// ---------------------------------------------------------------------------

/** phaseId → the upstream stepIds it observed-reading (M3 PhaseState.reads). */
export type ReadMap = Map<string, readonly string[]>;

/** Fold a run's PhaseStates into a read map (drops phases with no reads). */
export function readMapOf(phases: Record<string, PhaseState>): ReadMap {
	const m: ReadMap = new Map();
	for (const [id, ps] of Object.entries(phases)) {
		const deps = (ps.reads ?? []).map((r) => r.stepId);
		if (deps.length) m.set(id, deps);
	}
	return m;
}

/** Phases that directly read `phaseId` (its immediate dependents).
 *
 *  When `declared` is provided, the dependent set is the **union** of
 *  observed dependents (from `reads`) and declared dependents (from
 *  `declared`) — a declared-but-unobserved edge (e.g. a `when` ref that never
 *  fired) still counts as a dependency for staleness propagation (M2 union).
 *  `declared` undefined → observed-only (backward-compatible). */
export function dependentsOf(reads: ReadMap, phaseId: string, declared?: ReadMap): string[] {
	const out = new Set<string>();
	for (const [reader, deps] of reads) {
		if (deps.includes(phaseId)) out.add(reader);
	}
	if (declared) {
		for (const [reader, deps] of declared) {
			if (deps.includes(phaseId)) out.add(reader);
		}
	}
	return [...out];
}

// ---------------------------------------------------------------------------
// Stale frontier (transitive closure, union semantics)
// ---------------------------------------------------------------------------

/**
 * The set of phases that are stale if `seeds` change, transitively. A reader
 * is stale if ANY phase it (observed- OR declared-)reading is stale
 * (union/I5: when in doubt, assume dependency). Includes the seeds themselves.
 *
 * When `declared` is provided, the read graph used for propagation is the
 * **union** of `reads` (observed, M3) and `declared` (M2 compile-time refs):
 * a declared-but-unobserved edge still propagates staleness. `declared`
 * undefined → observed-only (backward-compatible, identical to pre-M2).
 *
 * Deterministic. O(phases + read-edges). Cycles in the read graph (which a
 * correct DAG can't produce, but a pathological one could) terminate because a
 * phase is enqueued at most once.
 */
export function computeStaleFrontier(reads: ReadMap, seeds: Iterable<string>, declared?: ReadMap): Set<string> {
	const stale = new Set<string>();
	const queue: string[] = [...seeds];
	while (queue.length) {
		const s = queue.shift() as string;
		if (stale.has(s)) continue;
		stale.add(s);
		for (const dep of dependentsOf(reads, s, declared)) {
			if (!stale.has(dep)) queue.push(dep);
		}
	}
	return stale;
}

// ---------------------------------------------------------------------------
// Declared-plane derivation (M2)
// ---------------------------------------------------------------------------

/** Build a declared ReadMap from a flow definition: each phase's `collectRefs`
 *  `{steps.X}` refs become its declared reads (self-refs excluded so a loop
 *  `until` checking `{steps.thisId.output}` doesn't create a self-edge).
 *
 *  Pure. Used by `recomputeTaskflow` and `/tf why-stale` so union (observed ∪
 *  declared) semantics apply to old runs too (pre-H1 runs have no persisted
 *  `RunState.declaredDeps` — deriving from `def` keeps recompute sound). */
export function declaredReadMapOfDef(def: Taskflow): ReadMap {
	const m: ReadMap = new Map();
	for (const p of def.phases) {
		const refs = collectRefs(p);
		const reads = refs.steps.filter((id) => id !== p.id);
		if (reads.length) m.set(p.id, reads);
	}
	return m;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render either the full observed dependency graph (no seeds) or the stale
 * frontier given assumed-changed seeds. Each stale phase lists the stale
 * upstreams that caused it (its "why").
 *
 * When `declared` is provided, the frontier is the **union** (observed ∪
 * declared) and a stale phase's "why" annotates edges present only in the
 * declared plane (not observed at runtime) with `(declared)`. `declared`
 * undefined → observed-only rendering (backward-compatible).
 */
export function formatWhyStale(
	runId: string,
	flowName: string,
	reads: ReadMap,
	seeds: readonly string[],
	declared?: ReadMap,
): string {
	const lines: string[] = [];
	lines.push(`why-stale — run ${runId} · flow "${flowName}"`);
	lines.push("");

	if (seeds.length === 0) {
		// No seeds → show the full observed dependency graph (who reads what).
		if (reads.size === 0 && (!declared || declared.size === 0)) {
			lines.push("(No observed readSets in this run — provenance is empty.)");
			return lines.join("\n");
		}
		lines.push("Observed dependency graph (who reads what):");
		lines.push("");
		const allReaders = new Set<string>([...reads.keys(), ...(declared?.keys() ?? [])]);
		for (const reader of allReaders) {
			const obs = reads.get(reader) ?? [];
			const dec = declared?.get(reader) ?? [];
			const parts: string[] = [];
			for (const d of obs) parts.push(d);
			for (const d of dec) if (!obs.includes(d)) parts.push(`${d} (declared)`);
			lines.push(`■ ${reader}  reads: ${parts.join(", ") || "(none)"}`);
		}
		lines.push("");
		lines.push("Pass a phase id to compute its stale frontier: /tf why-stale <runId> <phaseId>");
		return lines.join("\n");
	}

	const frontier = computeStaleFrontier(reads, seeds, declared);
	const seedSet = new Set(seeds);
	lines.push(`Assuming changed: ${[...seedSet].join(", ")}`);
	lines.push("");
	if (frontier.size <= seedSet.size) {
		lines.push(`Stale frontier: only the seed(s) themselves — nothing else reads them.`);
		return lines.join("\n");
	}
	lines.push(`Stale frontier (transitive, ${frontier.size} phases):`);
	// Order: seeds first, then the rest, for readability.
	const ordered = [...seeds.filter((s) => frontier.has(s)), ...[...frontier].filter((s) => !seedSet.has(s))];
	for (const id of ordered) {
		if (seedSet.has(id)) {
			lines.push(`  ■ ${id}  (changed — seed)`);
		} else {
			// Why is it stale? The stale upstreams it read (observed ∪ declared).
			const obs = reads.get(id) ?? [];
			const dec = declared?.get(id) ?? [];
			const obsCauses = obs.filter((d) => frontier.has(d));
			const decCauses = dec.filter((d) => frontier.has(d) && !obs.includes(d));
			const causeStr = [
				...obsCauses,
				...decCauses.map((d) => `${d} (declared)`),
			].join(", ");
			lines.push(`  ■ ${id}  ← reads ${causeStr || "(nothing stale?)"}`);
		}
	}
	return lines.join("\n");
}
