/**
 * Library — search ranking (structural + keyword; Phase 1).
 *
 * Phase 2 adds the embedding/cosine path; the seam (LibraryDeps.embedder) is
 * already in place but left unused here. When no embedder is configured OR
 * structureOnly is set, search degrades to keyword + structural ranking.
 *
 * Refs: docs/rfc-library-reuse.md §5.2 (blend), §5.2.1 (structScore),
 * §5.2.2 (staleness), §5.3 (why/reuseHint templates).
 */

import { getFlow, listFlows, readMeta } from "../store.ts";
import type { Taskflow } from "../schema.ts";
import type { FlowMeta } from "./types.ts";
import {
	computeGenerality,
	computePhaseSignature,
	countPhases,
	extractAgentUsage,
} from "./meta.ts";
import type {
	LibraryDeps,
	ResolvedCandidate,
	SearchInput,
	SearchResponse,
	SearchResult,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Levenshtein (RFC §5.2.1)
// ---------------------------------------------------------------------------

/** Standard Levenshtein edit distance (insert/delete/replace cost 1).
 *  O(m·n) DP; signature strings are short (<50 chars) so cost is negligible. */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const m = a.length;
	const n = b.length;
	// Two rolling rows; allocate fresh each call (signatures are tiny).
	let prev = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		const curr = new Array<number>(n + 1);
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		prev = curr;
	}
	return prev[n];
}

// ---------------------------------------------------------------------------
// Candidate resolution (RFC §5.2.2 staleness detection)
// ---------------------------------------------------------------------------

/** Resolve a saved flow + its sidecar into a candidate whose structural fields
 *  are ALWAYS freshly derived from the current def, and whose embedding is only
 *  trusted when the sidecar's phaseSignature matches the fresh one. */
export function resolveCandidate(
	def: Taskflow,
	scope: "user" | "project",
	name: string,
	sidecar: FlowMeta | undefined,
): ResolvedCandidate {
	const freshSig = computePhaseSignature(def);
	const freshGen = computeGenerality(def);
	const freshAgents = extractAgentUsage(def);
	const freshCount = countPhases(def);

	if (!sidecar) {
		return {
			name,
			scope,
			def,
			phaseSignature: freshSig,
			phaseCount: freshCount,
			agentUsage: freshAgents,
			generality: freshGen,
			reuseCount: 0,
			version: 1,
			embedding: null,
			embeddingStale: true,
		};
	}

	const sigMatch = sidecar.phaseSignature === freshSig;
	return {
		name,
		scope,
		def,
		phaseSignature: freshSig,
		phaseCount: freshCount,
		agentUsage: freshAgents,
		generality: freshGen,
		purpose: sidecar.purpose,
		tags: sidecar.tags,
		notes: sidecar.notes,
		reuseCount: sidecar.reuseCount ?? 0,
		version: sidecar.version ?? 1,
		derivedFrom: sidecar.derivedFrom,
		embedding: sigMatch ? sidecar.embedding ?? null : null,
		embeddingStale: !sigMatch,
	};
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** structScore ∈ [0,1]. RFC §5.2.1: 0.7*sigSim + 0.3*countPenalty. */
function computeStructScore(
	query: { phaseSignature: string; phaseCount: number },
	cand: { phaseSignature: string; phaseCount: number },
): number {
	let sigSim = 0;
	if (cand.phaseSignature && query.phaseSignature) {
		const d = levenshtein(query.phaseSignature, cand.phaseSignature);
		const denom = Math.max(query.phaseSignature.length, cand.phaseSignature.length, 1);
		sigSim = 1 - d / denom;
		if (sigSim < 0) sigSim = 0;
	}
	let countPenalty = 0;
	if (query.phaseCount > 0 && cand.phaseCount > 0) {
		const diff = Math.abs(query.phaseCount - cand.phaseCount);
		countPenalty = 1 - Math.min(1, diff / Math.max(query.phaseCount, cand.phaseCount));
	}
	return 0.7 * sigSim + 0.3 * countPenalty;
}

/** textScore ∈ [0,1]. Token-overlap between query and the flow's text fields
 *  (name + purpose + tags + phase task text). CJK-aware: queries tokenized on
 *  whitespace AND matched as substrings, so a Chinese query token like "鉴权"
 *  still matches a purpose containing "...缺少鉴权检查..." (which whitespace
 *  alone would never split out). */
function computeTextScore(queryTokens: string[], cand: {
	name: string;
	purpose?: string;
	tags?: string[];
	phaseTaskText: string;
}): number {
	if (queryTokens.length === 0) return 0;
	const fieldText = (
		(cand.name ?? "") +
		" " +
		(cand.purpose ?? "") +
		" " +
		(cand.tags ?? []).join(" ") +
		" " +
		cand.phaseTaskText
	).toLowerCase();
	if (!fieldText.trim()) return 0;
	// Substring match per query token (CJK-friendly). Longer tokens weigh more
	// (they carry more signal) so e.g. a 2-char Chinese term counts more than a
	// 2-char English one only marginally; this keeps the [0,1] shape intuitive.
	let hits = 0;
	for (const t of queryTokens) {
		if (!t) continue;
		if (fieldText.includes(t)) hits++;
	}
	return hits / queryTokens.length;
}

function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 1);
}

