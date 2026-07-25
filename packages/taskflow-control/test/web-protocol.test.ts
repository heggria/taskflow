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
	WebBootstrapViewSchema,
	WebCommandOutcomeSchema,
	WebCommandRequestSchema,
	WebForceReleaseCommandSchema,
	WebSourceObservationSchema,
	WebPageCursorPayloadSchema,
	WebRunListQuerySchema,
	WebRunDetailSchema,
	WebReservationDetailSchema,
	WebSessionExchangeResponseSchema,
	WebStreamCursorPayloadSchema,
	WebStreamFrameSchema,
} from "../src/web-protocol.ts";

const bootstrapFixture = {
	browserProtocolMajor: 1,
	browserProtocolMinor: 0,
	protocolConsumerRange: { major: 1, minMinor: 0, maxMinor: 0 },
	schemaVersion: "web.v1",
	contentCatalogVersion: "taskflow-content.v1",
	defaultLocale: "en",
	supportedLocales: ["en", "zh-CN"],
	contentKeysetDigests: {
		projected: `sha256:${"a".repeat(64)}`,
		static: `sha256:${"b".repeat(64)}`,
		combined: `sha256:${"c".repeat(64)}`,
	},
	listenerId: "listener-1",
	mode: "auto",
	role: "writer",
	principalId: "principal-1",
	principalDisplayName: "Local user",
	csrfToken: "c".repeat(32),
	sessionIdleExpiresAt: 10,
	sessionAbsoluteExpiresAt: 20,
	buildInfo: {
		packageVersion: "0.3.0-beta.2",
		controlSchemaVersion: 1,
	},
	supportedFeatures: ["sse", "polling-fallback"],
	supportedCommands: ["cancel-run"],
	pollingMinIntervalMs: 3_000,
	registryContext: {
		mode: "standalone",
		registryRevision: "standalone",
		visibleMounts: [
			{ projectId: "project-1", controlDomainId: "domain-1" },
		],
	},
	sourceObservation: {
		coverage: "complete",
		authority: "verified",
		observedAt: 1,
		registryContext: {
			mode: "standalone",
			registryRevision: "standalone",
			visibleMounts: [
				{ projectId: "project-1", controlDomainId: "domain-1" },
			],
		},
		watermarks: [],
	},
} as const;

test("P17 bootstrap advertises one bounded polling interval", () => {
	assert.equal(Value.Check(WebBootstrapViewSchema, bootstrapFixture), true);
	for (const pollingMinIntervalMs of [2_999, 60_001]) {
		assert.equal(
			Value.Check(WebBootstrapViewSchema, {
				...bootstrapFixture,
				pollingMinIntervalMs,
			}),
			false,
		);
	}
	assert.equal(
		Value.Check(WebBootstrapViewSchema, {
			...bootstrapFixture,
			pollingIntervalMs: 3_000,
		}),
		false,
	);
});

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
	assert.equal(
		Value.Check(WebCommandRequestSchema, {
			...cancel,
			expectedRunVersion: Number.MAX_SAFE_INTEGER + 1,
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

test("P17 wire observation excludes browser-local stream state", () => {
	assert.equal(
		Value.Check(WebSourceObservationSchema, {
			coverage: "partial",
			authority: "verified",
			observedAt: 1,
			registryContext: {
				mode: "standalone",
				registryRevision: "standalone",
				visibleMounts: [
					{ projectId: "project-1", controlDomainId: "domain-1" },
				],
			},
			watermarks: [],
		}),
		true,
	);
	assert.equal(
		Value.Check(WebSourceObservationSchema, {
			streamState: "connected",
			coverage: "complete",
			authority: "verified",
			observedAt: 1,
			registryContext: {
				mode: "standalone",
				registryRevision: "standalone",
				visibleMounts: [
					{ projectId: "project-1", controlDomainId: "domain-1" },
				],
			},
			watermarks: [],
		}),
		false,
	);
});

test("P17 authoritative DTOs require source observation and reject pre-v5 Run detail", () => {
	const sourceObservation = {
		coverage: "complete",
		authority: "verified",
		observedAt: 1,
		registryContext: {
			mode: "auto",
			registryRevision: "registry-1",
			visibleMounts: [
				{ projectId: "project-1", controlDomainId: "domain-1" },
			],
		},
		watermarks: [
			{
				projectId: "project-1",
				controlDomainId: "domain-1",
				nextCommitSeq: 20,
				minAvailableCommitSeq: 4,
			},
		],
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
			sourceObservation,
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
			sourceObservation,
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
			timeline: { items: [], sourceObservation },
			artifacts: [],
			whyStale: {
				availability: "unavailable",
				unavailableReason: "cache fingerprint evidence is not retained",
				reasons: [],
			},
			replay: { replayable: false, unreplayableReasons: ["run is live"] },
			sourceObservation,
		}),
		false,
	);
});

test("P17 page cursor binds keyset while stream cursor has no page state", () => {
	const pageCursor = {
			version: 1,
			kind: "page",
			collection: "runs",
			listenerId: "listener-1",
			principalHash: "sha256:0123456789abcdef",
			queryHash: "sha256:fedcba9876543210",
			sortKey: "updatedAt",
			sortDirection: "desc",
			registryMode: "auto",
			registryRevision: "registry-1",
			registryContextHash: "sha256:0123456789abcdef",
			visibleMountsHash: "sha256:0123456789abcdef",
			projectWatermarksHash: "sha256:0123456789abcdef",
			after: {
				sortValue: 19,
				projectId: "project-1",
				controlDomainId: "domain-1",
				runId: "run-1",
			},
			issuedAt: 1,
			expiresAt: 2,
		};
	assert.equal(Value.Check(WebPageCursorPayloadSchema, pageCursor), true);
	for (const unsafe of [
		{ ...pageCursor, issuedAt: Number.MAX_SAFE_INTEGER + 1 },
		{
			...pageCursor,
			after: {
				...pageCursor.after,
				sortValue: Number.MAX_SAFE_INTEGER + 1,
			},
		},
	]) {
		assert.equal(Value.Check(WebPageCursorPayloadSchema, unsafe), false);
	}
	const streamCursor = {
		version: 1,
		kind: "stream",
		listenerId: "listener-1",
		principalHash: "sha256:0123456789abcdef",
		registryMode: "auto",
		registryRevision: "registry-1",
		registryContextHash: "sha256:0123456789abcdef",
		visibleMountsHash: "sha256:0123456789abcdef",
		projectIdentityHash: "sha256:0123456789abcdef",
		projectPositions: [20],
		issuedAt: 1,
		expiresAt: 2,
	};
	assert.equal(Value.Check(WebStreamCursorPayloadSchema, streamCursor), true);
	assert.equal(
		Value.Check(WebStreamCursorPayloadSchema, {
			...streamCursor,
			projectPositions: [Number.MAX_SAFE_INTEGER + 1],
		}),
		false,
	);
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
	for (const injected of ["cursor\rid: forged", "cursor\n\nretry: 0", "cursor\0tail"]) {
		assert.equal(
			Value.Check(WebStreamFrameSchema, {
				...heartbeat,
				id: injected,
			}),
			false,
			`SSE id accepted line injection: ${JSON.stringify(injected)}`,
		);
		assert.equal(
			Value.Check(WebStreamFrameSchema, {
				...heartbeat,
				cursor: injected,
			}),
			false,
			`SSE cursor accepted line injection: ${JSON.stringify(injected)}`,
		);
	}
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
