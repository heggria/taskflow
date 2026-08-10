import assert from "node:assert/strict";
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
	for (const use of uses) assert.match(use, /@[0-9a-f]{40} # v\d+$/);
	assert.equal(
		uses.filter((use) => use.includes("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7")).length,
		2,
	);
	assert.ok(uses.some((use) => use.includes("pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6")));
	assert.ok(uses.some((use) => use.includes("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6")));
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

test("every repository workflow pins third-party actions to verified full SHAs", () => {
	const workflowDir = new URL("../../../.github/workflows/", import.meta.url);
	const trustedPins = new Map([
		["actions/checkout", "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"],
		["pnpm/action-setup", "0ebf47130e4866e96fce0953f49152a61190b271"],
		["actions/setup-node", "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e"],
		["actions/upload-pages-artifact", "fc324d3547104276b827a68afc52ff2a11cc49c9"],
		["actions/deploy-pages", "cd2ce8fcbc39b97be8ca5fce6e763baed58fa128"],
		["github/codeql-action/init", "99df26d4f13ea111d4ec1a7dddef6063f76b97e9"],
		["github/codeql-action/analyze", "99df26d4f13ea111d4ec1a7dddef6063f76b97e9"],
	]);
	const files = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file));
	assert.ok(files.length > 0, "no workflow files found");
	let actionCount = 0;
	for (const file of files) {
		const source = readFileSync(new URL(file, workflowDir), "utf8");
		for (const line of source.split("\n")) {
			const match = line.match(/^\s*(?:-\s+)?uses:\s+([^@\s]+)@([^\s]+)(?:\s+#\s+(v\d+))?\s*$/);
			if (!match) continue;
			actionCount++;
			const [, action, revision, versionComment] = match;
			assert.match(revision ?? "", /^[0-9a-f]{40}$/, `${file}: action must use a full commit SHA: ${line.trim()}`);
			assert.match(versionComment ?? "", /^v\d+$/, `${file}: pinned action must retain a major-version comment`);
			assert.equal(trustedPins.get(action ?? ""), revision, `${file}: ${action} is not pinned to its verified tag commit`);
		}
		assert.doesNotMatch(source, /^\s*(?:-\s+)?uses:\s+[^\s]+@(?![0-9a-f]{40}\b)/m, `${file}: mutable action ref`);
	}
	assert.ok(actionCount > 0, "no third-party actions found");
});
