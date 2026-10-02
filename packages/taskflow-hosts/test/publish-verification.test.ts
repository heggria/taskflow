import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { sha512Integrity, verifyRegistryIdentity } from "../../../scripts/verify-published-package.mjs";

const pkg = { name: "taskflow-hosts", version: "0.2.1" };
const localIntegrity = sha512Integrity(Buffer.from("official tarball"));
const digest = Buffer.from(localIntegrity.slice("sha512-".length), "base64").toString("hex");

function fixtures() {
	return {
		pkg,
		localIntegrity,
		trustedOwners: ["heggria", "muyun"],
		expectedRepository: "https://github.com/heggria/taskflow",
		expectedRef: "refs/tags/v0.2.1",
		expectedSha: "deadbeef",
		metadata: {
			name: pkg.name,
			version: pkg.version,
			maintainers: [{ name: "heggria", email: "owner@example.com" }],
			dist: {
				integrity: localIntegrity,
				attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
			},
		},
		provenanceStatement: {
			predicateType: "https://slsa.dev/provenance/v1",
			subject: [{ name: `pkg:npm/${pkg.name}@${pkg.version}`, digest: { sha512: digest } }],
			predicate: {
				buildDefinition: {
					buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
					externalParameters: {
						workflow: {
							repository: "https://github.com/heggria/taskflow",
							path: ".github/workflows/publish.yml",
							ref: "refs/tags/v0.2.1",
						},
					},
					resolvedDependencies: [{ digest: { gitCommit: "deadbeef" } }],
				},
			},
		},
	};
}

test("publish verification accepts the trusted owner, exact tarball, and tag provenance", () => {
	assert.deepEqual(verifyRegistryIdentity(fixtures()), []);
});

test("publish verification rejects a preclaimed package even when the version exists", () => {
	const input = fixtures();
	input.metadata.maintainers = [{ name: "attacker", email: "bad@example.com" }];
	input.metadata.dist.integrity = sha512Integrity(Buffer.from("malicious tarball"));
	input.metadata.dist.attestations = {} as typeof input.metadata.dist.attestations;
	const errors = verifyRegistryIdentity(input);
	assert.ok(errors.some((error: string) => error.includes("trusted npm owner")));
	assert.ok(errors.some((error: string) => error.includes("integrity mismatch")));
	assert.ok(errors.some((error: string) => error.includes("no SLSA v1")));
});

test("publish verification rejects provenance from another repository or commit", () => {
	const input = fixtures();
	input.provenanceStatement.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/attacker/fork";
	input.provenanceStatement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = "cafebabe";
	const errors = verifyRegistryIdentity(input);
	assert.ok(errors.some((error: string) => error.includes("provenance repository")));
	assert.ok(errors.some((error: string) => error.includes("provenance commit")));
});

function workflowJob(source: string, name: string): string {
	const lines = source.split("\n");
	const start = lines.findIndex((line) => line === `  ${name}:`);
	assert.ok(start >= 0, `missing ${name} job`);
	const next = lines.findIndex((line, index) => index > start && /^  [a-zA-Z0-9_-]+:$/.test(line));
	return lines.slice(start, next < 0 ? undefined : next).join("\n");
}

