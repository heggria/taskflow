import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { createControlHost } from "../src/control-host.ts";
import {
	createMockExecutionProvider,
	type ExecutionProvider,
} from "../src/provider.ts";
import {
	inspectProjectControlStore,
	openProjectControlStore,
} from "../src/store/project-store.ts";
import {
	createWebCursorCodec,
} from "../src/web-cursor.ts";
import type { ControlEvent } from "../src/types.ts";
import {
	WebArtifactPageSchema,
	WebApprovalDetailSchema,
	WebApprovalPageSchema,
	WebAttentionPageSchema,
	WebAttemptPageSchema,
	WebBoundFragmentPageSchema,
	WebCoordinatorSummarySchema,
	WebNodeDetailSchema,
	WebOverviewViewSchema,
	WebProjectDetailSchema,
	WebProjectPageSchema,
	WebPolicyExplanationSchema,
	WebReceiptViewSchema,
	WebReservationDetailSchema,
	WebRunDetailSchema,
	WebRunGraphViewSchema,
	WebRunPageSchema,
	WebTimelineEventPageSchema,
	WebWhyStaleViewSchema,
} from "../src/web-protocol.ts";
import {
	WEB_IMPLEMENTED_READ_HANDLER_IDS,
	WebReadServiceError,
	createInitialWebReadHandlers,
	createInitialWebReadService,
} from "../src/web-read-service.ts";
import { WEB_ENDPOINTS } from "../src/web-protocol.ts";

