/**
 * Built-in effects verifier — static EffectIR checks (0.3 Trusted Effects MVP).
 *
 * Collects phase-level `effects[]` (and optional flow-level effects if present),
 * runs validateEffectIR, maps issues to VerificationIssue with category `"effects"`.
 *
 * Wired into `verifyTaskflow` as a built-in detector (always on when effects are
 * present). Also exported as {@link effectsLintVerifier} for plugin-style
 * registration (e.g. `pluginVerifierErrors` / explicit host lists).
 */

import type { Phase } from "../schema.ts";
import { validateEffectFlow, validateEffectIR } from "../effects/validate.ts";
import { dependenciesOf } from "../schema.ts";
import type { EffectDecl } from "../effects/types.ts";
import type {
	TaskflowVerifier,
	VerifiableFlow,
	VerificationIssue,
	VerifierIssue,
} from "../verify.ts";

function phaseEffects(p: Phase): EffectDecl[] {
	const raw = (p as Phase & { effects?: unknown }).effects;
	if (!Array.isArray(raw)) return [];
	return raw as EffectDecl[];
}

function flowLevelEffects(flow: VerifiableFlow): EffectDecl[] {
	const raw = (flow as VerifiableFlow & { effects?: unknown }).effects;
	if (!Array.isArray(raw)) return [];
	return raw as EffectDecl[];
}

/**
 * Collect all declared effects from a flow (flow-level + each phase), prefix
 * phase effect ids with `phaseId/` for unique bag identity, and run
 * `validateEffectIR`. Returns VerificationIssues with `category: "effects"`.
 *
 * Pure — no I/O. Empty effects → empty array (does not fail verify).
 */
export function detectEffectsIssues(flow: VerifiableFlow): VerificationIssue[] {
	const phases = Array.isArray(flow.phases) ? flow.phases : [];
	const scopedResults: Array<{ phaseId?: string; result: ReturnType<typeof validateEffectIR> }> = [];
	const topLevel = flowLevelEffects(flow);
	if (topLevel.length > 0) scopedResults.push({ result: validateEffectIR({ effects: topLevel }) });
	for (const rawPhase of phases) {
		if (!rawPhase || typeof rawPhase !== "object") continue;
		const phase = rawPhase as Phase;
		const effects = phaseEffects(phase);
		if (effects.length > 0) {
			scopedResults.push({ phaseId: phase.id, result: validateEffectIR({ effects }) });
		}
	}
	if (scopedResults.length === 0) return [];

	const flowResult = validateEffectFlow(phases as Phase[], (phase) => dependenciesOf(phase as Phase));
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
