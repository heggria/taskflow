import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createFirstDispatchProviderRoute,
	linkFirstDispatchPlan,
	linkProgram,
	validateFirstDispatchPlan,
	validateFirstDispatchPlanAgainstDurableEvidence,
	type FirstDispatchDurableEvidence,
	type FirstDispatchLinkContext,
	type FirstDispatchPlan,
} from "../src/index.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

const provider = createFirstDispatchProviderRoute({
	providerName: "script",
	providerContractVersion: "script-get-or-create-v1",
	providerRouteDigest: SHA_C,
	getOrCreate: async () => ({ kind: "unavailable", reason: "not called while linking" }),
});

const context: FirstDispatchLinkContext = {
	commandId: "cmd-p16-first",
	requestHash: SHA_A,
	callerPrincipalDigest: SHA_B,
	projectId: "proj-p16-first",
	projectControlDomainId: "dom-p16-first",
	admissionId: "adm-p16-first",
	runId: "run-p16-first",
	continuationId: "cont-p16-first",
	continuationVersion: 1,
	admissionGenerationAtPlan: 0,
	provider,
};

function bound(program: unknown) {
	const linked = linkProgram({ program, providerClass: "script" });
	assert.equal(linked.ok, true, linked.ok ? undefined : linked.errors.join("; "));
	if (!linked.ok) throw new Error("fixture must link");
	return linked.boundPlan;
}

function plan(): Readonly<FirstDispatchPlan> {
	const result = linkFirstDispatchPlan(
		bound({
			name: "single-script",
			phases: [{ id: "first", type: "script", run: ["node", "-e", "process.stdout.write('ok')"], final: true }],
		}),
		context,
	);
	assert.equal(result.ok, true, result.ok ? undefined : result.reason);
	if (!result.ok) throw new Error("fixture must produce a first-dispatch plan");
	return result.plan;
}

function evidence(value: Readonly<FirstDispatchPlan>): FirstDispatchDurableEvidence {
	return {
		plannedEventId: "evt-p16-first",
		attemptId: value.attemptId,
		idempotencyKey: value.idempotencyKey,
		boundPlanHash: value.boundPlanHash,
		commandId: value.commandId,
		requestHash: value.requestHash,
		callerPrincipalDigest: value.callerPrincipalDigest,
		projectId: value.projectId,
		projectControlDomainId: value.projectControlDomainId,
		admissionId: value.admissionId,
		runId: value.runId,
		continuationId: value.continuationId,
		continuationVersion: value.continuationVersion,
		admissionGenerationAtPlan: value.admissionGenerationAtPlan,
		phaseId: value.phaseId,
		phaseType: value.phaseType,
		provider: value.provider,
		requestDigest: value.requestDigest,
		plannedAttemptHash: value.plannedAttemptHash,
	};
}

test("P16-1R E-1: one static provider call yields one immutable attempt tuple without calling provider", () => {
	let calls = 0;
	const result = linkFirstDispatchPlan(
		bound({
			name: "single-script",
			phases: [{ id: "first", type: "script", run: "true", final: true }],
		}),
		{
			...context,
			provider: createFirstDispatchProviderRoute({
				providerName: "script",
				providerContractVersion: "script-get-or-create-v1",
				providerRouteDigest: SHA_C,
				getOrCreate: async () => {
					calls += 1;
					return { kind: "unavailable", reason: "must not run at E-1" };
				},
			}),
		},
	);
	assert.equal(result.ok, true, result.ok ? undefined : result.reason);
	if (!result.ok) return;
	assert.equal(calls, 0);
	assert.equal(result.plan.attemptId, "first");
	assert.match(result.plan.idempotencyKey, /^p16fd_[a-f0-9]{64}$/);
	assert.match(result.plan.requestDigest, /^[a-f0-9]{64}$/);
	assert.match(result.plan.plannedAttemptHash, /^[a-f0-9]{64}$/);
	assert.equal(Object.isFrozen(result.plan), true);
	assert.equal(Object.isFrozen(result.plan.provider), true);
	assert.equal(Object.isFrozen(result.plan.request), true);
});

test("P16-1R E0: a serialized immutable attempt revalidates without provider access", () => {
	const original = plan();
	const result = validateFirstDispatchPlan(JSON.parse(JSON.stringify(original)));
	assert.equal(result.ok, true, result.ok ? undefined : result.reason);
	if (result.ok) assert.deepEqual(result.plan, original);
});

