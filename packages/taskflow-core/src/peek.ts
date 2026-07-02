/**
 * Peek — post-hoc inspection of a run's intermediate phase outputs.
 *
 * The runtime's context-isolation contract only returns the FINAL phase output
 * to the host conversation; every intermediate transcript stays in the
 * persisted RunState. Peek is the explicit, human-invoked escape hatch for
 * debugging: read one phase's output from a stored run, hard-truncated so a
 * peek can never flood the caller's context window.
 *
 * Exposed as `/tf peek <runId> <phaseId>` (pi) and `taskflow_peek` (codex MCP).
 * Read-only: never mutates run state.
 */

import type { PhaseState, RunState } from "./store.ts";
import { loadRun } from "./store.ts";

/** Default hard cap on peeked text (chars). */
export const PEEK_DEFAULT_LIMIT = 4000;
/** Ceiling a caller may raise the limit to. */
export const PEEK_MAX_LIMIT = 32000;

export interface PeekOptions {
	/** Phase to inspect. Omit to get a phase listing for the run. */
	phaseId?: string;
	/** Return the parsed JSON (`ps.json`) instead of the text output. */
	json?: boolean;
	/** For map/parallel phases: extract the 1-based n-th item's section. */
	item?: number;
	/** Truncation cap in chars (default PEEK_DEFAULT_LIMIT, max PEEK_MAX_LIMIT). */
	limit?: number;
}

export interface PeekResult {
	ok: boolean;
	/** Human-readable peeked content (or the error / listing). */
	text: string;
	truncated?: boolean;
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return PEEK_DEFAULT_LIMIT;
	return Math.min(Math.floor(limit), PEEK_MAX_LIMIT);
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	return { text: `${text.slice(0, limit)}\n… [truncated at ${limit} chars — total ${text.length}]`, truncated: true };
}

function fmtStatus(ps: PhaseState): string {
	const bits: string[] = [ps.status];
	if (ps.timedOut) bits.push("timed-out");
	if (ps.cacheHit) bits.push(`cache:${ps.cacheHit}`);
	if (ps.gate) bits.push(`gate:${ps.gate.verdict}`);
	if (ps.subProgress) bits.push(`${ps.subProgress.done}/${ps.subProgress.total} items`);
	return bits.join(" · ");
}

function listPhases(state: RunState): string {
	const lines = state.def.phases.map((p) => {
		const ps = state.phases[p.id];
		const status = ps ? fmtStatus(ps) : "pending";
		const size = ps?.output ? ` — ${ps.output.length} chars` : "";
		return `  ${p.id} [${status}]${size}`;
	});
	return `Run ${state.runId} (${state.flowName}) — ${state.status}\n\nPhases:\n${lines.join("\n")}\n\nPeek one with: peek ${state.runId} <phaseId>`;
}

/** Split a merged map/parallel output back into its labelled item sections,
 *  keyed by the 1-based position parsed from each "### [k/N]" label — NOT by
 *  section order. mergePhaseState labels positionally but omits budget-skipped
 *  items entirely, so section order can have gaps; keying by label keeps
 *  `--item k` aligned with the original `over[k-1]`. */
function splitItems(merged: string): Map<number, string> {
	// mergePhaseState labels sections "### [k/N] <agent>" joined by "\n\n---\n\n".
	const out = new Map<number, string>();
	const parts = merged.split(/\n\n---\n\n(?=### \[\d+\/\d+\])/);
	for (const part of parts) {
		const m = part.match(/^### \[(\d+)\/\d+\]/);
		// First label wins on duplicates. Known limitation: an item whose CONTENT
		// embeds the separator + a fake label can shadow a later genuine section —
		// unambiguous splitting needs a collision-free separator in mergePhaseState
		// (tracked as follow-up). Labels keyed positionally so budget-skip gaps
		// never shift indices.
		if (m && !out.has(Number(m[1]))) out.set(Number(m[1]), part);
	}
	return out;
}

/**
 * Peek at a stored run. Pure read: loads the persisted RunState and formats
 * the requested slice, hard-truncated. Never throws on missing data — every
 * miss returns `{ok: false}` with an actionable message.
 */
export function peekRun(cwd: string, runId: string, opts: PeekOptions = {}): PeekResult {
	const state = loadRun(cwd, runId);
	if (!state) return { ok: false, text: `Run not found: ${runId} (see runs with /tf runs)` };

	if (!opts.phaseId) return { ok: true, text: listPhases(state) };

	const ps = state.phases[opts.phaseId];
	if (!ps) {
		const known = state.def.phases.map((p) => p.id).join(", ");
		return { ok: false, text: `Phase '${opts.phaseId}' not found in run ${runId}. Phases: ${known}` };
	}

	const limit = clampLimit(opts.limit);
	const header = `${runId} › ${ps.id} [${fmtStatus(ps)}]${ps.error ? `\nerror: ${ps.error.slice(0, 500)}` : ""}`;

	let body: string;
	if (opts.item !== undefined) {
		const items = splitItems(ps.output ?? "");
		if (items.size === 0) return { ok: false, text: `Phase '${ps.id}' has no item sections (not a map/parallel output).` };
		const idx = Math.floor(opts.item);
		const section = items.get(idx);
		if (section === undefined) {
			const available = [...items.keys()].sort((a, b) => a - b).join(", ");
			return { ok: false, text: `Item ${opts.item} not found for phase '${ps.id}' (available: ${available}; budget-skipped items have no section).` };
		}
		body = section;
	} else if (opts.json) {
		if (ps.json === undefined) return { ok: false, text: `Phase '${ps.id}' has no parsed JSON (set output:"json" on the phase, or peek the text output).` };
		try {
			body = JSON.stringify(ps.json, null, 2);
		} catch {
			body = String(ps.json);
		}
	} else {
		if (ps.output === undefined) return { ok: false, text: `Phase '${ps.id}' has no output (status: ${ps.status}).` };
		body = ps.output;
	}

	const t = truncate(body, limit);
	return { ok: true, text: `${header}\n\n${t.text}`, truncated: t.truncated };
}
