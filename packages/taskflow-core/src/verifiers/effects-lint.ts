/**
 * Built-in effects verifier — static EffectIR checks (0.3 Trusted Effects MVP).
 *
 * Collects phase-level `effects[]`,
 * runs validateEffectIR, maps issues to VerificationIssue with category `"effects"`.
 *
 * Wired into `verifyTaskflow` as a built-in detector (always on when effects are
 * present). Also exported as {@link effectsLintVerifier} for plugin-style
 * registration (e.g. `pluginVerifierErrors` / explicit host lists).
 */

import type { Phase } from "../schema.ts";
import { validateComposedEffectFlow, validateEffectIR, type ComposedEffectFlowLike } from "../effects/validate.ts";
import type {
	TaskflowVerifier,
	VerifiableFlow,
	VerificationIssue,
	VerifierIssue,
} from "../verify.ts";

/** Options for the static effects detector. */
export interface DetectEffectsIssuesOptions {
	/** Optional saved-flow loader used to resolve `flow{use}` children. When
	 *  provided, resolved children are checked with their real effects; children
	 *  the loader cannot resolve degrade to advisory warnings (the runtime
	 *  loader remains the authoritative admission gate). */
	resolveFlow?: (name: string) => ComposedEffectFlowLike | undefined;
}

/**
 * Collect all declared effects from each phase, prefix
 * phase effect ids with `phaseId/` for unique bag identity, and run
 * `validateEffectIR`. Returns VerificationIssues with `category: "effects"`.
 *
 * Pure — no I/O. Empty effects → empty array (does not fail verify).
 */
export function detectEffectsIssues(flow: VerifiableFlow, options: DetectEffectsIssuesOptions = {}): VerificationIssue[] {
	const phases = Array.isArray(flow.phases) ? flow.phases : [];
	const scopedResults: Array<{ phaseId?: string; result: ReturnType<typeof validateEffectIR> }> = [];
	for (const rawPhase of phases) {
		if (!rawPhase || typeof rawPhase !== "object") continue;
		const phase = rawPhase as Phase;
		const effects = (phase as Phase & { effects?: unknown }).effects;
		if (effects !== undefined) {
			scopedResults.push({ phaseId: phase.id, result: validateEffectIR({ effects }) });
		}
	}

	const flowResult = validateComposedEffectFlow({ phases: phases as Phase[] }, {
		// Static gates have no flow store: an unresolved `flow{use}` child is
		// advisory (the runtime loader is the authoritative admission gate),
		// not a hard confidentiality taint.
		downgradeUnresolvedUse: true,
		resolveFlow: options.resolveFlow,
	});
	if (scopedResults.length === 0 && flowResult.issues.length === 0) return [];
	const issues: VerificationIssue[] = [];
	for (const scoped of scopedResults) {
		for (const issue of scoped.result.issues) {
			issues.push({
				message: `[effects] ${issue.message}`,
				severity: issue.severity,
				category: "effects",
				phaseId: scoped.phaseId,
				source: "effects-lint",
			});
		}
	}
	for (const issue of flowResult.issues) {
		const phaseId = issue.effectId?.includes("/") ? issue.effectId.split("/")[0] : undefined;
		issues.push({
			message: `[effects] ${issue.message}`,
			severity: issue.severity,
			category: "effects",
			phaseId,
			source: "effects-lint",
		});
	}
	return issues;
}

/** Plugin-style wrapper around {@link detectEffectsIssues} for hosts that
 *  register verifiers explicitly. Prefer the built-in path via `verifyTaskflow`
 *  (category `"effects"`); this path stamps category `"plugin"`. */
export const effectsLintVerifier: TaskflowVerifier = {
	name: "effects-lint",
	verify(flow: VerifiableFlow): VerifierIssue[] {
		return detectEffectsIssues(flow).map((i) => ({
			message: i.message,
			severity: i.severity,
			phaseId: i.phaseId,
		}));
	},
};
