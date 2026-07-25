#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const referenceRoot = path.join(
  repositoryRoot,
  "docs/internal/webui/reference-set-v1",
);
const laneIds = [
  "safari-voiceover-macos",
  "chrome-voiceover-macos",
  "edge-narrator-windows",
  "firefox-nvda-windows",
  "edge-forced-colors-windows",
];
const taskIds = [
  "launch-simple",
  "skip-and-navigation",
  "task-state",
  "approval-dialog",
  "mode-and-tabs",
  "graph-listbox",
  "evidence",
  "live-update",
  "narrow-zoom-contrast",
  "session-dialogs",
];
const commitPattern = /^[0-9a-f]{40}$/u;
const opaqueIdPattern = /^[A-Za-z0-9_-]{8,64}$/u;
const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function sha256File(filePath) {
  return `sha256:${createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex")}`;
}

function assertText(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.notEqual(value.trim(), "", `${label} must not be empty`);
}

function assertOpaqueId(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, opaqueIdPattern, `${label} must be an opaque id`);
}

function assertTimestamp(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, isoTimestampPattern, `${label} must be UTC ISO-8601`);
  assert.equal(Number.isNaN(Date.parse(value)), false);
}

function assertNoPlaceholders(value, label) {
  if (typeof value === "string") {
    assert.equal(
      /^(?:replace|replace-with-)/u.test(value),
      false,
      `${label} contains a template placeholder`,
    );
  } else if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoPlaceholders(item, `${label}[${index}]`),
    );
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertNoPlaceholders(item, `${label}.${key}`);
    }
  }
}

export function verifyWebBrowserAtEvidence(evidenceFile) {
  const filePath = path.resolve(evidenceFile);
  const text = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(
    text,
    /#launch=[A-Za-z0-9_-]{20,}/u,
    "browser/AT evidence contains a launch capability",
  );
  assert.doesNotMatch(
    text,
    /(?:\/Users\/|[A-Za-z]:\\Users\\)/u,
    "browser/AT evidence contains a local user path",
  );
  assert.doesNotMatch(
    text,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    "browser/AT evidence contains an email address",
  );
  const record = JSON.parse(text);
  const renderEvidence = JSON.parse(
    fs.readFileSync(
      path.join(referenceRoot, "render-evidence.json"),
      "utf8",
    ),
  );
  assertNoPlaceholders(record, "browser/AT evidence");
  assert.equal(record.schemaVersion, "taskflow-browser-at-review.v1");
  assert.equal(record.status, "complete");
  assert.match(record.buildCommit, commitPattern);
  assert.equal(
    renderEvidence.evidenceVersion,
    "taskflow-web-reference-render.v2",
  );
  assert.equal(renderEvidence.candidate?.trackedSourceClean, true);
  assert.equal(
    record.buildCommit,
    renderEvidence.candidate?.gitCommit,
    "browser/AT evidence must name the exact rendered candidate commit",
  );
  assert.equal(
    record.referenceManifestSha256,
    sha256File(path.join(referenceRoot, "manifest.json")),
  );
  assert.equal(
    record.renderEvidenceSha256,
    sha256File(path.join(referenceRoot, "render-evidence.json")),
  );
  assertOpaqueId(record.recordCoordinatorId, "recordCoordinatorId");
  const commitCheck = spawnSync(
    "git",
    ["cat-file", "-e", `${record.buildCommit}^{commit}`],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(
    commitCheck.status,
    0,
    `reviewed build commit is unavailable: ${commitCheck.stderr}`,
  );
  const ancestryCheck = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", record.buildCommit, "HEAD"],
    { cwd: repositoryRoot },
  );
  assert.equal(
    ancestryCheck.status,
    0,
    "reviewed build commit must be an ancestor of the evidence tip",
  );
  assert.deepEqual(
    record.lanes.map(({ laneId }) => laneId),
    laneIds,
  );
  for (const lane of record.lanes) {
    const label = `lane ${lane.laneId}`;
    assert.equal(lane.status, "pass", `${label} must pass`);
    assertOpaqueId(lane.reviewerId, `${label} reviewerId`);
    assert.equal(lane.independentFromImplementation, true);
    assertText(
      lane.environment.browserVersion,
      `${label} browserVersion`,
    );
    assertText(
      lane.environment.operatingSystemVersion,
      `${label} operatingSystemVersion`,
    );
    assertText(
      lane.environment.assistiveTechnologyVersion,
      `${label} assistiveTechnologyVersion`,
    );
    if (lane.laneId === "edge-forced-colors-windows") {
      assert.equal(
        lane.environment.assistiveTechnologyVersion,
        "forced-colors",
      );
    }
    assert.deepEqual(Object.keys(lane.results), taskIds);
    for (const [taskId, result] of Object.entries(lane.results)) {
      assert.equal(
        result.decision,
        "pass",
        `${label}/${taskId} must pass`,
      );
      assertText(
        result.observation,
        `${label}/${taskId} observation`,
      );
    }
    assert.deepEqual(lane.blockingIssues, []);
    assertTimestamp(lane.completedAt, `${label} completedAt`);
    assert.equal(lane.reviewerAttestation, true);
  }
  assert.equal(record.overallGatePassed, true);
  assertTimestamp(record.completedAt, "browser/AT completedAt");
  assert.equal(record.reviewerAttestation, true);
  return {
    buildCommit: record.buildCommit,
    laneCount: record.lanes.length,
    recordSha256: `sha256:${createHash("sha256")
      .update(text)
      .digest("hex")}`,
  };
}

function parseArguments(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--evidence-file" ||
    argv[1].trim() === ""
  ) {
    throw new Error(
      "usage: node scripts/verify-web-browser-at-evidence.mjs --evidence-file <file>",
    );
  }
  return argv[1];
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyWebBrowserAtEvidence(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(
      `web browser/AT evidence valid (${result.laneCount} lanes; build ${result.buildCommit.slice(0, 12)})\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
