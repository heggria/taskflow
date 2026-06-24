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

/** Phases that directly read `phaseId` (its immediate dependents). */
export function dependentsOf(reads: ReadMap, phaseId: string): string[] {
	const out: string[] = [];
	for (const [reader, deps] of reads) {
		if (deps.includes(phaseId)) out.push(reader);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Stale frontier (transitive closure, union semantics)
// ---------------------------------------------------------------------------

/**
 * The set of phases that are stale if `seeds` change, transitively. A reader
 * is stale if ANY phase it observed-reading is stale (union/I5: when in doubt,
 * assume dependency). Includes the seeds themselves.
 *
 * Deterministic. O(phases + read-edges). Cycles in the read graph (which a
 * correct DAG can't produce, but a pathological one could) terminate because a
 * phase is enqueued at most once.
 */
export function computeStaleFrontier(reads: ReadMap, seeds: Iterable<string>): Set<string> {
	const stale = new Set<string>();
	const queue: string[] = [...seeds];
	while (queue.length) {
		const s = queue.shift() as string;
		if (stale.has(s)) continue;
		stale.add(s);
		for (const dep of dependentsOf(reads, s)) {
			if (!stale.has(dep)) queue.push(dep);
		}
	}
	return stale;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render either the full observed dependency graph (no seeds) or the stale
 * frontier given assumed-changed seeds. Each stale phase lists the stale
 * upstreams that caused it (its "why").
 */
export function formatWhyStale(
	runId: string,
	flowName: string,
	reads: ReadMap,
	seeds: readonly string[],
): string {
	const lines: string[] = [];
	lines.push(`why-stale — run ${runId} · flow "${flowName}"`);
	lines.push("");

	if (seeds.length === 0) {
		// No seeds → show the full observed dependency graph (who reads what).
		if (reads.size === 0) {
			lines.push("(No observed readSets in this run — provenance is empty.)");
			return lines.join("\n");
		}
		lines.push("Observed dependency graph (who reads what):");
		lines.push("");
		for (const [reader, deps] of reads) {
			lines.push(`■ ${reader}  reads: ${deps.join(", ")}`);
		}
		lines.push("");
		lines.push("Pass a phase id to compute its stale frontier: /tf why-stale <runId> <phaseId>");
		return lines.join("\n");
	}

	const frontier = computeStaleFrontier(reads, seeds);
	const seedSet = new Set(seeds);
	lines.push(`Assuming changed: ${[...seedSet].join(", ")}`);
	lines.push("");
	if (frontier.size <= seedSet.size) {
		lines.push(`Stale frontier: only the seed(s) themselves — nothing else observed-reading them.`);
		return lines.join("\n");
	}
	lines.push(`Stale frontier (transitive, ${frontier.size} phases):`);
	// Order: seeds first, then the rest, for readability.
	const ordered = [...seeds.filter((s) => frontier.has(s)), ...[...frontier].filter((s) => !seedSet.has(s))];
	for (const id of ordered) {
		if (seedSet.has(id)) {
			lines.push(`  ■ ${id}  (changed — seed)`);
		} else {
			// Why is it stale? The stale upstreams it read.
			const deps = reads.get(id) ?? [];
			const causes = deps.filter((d) => frontier.has(d));
			lines.push(`  ■ ${id}  ← reads ${causes.length ? causes.join(", ") : "(nothing stale?)"}`);
		}
	}
	return lines.join("\n");
}
