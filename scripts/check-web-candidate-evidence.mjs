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
	"artifacts/web-compat/83021958-to-fb765b21/report.json",
);
const benchmarkRoot = path.join(
	repositoryRoot,
	"artifacts/web-bench/fb765b21cc284cf70e84a577f190c4bce38d0a79",
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

const ledger = fs.readFileSync(ledgerPath, "utf8");
for (const file of [
	compatibilityPath,
	benchmarkPath,
	benchmarkSummaryPath,
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
