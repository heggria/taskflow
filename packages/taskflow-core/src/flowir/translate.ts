/**
 * FlowIR translation — the 1:1 projection of a pi-taskflow `Taskflow` into the
 * `FlowIR` shape.
 *
 * **Stub/projection** (M1): this is a *structural* mirror, NOT a compile to
 * overstory's native inject/emits model (which expects an explicit emit
 * declaration pi-taskflow doesn't have — see roadmap §6.1). Each phase becomes
 * one `FlowIRNode`; `inject` is synthesized from `{steps.X}` interpolation refs
 * (`collectRefs`), `emits` is `[phase.id]`. The overstory-native `kind` lowering
 * is deliberately deferred.
 *
 * Pure, synchronous, never throws. Used by `compileTaskflowToIR` (./index.ts).
 *
 * @see docs/internal/overstory-convergence-roadmap.md §3 (M1)
 */

import { collectRefs, type Phase, type Taskflow } from "../schema.ts";
import type {
	CompileError,
	CompileWarning,
	DeclaredDeps,
	FlowIR,
	FlowIRNode,
	TaskflowIRMeta,
} from "./meta.ts";

// ---------------------------------------------------------------------------
// Sidecar: the pi-taskflow-specific fields not represented in FlowIRNode.
// Everything preserved verbatim so the projection is lossless and can
// round-trip back to a runnable Taskflow. Defined as a list so the sidecar
// never silently drops a field when the DSL grows (a new field is carried
// automatically through `Phase` indexing).
// ---------------------------------------------------------------------------

// NOTE: keep in sync with PhaseSchema (schema.ts). Every Phase field that is
// NOT represented on FlowIRNode (id/type/when) must appear here, or it is
// silently dropped on JSON ↔ DSL round-trip (translateTaskflow copies these
// verbatim into the sidecar). Missing fields here = data loss on round-trip.
const SIDECAR_PHASE_FIELDS = [
	"agent",
	"task",
	"over",
	"as",
	"branches",
	"from",
	"use",
	"def",
	"with",
	"run",
	"input",
	"timeout",
	"until",
	"maxIterations",
	"convergence",
	"reflexion",
	"variants",
	"judge",
	"judgeAgent",
	"mode",
	"dependsOn",
	"join",
	"when",
	"retry",
	"output",
	"expect",
	"model",
	"thinking",
	"tools",
	"cwd",
	"final",
	"optional",
	"idempotent",
	"concurrency",
	"context",
	"contextLimit",
	"onBlock",
	"eval",
	"score",
	"cache",
	"shareContext",
	"cancelLosers",
	"expandMode",
	"maxNodes",
] as const;

/** Build the per-phase sidecar record (verbatim copy of non-IR fields). */
function sidecarForPhase(phase: Phase): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const rec = phase as Record<string, unknown>;
	for (const k of SIDECAR_PHASE_FIELDS) {
		if (k in rec && rec[k] !== undefined) out[k] = rec[k];
	}
	return out;
}

/**
 * Translate a desugared `Taskflow` into a 1:1 `FlowIR` projection + declared
 * dependency metadata. Never throws: malformed input yields warnings/errors in
 * the return value, not an exception (so `/tf ir` on a broken flow still
 * produces a structured diagnostic rather than crashing the tool).
 *
 * `usedFallbackHash` is `true` unconditionally in the stub: the hash produced
 * is `flowDefHash` (the definition fingerprint), NOT the overstory-IR-canonical
 * hash, so callers can never mistake a stub hash for a canonical one. It flips
 * to `false` only once the genuine overstory compiler is vendored and the hash
 * is IR-canonical; a `when` guard remains a *future* fallback driver then.
 */
export function translateTaskflow(def: Taskflow): {
	ir: FlowIR;
	meta: TaskflowIRMeta;
	warnings: CompileWarning[];
	errors: CompileError[];
	usedFallbackHash: boolean;
} {
	const warnings: CompileWarning[] = [];
	const errors: CompileError[] = [];
	const declaredDeps: Record<string, DeclaredDeps> = {};
	const sidecarPhases: Record<string, unknown> = {};

	// In the stub the hash is ALWAYS the fallback (flowDefHash — the definition
	// fingerprint, not the overstory-IR-canonical hash). The `when` guard is a
	// *future* driver (the genuine compiler can't lower conditions → fallback);
	// today the stub unconditionally uses the fallback so callers can never
	// mistake a stub hash for a canonical one. Flips to `false` only once the
	// genuine overstory compiler is vendored and the hash is IR-canonical.
	const usedFallbackHash = true;

	const nodes: FlowIRNode[] = def.phases.map((phase) => {
		const refs = collectRefs(phase);
		// declared reads: the {steps.X} refs this phase statically references,
		// UNION the phase's explicit dependsOn (a declared-but-unobserved edge —
		// e.g. a semantic ordering that no interpolation captures — still counts
		// as a dependency for staleness propagation; observed ∪ declared).
		const reads = new Set<string>(refs.steps.filter((id) => id !== phase.id));
		for (const d of phase.dependsOn ?? []) if (d !== phase.id) reads.add(d);
		declaredDeps[phase.id] = { reads: Array.from(reads), writes: [phase.id] };

		// Advisory: a {steps.X} ref whose target doesn't exist (mirrors the
		// validation check but non-fatal here — validation is the source of
		// truth; this is a read-only diagnostic).
		const knownIds = new Set(def.phases.map((p) => p.id));
		for (const r of refs.steps) {
			if (r !== phase.id && !knownIds.has(r)) {
				warnings.push({
					phaseId: phase.id,
					message: `references {steps.${r}.*} but no phase '${r}' exists`,
				});
			}
		}

		if (phase.when !== undefined) {
			// `when` is a future fallback driver; today the stub is always fallback.
			// (Kept as a structural marker on the node for round-trip.)
		}

		sidecarPhases[phase.id] = sidecarForPhase(phase);

		return {
			id: phase.id,
			kind: phase.type ?? "agent",
			inject: Array.from(reads),
			emits: [phase.id],
			when: phase.when,
		} satisfies FlowIRNode;
	});

	const ir: FlowIR = {
		name: def.name,
		nodes,
		args: def.args,
		budget: def.budget,
		concurrency: def.concurrency,
	};

	const meta: TaskflowIRMeta = {
		sourceFlowName: def.name,
		declaredDeps,
		sidecar: { phases: sidecarPhases },
	};

	return { ir, meta, warnings, errors, usedFallbackHash };
}
