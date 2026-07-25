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
const referenceManifestPath = path.join(referenceRoot, "manifest.json");
const renderEvidencePath = path.join(referenceRoot, "render-evidence.json");

export const WEB_USABILITY_TASKS = [
  {
    taskId: "find-attention",
    timeLimitSeconds: 30,
    primaryAction: true,
    material: [
      ["live-packaged", null],
      ["fixture-render", "simple-home-partial-disconnected"],
    ],
  },
  {
    taskId: "explain-active-task",
    timeLimitSeconds: 60,
    primaryAction: false,
    material: [["live-packaged", "active-task-result"]],
  },
  {
    taskId: "understand-approval",
    timeLimitSeconds: 60,
    primaryAction: false,
    material: [["live-packaged", "needs-input-decision"]],
  },
  {
    taskId: "make-approval-decision",
    timeLimitSeconds: 90,
    primaryAction: true,
    material: [["live-packaged", "needs-input-decision"]],
  },
  {
    taskId: "cancel-task",
    timeLimitSeconds: 90,
    primaryAction: true,
    material: [
      ["live-packaged", null],
      ["fixture-render", "unknown-reconciling"],
    ],
  },
  {
    taskId: "find-assess-result",
    timeLimitSeconds: 60,
    primaryAction: true,
    material: [
      ["live-packaged", "completed-verified"],
      ["fixture-render", "completed-verification-unavailable"],
    ],
  },
  {
    taskId: "open-technical-evidence",
    timeLimitSeconds: null,
    primaryAction: true,
    material: [["live-packaged", "pro-evidence-receipt"]],
  },
];

