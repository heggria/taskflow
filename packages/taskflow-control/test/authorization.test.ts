import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { canonicalJson } from "taskflow-core/flowir/hash";
import { ControlError } from "../src/errors.ts";
import {
	AUTHORIZATION_CAPABILITIES, answerAuthorizationChallenge, authorizationAuditHash,
	createAuthorizationAuthority, type AuthorizationAuthorityOptions, type AuthorizationBinding, type AuthorizationChallenge,
	type AuthorizationPolicyLayer, type AuthorizationRequest, type VerifiedContext,
} from "../src/authorization.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tf-authz-")));
const inner = join(root, "allowed"), deeper = join(inner, "narrow"), other = join(root, "other");
mkdirSync(deeper, { recursive: true }); mkdirSync(other);
const outside = realpathSync(mkdtempSync(join(tmpdir(), "tf-authz-outside-")));
symlinkSync(outside, join(root, "escape"));
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
const binding: AuthorizationBinding = { projectId: "project-a", controlDomainId: "domain-a", projectRoot: root };
const secret = randomBytes(32);
function fixture(overrides: Partial<AuthorizationAuthorityOptions> = {}) {
	let policy: unknown = { host: {} };
	let reads = 0;
	const authority = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: secret,
		hostBaseline: AUTHORIZATION_CAPABILITIES,
		loadLivePolicy: () => { reads++; return policy; }, ...overrides });
	return { authority, context: authority.issueStandalone(binding), set: (value: unknown) => { policy = value; }, reads: () => reads };
}
function request(operation: AuthorizationRequest["operation"] = "read", extra: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
	return { ...binding, operation, ...(operation === "submit" || operation === "replay" || operation === "artifact" ? { commandKind: "run.submit" as const } : {}), ...extra };
}
function code(expected: string) { return (error: unknown) => error instanceof ControlError && error.code === expected && error.sideEffects === "none"; }
const denied = code("TF_POLICY_DENIED"), revoked = code("TF_AUTHORITY_REVOKED");

test("trusted contexts cannot be forged through body fields, JSON, spread, or a second issuer", async () => {
	const f = fixture(), foreign = fixture();
	for (const context of [null, { principal: f.authority.identity(f.context).principal }, { ...f.context }, JSON.parse(JSON.stringify(f.context)), foreign.context]) {
		await assert.rejects(f.authority.authorize(context as VerifiedContext, request()), revoked);
	}
	const identity = f.authority.identity(f.context);
	assert.equal(identity.principal, `os-user:${process.getuid!()}`);
	assert.ok(Object.isFrozen(identity)); assert.ok(Object.isFrozen(identity.binding)); assert.ok(Object.isFrozen(f.context));
	await assert.rejects(f.authority.authorize(f.context, { ...request(), callerPrincipal: identity.principal } as AuthorizationRequest), denied);
	assert.equal(f.reads(), 0, "identity spoofing must fail before reading policy");
});

test("bootstrap token challenge binds principal, project/domain and nonce; wrong proof consumes the challenge", async () => {
	const f = fixture();
	const challenge = f.authority.createChallenge(binding);
	const proof = answerAuthorizationChallenge(secret, challenge);
	const context = f.authority.authenticate(challenge.id, proof);
	assert.equal((await f.authority.authorize(context, request())).callerPrincipal, `os-user:${process.getuid!()}`);
	assert.throws(() => f.authority.authenticate(challenge.id, proof), denied);
	const tamperers: ((input: AuthorizationChallenge) => AuthorizationChallenge)[] = [
		(input) => ({ ...input, principal: `os-user:${process.getuid!() + 1}` }),
		(input) => ({ ...input, purpose: "other.purpose" as never }),
		(input) => ({ ...input, version: 2 as never }),
		(input) => ({ ...input, nonce: "00" }),
		(input) => ({ ...input, expiresAt: input.expiresAt + 1 }),
		(input) => ({ ...input, binding: { ...input.binding, projectId: "project-b" } }),
		(input) => ({ ...input, binding: { ...input.binding, controlDomainId: "domain-b" } }),
		(input) => ({ ...input, binding: { ...input.binding, projectRoot: other } }),
	];
	for (const tamper of tamperers) {
		const pending = f.authority.createChallenge(binding);
		assert.throws(() => f.authority.authenticate(pending.id, answerAuthorizationChallenge(secret, tamper(pending))), denied);
	}
	const wrong = f.authority.createChallenge(binding);
	assert.throws(() => f.authority.authenticate(wrong.id, answerAuthorizationChallenge(randomBytes(32), wrong)), denied);
	assert.throws(() => f.authority.authenticate(wrong.id, answerAuthorizationChallenge(secret, wrong)), denied);
});

