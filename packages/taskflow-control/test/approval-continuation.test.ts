import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	approvalContinuationMatchesRun,
	createControlHost,
	createApprovalContinuationCheckpoint,
	decideApproval,
	decodeApprovalContinuationCheckpoint,
	encodeApprovalContinuationCheckpoint,
	hashRequest,
	inspectProjectControlStore,
	linkProgram,
	loadApprovalForRun,
	loadApprovalRequest,
	projectArtifactBlobsDir,
	type CommandRecord,
	type ControlEvent,
	type RunProjection,
} from "../src/index.ts";

function boundPlanHash(): string {
	const linked = linkProgram({
		program: {
			name: "approval-checkpoint",
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
				},
			],
		},
	});
	if (!linked.ok) throw new Error(linked.errors.join("; "));
	return linked.boundPlan.boundPlanHash;
}

test("approval continuation codec round-trips settled private state exactly", () => {
	const checkpoint = createApprovalContinuationCheckpoint({
		runId: "run-checkpoint",
		boundPlanHash: boundPlanHash(),
		approvalPhaseId: "review",
		attempts: [
			{
				phaseId: "before",
				type: "script",
				status: "completed",
				output: "private intermediate output",
				providerName: "script",
				handle: "job-before",
				leaseEpoch: 4,
				attemptId: "att-before",
				startedAt: 100,
				endedAt: 200,
			},
		],
		phaseOutputs: {
			before: "private intermediate output",
		},
		createdAt: 300,
	});
	const bytes = encodeApprovalContinuationCheckpoint(
		checkpoint,
	);
	assert.deepEqual(
		decodeApprovalContinuationCheckpoint(bytes),
		checkpoint,
	);
	const run: RunProjection = {
		runId: checkpoint.runId,
		projectId: "project-checkpoint",
		controlDomainId: "domain-checkpoint",
		status: "paused",
		stage: "parked",
		boundPlanHash: checkpoint.boundPlanHash,
		needsOperator: false,
		createdAt: 1,
		updatedAt: 2,
		runVersion: 3,
		attempts: [
			{
				attemptId: "att-before",
				nodeInstanceId: "before",
				attemptOrdinal: 0,
				provider: "script",
				status: "completed",
				startedAt: 100,
				endedAt: 200,
				providerJobHandlePresent: true,
			},
		],
	};
	assert.equal(
		approvalContinuationMatchesRun(checkpoint, run, {
			exact: true,
		}),
		true,
	);
	assert.equal(
		approvalContinuationMatchesRun(
			checkpoint,
			{
				...run,
				attempts: [
					{
						...run.attempts![0]!,
						attemptId: "att-other",
					},
				],
			},
			{ exact: true },
		),
		false,
	);
});

test("approval continuation rejects unsettled, duplicate, and orphan output state", () => {
	const hash = boundPlanHash();
	assert.throws(
		() =>
			createApprovalContinuationCheckpoint({
				runId: "run-checkpoint",
				boundPlanHash: hash,
				approvalPhaseId: "review",
				attempts: [
					{
						phaseId: "before",
						type: "script",
						status: "still-running",
						attemptId: "att-live",
					},
				],
				phaseOutputs: {},
			}),
		/unique and settled/u,
	);
	assert.throws(
		() =>
			createApprovalContinuationCheckpoint({
				runId: "run-checkpoint",
				boundPlanHash: hash,
				approvalPhaseId: "review",
				attempts: [
					{
						phaseId: "before",
						type: "script",
						status: "completed",
						attemptId: "att-one",
					},
					{
						phaseId: "before",
						type: "script",
						status: "skipped",
						attemptId: "att-two",
					},
				],
				phaseOutputs: {},
			}),
		/unique and settled/u,
	);
	assert.throws(
		() =>
			createApprovalContinuationCheckpoint({
				runId: "run-checkpoint",
				boundPlanHash: hash,
				approvalPhaseId: "review",
				attempts: [],
				phaseOutputs: {
					before: "orphan",
				},
			}),
		/no settled Attempt/u,
	);
});