export const WEB_SEVERITY_1_CODES = new Set([
  "unknown-treated-as-terminal",
  "possible-live-work-missed",
  "receipt-treated-as-verified",
  "pro-treated-as-permission",
  "approval-treated-as-recommended",
  "approval-consequence-misunderstood",
  "refresh-consequence-misunderstood",
  "cancel-consequence-misunderstood",
]);

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
const profileIds = [
  "taskflow-naive-software-engineer",
  "ordinary-developer-tool-user",
];
const priorExposureIds = [
  "none",
  "used-released-version",
  "other-no-control-plane",
];
const zhReviewerRoles = ["content-ux", "technical-safety"];
const hashPattern = /^sha256:[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const opaqueIdPattern = /^[A-Za-z0-9_-]{8,64}$/u;
const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function readJsonRecord(filePath) {
  const bytes = fs.readFileSync(filePath);
  const text = bytes.toString("utf8");
  assert.doesNotMatch(
    text,
    /#launch=[A-Za-z0-9_-]{20,}/u,
    `${filePath} contains a launch capability`,
  );
  assert.doesNotMatch(
    text,
    /(?:\/Users\/|[A-Za-z]:\\Users\\)/u,
    `${filePath} contains a local user path`,
  );
  assert.doesNotMatch(
    text,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    `${filePath} contains an email address`,
  );
  return {
    digest: sha256Bytes(bytes),
    filePath,
    record: JSON.parse(text),
  };
}

function assertNoPlaceholders(value, label) {
  if (typeof value === "string") {
    assert.equal(
      /^(?:replace|replace-with-)/u.test(value),
      false,
      `${label} contains a template placeholder`,
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoPlaceholders(item, `${label}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertNoPlaceholders(item, `${label}.${key}`);
    }
  }
}

function assertOpaqueId(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, opaqueIdPattern, `${label} must be an opaque id`);
}

function assertIsoTimestamp(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, isoTimestampPattern, `${label} must be UTC ISO-8601`);
  assert.equal(
    Number.isNaN(Date.parse(value)),
    false,
    `${label} must be a real timestamp`,
  );
}

function assertText(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.notEqual(value.trim(), "", `${label} must not be empty`);
}

function assertStringArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  for (const [index, item] of value.entries()) {
    assert.equal(
      typeof item,
      "string",
      `${label}[${index}] must be a string`,
    );
  }
}

function assertBinding(record, binding, label) {
  assert.equal(record.buildCommit, binding.buildCommit, `${label} commit`);
  assert.equal(
    record.referenceManifestSha256,
    binding.referenceManifestSha256,
    `${label} reference manifest`,
  );
  assert.equal(
    record.renderEvidenceSha256,
    binding.renderEvidenceSha256,
    `${label} render evidence`,
  );
}

function assertScreenResults(results, label) {
  assert.deepEqual(
    results.map(({ screenId }) => screenId),
    screenIds,
    `${label} must cover every screen exactly once`,
  );
  for (const result of results) {
    assert.equal(result.decision, "approved", `${label}/${result.screenId}`);
    assert.equal(typeof result.notes, "string");
  }
}

function validateReferenceReview(record, binding) {
  assert.equal(
    record.schemaVersion,
    "taskflow-web-reference-review.v1",
  );
  assert.equal(record.status, "complete");
  assertBinding(record, binding, "reference review");
  assertOpaqueId(record.reviewerId, "reference review reviewerId");
  assert.equal(record.reviewerRole, "product-owner");
  assert.equal(record.independentFromImplementation, true);
  assert.deepEqual(record.requiredCoverage, {
    screenFamilies: 9,
    matrixRenders: 144,
    supplementalRenders: 5,
    totalRenders: 149,
  });
  assert.deepEqual(record.reviewedCoverage, {
    screenFamilies: screenIds,
    renderEntries: 149,
  });
  assertScreenResults(record.screenResults, "reference review");
  assert.equal(
    Object.values(record.matrixChecks).every((value) => value === true),
    true,
    "every reference matrix check must pass",
  );
  assert.deepEqual(record.blockingIssues, []);
  assert.equal(record.overallDecision, "approved");
  assertIsoTimestamp(record.completedAt, "reference review completedAt");
  assert.equal(record.reviewerAttestation, true);
}

function validateSession(record, binding, label) {
  assert.equal(record.schemaVersion, "taskflow-usability-session.v1");
  assert.equal(record.status, "complete");
  assertBinding(record, binding, label);
  assertOpaqueId(record.participantId, `${label} participantId`);
  assert.equal(profileIds.includes(record.participantProfile), true);
  assert.equal(
    priorExposureIds.includes(record.priorTaskflowExposure),
    true,
  );
  assert.equal(record.freshParticipant, true);
  assert.equal(record.locale, "en");
  assertText(record.environment.browserVersion, `${label} browserVersion`);
  assertText(
    record.environment.operatingSystemVersion,
    `${label} operatingSystemVersion`,
  );
  assertText(record.environment.viewport, `${label} viewport`);
  assert.equal(record.environment.zoomPercent, 100);
  assert.equal(record.environment.theme, "light");
  assert.ok(record.environment.inputMethods.length > 0);
  assertStringArray(
    record.environment.inputMethods,
    `${label} inputMethods`,
  );
  assertText(
    record.environment.assistiveTechnology,
    `${label} assistiveTechnology`,
  );
  assert.deepEqual(
    record.tasks.map(({ taskId }) => taskId),
    WEB_USABILITY_TASKS.map(({ taskId }) => taskId),
    `${label} must cover every task exactly once`,
  );

  for (const [index, task] of record.tasks.entries()) {
    const spec = WEB_USABILITY_TASKS[index];
    const taskLabel = `${label}/${spec.taskId}`;
    assert.equal(task.timeLimitSeconds, spec.timeLimitSeconds);
    assert.deepEqual(
      task.material.map(({ mode, fixtureId }) => [mode, fixtureId]),
      spec.material,
      `${taskLabel} material drifted from the frozen protocol`,
    );
    assert.equal(
      typeof task.completionSeconds,
      "number",
      `${taskLabel} must record completion seconds`,
    );
    assert.equal(
      Number.isFinite(task.completionSeconds) &&
        task.completionSeconds >= 0,
      true,
      `${taskLabel} completion seconds must be finite and non-negative`,
    );
    assert.equal([0, 1, 2].includes(task.score), true);
    if (
      task.score === 2 &&
      spec.timeLimitSeconds !== null
    ) {
      assert.ok(
        task.completionSeconds <= spec.timeLimitSeconds,
        `${taskLabel} cannot score 2 after its time limit`,
      );
    }
    assert.equal(
      task.primaryActionFound,
      spec.primaryAction
        ? Boolean(task.primaryActionFound)
        : null,
      `${taskLabel} primary action evidence is invalid`,
    );
    assert.equal(
      Number.isInteger(task.confidence) &&
        task.confidence >= 1 &&
        task.confidence <= 5,
      true,
      `${taskLabel} confidence must be 1..5`,
    );
    assertText(task.participantWords, `${taskLabel} participantWords`);
    assertStringArray(task.wrongTurns, `${taskLabel} wrongTurns`);
    assertStringArray(
      task.moderatorInterventions,
      `${taskLabel} moderatorInterventions`,
    );
    assertStringArray(task.errors, `${taskLabel} errors`);
    if (spec.taskId === "make-approval-decision") {
      assert.equal(
        ["allow", "do-not-allow"].includes(task.decisionVariant),
        true,
        `${taskLabel} decisionVariant is invalid`,
      );
    } else {
      assert.equal(Object.hasOwn(task, "decisionVariant"), false);
    }
  }

  assert.ok(Array.isArray(record.severity1Findings));
  for (const [index, finding] of record.severity1Findings.entries()) {
    const findingLabel = `${label}/severity1Findings[${index}]`;
    assert.equal(WEB_SEVERITY_1_CODES.has(finding.code), true);
    assert.equal(
      WEB_USABILITY_TASKS.some(
        ({ taskId }) => taskId === finding.taskId,
      ),
      true,
    );
    assertText(finding.participantWords, `${findingLabel}.participantWords`);
    assert.equal(
      [
        "open",
        "fixed-retest-required",
        "fixed-retested-on-new-candidate",
      ].includes(finding.disposition),
      true,
      `${findingLabel}.disposition is invalid`,
    );
  }
  assertIsoTimestamp(record.completedAt, `${label} completedAt`);
  assert.equal(record.facilitatorAttestation, true);
}

function validateZhReview(record, binding, label) {
  assert.equal(
    record.schemaVersion,
    "taskflow-zh-cn-content-review.v1",
  );
  assert.equal(record.status, "complete");
  assertBinding(record, binding, label);
  assertOpaqueId(record.reviewerId, `${label} reviewerId`);
  assert.equal(zhReviewerRoles.includes(record.reviewerRole), true);
  assert.equal(record.nativeSimplifiedChineseReviewer, true);
  assert.equal(record.independentFromImplementation, true);
  assert.deepEqual(record.contentDigests, {
    combinedKeyset: binding.combinedKeysetSha256,
    zhCN: binding.zhCNCatalogSha256,
  });
  assert.deepEqual(record.requiredCoverage, {
    projectedKeys: binding.projectedKeyCount,
    staticKeys: binding.staticKeyCount,
    totalKeys: binding.combinedKeyCount,
    screenFamilies: 9,
    renderEntries: 149,
  });
  assert.deepEqual(record.reviewedCoverage, {
    projectedKeys: binding.projectedKeyCount,
    staticKeys: binding.staticKeyCount,
    screenFamilies: screenIds,
    renderEntries: 149,
  });
  assertScreenResults(record.screenResults, label);
  assert.equal(
    Object.values(record.checks).every((value) => value === true),
    true,
    `${label} must pass every check`,
  );
  assert.deepEqual(record.safetyCriticalFindings, []);
  assert.equal(record.overallDecision, "approved");
  assertIsoTimestamp(record.completedAt, `${label} completedAt`);
  assert.equal(record.reviewerAttestation, true);
}

function taskAggregate(sessions, spec) {
  const tasks = sessions.map(
    (session) =>
      session.record.tasks.find(
        ({ taskId }) => taskId === spec.taskId,
      ),
  );
  const score2Count = tasks.filter(({ score }) => score === 2).length;
  const score1Count = tasks.filter(({ score }) => score === 1).length;
  const score0Count = tasks.filter(({ score }) => score === 0).length;
  const primaryActionFoundCount = spec.primaryAction
    ? tasks.filter(({ primaryActionFound }) => primaryActionFound).length
    : null;
  return {
    gatePassed:
      score2Count >= 4 &&
      (primaryActionFoundCount === null ||
        primaryActionFoundCount >= 4),
    primaryActionFoundCount,
    score0Count,
    score1Count,
    score2Count,
    withinTimeScore2Count:
      spec.timeLimitSeconds === null ? null : score2Count,
  };
}

function validateSummary(
  record,
  {
    binding,
    referenceReview,
    sessions,
    zhReviews,
  },
) {
  assert.equal(record.schemaVersion, "taskflow-usability-study.v1");
  assert.equal(record.status, "complete");
  assertBinding(record, binding, "study summary");
  assertOpaqueId(record.studyId, "study summary studyId");
  assert.equal(
    record.referenceReviewRecordSha256,
    referenceReview.digest,
  );
  assert.deepEqual(
    [...record.sessionRecordSha256].sort(),
    sessions.map(({ digest }) => digest).sort(),
  );
  assert.deepEqual(
    [...record.zhCNReviewRecordSha256].sort(),
    zhReviews.map(({ digest }) => digest).sort(),
  );
  assert.ok(Array.isArray(record.retainedFailedRecordSha256));
  for (const digest of record.retainedFailedRecordSha256) {
    assert.match(digest, hashPattern);
  }
  assert.equal(record.freshEnglishParticipantCount, 5);
  const profileCounts = Object.fromEntries(
    profileIds.map((profileId) => [
      profileId,
      sessions.filter(
        ({ record: session }) =>
          session.participantProfile === profileId,
      ).length,
    ]),
  );
  assert.deepEqual(record.participantProfileCounts, profileCounts);
  assert.ok(
    profileCounts["taskflow-naive-software-engineer"] >= 2,
  );
  assert.ok(
    profileCounts["ordinary-developer-tool-user"] >= 3,
  );
  assert.equal(record.nativeChineseReviewerCount, 2);
  assert.deepEqual(
    record.taskResults.map(({ taskId }) => taskId),
    WEB_USABILITY_TASKS.map(({ taskId }) => taskId),
  );
  for (const [index, result] of record.taskResults.entries()) {
    const aggregate = taskAggregate(
      sessions,
      WEB_USABILITY_TASKS[index],
    );
    assert.deepEqual(result, {
      taskId: WEB_USABILITY_TASKS[index].taskId,
      ...aggregate,
    });
    assert.equal(result.gatePassed, true);
  }
  assert.equal(record.severity1FindingCount, 0);
  assert.deepEqual(record.severity1Findings, []);
  assert.ok(Array.isArray(record.findingDispositions));
  assert.equal(record.chineseContentReviewPassed, true);
  assert.equal(record.referenceReviewPassed, true);
  assert.equal(record.overallGatePassed, true);
  assertIsoTimestamp(record.completedAt, "study summary completedAt");
  assert.equal(record.reviewerAttestation, true);
}

function listJsonRecords(directory, expectedCount, label) {
  assert.equal(fs.existsSync(directory), true, `${label} directory missing`);
  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
  assert.equal(files.length, expectedCount, `${label} record count`);
  return files.map(readJsonRecord);
}

export function verifyWebHumanEvidence(evidenceDirectory) {
  const evidenceRoot = path.resolve(evidenceDirectory);
  const referenceManifest = JSON.parse(
    fs.readFileSync(referenceManifestPath, "utf8"),
  );
  const renderEvidence = JSON.parse(
    fs.readFileSync(renderEvidencePath, "utf8"),
  );
  const referenceReview = readJsonRecord(
    path.join(evidenceRoot, "reference-review.json"),
  );
  const summary = readJsonRecord(
    path.join(evidenceRoot, "study-summary.json"),
  );
  const sessions = listJsonRecords(
    path.join(evidenceRoot, "sessions"),
    5,
    "English session",
  );
  const zhReviews = listJsonRecords(
    path.join(evidenceRoot, "zh-cn-reviews"),
    2,
    "zh-CN review",
  );
  const binding = {
    buildCommit: renderEvidence.candidate?.gitCommit,
    projectedKeyCount:
      referenceManifest.contentCatalogs.keyCounts.projected,
    staticKeyCount:
      referenceManifest.contentCatalogs.keyCounts.static,
    combinedKeyCount:
      referenceManifest.contentCatalogs.keyCounts.combined,
    combinedKeysetSha256:
      referenceManifest.contentCatalogs.keysetDigests.combined,
    referenceManifestSha256: sha256File(referenceManifestPath),
    renderEvidenceSha256: sha256File(renderEvidencePath),
    zhCNCatalogSha256:
      referenceManifest.contentCatalogs.catalogDigests["zh-CN"],
  };
  assert.equal(
    renderEvidence.evidenceVersion,
    "taskflow-web-reference-render.v2",
  );
  assert.equal(renderEvidence.candidate?.trackedSourceClean, true);
  assert.match(binding.buildCommit, commitPattern);
  assert.equal(
    summary.record.buildCommit,
    binding.buildCommit,
    "human evidence must name the exact rendered candidate commit",
  );
  const commitCheck = spawnSync(
    "git",
    ["cat-file", "-e", `${binding.buildCommit}^{commit}`],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(
    commitCheck.status,
    0,
    `reviewed build commit is unavailable: ${commitCheck.stderr}`,
  );
  const ancestryCheck = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", binding.buildCommit, "HEAD"],
    { cwd: repositoryRoot },
  );
  assert.equal(
    ancestryCheck.status,
    0,
    "reviewed build commit must be an ancestor of the evidence tip",
  );

  for (const item of [
    referenceReview,
    summary,
    ...sessions,
    ...zhReviews,
  ]) {
    assertNoPlaceholders(item.record, item.filePath);
  }
  validateReferenceReview(referenceReview.record, binding);
  for (const [index, session] of sessions.entries()) {
    validateSession(
      session.record,
      binding,
      `session ${index + 1}`,
    );
  }
  const participantIds = sessions.map(
    ({ record }) => record.participantId,
  );
  assert.equal(
    new Set(participantIds).size,
    participantIds.length,
    "participant ids must be unique",
  );
  const decisionVariants = sessions.map(
    ({ record }) =>
      record.tasks.find(
        ({ taskId }) => taskId === "make-approval-decision",
      ).decisionVariant,
  );
  const allowCount = decisionVariants.filter(
    (value) => value === "allow",
  ).length;
  assert.ok(
    allowCount === 2 || allowCount === 3,
    "approval variants must alternate across the cohort",
  );
  assert.equal(
    sessions.every(
      ({ record }) => record.severity1Findings.length === 0,
    ),
    true,
    "a severity-1 finding blocks the candidate",
  );
  for (const [index, review] of zhReviews.entries()) {
    validateZhReview(
      review.record,
      binding,
      `zh-CN review ${index + 1}`,
    );
  }
  assert.deepEqual(
    zhReviews.map(({ record }) => record.reviewerRole).sort(),
    [...zhReviewerRoles].sort(),
  );
  const allHumanIds = [
    referenceReview.record.reviewerId,
    ...participantIds,
    ...zhReviews.map(({ record }) => record.reviewerId),
  ];
  assert.equal(
    new Set(allHumanIds).size,
    allHumanIds.length,
    "participant and reviewer ids must be unique",
  );
  validateSummary(summary.record, {
    binding,
    referenceReview,
    sessions,
    zhReviews,
  });

  return {
    buildCommit: binding.buildCommit,
    referenceManifestSha256: binding.referenceManifestSha256,
    renderEvidenceSha256: binding.renderEvidenceSha256,
    referenceReviewSha256: referenceReview.digest,
    sessionRecordSha256: sessions.map(({ digest }) => digest).sort(),
    zhCNReviewRecordSha256: zhReviews
      .map(({ digest }) => digest)
      .sort(),
  };
}

function parseArguments(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--evidence-dir" ||
    argv[1].trim() === ""
  ) {
    throw new Error(
      "usage: node scripts/verify-web-human-evidence.mjs --evidence-dir <directory>",
    );
  }
  return argv[1];
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyWebHumanEvidence(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(
      `web human evidence valid (5 English sessions; 2 zh-CN reviews; reference approved; build ${result.buildCommit.slice(0, 12)})\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
