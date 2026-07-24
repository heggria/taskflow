import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const fixtureRoot = path.join(
  root,
  "packages/taskflow-web/test/fixtures/usability-v1",
);
const reviewRoot = path.join(root, "docs/internal/webui");

function readJson(name) {
  return JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8"));
}

function readReviewJson(name) {
  return JSON.parse(readFileSync(path.join(reviewRoot, name), "utf8"));
}

const session = readJson("session-result.template.json");
const summary = readJson("study-summary.template.json");
const zhReview = readJson("zh-cn-content-review.template.json");
const browserAt = readReviewJson("browser-at-result.template.json");
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

assert.equal(session.schemaVersion, "taskflow-usability-session.v1");
assert.equal(session.status, "template-not-evidence");
assert.equal(session.freshParticipant, false);
assert.equal(session.completedAt, null);
assert.equal(session.facilitatorAttestation, false);
assert.deepEqual(
  session.tasks.map(({ taskId }) => taskId),
  [1, 2, 3, 4, 5, 6, 7, 8, 9],
  "session template must cover every frozen task exactly once",
);

const expectedSessions = new Map([
  [1, ["live-packaged", null]],
  [2, ["fixture-render", "simple-home-partial-disconnected"]],
  [3, ["fixture-render", "active-task-result"]],
  [4, ["fixture-render", "needs-input-decision"]],
  [
    5,
    [
      "fixture-render",
      "completed-verified + completed-verification-unavailable",
    ],
  ],
  [6, ["fixture-render", "unknown-reconciling"]],
  [7, ["live-packaged", "pro-evidence-receipt"]],
  [8, ["fixture-render", "error-command-outcome-unknown"]],
  [9, ["live-packaged", "settings-session"]],
]);

for (const task of session.tasks) {
  const expected = expectedSessions.get(task.taskId);
  assert.ok(expected, `unexpected usability task ${task.taskId}`);
  assert.equal(task.evidenceMode, expected[0]);
  assert.equal(task.fixtureId, expected[1]);
  assert.equal(task.score, null, "template must not contain fabricated scores");
  assert.equal(
    task.primaryActionFound,
    null,
    "template must not contain fabricated action evidence",
  );
  assert.equal(task.participantWords, "");
  assert.equal(task.facilitatorIntervention, "");
  assert.equal(task.misunderstanding, "");
}

assert.equal(summary.schemaVersion, "taskflow-usability-study.v1");
assert.equal(summary.status, "template-not-evidence");
assert.deepEqual(summary.sessionRecordSha256, []);
assert.equal(summary.freshEnglishParticipantCount, 0);
assert.equal(summary.nativeChineseReviewerCount, 0);
assert.equal(summary.chineseContentReviewPassed, false);
assert.equal(summary.overallGatePassed, false);
assert.equal(summary.approvedReferenceManifestSha256, null);
assert.equal(summary.completedAt, null);
assert.equal(summary.reviewerAttestation, false);
assert.deepEqual(
  summary.taskResults.map(({ taskId }) => taskId),
  [1, 2, 3, 4, 5, 6, 7, 8, 9],
  "study summary template must cover every frozen task exactly once",
);

const actionTasks = new Set([4, 7, 8, 9]);
for (const result of summary.taskResults) {
  assert.equal(result.score2Count, 0);
  assert.equal(result.score1Count, 0);
  assert.equal(result.score0Count, 0);
  assert.equal(
    result.primaryActionFoundCount,
    actionTasks.has(result.taskId) ? 0 : null,
  );
  assert.equal(result.gatePassed, false);
}

assert.equal(
  zhReview.schemaVersion,
  "taskflow-zh-cn-content-review.v1",
);
assert.equal(zhReview.status, "template-not-evidence");
assert.equal(zhReview.nativeSimplifiedChineseReviewer, false);
assert.equal(zhReview.independentFromImplementation, false);
assert.deepEqual(zhReview.requiredCoverage, {
  projectedKeys: 149,
  staticKeys: 184,
  totalKeys: 337,
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
  assert.deepEqual(Object.keys(lane.results), browserTaskIds);
  assert.deepEqual(
    Object.values(lane.results),
    browserTaskIds.map(() => null),
  );
  assert.deepEqual(lane.blockingIssues, []);
  assert.equal(lane.completedAt, null);
  assert.equal(lane.reviewerAttestation, false);
}
assert.equal(browserAt.overallGatePassed, false);
assert.equal(browserAt.completedAt, null);
assert.equal(browserAt.reviewerAttestation, false);

console.log(
  "web usability materials valid (9 study tasks + zh-CN + 5 browser/AT lanes; templates contain no evidence)",
);
