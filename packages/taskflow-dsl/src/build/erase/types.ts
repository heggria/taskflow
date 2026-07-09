/**
 * Shared types for the AST erase pipeline.
 * Kept tiny so kind emitters and templates never import each other.
 */

import type { Diagnostic } from "../../diagnostics.ts";

export interface EraseResult {
	ok: boolean;
	taskflow?: Record<string, unknown>;
	diagnostics: Diagnostic[];
}

export interface PhaseDraft {
	id: string;
	type: string;
	raw: Record<string, unknown>;
	dependsOn: Set<string>;
	final?: boolean;
}

/** Mutable session state for one eraseSource() call. */
export interface EraseSession {
	file: string;
	sf: import("typescript").SourceFile;
	diags: Diagnostic[];
	phases: Map<string, PhaseDraft>;
	order: string[];
}

export const PHASE_RUNES = new Set([
	"agent",
	"parallel",
	"map",
	"gate",
	"reduce",
	"approval",
	"subflow",
	"loop",
	"tournament",
	"script",
	"race",
	"expand",
]);
