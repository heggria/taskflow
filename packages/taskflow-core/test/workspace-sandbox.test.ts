import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type {
	ConcreteSandboxPreparation,
	ExecutionOwner,
	HostBaselinePolicy,
	MutationPermit,
	ResolvedPathRef,
	SandboxGrant,
	SandboxPolicyPlan,
	ScopedCapability,
	WorkspaceBackendCapabilities,
} from "../src/resources/backend.ts";
import {
	FILE_BROKER_EVIDENCE_CHECKS,
	HOST_PROBE_VERSION,
	loadVerifiedHostSupportBaseline,
	matchSandboxedHostTarget,
	PROCESS_SANDBOX_EVIDENCE_CHECKS,
	type HostProbeEvidenceBundle,
	type HostProbeResult,
	type HostProbeTarget,
	type HostSupportBaseline,
	type VerifiedSandboxHostApproval,
} from "../src/resources/baseline.ts";
import {
	SandboxPolicyFactory,
	computeHostBaselineBodyDigest,
	computeSandboxPolicyDigest,
	computeWorkspaceBackendCapabilitiesSha256,
	createSandboxPolicyPlan,
} from "../src/resources/sandbox.ts";
import { canonicalJson } from "../src/resources/canonical-json.ts";
import { MutationPermitRegistry } from "../src/resources/permits.ts";
import { resolvePathRef } from "../src/resources/resolve.ts";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const KEY = new Uint8Array(32).fill(7);
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-sandbox-roots-"));
const ROOTS = {
	workspace: path.join(TEST_ROOT, "workspace"),
	machineA: path.join(TEST_ROOT, "machine-a", "repo"),
	machineB: path.join(TEST_ROOT, "machine-b", "repo"),
	api: path.join(TEST_ROOT, "workspace", "packages", "api"),
	other: path.join(TEST_ROOT, "workspace", "packages", "other"),
};
for (const root of Object.values(ROOTS)) fs.mkdirSync(root, { recursive: true });
after(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

function approvalSuite(checks: readonly string[]): { pass: true; checks: Record<string, boolean> } {
	return { pass: true, checks: Object.fromEntries(checks.map((check) => [check, true])) };
}

interface SandboxApprovalContext {
	approval: VerifiedSandboxHostApproval;
	target: HostProbeTarget;
	baselineId: string;
}

function createSandboxApproval(
	backend: WorkspaceBackendCapabilities,
	classification: "sandboxed-single-root" | "sandboxed-multi-root",
): SandboxApprovalContext {
	const repositoryRoot = path.join(TEST_ROOT, `approval-${classification}-${crypto.randomUUID()}`);
	fs.mkdirSync(repositoryRoot, { recursive: true });
	const baselineId = `test-${classification}`;
	const target: HostProbeTarget = {
		host: "codex",
		hostVersion: classification,
		hostBinarySha256: classification === "sandboxed-single-root" ? "a".repeat(64) : "b".repeat(64),
		os: "macos",
		osVersion: "test",
		osBuild: "test",
		arch: "arm64",
		sandboxMechanismVersion: `test:${classification}`,
		backendId: backend.backendId,
		backendCapabilityVersion: backend.backendCapabilityVersion,
		backendCapabilitiesSha256: computeWorkspaceBackendCapabilitiesSha256(backend),
		baselinePolicyId: backend.baselinePolicyId,
	};
	const probeResult: HostProbeResult = {
		target,
		classification,
		agent: approvalSuite(PROCESS_SANDBOX_EVIDENCE_CHECKS) as HostProbeResult["agent"],
		script: approvalSuite(PROCESS_SANDBOX_EVIDENCE_CHECKS) as HostProbeResult["script"],
		fileBroker: approvalSuite(FILE_BROKER_EVIDENCE_CHECKS) as HostProbeResult["fileBroker"],
	};
	const bundle: HostProbeEvidenceBundle = {
		schemaVersion: 1,
		probeVersion: HOST_PROBE_VERSION,
		results: [probeResult],
	};
	const evidenceBody = JSON.stringify(bundle);
	fs.writeFileSync(path.join(repositoryRoot, "evidence.json"), evidenceBody);
	const evidence = {
		path: "evidence.json",
		sha256: crypto.createHash("sha256").update(evidenceBody).digest("hex"),
	};
	const support: HostSupportBaseline = {
		schemaVersion: 1,
		baselineId,
		cells: [{
			target,
			classification,
			agent: { ...evidence },
			script: { ...evidence },
			fileBroker: { ...evidence },
			decision: { owner: "test", status: "approved", reason: "all strict checks pass" },
		}],
	};
	fs.writeFileSync(path.join(repositoryRoot, "baseline.json"), JSON.stringify(support));
	const verified = loadVerifiedHostSupportBaseline({ repositoryRoot, baselinePath: "baseline.json" });
	const match = matchSandboxedHostTarget(verified, target);
	if (!match.ok) throw new Error(match.reason);
	return { approval: match.approval, target, baselineId };
}

const owner: ExecutionOwner = {
	runId: "run-1",
	phaseId: "work",
	attemptId: "attempt-1",
	unitId: "phase",
	ancestry: [],
};

function capabilities(
	overrides: Partial<WorkspaceBackendCapabilities["sandboxFeatures"]> = {},
): WorkspaceBackendCapabilities {
	return {
		schemaVersion: 1,
		backendId: "test-native",
		backendCapabilityVersion: "1",
		agent: "native-single-root",
		script: "native-single-root",
		sandboxFeatures: {
			maxGrants: 1,
			scopeKinds: ["directory", "file"],
			perGrantAccess: true,
			denyAmbientUserData: true,
			exactBaselineMounts: true,
			privateTempPerExecution: true,
			descendantEnforcement: true,
			raceFreeFileBroker: true,
			networkModes: ["host-policy", "none"],
			credentialModes: ["opaque-broker", "isolated-host-process"],
			...overrides,
		},
		brokeredRead: true,
		brokeredWrite: true,
		versionCommitModes: ["content-snapshot"],
		restoreStrategies: ["replace-scope"],
		baselinePolicyId: "baseline",
	};
}

const SINGLE_ROOT_APPROVAL = createSandboxApproval(capabilities(), "sandboxed-single-root");

function baseline(): HostBaselinePolicy {
	const body: Omit<HostBaselinePolicy, "bodyDigest"> = {
		schemaVersion: 1,
		policyId: "baseline",
		policyVersion: "1",
		readableSystemClasses: ["runtime"],
		providerMetadata: [],
		credentialDelivery: { mode: "unavailable" },
		temp: { mode: "private-per-execution", access: "read-write" },
		network: "none",
	};
	return { ...body, bodyDigest: computeHostBaselineBodyDigest(body) };
}

function grant(access: "read-only" | "read-write" = "read-only", root = ROOTS.workspace): SandboxGrant {
	return {
		bindingId: "binding",
		resourceDomainId: "domain",
		providerInstanceId: "provider",
		logicalWorkspaceId: "target",
		logicalPrefix: "packages/api",
		physicalScopeRoot: fs.realpathSync(root),
		scopeKind: "directory",
		access,
		lifetime: { scope: "phase", runId: "run-1", phaseId: "work", attemptId: "attempt-1" },
	};
}

function cwdFor(selected: SandboxGrant, cwdOwner: ExecutionOwner = owner): ResolvedPathRef {
	const capability: ScopedCapability = {
			bindingId: selected.bindingId,
			resourceDomainId: selected.resourceDomainId,
			providerInstanceId: selected.providerInstanceId,
			logicalWorkspaceId: selected.logicalWorkspaceId,
			logicalPrefix: selected.logicalPrefix,
			physicalScopeRoot: selected.physicalScopeRoot,
			access: selected.access,
			version: { identityMode: "portable", generation: 1, state: "clean" },
			lifetime: selected.lifetime,
		};
	const resolved = resolvePathRef({
		workspace: selected.logicalWorkspaceId,
		access: selected.access,
		intent: "existing-directory",
		maxLifetime: { scope: "phase" },
	}, {
		workspaces: new Map([[selected.logicalWorkspaceId, capability]]),
		runId: cwdOwner.runId,
		phaseId: cwdOwner.phaseId,
		attemptId: cwdOwner.attemptId,
		now: () => NOW,
	}, { definitions: {}, values: {} });
	if (!resolved.ok) throw new Error(resolved.error.redactedMessage);
	assert.equal(resolved.ok, true);
	return resolved.value;
}

function policy(
	backend = capabilities(),
	selected = grant(),
	mode: SandboxPolicyPlan["mode"] = "sandboxed",
	policyOwner: ExecutionOwner = owner,
): SandboxPolicyPlan {
	return createSandboxPolicyPlan({
		mode,
		cwd: cwdFor(selected, policyOwner),
		grants: [selected],
		baseline: baseline(),
		credentialRequirements: [],
	}, backend);
}

function evidence(): ConcreteSandboxPreparation {
	return {
		assurance: "native-sandbox-prepared",
		preparationId: "native-preparation",
		baselineMounts: [
			{ mountId: "system:runtime", physicalPath: "/system/runtime", access: "read-only" },
			{ mountId: "temp:execution", physicalPath: "/private/temp", access: "read-write" },
		],
		credentialBindings: [],
	};
}

function factory(
	backend = capabilities(),
	extra: Partial<ConstructorParameters<typeof SandboxPolicyFactory>[0]> = {},
): SandboxPolicyFactory {
	const executionTarget = extra.executionTarget ?? "agent";
	const selectedMode = backend[executionTarget];
	const approvalContext = selectedMode === "native-single-root" || selectedMode === "native-multi-root"
		? createSandboxApproval(
			backend,
			selectedMode === "native-single-root" ? "sandboxed-single-root" : "sandboxed-multi-root",
		)
		: undefined;
	return new SandboxPolicyFactory({
		capabilities: backend,
		executionTarget,
		sandboxApproval: approvalContext?.approval,
		liveTarget: approvalContext?.target,
		hostSupportBaselineId: approvalContext?.baselineId,
		baselineBindings: [baseline()],
		key: KEY,
		keyId: "key-1",
		now: () => new Date(NOW),
		concreteAdapter: { prepareConcreteSandbox: async () => evidence() },
		...extra,
	});
}

async function permit(
	selected = grant("read-write"),
	permitOwner: ExecutionOwner = owner,
): Promise<MutationPermit> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-sandbox-permit-"));
	try {
		const registry = new MutationPermitRegistry({
			directory,
			journalEpoch: 1,
			now: () => NOW,
		});
		return await registry.issueForDurableIntent({
			intentId: "intent",
			intentSequence: 1,
			journalEpoch: 1,
			owner: permitOwner,
			scopes: [{ resourceDomainId: selected.resourceDomainId, canonicalPrefix: selected.physicalScopeRoot }],
		}, 60 * 60 * 1000);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

test("workspace policy digest is canonical, sorted, and path/principal/secret free", async () => {
	const backend = capabilities();
	const first = policy(backend, grant("read-only", ROOTS.machineA));
	const second = policy(backend, {
		...grant("read-only", ROOTS.machineB),
		bindingId: "relocated-binding",
		providerInstanceId: "relocated-provider",
	});
	assert.equal(first.policyDigest, second.policyDigest);
	assert.match(first.policyDigest, /^tfws-policy:v1:[a-f0-9]{64}$/);

	const withUnsignedHostData = {
		...first,
		principalId: "principal-must-not-hash",
		bootstrapSecret: "secret-must-not-hash",
	};
	assert.equal(computeSandboxPolicyDigest(withUnsignedHostData, backend), first.policyDigest);
	await assert.rejects(
		factory().prepareSandbox(withUnsignedHostData as SandboxPolicyPlan, owner),
		/unsigned or unsupported fields/,
	);
});

test("workspace canonical JSON follows the strict JSON domain", () => {
	assert.equal(canonicalJson({ z: 1, a: { y: -0, x: "😀" } }), '{"a":{"x":"😀","y":0},"z":1}');
	assert.throws(() => canonicalJson({ omitted: undefined }), /cannot encode undefined/);
	assert.throws(() => canonicalJson([, 1]), /sparse arrays/);
	assert.throws(() => canonicalJson("\ud800"), /lone UTF-16 surrogate/);
});

test("sandboxed preparation requires concrete native verification and seals an authenticated plan", async () => {
	const backend = capabilities();
	await assert.rejects(
		factory(backend, { concreteAdapter: undefined }).prepareSandbox(policy(backend), owner),
		/TFWS_UNSUPPORTED_SANDBOX_POLICY.*concrete native preparation/,
	);

	const prepared = await factory(backend).prepareSandbox(policy(backend), owner);
	assert.equal(prepared.assurance, "native-sandbox-prepared");
	assert.ok(Object.isFrozen(prepared));
	const sealed = factory(backend);
	const ownPrepared = await sealed.prepareSandbox(policy(backend), owner);
	const plan = sealed.sealSandbox(ownPrepared, []);
	assert.match(plan.enforcementDigest, /^tfws-enforcement:v1:key-1:[a-f0-9]{64}$/);
	assert.ok(Object.isFrozen(plan));
	assert.throws(() => sealed.sealSandbox(ownPrepared, []), /TFWS_PLAN_REPLAY/);
});

test("native factory requires the exact process-local host approval", () => {
	assert.throws(
		() => factory(capabilities(), { sandboxApproval: undefined }),
		/TFWS_UNSUPPORTED_SANDBOX_POLICY.*exact verified host approval/,
	);
	assert.throws(
		() => factory(capabilities(), {
			sandboxApproval: structuredClone(SINGLE_ROOT_APPROVAL.approval) as VerifiedSandboxHostApproval,
		}),
		/TFWS_UNSUPPORTED_SANDBOX_POLICY.*exact verified host approval/,
	);
	assert.throws(
		() => factory({ ...capabilities(), backendCapabilityVersion: "2" }, {
			sandboxApproval: SINGLE_ROOT_APPROVAL.approval,
		}),
		/verified host approval does not exactly match the live native host target/,
	);
	assert.throws(
		() => factory(capabilities(), {
			sandboxApproval: SINGLE_ROOT_APPROVAL.approval,
			hostSupportBaselineId: "other-baseline",
		}),
		/verified host approval does not exactly match the live native host target/,
	);
	const differentCapabilities = capabilities({ maxGrants: 2 });
	const differentApproval = createSandboxApproval(differentCapabilities, "sandboxed-single-root");
	assert.throws(
		() => factory(capabilities(), {
			sandboxApproval: differentApproval.approval,
			liveTarget: differentApproval.target,
			hostSupportBaselineId: differentApproval.baselineId,
		}),
		/live host target does not match the complete selected backend capabilities/,
	);
});

test("backend capability schema and native broker invariants fail closed", () => {
	assert.throws(
		() => factory({ ...capabilities(), brokeredRead: false }),
		/native execution requires a race-free broker/,
	);
	assert.throws(
		() => factory(capabilities({ raceFreeFileBroker: false })),
		/native execution requires a race-free broker/,
	);
	const malformedMode = { ...capabilities(), agent: "prompt-only" } as unknown as WorkspaceBackendCapabilities;
	assert.throws(() => factory(malformedMode), /backend agent mode is invalid/);
	const duplicateScopes = capabilities();
	duplicateScopes.sandboxFeatures.scopeKinds = ["directory", "directory"];
	assert.throws(() => factory(duplicateScopes), /scopeKinds contains a duplicate value/);
	const malformedBoolean = capabilities() as unknown as { sandboxFeatures: { perGrantAccess: string } };
	malformedBoolean.sandboxFeatures.perGrantAccess = "yes";
	assert.throws(
		() => factory(malformedBoolean as unknown as WorkspaceBackendCapabilities),
		/perGrantAccess must be boolean/,
	);
});

test("sandbox preparation rejects cloned or handmade resolver capabilities", async () => {
	const valid = policy();
	const forged = {
		...valid,
		cwd: structuredClone(valid.cwd),
	};
	await assert.rejects(factory().prepareSandbox(forged, owner), /cwd was not issued by the workspace resolver/);
});

test("trusted baseline digest binds the complete immutable policy body", async () => {
	const expanded = policy();
	expanded.baseline = { ...expanded.baseline, network: "host-policy" };
	// The portable policy digest intentionally carries only the registered body
	// digest. Keeping that digest while changing the body must still fail at the
	// trusted factory boundary.
	expanded.policyDigest = computeSandboxPolicyDigest(expanded, capabilities());
	await assert.rejects(factory().prepareSandbox(expanded, owner), /TFWS_BASELINE_MISMATCH/);
	assert.throws(
		() => factory(capabilities(), { baselineBindings: [expanded.baseline] }),
		/TFWS_BASELINE_MISMATCH/,
	);
});

test("single-root negotiation rejects every unenforceable concrete policy dimension", async (t) => {
	const cases: Array<{
		name: string;
		backend: WorkspaceBackendCapabilities;
		makePolicy?: (backend: WorkspaceBackendCapabilities) => SandboxPolicyPlan;
	}> = [
		{ name: "scope kind", backend: capabilities({ scopeKinds: ["file"] }) },
		{ name: "RO/RW", backend: capabilities({ perGrantAccess: false }) },
		{ name: "ambient denial", backend: capabilities({ denyAmbientUserData: false }) },
		{ name: "exact baseline", backend: capabilities({ exactBaselineMounts: false }) },
		{ name: "private temp", backend: capabilities({ privateTempPerExecution: false }) },
		{ name: "descendants", backend: capabilities({ descendantEnforcement: false }) },
		{ name: "network", backend: capabilities({ networkModes: ["host-policy"] }) },
	];
	for (const item of cases) {
		await t.test(item.name, async () => {
			await assert.rejects(
				factory(item.backend).prepareSandbox((item.makePolicy ?? policy)(item.backend), owner),
				/TFWS_UNSUPPORTED_SANDBOX_POLICY/,
			);
		});
	}

	await t.test("grant count", async () => {
		const backend = capabilities({ maxGrants: 2 });
		const selected = grant();
		const extra = { ...grant(), bindingId: "b2", resourceDomainId: "d2", logicalWorkspaceId: "other" };
		const plan = createSandboxPolicyPlan({
			mode: "sandboxed",
			cwd: cwdFor(selected),
			grants: [selected, extra],
			baseline: baseline(),
			credentialRequirements: [],
		}, backend);
		await assert.rejects(factory(backend).prepareSandbox(plan, owner), /single-root.*exactly one grant/);
	});

	await t.test("credentials", async () => {
		const backend = capabilities({ credentialModes: [] });
		const selected = grant();
		const base = baseline();
		base.credentialDelivery = { mode: "opaque-broker", brokerId: "broker", maxTtlMs: 10_000 };
		base.bodyDigest = computeHostBaselineBodyDigest(base);
		const plan = createSandboxPolicyPlan({
			mode: "sandboxed",
			cwd: cwdFor(selected),
			grants: [selected],
			baseline: base,
			credentialRequirements: [{
				credentialGrantId: "cred-grant",
				credentialId: "git",
				audience: "github",
				purpose: "clone",
				ttlMs: 1_000,
				delivery: { mode: "opaque-broker", brokerId: "broker", maxTtlMs: 10_000 },
			}],
		}, backend);
		await assert.rejects(
			factory(backend, { baselineBindings: [base] }).prepareSandbox(plan, owner),
			/credential mode.*unavailable/,
		);
	});
});

test("native multi-root capability fails closed before concrete adapter execution", async () => {
	const backend: WorkspaceBackendCapabilities = {
		...capabilities({ maxGrants: 2 }),
		agent: "native-multi-root",
	};
	const selected = grant();
	const extra: SandboxGrant = {
		...grant("read-only", ROOTS.other),
		bindingId: "binding-other",
		resourceDomainId: "domain-other",
		providerInstanceId: "provider-other",
		logicalWorkspaceId: "other",
		logicalPrefix: "",
	};
	const plan = createSandboxPolicyPlan({
		mode: "sandboxed",
		cwd: cwdFor(selected),
		grants: [selected, extra],
		baseline: baseline(),
		credentialRequirements: [],
	}, backend);
	let adapterCalls = 0;
	const sandbox = factory(backend, {
		concreteAdapter: {
			prepareConcreteSandbox: async () => {
				adapterCalls++;
				return evidence();
			},
		},
	});
	await assert.rejects(
		sandbox.prepareSandbox(plan, owner),
		/TFWS_UNSUPPORTED_SANDBOX_POLICY.*native multi-root.*not implemented/,
	);
	assert.equal(adapterCalls, 0);
});

test("resolve-only is explicitly authorized and never reports sandbox assurance", async () => {
	const backend = { ...capabilities(), agent: "resolve-only" as const };
	const plan = policy(backend, grant(), "resolve-only");
	const adapter = {
		prepareResolveOnly: async () => ({
			assurance: "resolve-only-no-sandbox" as const,
			preparationId: "path-check",
		}),
	};
	await assert.rejects(
		factory(backend, { concreteAdapter: undefined, resolveOnlyAdapter: adapter }).prepareSandbox(plan, owner),
		/TFWS_RESOLVE_ONLY_NOT_AUTHORIZED/,
	);
	const prepared = await factory(backend, {
		concreteAdapter: undefined,
		resolveOnlyAdapter: adapter,
		authorizeResolveOnly: () => true,
	}).prepareSandbox(plan, owner);
	assert.equal(prepared.assurance, "resolve-only-no-sandbox");
	await assert.rejects(
		factory(backend).prepareSandbox(policy(backend, grant(), "sandboxed"), owner),
		/TFWS_UNSUPPORTED_SANDBOX_POLICY.*resolve-only/,
	);
	await assert.rejects(
		factory(capabilities(), {
			concreteAdapter: undefined,
			resolveOnlyAdapter: adapter,
			authorizeResolveOnly: () => true,
		}).prepareSandbox(policy(capabilities(), grant(), "resolve-only"), owner),
		/resolve-only must be advertised explicitly/,
	);
});

test("preparation snapshots policy and owner before awaiting the native adapter", async () => {
	let release: (() => void) | undefined;
	const wait = new Promise<void>((resolve) => { release = resolve; });
	const mutablePolicy = policy();
	const mutableOwner = structuredClone(owner);
	const planner = factory(capabilities(), {
		concreteAdapter: {
			prepareConcreteSandbox: async () => {
				await wait;
				return evidence();
			},
		},
	});
	const pending = planner.prepareSandbox(mutablePolicy, mutableOwner);
	mutablePolicy.grants[0].physicalScopeRoot = "/attacker";
	mutableOwner.attemptId = "attacker";
	release?.();
	const prepared = await pending;
	assert.equal(prepared.policy.grants[0].physicalScopeRoot, fs.realpathSync(ROOTS.workspace));
	assert.equal(prepared.owner.attemptId, "attempt-1");
});

test("RW sealing requires owner-matched permits covering every canonical physical scope", async () => {
	const selected = grant("read-write", ROOTS.api);
	const backend = capabilities();
	const planner = factory(backend);
	const prepared = await planner.prepareSandbox(policy(backend, selected), owner);
	assert.throws(() => planner.sealSandbox(prepared, []), /TFWS_MISSING_MUTATION_PERMIT/);
	const wrongScope = await permit({ ...selected, physicalScopeRoot: ROOTS.other });
	assert.throws(
		() => planner.sealSandbox(prepared, [wrongScope]),
		/TFWS_INVALID_MUTATION_PERMIT|TFWS_MISSING_MUTATION_PERMIT/,
	);
	const plan = planner.sealSandbox(prepared, [await permit(selected)]);
	assert.equal(plan.mutationPermits.length, 1);
});

test("enforcement HMAC binds owner, expiry, physical mappings, and permit IDs", async () => {
	const backend = capabilities();
	const externalLifetime = { scope: "external" as const, bindingId: "binding", providerInstanceId: "provider" };
	const aGrant: SandboxGrant = {
		...grant("read-write", ROOTS.machineA),
		lifetime: externalLifetime,
	};
	const bGrant: SandboxGrant = {
		...grant("read-write", ROOTS.machineB),
		lifetime: externalLifetime,
	};
	const aFactory = factory(backend);
	const bFactory = factory(backend);
	const secondOwner = { ...owner, attemptId: "attempt-2" };
	const aPrepared = await aFactory.prepareSandbox(policy(backend, aGrant), owner);
	const bPrepared = await bFactory.prepareSandbox(policy(backend, bGrant, "sandboxed", secondOwner), secondOwner);
	const a = aFactory.sealSandbox(aPrepared, [await permit(aGrant)]);
	const b = bFactory.sealSandbox(bPrepared, [await permit(bGrant, secondOwner)]);
	assert.equal(a.prepared.policy.policyDigest, b.prepared.policy.policyDigest);
	assert.notEqual(a.enforcementDigest, b.enforcementDigest);
});

test("sealed plan activation is guarded once and keeps journal hooks around execution", async () => {
	const selected = grant("read-write");
	const planner = factory();
	const prepared = await planner.prepareSandbox(policy(capabilities(), selected), owner);
	const sealed = planner.sealSandbox(prepared, [await permit(selected)]);
	const events: string[] = [];
	const result = await planner.activateOnce(sealed, {
		activateMutationPermits: async () => { events.push("activate"); },
		settleMutationPermits: async (_permits, _owner, outcome) => { events.push(`settle:${outcome}`); },
	}, async (activation) => {
		events.push("execute");
		assert.equal(activation.plan, sealed);
		return 42;
	});
	assert.equal(result, 42);
	assert.deepEqual(events, ["activate", "execute", "settle:completed"]);
	await assert.rejects(
		planner.activateOnce(sealed, {}, async () => undefined),
		/TFWS_PLAN_REPLAY/,
	);
});
