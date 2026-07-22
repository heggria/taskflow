/**
 * Capability token grammar + grant narrowing (P1/P8).
 *
 * Tokens: bare (`admit`) or hierarchical (`provider-submit:script`).
 * Narrowing never enlarges: child must be equal-or-more-specific under parent.
 * Unsupported processIsolation=sandboxed → fail closed when host cannot sandbox.
 */
import { hashRequest } from "./hash.ts";

/** Capability token: `segment` or `segment:sub…` (no spaces, no `..`). */
const TOKEN_RE = /^[a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)*$/;

export function isValidCapabilityToken(token: string): boolean {
	if (typeof token !== "string" || token.length === 0 || token.length > 128) return false;
	if (token.includes("..") || token.includes("/") || token.includes("\\")) return false;
	return TOKEN_RE.test(token);
}

/**
 * True when `grant` is covered by `ceiling` (equal or more specific).
 * e.g. ceiling `provider-submit` covers `provider-submit:script`.
 * Ceiling never covers a sibling or parent of a more specific grant.
 */
export function grantCoveredBy(grant: string, ceiling: string): boolean {
	if (!isValidCapabilityToken(grant) || !isValidCapabilityToken(ceiling)) return false;
	if (grant === ceiling) return true;
	return grant.startsWith(ceiling + ":");
}

/**
 * Narrow grants under a ceiling set. Invalid tokens drop (fail closed).
 * Result is sorted unique subset of input grants that are covered by some ceiling.
 */
export function narrowGrants(grants: string[], ceilings: string[]): string[] {
	const validCeilings = ceilings.filter(isValidCapabilityToken);
	const out = new Set<string>();
	for (const g of grants) {
		if (!isValidCapabilityToken(g)) continue;
		if (validCeilings.some((c) => grantCoveredBy(g, c))) {
			out.add(g);
		}
	}
	return [...out].sort();
}

// ---------------------------------------------------------------------------
// P8 orthogonal enforcement capabilities (RFC §15)
// ---------------------------------------------------------------------------

export const RESOLUTION_MODES = ["contained", "unbound"] as const;
export type ResolutionMode = (typeof RESOLUTION_MODES)[number];

export const MUTATION_MEDIATION_MODES = ["none", "brokered"] as const;
export type MutationMediation = (typeof MUTATION_MEDIATION_MODES)[number];

export const PROCESS_ISOLATION_MODES = ["none", "sandboxed"] as const;
export type ProcessIsolation = (typeof PROCESS_ISOLATION_MODES)[number];

export const REVOCATION_MODES = ["admission-only", "per-mutation", "bounded-latency"] as const;
export type RevocationMode = (typeof REVOCATION_MODES)[number];

export interface EnforcementCapabilities {
	resolution: ResolutionMode;
	mutationMediation: MutationMediation;
	processIsolation: ProcessIsolation;
	revocation: RevocationMode;
}

/** Host-default attenuated enforcement (no sandbox claim without support). */
export const DEFAULT_ENFORCEMENT: EnforcementCapabilities = Object.freeze({
	resolution: "contained",
	mutationMediation: "none",
	processIsolation: "none",
	revocation: "admission-only",
});

export type EnforcementDecision =
	| { ok: true; effective: EnforcementCapabilities; digest: string }
	| { ok: false; reason: string };

/**
 * Compile requested enforcement against host support.
 * Unsupported sandbox → fail closed (D11 / P8).
 */
export function compileEnforcement(
	requested: Partial<EnforcementCapabilities> | undefined,
	hostSupport: { sandboxAvailable: boolean },
): EnforcementDecision {
	const effective: EnforcementCapabilities = {
		resolution: requested?.resolution ?? DEFAULT_ENFORCEMENT.resolution,
		mutationMediation: requested?.mutationMediation ?? DEFAULT_ENFORCEMENT.mutationMediation,
		processIsolation: requested?.processIsolation ?? DEFAULT_ENFORCEMENT.processIsolation,
		revocation: requested?.revocation ?? DEFAULT_ENFORCEMENT.revocation,
	};

	if (!RESOLUTION_MODES.includes(effective.resolution)) {
		return { ok: false, reason: `unknown resolution mode: ${String(effective.resolution)}` };
	}
	if (!MUTATION_MEDIATION_MODES.includes(effective.mutationMediation)) {
		return { ok: false, reason: `unknown mutationMediation: ${String(effective.mutationMediation)}` };
	}
	if (!PROCESS_ISOLATION_MODES.includes(effective.processIsolation)) {
		return { ok: false, reason: `unknown processIsolation: ${String(effective.processIsolation)}` };
	}
	if (!REVOCATION_MODES.includes(effective.revocation)) {
		return { ok: false, reason: `unknown revocation: ${String(effective.revocation)}` };
	}

	if (effective.processIsolation === "sandboxed" && !hostSupport.sandboxAvailable) {
		return {
			ok: false,
			reason: "processIsolation=sandboxed unsupported on this host (fail closed)",
		};
	}

	const digest = `enf:${hashRequest(effective)}`;
	return { ok: true, effective, digest };
}