test("publish workflow pins actions and isolates npm provenance from release permissions", () => {
	const source = readFileSync(new URL("../../../.github/workflows/publish.yml", import.meta.url), "utf8");
	const uses = source.match(/^\s*- uses: .+$/gm) ?? [];
	assert.equal(uses.length, 4);
	for (const use of uses) assert.match(use, /@[0-9a-f]{40} # v\d+(?:\.\d+\.\d+)?$/);
	assert.equal(
		uses.filter((use) => use.includes("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7")).length,
		2,
	);
	assert.ok(uses.some((use) => use.includes("pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0")));
	assert.ok(uses.some((use) => use.includes("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7")));
	assert.doesNotMatch(source, /uses:\s+\S+@v\d+/);

	const publish = workflowJob(source, "publish");
	assert.match(publish, /permissions:\n      contents: read\s+#.*\n      id-token: write\s+#/);
	assert.doesNotMatch(publish, /contents: write/);
	assert.doesNotMatch(publish, /Create GitHub Release/);

	const release = workflowJob(source, "release");
	assert.match(release, /needs: publish/);
	assert.match(release, /permissions:\n      contents: write\s+#/);
	assert.doesNotMatch(release, /id-token:/);
	assert.match(release, /Create GitHub Release/);
});

test("publish workflow verifies every package after registry mutation", () => {
	const workflow = readFileSync(new URL("../../../.github/workflows/publish.yml", import.meta.url), "utf8");
	assert.match(workflow, /verify_one\(\)/);
	for (const pkg of [
		"taskflow-core",
		"taskflow-mcp-core",
		"taskflow-hosts",
		"taskflow-dsl",
		"pi-taskflow",
		"codex-taskflow",
		"claude-taskflow",
		"opencode-taskflow",
		"grok-taskflow",
		"hermes-taskflow",
	]) {
		assert.match(workflow, new RegExp(`verify_one ${pkg}`));
	}
});

test("publish workflow smokes, publishes, and verifies one deterministic tarball set", () => {
	const workflow = readFileSync(new URL("../../../.github/workflows/publish.yml", import.meta.url), "utf8");
	assert.match(workflow, /Create deterministic release tarballs[\s\S]*pack-release-packages\.mjs \.release-tarballs/);
	assert.match(workflow, /smoke-packed-packages\.mjs \.release-tarballs/);
	assert.match(workflow, /npm publish "\$tarball" --provenance --access public/);
	assert.match(workflow, /verify-published-package\.mjs "packages\/\$pkg" "\$tarball"/);
	assert.doesNotMatch(workflow, /pnpm publish --filter/);
});

// Enumerate uses directives before parsing their refs/comments. A restrictive
// match must never silently skip an action when Dependabot changes its comment.
function verifyActionPins(source: string, trustedPins: ReadonlyMap<string, string>, file: string): number {
	let count = 0;
	for (const line of source.split("\n")) {
		if (!/^\s*(?:-\s+)?uses:/.test(line)) continue;
		const match = line.match(/^\s*(?:-\s+)?uses:\s+([^@\s]+)@([0-9a-f]{40})\s+#\s+(v\d+(?:\.\d+\.\d+)?)\s*$/);
		assert.ok(match, `${file}: action must use a full commit SHA and a major or semver comment: ${line.trim()}`);
		const [, action, revision] = match;
		assert.equal(trustedPins.get(action!), revision, `${file}: ${action} is not pinned to its verified tag commit`);
		count++;
	}
	return count;
}

test("action pin validation accepts major and semver comments without skipping either", () => {
	const sha = "ea17c68df8912ef543352723c149a84f56e3d413";
	const pins = new Map([["pnpm/action-setup", sha]]);
	assert.equal(verifyActionPins(`  - uses: pnpm/action-setup@${sha} # v6\n    uses: pnpm/action-setup@${sha} # v6.1.0`, pins, "fixture"), 2);
	for (const use of [
		`pnpm/action-setup@${"0".repeat(40)} # v6.1.0`,
		`unknown/action@${sha} # v6.1.0`,
		"pnpm/action-setup@v6.1.0 # v6.1.0",
		`pnpm/action-setup@${sha}`,
		`pnpm/action-setup@${sha} # v6.1`,
		`"pnpm/action-setup@${sha}" # v6.1.0`,
		"",
	]) {
		assert.throws(() => verifyActionPins(`  - uses: ${use}`, pins, "fixture"), `must reject: ${use}`);
	}
});

test("every repository workflow pins third-party actions to verified full SHAs", () => {
	const workflowDir = new URL("../../../.github/workflows/", import.meta.url);
	const trustedPins = new Map([
		["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
		["pnpm/action-setup", "ea17c68df8912ef543352723c149a84f56e3d413"], // v6.1.0
		["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
		["actions/upload-pages-artifact", "fc324d3547104276b827a68afc52ff2a11cc49c9"],
		["actions/deploy-pages", "368f82528645a54fb793d4d04e342629a3f51346"],
		["github/codeql-action/init", "cdf488f595d80d6e07e03d4674febd5ab45fa938"], // v4.37.9
		["github/codeql-action/analyze", "cdf488f595d80d6e07e03d4674febd5ab45fa938"],
		["hashgraph-online/ai-plugin-scanner-action", "484da6f8e99a057233b939ab50450a14a68f5a1c"],
	]);
	const files = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file));
	assert.ok(files.length > 0, "no workflow files found");
	let actionCount = 0;
	for (const file of files) {
		actionCount += verifyActionPins(readFileSync(new URL(file, workflowDir), "utf8"), trustedPins, file);
	}
	assert.ok(actionCount > 0, "no third-party actions found");
});

test("scanner upgrades retain the high-severity and minimum-score gates", () => {
	const workflow = readFileSync(new URL("../../../.github/workflows/plugin-scanner.yml", import.meta.url), "utf8");
	assert.match(workflow, /min_score: 80/);
	assert.match(workflow, /fail_on_severity: high/);
	assert.match(workflow, /install_cisco: "true"/);
	assert.match(workflow, /cisco_skill_scan: "on"/);
	assert.match(workflow, /cisco_policy: balanced/);
	assert.match(workflow, /if: always\(\)\n        run: node scripts\/verify-plugin-scan-coverage\.mjs plugin-security-report\.json/);
	assert.match(workflow, /online: "false"/);
	assert.match(workflow, /submission_enabled: "false"/);
	assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});


test("publish workflow rejects candidate release notes before packing or publishing", () => {
	const workflow = readFileSync(new URL("../../../.github/workflows/publish.yml", import.meta.url), "utf8");
	const gate = workflow.indexOf("node scripts/verify-release-contract.mjs --published");
	assert.ok(gate >= 0, "dated release contract is mandatory");
	assert.ok(gate < workflow.indexOf("Create deterministic release tarballs"), "reject drift before preparing release artifacts");
	assert.ok(gate < workflow.indexOf("npm publish"), "reject drift before npm mutation");
});


test("existing GitHub releases rerun under set -e with typed false/true state and reject malformed booleans", () => {
	const workflow = readFileSync(new URL("../../../.github/workflows/publish.yml", import.meta.url), "utf8");
	const start = workflow.indexOf('            RELEASE_TAG="');
	assert.ok(start >= 0, "existing release validation block missing");
	const end = workflow.indexOf("\n          fi", start);
	assert.ok(end > start, "existing release validation block incomplete");
	// Execute the actual workflow's rerun branch rather than a duplicate of
	// its jq filters. No gh/network call is needed for existing metadata.
	const script = `set -euo pipefail\n${workflow.slice(start, end)}`;
	const cases: [string, Record<string, unknown>, string, boolean][] = [
		["stable false/false", { draft: false, prerelease: false }, "1.0.0", true],
		["beta false/true", { draft: false, prerelease: true }, "1.0.0-beta.1", true],
		["draft true", { draft: true, prerelease: false }, "1.0.0", false],
		["stable prerelease true", { draft: false, prerelease: true }, "1.0.0", false],
		["beta prerelease false", { draft: false, prerelease: false }, "1.0.0-beta.1", false],
	];
	for (const field of ["draft", "prerelease"]) {
		for (const value of [null, undefined, "false", 0, {}, []]) {
			const state: Record<string, unknown> = { draft: false, prerelease: false };
			if (value === undefined) delete state[field]; else state[field] = value;
			cases.push([`${field} ${value === undefined ? "missing" : JSON.stringify(value)}`, state, "1.0.0", false]);
		}
	}
	for (const [name, state, version, accepted] of cases) {
		const result = spawnSync("bash", ["-c", script], {
			encoding: "utf8",
			env: { ...process.env, VERSION: version, GITHUB_REF_NAME: `v${version}`, TAG_COMMIT: "deadbeef",
				RELEASE_JSON: JSON.stringify({ tag_name: `v${version}`, target_commitish: "deadbeef", ...state }) },
		});
		assert.equal(result.error, undefined, `${name}: could not execute workflow branch`);
		if (accepted) {
			assert.equal(result.status, 0, `${name}: ${result.stderr}`);
			assert.match(result.stdout, /verified target; skipping creation/, name);
		} else {
			assert.notEqual(result.status, 0, `${name}: malformed/incompatible state must fail closed`);
			assert.doesNotMatch(result.stdout, /skipping creation/, name);
		}
	}
});


test("publish job verifies registry channels after every artifact and gates GitHub Release creation", () => {
	const workflow = readFileSync(new URL("../../../.github/workflows/publish.yml", import.meta.url), "utf8");
	const publish = workflowJob(workflow, "publish");
	const guard = publish.indexOf('node scripts/verify-release-dist-tags.mjs "$VERSION" "$NPM_TAG"');
	assert.ok(guard > publish.indexOf("verify_one hermes-taskflow"), "verify channels only after all ten provenance/integrity checks");
	assert.ok(guard >= 0, "npm channel check is mandatory");
	assert.doesNotMatch(publish, /continue-on-error:\s*true/);
	const release = workflowJob(workflow, "release");
	assert.match(release, /needs: publish/);
});
