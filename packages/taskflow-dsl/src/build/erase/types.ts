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
	/** Source-level variable binding. May differ from the emitted phase id. */
	binding?: string;
	type: string;
	raw: Record<string, unknown>;
	dependsOn: Set<string>;
	final?: boolean;
}

const BINDING_PREFIX = "\u0000binding:";

export function setPhaseBinding(phases: Map<string, PhaseDraft>, binding: string, draft: PhaseDraft): void {
	phases.set(`${BINDING_PREFIX}${binding}`, draft);
}

export function phaseByBinding(phases: Map<string, PhaseDraft>, binding: string): PhaseDraft | undefined {
	return phases.get(`${BINDING_PREFIX}${binding}`) ?? phases.get(binding);
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
	"gateAutomated",
	"gateScored",
	"reduce",
	"approval",
	"subflow",
	"loop",
	"tournament",
	"script",
	"race",
	"expand",
]);