test("trusted credential issuers bind distinct principals and tokens; wire labels cannot select one", async () => {
	const issuerA = fixture({ credentialIssuerId: "adapter-a" });
	const issuerB = fixture({ credentialIssuerId: "adapter-b", bootstrapSecret: randomBytes(32) });
	assert.notEqual(issuerA.authority.identity(issuerA.context).principal, issuerB.authority.identity(issuerB.context).principal);
	const challenge = issuerB.authority.createChallenge(binding);
	assert.throws(() => issuerB.authority.authenticate(challenge.id, answerAuthorizationChallenge(secret, challenge)), denied);
	assert.throws(() => fixture({ credentialIssuerId: "untrusted\nlabel" }), denied);
	await assert.rejects(issuerA.authority.authorize(issuerA.context, { ...request(), credentialIssuerId: "adapter-b" } as AuthorizationRequest), denied);
});

test("expired and malformed authentication fails closed; challenge queue is bounded", () => {
	let time = 10;
	const f = fixture({ now: () => time, challengeTtlMs: 20 });
	const expired = f.authority.createChallenge(binding); time = 30;
	assert.throws(() => f.authority.authenticate(expired.id, answerAuthorizationChallenge(secret, expired)), denied);
	for (const proof of ["", "a".repeat(63), "G".repeat(64), null]) {
		const pending = f.authority.createChallenge(binding);
		assert.throws(() => f.authority.authenticate(pending.id, proof as string), denied);
	}
	for (let i = 0; i < 256; i++) f.authority.createChallenge(binding);
	assert.throws(() => f.authority.createChallenge(binding), denied);
	time += 20; assert.ok(f.authority.createChallenge(binding));
});

test("issuance requires actual OS uid, an existing project directory and protected token strength", () => {
	assert.throws(() => fixture({ ownerUid: process.getuid!() + 1 }), code("TF_BOOTSTRAP_FAILED"));
	assert.throws(() => fixture({ bootstrapSecret: randomBytes(31) }), denied);
	assert.throws(() => fixture({ challengeTtlMs: 60_001 }), denied);
	assert.throws(() => fixture({ hostBaseline: ["network" as never] }), denied);
	const f = fixture();
	assert.throws(() => f.authority.issueStandalone({ ...binding, projectRoot: join(root, "missing") }), denied);
	writeFileSync(join(root, "file"), "file");
	assert.throws(() => f.authority.issueStandalone({ ...binding, projectRoot: join(root, "file") }), denied);
});

test("empty policy inherits only an explicit host baseline, never unrestricted authority", async () => {
	const f = fixture({ hostBaseline: ["project.read", "run.submit"] });
	assert.equal((await f.authority.authorize(f.context, request())).capability.kind, "project.read");
	assert.equal((await f.authority.authorize(f.context, request("submit"))).capability.kind, "run.submit");
	await assert.rejects(f.authority.authorize(f.context, request("submit", { commandKind: "approval.decide" })), denied);
	const none = fixture({ hostBaseline: [] });
	await assert.rejects(none.authority.authorize(none.context, request()), denied);
	for (const policy of [{}, { user: {} }, null, { host: { capabilities: [] } }]) {
		f.set(policy); await assert.rejects(f.authority.authorize(f.context, request()), denied);
	}
});

test("run.cancel requires its own explicit capability and current authorization", async () => {
	const f = fixture({ hostBaseline: ["run.submit", "run.cancel", "artifact.read"] });
	assert.equal((await f.authority.authorize(f.context, request("submit", { commandKind: "run.cancel" }))).capability.kind, "run.cancel");
	assert.equal((await f.authority.authorize(f.context, request("replay", { commandKind: "run.cancel" }))).capability.kind, "run.cancel");
	f.set({ host: {}, project: { deny: ["run.cancel"] } });
	await assert.rejects(f.authority.authorize(f.context, request("submit", { commandKind: "run.cancel" })), denied);
	await assert.rejects(f.authority.authorize(f.context, request("replay", { commandKind: "run.cancel" })), denied);
	const baseline = fixture({ hostBaseline: ["run.submit"] });
	await assert.rejects(baseline.authority.authorize(baseline.context, request("submit", { commandKind: "run.cancel" })), denied);
});

for (const field of ["host", "user", "project", "invocation"] as const) {
	test(`four-layer policy: ${field} can deny or attenuate, and lower layers cannot enlarge it`, async () => {
		const f = fixture();
		f.set({ host: {}, [field]: { deny: ["run.submit"] } });
		await assert.rejects(f.authority.authorize(f.context, request("submit")), denied);
		assert.equal((await f.authority.authorize(f.context, request())).capability.kind, "project.read");
		f.set({ host: { capabilities: [{ kind: "run.submit", scopeRoot: inner }] }, [field]: { attenuate: [{ kind: "run.submit", scopeRoot: deeper }] } });
		await assert.rejects(f.authority.authorize(f.context, request("submit", { resourcePath: other })), denied);
		const accepted = await f.authority.authorize(f.context, request("submit", { resourcePath: join(deeper, "new-file") }));
		assert.equal(accepted.capability.scopeRoot, deeper);
		f.set({ host: { capabilities: [{ kind: "run.submit", scopeRoot: inner }] }, user: { capabilities: [{ kind: "run.submit", scopeRoot: root }] } });
		await assert.rejects(f.authority.authorize(f.context, request("submit", { resourcePath: other })), denied);
	});
}

