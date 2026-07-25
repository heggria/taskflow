#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const evidencePath = path.join(
	repoRoot,
	"docs/internal/webui/reference-set-v1/render-evidence.json",
);
const reviewTemplatePath = path.join(
	repoRoot,
	"docs/internal/webui/reference-set-v1/review-result.template.json",
);
const fixtureRoot = path.join(
	repoRoot,
	"packages/taskflow-control/test/fixtures/web-v1/reference",
);
const webAssetManifestPath = path.join(
	repoRoot,
	"packages/taskflow-web/dist/app/taskflow-web-assets.json",
);
const renderSourceScopes = [
	"package.json",
	"pnpm-lock.yaml",
	"tsconfig.base.json",
	"packages/taskflow-web",
	"packages/taskflow-control/src",
	"packages/taskflow-daemon/src",
	"packages/taskflow-cli/src",
	"packages/taskflow-cli/test/render-web-reference.mts",
	"scripts/generate-web-reference-fixtures.mjs",
];

function sha256(filePath) {
	return `sha256:${createHash("sha256")
		.update(fs.readFileSync(filePath))
		.digest("hex")}`;
}

if (!fs.existsSync(evidencePath)) {
	throw new Error("web reference render evidence is missing");
}
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const reviewTemplate = JSON.parse(
	fs.readFileSync(reviewTemplatePath, "utf8"),
);
if (evidence.evidenceVersion !== "taskflow-web-reference-render.v2") {
	throw new Error(`unexpected render evidence version: ${evidence.evidenceVersion}`);
}
if (evidence.status !== "rendered-awaiting-human-approval") {
	throw new Error(`unexpected render evidence status: ${evidence.status}`);
}
if (
	!evidence.candidate ||
	!/^[0-9a-f]{40}$/u.test(evidence.candidate.gitCommit) ||
	evidence.candidate.trackedSourceClean !== true ||
	!/^sha256:[0-9a-f]{64}$/u.test(evidence.candidate.webBuildId) ||
	!/^sha256:[0-9a-f]{64}$/u.test(
		evidence.candidate.assetManifestSha256,
	)
) {
	throw new Error("render evidence candidate provenance is incomplete");
}
const candidateCheck = spawnSync(
	"git",
	["cat-file", "-e", `${evidence.candidate.gitCommit}^{commit}`],
	{ cwd: repoRoot, encoding: "utf8" },
);
if (candidateCheck.status !== 0) {
	throw new Error(
		`render candidate commit is unavailable: ${candidateCheck.stderr}`,
	);
}
const ancestryCheck = spawnSync(
	"git",
	[
		"merge-base",
		"--is-ancestor",
		evidence.candidate.gitCommit,
		"HEAD",
	],
	{ cwd: repoRoot },
);
if (ancestryCheck.status !== 0) {
	throw new Error("render candidate must be an ancestor of the evidence tip");
}
const sourceDrift = spawnSync(
	"git",
	[
		"diff",
		"--quiet",
		evidence.candidate.gitCommit,
		"HEAD",
		"--",
		...renderSourceScopes,
	],
	{ cwd: repoRoot },
);
if (sourceDrift.status !== 0) {
	throw new Error(
		"rendered Web source differs from the recorded candidate commit",
	);
}
if (!fs.existsSync(webAssetManifestPath)) {
	const build = spawnSync(
		"pnpm",
		["--filter", "taskflow-web", "build"],
		{
			cwd: repoRoot,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (build.status !== 0) {
		throw new Error(
			`cannot rebuild the packaged Web asset manifest: ${build.stderr || build.stdout}`,
		);
	}
}
if (!fs.existsSync(webAssetManifestPath)) {
	throw new Error(
		"packaged Web asset manifest is missing after a successful build",
	);
}
if (
	sha256(webAssetManifestPath) !==
	evidence.candidate.assetManifestSha256
) {
	throw new Error("packaged Web asset manifest differs from render evidence");
}
const assetManifest = JSON.parse(
	fs.readFileSync(webAssetManifestPath, "utf8"),
);
if (assetManifest.webBuildId !== evidence.candidate.webBuildId) {
	throw new Error("packaged Web build id differs from render evidence");
}
if (evidence.review?.approved !== false) {
	throw new Error("unapproved reference evidence cannot claim approval");
}
const expectedRepresentative =
	evidence.matrix.representativeScreens *
	evidence.matrix.locales.length *
	evidence.matrix.themes.length *
	evidence.matrix.viewports.length;
if (
	evidence.matrix.representativeScreenshotCount !==
	expectedRepresentative
) {
	throw new Error("representative screenshot matrix is incomplete");
}
const expectedTotal =
	evidence.matrix.representativeScreenshotCount +
	evidence.matrix.supplementalScreenshotCount;
if (evidence.screenshots.length !== expectedTotal) {
	throw new Error(
		`expected ${expectedTotal} screenshots, found ${evidence.screenshots.length}`,
	);
}
const a11yAssessed = evidence.screenshots.filter(
	(screenshot) =>
		screenshot.seriousOrCriticalA11yViolations !== null,
).length;
if (a11yAssessed !== evidence.matrix.a11yAssessedScreenshotCount) {
	throw new Error(
		`expected ${evidence.matrix.a11yAssessedScreenshotCount} accessibility assessments, found ${a11yAssessed}`,
	);
}
for (const [fixtureId, digest] of Object.entries(
	evidence.fixtureDigests,
)) {
	const filePath = path.join(fixtureRoot, `${fixtureId}.json`);
	if (!fs.existsSync(filePath) || sha256(filePath) !== digest) {
		throw new Error(`${fixtureId}: fixture digest drift`);
	}
}
for (const screenshot of evidence.screenshots) {
	const filePath = path.resolve(repoRoot, screenshot.path);
	const relative = path.relative(repoRoot, filePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`${screenshot.path}: screenshot escaped the repository`);
	}
	if (!fs.existsSync(filePath)) {
		throw new Error(`${screenshot.path}: screenshot is missing`);
	}
	if (sha256(filePath) !== screenshot.sha256) {
		throw new Error(`${screenshot.path}: screenshot digest drift`);
	}
	if (screenshot.horizontalOverflow !== false) {
		throw new Error(`${screenshot.path}: horizontal overflow recorded`);
	}
	if (
		screenshot.seriousOrCriticalA11yViolations !== null &&
		screenshot.seriousOrCriticalA11yViolations !== 0
	) {
		throw new Error(
			`${screenshot.path}: serious accessibility violation recorded`,
		);
	}
}

const screenIds = [
	"simple-home",
	"active-task",
	"needs-input-decision",
	"completed-task",
	"unknown-reconciling",
	"pro-graph",
	"pro-evidence",
	"settings",
	"error-recovery",
];
if (
	reviewTemplate.schemaVersion !==
	"taskflow-web-reference-review.v1"
) {
	throw new Error("unexpected reference review template schema");
}
if (reviewTemplate.status !== "template-not-evidence") {
	throw new Error("reference review template cannot claim evidence");
}
if (reviewTemplate.reviewerRole !== "replace-with-product-owner") {
	throw new Error("reference review template must require product-owner");
}
if (reviewTemplate.independentFromImplementation !== false) {
	throw new Error("blank review template cannot claim independence");
}
if (
	JSON.stringify(reviewTemplate.requiredCoverage) !==
	JSON.stringify({
		screenFamilies: 9,
		matrixRenders: 144,
		supplementalRenders: 5,
		totalRenders: 149,
	})
) {
	throw new Error("reference review template coverage drifted");
}
if (
	JSON.stringify(reviewTemplate.reviewedCoverage) !==
	JSON.stringify({
		screenFamilies: [],
		renderEntries: 0,
	})
) {
	throw new Error("blank review template contains review coverage");
}
if (
	JSON.stringify(
		reviewTemplate.screenResults.map(({ screenId }) => screenId),
	) !== JSON.stringify(screenIds)
) {
	throw new Error("reference review template misses a screen family");
}
for (const result of reviewTemplate.screenResults) {
	if (result.decision !== "pending" || result.notes !== "") {
		throw new Error("reference review template contains a decision");
	}
}
if (
	Object.values(reviewTemplate.matrixChecks).some(
		(value) => value !== null,
	) ||
	reviewTemplate.overallDecision !== "pending" ||
	reviewTemplate.completedAt !== null ||
	reviewTemplate.reviewerAttestation !== false
) {
	throw new Error("reference review template contains approval evidence");
}

process.stdout.write(
	`web render evidence valid (${evidence.screenshots.length} screenshots; human approval pending)\n`,
);
