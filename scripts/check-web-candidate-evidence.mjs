import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_PRIMARY_NODE_VERSION } from "./web-runtime-versions.mjs";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const compatibilityPath = path.join(
	repositoryRoot,
	"artifacts/web-compat/d8df9c65-to-7e555c7d/report.json",
);
const benchmarkRoot = path.join(
	repositoryRoot,
	"artifacts/web-bench/7e555c7d7f39109ee89a502f0d818cc34f1ce7fa",
);
const benchmarkPath = path.join(benchmarkRoot, "web-perf-v1.json");
const benchmarkSummaryPath = path.join(
	benchmarkRoot,
	"web-perf-v1.md",
);
const ledgerPath = path.join(
	repositoryRoot,
	"docs/internal/webui/immutable-candidate-evidence-v1.md",
);
const nativeSafariMutationPath = path.join(
	repositoryRoot,
	"docs/internal/webui/native-safari-mutation-smoke-v1.json",
);
const nativeSafariRejectCurrentPath = path.join(
	repositoryRoot,
	"docs/internal/webui/native-safari-reject-current-session-smoke-v1.json",
);
const nativeSafariCancelPath = path.join(
	repositoryRoot,
	"docs/internal/webui/native-safari-cancel-smoke-v1.json",
);
const nativeSafariPeerRevocationPath = path.join(
	repositoryRoot,
	"docs/internal/webui/native-safari-peer-revocation-smoke-v1.json",
);
const candidateSourceScopes = [
	"packages/taskflow-core/src",
	"packages/taskflow-core/package.json",
	"packages/taskflow-control/src",
	"packages/taskflow-control/package.json",
	"packages/taskflow-daemon/src",
	"packages/taskflow-daemon/package.json",
	"packages/taskflow-cli/src",
	"packages/taskflow-cli/scripts",
	"packages/taskflow-cli/package.json",
	"packages/taskflow-web/src",
	"packages/taskflow-web/scripts",
	"packages/taskflow-web/index.html",
	"packages/taskflow-web/package.json",
	"packages/taskflow-web/vite.config.ts",
	"packages/taskflow-web/tsconfig.build.json",
	"scripts/bench-web.mjs",
	"scripts/web-runtime-versions.mjs",
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"tsconfig.base.json",
	"tsconfig.json",
];

function sha256File(file) {
	return createHash("sha256")
		.update(fs.readFileSync(file))
		.digest("hex");
}

