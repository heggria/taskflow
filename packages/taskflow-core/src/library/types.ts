/**
 * Library — reusable-flow asset layer types.
 *
 * The library lets taskflow accumulate, retrieve, and iteratively generalize
 * saved flows. Phase 1 (this module) defines the data shapes and the
 * host-neutral interfaces; the runtime logic (meta derivation, search ranking)
 * lives in `meta.ts` / `search.ts`, and persistence (sidecar `.meta.json`)
 * lives in `store.ts`.
 *
 * Design refs: docs/rfc-library-reuse.md (§3 data format, §4 embedder, §5
 * search). Embedding support is Phase 2 — Phase 1 ships with structural /
 * keyword search only and every embedding field is optional.
 */

import type { Taskflow } from "../schema.ts";

/** Library-side settings, nested under `settings.json → taskflow.library`. */
export interface LibrarySettings {
	/** Master switch. Default true. When false, search/save-meta are no-ops. */
	enabled: boolean;
	/** Which scopes to search: "project" | "user" | "both" (default both). */
	scope: "project" | "user" | "both";
	/** Optional blend weights for mixed search ranking (Phase 2). */
	searchWeights?: { semantic: number; structural: number; textual: number };
	/** Optional Phase-3 auto-prune threshold. */
	maxFlows?: number;
}

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
	enabled: true,
	scope: "both",
};

/** The sidecar `.meta.json` record. Persisted next to a flow file. */
export interface FlowMeta {
	schemaVersion: 1;

	/** Agent-provided (optional). */
	purpose?: string;
	tags?: string[];
	notes?: string;

	/** Auto-derived at save time. */
	phaseSignature: string;
	phaseCount: number;
	agentUsage: string[];
	generality: number;
	argShape?: Record<string, string>; // Phase 3 only; derived speculatively, not used in ranking

	/** Reuse flywheel. */
	reuseCount: number;
	lastUsedAt: number | null;
	createdAt: number;
	version: number;
	derivedFrom?: string; // "<name>@v<n>" lineage

	/** Embedding (Phase 2; always optional / may be null). */
	embeddingModel?: string;
	embeddingDim?: number;
	embedding?: number[] | null;
	embeddedAt?: number | null;
}

/** A candidate resolved for search: live-derived structural fields + trusted
 *  sidecar fields (purpose/tags/...) + embedding gated on signature match.
 *  (RFC §5.2.2 staleness detection.) */
export interface ResolvedCandidate {
	name: string;
	scope: "user" | "project";
	def: Taskflow;

	// live-derived (always fresh)
	phaseSignature: string;
	phaseCount: number;
	agentUsage: string[];
	generality: number;

	// from sidecar (trusted; agent-provided)
	purpose?: string;
	tags?: string[];
	notes?: string;
	reuseCount: number;
	version: number;
	derivedFrom?: string;

	// embedding: only trusted when signature matches the live-derived one
	embedding: number[] | null;
	embeddingStale: boolean;
}

export interface SearchResult {
	name: string;
	scope: "user" | "project";
	purpose?: string;
	tags?: string[];
	phaseSignature: string;
	phaseCount: number;
	generality: number;
	reuseCount: number;
	version: number;
	score: number;
	why: string;
	reuseHint: string;
}

export interface SearchResponse {
	results: SearchResult[];
	searchMode: "semantic" | "structural" | "mixed";
	embedder?: string;
	counts: { scanned: number; withVectors: number };
}

/** Input to searchLibrary(). */
export interface SearchInput {
	query: string;
	limit?: number; // default 5, max 20
	structureOnly?: boolean;
	minScore?: number; // 0-1
	scope?: "project" | "user" | "both";
	phaseSignatureHint?: string;
	phaseCountHint?: number;
}

/** The minimal host-neutral dependency the library functions need.
 *  Embedder is Phase 2; Phase 1 leaves it undefined and search degrades to
 *  structural/keyword (RFC §4.3, A2: stays OUT of RuntimeDeps). */
export interface LibraryDeps {
	embedder?: {
		embed(text: string): Promise<number[]>;
		readonly model: string;
		readonly dim: number;
	};
	settings: LibrarySettings;
	cwd: string;
}
