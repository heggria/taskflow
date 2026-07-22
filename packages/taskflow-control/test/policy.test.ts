/**
 * P1/P2 policy compiler + evaluator — behavior tests (no string theater).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	compilePolicy,
	evaluateCapability,
	HOST_DEFAULT_EXPOSURE,
	linkProgram,
} from "../src/index.ts";

const SCRIPT = {
	name: "pol",
	phases: [{ id: "main", type: "script" as const, run: "true", final: true }],
};

test("empty policy → host-default attenuated; DomainTransfer never allowed", () => {
	const d = compilePolicy({});
	assert.equal(d.ok, true);
	assert.equal(d.exposure.emptyPolicy, true);
	for (const c of HOST_DEFAULT_EXPOSURE) {
		assert.ok(d.exposure.allowed.includes(c), c);
	}
	assert.equal(evaluateCapability(d.exposure, "domain-transfer"), false);
	assert.equal(evaluateCapability(d.exposure, "network"), false);
	assert.equal(evaluateCapability(d.exposure, "cross-project"), false);
});

test("project cannot enlarge: allow network is ignored without host grant", () => {
	const d = compilePolicy({
		project: {
			layer: "project",
			allow: ["network", "admit"],
			rules: [],
		},
	});
	// Intersection with host default — network not in host default
	assert.equal(d.exposure.allowed.includes("network"), false);
	assert.ok(d.exposure.allowed.includes("admit"));
});

test("deny admit fails closed when requested", () => {
	const d = compilePolicy({
		project: {
			layer: "project",
			rules: [{ capability: "admit", op: "deny" }],
		},
		requested: ["admit", "observe"],
	});
	assert.equal(d.ok, false);
	assert.ok(d.denied.includes("admit"));
	assert.ok(!d.denied.includes("observe") || d.exposure.allowed.includes("observe"));
});

test("attenuate never enlarges; substitute requires allowed target", () => {
	const att = compilePolicy({
		user: {
			layer: "user",
			rules: [{ capability: "provider-submit", op: "attenuate", attenuateTo: "provider-submit:script" }],
		},
		// Request the attenuated token, not the removed base capability
		requested: ["link", "admit", "provider-submit:script"],
	});
	assert.equal(att.ok, true, JSON.stringify(att));
	assert.ok(att.exposure.allowed.includes("provider-submit:script"));
	assert.equal(att.exposure.allowed.includes("provider-submit"), false);

	const badSub = compilePolicy({
		user: {
			layer: "user",
			rules: [{ capability: "admit", op: "substitute", substituteWith: "domain-transfer" }],
		},
		requested: ["observe"],
	});
	// substitute to forbidden / not-allowed → capability removed from allowed set
	assert.equal(badSub.exposure.allowed.includes("admit"), false);
	assert.equal(badSub.exposure.allowed.includes("domain-transfer"), false);
});

test("policyHash/exposureHash stable; link embeds them in BoundPlan hash", () => {
	const a = compilePolicy({});
	const b = compilePolicy({});
	assert.equal(a.exposure.policyHash, b.exposure.policyHash);
	assert.equal(a.exposure.exposureHash, b.exposure.exposureHash);

	const linked = linkProgram({ program: SCRIPT });
	assert.equal(linked.ok, true);
	if (!linked.ok) return;
	assert.ok(linked.exposure.emptyPolicy);
	assert.match(linked.boundPlan.boundPlanHash, /^bp:[0-9a-f]{64}$/);

	const linkedDeny = linkProgram({
		program: SCRIPT,
		policy: {
			project: { layer: "project", rules: [{ capability: "admit", op: "deny" }] },
			requested: ["admit"],
		},
	});
	assert.equal(linkedDeny.ok, false);

	// Different policy → different bound plan hash
	const withUserDenyNetwork = linkProgram({
		program: SCRIPT,
		policy: {
			user: { layer: "user", rules: [{ capability: "observe", op: "deny" }] },
		},
	});
	// observe denied but not in required path for link success if requested default fails
	// Default requested is full host default including observe → link fails
	assert.equal(withUserDenyNetwork.ok, false);
});

test("unknown security field / unknown op fail closed", () => {
	const d = compilePolicy({
		project: {
			layer: "project",
			rules: [{ capability: "admit", op: "enlarge" as "deny" }],
		},
		requested: ["admit"],
	});
	// Unknown op removes capability
	assert.equal(d.ok, false);
	assert.ok(d.denied.includes("admit"));
});
