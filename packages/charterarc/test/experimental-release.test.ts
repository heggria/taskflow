import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	sha512Integrity,
	verifyRegistryIdentity,
} from "../../../scripts/verify-published-package.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowPath = ".github/workflows/publish-charterarc-experimental.yml";

async function read(relativePath: string): Promise<string> {
	return readFile(path.join(repo, relativePath), "utf8");
}

test("experimental release: package and workflow cannot promote latest", async () => {
	const manifest = JSON.parse(await read("packages/charterarc/package.json"));
	assert.equal(manifest.version, "0.2.7-experimental.0");
	assert.notEqual(manifest.private, true);
	assert.equal(manifest.publishConfig?.tag, "experimental");
	assert.equal(manifest.publishConfig?.access, "public");
	assert.equal(manifest.scripts?.prepublishOnly, "npm run build");

	const stablePacker = await read("scripts/pack-release-packages.mjs");
	const stableNames =
		/export const RELEASE_PACKAGE_NAMES = \[([\s\S]*?)\];/.exec(stablePacker)?.[1] ?? "";
	assert.doesNotMatch(stableNames, /["']charterarc["']/);

	const stableWorkflow = await read(".github/workflows/publish.yml");
	assert.doesNotMatch(stableWorkflow, /(?:publish_one|verify_one) charterarc/);

	const workflow = await read(workflowPath);
	assert.match(workflow, /tags:\s*\n\s*- ["']charterarc-v\*-experimental\.\*["']/);
	assert.match(workflow, /workflow_dispatch:/);
	assert.match(workflow, /permissions:\s*\n\s*contents: read[^\n]*\n\s*id-token: write/);
	assert.doesNotMatch(workflow, /contents: write/);
	assert.match(workflow, /git merge-base --is-ancestor[^\n]*origin\/main/);
	assert.match(workflow, /charterarc-v\$\([^\n]*packages\/charterarc\/package\.json[^\n]*version/);
	assert.match(workflow, /pnpm run check:charterarc/);
	assert.match(workflow, /pnpm run test:pack-charterarc/);
	assert.match(
		workflow,
		/pack-release-packages\.mjs \.experimental-tarballs charterarc/,
	);
	assert.match(workflow, /npm install[\s\S]*\$tarball/);
	assert.match(workflow, /npm publish[^\n]*\$tarball[^\n]*--provenance/);
	assert.match(workflow, /npm publish[^\n]*--tag experimental/);
	assert.doesNotMatch(workflow, /--tag latest|dist-tag (?:add|set)[^\n]*latest/);
	assert.doesNotMatch(workflow, /dist-tag rm[^\n]*latest/);
	assert.match(workflow, /verify-published-package\.mjs[^\n]*packages\/charterarc[^\n]*\$tarball/);
	assert.match(workflow, /PUBLISH_WORKFLOW_PATH:\s*["']?\.github\/workflows\/publish-charterarc-experimental\.yml/);
	assert.match(workflow, /PUBLISH_REF:\s*\$\{\{ env\.PUBLISH_REF \}\}/);
	assert.match(workflow, /PUBLISH_COMMIT:\s*\$\{\{ env\.PUBLISH_SHA \}\}/);
	const verifier = await read("scripts/verify-published-package.mjs");
	assert.match(verifier, /process\.env\.PUBLISH_COMMIT \?\? process\.env\.GITHUB_SHA/);
	assert.match(workflow, /pnpm view "\$name" versions --json/);
	assert.match(workflow, /versions\.length !== 1 \|\| versions\[0\] !== version/);
	assert.match(workflow, /registry-forced first-publish latest=/);
	assert.match(workflow, /dist-tags/);
	assert.match(workflow, /experimental/);
	assert.match(workflow, /latest/);
	assert.doesNotMatch(workflow, /gh release create|Create GitHub Release/);

	const smoke = await read("scripts/smoke-packed-charterarc.mjs");
	assert.doesNotMatch(
		smoke,
		/assert\.equal\(manifest\.version, rootManifest\.version/,
		"the experimental CharterArc version must be allowed to differ from Taskflow's stable version",
	);

	const goal = await read("docs/internal/charterarc-autonomous-goal.md");
	assert.match(goal, /Before M4[\s\S]*npm\s+`experimental` dist-tag/);
	assert.match(goal, /must never explicitly set or move `latest`/);
	assert.match(goal, /registry-forced first-publish `latest`/);
	assert.match(goal, /Only after M4[\s\S]*`latest` dist-tag/);
});

test("experimental release: provenance verification binds the dedicated workflow", () => {
	const pkg = { name: "charterarc", version: "0.2.7-experimental.0" };
	const localIntegrity = sha512Integrity(Buffer.from("experimental tarball"));
	const digest = Buffer.from(
		localIntegrity.slice("sha512-".length),
		"base64",
	).toString("hex");
	const input = {
		pkg,
		localIntegrity,
		trustedOwners: ["heggria"],
		expectedRepository: "https://github.com/heggria/taskflow",
		expectedWorkflowPath: workflowPath,
		expectedRef: "refs/tags/charterarc-v0.2.7-experimental.0",
		expectedSha: "deadbeef",
		metadata: {
			name: pkg.name,
			version: pkg.version,
			maintainers: [{ name: "heggria" }],
			dist: {
				integrity: localIntegrity,
				attestations: {
					provenance: { predicateType: "https://slsa.dev/provenance/v1" },
				},
			},
		},
		provenanceStatement: {
			predicateType: "https://slsa.dev/provenance/v1",
			subject: [
				{
					name: `pkg:npm/${pkg.name}@${pkg.version}`,
					digest: { sha512: digest },
				},
			],
			predicate: {
				buildDefinition: {
					buildType:
						"https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
					externalParameters: {
						workflow: {
							repository: "https://github.com/heggria/taskflow",
							path: workflowPath,
							ref: "refs/tags/charterarc-v0.2.7-experimental.0",
						},
					},
					resolvedDependencies: [{ digest: { gitCommit: "deadbeef" } }],
				},
			},
		},
	};

	assert.deepEqual(verifyRegistryIdentity(input), []);
});
