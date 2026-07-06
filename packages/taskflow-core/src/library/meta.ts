/**
 * Library — auto-derived structural metadata.
 *
 * Computed at save time (zero tokens, deterministic) and re-derived live at
 * search time (RFC §5.2.2 staleness). No embedding logic here — that's Phase 2.
 *
 * Refs: docs/rfc-library-reuse.md §3.2 (phaseSignature), §3.3 (generality).
 */

import type { Taskflow } from "../schema.ts";
import { topoLayers } from "../schema.ts";
import type { FlowMeta } from "./types.ts";

/** Topological phase-type signature, e.g. "agent→map→gate→reduce".
 *  Parallel same-layer phases joined with "+". Uses topoLayers() for
 *  deterministic ordering. */
export function computePhaseSignature(def: Taskflow): string {
	if (!Array.isArray(def.phases) || def.phases.length === 0) return "";
	const layers = topoLayers(def.phases);
	return layers
		.map((layer) => layer.map((p) => p.type ?? "agent").join("+"))
		.join("→");
}

export function countPhases(def: Taskflow): number {
	return Array.isArray(def.phases) ? def.phases.length : 0;
}

/** Distinct agent names referenced across phases (sorted, stable). */
export function extractAgentUsage(def: Taskflow): string[] {
	if (!Array.isArray(def.phases)) return [];
	const set = new Set<string>();
	for (const p of def.phases) {
		if (typeof p.agent === "string" && p.agent.trim()) set.add(p.agent.trim());
		// parallel branches
		if (Array.isArray((p as { branches?: unknown }).branches)) {
			for (const b of (p as { branches?: Array<{ agent?: unknown }> }).branches ?? []) {
				if (b && typeof b.agent === "string" && b.agent.trim()) set.add(b.agent.trim());
			}
		}
	}
	return Array.from(set).sort();
}

/** The literal-vs-placeholder character accounting used by generality.
 *  Counts literal chars and placeholder chars across phase task/over/run/input. */
interface ContentAccount {
	literalChars: number;
	placeholderChars: number;
	placeholderRefs: number;
	argCount: number;
	hasDescription: boolean;
	productionKnobs: number;
}

const PLACEHOLDER_RE = /\{(args|steps|item|previous|loop|reflexion)(\.[^}]{1,200})?\}/g;

function accountContent(def: Taskflow): ContentAccount {
	const acc: ContentAccount = {
		literalChars: 0,
		placeholderChars: 0,
		placeholderRefs: 0,
		argCount: 0,
		hasDescription: typeof def.description === "string" && def.description.trim().length > 0,
		productionKnobs: 0,
	};

	// args
	if (def.args && typeof def.args === "object") {
		acc.argCount = Object.keys(def.args as Record<string, unknown>).length;
	}

	// production knobs (cap 0.15, each +0.05)
	if (def.budget) acc.productionKnobs += 0.05;
	if (def.concurrency && typeof def.concurrency === "number") acc.productionKnobs += 0.05;
	let sawRetry = false;
	let sawExpect = false;
	if (Array.isArray(def.phases)) {
		for (const p of def.phases) {
			if (p.retry) sawRetry = true;
			if ((p as { expect?: unknown }).expect) sawExpect = true;
		}
	}
	if (sawRetry) acc.productionKnobs += 0.05;
	if (sawExpect) acc.productionKnobs += 0.05;
	acc.productionKnobs = Math.min(0.15, acc.productionKnobs);

	// scan phase string fields for literals vs placeholders
	const scan = (s: unknown): void => {
		if (typeof s !== "string") return;
		PLACEHOLDER_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		let lastEnd = 0;
		let placeholderCharsThis = 0;
		let placeholderRefsThis = 0;
		while ((m = PLACEHOLDER_RE.exec(s)) !== null) {
			// literal chunk before this placeholder
			acc.literalChars += m.index - lastEnd;
			placeholderCharsThis += m[0].length;
			placeholderRefsThis += 1;
			lastEnd = m.index + m[0].length;
		}
		acc.literalChars += s.length - lastEnd;
		acc.placeholderChars += placeholderCharsThis;
		acc.placeholderRefs += placeholderRefsThis;
	};

	if (Array.isArray(def.phases)) {
		for (const p of def.phases) {
			scan(p.task);
			scan((p as { over?: unknown }).over);
			scan((p as { run?: unknown }).run);
			scan((p as { input?: unknown }).input);
			// parallel branch tasks
			if (Array.isArray((p as { branches?: unknown }).branches)) {
				for (const b of (p as { branches?: Array<{ task?: unknown }> }).branches ?? []) {
					scan(b?.task);
				}
			}
		}
	}
	return acc;
}

/** generality ∈ [0,1]. RFC §3.3 (v2 formula, A8 fix):
 *  uses literalTokenRatio = literalChars/(literalChars+placeholderChars)
 *  so verbose-but-parameterized flows aren't structurally penalized. */
export function computeGenerality(def: Taskflow): number {
	const a = accountContent(def);
	const totalChars = a.literalChars + a.placeholderChars;
	const literalTokenRatio = totalChars > 0 ? a.literalChars / totalChars : 1;
	let g =
		0.4 * (1 - literalTokenRatio) +
		0.3 * Math.min(1, a.argCount / 3) +
		0.3 * (a.hasDescription ? 0.3 : 0) +
		a.productionKnobs;
	if (g < 0) g = 0;
	if (g > 1) g = 1;
	return Math.round(g * 100) / 100;
}

/** Build a fresh FlowMeta from a def + optional agent-provided fields.
 *  Used at save time. reuseCount starts at 0; version starts at 1. */
export function deriveMeta(
	def: Taskflow,
	opts: { purpose?: string; tags?: string[]; notes?: string; derivedFrom?: string; prevMeta?: FlowMeta },
): FlowMeta {
	const now = Date.now();
	const prev = opts.prevMeta;
	return {
		schemaVersion: 1,
		purpose: opts.purpose,
		tags: opts.tags,
		notes: opts.notes,
		phaseSignature: computePhaseSignature(def),
		phaseCount: countPhases(def),
		agentUsage: extractAgentUsage(def),
		generality: computeGenerality(def),
		reuseCount: prev?.reuseCount ?? 0,
		lastUsedAt: prev?.lastUsedAt ?? null,
		createdAt: prev?.createdAt ?? now,
		version: prev ? prev.version + 1 : 1,
		derivedFrom: opts.derivedFrom,
		embedding: prev?.embedding ?? null,
		embeddingModel: prev?.embeddingModel,
		embeddingDim: prev?.embeddingDim,
		embeddedAt: prev?.embeddedAt ?? null,
	};
}
