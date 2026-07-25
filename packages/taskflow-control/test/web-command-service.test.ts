import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	createApprovalRequest,
	loadApprovalRequest,
} from "../src/approval.ts";
import { createControlHost } from "../src/control-host.ts";
import { openUserCoordinatorStore } from "../src/store/coordinator.ts";
import {
	WEB_DEFAULT_ENABLED_COMMAND_KINDS,
	WEB_IMPLEMENTED_COMMAND_HANDLER_IDS,
	WEB_IMPLEMENTED_COMMAND_KINDS,
	WEB_PRODUCTION_ENABLEABLE_COMMAND_KINDS,
	assertProductionWebCommandCapabilities,
	createWebCommandHandlers,
} from "../src/web-command-service.ts";
import {
	WebCommandOutcomeSchema,
	type WebHandlerContext,
} from "../src/web-protocol.ts";
import { WebReadServiceError } from "../src/web-read-service.ts";
import type {
	ControlEvent,
	RunProjection,
} from "../src/types.ts";

function fixture() {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-command-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const host = createControlHost({
		projectRoot: project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		env: { ...process.env, TASKFLOW_HOME: home },
	});
	return {
		root,
		host,
		cleanup() {
			host.close();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

function multiProjectFixture() {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-command-multi-"),
	);
	const home = path.join(root, "home");
	const env = { ...process.env, TASKFLOW_HOME: home };
	const create = (name: string) => {
		const projectRoot = path.join(root, name);
		fs.mkdirSync(projectRoot, { recursive: true });
		return createControlHost({
			projectRoot,
			controlMode: "auto",
			skipSingleton: true,
			allowMockProvider: true,
			env,
		});
	};
	const hosts = [create("primary"), create("secondary")] as const;
	return {
		root,
		home,
		env,
		hosts,
		cleanup() {
			for (const host of hosts) host.close();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

function parkRejectableRun(host: ReturnType<typeof createControlHost>, runId: string) {
	const approval = createApprovalRequest(host.store.projectRoot, {
		runId,
		projectId: host.projectId,
		controlDomainId: host.controlDomainId,
		expectedRunVersion: 1,
		allowedDecisions: ["reject"],
	});
	const now = Date.now();
	host.store.commit({
		events: [
			{
				eventId: `event-${runId}-parked`,
				schemaVersion: 1,
				controlDomainId: host.controlDomainId,
				streamId: runId,
				streamSeq: 0,
				commitSeq: 0,
				projectId: host.projectId,
				recordedAt: now,
				payload: {
					type: "ApprovalParked",
					runId,
					approvalRequestId: approval.approvalRequestId,
				},
			},
		],
		run: {
			runId,
			projectId: host.projectId,
			controlDomainId: host.controlDomainId,
			status: "paused",
			stage: "parked",
			boundPlanHash: `bp:${"d".repeat(64)}`,
			needsOperator: false,
			createdAt: now,
			updatedAt: now,
			runVersion: 1,
			approvalRequestId: approval.approvalRequestId,
		},
	});
	return approval;
}

function context(
	principalId = "principal-web",
	observedAt = 1_900_000_000_000,
): WebHandlerContext {
	return {
		requestId: "request-web-command",
		listenerId: "listener-web-command",
		principalId,
		principalDisplayName: "Local user",
		principalHash: `sha256:${"a".repeat(64)}`,
		observedAt,
		sessionAbsoluteExpiresAt: observedAt + 60_000,
	};
}

test("Web commands: implementation inventory is closed and coordinator commands recover by id", async () => {
	assert.deepEqual(WEB_IMPLEMENTED_COMMAND_HANDLER_IDS, [
		"commands",
		"command",
	]);
	assert.deepEqual(WEB_IMPLEMENTED_COMMAND_KINDS, [
		"approve",
		"reject",
		"cancel-run",
		"set-max-active-runs",
		"force-release",
	]);
	assert.deepEqual(WEB_DEFAULT_ENABLED_COMMAND_KINDS, [
		"approve",
		"reject",
		"cancel-run",
	]);
	assert.deepEqual(
		WEB_PRODUCTION_ENABLEABLE_COMMAND_KINDS,
		[
			"approve",
			"reject",
			"cancel-run",
			"set-max-active-runs",
			"force-release",
		],
	);
	assert.doesNotThrow(() =>
		assertProductionWebCommandCapabilities([
			"approve",
			"reject",
			"cancel-run",
			"force-release",
		]),
	);
	assert.throws(
		() =>
			assertProductionWebCommandCapabilities([
				"edit-approval",
			]),
		/not production-conforming: edit-approval/u,
	);
	const testFixture = fixture();
	try {
		const handlers = createWebCommandHandlers(testFixture.host, {
			supportedCommands: ["set-max-active-runs"],
		});
		const body = {
			commandId: "cmd-set-capacity",
			kind: "set-max-active-runs" as const,
			value: 6,
			expectedMaxActiveRuns: 4,
			expectedCoordinatorEpoch: 0,
		};
		const submitted = await handlers.commands(
			{ params: {}, query: {}, body },
			context(),
		);
		assert.equal(Value.Check(WebCommandOutcomeSchema, submitted), true);
		assert.equal(submitted.status, "completed");
		assert.equal(testFixture.host.coordinator.maxActiveRuns, 6);

		const recovered = await handlers.command(
			{
				params: { commandId: body.commandId },
				query: {},
				body: {},
			},
			context(),
		);
		assert.deepEqual(recovered, submitted);

		const missing = await handlers.command(
			{
				params: { commandId: "cmd-not-found" },
				query: {},
				body: {},
			},
			context(),
		);
		assert.deepEqual(missing, {
			commandId: "cmd-not-found",
			status: "not-found",
			observedAt: context().observedAt,
		});

		await assert.rejects(
			async () =>
				handlers.command(
					{
						params: { commandId: body.commandId },
						query: {},
						body: {},
					},
					context("principal-other"),
				),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code ===
					"TF_CROSS_PRINCIPAL_COMMAND",
		);
	} finally {
		testFixture.cleanup();
	}
});

test("Web commands: reject uses current Run CAS and a durable recoverable command", async () => {
	const testFixture = fixture();
	try {
		const runId = "run-web-reject";
		const approval = createApprovalRequest(
			testFixture.host.store.projectRoot,
			{
				runId,
				projectId: testFixture.host.projectId,
				controlDomainId:
					testFixture.host.controlDomainId,
				expectedRunVersion: 1,
				allowedDecisions: ["reject"],
			},
		);
		const now = Date.now();
		const run: RunProjection = {
			runId,
			projectId: testFixture.host.projectId,
			controlDomainId:
				testFixture.host.controlDomainId,
			status: "paused",
			stage: "parked",
			boundPlanHash: `bp:${"b".repeat(64)}`,
			needsOperator: false,
			createdAt: now,
			updatedAt: now,
			runVersion: 1,
			approvalRequestId: approval.approvalRequestId,
		};
		const event: ControlEvent = {
			eventId: "event-web-reject-parked",
			schemaVersion: 1,
			controlDomainId:
				testFixture.host.controlDomainId,
			streamId: runId,
			streamSeq: 0,
			commitSeq: 0,
			projectId: testFixture.host.projectId,
			recordedAt: now,
			payload: {
				type: "ApprovalParked",
				runId,
				approvalRequestId:
					approval.approvalRequestId,
			},
		};
		testFixture.host.store.commit({
			events: [event],
			run,
		});

		const handlers = createWebCommandHandlers(testFixture.host, {
			supportedCommands: ["reject"],
		});
		const body = {
			commandId: "cmd-web-reject",
			kind: "reject" as const,
			projectId: testFixture.host.projectId,
			controlDomainId:
				testFixture.host.controlDomainId,
			runId,
			expectedRunVersion: 1,
			approvalRequestId:
				approval.approvalRequestId,
			reason: "Not approved for publication.",
		};
		const outcome = await handlers.commands(
			{ params: {}, query: {}, body },
			context(),
		);
		assert.equal(Value.Check(WebCommandOutcomeSchema, outcome), true);
		assert.equal(outcome.status, "completed");
		assert.equal(
			testFixture.host.store.getCommand(
				body.commandId,
			)?.status,
			"completed",
		);
		assert.equal(
			testFixture.host.store.getRun(runId)?.status,
			"blocked",
		);
		const decided = loadApprovalRequest(
			testFixture.host.store.projectRoot,
			approval.approvalRequestId,
		);
		assert.equal(decided?.status, "rejected");
		assert.equal(
			decided?.decisionCommandId,
			body.commandId,
		);

		const retried = await handlers.commands(
			{ params: {}, query: {}, body },
			context(),
		);
		assert.deepEqual(retried, outcome);
			await assert.rejects(
				async () =>
					handlers.commands(
					{
					params: {},
					query: {},
					body: {
						...body,
						reason: "Different body",
					},
				},
						context(),
					),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code ===
					"TF_IDEMPOTENCY_CONFLICT",
		);
	} finally {
		testFixture.cleanup();
	}
});

test("Web commands: approve resumes the exact checkpoint and exposes only the durable command outcome", async () => {
	const testFixture = fixture();
	try {
		const parked =
			await testFixture.host.admitAndRun({
				commandId:
					"cmd-web-approve-admit",
				program: {
					name: "web-approval",
					phases: [
						{
							id: "before",
							type: "script",
							run: "printf before",
						},
						{
							id: "review",
							type: "approval",
							dependsOn: ["before"],
							task:
								"Approve this task?",
						},
						{
							id: "after",
							type: "script",
							dependsOn: ["review"],
							run: "printf after",
							final: true,
						},
					],
				},
			});
		assert.equal(parked.ok, true);
		assert.equal(parked.run?.stage, "parked");
		const continuationArtifactId =
			parked.run!
				.approvalContinuationArtifactId!;
		const handlers = createWebCommandHandlers(
			testFixture.host,
			{
				supportedCommands: ["approve"],
			},
		);
		const body = {
			commandId: "cmd-web-approve",
			kind: "approve" as const,
			projectId: testFixture.host.projectId,
			controlDomainId:
				testFixture.host.controlDomainId,
			runId: parked.run!.runId,
			expectedRunVersion:
				parked.run!.runVersion,
			approvalRequestId:
				parked.run!.approvalRequestId!,
		};
		const outcome = await handlers.commands(
			{ params: {}, query: {}, body },
			context(),
		);
		assert.equal(
			Value.Check(
				WebCommandOutcomeSchema,
				outcome,
			),
			true,
		);
		assert.equal(outcome.status, "completed");
		const run = testFixture.host.store.getRun(
			body.runId,
		);
		assert.equal(run?.status, "completed");
		assert.equal(run?.stage, "terminal");
		assert.deepEqual(
			run?.attempts?.map(
				(attempt) =>
					attempt.nodeInstanceId,
			),
			["before", "review", "after"],
		);
		const receipt =
			testFixture.host.store.getReceiptForRun(
				body.runId,
			);
		assert.ok(receipt);
		assert.equal(
			receipt?.artifactRefs.includes(
				continuationArtifactId,
			),
			false,
		);
		assert.equal(
			testFixture.host.store.getCommand(
				body.commandId,
			)?.status,
			"completed",
		);

		const retried = await handlers.commands(
			{ params: {}, query: {}, body },
			context(),
		);
		assert.deepEqual(retried, outcome);
	} finally {
		testFixture.cleanup();
	}
});

test("Web commands: unsupported kinds fail closed and never create a record", async () => {
	const testFixture = fixture();
	try {
		const handlers = createWebCommandHandlers(testFixture.host);
			await assert.rejects(
				async () =>
					handlers.commands(
				{
					params: {},
					query: {},
					body: {
						commandId: "cmd-resume-disabled",
						kind: "resume-run",
						projectId: testFixture.host.projectId,
						controlDomainId:
							testFixture.host.controlDomainId,
						runId: "run-disabled",
						expectedRunVersion: 1,
					},
				},
						context(),
					),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code ===
					"TF_FEATURE_REQUIRED",
		);
		assert.equal(
			testFixture.host.store.getCommand(
				"cmd-resume-disabled",
			),
			null,
		);
	} finally {
		testFixture.cleanup();
	}
});

test("Web commands: multi-project listener resolves the exact home authority", async () => {
	const primary = fixture();
	const secondary = fixture();
	try {
		const runId = "run-web-secondary-reject";
		const approval = createApprovalRequest(
			secondary.host.store.projectRoot,
			{
				runId,
				projectId: secondary.host.projectId,
				controlDomainId:
					secondary.host.controlDomainId,
				expectedRunVersion: 1,
				allowedDecisions: ["reject"],
			},
		);
		const now = Date.now();
		secondary.host.store.commit({
			events: [
				{
					eventId:
						"event-web-secondary-reject-parked",
					schemaVersion: 1,
					controlDomainId:
						secondary.host.controlDomainId,
					streamId: runId,
					streamSeq: 0,
					commitSeq: 0,
					projectId: secondary.host.projectId,
					recordedAt: now,
					payload: {
						type: "ApprovalParked",
						runId,
						approvalRequestId:
							approval.approvalRequestId,
					},
				},
			],
			run: {
				runId,
				projectId: secondary.host.projectId,
				controlDomainId:
					secondary.host.controlDomainId,
				status: "paused",
				stage: "parked",
				boundPlanHash: `bp:${"c".repeat(64)}`,
				needsOperator: false,
				createdAt: now,
				updatedAt: now,
				runVersion: 1,
				approvalRequestId:
					approval.approvalRequestId,
			},
		});
		const hosts = [primary.host, secondary.host];
		const handlers = createWebCommandHandlers(primary.host, {
			supportedCommands: ["reject"],
			resolveHost: (projectId, controlDomainId) =>
				hosts.find(
					(host) =>
						host.projectId === projectId &&
						host.controlDomainId ===
							controlDomainId,
				) ?? null,
			listHosts: () => hosts,
		});
		const body = {
			commandId: "cmd-web-secondary-reject",
			kind: "reject" as const,
			projectId: secondary.host.projectId,
			controlDomainId:
				secondary.host.controlDomainId,
			runId,
			expectedRunVersion: 1,
			approvalRequestId:
				approval.approvalRequestId,
			reason: "Secondary project decision.",
		};
		const outcome = await handlers.commands(
			{ params: {}, query: {}, body },
			context(),
		);
		assert.equal(outcome.status, "completed");
		assert.equal(
			primary.host.store.getCommand(body.commandId),
			null,
		);
		assert.equal(
			secondary.host.store.getCommand(body.commandId)
				?.status,
			"completed",
		);
		assert.deepEqual(
			await handlers.command(
				{
					params: {
						commandId: body.commandId,
					},
					query: {},
					body: {},
				},
				context(),
			),
			outcome,
		);

		await assert.rejects(
			async () =>
				handlers.commands(
				{
					params: {},
					query: {},
					body: {
						...body,
						commandId:
							"cmd-web-wrong-domain",
						controlDomainId:
							primary.host
								.controlDomainId,
					},
				},
					context(),
				),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code ===
					"TF_AUTHORITY_REVOKED",
		);
	} finally {
		primary.cleanup();
		secondary.cleanup();
	}
});

test("Web commands: listener-global route claim prevents sequential and concurrent cross-project reuse", async () => {
	const testFixture = multiProjectFixture();
	try {
		const [primary, secondary] = testFixture.hosts;
		const hosts = [...testFixture.hosts];
		const handlers = createWebCommandHandlers(primary, {
			supportedCommands: ["reject"],
			resolveHost: (projectId, controlDomainId) =>
				hosts.find(
					(candidate) =>
						candidate.projectId === projectId &&
						candidate.controlDomainId === controlDomainId,
				) ?? null,
			listHosts: () => hosts,
		});
			const makeBody = (
				host: ReturnType<typeof createControlHost>,
				runId: string,
			commandId: string,
		) => {
			const approval = parkRejectableRun(host, runId);
			return {
				commandId,
				kind: "reject" as const,
				projectId: host.projectId,
				controlDomainId: host.controlDomainId,
				runId,
				expectedRunVersion: 1,
				approvalRequestId: approval.approvalRequestId,
				reason: "Do not continue.",
				};
			};

			const legacy = makeBody(
				primary,
				"run-route-legacy-primary",
				"cmd-route-legacy",
			);
			const legacyResult = await primary.reject(legacy.runId, {
				commandId: legacy.commandId,
				principal: "principal-web",
				expectedRunVersion: legacy.expectedRunVersion,
				approvalRequestId: legacy.approvalRequestId,
				note: legacy.reason,
			});
			assert.equal(legacyResult.ok, true);
			await assert.rejects(
				async () =>
					await handlers.commands(
						{
							params: {},
							query: {},
							body: {
								...legacy,
								reason: "Changed legacy body.",
							},
						},
						context(),
					),
				(error: unknown) =>
					error instanceof WebReadServiceError &&
					error.controlError.code ===
						"TF_IDEMPOTENCY_CONFLICT",
			);
			assert.equal(
				openUserCoordinatorStore(
					testFixture.env,
				).getCommandRoute(legacy.commandId),
				null,
			);
			assert.equal(
				(
					await handlers.commands(
						{ params: {}, query: {}, body: legacy },
						context(),
					)
				).status,
				"completed",
			);

			const first = makeBody(
				primary,
			"run-route-sequential-primary",
			"cmd-route-sequential",
		);
		const conflicting = makeBody(
			secondary,
			"run-route-sequential-secondary",
			first.commandId,
		);
		const firstOutcome = await handlers.commands(
			{ params: {}, query: {}, body: first },
			context(),
		);
			await assert.rejects(
				async () =>
					await handlers.commands(
						{ params: {}, query: {}, body: conflicting },
						context(),
					),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code ===
					"TF_IDEMPOTENCY_CONFLICT",
		);
		assert.equal(
			primary.store.getCommand(first.commandId)?.status,
			"completed",
		);
		assert.equal(secondary.store.getCommand(first.commandId), null);
		assert.deepEqual(
			await handlers.command(
				{
					params: { commandId: first.commandId },
					query: {},
					body: {},
				},
				context(),
			),
			firstOutcome,
		);
		assert.deepEqual(
			openUserCoordinatorStore(testFixture.env).getCommandRoute(
				first.commandId,
			)?.authority,
			{
				kind: "project",
				projectId: primary.projectId,
				controlDomainId: primary.controlDomainId,
			},
		);

		const concurrentId = "cmd-route-concurrent";
		const concurrent = [
			makeBody(
				primary,
				"run-route-concurrent-primary",
				concurrentId,
			),
			makeBody(
				secondary,
				"run-route-concurrent-secondary",
				concurrentId,
			),
		] as const;
		const settled = await Promise.allSettled(
			concurrent.map((body) =>
				handlers.commands(
					{ params: {}, query: {}, body },
					context(),
				),
			),
		);
		assert.equal(
			settled.filter((result) => result.status === "fulfilled")
				.length,
			1,
		);
		assert.equal(
			settled.filter(
				(result) =>
					result.status === "rejected" &&
					result.reason instanceof WebReadServiceError &&
					result.reason.controlError.code ===
						"TF_IDEMPOTENCY_CONFLICT",
			).length,
			1,
		);
		assert.equal(
			hosts.filter(
				(candidate) =>
					candidate.store.getCommand(concurrentId) !== null,
			).length,
			1,
		);
		const persisted =
			openUserCoordinatorStore(
				testFixture.env,
			).getCommandRoute(concurrentId);
		assert.ok(persisted);
		assert.equal(persisted.commandId, concurrentId);
	} finally {
		testFixture.cleanup();
	}
});
