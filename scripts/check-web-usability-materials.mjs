import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  WEB_SEVERITY_1_CODES,
  WEB_USABILITY_TASKS,
} from "./verify-web-human-evidence.mjs";
import { runWebHumanEvidenceVerifierSelfTest } from "./test-web-human-evidence-verifier.mjs";

const root = process.cwd();
const fixtureRoot = path.join(
  root,
  "packages/taskflow-web/test/fixtures/usability-v1",
);
const reviewRoot = path.join(root, "docs/internal/webui");

function readJson(rootPath, name) {
  return JSON.parse(readFileSync(path.join(rootPath, name), "utf8"));
}

const session = readJson(
  fixtureRoot,
  "session-result.template.json",
);
const summary = readJson(
  fixtureRoot,
  "study-summary.template.json",
);
const zhReview = readJson(
  fixtureRoot,
  "zh-cn-content-review.template.json",
);
const browserAt = readJson(
  reviewRoot,
  "browser-at-result.template.json",
);
const referenceManifest = readJson(
  path.join(reviewRoot, "reference-set-v1"),
  "manifest.json",
);
const protocol = readFileSync(
  path.join(reviewRoot, "usability-script-v1.md"),
  "utf8",
);

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
const taskSpecs = [
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
const taskIds = taskSpecs.map(({ taskId }) => taskId);
const severity1Codes = [
  "unknown-treated-as-terminal",
  "possible-live-work-missed",
  "receipt-treated-as-verified",
  "pro-treated-as-permission",
  "approval-treated-as-recommended",
  "approval-consequence-misunderstood",
  "refresh-consequence-misunderstood",
  "cancel-consequence-misunderstood",
];
assert.deepEqual(
  WEB_USABILITY_TASKS,
  taskSpecs,
  "completed-evidence verifier task contract drifted from the templates",
);
assert.deepEqual(
  [...WEB_SEVERITY_1_CODES],
  severity1Codes,
  "completed-evidence verifier severity contract drifted",
);

assert.equal(session.schemaVersion, "taskflow-usability-session.v1");
assert.equal(session.status, "template-not-evidence");
assert.equal(session.participantProfile, "replace");
assert.equal(session.priorTaskflowExposure, "replace");
assert.equal(session.freshParticipant, false);
assert.equal(session.locale, "en");
assert.equal(session.environment.theme, "light");
assert.equal(session.environment.zoomPercent, 100);
assert.deepEqual(
  session.tasks.map(({ taskId }) => taskId),
  taskIds,
  "session template must cover the seven RFC §19.4 tasks exactly once",
);
assert.deepEqual(session.severity1Findings, []);
assert.equal(session.completedAt, null);
assert.equal(session.facilitatorAttestation, false);

for (const [index, task] of session.tasks.entries()) {
  const spec = taskSpecs[index];
  assert.equal(task.timeLimitSeconds, spec.timeLimitSeconds);
  assert.deepEqual(
    task.material.map(({ mode, fixtureId }) => [mode, fixtureId]),
    spec.material,
  );
  assert.equal(task.completionSeconds, null);
  assert.equal(task.score, null);
  assert.equal(task.primaryActionFound, null);
  assert.equal(task.confidence, null);
  assert.equal(task.participantWords, "");
  assert.deepEqual(task.wrongTurns, []);
  assert.deepEqual(task.moderatorInterventions, []);
  assert.deepEqual(task.errors, []);
  if (task.taskId === "make-approval-decision") {
    assert.equal(
      task.decisionVariant,
      "replace-with-allow-or-do-not-allow",
    );
  } else {
    assert.equal(
      Object.hasOwn(task, "decisionVariant"),
      false,
      `${task.taskId} cannot carry an approval variant`,
    );
  }
  assert.equal(
    protocol.includes(`### \`${task.taskId}\``),
    true,
    `${task.taskId} is missing from the frozen protocol`,
  );
}
for (const code of severity1Codes) {
  assert.equal(
    protocol.includes(`\`${code}\``),
    true,
    `severity-1 code ${code} is missing from the protocol`,
  );
}

assert.equal(summary.schemaVersion, "taskflow-usability-study.v1");
assert.equal(summary.status, "template-not-evidence");
assert.equal(summary.referenceReviewRecordSha256, null);
assert.deepEqual(summary.sessionRecordSha256, []);
assert.deepEqual(summary.zhCNReviewRecordSha256, []);
assert.deepEqual(summary.retainedFailedRecordSha256, []);
assert.equal(summary.freshEnglishParticipantCount, 0);
assert.deepEqual(summary.participantProfileCounts, {
  "taskflow-naive-software-engineer": 0,
  "ordinary-developer-tool-user": 0,
});
assert.equal(summary.nativeChineseReviewerCount, 0);
assert.equal(summary.severity1FindingCount, 0);
assert.deepEqual(summary.severity1Findings, []);
assert.deepEqual(summary.findingDispositions, []);
assert.equal(summary.chineseContentReviewPassed, false);
assert.equal(summary.referenceReviewPassed, false);
assert.equal(summary.overallGatePassed, false);
assert.equal(summary.completedAt, null);
assert.equal(summary.reviewerAttestation, false);
assert.deepEqual(
  summary.taskResults.map(({ taskId }) => taskId),
  taskIds,
  "study summary template must cover the seven RFC §19.4 tasks exactly once",
);

for (const [index, result] of summary.taskResults.entries()) {
  const spec = taskSpecs[index];
  assert.equal(result.score2Count, 0);
  assert.equal(result.score1Count, 0);
  assert.equal(result.score0Count, 0);
  assert.equal(
    result.withinTimeScore2Count,
    spec.timeLimitSeconds === null ? null : 0,
  );
  assert.equal(
    result.primaryActionFoundCount,
    spec.primaryAction ? 0 : null,
  );
  assert.equal(result.gatePassed, false);
}

assert.equal(
  zhReview.schemaVersion,
  "taskflow-zh-cn-content-review.v1",
);
assert.equal(zhReview.status, "template-not-evidence");
assert.equal(
  zhReview.reviewerRole,
  "replace-with-content-ux-or-technical-safety",
);
assert.equal(zhReview.nativeSimplifiedChineseReviewer, false);
assert.equal(zhReview.independentFromImplementation, false);
assert.deepEqual(zhReview.requiredCoverage, {
  projectedKeys:
    referenceManifest.contentCatalogs.keyCounts.projected,
  staticKeys: referenceManifest.contentCatalogs.keyCounts.static,
  totalKeys: referenceManifest.contentCatalogs.keyCounts.combined,
  screenFamilies: 9,
  renderEntries: 149,
});
assert.deepEqual(zhReview.reviewedCoverage, {
  projectedKeys: 0,
  staticKeys: 0,
  screenFamilies: [],
  renderEntries: 0,
});
assert.deepEqual(
  zhReview.screenResults.map(({ screenId }) => screenId),
  screenIds,
);
for (const result of zhReview.screenResults) {
  assert.equal(result.decision, "pending");
  assert.equal(result.notes, "");
}
assert.deepEqual(
  Object.values(zhReview.checks),
  Object.values(zhReview.checks).map(() => null),
);
assert.deepEqual(zhReview.safetyCriticalFindings, []);
assert.equal(zhReview.overallDecision, "pending");
assert.equal(zhReview.completedAt, null);
assert.equal(zhReview.reviewerAttestation, false);

const browserLaneIds = [
  "safari-voiceover-macos",
  "chrome-voiceover-macos",
  "edge-narrator-windows",
  "firefox-nvda-windows",
  "edge-forced-colors-windows",
];
const browserTaskIds = [
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
assert.equal(browserAt.schemaVersion, "taskflow-browser-at-review.v1");
assert.equal(browserAt.status, "template-not-evidence");
assert.deepEqual(
  browserAt.lanes.map(({ laneId }) => laneId),
  browserLaneIds,
);
for (const lane of browserAt.lanes) {
  assert.equal(lane.status, "not-run");
  assert.equal(lane.independentFromImplementation, false);
  assert.deepEqual(Object.keys(lane.results), browserTaskIds);
  for (const result of Object.values(lane.results)) {
    assert.deepEqual(result, {
      decision: null,
      observation: "",
    });
  }
  assert.deepEqual(lane.blockingIssues, []);
  assert.equal(lane.completedAt, null);
  assert.equal(lane.reviewerAttestation, false);
}
assert.equal(browserAt.overallGatePassed, false);
assert.equal(browserAt.completedAt, null);
assert.equal(browserAt.reviewerAttestation, false);

runWebHumanEvidenceVerifierSelfTest();

console.log(
  `web usability materials valid (7 RFC tasks + 8 severity-1 codes + ${referenceManifest.contentCatalogs.keyCounts.combined} zh-CN keys + 5 observed AT lanes; completed-evidence verifier self-test passed)`,
);
