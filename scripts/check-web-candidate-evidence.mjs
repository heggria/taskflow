import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	WEB_NODE_MATRIX_VERSIONS,
	WEB_PRIMARY_NODE_VERSION,
} from "./web-runtime-versions.mjs";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const compatibilityPath = path.join(
	repositoryRoot,
	"artifacts/web-compat/aa34369a-to-130e1a3f/report.json",
);
const benchmarkRoot = path.join(
	repositoryRoot,
	"artifacts/web-bench/130e1a3f7c0bf991c96d6e0192a2517be43ff827",
);
const benchmarkPath = path.join(benchmarkRoot, "web-perf-v1.json");
const benchmarkSummaryPath = path.join(
	benchmarkRoot,
	"web-perf-v1.md",
);
const nodeMatrixPath = path.join(
	repositoryRoot,
	"artifacts/web-node-matrix/130e1a3f7c0bf991c96d6e0192a2517be43ff827/report.json",
);
const browserMatrixPath = path.join(
	repositoryRoot,
	"artifacts/web-browser-matrix/130e1a3f7c0bf991c96d6e0192a2517be43ff827/report.json",
);
const ledgerPath = path.join(
	repositoryRoot,
	"docs/internal/webui/immutable-candidate-evidence-v2.md",
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
const nativeSafariTwoSessionRevocationPath = path.join(
	repositoryRoot,
	"docs/internal/webui/native-safari-two-session-revocation-smoke-v1.json",
);
const currentNativeSafariReadPath = path.join(
	repositoryRoot,
	"docs/internal/webui/native-safari-current-read-smoke-v1.json",
);
const currentNativeSafariMutationPath = path.join(
	repositoryRoot,
	"docs/internal/webui/native-safari-current-mutation-smoke-v1.json",
);
const currentNativeSafariRejectCurrentPath = path.join(
	repositoryRoot,
	"docs/internal/webui/native-safari-current-reject-current-session-smoke-v1.json",
);
const currentNativeSafariCancelPath = path.join(
	repositoryRoot,
	"docs/internal/webui/native-safari-current-cancel-smoke-v1.json",
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
	"packages/taskflow-cli/test/e2e-web-console.mts",
	"packages/taskflow-cli/package.json",
	"packages/taskflow-web/src",
	"packages/taskflow-web/scripts",
	"packages/taskflow-web/index.html",
	"packages/taskflow-web/package.json",
	"packages/taskflow-web/vite.config.ts",
	"packages/taskflow-web/tsconfig.build.json",
	"scripts/bench-web.mjs",
	"scripts/test-web-browser-matrix.mjs",
	"scripts/test-web-node-matrix.mjs",
	"scripts/test-web-packaged-compatibility.mjs",
	"scripts/web-runtime-versions.mjs",
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"tsconfig.base.json",
	"tsconfig.json",
];
const browserHarnessPaths = [
	"packages/taskflow-cli/test/e2e-web-console.mts",
	"scripts/test-web-browser-matrix.mjs",
];

function sha256File(file) {
	return createHash("sha256")
		.update(fs.readFileSync(file))
		.digest("hex");
}

function sha256GitFile(commit, relativePath) {
	const result = spawnSync(
		"git",
		["show", `${commit}:${relativePath}`],
		{
			cwd: repositoryRoot,
			encoding: null,
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	assert.equal(
		result.status,
		0,
		`cannot read ${relativePath} from ${commit}`,
	);
	return `sha256:${createHash("sha256")
		.update(result.stdout)
		.digest("hex")}`;
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
		currentCandidateCommit,
		sourceCoverage = "historical",
		expectedSourceDigest,
		expectedManifestSha256,
		expectedBuildId,
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
	if (expectedSourceDigest !== undefined) {
		assert.equal(
			record.candidate.webSourceDigest,
			expectedSourceDigest,
			`${label} source digest must match the immutable candidate`,
		);
	}
	if (expectedManifestSha256 !== undefined) {
		assert.equal(
			record.candidate.webManifestSha256,
			expectedManifestSha256,
			`${label} manifest must match the immutable candidate`,
		);
	}
	if (expectedBuildId !== undefined) {
		assert.equal(
			record.candidate.webBuildId,
			expectedBuildId,
			`${label} Web build must match the immutable candidate`,
		);
	}
	assert.equal(record.environment.browser, "Safari");
	const nativeAncestry = spawnSync(
		"git",
		[
			"merge-base",
			"--is-ancestor",
			record.candidate.gitCommit,
			currentCandidateCommit,
		],
		{ cwd: repositoryRoot },
	);
	assert.equal(
		nativeAncestry.status,
		0,
		`${label} commit must be an ancestor of the current candidate`,
	);
	const sourceDriftAfterRecord = spawnSync(
		"git",
		[
			"diff",
			"--quiet",
			record.candidate.gitCommit,
			currentCandidateCommit,
			"--",
			...candidateSourceScopes,
		],
		{ cwd: repositoryRoot },
	);
	if (sourceCoverage === "historical") {
		assert.equal(
			sourceDriftAfterRecord.status,
			1,
			`${label} unexpectedly covers current source; record it as current evidence instead of historical evidence`,
		);
	} else {
		assert.equal(
			sourceCoverage,
			"current",
			`${label} has an unsupported source coverage`,
		);
		assert.equal(
			sourceDriftAfterRecord.status,
			0,
			`${label} is stale because candidate source drifted after the native Safari review`,
		);
	}
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
	expectedCommit: "60002c343ee4ab476bded389bf7bf34bfd9d4f13",
	expectedResult: "native-approval-and-revoke-all-smoke-pass",
	currentCandidateCommit: newBuild.gitCommit,
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
	expectedCommit: "60002c343ee4ab476bded389bf7bf34bfd9d4f13",
	expectedResult: "native-reject-and-current-session-smoke-pass",
	currentCandidateCommit: newBuild.gitCommit,
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
	expectedCommit: "60002c343ee4ab476bded389bf7bf34bfd9d4f13",
	expectedResult: "native-cancel-run-smoke-pass",
	currentCandidateCommit: newBuild.gitCommit,
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
	expectedCommit: "e19dfd4511a0c53375990bd07490066eb62a7d81",
	expectedResult:
		"native-safari-peer-session-invalidation-smoke-pass",
	currentCandidateCommit: newBuild.gitCommit,
});

const nativeSafariTwoSessionRevocationBytes = fs.readFileSync(
	nativeSafariTwoSessionRevocationPath,
	"utf8",
);
assertNoLocalPath(
	nativeSafariTwoSessionRevocationBytes,
	"native Safari two-session revocation record",
);
const nativeSafariTwoSessionRevocation = JSON.parse(
	nativeSafariTwoSessionRevocationBytes,
);
assertNativeSafariRecord(nativeSafariTwoSessionRevocation, {
	label: "native Safari two-session revocation record",
	expectedCommit: "d6ac8877ae805bc0b56f819116bcbc3a354c2588",
	expectedResult:
		"native-safari-two-cookie-jar-revocation-smoke-pass",
	currentCandidateCommit: newBuild.gitCommit,
});

const currentNativeSafariRecords = [
	{
		label: "current native Safari read/keyboard record",
		path: currentNativeSafariReadPath,
		result: "native-current-read-keyboard-smoke-pass",
	},
	{
		label: "current native Safari allow/revoke-all record",
		path: currentNativeSafariMutationPath,
		result:
			"native-current-approval-and-revoke-all-smoke-pass",
	},
	{
		label:
			"current native Safari reject/current-session record",
		path: currentNativeSafariRejectCurrentPath,
		result:
			"native-current-reject-and-current-session-smoke-pass",
	},
	{
		label: "current native Safari cancel record",
		path: currentNativeSafariCancelPath,
		result: "native-current-cancel-run-smoke-pass",
	},
];
for (const currentRecord of currentNativeSafariRecords) {
	const bytes = fs.readFileSync(currentRecord.path, "utf8");
	assertNoLocalPath(bytes, currentRecord.label);
	assertNativeSafariRecord(JSON.parse(bytes), {
		label: currentRecord.label,
		expectedCommit:
			"c04540019d99984366843536baa2b47771beb8fa",
		expectedResult: currentRecord.result,
		currentCandidateCommit: "HEAD",
		sourceCoverage: "current",
		expectedSourceDigest: benchmark.git.sourceDigest,
		expectedManifestSha256: newBuild.manifestSha256,
		expectedBuildId: benchmark.build.webBuildId,
	});
}

const nodeMatrixBytes = fs.readFileSync(nodeMatrixPath, "utf8");
assertNoLocalPath(nodeMatrixBytes, "Node matrix report");
const nodeMatrix = JSON.parse(nodeMatrixBytes);
assert.equal(nodeMatrix.schemaVersion, 1);
assert.equal(nodeMatrix.status, "pass");
assert.equal(nodeMatrix.candidate.gitCommit, newBuild.gitCommit);
assert.equal(nodeMatrix.candidate.trackedDirty, false);
assert.deepEqual(
	nodeMatrix.runtimes.map((runtime) => runtime.node),
	WEB_NODE_MATRIX_VERSIONS,
);
for (const runtime of nodeMatrix.runtimes) {
	assert.equal(runtime.suiteFiles, 8);
	assert.equal(runtime.testCount, 63);
	assert.equal(runtime.passCount, runtime.testCount);
	assert.equal(runtime.failCount, 0);
}

const browserMatrixBytes = fs.readFileSync(
	browserMatrixPath,
	"utf8",
);
assertNoLocalPath(browserMatrixBytes, "browser matrix report");
const browserMatrix = JSON.parse(browserMatrixBytes);
assert.equal(
	browserMatrix.schemaVersion,
	4,
	"browser matrix must bind its executable harness",
);
assert.equal(browserMatrix.status, "pass");
assertConcreteCommit(
	browserMatrix.candidate.gitCommit,
	"browser matrix commit",
);
const browserCandidateAncestry = spawnSync(
	"git",
	[
		"merge-base",
		"--is-ancestor",
		newBuild.gitCommit,
		browserMatrix.candidate.gitCommit,
	],
	{ cwd: repositoryRoot },
);
assert.equal(
	browserCandidateAncestry.status,
	0,
	"browser matrix must descend from the immutable source build",
);
const browserEvidenceAncestry = spawnSync(
	"git",
	[
		"merge-base",
		"--is-ancestor",
		browserMatrix.candidate.gitCommit,
		"HEAD",
	],
	{ cwd: repositoryRoot },
);
assert.equal(
	browserEvidenceAncestry.status,
	0,
	"current evidence tip must descend from the browser matrix candidate",
);
const browserSourceDrift = spawnSync(
	"git",
	[
		"diff",
		"--quiet",
		newBuild.gitCommit,
		browserMatrix.candidate.gitCommit,
		"--",
		...candidateSourceScopes,
	],
	{ cwd: repositoryRoot },
);
assert.equal(
	browserSourceDrift.status,
	0,
	"browser matrix candidate changed immutable production source",
);
assert.equal(browserMatrix.candidate.trackedDirty, false);
assert.equal(
	browserMatrix.candidate.manifestSha256,
	newBuild.manifestSha256,
);
assert.equal(
	browserMatrix.candidate.webBuildId,
	benchmark.build.webBuildId,
);
assert.deepEqual(
	browserMatrix.harness?.map((entry) => entry.path),
	browserHarnessPaths,
	"browser matrix harness inventory drifted",
);
for (const entry of browserMatrix.harness) {
	assert.equal(
		entry.sha256,
		sha256GitFile(
			browserMatrix.candidate.gitCommit,
			entry.path,
		),
		`${entry.path} digest does not match the matrix candidate`,
	);
	assert.equal(
		entry.sha256,
		`sha256:${sha256File(
			path.join(repositoryRoot, entry.path),
		)}`,
		`${entry.path} changed after browser evidence was recorded`,
	);
}
assert.deepEqual(
	browserMatrix.engines.map((engine) => [
		engine.browserEngine,
		engine.browserChannel ?? null,
	]),
	[
		["chromium", null],
		["firefox", null],
		["webkit", null],
		["chromium", "chrome"],
	],
);
const browserBooleanAssertions = [
	"packagedCli",
	"multiProject",
	"listenerReused",
	"independentLaunchCapabilities",
	"crossPortBrowserCookieIsolation",
	"sseConnected",
	"pollingFallbackObserved",
	"pollingProjectionEquivalent",
	"pollingGetSurfaceInventoryCovered",
	"simpleAttentionCopyVerified",
	"approvalDecisionCommitted",
	"approvalContinuationAfterRestartSafe",
	"approvalSettledAttemptsNotReplayed",
	"approvalPrivateCheckpointNotReceiptReachable",
	"cancelCommandCommitted",
	"completedReceiptAndArtifactRendered",
	"proGraphTimelineAndNodeDetailRendered",
	"proTabsKeyboardAndFocusVerified",
	"proGraphDisclosureKeyboardVerified",
	"receiptJsonExported",
	"receiptJsonLocallyChecked",
	"whyStaleDistinctFromReplay",
	"zeroTokenReplayExecuted",
	"proGraphListboxKeyboardParityVerified",
	"taskListPageVirtualizationVerified",
	"artifactDownloadPathObserved",
	"sensitiveArtifactDisclosureVerified",
	"sensitiveArtifactDeclineIssuedNoRequest",
	"sensitiveArtifactAcknowledgementObserved",
	"settingsSwitchAndSingleSelectionKeyboardVerified",
	"sessionSafetyDialogFocusAndDismissalVerified",
	"currentSessionLogoutCommitted",
	"listenerWideSessionRevocationCommitted",
	"listenerWideSessionRevocationInvalidatedPeer",
];
for (const engine of browserMatrix.engines) {
	const label = `${engine.browserEngine}:${engine.browserChannel ?? "bundled"}`;
	assert.equal(engine.attempts, 1, `${label} required a retry`);
	assert.match(engine.browserVersion, /^\d/u);
	for (const field of browserBooleanAssertions) {
		assert.equal(
			engine[field],
			true,
			`${label} assertion failed: ${field}`,
		);
	}
	for (const field of [
		"consoleErrors",
		"pageErrors",
		"cspViolations",
		"runtimeStyleInsertions",
		"inlineStyleAttributes",
		"runtimeStyleElements",
		"zeroTokenReplayProviderCalls",
		"zeroTokenReplayDurableWrites",
	]) {
		assert.equal(engine[field], 0, `${label} emitted ${field}`);
	}
	assert.equal(engine.mobileWidth, 320);
	assert.equal(engine.horizontalOverflow, false);
	if (engine.browserEngine === "firefox") {
		assert.equal(engine.browserTransportDiagnostics, 6);
	} else {
		assert.equal(engine.browserTransportDiagnostics, 0);
	}
	if (engine.browserEngine === "chromium") {
		assert.deepEqual(engine.a11yViolationCounts, {
			home: 0,
			task: 0,
		});
	}
}

const ledger = fs.readFileSync(ledgerPath, "utf8");
for (const file of [
	compatibilityPath,
	benchmarkPath,
	benchmarkSummaryPath,
	nodeMatrixPath,
	browserMatrixPath,
	nativeSafariMutationPath,
	nativeSafariRejectCurrentPath,
	nativeSafariCancelPath,
	nativeSafariPeerRevocationPath,
	nativeSafariTwoSessionRevocationPath,
	...currentNativeSafariRecords.map(({ path: file }) => file),
]) {
	assert.match(
		ledger,
		new RegExp(sha256File(file), "u"),
		`ledger does not bind ${path.relative(repositoryRoot, file)}`,
	);
}
assertNoLocalPath(ledger, "candidate evidence ledger");

process.stdout.write(
	`automated Web candidate evidence valid (${oldBuild.gitCommit.slice(0, 8)} → ${newBuild.gitCommit.slice(0, 8)}; 30 benchmark samples; ${browserMatrix.engines.length} browser lanes; ${currentNativeSafariRecords.length} current-source native Safari scoped records; peer-session records historical-only)\n`,
);