test("substitution is scoped attenuation; conflicting substitutions deny instead of picking a winner", async () => {
	const f = fixture();
	const narrow: AuthorizationPolicyLayer = { substitute: [{ capability: "run.submit", with: { kind: "run.submit", scopeRoot: inner } }] };
	f.set({ host: {}, user: narrow });
	assert.equal((await f.authority.authorize(f.context, request("submit", { resourcePath: deeper }))).capability.scopeRoot, inner);
	await assert.rejects(f.authority.authorize(f.context, request("submit", { resourcePath: other })), denied);
	f.set({ host: {}, user: narrow, project: { substitute: [{ capability: "run.submit", with: { kind: "run.submit", scopeRoot: deeper } }] } });
	await assert.rejects(f.authority.authorize(f.context, request("submit", { resourcePath: deeper })), denied);
	f.set({ host: {}, invocation: { substitute: [{ capability: "run.submit", with: { kind: "approval.decide", scopeRoot: inner } }] } });
	await assert.rejects(f.authority.authorize(f.context, request("submit", { resourcePath: inner })), denied);
});

test("unknown security keys and capability values fail closed at every policy layer", async () => {
	const f = fixture();
	for (const field of ["host", "user", "project", "invocation"] as const) {
		for (const bad of [
			{ allowNetwork: true }, { capabilities: [{ kind: "network", scopeRoot: root }] },
			{ deny: ["DomainTransfer"] }, { attenuate: [{ kind: "run.submit", scopeRoot: root, label: "trusted" }] },
			{ capabilities: [{ kind: "run.submit", scopeRoot: outside }] }, { capabilities: "all" },
		]) {
			f.set({ host: {}, [field]: bad }); await assert.rejects(f.authority.authorize(f.context, request()), denied);
		}
	}
	f.set({ host: {}, policyHash: "a".repeat(64) }); await assert.rejects(f.authority.authorize(f.context, request()), denied);
	f.set({ host: {} });
	await assert.rejects(f.authority.authorize(f.context, request("network" as never)), denied);
	await assert.rejects(f.authority.authorize(f.context, request("read", { commandKind: "unknown" as never })), denied);
});

test("project/domain and symlink scope escapes fail before policy read or side effect", async () => {
	const f = fixture();
	for (const extra of [{ projectId: "project-b" }, { controlDomainId: "domain-b" }, { projectRoot: outside }, { resourcePath: outside }, { resourcePath: join(root, "escape", "future-file") }]) {
		await assert.rejects(f.authority.authorize(f.context, request("submit", extra)), denied);
	}
	assert.equal(f.reads(), 0);
});

test("dangling symlink ancestors cannot become ordinary missing resource paths", async () => {
	const alias = join(root, "dangling-resource");
	symlinkSync(join(outside, "not-created"), alias);
	const f = fixture();
	try {
		for (const resourcePath of [alias, join(alias, "future-file"), join(alias, "missing", "future-file")]) {
			await assert.rejects(f.authority.authorize(f.context, request("submit", { resourcePath })), denied);
		}
		assert.equal(f.reads(), 0);
	} finally { unlinkSync(alias); }
});

test("dangling policy scope rejects even when the requested resource uses an independent valid grant", async () => {
	const alias = join(root, "dangling-policy");
	symlinkSync(join(outside, "not-created"), alias);
	const f = fixture();
	try {
		for (const extra of [
			{ capabilities: [{ kind: "run.submit", scopeRoot: root }, { kind: "project.read", scopeRoot: alias }] },
			{ attenuate: [{ kind: "project.read", scopeRoot: alias }] },
			{ substitute: [{ capability: "project.read", with: { kind: "project.read", scopeRoot: alias } }] },
		]) {
			f.set({ host: extra });
			await assert.rejects(f.authority.authorize(f.context, request("submit")), denied);
		}
	} finally { unlinkSync(alias); }
});

