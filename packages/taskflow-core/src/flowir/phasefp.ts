/**
 * Per-phase structural sub-fingerprint (M6).
 *
 * `phaseFingerprint` produces a content-addressed hash of ONLY the subset of
 * the flow definition that can affect a single phase's subagent output: the
 * phase itself plus its transitive dependency closure. Folding this into the
 * cross-run cache key (instead of the whole-flow `flowDefHash`) means editing
 * phase B invalidates only B and its transitive dependents — independent
 * sibling phase A keeps its cache hit.
 *
 * ## Soundness (the fallback gate)
 *
 * Per-phase invalidation is only sound when a phase's *real* dependencies are
 * fully captured by the static `dependsOn ∪ from` closure. Three cases break
 * that guarantee, so `phaseFingerprint` returns `undefined` for them and the
 * caller falls back to the whole-flow `flowDefHash` (safe, = pre-M6 behavior):
 *
 *   1. **Shared Context Tree** (`def.contextSharing === true` or any closure
 *      member has `shareContext === true`): a sharing phase can read sibling
 *      blackboard writes OUTSIDE its declared deps, so the static closure
 *      under-approximates real reads.
 *   2. **`flow` phase in the closure** (`type === "flow"`): a `flow` phase's
 *      sub-structure is resolved at runtime (inline `def`) or from a saved
 *      flow (`use`) and is not statically visible here. Editing the saved
 *      sub-flow would not move this phase's sub-fingerprint.
 *   3. **`join: "any"` phase** (`phase.join === "any"`): validation exempts it
 *      from the `{steps.X}`-must-be-in-`dependsOn` check, so it may read
 *      phases outside its static closure. The closure under-approximates its
 *      real reads, so fall back to whole-flow invalidation.
 *
 * `cache`, `retry`, `concurrency`, and `final` are stripped from each phase
 * before hashing: none of them changes the subagent's OUTPUT (they are policy,
 * execution mechanics, or result selection). `cache`'s sub-fields
 * (`scope`/`ttl`/`fingerprint`) reach the cache key through other paths
 * (`cc.scope` gates the lookup, `cc.ttlMs` governs expiry, `cc.fingerprint` is
 * in the key tail). Every other `Phase` field is hashed. `PhaseSchema` uses
 * `additionalProperties: false`, so no surprise field can be missed.
 *
 * Pure + async (Web Crypto via `hashCanonical`). Reuses the vendored
 * `canonicalJson`/`hashCanonical` (byte-identical to overstory's contract) so
 * the sub-fingerprint shares one hashing contract with `flowDefHash`. Never
 * throws — callers wrap in try/catch and degrade to `flowDefHash`.
 *
 * @see docs/internal/cache-migration.md (v3:phasefp tier)
 */

import { transitiveDependencies, type Phase, type Taskflow } from "../schema.ts";
import { canonicalJson, hashCanonical } from "./hash.ts";

/** Fields stripped before hashing because they do NOT affect a phase's
 *  subagent OUTPUT, only execution mechanics or result selection — folding
 *  them in would cause false cache invalidation on a no-op config change:
 *   - `cache`: policy object; its sub-fields reach the key via
 *     `cc.scope`/`cc.ttlMs`/`cc.fingerprint`.
 *   - `retry`: retry/backoff is execution mechanics; a successful phase
 *     produces the same output regardless of how many attempts it took.
 *   - `concurrency`: fan-out parallelism; does not change any item's output.
 *   - `final`: marks which phase's output is the flow result; does not change
 *     the phase's own output. */
const PHASE_FP_STRIP = ["cache", "retry", "concurrency", "final"] as const;

/** Clone a phase into a plain record with policy fields removed. */
function stripPolicy(phase: Phase): Record<string, unknown> {
	const rec = phase as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(rec)) {
		if ((PHASE_FP_STRIP as readonly string[]).includes(k)) continue;
		out[k] = rec[k];
	}
	return out;
}

/**
 * Per-phase structural sub-fingerprint.
 *
 * @returns the hex hash, or `undefined` when per-phase soundness cannot be
 *   guaranteed (caller falls back to the whole-flow `flowDefHash`). Never
 *   throws.
 */
export async function phaseFingerprint(def: Taskflow, phaseId: string): Promise<string | undefined> {
	const phases = def.phases as Phase[];
	const byId = new Map(phases.map((p) => [p.id, p]));
	const phase = byId.get(phaseId);
	if (!phase) return undefined;

	// --- Soundness gate: fall back to whole-flow when static closure is unsafe. ---
	// Flow-wide context sharing enables cross-sibling reads outside declared deps.
	if (def.contextSharing === true) return undefined;
	// A `join: "any"` phase may interpolate `{steps.X.*}` refs to phases OUTSIDE
	// its declared dependsOn (validation deliberately exempts it — schema.ts), so
	// the static closure under-approximates its real reads. Fall back to
	// whole-flow invalidation rather than rely on the key tail alone (which would
	// be an undocumented coupling). Safe, = pre-M6 behavior.
	if (phase.join === "any") return undefined;

	const closureIds = transitiveDependencies(phases, phaseId);
	const closurePhases: Phase[] = [];
	for (const id of closureIds) {
		const p = byId.get(id);
		if (!p) continue; // unknown dep — validation reports elsewhere
		// Per-phase sharing: this closure member can read sibling blackboard
		// writes outside its own declared deps.
		if (p.shareContext === true) return undefined;
		// A flow phase's sub-structure is runtime/saved-flow-resolved and not
		// statically visible — editing it would not move the sub-fingerprint.
		if ((p.type ?? "agent") === "flow") return undefined;
		closurePhases.push(p);
	}
	// The self phase's own sharing/type is part of the closure too.
	if (phase.shareContext === true) return undefined;
	if ((phase.type ?? "agent") === "flow") return undefined;

	// --- Build the canonical payload. ---
	// `deps` is the SORTED transitive closure (self excluded). canonicalJson
	// sorts OBJECT keys but preserves ARRAY order, so we sort the array
	// explicitly for determinism independent of dependency walk order.
	const depsPayload = closurePhases.map((p) => ({ id: p.id, def: stripPolicy(p) }));
	const payload = { self: stripPolicy(phase), deps: depsPayload };

	return hashCanonical(canonicalJson(payload));
}
