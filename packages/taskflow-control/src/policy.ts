/**
 * Policy overlay compiler + evaluator (P1 / P2 / §14).
 *
 * Effective authority = host ∩ user ∩ project ∩ invocation.
 * Empty policy → host-default attenuated exposure (never unrestricted).
 * Security-unknown fields fail closed.
 */
import { hashRequest, stableStringify } from "./hash.ts";

/** Capability tokens (narrowable; never enlarged by lower layers). */
export type CapabilityToken =
	| "link"
	| "admit"
	| "observe"
	| "cancel"
	| "approve"
	| "network"
	| "cross-project"
	| "domain-transfer"
	| "force-release"
	| "provider-submit"
	| string;

export type PolicyOp = "deny" | "substitute" | "attenuate";

export interface PolicyRule {
	/** Capability or prefix (e.g. "provider-submit"). */
	capability: string;
	op: PolicyOp;
	/** For substitute: replacement capability (must already be allowed at higher layer). */
	substituteWith?: string;
	/** For attenuate: narrower grant token / path prefix. */
	attenuateTo?: string;
	/** Optional human note. */
	reason?: string;
}

export interface PolicyOverlay {
	/** Layer name for audit. */
	layer: "host" | "user" | "project" | "invocation";
	rules: PolicyRule[];
	/** Explicit allow-list; when empty + no rules, use empty-policy exposure. */
	allow?: CapabilityToken[];
}

export interface Exposure {
	/** Effective allowed capabilities after overlay stack. */
	allowed: CapabilityToken[];
	/** Denied (including unknown fail-closed). */
	denied: CapabilityToken[];
	/** Digest of effective policy for BoundPlan / CommandRecord. */
	policyHash: string;
	/** Digest of exposure set. */
	exposureHash: string;
	/** True when no explicit project/user policy was supplied (P2). */
	emptyPolicy: boolean;
}

/** Host-default attenuated set (P2): public surface only; no network/cross-project/DomainTransfer. */
export const HOST_DEFAULT_EXPOSURE: readonly CapabilityToken[] = Object.freeze([
	"link",
	"admit",
	"observe",
	"cancel",
	"approve",
	"provider-submit",
]);

const ALWAYS_DENY: readonly CapabilityToken[] = Object.freeze([
	"domain-transfer",
	"network",
	"cross-project",
]);

export interface CompilePolicyInput {
	host?: PolicyOverlay;
	user?: PolicyOverlay;
	project?: PolicyOverlay;
	invocation?: PolicyOverlay;
	/** Requested capabilities for this admit (defaults to host default). */
	requested?: CapabilityToken[];
}

export type PolicyDecision =
	| { ok: true; exposure: Exposure }
	| { ok: false; reason: string; denied: CapabilityToken[]; exposure: Exposure };

/**
 * Compile stacked overlays into an Exposure.
 * Lower layers can only deny/substitute/attenuate — never enlarge the set.
 */