test("every read/submit/replay loads live policy, including revoked principals and changed audit context", async () => {
	const f = fixture();
	for (const operation of ["read", "submit", "replay"] as const) await f.authority.authorize(f.context, request(operation));
	assert.equal(f.reads(), 3);
	const before = await f.authority.authorize(f.context, request("replay"));
	f.set({ host: {}, project: { attenuate: [{ kind: "project.read", scopeRoot: inner }] } });
	const after = await f.authority.authorize(f.context, request("replay"));
	assert.notEqual(before.authorizationContextHash, after.authorizationContextHash);
	assert.ok(Object.isFrozen(after.effectivePolicy.layers));
	assert.ok(Object.isFrozen(after.effectivePolicy.layers.project!.attenuate));
	f.set({ host: {}, project: { deny: ["run.submit"] } });
	await assert.rejects(f.authority.authorize(f.context, request("replay")), denied);
	f.set({ host: {}, revokedPrincipals: [before.callerPrincipal] });
	await assert.rejects(f.authority.authorize(f.context, request()), revoked);
	assert.equal(authorizationAuditHash({ z: [null, 1], a: { b: true } }), createHash("sha256").update(canonicalJson({ a: { b: true }, z: [null, 1] })).digest("hex"));
});

test("request identity/class cannot change during live policy reads", async () => {
	let finish!: (value: unknown) => void;
	const f = fixture({ loadLivePolicy: () => new Promise((resolve) => { finish = resolve; }) });
	const input = request("submit");
	const pending = f.authority.authorize(f.context, input);
	input.commandKind = "coordinator.forceRelease";
	input.projectId = "project-b";
	finish({ host: {} });
	const result = await pending;
	assert.equal(result.capability.kind, "run.submit");
	const fixed = fixture();
	assert.equal(result.authorizationContextHash, (await fixed.authority.authorize(fixed.context, request("submit"))).authorizationContextHash);
});

test("a resource symlink redirected while live policy is loading cannot escape at disclosure", async () => {
	const alias = join(root, "changing-alias"); symlinkSync(inner, alias);
	let finish!: (value: unknown) => void;
	const f = fixture({ loadLivePolicy: () => new Promise((resolve) => { finish = resolve; }) });
	const pending = f.authority.authorize(f.context, request("read", { resourcePath: join(alias, "future") }));
	unlinkSync(alias); symlinkSync(outside, alias);
	finish({ host: {} });
	try { await assert.rejects(pending, denied); } finally { unlinkSync(alias); }
});

test("unavailable live policy and context revocation during an asynchronous policy read deny", async () => {
	const unavailable = fixture({ loadLivePolicy: () => { throw new Error("storage down"); } });
	await assert.rejects(unavailable.authority.authorize(unavailable.context, request("replay")), denied);
	let finish!: (value: unknown) => void;
	const f = fixture({ loadLivePolicy: () => new Promise((resolve) => { finish = resolve; }) });
	const pending = f.authority.authorize(f.context, request());
	f.authority.revokeContext(f.context); finish({ host: {} });
	await assert.rejects(pending, revoked);
	await assert.rejects(f.authority.authorize(f.context, request()), revoked);
});

test("artifact digest requires live ledger reachability and policy; revocation during lookup denies", async () => {
	let reachable = true, lookups = 0;
	const f = fixture({ verifyArtifactReachability: async (principal, checked, digest) => {
		lookups++; assert.equal(principal, `os-user:${process.getuid!()}`); assert.deepEqual(checked, binding); assert.equal(digest, "digest"); return reachable;
	} });
	await f.authority.authorize(f.context, request("artifact", { artifactDigest: "digest" }));
	reachable = false;
	await assert.rejects(f.authority.authorize(f.context, request("artifact", { artifactDigest: "digest" })), denied);
	reachable = true; f.set({ host: {}, project: { deny: ["artifact.read"] } });
	await assert.rejects(f.authority.authorize(f.context, request("artifact", { artifactDigest: "digest" })), denied);
	assert.equal(lookups, 3);
	f.set({ host: {}, invocation: { deny: ["run.submit"] } });
	await assert.rejects(f.authority.authorize(f.context, request("artifact", { artifactDigest: "digest" })), denied);
	await assert.rejects(f.authority.authorize(f.context, request("artifact", { artifactDigest: "digest", commandKind: undefined })), denied);
	const noLedger = fixture();
	await assert.rejects(noLedger.authority.authorize(noLedger.context, request("artifact", { artifactDigest: "digest" })), denied);
	await assert.rejects(f.authority.authorize(f.context, { ...request("artifact", { artifactDigest: "digest" }), artifactReachable: true } as AuthorizationRequest), denied);
	let finish!: (value: boolean) => void;
	const racing = fixture({ verifyArtifactReachability: () => new Promise((resolve) => { finish = resolve; }) });
	const pending = racing.authority.authorize(racing.context, request("artifact", { artifactDigest: "digest" }));
	racing.set({ host: {}, invocation: { deny: ["run.submit"] } });
	finish(true); await assert.rejects(pending, denied);
});
