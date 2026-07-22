/**
 * P8 grants/token grammar + enforcement capabilities — behavior tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	compileEnforcement,
	DEFAULT_ENFORCEMENT,
	grantCoveredBy,
	isValidCapabilityToken,
	narrowGrants,
} from "../src/index.ts";

test("capability token grammar: valid hierarchical; reject traversal/spaces", () => {
	assert.equal(isValidCapabilityToken("admit"), true);
	assert.equal(isValidCapabilityToken("provider-submit:script"), true);
	assert.equal(isValidCapabilityToken("a:b:c"), true);
	assert.equal(isValidCapabilityToken(""), false);
	assert.equal(isValidCapabilityToken("../evil"), false);
	assert.equal(isValidCapabilityToken("a/b"), false);
	assert.equal(isValidCapabilityToken("has space"), false);
	assert.equal(isValidCapabilityToken("Upper"), false);
	assert.equal(isValidCapabilityToken(":bad"), false);
});

test("grantCoveredBy: parent covers child; not reverse; not sibling", () => {
	assert.equal(grantCoveredBy("provider-submit:script", "provider-submit"), true);
	assert.equal(grantCoveredBy("provider-submit", "provider-submit"), true);
	assert.equal(grantCoveredBy("provider-submit", "provider-submit:script"), false);
	assert.equal(grantCoveredBy("network", "admit"), false);
	assert.equal(grantCoveredBy("provider-submit-extra", "provider-submit"), false);
});

test("narrowGrants: never enlarges; invalid dropped; sorted unique", () => {
	const ceilings = ["admit", "provider-submit", "observe"];
	const narrowed = narrowGrants(
		["admit", "provider-submit:script", "network", "../x", "observe", "admit"],
		ceilings,
	);
	assert.deepEqual(narrowed, ["admit", "observe", "provider-submit:script"]);
	// Empty ceiling → nothing
	assert.deepEqual(narrowed.length > 0 ? narrowGrants(["admit"], []) : [], []);
	// Project cannot enlarge past host ceiling
	const hostOnly = narrowGrants(["network", "admit"], ["admit"]);
	assert.deepEqual(hostOnly, ["admit"]);
});

test("P8 enforcement: default attenuated; sandbox without support fail-closed", () => {
	const def = compileEnforcement(undefined, { sandboxAvailable: false });
	assert.equal(def.ok, true);
	if (def.ok) {
		assert.deepEqual(def.effective, DEFAULT_ENFORCEMENT);
		assert.match(def.digest, /^enf:[0-9a-f]+$/);
	}

	const sandOk = compileEnforcement(
		{ processIsolation: "sandboxed" },
		{ sandboxAvailable: true },
	);
	assert.equal(sandOk.ok, true);

	const sandFail = compileEnforcement(
		{ processIsolation: "sandboxed" },
		{ sandboxAvailable: false },
	);
	assert.equal(sandFail.ok, false);
	if (!sandFail.ok) {
		assert.match(sandFail.reason, /sandboxed unsupported|fail closed/i);
	}

	const badMode = compileEnforcement(
		{ resolution: "teleport" as "contained" },
		{ sandboxAvailable: false },
	);
	assert.equal(badMode.ok, false);
});
