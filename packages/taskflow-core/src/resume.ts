/**
 * Resume overrides + immutable history — 0.2.0 dogfood issue 5.
 *
 * Resume creates a NEW RunState (new runId, `parentRunId` pointing at the
 * original) and never mutates or overwrites the original run file. Reusable
 * completed phase states are copied into the child; the target failed/paused
 * phase + its transitive downstream dependents are cleared so they re-run.
 *
 * An optional `ResumeOverrides` API re-runs exactly one phase with a patched
 * task/model/timeout/idleTimeout (applied to the CHILD's def only — the parent
 * def is untouched). When no overrides are supplied, ordinary resume forks a
 * new run that preserves all `done` phases and lets the runtime re-run the
 * non-done (failed/paused/running) ones.
 *
 * The fork/apply helpers are pure + total so they can be unit-tested without
 * touching the runtime or the filesystem. The host adapters (pi / MCP) call
 * `forkRunForResume` and hand the child RunState to `executeTaskflow`.
 */

import { validateTaskflow, dependenciesOf, type Phase, type Taskflow } from "./schema.ts";
import { newRunId, type PhaseState, type RunState } from "./store.ts";
import { getBuildInfo } from "./build-info.ts";

/** Overrides for re-running exactly one phase on resume. `phaseId` is required;
 *  at least one of the other fields must be supplied. All values are applied to
 *  the CHILD's def only (the parent def + persisted file are never touched). */
export interface ResumeOverrides {
	phaseId: string;
	task?: string;
	model?: string;
	timeout?: number;
	idleTimeout?: number;
}

/** Runs are resumable only when execution stopped non-terminally. Completed and
 * blocked runs are immutable terminal history; use a fresh run or recompute. */
export function validateResumeRun(prev: RunState): { ok: boolean; errors: string[] } {
	if (prev.status === "failed" || prev.status === "paused") return { ok: true, errors: [] };
	return {
		ok: false,
		errors: [`Run '${prev.runId}' has status '${prev.status}' and is not resumable (expected failed or paused)`],
	};
}

/** Validate resume overrides against a prior run. Returns structured errors.
 *  Checks: phaseId exists, at least one override field is present, and field
 *  values pass the normal Taskflow validator after applying the overrides. */
export function validateResumeOverrides(prev: RunState, ov: ResumeOverrides): { ok: boolean; errors: string[] } {
	const errors = [...validateResumeRun(prev).errors];
	if (!ov.phaseId || typeof ov.phaseId !== "string") {
		errors.push("resume overrides require a 'phaseId'");
		return { ok: false, errors };
	}
	const phase = prev.def.phases.find((p) => p.id === ov.phaseId);
	if (!phase) {
		errors.push(`resume overrides target phase '${ov.phaseId}' not found in run '${prev.runId}' (flow '${prev.flowName}')`);
		return { ok: false, errors };
	}
	const priorPhase = prev.phases[ov.phaseId];
	if (priorPhase?.status === "done") {
		errors.push(`resume overrides target phase '${ov.phaseId}' is already done; override the failed/in-flight phase or start a fresh run`);
	}
	// At least one override field must be supplied (besides phaseId).
	const hasAny = ov.task !== undefined || ov.model !== undefined || ov.timeout !== undefined || ov.idleTimeout !== undefined;
	if (!hasAny) {
		errors.push("resume overrides require at least one of: task, model, timeout, idleTimeout (besides phaseId)");
	}
	// Field value sanity (the full def is re-validated after apply, but these
	// give precise messages before constructing a child def).
	if (ov.timeout !== undefined && (typeof ov.timeout !== "number" || !Number.isFinite(ov.timeout) || ov.timeout < 1000)) {
		errors.push(`resume override 'timeout' must be a number >= 1000 ms, got ${ov.timeout}`);
	}
	if (ov.idleTimeout !== undefined && (typeof ov.idleTimeout !== "number" || !Number.isFinite(ov.idleTimeout) || ov.idleTimeout < 0)) {
		errors.push(`resume override 'idleTimeout' must be a non-negative finite number (ms), got ${ov.idleTimeout}`);
	}
	if (errors.length) return { ok: false, errors };
	// Apply + validate the child def with the normal Taskflow validator so
	// structural constraints (e.g. a patched task introducing a bad ref) are
	// caught before the child run starts.
	const childDef = applyResumeOverrides(prev.def, ov);
	const v = validateTaskflow(childDef);
	if (!v.ok) {
		errors.push(...v.errors.map((e) => `resume override produced an invalid flow: ${e}`));
	}
	return { ok: errors.length === 0, errors };
}

