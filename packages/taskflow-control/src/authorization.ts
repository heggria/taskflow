/**
 * Trusted local identity and P1/P2/P12 authorization.
 *
 * A protected bootstrap token proves possession of the local OS user's token,
 * not kernel-verified per-connection peer credentials. The bootstrap owner must
 * protect its directory/token (0700/0600); processes able to read that token act
 * as that user. This module neither grants network/domain transfer authority nor
 * replaces TE PathRef/permit checks. Policy callbacks must read current policy.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "taskflow-core/flowir/hash";
import { ControlError } from "./errors.ts";
import type { CommandKind } from "./schema/commands.ts";

export const AUTHORIZATION_CAPABILITIES = [
	"project.read", "run.submit", "run.cancel", "approval.decide", "coordinator.setMaxActiveRuns",
	"coordinator.forceRelease", "artifact.read",
] as const;
export type AuthorizationCapabilityKind = typeof AUTHORIZATION_CAPABILITIES[number];
export type AuthorizationCapability = { kind: AuthorizationCapabilityKind; scopeRoot: string };
export type AuthorizationPolicyLayer = {
	capabilities?: AuthorizationCapability[];
	deny?: AuthorizationCapabilityKind[];
	attenuate?: AuthorizationCapability[];
	substitute?: { capability: AuthorizationCapabilityKind; with: AuthorizationCapability }[];
};
export type LiveAuthorizationPolicy = {
	host: AuthorizationPolicyLayer;
	user?: AuthorizationPolicyLayer;
	project?: AuthorizationPolicyLayer;
	invocation?: AuthorizationPolicyLayer;
	revokedPrincipals?: string[];
};
export type AuthorizationBinding = { projectId: string; controlDomainId: string; projectRoot: string };
declare const verifiedContextBrand: unique symbol;
/** No serializable identity fields. Only the issuing authority recognizes it. */
export type VerifiedContext = { readonly [verifiedContextBrand]: true };
export type AuthorizationChallenge = Readonly<{
	purpose: "taskflow.control.authentication"; version: 1;
	id: string; nonce: string; expiresAt: number; principal: string; binding: Readonly<AuthorizationBinding>;
}>;
export type AuthorizeOperation = "read" | "submit" | "replay" | "artifact";
export type AuthorizationCommandKind = CommandKind | "run.cancel";
export type AuthorizationRequest = AuthorizationBinding & {
	operation: AuthorizeOperation;
	commandKind?: AuthorizationCommandKind;
	resourcePath?: string;
	artifactDigest?: string;
};
export type AuthorizationDecision = Readonly<{
	principal: string;
	callerPrincipal: string;
	authorizationContextHash: string;
	capability: Readonly<AuthorizationCapability>;
	effectivePolicy: Readonly<{ hostBaseline: readonly AuthorizationCapabilityKind[]; layers: LiveAuthorizationPolicy; capability: Readonly<AuthorizationCapability> }>;
}>;
export interface AuthorizationAuthorityOptions {
	ownerUid: number;
	/** Trusted bootstrap issuer configuration, never an RPC body/client label. */
	credentialIssuerId?: string;
	bootstrapSecret: Uint8Array;
	/** Explicit, trusted host baseline; [] grants no capabilities. */
	hostBaseline: readonly AuthorizationCapabilityKind[];
	loadLivePolicy: (principal: string, binding: Readonly<AuthorizationBinding>) => unknown | Promise<unknown>;
	verifyArtifactReachability?: (principal: string, binding: Readonly<AuthorizationBinding>, digest: string, commandKind?: AuthorizationCommandKind) => boolean | Promise<boolean>;
	now?: () => number;
	challengeTtlMs?: number;
}
export interface AuthorizationAuthority {
	issueStandalone(binding: AuthorizationBinding): VerifiedContext;
	createChallenge(binding: AuthorizationBinding): AuthorizationChallenge;
	authenticate(challengeId: string, proof: string): VerifiedContext;
	identity(context: VerifiedContext): Readonly<{ principal: string; binding: Readonly<AuthorizationBinding> }>;
	revokeContext(context: VerifiedContext): void;
	authorize(context: VerifiedContext, request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

function denied(message: string): never { throw new ControlError("TF_POLICY_DENIED", message); }
function revoked(): never { throw new ControlError("TF_AUTHORITY_REVOKED", "verified context is absent, foreign, or revoked"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) denied("security object is required");
	const object = value as Record<string, unknown>;
	if (![Object.prototype, null].includes(Object.getPrototypeOf(object))) denied("security object prototype is unsupported");
	if (Object.keys(object).some((key) => !keys.includes(key))) denied("unknown security field");
	return object;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function kind(value: unknown): value is AuthorizationCapabilityKind {
	return (AUTHORIZATION_CAPABILITIES as readonly unknown[]).includes(value);
}
function contained(root: string, target: string): boolean {
	const suffix = relative(root, target);
	return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}
/** Resolve existing ancestors too, so a symlink cannot enlarge lexical scope. */
function canonicalPath(value: unknown): string {
	if (!text(value) || !isAbsolute(value) || value.includes("\0")) denied("absolute resource scope is required");
	let existing = resolve(value);
	const suffix: string[] = [];
	for (;;) {
		try { lstatSync(existing); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") denied("resource scope cannot be verified");
			const parent = dirname(existing);
			if (parent === existing) denied("resource scope cannot be verified");
			suffix.unshift(relative(parent, existing)); existing = parent;
			continue;
		}
		// An existing entry whose target cannot be resolved is not a missing
		// path: notably a dangling symlink must never inherit its parent's scope.
		try { return resolve(realpathSync(existing), ...suffix); }
		catch { denied("existing resource scope or symbolic link cannot be verified"); }
	}
}
function trustedBinding(value: unknown): Readonly<AuthorizationBinding> {
	const body = record(value, ["projectId", "controlDomainId", "projectRoot"]);
	if (!text(body.projectId) || !text(body.controlDomainId)) denied("project/domain identity is required");
	// A mount is an existing canonical root, not an unverified client path.
	const root = canonicalPath(body.projectRoot);
	try { if (realpathSync(root) !== root || !statSync(root).isDirectory()) denied("project root is not a canonical directory"); }
	catch { denied("project root must exist"); }
	return Object.freeze({ projectId: body.projectId, controlDomainId: body.controlDomainId, projectRoot: root });
}
function capability(value: unknown, root: string): AuthorizationCapability {
	const body = record(value, ["kind", "scopeRoot"]);
	if (!kind(body.kind)) denied("unknown capability");
	const scopeRoot = canonicalPath(body.scopeRoot);
	if (!contained(root, scopeRoot)) denied("policy cannot expand project scope");
	return { kind: body.kind, scopeRoot };
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) denied("security list is required"); return value; }
function freezePolicy(policy: LiveAuthorizationPolicy): LiveAuthorizationPolicy {
	function freeze(value: unknown): void {
		if (value && typeof value === "object") {
			for (const child of Object.values(value)) freeze(child);
			Object.freeze(value);
		}
	}
	freeze(policy); return policy;
}
function layer(value: unknown, root: string): AuthorizationPolicyLayer {
	const body = record(value, ["capabilities", "deny", "attenuate", "substitute"]);
	const result: AuthorizationPolicyLayer = {};
	for (const field of ["capabilities", "attenuate"] as const) {
		if (body[field] !== undefined) result[field] = array(body[field]).map((item) => capability(item, root));
	}
	if (body.deny !== undefined) result.deny = array(body.deny).map((item) => { if (!kind(item)) denied("unknown denied capability"); return item; });
	if (body.substitute !== undefined) result.substitute = array(body.substitute).map((item) => {
		const substitution = record(item, ["capability", "with"]);
		if (!kind(substitution.capability)) denied("unknown substitution capability");
		const replacement = capability(substitution.with, root);
		if (substitution.capability !== replacement.kind) denied("substitution cannot change command authority");
		return { capability: substitution.capability, with: replacement };
	});
	return result;
}
function livePolicy(value: unknown, root: string): LiveAuthorizationPolicy {
	const body = record(value, ["host", "user", "project", "invocation", "revokedPrincipals"]);
	const result: LiveAuthorizationPolicy = { host: layer(body.host, root) };
	for (const field of ["user", "project", "invocation"] as const) if (body[field] !== undefined) result[field] = layer(body[field], root);
	if (body.revokedPrincipals !== undefined) result.revokedPrincipals = array(body.revokedPrincipals).map((item) => { if (!text(item)) denied("invalid revoked principal"); return item; });
	return result;
}
function requestedCapability(request: AuthorizationRequest): AuthorizationCapabilityKind {
	if (request.commandKind !== undefined && !["run.submit", "run.cancel", "approval.decide", "coordinator.setMaxActiveRuns", "coordinator.forceRelease"].includes(request.commandKind)) denied("unknown command class");
	if (request.operation === "read") return "project.read";
	if (request.operation === "artifact") return "artifact.read";
	if ((request.operation === "submit" || request.operation === "replay") && request.commandKind !== undefined) return request.commandKind;
	return denied("unknown operation or command class");
}
/** Shared core canonical serialization, full SHA256 for wire audit fields. */
export function authorizationAuditHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
/** Client helper: caller obtains secret from protected bootstrap storage. */
export function answerAuthorizationChallenge(secret: Uint8Array, challenge: AuthorizationChallenge): string {
	return createHmac("sha256", secret).update(canonicalJson(challenge), "utf8").digest("hex");
}

export function createAuthorizationAuthority(options: AuthorizationAuthorityOptions): AuthorizationAuthority {
	if (!Number.isSafeInteger(options.ownerUid) || options.ownerUid < 0 || !process.getuid || options.ownerUid !== process.getuid()) {
		throw new ControlError("TF_BOOTSTRAP_FAILED", "local authorization requires the actual process OS uid");
	}
	if (!(options.bootstrapSecret instanceof Uint8Array) || options.bootstrapSecret.byteLength < 32) denied("protected bootstrap secret must have at least 256 bits");
	const secret = Buffer.from(options.bootstrapSecret);
	const baseline = new Set(array([...options.hostBaseline]).map((value) => { if (!kind(value)) denied("unknown host baseline capability"); return value; }));
	if (options.credentialIssuerId !== undefined && !/^[a-zA-Z0-9._-]{1,64}$/.test(options.credentialIssuerId)) denied("invalid trusted credential issuer");
	const principal = `os-user:${options.ownerUid}${options.credentialIssuerId === undefined ? "" : `/credential:${options.credentialIssuerId}`}`;
	const now = options.now ?? Date.now;
	const ttl = options.challengeTtlMs ?? 5_000;
	if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 60_000) denied("challenge lifetime must be bounded");
	const contexts = new WeakMap<object, Readonly<{ principal: string; binding: Readonly<AuthorizationBinding> }>>();
	const challenges = new Map<string, AuthorizationChallenge>();
	function issue(binding: Readonly<AuthorizationBinding>): VerifiedContext {
		const context = Object.freeze(Object.create(null)) as VerifiedContext;
		contexts.set(context, Object.freeze({ principal, binding })); return context;
	}
	function identity(context: VerifiedContext) {
		if (context === null || typeof context !== "object") return revoked();
		const verified = contexts.get(context); if (!verified) return revoked(); return verified;
	}
	return {
		issueStandalone: (binding) => issue(trustedBinding(binding)),
		createChallenge(binding) {
			const time = now();
			for (const [id, pending] of challenges) if (pending.expiresAt <= time) challenges.delete(id);
			if (challenges.size >= 256) denied("too many pending authentication challenges");
			const challenge: AuthorizationChallenge = Object.freeze({ purpose: "taskflow.control.authentication", version: 1, id: randomUUID(), nonce: randomBytes(32).toString("hex"), expiresAt: time + ttl, principal, binding: trustedBinding(binding) });
			challenges.set(challenge.id, challenge); return challenge;
		},
		authenticate(id, proof) {
			const challenge = challenges.get(id); challenges.delete(id);
			if (!challenge || challenge.expiresAt <= now() || typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) denied("authentication challenge is absent, expired, or invalid");
			const expected = Buffer.from(answerAuthorizationChallenge(secret, challenge), "hex");
			if (!timingSafeEqual(expected, Buffer.from(proof, "hex"))) denied("bootstrap token proof failed");
			return issue(challenge.binding);
		},
		identity,
		revokeContext(context) { contexts.delete(context); },
		async authorize(context, request) {
			const verified = identity(context);
			const body = { ...record(request, ["operation", "commandKind", "resourcePath", "artifactDigest", "projectId", "controlDomainId", "projectRoot"]) };
			if (body.projectId !== verified.binding.projectId || body.controlDomainId !== verified.binding.controlDomainId
				|| canonicalPath(body.projectRoot) !== verified.binding.projectRoot) denied("verified context does not authorize this project/domain");
			const operation = body.operation as AuthorizeOperation;
			const commandKind = body.commandKind as AuthorizationCommandKind | undefined;
			const requested = requestedCapability({ ...verified.binding, operation, commandKind });
			if (operation === "artifact" && commandKind === undefined) denied("artifact authorization requires its ledger command class");
			const requiredCapabilities: AuthorizationCapabilityKind[] = operation === "artifact" ? [requested, commandKind!] : [requested];
			for (const required of requiredCapabilities) if (!baseline.has(required)) denied("capability is outside the explicit host baseline");
			let path = canonicalPath(body.resourcePath ?? verified.binding.projectRoot);
			if (!contained(verified.binding.projectRoot, path)) denied("resource is outside the verified project");
			if (operation === "artifact") {
				if (!text(body.artifactDigest) || !options.verifyArtifactReachability) denied("artifact digest is not bearer authorization");
				try { if (!await options.verifyArtifactReachability(verified.principal, verified.binding, body.artifactDigest, commandKind)) denied("artifact is not reachable from an authorized ledger entry"); }
				catch { denied("artifact reachability is unavailable or denied"); }
			}
			// The policy read comes after any asynchronous reachability check, so a
			// revocation during that check cannot expose historical artifact bytes.
			let policy: LiveAuthorizationPolicy;
			try { policy = livePolicy(await options.loadLivePolicy(verified.principal, verified.binding), verified.binding.projectRoot); }
			catch (error) { if (error instanceof ControlError) throw error; return denied("current policy is unavailable"); }
			identity(context); // Revocation while awaiting a policy read must also deny.
			path = canonicalPath(body.resourcePath ?? verified.binding.projectRoot);
			if (canonicalPath(verified.binding.projectRoot) !== verified.binding.projectRoot || !contained(verified.binding.projectRoot, path)) denied("project/resource scope changed during authorization");
			if (policy.revokedPrincipals?.includes(verified.principal)) return revoked();
			let scopeRoot = verified.binding.projectRoot;
			for (const required of requiredCapabilities) {
				let substitution: string | undefined;
				for (const current of [policy.host, policy.user, policy.project, policy.invocation]) {
					if (!current) continue;
					if (current.deny?.includes(required)) denied("capability is denied by current policy");
					const attenuation = current.attenuate?.filter((entry) => entry.kind === required);
					for (const grant of [current.capabilities, attenuation?.length ? attenuation : undefined]) {
						if (grant === undefined) continue;
						// No attenuation entry for this kind means inheritance; an explicit
						// capabilities: [] always means deny everything.
						const candidates = grant.filter((entry) => entry.kind === required && contained(entry.scopeRoot, path));
						if (candidates.length === 0) denied("capability scope is absent or attenuated");
						const widest = candidates.sort((a, b) => a.scopeRoot.length - b.scopeRoot.length)[0]!;
						if (contained(scopeRoot, widest.scopeRoot)) scopeRoot = widest.scopeRoot;
					}
					for (const replacement of current.substitute ?? []) {
						if (replacement.capability !== required) continue;
						if (substitution !== undefined && substitution !== replacement.with.scopeRoot) denied("substitution conflict");
						substitution = replacement.with.scopeRoot;
						if (!contained(scopeRoot, substitution) || !contained(substitution, path)) denied("substitution cannot expand effective scope");
						scopeRoot = substitution;
					}
				}
			}
			const effectiveCapability = Object.freeze({ kind: requested, scopeRoot });
			freezePolicy(policy);
			return Object.freeze({ principal: verified.principal, callerPrincipal: verified.principal,
				authorizationContextHash: authorizationAuditHash({ principal: verified.principal, binding: verified.binding, hostBaseline: [...baseline].sort(), policy, operation, commandKind, scopeRoot }),
				capability: effectiveCapability,
				effectivePolicy: Object.freeze({ hostBaseline: Object.freeze([...baseline].sort()), layers: policy, capability: effectiveCapability }) });
		},
	};
}
