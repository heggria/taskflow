import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	holdWebManualReview,
	isWebManualReviewStage,
	readWebManualReviewConfig,
	webManualReviewRecord,
} from "./web-manual-review-harness.ts";

test("manual review config: defaults to a disabled initial hold", () => {
	assert.deepEqual(readWebManualReviewConfig({}), {
		enabled: false,
		exitAfterHold: false,
		holdMs: 0,
		stage: "initial",
	});
});

test("manual review config: freezes staged exit and release behavior", () => {
	const config = readWebManualReviewConfig({
		TASKFLOW_WEB_MANUAL_REVIEW_EXIT_AFTER_HOLD: "1",
		TASKFLOW_WEB_MANUAL_REVIEW_MS: "900000",
		TASKFLOW_WEB_MANUAL_REVIEW_RELEASE_DIR:
			"/tmp/taskflow-native-review/release",
		TASKFLOW_WEB_MANUAL_REVIEW_STAGE: "sessions",
	});
	assert.deepEqual(config, {
		enabled: true,
		exitAfterHold: true,
		holdMs: 900_000,
		releaseDirectory:
			"/tmp/taskflow-native-review/release",
		stage: "sessions",
	});
	assert.equal(
		isWebManualReviewStage(config, "sessions"),
		true,
	);
	assert.equal(
		isWebManualReviewStage(config, "cancel"),
		false,
	);
});

test("manual review config: rejects ambiguous stage and duration", () => {
	assert.throws(
		() =>
			readWebManualReviewConfig({
				TASKFLOW_WEB_MANUAL_REVIEW_STAGE:
					"approval",
			}),
		/must be one of/u,
	);
	assert.throws(
		() =>
			readWebManualReviewConfig({
				TASKFLOW_WEB_MANUAL_REVIEW_MS: "-1",
			}),
		/non-negative safe integer/u,
	);
	assert.throws(
		() =>
			readWebManualReviewConfig({
				TASKFLOW_WEB_MANUAL_REVIEW_MS: "1s",
			}),
		/non-negative safe integer/u,
	);
	assert.throws(
		() =>
			readWebManualReviewConfig({
				TASKFLOW_WEB_MANUAL_REVIEW_MS:
					"180001",
				TASKFLOW_WEB_MANUAL_REVIEW_STAGE:
					"cancel",
			}),
		/must be <= 180000 for cancel stage/u,
	);
});

test("manual review hold: emits the selected capabilities and releases by directory", async () => {
	const parent = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-native-review-"),
	);
	const releaseDirectory = path.join(parent, "release");
	const config = readWebManualReviewConfig({
		TASKFLOW_WEB_MANUAL_REVIEW_EXIT_AFTER_HOLD: "1",
		TASKFLOW_WEB_MANUAL_REVIEW_MS: "5000",
		TASKFLOW_WEB_MANUAL_REVIEW_RELEASE_DIR:
			releaseDirectory,
		TASKFLOW_WEB_MANUAL_REVIEW_STAGE: "cancel",
	});
	const launches = [
		{
			label: "live-task",
			launchUrl:
				"http://127.0.0.1:1234/__launch/example",
			origin: "http://127.0.0.1:1234",
			project: "live-check",
		},
	] as const;
	const messages: string[] = [];
	try {
		setTimeout(() => {
			fs.mkdirSync(releaseDirectory);
		}, 10);
		assert.equal(
			await holdWebManualReview(config, {
				launches,
				stage: "cancel",
				write: (message) => {
					messages.push(message);
				},
			}),
			true,
		);
		assert.equal(messages.length, 1);
		assert.match(messages[0] ?? "", /^\[manual-review\] /u);
		assert.deepEqual(
			JSON.parse(
				(messages[0] ?? "").replace(
					/^\[manual-review\] /u,
					"",
				),
			),
			webManualReviewRecord(
				config,
				"cancel",
				launches,
			),
		);
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});
