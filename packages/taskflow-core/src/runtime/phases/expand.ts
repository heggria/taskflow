/**
 * Expand phase helpers — pure transforms for fragment prep + graft promote.
 * Execution still wires through flow{def} path in runtime.ts; logic lives here
 * so expand does not keep growing executePhaseInner.
 */

import type { Phase, Taskflow } from "../../schema.ts";
import type { PhaseState, RunState } from "../../store.ts";

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

/**
 * Prefix every phase id (and rewrite dependsOn/from) so graft fragments never
 * collide with parent phase ids.
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
			return np;
		}),
	};
}

/**
 * Copy child phase states onto the parent run (graft promote).
 * Skips ids that already exist on the parent.
 */
export function promoteGraftPhases(
	parent: RunState,
	childPhases: Record<string, PhaseState>,
): { promoted: number; warnings: string[] } {
	const warnings: string[] = [];
	let promoted = 0;
	for (const [cid, cps] of Object.entries(childPhases)) {
		if (parent.phases[cid]) {
			warnings.push(`expand graft skipped promote of '${cid}' (id already exists on parent)`);
			continue;
		}
		parent.phases[cid] = { ...cps, id: cid };
		promoted++;
	}
	warnings.push(`expand graft: promoted ${promoted} phase(s) onto parent run`);
	return { promoted, warnings };
}
