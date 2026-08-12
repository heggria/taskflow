import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createTeExecutionProvider,
	processIsolationFromClassification,
	TE_PROVIDER_KIND,
	type ExecutionProvider,
	type TeExecutionAuthority,
} from "../src/te-provider.ts";
import { ControlError } from "../src/errors.ts";

const CAPABILITIES = {
	resolution: "contained" as const,
	mutationMediation: "brokered" as const,
	revocation: "admission-only" as const,
	baselinePolicyId: "taskflow-resolve-only",
	hostProbeSha256: "a".repeat(64),
};

const fakePlan = {
	schemaVersion: 1,
	projectId: "00000000-0000-0000-0000-000000000001",
	controlDomainId: "00000000-0000-0000-0000-000000000002",
	planId: "00000000-0000-0000-0000-000000000003",
	bindings: [],
	spawnTemplate: {
		allowedAgentClasses: ["executor"],
		allowedProviderClasses: ["te-resources"],
		maxToolCallsPerStep: 10,
		maxEffectsPerNode: 5,
		maxChildren: 4,
		maxDepth: 2,
		budgetShare: 0.5,
	},
	savedFlowPins: [],
	grantRefs: [],
	claims: [],
	enforcementCapabilities: { ...CAPABILITIES, processIsolation: "none" },
	dynamicPolicy: { hostCeiling: {}, authorizationContextHash: "b".repeat(64) },
	boundPlanHash: "plan:" + "c".repeat(64),
};

function fakeTeAuthority(calls: string[] = []): TeExecutionAuthority {
	const handle = {
		providerJobHandle: "te-job-1",
		poll: async () => {
			calls.push("poll");
			return { outcome: "accepted" as const, status: "running" as const };
		},
		cancel: async () => {
			calls.push("cancel");
			return { outcome: "accepted" as const, cancelled: true as const };
		},
		collect: async () => {
			calls.push("collect");
			return { outcome: "accepted" as const, providerJobHandle: "te-job-1" as const };
		},
		reconcile: async () => {
			calls.push("reconcile");
			return { outcome: "accepted" as const, providerState: "running" as const };
		},
	};
	return {
		assurance: "resolve-only-no-sandbox",
		probe: async () => {
			calls.push("probe");
			return { classification: "resolve-only" as const, baselinePolicyId: "taskflow-resolve-only", hostProbeSha256: CAPABILITIES.hostProbeSha256 };
		},
		prepare: async () => {
			calls.push("prepare");
			return { outcome: "accepted" as const, fulfillment: { preparationId: "prep-1", enforcementCapabilities: { ...CAPABILITIES, processIsolation: "none" } } };
		},
		submit: async () => {
			calls.push("submit");
			return handle;
		},
		watch: async function* () {
			calls.push("watch");
			yield { kind: "terminal" as const, outcome: "completed" as const };
		},
	};
}

test("te-provider: probe maps TE resolve-only evidence to the P8 default capability package", async () => {
	const calls: string[] = [];
	const provider = createTeExecutionProvider(fakeTeAuthority(calls));
	assert.equal(provider.kind, TE_PROVIDER_KIND);
	const result = await provider.probe();
	assert.equal(result.outcome, "accepted");
	assert.deepEqual(result.capabilities, {
		processIsolation: "none",
		resolution: "contained",
		mutationMediation: "brokered",
		revocation: "admission-only",
		baselinePolicyId: "taskflow-resolve-only",
		hostProbeSha256: CAPABILITIES.hostProbeSha256,
	});
	assert.deepEqual(calls, ["probe"]);
});

test("te-provider: unsupported host probe fails closed (P8 D11 — never bare-shell)", () => {
	assert.throws(() => processIsolationFromClassification("unsupported"), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_FEATURE_REQUIRED");
		return true;
	});
	// The adapter propagates the fail-closed decision through probe().
	const te = fakeTeAuthority();
	(te as { probe: () => Promise<unknown> }).probe = async () => {
		throw new ControlError("TF_FEATURE_REQUIRED", "unsupported host probe classification: refusing execution without evidence (P8 D11)", {
			recoveryAction: "operator",
			sideEffects: "none",
		});
	};
	const provider = createTeExecutionProvider(te);
	assert.rejects(async () => provider.probe(), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_FEATURE_REQUIRED");
		return true;
	});
});

test("te-provider: prepare/submit/poll/cancel/collect/reconcile delegate to the TE authority", async () => {
	const calls: string[] = [];
	const provider = createTeExecutionProvider(fakeTeAuthority(calls));

	const prepare = await provider.prepare({ plan: fakePlan as never, owner: owner(), controlDomainId: "d" });
	assert.equal(prepare.outcome, "accepted");
	assert.equal((prepare as { fulfillment: { preparationId: string } }).fulfillment.preparationId, "prep-1");

	const submit = await provider.submit({ preparationId: "prep-1", owner: owner(), controlDomainId: "d" });
	assert.equal(submit.outcome, "accepted");
	assert.equal((submit as { providerJobHandle: string }).providerJobHandle, "te-job-1");

	const poll = await provider.poll({ providerJobHandle: "te-job-1" });
	assert.equal(poll.outcome, "accepted");
	assert.equal((poll as { status: string }).status, "running");

	const cancel = await provider.cancel({ providerJobHandle: "te-job-1" });
	assert.equal(cancel.outcome, "accepted");
	assert.equal((cancel as { cancelled: boolean }).cancelled, true);

	const collect = await provider.collect({ providerJobHandle: "te-job-1" });
	assert.equal(collect.outcome, "accepted");

	const reconcile = await provider.reconcile({ providerJobHandle: "te-job-1" });
	assert.equal(reconcile.outcome, "accepted");
	assert.equal((reconcile as { providerState: string }).providerState, "running");

	const events: string[] = [];
	for await (const event of provider.watch({ providerJobHandle: "te-job-1" })) {
		events.push(event.kind);
	}
	assert.deepEqual(events, ["terminal"]);
	// probe is covered by its own test; the rest delegate once each.
	assert.deepEqual(calls, ["prepare", "submit", "poll", "cancel", "collect", "reconcile", "watch"]);
});

test("te-provider: only TE-shaped authorities can become a provider (fail closed)", () => {
	assert.throws(
		() => createTeExecutionProvider({ assurance: "custom-sandbox" } as unknown as TeExecutionAuthority),
		(error: unknown) => {
			assert.ok(error instanceof ControlError);
			assert.equal((error as ControlError).code, "TF_AUTHORITY_REVOKED");
			return true;
		},
	);
	assert.throws(
		() => createTeExecutionProvider({ assurance: "resolve-only-no-sandbox" } as unknown as TeExecutionAuthority),
		(error: unknown) => {
			assert.ok(error instanceof ControlError);
			assert.equal((error as ControlError).code, "TF_AUTHORITY_REVOKED");
			return true;
		},
	);
});

test("te-provider: a provider is always marked te-resources", () => {
	const provider = createTeExecutionProvider(fakeTeAuthority());
	const typed: ExecutionProvider = provider;
	assert.equal(typed.kind, "te-resources");
});

function owner() {
	return { runId: "r", phaseId: "p", attemptId: "a", unitId: "u", ancestry: [] };
}