for (const [field, value] of [
	["admissionId", "../adm-escape"],
	["runId", "run/escape"],
	["continuationId", "cont\\escape"],
	["continuationVersion", 0],
	["admissionGenerationAtPlan", -1],
] as const) {
	test(`P16-1R E-1: unsafe ${field} fails before E0`, () => {
		const result = linkFirstDispatchPlan(
			bound({
				name: "single-script",
				phases: [{ id: "first", type: "script", run: "true", final: true }],
			}),
			{ ...context, [field]: value },
		);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "TF_FEATURE_REQUIRED");
			assert.equal(result.recoveryAction, "none");
			assert.equal(result.sideEffects, "none");
		}
	});
}

for (const [name, program] of [
	[
		"dynamic interpolation",
		{
			name: "dynamic",
			phases: [{ id: "first", type: "script", run: ["echo", "{args.value}"], final: true }],
		},
	],
	[
		"multiple provider calls",
		{
			name: "two-calls",
			phases: [
				{ id: "first", type: "script", run: "true" },
				{ id: "second", type: "script", run: "true", dependsOn: ["first"], final: true },
			],
		},
	],
	[
		"non-provider first phase",
		{
			name: "agent-first",
			phases: [{ id: "first", type: "agent", task: "work", final: true }],
		},
	],
] as const) {
	test(`P16-1R E-1: ${name} is rejected with no side effect`, () => {
		const result = linkFirstDispatchPlan(bound(program), context);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "TF_FEATURE_REQUIRED");
			assert.equal(result.recoveryAction, "none");
			assert.equal(result.sideEffects, "none");
		}
	});
}

test("P16-1R E-1: a structurally forged provider capability is rejected", () => {
	const forged = {
		providerName: "script",
		providerContractVersion: "script-get-or-create-v1",
		providerRouteDigest: SHA_C,
		capability: {
			kind: "p16-1r-atomic-get-or-create-v1",
			providerName: "script",
			providerContractVersion: "script-get-or-create-v1",
			providerRouteDigest: SHA_C,
			getOrCreate: async () => ({ kind: "unavailable", reason: "forged" }),
		},
	};
	const result = linkFirstDispatchPlan(
		bound({
			name: "single-script",
			phases: [{ id: "first", type: "script", run: "true", final: true }],
		}),
		{ ...context, provider: forged as typeof provider },
	);
	assert.equal(result.ok, false);
});

test("P16-1R reopen: self-consistent replacement cannot pass independently read durable evidence", () => {
	const original = plan();
	const changed = linkFirstDispatchPlan(
		bound({
			name: "single-script",
			phases: [{ id: "first", type: "script", run: "true", final: true }],
		}),
		{ ...context, admissionId: "adm-p16-other" },
	);
	assert.equal(changed.ok, true, changed.ok ? undefined : changed.reason);
	if (!changed.ok) return;
	assert.equal(validateFirstDispatchPlan(changed.plan).ok, true);
	const reopened = validateFirstDispatchPlanAgainstDurableEvidence(changed.plan, evidence(original));
	assert.equal(reopened.ok, false);
	if (!reopened.ok) {
		assert.equal(reopened.code, "TF_DURABILITY_FAILED");
		assert.equal(reopened.recoveryAction, "operator");
		assert.equal(reopened.sideEffects, "unknown");
	}
});

test("P16-1R reopen: tuple tamper is a durability failure", () => {
	const persisted = JSON.parse(JSON.stringify(plan())) as Record<string, unknown>;
	persisted.idempotencyKey = `p16fd_${SHA_A}`;
	const result = validateFirstDispatchPlan(persisted);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "TF_DURABILITY_FAILED");
});

test("P16-1R reopen: malformed independent evidence fails closed without throwing", () => {
	const original = plan();
	const malformed = { ...evidence(original) } as Record<string, unknown>;
	delete malformed.provider;
	const result = validateFirstDispatchPlanAgainstDurableEvidence(
		original,
		malformed,
	);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.code, "TF_DURABILITY_FAILED");
		assert.equal(result.recoveryAction, "operator");
		assert.equal(result.sideEffects, "unknown");
	}
});