function phaseTaskText(def: Taskflow): string {
	if (!Array.isArray(def.phases)) return "";
	const parts: string[] = [];
	for (const p of def.phases) {
		if (typeof p.task === "string") parts.push(p.task);
		if (Array.isArray((p as { branches?: unknown }).branches)) {
			for (const b of (p as { branches?: Array<{ task?: string }> }).branches ?? []) {
				if (b?.task) parts.push(b.task);
			}
		}
	}
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// why / reuseHint templates (RFC §5.3, Tier 1, zero-token)
// ---------------------------------------------------------------------------

function buildWhy(s: {
	semScore?: number;
	structScore: number;
	textScore: number;
	searchMode: "semantic" | "structural" | "mixed";
}): string {
	const hits: string[] = [];
	if ((s.searchMode === "semantic" || s.searchMode === "mixed") && s.semScore != null && s.semScore > 0.7) {
		hits.push(`语义命中(sem=${s.semScore.toFixed(2)})`);
	}
	if (s.structScore > 0.8) hits.push(`结构一致(struct=${s.structScore.toFixed(2)})`);
	if (s.textScore > 0.3) hits.push(`关键词匹配(text=${s.textScore.toFixed(2)})`);
	return hits.length > 0 ? hits.join(" + ") : "低分命中，建议检查";
}

function buildReuseHint(r: { score: number; argCount: number }): string {
	if (r.score >= 0.8) return `直接复用${r.argCount > 0 ? `，注意 ${r.argCount} 个 args 参数` : ""}`;
	if (r.score >= 0.5) return `结构相似，建议 copy + 泛化后使用`;
	return `低相关度，建议从头编写或大幅改写`;
}

// ---------------------------------------------------------------------------
// searchLibrary
// ---------------------------------------------------------------------------

function argCountOf(def: Taskflow): number {
	return def.args && typeof def.args === "object" ? Object.keys(def.args as Record<string, unknown>).length : 0;
}

/** Search the library. Returns ranked top-N. Degrades to structural/keyword
 *  when no embedder is configured or structureOnly is requested. */
export async function searchLibrary(deps: LibraryDeps, input: SearchInput): Promise<SearchResponse> {
	const limit = Math.min(20, Math.max(1, input.limit ?? 5));
	const minScore = input.minScore ?? 0;
	const scope = input.scope ?? deps.settings.scope ?? "both";

	// gather candidates
	const flows = listFlows(deps.cwd).filter((f) => {
		if (scope === "both") return true;
		return f.scope === scope;
	});

	const queryTokens = tokenize(input.query);

	// embed the query if an embedder is available and not structureOnly
	let queryVec: number[] | null = null;
	const hasEmbedder = !!deps.embedder && !input.structureOnly;
	if (hasEmbedder && deps.embedder) {
		try {
			queryVec = await deps.embedder.embed(input.query);
		} catch {
			queryVec = null; // degrade
		}
	}

	const scored: Array<{ cand: ResolvedCandidate; score: number; semScore?: number; structScore: number; textScore: number }> = [];
	for (const f of flows) {
		const sidecarR = readMeta(deps.cwd, f.name);
		const sidecar = sidecarR.ok ? sidecarR.value : undefined;
		const cand = resolveCandidate(f.def, f.scope, f.name, sidecar);
		const qShape = {
			phaseSignature: input.phaseSignatureHint ?? "",
			phaseCount: input.phaseCountHint ?? 0,
		};
		const structScore = computeStructScore(qShape, cand);
		const textScore = computeTextScore(queryTokens, {
			name: cand.name,
			purpose: cand.purpose,
			tags: cand.tags,
			phaseTaskText: phaseTaskText(cand.def),
		});

		let score: number;
		let semScore: number | undefined;
		const hasVectors = queryVec != null && cand.embedding != null && !cand.embeddingStale;
		if (hasVectors && queryVec && cand.embedding) {
			semScore = cosine(queryVec, cand.embedding);
			score = 0.6 * semScore + 0.25 * structScore + 0.15 * textScore;
		} else {
			score = 0.6 * textScore + 0.4 * structScore;
		}
		if (score < minScore) continue;
		if (score <= 0) continue; // zero-relevance results are noise; don't surface them
		scored.push({ cand, score: Math.round(score * 100) / 100, semScore, structScore, textScore });
	}

	scored.sort((a, b) => b.score - a.score);
	const top = scored.slice(0, limit);

	const withVectors = top.filter((s) => s.cand.embedding != null && !s.cand.embeddingStale).length;
	let searchMode: "semantic" | "structural" | "mixed";
	if (input.structureOnly || !deps.embedder || withVectors === 0) searchMode = "structural";
	else if (withVectors === top.length) searchMode = "semantic";
	else searchMode = "mixed";

	const results: SearchResult[] = top.map((s) => ({
		name: s.cand.name,
		scope: s.cand.scope,
		purpose: s.cand.purpose,
		tags: s.cand.tags,
		phaseSignature: s.cand.phaseSignature,
		phaseCount: s.cand.phaseCount,
		generality: s.cand.generality,
		reuseCount: s.cand.reuseCount,
		version: s.cand.version,
		score: s.score,
		why: buildWhy({ semScore: s.semScore, structScore: s.structScore, textScore: s.textScore, searchMode }),
		reuseHint: buildReuseHint({ score: s.score, argCount: argCountOf(s.cand.def) }),
	}));

	return {
		results,
		searchMode,
		embedder: deps.embedder?.model,
		counts: { scanned: flows.length, withVectors },
	};
}

/** Pure cosine similarity. Zero-dep. Accepts non-normalized vectors. */
export function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	if (n === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < n; i++) {
		const x = a[i];
		const y = b[i];
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Bump reuseCount for a flow by name (RFC §6 reuse flywheel).
 *  Phase 1: structural-only; the caller (tool handler) decides whether to
 *  bump based on a `reusedFromSearch` flag. Returns the new count or null if
 *  the flow has no sidecar yet. The actual sidecar write is done by
 *  `bumpReuseInSidecar` in store.ts under withLock. */
export { getFlow };
