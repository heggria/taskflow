/**
 * BoundFragment construction (P7 dual hashes).
 */
import { hashBoundFragment } from "./hash.ts";
import type { BoundFragment } from "./types.ts";

export interface BindFragmentInput {
	fragment: unknown;
	parentBoundPlanHash?: string;
	/** Extra meta entering the audit hash (provider, policy, grants, …). */
	meta?: Record<string, unknown>;
}

/**
 * Bind a dynamic nested/grafted program fragment with dual content hashes.
 * Callers must re-Link/validate before reuse; no blind promotedPhases restore.
 */
export function bindFragment(input: BindFragmentInput): BoundFragment {
	const hashes = hashBoundFragment(input.fragment, {
		parentBoundPlanHash: input.parentBoundPlanHash ?? null,
		...(input.meta ?? {}),
	});
	return {
		boundFragmentHash: hashes.boundFragmentHash,
		executionSemanticHash: hashes.executionSemanticHash,
		fragment: input.fragment,
		parentBoundPlanHash: input.parentBoundPlanHash,
		createdAt: Date.now(),
	};
}

/**
 * Cache reuse gate (P7): semantic hash equal + parent plan match.
 * Does NOT alone authorize execution — authority/lease/artifacts still required.
 */
export function fragmentSemanticMatch(a: BoundFragment, b: BoundFragment): boolean {
	return (
		a.executionSemanticHash === b.executionSemanticHash &&
		(a.parentBoundPlanHash ?? null) === (b.parentBoundPlanHash ?? null)
	);
}
