/** P17 browser protocol schema closure and security-sensitive fields. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import {
	FORCE_RELEASE_ACKNOWLEDGEMENT,
	WebCoordinatorSummarySchema,
	WebCommandOutcomeSchema,
	WebCommandRequestSchema,
	WebForceReleaseCommandSchema,
	WebObservationStateSchema,
	WebPageCursorPayloadSchema,
	WebRunListQuerySchema,
	WebRunDetailSchema,
	WebReservationDetailSchema,
	WebSessionExchangeResponseSchema,
	WebStreamCursorPayloadSchema,
	WebStreamFrameSchema,
} from "../src/web-protocol.ts";

test("P17 session exchange uses the common closed response envelope", () => {
	const response = {
		ok: true,
		requestId: "request-1",
		schemaVersion: "web.v1",
		data: {
			csrfToken: "c".repeat(32),
			idleExpiresAt: 10,
			absoluteExpiresAt: 20,
			hostNonce: "a".repeat(26),
		},
	};
	assert.equal(Value.Check(WebSessionExchangeResponseSchema, response), true);
	assert.equal(
		Value.Check(WebSessionExchangeResponseSchema, {
			...response,
			data: { ...response.data, sessionId: "must-remain-http-only" },
		}),
		false,
	);
});

test("P17 command union is closed and policy mutation is absent", () => {
	const cancel = {
		commandId: "cmd-1",
		kind: "cancel-run",
		projectId: "project-1",
		controlDomainId: "domain-1",
		runId: "run-1",
		expectedRunVersion: 3,
	};
	assert.equal(Value.Check(WebCommandRequestSchema, cancel), true);
	assert.equal(
		Value.Check(WebCommandRequestSchema, { ...cancel, surprise: true }),
		false,
	);
	assert.equal(
		Value.Check(WebCommandRequestSchema, {
			commandId: "cmd-policy",
			kind: "update-policy",
			projectId: "project-1",
		}),
		false,
	);
	for (const unsafe of ["../escape", "a/b", "a\\b", "a\0b", "a..b", "x".repeat(129)]) {
		assert.equal(
			Value.Check(WebCommandRequestSchema, { ...cancel, commandId: unsafe }),
			false,
			`unsafe commandId accepted: ${JSON.stringify(unsafe)}`,
		);
	}
});

test("P17 force-release requires complete observed CAS state and exact acknowledgement", () => {
	const command = {
		commandId: "force-1",
		kind: "force-release",
		reservationId: "reservation-1",
		expectedState: "orphan-suspect",
		expectedRevision: 4,
		expectedCoordinatorEpoch: 9,
		expectedProjectId: "project-1",
		expectedControlDomainId: "domain-1",
		expectedRunId: "run-1",
		acknowledgement: FORCE_RELEASE_ACKNOWLEDGEMENT,
	};
	assert.equal(Value.Check(WebForceReleaseCommandSchema, command), true);
	assert.equal(
		Value.Check(WebForceReleaseCommandSchema, {
			...command,
			acknowledgement: true,
		}),
		false,
	);
	assert.equal(
		Value.Check(WebForceReleaseCommandSchema, {
			...command,
			expectedRevision: 0,
		}),
		false,
	);
});

test("P17 observation separates stream, coverage, and authority axes", () => {
	assert.equal(
		Value.Check(WebObservationStateSchema, {
			streamState: "connected",
			coverage: "partial",
			authority: "verified",
			observedAt: 1,
		}),
		true,
	);
	assert.equal(
		Value.Check(WebObservationStateSchema, {
			freshness: "live",
			observedAt: 1,
		}),
		false,
	);
});

test("P17 coordinator and Hard-GA run-detail read DTOs are structurally complete", () => {
	const observation = {
		streamState: "connected",
		coverage: "complete",
		authority: "verified",
		observedAt: 1,
	};
	assert.equal(
		Value.Check(WebCoordinatorSummarySchema, {
			maxActiveRuns: 4,
			occupyingCount: 1,
			coordinatorEpoch: 9,
			reservationCounts: {
				reserved: 0,
				committed: 1,
				released: 0,
				expired: 0,
				orphanSuspect: 0,
			},
			observation,
		}),
		true,
	);
	assert.equal(
		Value.Check(WebReservationDetailSchema, {
			reservationId: "rsv-1",
			state: "committed",
			revision: 2,
			slots: 1,
			coordinatorEpoch: 9,
			projectId: "project-1",
			controlDomainId: "domain-1",
			runId: "run-1",
			providerJobHandlePresent: true,
			createdAt: 1,
			updatedAt: 2,
			operatorOverridden: false,
			observation,
		}),
		true,
	);
	const digest = "sha256:0123456789abcdef";
	assert.equal(
		Value.Check(WebRunDetailSchema, {
			run: {
				projectId: "project-1",
				controlDomainId: "domain-1",
				runId: "run-1",
				status: "running",
				stage: "executing",
				boundPlanHash: digest,
				needsOperator: false,
				runVersion: 2,
				createdAt: 1,
				updatedAt: 2,
				commitSeq: 3,
			},
			boundPlan: {
				boundPlanHash: digest,
				executionSemanticHash: digest,
				programName: "flow",
				approvalMode: "durable-optional",
				grantRefs: [],
				createdAt: 1,
			},
			boundFragments: [],
			nodes: [],
			edges: [],
			attempts: [],
			timeline: { items: [], observation },
			artifacts: [],
			whyStale: { stale: false, reasons: [] },
			replay: { replayable: false, unreplayableReasons: ["run is live"] },
			observation,
		}),
		true,
	);
});

test("P17 page cursor binds keyset while stream cursor has no page state", () => {
	assert.equal(
		Value.Check(WebPageCursorPayloadSchema, {
			version: 1,
			principalHash: "sha256:0123456789abcdef",
			registryRevision: "registry-1",
			queryHash: "sha256:fedcba9876543210",
			sortKey: "updatedAt",
			sortDirection: "desc",
			projectWatermarks: [
				{
					projectId: "project-1",
					controlDomainId: "domain-1",
					nextCommitSeq: 20,
					minAvailableCommitSeq: 4,
				},
			],
			after: {
				sortValue: 19,
				projectId: "project-1",
				controlDomainId: "domain-1",
				runId: "run-1",
			},
			issuedAt: 1,
			expiresAt: 2,
		}),
		true,
	);
	const streamCursor = {
		version: 1,
		principalHash: "sha256:0123456789abcdef",
		registryRevision: "registry-1",
		projectWatermarks: [
			{
				projectId: "project-1",
				controlDomainId: "domain-1",
				nextCommitSeq: 20,
				minAvailableCommitSeq: 4,
			},
		],
		issuedAt: 1,
		expiresAt: 2,
	};
	assert.equal(Value.Check(WebStreamCursorPayloadSchema, streamCursor), true);
	assert.equal(
		Value.Check(WebStreamCursorPayloadSchema, {
			...streamCursor,
			after: { sortValue: 1, projectId: "p", controlDomainId: "d", runId: "r" },
		}),
		false,
	);
});

test("P17 command outcomes are closed by status and cannot contradict themselves", () => {
	const known = {
		commandId: "cmd-1",
		requestHash: "0123456789abcdef".repeat(4),
		kind: "approve",
		firstCommitSeq: 1,
		lastCommitSeq: 2,
		observedAt: 3,
	};
	assert.equal(
		Value.Check(WebCommandOutcomeSchema, { ...known, status: "pending" }),
		true,
	);
	assert.equal(
		Value.Check(WebCommandOutcomeSchema, {
			...known,
			status: "completed",
			error: {
				code: "TF_COMMAND_FAILED",
				message: "contradiction",
				recoveryAction: "operator",
				sideEffects: "unknown",
			},
		}),
		false,
	);
	assert.equal(
		Value.Check(WebCommandOutcomeSchema, { ...known, status: "failed" }),
		false,
	);
	assert.equal(
		Value.Check(WebCommandOutcomeSchema, {
			...known,
			status: "failed",
			error: {
				code: "TF_COMMAND_FAILED",
				message: "failed",
				recoveryAction: "operator",
				sideEffects: "unknown",
				extra: true,
			},
		}),
		false,
	);
	assert.equal(
		Value.Check(WebCommandOutcomeSchema, {
			commandId: "missing-1",
			status: "not-found",
			observedAt: 3,
			requestHash: known.requestHash,
		}),
		false,
	);
});

test("P17 list query bounds pagination and fixes sort vocabulary", () => {
	assert.equal(
		Value.Check(WebRunListQuerySchema, { limit: 200, sortKey: "updatedAt" }),
		true,
	);
	assert.equal(Value.Check(WebRunListQuerySchema, { limit: 201 }), false);
	assert.equal(
		Value.Check(WebRunListQuerySchema, { sortKey: "commitSeq" }),
		false,
	);
});

test("P17 SSE frames are closed discriminated unions", () => {
	const heartbeat = {
		type: "heartbeat",
		id: "cursor-1",
		cursor: "cursor-1",
		observedAt: 1,
	};
	assert.equal(Value.Check(WebStreamFrameSchema, heartbeat), true);
	assert.equal(
		Value.Check(WebStreamFrameSchema, { ...heartbeat, type: "raw-journal" }),
		false,
	);
});

test("web-protocol source is browser-safe", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const source = fs.readFileSync(
		path.join(here, "../src/web-protocol.ts"),
		"utf8",
	);
	assert.doesNotMatch(source, /from\s+["']node:/);
	assert.doesNotMatch(
		source,
		/from\s+["'][^"']*(?:store\/|provider\.ts|daemon)/,
	);
});
