/**
 * Link plane: Program → BoundPlan (immutable).
 */
import { validateTaskflow, desugar, isShorthand, type Taskflow } from "taskflow-core";
import {
	DEFAULT_APPROVAL_MODE,
	type ApprovalMode,
	type BoundPlan,
} from "./types.ts";
import { extractExecutionSemantics, hashBoundPlan, hashExecutionSemantic } from "./hash.ts";

export interface LinkInput {
	program: unknown;
	approvalMode?: ApprovalMode;
	grantRefs?: string[];
	/** Provider class / name pinned at link (enters boundPlanHash). */
	providerClass?: string;
	/** Optional policy overlay digest. */
	policyHash?: string;
	/** Optional exposure set digest. */
	exposureHash?: string;
}

export type LinkResult =
	| { ok: true; boundPlan: BoundPlan }
	| { ok: false; errors: string[] };

export function linkProgram(input: LinkInput): LinkResult {
	let def: Taskflow;
	try {
		// Full Taskflow {name, phases} must not go through shorthand desugar —
		// desugar() rejects non-shorthand objects that lack task/tasks/chain.
		if (isShorthand(input.program)) {
			def = desugar(input.program) as Taskflow;
		} else {
			def = input.program as Taskflow;
		}
	} catch (e) {
		return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
	}
	const v = validateTaskflow(def);
	if (!v.ok) {
		return { ok: false, errors: v.errors ?? ["validation failed"] };
	}
	const program: Taskflow = def;
	const approvalMode = input.approvalMode ?? DEFAULT_APPROVAL_MODE;
	const grantRefs = input.grantRefs ?? [];
	const providerClass = input.providerClass ?? "script";
	const semantics = extractExecutionSemantics(program);
	// Bound plan hash covers ALL execution-semantic fields (P6).
	const boundPlanHash = hashBoundPlan(program, {
		approvalMode,
		grantRefs,
		providerClass,
		policyHash: input.policyHash ?? null,
		exposureHash: input.exposureHash ?? null,
		semantics,
	});
	const executionSemanticHash = hashExecutionSemantic({
		...semantics,
		approvalMode,
		grantRefs,
		providerClass,
		policyHash: input.policyHash ?? null,
		exposureHash: input.exposureHash ?? null,
	});
	const boundPlan: BoundPlan = {
		boundPlanHash,
		executionSemanticHash,
		programName: program.name,
		program,
		createdAt: Date.now(),
		approvalMode,
		grantRefs,
	};
	return { ok: true, boundPlan };
}
