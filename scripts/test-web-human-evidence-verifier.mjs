#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyWebHumanEvidence,
  WEB_USABILITY_TASKS,
} from "./verify-web-human-evidence.mjs";
import { verifyWebBrowserAtEvidence } from "./verify-web-browser-at-evidence.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const templateRoot = path.join(
  repositoryRoot,
  "packages/taskflow-web/test/fixtures/usability-v1",
);
const referenceRoot = path.join(
  repositoryRoot,
  "docs/internal/webui/reference-set-v1",
);
const completedAt = "2026-07-25T00:00:00Z";
const actionTaskIds = new Set(
  WEB_USABILITY_TASKS.filter(({ primaryAction }) => primaryAction).map(
    ({ taskId }) => taskId,
  ),
);

function cloneJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256File(filePath) {
  return `sha256:${createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex")}`;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function completeReferenceReview(binding) {
  const record = cloneJson(
    path.join(
      referenceRoot,
      "review-result.template.json",
    ),
  );
  record.status = "complete";
  record.reviewerId = "reviewer_product";
  record.reviewerRole = "product-owner";
  record.independentFromImplementation = true;
  Object.assign(record, binding);
  record.reviewedCoverage = {
    screenFamilies: record.screenResults.map(
      ({ screenId }) => screenId,
    ),
    renderEntries: 149,
  };
  for (const result of record.screenResults) {
    result.decision = "approved";
  }
  for (const key of Object.keys(record.matrixChecks)) {
    record.matrixChecks[key] = true;
  }
  record.overallDecision = "approved";
  record.completedAt = completedAt;
  record.reviewerAttestation = true;
  return record;
}

function completeSession(template, binding, index) {
  const record = structuredClone(template);
  record.status = "complete";
  record.participantId = `participant_0${index + 1}`;
  record.participantProfile =
    index < 2
      ? "taskflow-naive-software-engineer"
      : "ordinary-developer-tool-user";
  record.priorTaskflowExposure = "none";
  record.freshParticipant = true;
  Object.assign(record, binding);
  record.environment = {
    assistiveTechnology: "none",
    browserVersion: "Test Browser 1",
    inputMethods: ["keyboard", "pointer"],
    operatingSystemVersion: "Test OS 1",
    theme: "light",
    viewport: "1440x900",
    zoomPercent: 100,
  };
  for (const task of record.tasks) {
    task.completionSeconds =
      task.timeLimitSeconds === null
        ? 75
        : Math.max(1, task.timeLimitSeconds - 5);
    task.score = 2;
    task.primaryActionFound = actionTaskIds.has(task.taskId)
      ? true
      : null;
    task.confidence = 4;
    task.participantWords = `Observed ${task.taskId} correctly.`;
    if (task.taskId === "make-approval-decision") {
      task.decisionVariant =
        index % 2 === 0 ? "allow" : "do-not-allow";
    }
  }
  record.completedAt = completedAt;
  record.facilitatorAttestation = true;
  return record;
}

function completeZhReview(template, binding, manifest, role) {
  const record = structuredClone(template);
  record.status = "complete";
  record.reviewerId =
    role === "content-ux"
      ? "reviewer_zh_ux"
      : "reviewer_zh_safe";
  record.reviewerRole = role;
  record.nativeSimplifiedChineseReviewer = true;
  record.independentFromImplementation = true;
  Object.assign(record, binding);
  record.contentDigests = {
    combinedKeyset:
      manifest.contentCatalogs.keysetDigests.combined,
    zhCN: manifest.contentCatalogs.catalogDigests["zh-CN"],
  };
  record.reviewedCoverage = {
    projectedKeys:
      manifest.contentCatalogs.keyCounts.projected,
    staticKeys: manifest.contentCatalogs.keyCounts.static,
    screenFamilies: record.screenResults.map(
      ({ screenId }) => screenId,
    ),
    renderEntries: 149,
  };
  for (const result of record.screenResults) {
    result.decision = "approved";
  }
  for (const key of Object.keys(record.checks)) {
    record.checks[key] = true;
  }
  record.overallDecision = "approved";
  record.completedAt = completedAt;
  record.reviewerAttestation = true;
  return record;
}

function completeSummary(
  template,
  binding,
  referenceReviewDigest,
  sessionDigests,
  zhReviewDigests,
) {
  const record = structuredClone(template);
  record.status = "complete";
  record.studyId = "study_beta2";
  Object.assign(record, binding);
  record.referenceReviewRecordSha256 = referenceReviewDigest;
  record.sessionRecordSha256 = [...sessionDigests].sort();
  record.zhCNReviewRecordSha256 = [...zhReviewDigests].sort();
  record.freshEnglishParticipantCount = 5;
  record.participantProfileCounts = {
    "taskflow-naive-software-engineer": 2,
    "ordinary-developer-tool-user": 3,
  };
  record.nativeChineseReviewerCount = 2;
  for (const result of record.taskResults) {
    result.score2Count = 5;
    result.withinTimeScore2Count =
      result.withinTimeScore2Count === null ? null : 5;
    result.primaryActionFoundCount =
      result.primaryActionFoundCount === null ? null : 5;
    result.gatePassed = true;
  }
  record.chineseContentReviewPassed = true;
  record.referenceReviewPassed = true;
  record.overallGatePassed = true;
  record.completedAt = completedAt;
  record.reviewerAttestation = true;
  return record;
}

export function runWebHumanEvidenceVerifierSelfTest() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "taskflow-human-evidence-"),
  );
  try {
    const sessionsRoot = path.join(temporaryRoot, "sessions");
    const zhRoot = path.join(temporaryRoot, "zh-cn-reviews");
    fs.mkdirSync(sessionsRoot);
    fs.mkdirSync(zhRoot);
    const renderEvidence = cloneJson(
      path.join(referenceRoot, "render-evidence.json"),
    );
    assert.equal(
      renderEvidence.evidenceVersion,
      "taskflow-web-reference-render.v2",
    );
    const buildCommit = renderEvidence.candidate.gitCommit;
    const binding = {
      buildCommit,
      referenceManifestSha256: sha256File(
        path.join(referenceRoot, "manifest.json"),
      ),
      renderEvidenceSha256: sha256File(
        path.join(referenceRoot, "render-evidence.json"),
      ),
    };
    const manifest = cloneJson(
      path.join(referenceRoot, "manifest.json"),
    );
    const referenceReview = completeReferenceReview(binding);
    const referenceReviewPath = path.join(
      temporaryRoot,
      "reference-review.json",
    );
    writeJson(referenceReviewPath, referenceReview);

    const sessionTemplate = cloneJson(
      path.join(templateRoot, "session-result.template.json"),
    );
    const sessionPaths = Array.from({ length: 5 }, (_, index) => {
      const filePath = path.join(
        sessionsRoot,
        `participant-0${index + 1}.json`,
      );
      writeJson(
        filePath,
        completeSession(sessionTemplate, binding, index),
      );
      return filePath;
    });

    const zhTemplate = cloneJson(
      path.join(
        templateRoot,
        "zh-cn-content-review.template.json",
      ),
    );
    const zhPaths = [
      ["content-ux", "content-ux.json"],
      ["technical-safety", "technical-safety.json"],
    ].map(([role, fileName]) => {
      const filePath = path.join(zhRoot, fileName);
      writeJson(
        filePath,
        completeZhReview(zhTemplate, binding, manifest, role),
      );
      return filePath;
    });

    const summary = completeSummary(
      cloneJson(
        path.join(templateRoot, "study-summary.template.json"),
      ),
      binding,
      sha256File(referenceReviewPath),
      sessionPaths.map(sha256File),
      zhPaths.map(sha256File),
    );
    const summaryPath = path.join(
      temporaryRoot,
      "study-summary.json",
    );
    writeJson(summaryPath, summary);

    const verified = verifyWebHumanEvidence(temporaryRoot);
    assert.equal(verified.buildCommit, buildCommit);
    assert.equal(verified.sessionRecordSha256.length, 5);
    assert.equal(verified.zhCNReviewRecordSha256.length, 2);

    const wrongAncestor = execFileSync(
      "git",
      ["rev-parse", `${buildCommit}^`],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim();
    summary.buildCommit = wrongAncestor;
    writeJson(summaryPath, summary);
    assert.throws(
      () => verifyWebHumanEvidence(temporaryRoot),
      /exact rendered candidate commit/u,
    );
    summary.buildCommit = buildCommit;
    writeJson(summaryPath, summary);

    const browserAt = cloneJson(
      path.join(
        repositoryRoot,
        "docs/internal/webui/browser-at-result.template.json",
      ),
    );
    browserAt.status = "complete";
    Object.assign(browserAt, binding);
    browserAt.recordCoordinatorId = "reviewer_at_coordinator";
    for (const [index, lane] of browserAt.lanes.entries()) {
      lane.status = "pass";
      lane.reviewerId = `reviewer_at_0${index + 1}`;
      lane.independentFromImplementation = true;
      lane.environment.browserVersion = "Native Browser 1";
      lane.environment.operatingSystemVersion = "Native OS 1";
      if (
        lane.environment.assistiveTechnologyVersion !==
        "forced-colors"
      ) {
        lane.environment.assistiveTechnologyVersion =
          "Native AT 1";
      }
      for (const [taskId, result] of Object.entries(
        lane.results,
      )) {
        result.decision = "pass";
        result.observation = `Observed ${taskId} behavior.`;
      }
      lane.completedAt = completedAt;
      lane.reviewerAttestation = true;
    }
    browserAt.overallGatePassed = true;
    browserAt.completedAt = completedAt;
    browserAt.reviewerAttestation = true;
    const browserAtPath = path.join(
      temporaryRoot,
      "browser-at.json",
    );
    writeJson(browserAtPath, browserAt);
    assert.equal(
      verifyWebBrowserAtEvidence(browserAtPath).laneCount,
      5,
    );
    browserAt.lanes[0].results["launch-simple"].observation = "";
    writeJson(browserAtPath, browserAt);
    assert.throws(
      () => verifyWebBrowserAtEvidence(browserAtPath),
      /observation must not be empty/u,
    );

    const invalidSession = cloneJson(sessionPaths[0]);
    invalidSession.severity1Findings = [
      {
        code: "unknown-treated-as-terminal",
        disposition: "open",
        participantWords: "It is stopped.",
        taskId: "cancel-task",
      },
    ];
    writeJson(sessionPaths[0], invalidSession);
    summary.sessionRecordSha256 = sessionPaths
      .map(sha256File)
      .sort();
    writeJson(summaryPath, summary);
    assert.throws(
      () => verifyWebHumanEvidence(temporaryRoot),
      /severity-1 finding blocks the candidate/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, {
      force: true,
      recursive: true,
    });
  }
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runWebHumanEvidenceVerifierSelfTest();
  process.stdout.write(
    "web human evidence verifier self-test passed\n",
  );
}
