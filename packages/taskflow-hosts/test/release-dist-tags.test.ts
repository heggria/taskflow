import assert from "node:assert/strict";
import { test } from "node:test";
import { STABLE_PACKAGE_NAMES } from "../../../scripts/verify-release-contract.mjs";
import { verifyReleaseDistTags } from "../../../scripts/verify-release-dist-tags.mjs";

for (const [version, channel] of [["1.0.0", "latest"], ["1.0.0-beta.1", "beta"], ["0.3.0-beta.1.2", "beta"]] as const) {
	test(`registry channel gate verifies all ten ${channel}=${version} while leaving other channels independent`, () => {
		const queried: string[] = [];
		const result = verifyReleaseDistTags(version, channel, (name) => {
			queried.push(name);
			return { latest: "0.2.10", beta: "0.3.0-beta.1", [channel]: version };
		});
		assert.deepEqual(queried, STABLE_PACKAGE_NAMES);
		assert.deepEqual(result.verified, STABLE_PACKAGE_NAMES);
	});
}

test("registry channel gate rejects one mismatching adapter even when the requested version exists on beta", () => {
	const queried: string[] = [];
	assert.throws(() => verifyReleaseDistTags("1.0.0", "latest", (name) => {
		queried.push(name);
		return { latest: name === "hermes-taskflow" ? "0.2.10" : "1.0.0", beta: "1.0.0" };
	}), /hermes-taskflow: npm latest must equal 1\.0\.0/);
	assert.deepEqual(queried, STABLE_PACKAGE_NAMES, "a mismatch must not conceal unchecked packages");
});

test("registry channel gate fails closed for absent, malformed, unavailable or non-string tags", () => {
	for (const tags of [null, undefined, [], {}, { latest: null }, { latest: false }, { latest: ["1.0.0"] }]) {
		const queried: string[] = [];
		assert.throws(() => verifyReleaseDistTags("1.0.0", "latest", (name) => {
			queried.push(name); return name === "taskflow-core" ? tags : { latest: "1.0.0" };
		}), /taskflow-core: .*dist-tag|taskflow-core: npm latest must equal/);
		assert.deepEqual(queried, STABLE_PACKAGE_NAMES);
	}
	const queried: string[] = [];
	assert.throws(() => verifyReleaseDistTags("1.0.0-beta.1", "beta", (name) => {
		queried.push(name);
		if (name === "taskflow-core") throw new Error("registry unavailable");
		return { beta: "1.0.0-beta.1" };
	}), /taskflow-core: unable to read npm dist-tags/);
	assert.deepEqual(queried, STABLE_PACKAGE_NAMES);
});

test("registry channel gate rejects channel substitution and unsupported prereleases before registry reads", () => {
	for (const [version, channel] of [["1.0.0", "beta"], ["1.0.0-beta.1", "latest"], ["1.0.0-alpha.1", "alpha"]]) {
		let queried = false;
		assert.throws(() => verifyReleaseDistTags(version!, channel!, () => { queried = true; return {}; }), /version\/channel mismatch|stable semver or a numbered beta/);
		assert.equal(queried, false);
	}
});
