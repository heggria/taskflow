#!/usr/bin/env node
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
if (evidence.status !== "rendered-awaiting-human-approval") {
	throw new Error(`unexpected render evidence status: ${evidence.status}`);
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
	const filePath = path.join(repoRoot, screenshot.path);
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