test("ControlHost parks and rejects a real approval node with truthful durable state", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-approval-continuation-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const marker = path.join(project, "before.txt");
	const host = createControlHost({
		projectRoot: project,
		controlMode: "standalone",
		skipSingleton: true,
		env: {
			...process.env,
			TASKFLOW_HOME: home,
		},
	});
	try {
		const result = await host.admitAndRun({
			commandId: "cmd-real-approval-park",
			program: {
				name: "real-approval-park",
				phases: [
					{
						id: "before",
						type: "script",
						run: `printf once > "${marker}" && printf before`,
					},
					{
						id: "review",
						type: "approval",
						dependsOn: ["before"],
						task:
							"Continue after {steps.before.output}?",
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
		assert.equal(result.ok, true, JSON.stringify(result.error));
		assert.equal(result.run?.status, "paused");
		assert.equal(result.run?.stage, "parked");
		assert.equal(result.run?.reservationId, undefined);
		assert.equal(result.receipt, undefined);
		assert.equal(
			fs.readFileSync(marker, "utf8"),
			"once",
		);

		const approval = loadApprovalForRun(
			project,
			result.run!.runId,
		);
		assert.equal(approval?.status, "pending");
		assert.equal(approval?.nodeInstanceId, "review");
		assert.equal(
			approval?.boundPlanHash,
			result.run?.boundPlanHash,
		);
		assert.equal(
			approval?.message,
			"Continue after before?",
		);
		assert.deepEqual(approval?.allowedDecisions, [
			"approve",
			"reject",
		]);
		assert.equal(
			approval?.continuationArtifactId,
			result.run?.approvalContinuationArtifactId,
		);

		const artifact = host.store.getArtifact(
			approval!.continuationArtifactId!,
		);
		assert.equal(artifact?.role, "approval-continuation");
		assert.equal(artifact?.redactionClass, "secret");
		const bytes = host.store.readArtifactBytes(
			artifact!.digest,
		);
		assert.ok(bytes);
		const checkpoint =
			decodeApprovalContinuationCheckpoint(bytes!);
		assert.equal(
			checkpoint.approvalPhaseId,
			"review",
		);
		assert.deepEqual(checkpoint.phaseOutputs, {
			before: "before",
		});
		assert.equal(checkpoint.attempts.length, 1);
		assert.equal(
			host.store.getReceiptForRun(result.run!.runId),
			null,
		);
		const rejected = await host.reject(result.run!.runId, {
			commandId: "cmd-real-approval-reject",
			principal: "local-reviewer",
			expectedRunVersion: result.run!.runVersion,
			approvalRequestId: approval!.approvalRequestId,
		});
		assert.equal(
			rejected.ok,
			true,
			JSON.stringify(rejected.error),
		);
		assert.equal(rejected.run?.status, "blocked");
		assert.equal(rejected.run?.stage, "terminal");
		assert.deepEqual(
			rejected.run?.nodes?.map((node) => [
				node.nodeInstanceId,
				node.status,
			]),
			[
				["before", "completed"],
				["review", "blocked"],
				["after", "pending"],
			],
		);
		assert.equal(
			loadApprovalForRun(
				project,
				result.run!.runId,
			)?.status,
			"rejected",
		);
		assert.equal(
			host.store.getReceiptForRun(result.run!.runId),
			null,
		);
	} finally {
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("ControlHost expires a real approval node with truthful durable state", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-approval-expiration-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const host = createControlHost({
		projectRoot: project,
		controlMode: "standalone",
		skipSingleton: true,
		env: {
			...process.env,
			TASKFLOW_HOME: home,
		},
	});
	try {
		const parked = await host.admitAndRun({
			commandId: "cmd-real-approval-expire",
			program: {
				name: "real-approval-expire",
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
		assert.equal(
			parked.ok,
			true,
			JSON.stringify(parked.error),
		);
		assert.equal(parked.run?.status, "paused");
		assert.equal(parked.run?.stage, "parked");

		const expired = await host.expireApproval(
			parked.run!.runId,
			{ now: Date.now() + 1 },
		);
		assert.equal(
			expired.ok,
			true,
			JSON.stringify(expired.error),
		);
		assert.equal(expired.run?.status, "blocked");
		assert.equal(expired.run?.stage, "terminal");
		assert.deepEqual(
			expired.run?.nodes?.map((node) => [
				node.nodeInstanceId,
				node.status,
			]),
			[
				["before", "completed"],
				["review", "blocked"],
				["after", "pending"],
			],
		);
		assert.equal(
			loadApprovalForRun(
				project,
				parked.run!.runId,
			)?.status,
			"expired",
		);
		assert.equal(
			host.store.getReceiptForRun(parked.run!.runId),
			null,
		);
	} finally {
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("approved continuation survives restart, never replays settled work, and issues an honest Receipt", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-approval-resume-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	const beforeMarker = path.join(project, "before.txt");
	const afterMarker = path.join(project, "after.txt");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const env = {
		...process.env,
		TASKFLOW_HOME: home,
	};
	let first: ReturnType<typeof createControlHost> | undefined;
	let reopened: ReturnType<typeof createControlHost> | undefined;
	try {
		first = createControlHost({
			projectRoot: project,
			controlMode: "standalone",
			skipSingleton: true,
			env,
		});
		const parked = await first.admitAndRun({
			commandId: "cmd-restart-approval-admit",
			program: {
				name: "restart-approval",
				phases: [
					{
						id: "before",
						type: "script",
						run: `test ! -e "${beforeMarker}" && printf once > "${beforeMarker}" && printf before`,
					},
					{
						id: "review",
						type: "approval",
						dependsOn: ["before"],
						task:
							"Continue after {steps.before.output}?",
					},
					{
						id: "after",
						type: "script",
						dependsOn: ["review"],
						run: `printf once > "${afterMarker}" && printf after`,
						final: true,
					},
				],
			},
		});
		assert.equal(
			parked.ok,
			true,
			JSON.stringify(parked.error),
		);
		assert.equal(parked.run?.status, "paused");
		assert.equal(parked.run?.stage, "parked");
		const runId = parked.run!.runId;
		const approvalRequestId =
			parked.run!.approvalRequestId!;
		const continuationArtifactId =
			parked.run!.approvalContinuationArtifactId!;
		const expectedRunVersion =
			parked.run!.runVersion;
		first.close();
		first = undefined;

		reopened = createControlHost({
			projectRoot: project,
			controlMode: "standalone",
			skipSingleton: true,
			env,
		});
		const completed = await reopened.approve(runId, {
			commandId: "cmd-restart-approval-approve",
			principal: "local-user",
			expectedRunVersion,
			approvalRequestId,
		});
		assert.equal(
			completed.ok,
			true,
			JSON.stringify(completed.error),
		);
		assert.equal(completed.run?.status, "completed");
		assert.equal(completed.run?.stage, "terminal");
		assert.equal(completed.run?.finalOutput, "after");
		assert.equal(
			fs.readFileSync(beforeMarker, "utf8"),
			"once",
		);
		assert.equal(
			fs.readFileSync(afterMarker, "utf8"),
			"once",
		);
		assert.deepEqual(
			completed.run?.attempts?.map((attempt) => [
				attempt.nodeInstanceId,
				attempt.status,
				attempt.providerJobHandlePresent,
			]),
			[
				["before", "completed", true],
				["review", "completed", false],
				["after", "completed", true],
			],
		);
		assert.ok(completed.receipt);
		assert.equal(
			completed.receipt?.assurance.provenance,
			"ok",
		);
		assert.equal(
			completed.receipt?.assurance.providerOutcome,
			"ok",
		);
		assert.equal(
			completed.receipt?.artifactRefs.includes(
				continuationArtifactId,
			),
			false,
		);
		assert.equal(
			reopened.store.getCommand(
				"cmd-restart-approval-approve",
			)?.status,
			"completed",
		);
		const approval = loadApprovalForRun(project, runId);
		assert.equal(approval?.status, "approved");
		assert.equal(
			approval?.decisionCommandId,
			"cmd-restart-approval-approve",
		);
		const privateArtifact = reopened.store.getArtifact(
			continuationArtifactId,
		);
		assert.equal(
			privateArtifact?.role,
			"approval-continuation",
		);
		assert.equal(
			privateArtifact?.redactionClass,
			"secret",
		);
		const inspected = inspectProjectControlStore(
			project,
			{
				projectId: reopened.projectId,
				controlDomainId:
					reopened.controlDomainId,
			},
		);
		assert.equal(
			inspected.ok,
			true,
			inspected.ok ? undefined : inspected.detail,
		);
	} finally {
		first?.close();
		reopened?.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("startup recovery closes every queued approve saga crash window without replay", async () => {
	const crashWindows = [
		"after-project-commit",
		"after-coordinator-commit",
		"after-approval-decision",
		"after-command-settlement",
		"after-dispatch-marker",
	] as const;
	for (const crashWindow of crashWindows) {
		const root = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				`tf-approval-recovery-${crashWindow}-`,
			),
		);
		const project = path.join(root, "project");
		const home = path.join(root, "home");
		const beforeMarker = path.join(
			project,
			"before.txt",
		);
		const afterMarker = path.join(
			project,
			"after.txt",
		);
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(home, { recursive: true });
		const env = {
			...process.env,
			TASKFLOW_HOME: home,
		};
		let first:
			| ReturnType<typeof createControlHost>
			| undefined;
		let reopened:
			| ReturnType<typeof createControlHost>
			| undefined;
		try {
			first = createControlHost({
				projectRoot: project,
				controlMode: "standalone",
				skipSingleton: true,
				env,
			});
			const parked = await first.admitAndRun({
				commandId: `cmd-admit-${crashWindow}`,
				program: {
					name: `approval-recovery-${crashWindow}`,
					phases: [
						{
							id: "before",
							type: "script",
							run: `test ! -e "${beforeMarker}" && printf once > "${beforeMarker}" && printf before`,
						},
						{
							id: "review",
							type: "approval",
							dependsOn: ["before"],
							task: "Continue?",
						},
						{
							id: "after",
							type: "script",
							dependsOn: ["review"],
							run: `test ! -e "${afterMarker}" && printf once > "${afterMarker}" && printf after`,
							final: true,
						},
					],
				},
			});
			assert.equal(
				parked.ok,
				true,
				JSON.stringify(parked.error),
			);
			const parkedRun = parked.run!;
			const approval = loadApprovalForRun(
				project,
				parkedRun.runId,
			)!;
			const commandId = `cmd-approve-${crashWindow}`;
			const principal = "recovery-user";
			const requestHash = hashRequest({
				kind: "approve",
				runId: parkedRun.runId,
				expectedRunVersion:
					parkedRun.runVersion,
				approvalRequestId:
					approval.approvalRequestId,
			});
			const reservation = first.coordinator.reserve({
				coordinatorEpoch: 101,
			});
			assert.ok(reservation);
			const command: CommandRecord = {
				commandId,
				requestHash,
				callerPrincipal: principal,
				authorizationContextHash: hashRequest({
					principal,
				}),
				projectId: first.projectId,
				controlDomainId:
					first.controlDomainId,
				kind: "approve",
				status: "accepted",
				firstCommitSeq: 0,
				lastCommitSeq: 0,
				runId: parkedRun.runId,
				recordedAt: Date.now(),
			};
			const makeEvent = (
				payload: ControlEvent["payload"],
			): ControlEvent => ({
				eventId: `ev-${crypto.randomUUID()}`,
				schemaVersion: 1,
				controlDomainId:
					first!.controlDomainId,
				streamId: parkedRun.runId,
				streamSeq: 0,
				commitSeq: 0,
				commandId,
				projectId: first!.projectId,
				recordedAt: Date.now(),
				payload,
			});
			const accepted = first.store.compareAndCommit({
				runId: parkedRun.runId,
				expectedRunVersion:
					parkedRun.runVersion,
				build: (run) => ({
					command,
					run: {
						...run,
						status: "running",
						stage: "queued",
						reservationId:
							reservation.reservationId,
						updatedAt: Date.now(),
						runVersion:
							run.runVersion + 1,
					},
					events: [
						makeEvent({
							type: "ApprovalDecided",
							runId: run.runId,
							approvalRequestId:
								approval.approvalRequestId,
							decision: "approve",
						}),
						makeEvent({
							type: "RunStatusChanged",
							runId: run.runId,
							status: "running",
							stage: "queued",
							reason:
								"approval-approved-awaiting-dispatch",
						}),
					],
				}),
			});
			assert.equal(accepted.ok, true);

			if (
				crashWindow !==
				"after-project-commit"
			) {
				first.coordinator.commitReservation(
					reservation.reservationId,
					{
						projectId: first.projectId,
						projectControlDomainId:
							first.controlDomainId,
						runId: parkedRun.runId,
						projectAdmitCommitSeq:
							accepted.commitSeqEnd,
					},
				);
			}
			if (
				crashWindow ===
					"after-approval-decision" ||
				crashWindow ===
					"after-command-settlement" ||
				crashWindow ===
					"after-dispatch-marker"
			) {
				const decided = decideApproval(
					project,
					approval.approvalRequestId,
					{
						decision: "approve",
						principal,
						commandId,
					},
				);
				assert.equal(decided.ok, true);
			}
			if (
				crashWindow ===
					"after-command-settlement" ||
				crashWindow ===
					"after-dispatch-marker"
			) {
				const acceptedCommand =
					first.store.getCommand(commandId)!;
				const current =
					first.store.getRun(
						parkedRun.runId,
					)!;
				const settled =
					first.store.compareAndCommit({
						runId: current.runId,
						expectedRunVersion:
							current.runVersion,
						build: (run) => ({
							command: {
								...acceptedCommand,
								status: "completed",
								lastCommitSeq: 0,
								recordedAt:
									Date.now(),
							},
							run: {
								...run,
								updatedAt:
									Date.now(),
								runVersion:
									run.runVersion +
									1,
							},
							events: [
								makeEvent({
									type: "Generic",
									kind: "ApprovalDispatchAccepted",
									data: {
										approvalRequestId:
											approval.approvalRequestId,
										approvalPhaseId:
											approval.nodeInstanceId,
										continuationArtifactId:
											approval.continuationArtifactId,
									},
								}),
							],
						}),
				});
				assert.equal(settled.ok, true);
			}
			if (
				crashWindow ===
				"after-dispatch-marker"
			) {
				const current =
					first.store.getRun(
						parkedRun.runId,
					)!;
				const dispatched =
					first.store.compareAndCommit({
						runId: current.runId,
						expectedRunVersion:
							current.runVersion,
						build: (run) => ({
							run: {
								...run,
								status: "running",
								stage: "executing",
								updatedAt:
									Date.now(),
								runVersion:
									run.runVersion +
									1,
							},
							events: [
								makeEvent({
									type: "RunAdmitted",
									runId: run.runId,
									reservationId:
										reservation.reservationId,
								}),
								makeEvent({
									type: "RunStatusChanged",
									runId: run.runId,
									status: "running",
									stage: "executing",
									reason:
										"approval-continuation-dispatched",
								}),
							],
						}),
					});
				assert.equal(dispatched.ok, true);
			}

			first.close();
			first = undefined;
			reopened = createControlHost({
				projectRoot: project,
				controlMode: "standalone",
				skipSingleton: true,
				env,
			});
			const report =
				await reopened.recoverApprovedContinuations();
			const unsafeAfterDispatch =
				crashWindow ===
				"after-dispatch-marker";
			assert.deepEqual(
				{
					inspected: report.inspected,
					resumed: report.resumed,
					failed: report.failed,
				},
				unsafeAfterDispatch
					? {
							inspected: 1,
							resumed: 0,
							failed: 1,
						}
					: {
							inspected: 1,
							resumed: 1,
							failed: 0,
						},
				`${crashWindow}: ${JSON.stringify(report)}`,
			);
			const completed =
				reopened.store.getRun(parkedRun.runId)!;
			assert.equal(
				completed.status,
				unsafeAfterDispatch
					? "unknown"
					: "completed",
			);
			assert.equal(
				completed.stage,
				unsafeAfterDispatch
					? "reconciling"
					: "terminal",
			);
			assert.equal(
				completed.finalOutput,
				unsafeAfterDispatch
					? undefined
					: "after",
			);
			assert.equal(
				Boolean(completed.receiptId),
				!unsafeAfterDispatch,
			);
			assert.equal(
				reopened.store.getCommand(commandId)
					?.status,
				"completed",
			);
			assert.equal(
				loadApprovalForRun(
					project,
					parkedRun.runId,
				)?.status,
				"approved",
			);
			assert.equal(
				fs.readFileSync(beforeMarker, "utf8"),
				"once",
			);
			assert.equal(
				fs.existsSync(afterMarker),
				!unsafeAfterDispatch,
			);
			if (!unsafeAfterDispatch) {
				assert.equal(
					fs.readFileSync(
						afterMarker,
						"utf8",
					),
					"once",
				);
			}
			assert.equal(
				completed.attempts?.filter(
					(attempt) =>
						attempt.nodeInstanceId ===
						"before",
				).length,
				1,
			);
			assert.equal(
				(
					await reopened.recoverApprovedContinuations()
				).inspected,
				0,
			);
		} finally {
			first?.close();
			reopened?.close();
			fs.rmSync(root, {
				recursive: true,
				force: true,
			});
		}
	}
});

test("multiple approvals checkpoint and consume exactly one decision at a time", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-multi-approval-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	const beforeMarker = path.join(project, "before.txt");
	const middleMarker = path.join(project, "middle.txt");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const host = createControlHost({
		projectRoot: project,
		controlMode: "standalone",
		skipSingleton: true,
		env: {
			...process.env,
			TASKFLOW_HOME: home,
		},
	});
	try {
		const firstPark = await host.admitAndRun({
			commandId: "cmd-multi-approval-admit",
			program: {
				name: "multiple-approvals",
				phases: [
					{
						id: "before",
						type: "script",
						run: `test ! -e "${beforeMarker}" && printf once > "${beforeMarker}" && printf before`,
					},
					{
						id: "review-one",
						type: "approval",
						dependsOn: ["before"],
						task: "Approve the first boundary?",
					},
					{
						id: "middle",
						type: "script",
						dependsOn: ["review-one"],
						run: `test ! -e "${middleMarker}" && printf once > "${middleMarker}" && printf middle`,
					},
					{
						id: "review-two",
						type: "approval",
						dependsOn: ["middle"],
						task: "Approve the second boundary?",
					},
					{
						id: "after",
						type: "script",
						dependsOn: ["review-two"],
						run: "printf after",
						final: true,
					},
				],
			},
		});
		assert.equal(firstPark.ok, true);
		const runId = firstPark.run!.runId;
		const firstApprovalId =
			firstPark.run!.approvalRequestId!;
		const firstApproved = await host.approve(runId, {
			commandId: "cmd-multi-approval-first",
			expectedRunVersion:
				firstPark.run!.runVersion,
			approvalRequestId: firstApprovalId,
		});
		assert.equal(
			firstApproved.ok,
			true,
			JSON.stringify(firstApproved.error),
		);
		assert.equal(firstApproved.run?.status, "paused");
		assert.equal(firstApproved.run?.stage, "parked");
		assert.equal(firstApproved.receipt, undefined);
		assert.equal(
			fs.readFileSync(beforeMarker, "utf8"),
			"once",
		);
		assert.equal(
			fs.readFileSync(middleMarker, "utf8"),
			"once",
		);
		assert.equal(
			loadApprovalRequest(project, firstApprovalId)
				?.status,
			"approved",
		);

		const secondApproval = loadApprovalForRun(
			project,
			runId,
		);
		assert.equal(secondApproval?.status, "pending");
		assert.equal(
			secondApproval?.nodeInstanceId,
			"review-two",
		);
		assert.notEqual(
			secondApproval?.approvalRequestId,
			firstApprovalId,
		);
		const completed = await host.approve(runId, {
			commandId: "cmd-multi-approval-second",
			expectedRunVersion:
				firstApproved.run!.runVersion,
			approvalRequestId:
				secondApproval!.approvalRequestId,
		});
		assert.equal(
			completed.ok,
			true,
			JSON.stringify(completed.error),
		);
		assert.equal(completed.run?.status, "completed");
		assert.equal(completed.run?.finalOutput, "after");
		assert.deepEqual(
			completed.run?.attempts?.map(
				(attempt) => attempt.nodeInstanceId,
			),
			[
				"before",
				"review-one",
				"middle",
				"review-two",
				"after",
			],
		);
		assert.equal(
			fs.readFileSync(beforeMarker, "utf8"),
			"once",
		);
		assert.equal(
			fs.readFileSync(middleMarker, "utf8"),
			"once",
		);
		const continuationArtifacts =
			host.store
				.listArtifactsForRun(runId)
				.filter(
					(artifact) =>
						artifact.role ===
						"approval-continuation",
				);
		assert.equal(continuationArtifacts.length, 2);
		for (const artifact of continuationArtifacts) {
			assert.equal(
				completed.receipt?.artifactRefs.includes(
					artifact.artifactId,
				),
				false,
			);
		}
	} finally {
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("corrupt continuation fails closed after approval with no Receipt", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-corrupt-approval-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const host = createControlHost({
		projectRoot: project,
		controlMode: "standalone",
		skipSingleton: true,
		env: {
			...process.env,
			TASKFLOW_HOME: home,
		},
	});
	try {
		const parked = await host.admitAndRun({
			commandId: "cmd-corrupt-approval-admit",
			program: {
				name: "corrupt-approval",
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
		const artifact = host.store.getArtifact(
			parked.run!.approvalContinuationArtifactId!,
		);
		assert.ok(artifact);
		fs.writeFileSync(
			path.join(
				projectArtifactBlobsDir(project),
				artifact!.digest.slice("sha256:".length),
			),
			"corrupt",
		);

		const result = await host.approve(
			parked.run!.runId,
			{
				commandId:
					"cmd-corrupt-approval-approve",
				expectedRunVersion:
					parked.run!.runVersion,
				approvalRequestId:
					parked.run!.approvalRequestId,
			},
		);
		assert.equal(result.ok, false);
		assert.equal(
			result.error?.code,
			"TF_RECONCILE_REQUIRED",
		);
		assert.match(
			result.error?.message ?? "",
			/missing or corrupt/u,
		);
		assert.equal(result.run?.status, "unknown");
		assert.equal(result.run?.stage, "reconciling");
		assert.equal(result.run?.needsOperator, true);
		assert.equal(
			host.store.getCommand(
				"cmd-corrupt-approval-approve",
			)?.status,
			"accepted",
		);
		assert.equal(
			loadApprovalForRun(
				project,
				parked.run!.runId,
			)?.status,
			"approved",
		);
		assert.equal(
			host.store.getReceiptForRun(
				parked.run!.runId,
			),
			null,
		);
		assert.equal(
			host.coordinator.getReservation(
				result.run!.reservationId!,
			)?.state,
			"orphan-suspect",
		);
	} finally {
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
