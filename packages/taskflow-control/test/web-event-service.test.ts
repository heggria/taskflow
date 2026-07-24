import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { createControlHost } from "../src/control-host.ts";
import {
	advanceMinAvailable,
	loadCompactionState,
	noteCommitSeq,
} from "../src/compaction.ts";
import { sha256Hex, stableStringify } from "../src/hash.ts";
import {
	WEB_IMPLEMENTED_EVENT_HANDLER_IDS,
	createWebEventHandlers,
} from "../src/web-event-service.ts";
import { createWebCursorCodec } from "../src/web-cursor.ts";
import { WebReadServiceError } from "../src/web-read-service.ts";
import {
	WebStreamFrameSchema,
	type WebHandlerContext,
	type WebProjectWatermark,
	type WebStreamFrame,
} from "../src/web-protocol.ts";
import type { ControlEvent } from "../src/types.ts";

function context(observedAt: number): WebHandlerContext {
	return {
		requestId: "request-events",
		listenerId: "listener-events",
		principalId: "principal-events",
		principalDisplayName: "Local user",
		principalHash: `sha256:${"f".repeat(64)}`,
		observedAt,
		sessionAbsoluteExpiresAt: observedAt + 60_000,
	};
}

async function firstStreamFrame(
	handlers: ReturnType<typeof createWebEventHandlers>,
	query: { cursor?: string; projectIds?: string[] },
	requestContext: WebHandlerContext,
) {
	const stream = await handlers.events(
		{ params: {}, query, body: {} },
		requestContext,
	);
	return stream[Symbol.asyncIterator]().next();
}

async function assertStreamFailure(
	handlers: ReturnType<typeof createWebEventHandlers>,
	query: { cursor?: string; projectIds?: string[] },
	requestContext: WebHandlerContext,
	code: "TF_INVALID_ARGUMENT" | "TF_CURSOR_EXPIRED",
): Promise<void> {
	await assert.rejects(
		() => firstStreamFrame(handlers, query, requestContext),
		(error: unknown) =>
			error instanceof WebReadServiceError &&
			error.controlError.code === code,
	);
}

