/**
 * Trusted Effects (0.3 MVP) — pure type contract.
 *
 * EffectIR is the closed vocabulary of side effects a FlowIR node may declare.
 * PathRef is reused from resources/*; SecretRef/ServiceRef are typed handles
 * that fail closed until a real backend is bound (MVP: type + validation only).
 *
 * @see docs/internal/0.3.0-trusted-effects-mvp.md
 */

import type { PathRef } from "../resources/schema.ts";

// ---------------------------------------------------------------------------
// Information-flow labels (MVP fixed lattice)
// ---------------------------------------------------------------------------

/** Confidentiality lattice (low → high). Higher may not flow to lower sinks. */
export const CONFIDENTIALITY_LABELS = ["public", "internal", "secret"] as const;
export type ConfidentialityLabel = (typeof CONFIDENTIALITY_LABELS)[number];

/** Integrity lattice (low → high). Lower integrity must not overwrite higher. */
export const INTEGRITY_LABELS = ["untrusted", "project", "verified"] as const;
export type IntegrityLabel = (typeof INTEGRITY_LABELS)[number];

export const CONFIDENTIALITY_RANK: Record<ConfidentialityLabel, number> = {
	public: 0,
	internal: 1,
	secret: 2,
};

export const INTEGRITY_RANK: Record<IntegrityLabel, number> = {
	untrusted: 0,
	project: 1,
	verified: 2,
};

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/**
 * Opaque secret handle — never carries secret material.
 * MVP: validation only; no vault backend.
 */
export interface SecretRef {
	secretId: string;
	issuer?: string;
}

/**
 * External service endpoint handle — no ambient network authority from strings.
 * MVP: validation only; no live adapter.
 */
export interface ServiceRef {
	serviceId: string;
	/** Optional logical operation name (e.g. "createIssue"). */
	operation?: string;
}

export type EffectTarget =
	| { kind: "path"; path: PathRef }
	| { kind: "secret"; secret: SecretRef }
	| { kind: "service"; service: ServiceRef };

// ---------------------------------------------------------------------------
// Effect kinds (closed set for MVP)
// ---------------------------------------------------------------------------

export const EFFECT_KINDS = [
	"fs.read",
	"fs.write",
	"fs.delete",
	"secret.read",
	"service.call",
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

/**
 * One declared side effect on a FlowIR / phase node.
 * `id` is stable within the flow for why-effect attribution.
 */
export interface EffectDecl {
	id: string;
	kind: EffectKind;
	target: EffectTarget;
	confidentiality?: ConfidentialityLabel;
	integrity?: IntegrityLabel;
	/** Free-text purpose for why-* explainers (not authority). */
	purpose?: string;
}

/** EffectIR: bag of effects attached to a node or whole flow. */
export interface EffectIR {
	effects: EffectDecl[];
}

// ---------------------------------------------------------------------------
// why-* records
// ---------------------------------------------------------------------------

export interface WhyAuthorized {
	effectId: string;
	allowed: boolean;
	principalId?: string;
	capabilityBindingIds: string[];
	reasons: string[];
}

export interface WhyContext {
	effectId: string;
	runId: string;
	phaseId?: string;
	confidentiality: ConfidentialityLabel;
	integrity: IntegrityLabel;
	workspaceRoot?: string;
	reasons: string[];
}

export interface WhyEffect {
	effectId: string;
	kind: EffectKind;
	targetSummary: string;
	purpose?: string;
	intentId?: string;
	journalStatus?: string;
	status: "declared" | "staged" | "committed" | "rejected" | "unknown" | "skipped";
	reasons: string[];
	authorized: WhyAuthorized;
	context: WhyContext;
}
