/**
 * Expand phase helpers — pure transforms for fragment prep + graft promote.
 * Execution still wires through flow|def path in runtime.ts; logic lives here
 * so expand does not keep growing executePhaseInner.
 */

import type { Phase, Taskflow } from "../../schema.ts";
import type { PhaseState, RunState } from "../../store.ts";
import { emptyUsage } from "../../usage.ts";

export type ExpandMode = "nested" | "graft";

export function resolveExpandMode(phase: Phase): ExpandMode {
	return (phase as { expandMode?: string }).expandMode === "graft" ? "graft" : "nested";
}

export function resolveMaxNodes(phase: Phase, hardCap: number): number {
	const n = (phase as { maxNodes?: number }).maxNodes;
	if (typeof n === "number" && Number.isFinite(n)) {
		return Math.min(hardCap, Math.max(1, Math.floor(n)));
	}
	return Math.min(50, hardCap);
}

/** Rewrite `{steps.<oldId>...}` placeholders using a phase id map. */
function rewriteStepRefs(text: string, idMap: Map<string, string>): string {
	return text.replace(/\{steps\.([a-zA-Z0-9_-]+)/g, (full, id: string) => {
		const mapped = idMap.get(id);
		return mapped ? `{steps.${mapped}` : full;
	});
}

/**
 * Prefix every phase id (and rewrite dependsOn/from + template step refs) so
 * graft fragments never collide with parent phase ids and internal edges stay valid.
 */
export function prefixGraftFragment(fragment: Taskflow, expandPhaseId: string): Taskflow {
	const prefix = `${expandPhaseId}-`;
	const idMap = new Map(fragment.phases.map((p) => [p.id, prefix + p.id]));
	return {
		...fragment,
		name: fragment.name || `${expandPhaseId}-graft`,
		phases: fragment.phases.map((p) => {
			const np: Phase = { ...p, id: idMap.get(p.id) ?? prefix + p.id };
			if (p.dependsOn?.length) {
				np.dependsOn = p.dependsOn.map((d) => idMap.get(d) ?? d);
			}
			if (p.from?.length) {
				np.from = p.from.map((d) => idMap.get(d) ?? d);
			}
			// Rewrite string templates that reference sibling phase ids.
			const fields = ["task", "over", "when", "until", "input", "judge", "def"] as const;
			for (const f of fields) {
				const v = (np as Record<string, unknown>)[f];
				if (typeof v === "string") {
					(np as Record<string, unknown>)[f] = rewriteStepRefs(v, idMap);
				}
			}
			if (Array.isArray(np.run)) {
				np.run = np.run.map((r) => (typeof r === "string" ? rewriteStepRefs(r, idMap) : r));
			} else if (typeof np.run === "string") {
				np.run = rewriteStepRefs(np.run, idMap);
			}
			if (Array.isArray(np.eval)) {
				np.eval = np.eval.map((e) => (typeof e === "string" ? rewriteStepRefs(e, idMap) : e));
			}
			if (Array.isArray(np.context)) {
				np.context = np.context.map((c) => (typeof c === "string" ? rewriteStepRefs(c, idMap) : c));
			}
			if (np.branches?.length) {
				np.branches = np.branches.map((b) => {
					const nb = { ...b };
					if (typeof nb.task === "string") nb.task = rewriteStepRefs(nb.task, idMap);
					return nb;
				});
			}
			if (np.with && typeof np.with === "object") {
				const nw: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(np.with)) {
					nw[k] = typeof v === "string" ? rewriteStepRefs(v, idMap) : v;
				}
				np.with = nw;
			}
			const score = (np as { score?: { target?: unknown; judge?: { task?: unknown } } }).score;
			if (score && typeof score === "object") {
				const ns = { ...score };
				if (typeof ns.target === "string") ns.target = rewriteStepRefs(ns.target, idMap);
				if (ns.judge && typeof ns.judge === "object" && typeof ns.judge.task === "string") {
					ns.judge = { ...ns.judge, task: rewriteStepRefs(ns.judge.task, idMap) };
				}
				(np as { score?: unknown }).score = ns;
			}
			return np;
		}),
	};
}

/**
 * Copy child phase states onto the parent run (graft promote).
 * Skips ids that already exist on the parent.
 * Returns whether any phase was promoted (caller should zero expand usage to avoid double-count).
 */
export function promoteGraftPhases(
	parent: RunState,
	childPhases: Record<string, PhaseState>,
): { promoted: number; promotedIds: string[]; warnings: string[] } {
	const warnings: string[] = [];
	let promoted = 0;
	const promotedIds: string[] = [];
	// Collision ownership is defined by the authored definition, not by which
	// authored phases happen to have reached the scheduler and acquired state
	// rows. A graft may execute before a later authored phase with the same id;
	// promoting into that gap would steal ownership and zero the expand's residual
	// usage even though the authored phase subsequently overwrites the row.
	const authoredIds = new Set(parent.def.phases.map((phase) => phase.id));
	for (const [cid, cps] of Object.entries(childPhases)) {
		if (authoredIds.has(cid) || parent.phases[cid]) {
			warnings.push(`expand graft skipped promote of '${cid}' (id is authored or already exists on parent)`);
			continue;
		}
		// Keep child usage for audit; expand phase usage must be zeroed by caller
		// so run-level aggregateUsage does not double-count.
		parent.phases[cid] = { ...cps, id: cid };
		promoted++;
		promotedIds.push(cid);
	}
	if (promoted > 0) {
		warnings.push(`expand graft: promoted ${promoted} phase(s) onto parent run`);
	}
	return { promoted, promotedIds, warnings };
}

/** Empty usage helper for expand phase after graft (avoid double-count in rollup). */
export function emptyUsageForGraftExpand(): ReturnType<typeof emptyUsage> {
	return emptyUsage();
}