export function compilePolicy(input: CompilePolicyInput = {}): PolicyDecision {
	const layers: PolicyOverlay[] = [];
	if (input.host) layers.push(input.host);
	if (input.user) layers.push(input.user);
	if (input.project) layers.push(input.project);
	if (input.invocation) layers.push(input.invocation);

	const emptyPolicy =
		!input.user?.rules?.length &&
		!input.user?.allow?.length &&
		!input.project?.rules?.length &&
		!input.project?.allow?.length;

	// Start from host allow or host-default attenuated (P2).
	let allowed = new Set<CapabilityToken>(
		input.host?.allow?.length ? input.host.allow : HOST_DEFAULT_EXPOSURE,
	);

	// Host rules first
	if (input.host?.rules?.length) {
		allowed = applyRules(allowed, input.host.rules);
	}

	// Each subsequent layer can only shrink / substitute within parent set
	for (const layer of [input.user, input.project, input.invocation]) {
		if (!layer) continue;
		if (layer.allow?.length) {
			// Intersection only — never enlarge
			const next = new Set<CapabilityToken>();
			for (const c of layer.allow) {
				if (allowed.has(c)) next.add(c);
			}
			allowed = next;
		}
		if (layer.rules?.length) {
			allowed = applyRules(allowed, layer.rules);
		}
	}

	// Hard deny always-forbidden capabilities (DomainTransfer etc.)
	for (const d of ALWAYS_DENY) {
		allowed.delete(d);
	}

	const requested = input.requested ?? [...HOST_DEFAULT_EXPOSURE];
	const denied: CapabilityToken[] = [];
	const effective: CapabilityToken[] = [];
	for (const r of requested) {
		if (!allowed.has(r) || ALWAYS_DENY.includes(r as CapabilityToken)) {
			denied.push(r);
		} else {
			effective.push(r);
		}
	}

	// Unknown capabilities in requested that are not in host default → deny (fail-closed)
	for (const r of requested) {
		if (
			!HOST_DEFAULT_EXPOSURE.includes(r) &&
			!ALWAYS_DENY.includes(r as CapabilityToken) &&
			!allowed.has(r)
		) {
			if (!denied.includes(r)) denied.push(r);
		}
	}

	const exposureBody = {
		allowed: [...allowed].sort(),
		emptyPolicy,
		layers: layers.map((l) => ({ layer: l.layer, rules: l.rules, allow: l.allow ?? [] })),
	};
	const policyHash = `pol:${hashRequest(exposureBody)}`;
	const exposureHash = `exp:${hashRequest({ allowed: [...allowed].sort() })}`;

	const exposure: Exposure = {
		allowed: [...allowed].sort(),
		denied: [...new Set(denied)].sort(),
		policyHash,
		exposureHash,
		emptyPolicy,
	};

	if (denied.length > 0) {
		return {
			ok: false,
			reason: `policy denied capabilities: ${denied.join(", ")}`,
			denied,
			exposure,
		};
	}
	return { ok: true, exposure };
}

/** Evaluate whether a single capability is allowed under exposure. */
export function evaluateCapability(exposure: Exposure, capability: CapabilityToken): boolean {
	if (ALWAYS_DENY.includes(capability as CapabilityToken)) return false;
	return exposure.allowed.includes(capability);
}

function applyRules(allowed: Set<CapabilityToken>, rules: PolicyRule[]): Set<CapabilityToken> {
	const next = new Set(allowed);
	for (const rule of rules) {
		if (rule.op === "deny") {
			next.delete(rule.capability);
			// Prefix deny
			for (const c of [...next]) {
				if (c.startsWith(rule.capability + ":") || c === rule.capability) next.delete(c);
			}
			continue;
		}
		if (rule.op === "substitute") {
			if (!rule.substituteWith) {
				// Unknown substitute target → fail closed: remove
				next.delete(rule.capability);
				continue;
			}
			if (!next.has(rule.substituteWith) && !allowed.has(rule.substituteWith)) {
				// Cannot substitute to something not already allowed at this layer's parent
				next.delete(rule.capability);
				continue;
			}
			if (next.has(rule.capability)) {
				next.delete(rule.capability);
				next.add(rule.substituteWith);
			}
			continue;
		}
		if (rule.op === "attenuate") {
			if (!rule.attenuateTo) {
				next.delete(rule.capability);
				continue;
			}
			// Attenuate never enlarges: only if base capability present
			if (next.has(rule.capability)) {
				next.delete(rule.capability);
				next.add(rule.attenuateTo);
			}
			continue;
		}
		// Unknown op → fail closed remove capability
		next.delete(rule.capability);
	}
	return next;
}

/** Stable policy descriptor for debugging / tests. */
export function policyDebugString(exposure: Exposure): string {
	return stableStringify({
		allowed: exposure.allowed,
		denied: exposure.denied,
		emptyPolicy: exposure.emptyPolicy,
		policyHash: exposure.policyHash,
		exposureHash: exposure.exposureHash,
	});
}