test("event stream checkpoints, resumes, and advances a signed watermark without writes", async () => {
	assert.deepEqual(WEB_IMPLEMENTED_EVENT_HANDLER_IDS, [
		"events",
	]);
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-events-"),
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
	try {
		const observedAt = Date.now();
		const codec = createWebCursorCodec({
			key: Buffer.alloc(32, 47),
			listenerId: "listener-events",
		});
		const handlers = createWebEventHandlers(host, {
			cursorCodec: codec,
			pollIntervalMs: 10,
			heartbeatMs: 50,
		});
		const stream = await handlers.events(
			{
				params: {},
				query: {},
				body: {},
			},
			context(observedAt),
		);
		const iterator = stream[Symbol.asyncIterator]();
		const first = await iterator.next();
		assert.equal(first.done, false);
		assert.equal(
			Value.Check(WebStreamFrameSchema, first.value),
			true,
		);
		assert.equal(first.value?.type, "checkpoint");
		if (
			!first.value ||
			first.value.type !== "checkpoint"
		) {
			return;
		}
		const beforeReadCommitSeq =
			host.store.nextCommitSeq();
		assert.equal(
			first.value.projectWatermarks[0]
				?.nextCommitSeq,
			beforeReadCommitSeq,
		);
		assert.equal(
			host.store.nextCommitSeq(),
			beforeReadCommitSeq,
		);
		await iterator.return?.();

		const event: ControlEvent = {
			eventId: "event-after-checkpoint",
			schemaVersion: 1,
			controlDomainId: host.controlDomainId,
			streamId: "stream-events",
			streamSeq: 0,
			commitSeq: 0,
			projectId: host.projectId,
			recordedAt: Date.now(),
			payload: {
				type: "Generic",
				kind: "EventStreamTestCommit",
			},
		};
		host.store.commit({ events: [event] });
		const afterCommitSeq = host.store.nextCommitSeq();

		const resumed = await handlers.events(
			{
				params: {},
				query: { cursor: first.value.cursor },
				body: {},
			},
			context(observedAt),
		);
		const resumedIterator =
			resumed[Symbol.asyncIterator]();
		const resumedCheckpoint =
			await resumedIterator.next();
		assert.equal(
			resumedCheckpoint.value?.type,
			"checkpoint",
		);
		const change = await resumedIterator.next();
		assert.equal(change.done, false);
		assert.equal(change.value?.type, "change");
		if (!change.value || change.value.type !== "change") {
			return;
		}
		assert.equal(change.value.kind, "invalidated");
		assert.equal(
			change.value.resourceType,
			"project",
		);
		assert.equal(change.value.projectId, host.projectId);
		assert.equal(
			change.value.commitSeq,
			afterCommitSeq - 1,
		);
			const registryContext: {
				mode: "standalone";
				registryRevision: "standalone";
				visibleMounts: [
					{
						projectId: string;
						controlDomainId: string;
					},
				];
			} = {
				mode: "standalone",
				registryRevision: "standalone",
				visibleMounts: [
				{
					projectId: host.projectId,
					controlDomainId: host.controlDomainId,
				},
				],
			};
		const decoded = codec.decodeStream(
			change.value.cursor,
			{
				listenerId: "listener-events",
				principalHash: context(observedAt)
					.principalHash,
				registryContext,
					visibleMountsHash: `sha256:${sha256Hex(
						stableStringify(
							registryContext.visibleMounts,
						),
					)}`,
					projectWatermarks:
						first.value.projectWatermarks.map(
							(watermark) => ({
								...watermark,
								nextCommitSeq:
									afterCommitSeq,
							}),
						),
				},
			);
		assert.equal(
			decoded.projectWatermarks[0]
				?.nextCommitSeq,
			afterCommitSeq,
		);
		await resumedIterator.return?.();
	} finally {
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("event stream wakes on an atomic commit without waiting for the fallback poll", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-events-wakeup-"),
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
	let iterator:
		| AsyncIterator<WebStreamFrame>
		| undefined;
	try {
		const observedAt = Date.now();
		const handlers = createWebEventHandlers(host, {
			cursorCodec: createWebCursorCodec({
				key: Buffer.alloc(32, 73),
				listenerId: "listener-events",
			}),
			pollIntervalMs: 10_000,
			heartbeatMs: 10_000,
			listHosts: () => [host],
		});
		const stream = await handlers.events(
			{ params: {}, query: {}, body: {} },
			context(observedAt),
		);
		iterator = stream[Symbol.asyncIterator]();
		assert.equal((await iterator.next()).value?.type, "checkpoint");
		const nextFrame = iterator.next();
		await new Promise<void>((resolve) =>
			setImmediate(resolve),
		);

		host.store.commit({
			events: [
				{
					eventId: "event-wakeup",
					schemaVersion: 1,
					controlDomainId: host.controlDomainId,
					streamId: "stream-wakeup",
					streamSeq: 0,
					commitSeq: 0,
					projectId: host.projectId,
					recordedAt: Date.now(),
					payload: {
						type: "Generic",
						kind: "WakeupTestCommit",
					},
				},
			],
		});
		const change = await Promise.race([
			nextFrame,
			new Promise<never>((_, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								"commit watcher did not wake the event stream",
							),
						),
					2_000,
				);
				timer.unref();
			}),
		]);
		assert.equal(change.value?.type, "change");
	} finally {
		await iterator?.return?.();
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("event cursor matrix closes restart, query, authorization, mount, key, and compaction axes", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-events-matrix-"),
	);
	const home = path.join(root, "home");
	const projectA = path.join(root, "project-a");
	const projectB = path.join(root, "project-b");
	const projectC = path.join(root, "project-c");
	for (const directory of [home, projectA, projectB, projectC]) {
		fs.mkdirSync(directory, { recursive: true });
	}
	const env = { ...process.env, TASKFLOW_HOME: home };
	const hostA = createControlHost({
		projectRoot: projectA,
		controlMode: "auto",
		skipSingleton: true,
		allowMockProvider: true,
		env,
	});
	const hostB = createControlHost({
		projectRoot: projectB,
		controlMode: "auto",
		skipSingleton: true,
		allowMockProvider: true,
		env,
	});
	let hostC: ReturnType<typeof createControlHost> | undefined;
	try {
		const observedAt = Date.now();
		const requestContext = context(observedAt);
		const key = Buffer.alloc(32, 49);
		const options = {
			cursorCodec: createWebCursorCodec({
				key,
				listenerId: requestContext.listenerId,
			}),
			pollIntervalMs: 10,
			heartbeatMs: 20,
			listHosts: () => [hostA, hostB],
		};
		const handlers = createWebEventHandlers(hostA, options);
		const queryA = { projectIds: [hostA.projectId] };
		const initial = await firstStreamFrame(
			handlers,
			queryA,
			requestContext,
		);
		assert.equal(initial.value?.type, "checkpoint");
		if (!initial.value || initial.value.type !== "checkpoint") {
			return;
		}
		assert.deepEqual(
			initial.value.projectWatermarks.map(
				(watermark: WebProjectWatermark) =>
					watermark.projectId,
			),
			[hostA.projectId],
		);

		const restarted = createWebEventHandlers(
			hostA,
			options,
		);
		const afterRestart = await firstStreamFrame(
			restarted,
			{
				...queryA,
				cursor: initial.value.cursor,
			},
			requestContext,
		);
		assert.equal(afterRestart.value?.type, "checkpoint");

		await assertStreamFailure(
			restarted,
			{
				projectIds: [hostB.projectId],
				cursor: initial.value.cursor,
			},
			requestContext,
			"TF_CURSOR_EXPIRED",
		);
		await assertStreamFailure(
			restarted,
			{
				...queryA,
				cursor: initial.value.cursor,
			},
			{
				...requestContext,
				principalHash: `sha256:${"e".repeat(64)}`,
			},
			"TF_CURSOR_EXPIRED",
		);

		const rotatedListenerContext = {
			...requestContext,
			listenerId: "listener-events-rotated",
		};
		const rotatedListener = createWebEventHandlers(
			hostA,
			{
				...options,
				cursorCodec: createWebCursorCodec({
					key,
					listenerId:
						rotatedListenerContext.listenerId,
				}),
			},
		);
		await assertStreamFailure(
			rotatedListener,
			{
				...queryA,
				cursor: initial.value.cursor,
			},
			rotatedListenerContext,
			"TF_CURSOR_EXPIRED",
		);

		const rotatedKey = createWebEventHandlers(hostA, {
			...options,
			cursorCodec: createWebCursorCodec({
				key: Buffer.alloc(32, 50),
				listenerId: requestContext.listenerId,
			}),
		});
		await assertStreamFailure(
			rotatedKey,
			{
				...queryA,
				cursor: initial.value.cursor,
			},
			requestContext,
			"TF_INVALID_ARGUMENT",
		);

		hostC = createControlHost({
			projectRoot: projectC,
			controlMode: "auto",
			skipSingleton: true,
			allowMockProvider: true,
			env,
		});
		await assertStreamFailure(
			restarted,
			{
				...queryA,
				cursor: initial.value.cursor,
			},
			requestContext,
			"TF_CURSOR_EXPIRED",
		);

		const current = await firstStreamFrame(
			restarted,
			queryA,
			requestContext,
		);
		assert.equal(current.value?.type, "checkpoint");
		if (!current.value || current.value.type !== "checkpoint") {
			return;
		}
		for (const ordinal of [0, 1]) {
			const event: ControlEvent = {
				eventId: `event-cursor-matrix-${ordinal}`,
				schemaVersion: 1,
				controlDomainId: hostA.controlDomainId,
				streamId: "stream-cursor-matrix",
				streamSeq: ordinal,
				commitSeq: 0,
				projectId: hostA.projectId,
				recordedAt: Date.now(),
				payload: {
					type: "Generic",
					kind: `CursorMatrix${ordinal}`,
				},
			};
			hostA.store.commit({ events: [event] });
		}
		noteCommitSeq(
			projectA,
			hostA.store.nextCommitSeq() - 1,
		);
		const compaction = loadCompactionState(projectA);
		const advanced = advanceMinAvailable(
			projectA,
			compaction.maxCommitSeq,
		);
		assert.equal("error" in advanced, false);
		const compacted = await firstStreamFrame(
			restarted,
			{
				...queryA,
				cursor: current.value.cursor,
			},
			requestContext,
		);
		assert.equal(compacted.value?.type, "reset-required");
		if (compacted.value?.type === "reset-required") {
			assert.equal(
				compacted.value.error.code,
				"TF_CURSOR_EXPIRED",
			);
		}
	} finally {
		hostC?.close();
		hostB.close();
		hostA.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("event stream survives handler restart, heartbeats, and resets after compaction", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-events-restart-"),
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
	try {
		const observedAt = Date.now();
		const codec = createWebCursorCodec({
			key: Buffer.alloc(32, 48),
			listenerId: "listener-events",
		});
		const options = {
			cursorCodec: codec,
			pollIntervalMs: 10,
			heartbeatMs: 20,
		};
		const firstHandlers = createWebEventHandlers(
			host,
			options,
		);
		const firstStream = await firstHandlers.events(
			{ params: {}, query: {}, body: {} },
			context(observedAt),
		);
		const firstIterator =
			firstStream[Symbol.asyncIterator]();
		const checkpoint = await firstIterator.next();
		assert.equal(checkpoint.value?.type, "checkpoint");
		if (
			!checkpoint.value ||
			checkpoint.value.type !== "checkpoint"
		) {
			return;
		}
		const heartbeat = await firstIterator.next();
		assert.equal(heartbeat.value?.type, "heartbeat");
		await firstIterator.return?.();

		// Reconstructing the pure handler with the same listener key models a
		// daemon adapter restart without changing cursor authority.
		const restartedHandlers = createWebEventHandlers(
			host,
			options,
		);
		const restarted = await restartedHandlers.events(
			{
				params: {},
				query: { cursor: checkpoint.value.cursor },
				body: {},
			},
			context(observedAt),
		);
		const restartedIterator =
			restarted[Symbol.asyncIterator]();
		const restartedCheckpoint =
			await restartedIterator.next();
		assert.equal(
			restartedCheckpoint.value?.type,
			"checkpoint",
		);
		await restartedIterator.return?.();

		const event: ControlEvent = {
			eventId: "event-compacted-after-checkpoint",
			schemaVersion: 1,
			controlDomainId: host.controlDomainId,
			streamId: "stream-compaction",
			streamSeq: 0,
			commitSeq: 0,
			projectId: host.projectId,
			recordedAt: Date.now(),
			payload: {
				type: "Generic",
				kind: "CompactionAfterCheckpoint",
			},
		};
		host.store.commit({ events: [event] });
		noteCommitSeq(
			project,
			host.store.nextCommitSeq() - 1,
		);
		const compaction = loadCompactionState(project);
		assert.ok(compaction.maxCommitSeq >= 1);
		const advanced = advanceMinAvailable(
			project,
			compaction.maxCommitSeq,
		);
		assert.equal("error" in advanced, false);

		const expired = await restartedHandlers.events(
			{
				params: {},
				query: { cursor: checkpoint.value.cursor },
				body: {},
			},
			context(observedAt),
		);
		const expiredFrame =
			await expired[Symbol.asyncIterator]().next();
		assert.equal(
			expiredFrame.value?.type,
			"reset-required",
		);
		if (
			expiredFrame.value?.type === "reset-required"
		) {
			assert.equal(
				expiredFrame.value.error.code,
				"TF_CURSOR_EXPIRED",
			);
			assert.equal(
				expiredFrame.value.error.recoveryAction,
				"refresh",
			);
		}
	} finally {
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