function tempWorkspace() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-web-read-"));
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	return {
		root,
		project,
		env: { ...process.env, TASKFLOW_HOME: home },
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

function handlerContext(observedAt: number) {
	return {
		requestId: "request-web-read",
		listenerId: "listener-web-read",
		principalId: "principal-local",
		principalDisplayName: "Local user",
		principalHash: `sha256:${"a".repeat(64)}`,
		observedAt,
		sessionAbsoluteExpiresAt: observedAt + 8 * 60 * 60_000,
	};
}

test("read-only ControlStore inspection proves header, projection, and watermark identity", () => {
	const temp = tempWorkspace();
	try {
		const store = openProjectControlStore(temp.project);
		const inspected = inspectProjectControlStore(temp.project, {
			projectId: store.header.projectId,
			controlDomainId: store.header.controlDomainId,
		});
		assert.equal(inspected.ok, true);
		if (!inspected.ok) return;
		assert.equal(inspected.snapshot.nextCommitSeq, 1);
		assert.equal(inspected.snapshot.minAvailableCommitSeq, 1);
		assert.deepEqual(inspected.snapshot.runs, []);
		assert.deepEqual(inspected.snapshot.boundPlans, []);
		assert.deepEqual(inspected.snapshot.receipts, []);
		assert.deepEqual(inspected.snapshot.approvals, []);
		const mismatch = inspectProjectControlStore(temp.project, {
			projectId: "proj-other",
			controlDomainId: store.header.controlDomainId,
		});
		assert.deepEqual(mismatch, {
			ok: false,
			reason: "identity-mismatch",
			detail: "registry identity does not match the control store header",
		});
	} finally {
		temp.cleanup();
	}
});

test("read-only inspection includes durable BoundPlan and Receipt provenance", async () => {
	const temp = tempWorkspace();
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		env: temp.env,
	});
	try {
		const admitted = await host.admitAndRun({
			commandId: "cmd-web-inspection",
			program: {
				name: "inspectable-task",
				phases: [
					{
						id: "main",
						type: "script",
						run: "printf inspected",
						final: true,
					},
				],
			},
		});
		assert.equal(admitted.ok, true, JSON.stringify(admitted.error));
		const inspected = inspectProjectControlStore(temp.project, {
			projectId: host.projectId,
			controlDomainId: host.controlDomainId,
		});
		assert.equal(inspected.ok, true);
		if (!inspected.ok) return;
		assert.equal(inspected.snapshot.runs.length, 1);
		assert.equal(
			inspected.snapshot.runs[0]?.lastCommitSeq,
			inspected.snapshot.nextCommitSeq - 1,
		);
		assert.deepEqual(
			inspected.snapshot.runs[0]?.nodes?.map((node) => ({
				phaseId: node.phaseId,
				status: node.status,
			})),
			[{ phaseId: "main", status: "completed" }],
		);
		assert.equal(
			inspected.snapshot.runs[0]?.attempts?.[0]
				?.providerJobHandlePresent,
			true,
		);
		assert.equal(inspected.snapshot.boundPlans.length, 1);
		assert.equal(
			inspected.snapshot.boundPlans[0]?.programName,
			"inspectable-task",
		);
		assert.equal(inspected.snapshot.receipts.length, 1);
		assert.equal(
			inspected.snapshot.receipts[0]?.runId,
			admitted.run?.runId,
		);
		assert.equal(
			inspected.snapshot.receipts[0]?.assurance
				.provenance,
			"ok",
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("real handler coverage is explicit and cannot be confused with 29 generated contracts", () => {
	assert.deepEqual(WEB_IMPLEMENTED_READ_HANDLER_IDS, [
		"overview",
		"projects",
		"projectDetail",
		"coordinator",
		"reservationDetail",
		"runs",
		"runDetail",
		"runFragments",
		"runGraph",
		"runTimeline",
		"nodeDetail",
		"nodeAttempts",
		"runArtifacts",
		"runReceipt",
		"runWhyStale",
		"approvals",
		"approvalDetail",
		"attention",
		"policyExplanation",
	]);
	assert.equal(WEB_IMPLEMENTED_READ_HANDLER_IDS.length, 19);
	assert.equal(Object.keys(WEB_ENDPOINTS).length, 29);
});

test("Project handler uses verified headers and stable keyset pagination", async () => {
	const temp = tempWorkspace();
	const second = path.join(temp.root, "second-project");
	fs.mkdirSync(second, { recursive: true });
	const observedAt = 1_800_000_000_000;
	const context = handlerContext(observedAt);
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "auto",
		skipSingleton: true,
		allowMockProvider: true,
		env: temp.env,
	});
	try {
		const secondStore = openProjectControlStore(second);
		host.registry.registerFromStore(secondStore, second);
		const handlers = createInitialWebReadHandlers(host, {
			cursorCodec: createWebCursorCodec({
				key: Buffer.alloc(32, 4),
				listenerId: context.listenerId,
				now: () => observedAt,
			}),
		});
		const first = await handlers.projects(
			{ params: {}, query: { limit: 1 }, body: {} },
			context,
		);
		assert.equal(Value.Check(WebProjectPageSchema, first), true);
		assert.equal(first.items.length, 1);
		assert.ok(first.nextCursor);
		assert.equal(first.items[0]?.authorityVerified, true);
		assert.equal(
			first.items[0]?.directoryBindingLabel.includes(temp.root),
			false,
		);
		const secondPage = await handlers.projects(
			{
				params: {},
				query: { limit: 1, cursor: first.nextCursor },
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebProjectPageSchema, secondPage), true);
		assert.equal(secondPage.items.length, 1);
		assert.equal(secondPage.nextCursor, undefined);
		assert.notEqual(
			first.items[0]?.projectId,
			secondPage.items[0]?.projectId,
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("initial real handlers return schema-valid overview/coordinator/reservation reads", async () => {
	const temp = tempWorkspace();
	const observedAt = 1_800_000_000_000;
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		env: temp.env,
	});
	try {
		const reservation = host.coordinator.reserve({ coordinatorEpoch: 7 });
		assert.ok(reservation);
		const handlers = createInitialWebReadHandlers(host, {
			now: () => observedAt,
		});
		const requestContext = handlerContext(observedAt);
		const overview = await handlers.overview(
			{ params: {}, query: {}, body: {} },
			requestContext,
		);
		const coordinator = await handlers.coordinator({
			params: {},
			query: {},
			body: {},
		}, requestContext);
		const detail = await handlers.reservationDetail(
			{
				params: { reservationId: reservation.reservationId },
				query: {},
				body: {},
			},
			requestContext,
		);
		const projectDetail = await handlers.projectDetail(
			{
				params: {
					projectId: host.projectId,
					controlDomainId: host.controlDomainId,
				},
				query: {},
				body: {},
			},
			requestContext,
		);
		const policyExplanation = await handlers.policyExplanation(
			{
				params: {},
				query: { projectId: host.projectId },
				body: {},
			},
			requestContext,
		);
		assert.equal(Value.Check(WebOverviewViewSchema, overview), true);
		assert.equal(Value.Check(WebCoordinatorSummarySchema, coordinator), true);
		assert.equal(Value.Check(WebReservationDetailSchema, detail), true);
		assert.equal(
			Value.Check(WebProjectDetailSchema, projectDetail),
			true,
		);
		assert.equal(
			Value.Check(
				WebPolicyExplanationSchema,
				policyExplanation,
			),
			true,
		);
		assert.equal(overview.sourceObservation.authority, "verified");
		assert.equal(overview.sourceObservation.coverage, "complete");
		assert.equal(overview.sourceObservation.observedAt, observedAt);
		assert.equal(overview.coordinatorCapacity.occupied, 1);
		assert.equal(coordinator.reservationCounts.reserved, 1);
		assert.equal(detail.providerJobHandlePresent, false);
		assert.equal(overview.usage.availability, "measured");
		assert.match(overview.usage.methodology, /No Tasks exist/u);
		assert.equal(projectDetail.displayRoot.includes(temp.root), false);
		assert.equal(projectDetail.header.verified, true);
		assert.equal(
			policyExplanation.policyHash,
			projectDetail.effectivePolicyHash,
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("Run handler projects durable truth and paginates without loss or duplication", async () => {
	const temp = tempWorkspace();
	const observedAt = 1_800_000_000_000;
	const context = handlerContext(observedAt);
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		env: temp.env,
	});
	try {
		for (const [index, name] of [
			"first-task",
			"second-task",
			"third-task",
		].entries()) {
			const admitted = await host.admitAndRun({
				commandId: `cmd-web-list-${index}`,
				program: {
					name,
					phases: [
						{
							id: "main",
							type: "script",
							run: `printf ${index}`,
							final: true,
						},
					],
				},
			});
			assert.equal(admitted.ok, true, JSON.stringify(admitted.error));
		}
		const cursorCodec = createWebCursorCodec({
			key: Buffer.alloc(32, 9),
			listenerId: context.listenerId,
			now: () => observedAt,
		});
		const handlers = createInitialWebReadHandlers(host, {
			now: () => observedAt,
			cursorCodec,
		});
		const first = await handlers.runs(
			{
				params: {},
				query: { limit: 2 },
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebRunPageSchema, first), true);
		assert.equal(first.items.length, 2);
		assert.ok(first.nextCursor);
		assert.ok(
			first.items.every(
				(item) =>
					item.displayTitle.endsWith("-task") &&
					item.presentation.headline.key === "task.completed" &&
					item.commitSeq > 0,
			),
		);
		const second = await handlers.runs(
			{
				params: {},
				query: { limit: 2, cursor: first.nextCursor },
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebRunPageSchema, second), true);
		assert.equal(second.items.length, 1);
		assert.equal(second.nextCursor, undefined);
		const ids = [...first.items, ...second.items].map(
			(item) => item.runId,
		);
		assert.equal(new Set(ids).size, 3);

		const selected = first.items[0]!;
		const timelineItems: Array<{
			eventId: string;
			commitSeq: number;
		}> = [];
		let timelineCursor: string | undefined;
		do {
			const page = await handlers.runTimeline(
				{
					params: {
						projectId: selected.projectId,
						controlDomainId: selected.controlDomainId,
						runId: selected.runId,
					},
					query: {
						expectedRunVersion: selected.runVersion,
						limit: 2,
						...(timelineCursor
							? { cursor: timelineCursor }
							: {}),
					},
					body: {},
				},
				context,
			);
			assert.equal(
				Value.Check(WebTimelineEventPageSchema, page),
				true,
			);
			timelineItems.push(...page.items);
			timelineCursor = page.nextCursor;
		} while (timelineCursor);
		assert.ok(timelineItems.length >= 4);
		assert.equal(
			new Set(timelineItems.map((event) => event.eventId)).size,
			timelineItems.length,
		);
		assert.deepEqual(
			timelineItems.map((event) => event.commitSeq),
			[...timelineItems]
				.map((event) => event.commitSeq)
				.sort((left, right) => left - right),
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("Run detail, graph, node, attempt, artifact, Receipt, and why-stale reads stay authoritative", async () => {
	const temp = tempWorkspace();
	const observedAt = 1_800_000_000_000;
	const context = handlerContext(observedAt);
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		env: temp.env,
	});
	try {
		const admitted = await host.admitAndRun({
			commandId: "cmd-web-detail",
			program: {
				name: "detail-task",
				phases: [
					{
						id: "prepare",
						type: "script",
						run: "printf ready",
					},
					{
						id: "finish",
						type: "script",
						dependsOn: ["prepare"],
						run: "printf done",
						final: true,
					},
				],
			},
		});
		assert.equal(admitted.ok, true, JSON.stringify(admitted.error));
		assert.ok(admitted.run);
		assert.ok(admitted.receipt);
		const run = admitted.run!;
		const receipt = admitted.receipt!;
		const handlers = createInitialWebReadHandlers(host, {
			now: () => observedAt,
			cursorCodec: createWebCursorCodec({
				key: Buffer.alloc(32, 12),
				listenerId: context.listenerId,
				now: () => observedAt,
			}),
		});
		const params = {
			projectId: run.projectId,
			controlDomainId: run.controlDomainId,
			runId: run.runId,
		};
		const detail = await handlers.runDetail(
			{ params, query: {}, body: {} },
			context,
		);
		assert.equal(Value.Check(WebRunDetailSchema, detail), true);
		assert.equal(detail.nodes.length, 2);
		assert.deepEqual(
			detail.edges.map((edge) => [
				edge.fromNodeInstanceId,
				edge.toNodeInstanceId,
			]),
			[["prepare", "finish"]],
		);
		assert.equal(detail.receipt?.receiptId, receipt.receiptId);
		assert.equal(detail.whyStale.availability, "unavailable");
		assert.equal(detail.replay.replayable, true);
		assert.equal(
			detail.replay.traceArtifact?.role,
			"replay-trace",
		);
		assert.equal(
			detail.replay.traceArtifact?.receiptId,
			receipt.receiptId,
		);
		assert.deepEqual(detail.replay.unreplayableReasons, []);

		const fragments = await handlers.runFragments(
			{
				params,
				query: { expectedRunVersion: run.runVersion, limit: 1 },
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebBoundFragmentPageSchema, fragments), true);
		assert.deepEqual(fragments.items, []);

		const graphFirst = await handlers.runGraph(
			{
				params,
				query: { expectedRunVersion: run.runVersion, limit: 1 },
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebRunGraphViewSchema, graphFirst), true);
		assert.equal(graphFirst.nodes.length, 1);
		assert.ok(graphFirst.nextCursor);
		const graphSecond = await handlers.runGraph(
			{
				params,
				query: {
					expectedRunVersion: run.runVersion,
					limit: 1,
					cursor: graphFirst.nextCursor,
				},
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebRunGraphViewSchema, graphSecond), true);
		assert.equal(graphSecond.nodes.length, 1);
		assert.equal(graphSecond.nextCursor, undefined);
		assert.equal(
			new Set(
				[...graphFirst.nodes, ...graphSecond.nodes].map(
					(node) => node.nodeInstanceId,
				),
			).size,
			2,
		);

		const node = await handlers.nodeDetail(
			{
				params: { ...params, nodeInstanceId: "finish" },
				query: {},
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebNodeDetailSchema, node), true);
		assert.deepEqual(node.dependencyNodeInstanceIds, ["prepare"]);
		assert.equal(node.attemptCount, 1);
		assert.equal(
			node.providerObservation.outcome,
			"completed",
		);
		assert.equal(
			node.providerObservation.jobHandlePresent,
			true,
		);

		const attempts = await handlers.nodeAttempts(
			{
				params: { ...params, nodeInstanceId: "finish" },
				query: { expectedRunVersion: run.runVersion, limit: 1 },
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebAttemptPageSchema, attempts), true);
		assert.equal(attempts.items.length, 1);
		assert.equal(attempts.items[0]?.providerJobHandlePresent, true);

		const artifacts = await handlers.runArtifacts(
			{
				params,
				query: {
					expectedRunVersion: run.runVersion,
					expectedReceiptId: receipt.receiptId,
				},
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebArtifactPageSchema, artifacts), true);
		assert.equal(artifacts.items.length, 2);
		const finalArtifact = artifacts.items.find(
			(artifact) => artifact.role === "final-output",
		);
		assert.equal(finalArtifact?.integrity, "ok");
		assert.equal(
			finalArtifact?.receiptId,
			receipt.receiptId,
		);

		const manifestIds: string[] = [];
		let receiptCursor: string | undefined;
		do {
			const receiptView = await handlers.runReceipt(
				{
					params,
					query: {
						expectedRunVersion: run.runVersion,
						expectedReceiptId: receipt.receiptId,
						limit: 2,
						...(receiptCursor
							? { cursor: receiptCursor }
							: {}),
					},
					body: {},
				},
				context,
			);
			assert.equal(Value.Check(WebReceiptViewSchema, receiptView), true);
			manifestIds.push(
				...receiptView.eventManifest.items.map(
					(entry) => entry.eventId,
				),
			);
			receiptCursor = receiptView.eventManifest.nextCursor;
		} while (receiptCursor);
		assert.deepEqual(manifestIds, receipt.eventManifest);

		const whyStale = await handlers.runWhyStale(
			{
				params,
				query: { targetIds: ["prepare", "finish"] },
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebWhyStaleViewSchema, whyStale), true);
		assert.ok(
			whyStale.targets.every(
				(target) => target.reuseDecision === "unavailable",
			),
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("dynamic inventory handlers expose durable fragment provenance and graph descendants", async () => {
	const temp = tempWorkspace();
	const observedAt = 1_800_000_100_000;
	const context = handlerContext(observedAt);
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		llmProvider: createMockExecutionProvider({
			output: "dynamic-ok",
		}),
		env: temp.env,
	});
	try {
		const admitted = await host.admitAndRun({
			commandId: "cmd-web-dynamic",
			program: {
				name: "dynamic-web-task",
				phases: [
					{
						id: "expand-work",
						type: "expand",
						expandMode: "nested",
						def: {
							name: "runtime-children",
							phases: [
								{
									id: "inspect",
									type: "script",
									run: "printf inspect",
								},
								{
									id: "report",
									type: "script",
									run: "printf report",
									dependsOn: ["inspect"],
									final: true,
								},
							],
						},
					},
					{
						id: "expand-more",
						type: "expand",
						expandMode: "graft",
						dependsOn: ["expand-work"],
						def: {
							name: "runtime-finalizer",
							phases: [
								{
									id: "finalize",
									type: "script",
									run: "printf final",
									final: true,
								},
							],
						},
						final: true,
					},
				],
			},
		});
		assert.equal(admitted.ok, true, JSON.stringify(admitted.error));
		const run = admitted.run!;
		const handlers = createInitialWebReadHandlers(host, {
			now: () => observedAt,
			cursorCodec: createWebCursorCodec({
				key: Buffer.alloc(32, 27),
				listenerId: context.listenerId,
				now: () => observedAt,
			}),
		});
		const params = {
			projectId: run.projectId,
			controlDomainId: run.controlDomainId,
			runId: run.runId,
		};
		const detail = await handlers.runDetail(
			{ params, query: {}, body: {} },
			context,
		);
		assert.equal(Value.Check(WebRunDetailSchema, detail), true);
		assert.equal(detail.boundFragments.length, 2);
		assert.ok(
			detail.boundFragments.some(
				(fragment) =>
					fragment.boundFragmentHash ===
					run.boundFragmentHash,
			),
		);
		assert.equal(
			detail.nodes.filter(
				(node) => node.origin === "bound-fragment",
			).length,
			3,
		);
		assert.ok(
			detail.edges.some(
				(edge) =>
					edge.kind === "dynamic-child" &&
					edge.fromNodeInstanceId ===
						"expand-work",
			),
		);
		assert.ok(
			detail.edges.some(
				(edge) =>
					edge.kind === "depends-on" &&
					edge.fromNodeInstanceId.startsWith(
						"dyn-",
					) &&
					edge.toNodeInstanceId.startsWith(
						"dyn-",
					),
			),
		);

		const firstFragments = await handlers.runFragments(
			{
				params,
				query: {
					expectedRunVersion: run.runVersion,
					limit: 1,
				},
				body: {},
			},
			context,
		);
		assert.equal(
			Value.Check(
				WebBoundFragmentPageSchema,
				firstFragments,
			),
			true,
		);
		assert.equal(firstFragments.items.length, 1);
		assert.ok(firstFragments.nextCursor);
		const secondFragments = await handlers.runFragments(
			{
				params,
				query: {
					expectedRunVersion: run.runVersion,
					limit: 1,
					cursor:
						firstFragments.nextCursor,
				},
				body: {},
			},
			context,
		);
		assert.equal(
			Value.Check(
				WebBoundFragmentPageSchema,
				secondFragments,
			),
			true,
		);
		assert.equal(secondFragments.items.length, 1);
		assert.equal(secondFragments.nextCursor, undefined);
		const fragmentItems = [
			...firstFragments.items,
			...secondFragments.items,
		];
		assert.equal(
			new Set(
				fragmentItems.map(
					(item) => item.boundFragmentHash,
				),
			).size,
			2,
		);
		assert.deepEqual(
			fragmentItems.map((item) => ({
				parent: item.parentNodeInstanceId,
				origin: item.originPhaseId,
				kind: item.linkKind,
				dynamic: item.dynamicNodeCount,
			})),
			[
				{
					parent: "expand-work",
					origin: "expand-work",
					kind: "nested-flow",
					dynamic: 2,
				},
				{
					parent: "expand-more",
					origin: "expand-more",
					kind: "graft-promote",
					dynamic: 1,
				},
			],
		);

		const timeline = await handlers.runTimeline(
			{
				params,
				query: {
					expectedRunVersion: run.runVersion,
					limit: 50,
				},
				body: {},
			},
			context,
		);
		assert.equal(
			timeline.items.filter(
				(event) =>
					event.kind ===
					"BoundFragmentLinked",
			).length,
			2,
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("node provider observation follows authoritative ambiguous run state", async () => {
	const temp = tempWorkspace();
	const observedAt = 1_800_000_150_000;
	const context = handlerContext(observedAt);
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		provider: createMockExecutionProvider({
			outcome: "ambiguous",
			ambiguousForever: true,
		}),
		reconcileBudget: {
			maxAttempts: 1,
			deadlineMs: 20,
		},
		env: temp.env,
	});
	try {
		const admitted = await host.admitAndRun({
			commandId: "cmd-web-ambiguous-provider",
			program: {
				name: "ambiguous-provider-task",
				phases: [
					{
						id: "main",
						type: "script",
						run: "printf ignored",
						final: true,
					},
				],
			},
		});
		assert.equal(admitted.ok, false);
		assert.equal(admitted.run?.status, "unknown");
		assert.equal(admitted.run?.stage, "reconciling");
		assert.equal(admitted.receipt, undefined);

		const handlers = createInitialWebReadHandlers(host, {
			now: () => observedAt,
			cursorCodec: createWebCursorCodec({
				key: Buffer.alloc(32, 29),
				listenerId: context.listenerId,
				now: () => observedAt,
			}),
		});
		const node = await handlers.nodeDetail(
			{
				params: {
					projectId: admitted.run!.projectId,
					controlDomainId:
						admitted.run!.controlDomainId,
					runId: admitted.run!.runId,
					nodeInstanceId: "main",
				},
				query: {},
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebNodeDetailSchema, node), true);
		assert.deepEqual(node.providerObservation, {
			provider: "mock",
			jobHandlePresent: true,
			outcome: "ambiguous",
		});
		const attention = await handlers.attention(
			{
				params: {},
				query: { limit: 50 },
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebAttentionPageSchema, attention), true);
		assert.deepEqual(
			attention.items
				.filter(
					(item) =>
						item.runId === admitted.run!.runId ||
						item.reservationId ===
							admitted.run!.reservationId,
				)
				.map((item) => item.message.key)
				.sort(),
			[
				"attention.execution-place-held",
				"attention.execution-unconfirmed",
			],
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("node provider observation exposes a checkpointed in-flight Attempt as running", async () => {
	const temp = tempWorkspace();
	const observedAt = 1_800_000_155_000;
	const context = handlerContext(observedAt);
	let completed = false;
	let observedFirstPoll: (() => void) | undefined;
	const firstPoll = new Promise<void>((resolve) => {
		observedFirstPoll = resolve;
	});
	const provider: ExecutionProvider = {
		name: "controlled-provider",
		async submit() {
			return {
				kind: "accepted",
				handle: "job-controlled-running",
				leaseEpoch: 7,
			};
		},
		async poll() {
			observedFirstPoll?.();
			observedFirstPoll = undefined;
			return completed
				? {
						kind: "completed",
						output: "controlled output",
					}
				: { kind: "still-running" };
		},
		async cancel() {
			completed = true;
			return { kind: "cancelled" };
		},
		async reconcile() {
			return completed
				? {
						kind: "completed",
						output: "controlled output",
					}
				: {
						kind: "ambiguous",
						reason: "controlled in flight",
					};
		},
		isLive() {
			return !completed;
		},
	};
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		provider,
		reconcileBudget: {
			maxAttempts: 1,
			deadlineMs: 1_000,
		},
		env: temp.env,
	});
	try {
		const admittedPromise = host.admitAndRun({
			commandId: "cmd-web-running-provider",
			program: {
				name: "running-provider-task",
				phases: [
					{
						id: "main",
						type: "script",
						run: "printf ignored",
						final: true,
					},
				],
			},
		});
		await firstPoll;
		const run = host.store.listRuns()[0]!;
		assert.equal(run.status, "running");
		assert.equal(run.stage, "executing");

		const handlers = createInitialWebReadHandlers(host, {
			now: () => observedAt,
			cursorCodec: createWebCursorCodec({
				key: Buffer.alloc(32, 30),
				listenerId: context.listenerId,
				now: () => observedAt,
			}),
		});
		const node = await handlers.nodeDetail(
			{
				params: {
					projectId: run.projectId,
					controlDomainId:
						run.controlDomainId,
					runId: run.runId,
					nodeInstanceId: "main",
				},
				query: {},
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebNodeDetailSchema, node), true);
		assert.deepEqual(node.providerObservation, {
			provider: "controlled-provider",
			jobHandlePresent: true,
			outcome: "running",
		});

		completed = true;
		const admitted = await admittedPromise;
		assert.equal(admitted.ok, true, JSON.stringify(admitted.error));
		assert.equal(
			admitted.receipt?.assurance.provenance,
			"ok",
		);
	} finally {
		completed = true;
		host.close();
		temp.cleanup();
	}
});

test("node provider observation distinguishes failed, rejected, and cancelled outcomes", async () => {
	const observedAt = 1_800_000_160_000;
	const context = handlerContext(observedAt);
	const scenarios: Array<{
		name: string;
		provider: ExecutionProvider;
		expected: {
			provider: string;
			jobHandlePresent: boolean;
			outcome: "failed" | "cancelled";
		};
		cancelAfterAdmit?: boolean;
	}> = [
		{
			name: "failed",
			provider: createMockExecutionProvider({
				outcome: "failed",
			}),
			expected: {
				provider: "mock",
				jobHandlePresent: true,
				outcome: "failed",
			},
		},
		{
			name: "rejected",
			provider: {
				name: "rejecting-provider",
				async submit() {
					return {
						kind: "rejected",
						reason: "provider rejected",
					};
				},
				async poll() {
					return {
						kind: "failed",
						error: "not submitted",
					};
				},
				async cancel() {
					return { kind: "already-terminal" };
				},
				async reconcile() {
					return {
						kind: "failed",
						error: "not submitted",
					};
				},
			},
			expected: {
				provider: "rejecting-provider",
				jobHandlePresent: false,
				outcome: "failed",
			},
		},
		{
			name: "cancelled",
			provider: createMockExecutionProvider({
				outcome: "hang",
			}),
			expected: {
				provider: "mock",
				jobHandlePresent: true,
				outcome: "cancelled",
			},
			cancelAfterAdmit: true,
		},
	];

	for (const scenario of scenarios) {
		const temp = tempWorkspace();
		const host = createControlHost({
			projectRoot: temp.project,
			controlMode: "standalone",
			skipSingleton: true,
			allowMockProvider: true,
			provider: scenario.provider,
			reconcileBudget: {
				maxAttempts: 1,
				deadlineMs: 20,
			},
			env: temp.env,
		});
		try {
			const admitted = await host.admitAndRun({
				commandId: `cmd-web-provider-${scenario.name}`,
				program: {
					name: `${scenario.name}-provider-task`,
					phases: [
						{
							id: "main",
							type: "script",
							run: "printf ignored",
							final: true,
						},
					],
				},
			});
			let run = admitted.run!;
			if (scenario.cancelAfterAdmit) {
				const cancelled = await host.cancel(run.runId, {
					commandId:
						"cmd-web-provider-cancelled-settle",
					expectedRunVersion: run.runVersion,
				});
				assert.equal(
					cancelled.ok,
					true,
					JSON.stringify(cancelled.error),
				);
				run = cancelled.run!;
			} else {
				assert.equal(admitted.ok, false);
				assert.equal(run.status, "failed");
			}

			const handlers = createInitialWebReadHandlers(host, {
				now: () => observedAt,
				cursorCodec: createWebCursorCodec({
					key: Buffer.alloc(
						32,
						30 + scenarios.indexOf(scenario),
					),
					listenerId: context.listenerId,
					now: () => observedAt,
				}),
			});
			const node = await handlers.nodeDetail(
				{
					params: {
						projectId: run.projectId,
						controlDomainId:
							run.controlDomainId,
						runId: run.runId,
						nodeInstanceId: "main",
					},
					query: {},
					body: {},
				},
				context,
			);
			assert.equal(
				Value.Check(WebNodeDetailSchema, node),
				true,
			);
			assert.deepEqual(
				node.providerObservation,
				scenario.expected,
			);
			assert.equal(
				host.store.getReceiptForRun(run.runId),
				null,
			);
		} finally {
			host.close();
			temp.cleanup();
		}
	}
});

test("Approval list and detail use the durable ApprovalRequest and current Run CAS", async () => {
	const temp = tempWorkspace();
	const observedAt = Date.now();
	const context = handlerContext(observedAt);
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		env: temp.env,
	});
	try {
		const parked = await host.admitAndRun({
			commandId: "cmd-web-approval-read",
			program: {
				name: "approval-task",
				phases: [
					{
						id: "prepare",
						type: "script",
						run: "printf prepared",
					},
					{
						id: "review",
						type: "approval",
						dependsOn: ["prepare"],
						task: "Review",
					},
				],
			},
		});
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		assert.ok(parked.run?.approvalRequestId);
		const runId = parked.run!.runId;
		const handlers = createInitialWebReadHandlers(host, {
			now: () => observedAt,
			supportedCommands: [
				"approve",
				"reject",
				"cancel-run",
			],
			cursorCodec: createWebCursorCodec({
				key: Buffer.alloc(32, 19),
				listenerId: context.listenerId,
				now: () => observedAt,
			}),
		});
		const page = await handlers.approvals(
			{
				params: {},
				query: { statuses: ["pending"], limit: 1 },
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebApprovalPageSchema, page), true);
		assert.equal(page.items.length, 1);
		assert.equal(
			page.items[0]?.expectedRunVersion,
			parked.run?.runVersion,
		);
		assert.equal(
			page.items[0]?.nodeInstanceId,
			"review",
		);
		assert.ok(
			page.items[0]?.availableActions.some(
				(action) => action.kind === "approve",
			),
		);
		const detail = await handlers.approvalDetail(
			{
				params: {
					projectId: host.projectId,
					controlDomainId: host.controlDomainId,
					runId,
					approvalRequestId:
						parked.run!.approvalRequestId!,
				},
				query: {},
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebApprovalDetailSchema, detail), true);
		assert.equal(detail.decisionRaceState, "open");
		assert.equal(detail.operationClass, "generic-action");
		assert.equal(
			detail.boundPlanHash,
			parked.run!.boundPlanHash,
		);
		assert.equal(
			detail.decisionPresentation?.operationClass,
			"generic-action",
		);
		assert.deepEqual(
			detail.availableActions
				.map((action) => action.kind)
				.sort(),
			["approve", "reject", "cancel-run"].sort(),
		);
		const attention = await handlers.attention(
			{
				params: {},
				query: {
					dispositions: ["needs-user-input"],
					limit: 1,
				},
				body: {},
			},
			context,
		);
		assert.equal(Value.Check(WebAttentionPageSchema, attention), true);
		assert.equal(attention.items.length, 1);
		assert.equal(attention.items[0]?.runId, runId);
		assert.equal(
			attention.items[0]?.disposition,
			"needs-user-input",
		);
		assert.equal(
			attention.items[0]?.message.key,
			"attention.decision-required",
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("aggregate overview reports a missing registered store as partial and unverified", () => {
	const temp = tempWorkspace();
	const second = path.join(temp.root, "second");
	fs.mkdirSync(second, { recursive: true });
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "auto",
		skipSingleton: true,
		allowMockProvider: true,
		env: temp.env,
	});
	try {
		const secondStore = openProjectControlStore(second);
		host.registry.registerFromStore(secondStore, second);
		fs.rmSync(second, { recursive: true, force: true });
		const service = createInitialWebReadService(host, {
			now: () => 1_800_000_000_000,
		});
		const overview = service.readOverview();
		assert.equal(Value.Check(WebOverviewViewSchema, overview), true);
		assert.equal(overview.sourceObservation.coverage, "partial");
		assert.equal(overview.sourceObservation.authority, "unverified");
		assert.equal(overview.projectHealth.healthy, 1);
		assert.equal(overview.projectHealth.unavailable, 1);
		assert.equal(overview.projectHealth.warnings[0]?.code, "missing");
		const attention = service.readAttention(
			{ limit: 50 },
			handlerContext(1_800_000_000_000),
		);
		assert.equal(Value.Check(WebAttentionPageSchema, attention), true);
		assert.equal(
			attention.items.find(
				(item) => item.kind === "project-unavailable",
			)?.message.key,
			"attention.project-unavailable",
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("aggregate snapshot cache reuses unchanged watermarks and invalidates on commit", () => {
	const temp = tempWorkspace();
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		env: temp.env,
	});
	let observedAt = 1_000;
	try {
		const service = createInitialWebReadService(host, {
			now: () => observedAt,
			snapshotCacheMs: 10 * 60_000,
			resolveHost: (projectId, controlDomainId) =>
				projectId === host.projectId &&
				controlDomainId === host.controlDomainId
					? host
					: null,
		});
		const first = service.readOverview();
		observedAt = 2_000;
		const unchanged = service.readOverview();
		assert.equal(
			unchanged.sourceObservation.observedAt,
			first.sourceObservation.observedAt,
		);

		const event: ControlEvent = {
			eventId: "event-cache-invalidation",
			schemaVersion: 1,
			controlDomainId: host.controlDomainId,
			streamId: "stream-cache-invalidation",
			streamSeq: 0,
			commitSeq: 0,
			projectId: host.projectId,
			recordedAt: observedAt,
			payload: {
				type: "Generic",
				kind: "CacheInvalidation",
			},
		};
		host.store.commit({ events: [event] });
		const changed = service.readOverview();
		assert.equal(
			changed.sourceObservation.observedAt,
			observedAt,
		);
		assert.ok(
			changed.sourceObservation.watermarks[0]!
				.nextCommitSeq >
				first.sourceObservation.watermarks[0]!
					.nextCommitSeq,
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("missing reservation becomes a typed read-service failure for envelope mapping", () => {
	const temp = tempWorkspace();
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		env: temp.env,
	});
	try {
		const service = createInitialWebReadService(host);
		assert.throws(
			() => service.readReservationDetail("rsv-missing"),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code === "TF_NOT_FOUND" &&
				error.controlError.recoveryAction === "refresh",
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});