function assertConcreteCommit(value, label) {
	assert.equal(typeof value, "string", `${label} must be a string`);
	assert.match(value, /^[0-9a-f]{40}$/iu, `${label} must be 40-hex`);
	const result = spawnSync(
		"git",
		["cat-file", "-e", `${value}^{commit}`],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	assert.equal(
		result.status,
		0,
		`${label} is not an available commit: ${result.stderr}`,
	);
}

function assertNoLocalPath(bytes, label) {
	assert.doesNotMatch(bytes, /\/Users\//u, `${label} leaks a local path`);
	assert.doesNotMatch(
		bytes,
		/#launch=[A-Za-z0-9_-]{20,}/u,
		`${label} leaks a launch capability`,
	);
}

function assertNativeSafariRecord(
	record,
	{
		label,
		expectedCommit,
		expectedResult,
		finalCandidateCommit,
	},
) {
	assert.equal(record.schemaVersion, 1);
	assert.equal(record.result, expectedResult);
	assert.equal(record.candidate.gitCommit, expectedCommit);
	assertConcreteCommit(record.candidate.gitCommit, `${label} commit`);
	assert.equal(record.candidate.trackedCandidateSourceDirty, false);
	assert.match(
		record.candidate.webSourceDigest,
		/^sha256:[0-9a-f]{64}$/u,
	);
	assert.match(
		record.candidate.webManifestSha256,
		/^sha256:[0-9a-f]{64}$/u,
	);
	assert.match(
		record.candidate.webBuildId,
		/^sha256:[0-9a-f]{64}$/u,
	);
	assert.equal(record.environment.browser, "Safari");
	const nativeAncestry = spawnSync(
		"git",
		[
			"merge-base",
			"--is-ancestor",
			record.candidate.gitCommit,
			finalCandidateCommit,
		],
		{ cwd: repositoryRoot },
	);
	assert.equal(
		nativeAncestry.status,
		0,
		`${label} commit must be an ancestor of the immutable candidate`,
	);
	for (const [name, passed] of Object.entries(record.assertions)) {
		assert.equal(passed, true, `${label} assertion failed: ${name}`);
	}
	assert.equal(
		record.excludedClaims.some((claim) =>
			claim.includes("VoiceOver"),
		),
		true,
	);
}

const compatibilityBytes = fs.readFileSync(
	compatibilityPath,
	"utf8",
);
assertNoLocalPath(compatibilityBytes, "compatibility report");
const compatibility = JSON.parse(compatibilityBytes);
assert.equal(compatibility.schemaVersion, 2);
assert.equal(compatibility.status, "pass");
assert.equal(
	compatibility.runtime.node,
	`v${WEB_PRIMARY_NODE_VERSION}`,
);
const oldBuild = compatibility.builds.old;
const newBuild = compatibility.builds.new;
assertConcreteCommit(oldBuild.gitCommit, "old build commit");
assertConcreteCommit(newBuild.gitCommit, "new build commit");
assert.notEqual(oldBuild.gitCommit, newBuild.gitCommit);
assert.notEqual(oldBuild.manifestSha256, newBuild.manifestSha256);
const ancestry = spawnSync(
	"git",
	["merge-base", "--is-ancestor", oldBuild.gitCommit, newBuild.gitCommit],
	{ cwd: repositoryRoot },
);
assert.equal(
	ancestry.status,
	0,
	"compatibility new build must descend from the old build",
);
const candidateAncestry = spawnSync(
	"git",
	["merge-base", "--is-ancestor", newBuild.gitCommit, "HEAD"],
	{ cwd: repositoryRoot },
);
assert.equal(
	candidateAncestry.status,
	0,
	"current evidence tip must descend from the immutable new build",
);
const sourceDrift = spawnSync(
	"git",
	[
		"diff",
		"--quiet",
		newBuild.gitCommit,
		"--",
		...candidateSourceScopes,
	],
	{ cwd: repositoryRoot },
);
assert.equal(
	sourceDrift.status,
	0,
	"candidate production or benchmark source changed after immutable evidence",
);
const sourceWorkingTree = spawnSync(
	"git",
	[
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--",
		...candidateSourceScopes,
	],
	{ cwd: repositoryRoot, encoding: "utf8" },
);
assert.equal(sourceWorkingTree.status, 0);
assert.equal(
	sourceWorkingTree.stdout.trim(),
	"",
	"candidate production or benchmark source is dirty",
);
assert.deepEqual(
	compatibility.pairs.map((pair) => pair.label),
	["old-client/new-server", "new-client/old-server"],
);
for (const pair of compatibility.pairs) {
	assert.equal(pair.pass, true, `${pair.label} did not pass`);
	assert.equal(pair.navigationStatus, 200);
	assert.equal(pair.bootstrapStatus, 200);
	assert.equal(pair.bootstrapSchemaVersion, "web.v1");
	assert.equal(pair.pageErrorCount, 0);
	assert.equal(pair.consoleErrorCount, 0);
	assert.deepEqual(pair.pageErrors, []);
	assert.deepEqual(pair.consoleErrors, []);
}
assert.equal(
	compatibility.pairs[0].server.gitCommit,
	newBuild.gitCommit,
);
assert.equal(
	compatibility.pairs[0].client.gitCommit,
	oldBuild.gitCommit,
);
assert.equal(
	compatibility.pairs[1].server.gitCommit,
	oldBuild.gitCommit,
);
assert.equal(
	compatibility.pairs[1].client.gitCommit,
	newBuild.gitCommit,
);

const benchmarkBytes = fs.readFileSync(benchmarkPath, "utf8");
assertNoLocalPath(benchmarkBytes, "benchmark report");
const benchmark = JSON.parse(benchmarkBytes);
assert.equal(benchmark.schemaVersion, 4);
assert.equal(benchmark.profile, "web-perf-v1");
assert.equal(benchmark.status, "structural-pass");
assert.equal(benchmark.git.commit, newBuild.gitCommit);
assert.equal(benchmark.git.dirty, false);
assert.match(benchmark.git.sourceDigest, /^sha256:[0-9a-f]{64}$/u);
assert.equal(benchmark.environment.node, `v${WEB_PRIMARY_NODE_VERSION}`);
assert.equal(benchmark.environment.nodeVersionMatches, true);
assert.equal(benchmark.environment.canonicalProfile, false);
assert.equal(benchmark.procedure.samples, 30);
assert.equal(benchmark.fixture.projects, 100);
assert.equal(benchmark.fixture.runs, 10_000);
assert.equal(benchmark.fixture.graphNodes, 2_000);
assert.equal(
	benchmark.build.manifestSha256,
	newBuild.manifestSha256,
);
assert.equal(benchmark.checks.simpleShellJs.status, "pass");
assert.equal(benchmark.checks.layoutShift.status, "pass");
assert.equal(benchmark.checks.cspClean.status, "pass");
for (const key of [
	"coldHomeUsefulMs",
	"coldOwnerReadyMs",
	"coldLaunchToUsefulMs",
	"warmHomeInteractiveMs",
	"cachedProInteractionMs",
	"eventToVisibleMs",
	"eventCommitToReceiptMs",
	"eventReceiptToVisibleMs",
]) {
	assert.equal(
		benchmark.raw[key].length,
		30,
		`${key} must retain 30 raw samples`,
	);
}
assert.equal(benchmark.raw.largeData.taskRows, 10_000);
assert.equal(benchmark.raw.largeData.graphNodes, 2_000);
assert.equal(benchmark.raw.largeData.contentVisibility, "auto");

const summaryBytes = fs.readFileSync(benchmarkSummaryPath, "utf8");
assertNoLocalPath(summaryBytes, "benchmark summary");
assert.match(summaryBytes, new RegExp(newBuild.gitCommit, "u"));
assert.match(summaryBytes, /Source: `[^`]+` \(clean\)/u);

const nativeSafariMutationBytes = fs.readFileSync(
	nativeSafariMutationPath,
	"utf8",
);
assertNoLocalPath(
	nativeSafariMutationBytes,
	"native Safari mutation record",
);
const nativeSafariMutation = JSON.parse(nativeSafariMutationBytes);
assertNativeSafariRecord(nativeSafariMutation, {
	label: "native Safari allow/revoke-all record",
	expectedCommit: "d8df9c650b68e4c0854aaad03e6da3ce0dc3352f",
	expectedResult: "native-approval-and-revoke-all-smoke-pass",
	finalCandidateCommit: newBuild.gitCommit,
});

const nativeSafariRejectCurrentBytes = fs.readFileSync(
	nativeSafariRejectCurrentPath,
	"utf8",
);
assertNoLocalPath(
	nativeSafariRejectCurrentBytes,
	"native Safari reject/current-session record",
);
const nativeSafariRejectCurrent = JSON.parse(
	nativeSafariRejectCurrentBytes,
);
assertNativeSafariRecord(nativeSafariRejectCurrent, {
	label: "native Safari reject/current-session record",
	expectedCommit: "d8df9c650b68e4c0854aaad03e6da3ce0dc3352f",
	expectedResult: "native-reject-and-current-session-smoke-pass",
	finalCandidateCommit: newBuild.gitCommit,
});

const nativeSafariCancelBytes = fs.readFileSync(
	nativeSafariCancelPath,
	"utf8",
);
assertNoLocalPath(
	nativeSafariCancelBytes,
	"native Safari cancel record",
);
const nativeSafariCancel = JSON.parse(nativeSafariCancelBytes);
assertNativeSafariRecord(nativeSafariCancel, {
	label: "native Safari cancel record",
	expectedCommit: "794c85f8a78d30c457ef63ad9a5f2b0c69d56356",
	expectedResult: "native-cancel-run-smoke-pass",
	finalCandidateCommit: newBuild.gitCommit,
});

const nativeSafariPeerRevocationBytes = fs.readFileSync(
	nativeSafariPeerRevocationPath,
	"utf8",
);
assertNoLocalPath(
	nativeSafariPeerRevocationBytes,
	"native Safari peer-revocation record",
);
const nativeSafariPeerRevocation = JSON.parse(
	nativeSafariPeerRevocationBytes,
);
assertNativeSafariRecord(nativeSafariPeerRevocation, {
	label: "native Safari peer-revocation record",
	expectedCommit: newBuild.gitCommit,
	expectedResult:
		"native-safari-peer-session-invalidation-smoke-pass",
	finalCandidateCommit: newBuild.gitCommit,
});
assert.equal(
	nativeSafariPeerRevocation.candidate.webSourceDigest,
	benchmark.git.sourceDigest,
);
assert.equal(
	nativeSafariPeerRevocation.candidate.webManifestSha256,
	newBuild.manifestSha256,
);
assert.equal(
	nativeSafariPeerRevocation.candidate.webBuildId,
	benchmark.build.webBuildId,
);

const ledger = fs.readFileSync(ledgerPath, "utf8");
for (const file of [
	compatibilityPath,
	benchmarkPath,
	benchmarkSummaryPath,
	nativeSafariMutationPath,
	nativeSafariRejectCurrentPath,
	nativeSafariCancelPath,
	nativeSafariPeerRevocationPath,
]) {
	assert.match(
		ledger,
		new RegExp(sha256File(file), "u"),
		`ledger does not bind ${path.relative(repositoryRoot, file)}`,
	);
}
assertNoLocalPath(ledger, "candidate evidence ledger");

process.stdout.write(
	`immutable Web candidate evidence valid (${oldBuild.gitCommit.slice(0, 8)} → ${newBuild.gitCommit.slice(0, 8)}; 30 benchmark samples)\n`,
);