/** Apply resume overrides to a deep-cloned def (the parent def is never
 *  mutated). Returns the child def. Pure. */
export function applyResumeOverrides(def: Taskflow, ov: ResumeOverrides): Taskflow {
	const child: Taskflow = structuredClone(def);
	const phase = child.phases.find((p) => p.id === ov.phaseId);
	if (!phase) return child; // validateResumeOverrides reports the missing phase
	if (ov.task !== undefined) phase.task = ov.task;
	if (ov.model !== undefined) phase.model = ov.model;
	if (ov.timeout !== undefined) phase.timeout = ov.timeout;
	if (ov.idleTimeout !== undefined) phase.idleTimeout = ov.idleTimeout;
	return child;
}

/** Compute the transitive DOWNSTREAM dependents of `target` (phases that depend
 *  on target, directly or transitively, via `dependsOn` ∪ `from`). Excludes the
 *  target itself. Sorted for deterministic output. */
export function transitiveDownstream(phases: Phase[], target: string): string[] {
	const byId = new Map(phases.map((p) => [p.id, p]));
	const seen = new Set<string>();
	const queue: string[] = [];
	for (const p of phases) {
		if (dependenciesOf(p).includes(target)) queue.push(p.id);
	}
	while (queue.length) {
		const id = queue.shift()!;
		if (seen.has(id)) continue;
		seen.add(id);
		const p = byId.get(id);
		if (!p) continue;
		for (const dep of phases) {
			if (dependenciesOf(dep).includes(id) && !seen.has(dep.id)) queue.push(dep.id);
		}
	}
	return Array.from(seen).sort();
}

/** Fork a prior run into a NEW child RunState for resume. The child gets a fresh
 *  runId + `parentRunId` pointing at the parent; the parent is never mutated.
 *
 *  - With `overrides`: the child def is patched (overrides applied to the target
 *    phase); the target + its transitive downstream are cleared (removed) so
 *    they re-run; other `done` phases are copied (within-run resume cache hits).
 *  - Without `overrides` (ordinary resume): the child def is a deep clone of the
 *    parent def; ALL `done` phases are copied; non-done (failed/paused/running)
 *    phases are omitted so the runtime re-runs them.
 *
 *  `prev` is never mutated. Returns the child RunState (ready for
 *  `executeTaskflow`). */
export function forkRunForResume(
	prev: RunState,
	opts: { overrides?: ResumeOverrides; cwd?: string } = {},
): RunState {
	const ov = opts.overrides;
	const childDef: Taskflow = ov ? applyResumeOverrides(prev.def, ov) : structuredClone(prev.def);
	// Phases to clear (re-run): the target + its transitive downstream (when
	// overrides are supplied). Without overrides, nothing is force-cleared here —
	// non-done phases are simply omitted and the runtime re-runs them.
	const clearSet = new Set<string>();
	if (ov) {
		clearSet.add(ov.phaseId);
		for (const id of transitiveDownstream(prev.def.phases, ov.phaseId)) clearSet.add(id);
	}
	const phases: Record<string, PhaseState> = {};
	for (const [id, ps] of Object.entries(prev.phases)) {
		if (clearSet.has(id)) continue; // re-run
		// Copy only completed (done) phases — failed/paused/running/skipped are
		// re-run by the runtime. Deep-clone so the child cannot mutate nested
		// usage/gate/read metadata retained by the immutable parent object.
		if (ps.status === "done") phases[id] = structuredClone(ps);
	}
	const build = getBuildInfo();
	return {
		runId: newRunId(prev.flowName),
		flowName: prev.flowName,
		def: childDef,
		args: structuredClone(prev.args),
		status: "running",
		phases,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: opts.cwd ?? prev.cwd,
		parentRunId: prev.runId,
		// Preserve workspace provenance/authority so a resume cannot silently
		// escape or downgrade the parent's cwd boundary.
		...(prev.invocationRootSnapshot !== undefined ? { invocationRootSnapshot: structuredClone(prev.invocationRootSnapshot) } : {}),
		...(prev.cwdRootBinding !== undefined ? { cwdRootBinding: structuredClone(prev.cwdRootBinding) } : {}),
		// The child is executed by the CURRENT build while retaining the host.
		...(prev.host !== undefined ? { host: prev.host } : {}),
		packageVersion: build.packageVersion,
		gitCommit: build.gitCommit,
		schemaVersion: build.schemaVersion,
	};
}
