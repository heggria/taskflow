/** P17 browser protocol schema closure and security-sensitive fields. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import {
	FORCE_RELEASE_ACKNOWLEDGEMENT,
	WebAggregateCursorPayloadSchema,
	WebCommandRequestSchema,
	WebForceReleaseCommandSchema,
	WebObservationStateSchema,
	WebRunListQuerySchema,
	WebSessionExchangeResponseSchema,
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

test("P17 aggregate cursor binds principal, registry revision, query, sort, and watermarks", () => {
	assert.equal(
		Value.Check(WebAggregateCursorPayloadSchema, {
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
			issuedAt: 1,
			expiresAt: 2,
		}),
		true,
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
