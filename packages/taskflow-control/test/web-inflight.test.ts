import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	createControlHost,
	type AdmitResult,
} from "../src/control-host.ts";
import type { ExecutionProvider } from "../src/provider.ts";
import { createWebCursorCodec } from "../src/web-cursor.ts";
import {
	WebRunDetailSchema,
	type WebHandlerContext,
} from "../src/web-protocol.ts";
import { createWebReadHandlers } from "../src/web-read-service.ts";

function context(observedAt: number): WebHandlerContext {
	return {
		requestId: "request-inflight",
		listenerId: "listener-inflight",
		principalId: "principal-inflight",
		principalDisplayName: "Local user",
		principalHash: `sha256:${"d".repeat(64)}`,
		observedAt,
		sessionAbsoluteExpiresAt: observedAt + 60_000,
	};
}

test("in-flight provider is inspectable and concurrent cancel cannot be overwritten as failure", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-inflight-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	let signalPollStarted: (() => void) | undefined;
	const pollStarted = new Promise<void>((resolve) => {
		signalPollStarted = resolve;
	});
	let settlePoll: (() => void) | undefined;
	const pollMaySettle = new Promise<void>((resolve) => {
		settlePoll = resolve;
	});
	let live = false;
	const provider: ExecutionProvider = {
		name: "gated-test-provider",
		async submit() {
			live = true;
			return {
				kind: "accepted",
				handle: "provider-job-inflight",
				leaseEpoch: 7,
			};
		},
		async poll() {
			signalPollStarted?.();
			await pollMaySettle;
			live = false;
			return {
				kind: "completed",
				output: "inflight-complete",
			};
		},
		async cancel() {
			live = false;
			settlePoll?.();
			return { kind: "cancelled" };
		},
		async reconcile() {
			return live
				? { kind: "running" }
				: {
						kind: "completed",
						output: "inflight-complete",
					};
		},
		isLive() {
			return live;
		},
	};
	const host = createControlHost({
		projectRoot: project,
		controlMode: "standalone",
		skipSingleton: true,
		scriptProvider: provider,
		env: { ...process.env, TASKFLOW_HOME: home },
	});
	let running: Promise<AdmitResult> | undefined;
	try {
		running = host.admitAndRun({
			commandId: "cmd-inflight",
			callerPrincipal: "principal-inflight",
			program: {
				name: "inflight",
				phases: [
					{
						id: "slow-step",
						type: "script",
						run: "ignored-by-gated-provider",
						final: true,
					},
				],
			},
		});
		await pollStarted;

		const durableRun = host.store.listRuns()[0];
		assert.ok(durableRun);
		assert.equal(durableRun.status, "running");
		assert.equal(durableRun.stage, "executing");
		assert.equal(
			durableRun.providerHandle,
			"provider-job-inflight",
		);
		assert.equal(durableRun.providerLeaseEpoch, 7);
		assert.deepEqual(
			durableRun.nodes?.map((node) => ({
				id: node.nodeInstanceId,
				status: node.status,
				attemptCount: node.attemptCount,
			})),
			[
				{
					id: "slow-step",
					status: "running",
					attemptCount: 1,
				},
			],
		);
		assert.deepEqual(
			durableRun.attempts?.map((attempt) => ({
				status: attempt.status,
				handle: attempt.providerJobHandlePresent,
			})),
			[
				{
					status: "still-running",
					handle: true,
				},
			],
		);
		assert.match(
			durableRun.attempts?.[0]?.attemptId ?? "",
			/^att_/u,
		);

		const observedAt = Date.now();
		const detail = await createWebReadHandlers(host, {
			cursorCodec: createWebCursorCodec({
				key: Buffer.alloc(32, 41),
				listenerId: "listener-inflight",
			}),
		}).runDetail(
			{
				params: {
					projectId: host.projectId,
					controlDomainId: host.controlDomainId,
					runId: durableRun.runId,
				},
				query: {},
				body: {},
			},
			context(observedAt),
		);
		assert.equal(Value.Check(WebRunDetailSchema, detail), true);
		assert.equal(detail.run.status, "running");
		assert.equal(detail.run.stage, "executing");
		assert.equal(detail.nodes[0]?.status, "running");
		assert.equal(
			detail.attempts[0]
				?.providerJobHandlePresent,
			true,
		);

		const cancel = host.cancel(durableRun.runId, {
			commandId: "cmd-inflight-cancel",
			principal: "principal-inflight",
			expectedRunVersion:
				host.store.getRun(durableRun.runId)!
					.runVersion,
		});
		const [cancelled, interruptedAdmission] =
			await Promise.all([cancel, running]);
		assert.equal(
			cancelled.ok,
			true,
			JSON.stringify(cancelled.error),
		);
		assert.equal(cancelled.run?.status, "cancelled");
		assert.equal(
			interruptedAdmission.run?.status,
			"cancelled",
		);
		assert.equal(
			host.store.getRun(durableRun.runId)?.status,
			"cancelled",
		);
		assert.equal(
			host.store.getRun(durableRun.runId)?.nodes?.[0]
				?.status,
			"cancelled",
		);
		const cancelledDetail =
			await createWebReadHandlers(host, {
				cursorCodec: createWebCursorCodec({
					key: Buffer.alloc(32, 42),
					listenerId: "listener-inflight",
				}),
			}).runDetail(
				{
					params: {
						projectId: host.projectId,
						controlDomainId:
							host.controlDomainId,
						runId: durableRun.runId,
					},
					query: {},
					body: {},
				},
				context(Date.now()),
			);
		assert.equal(
			Value.Check(
				WebRunDetailSchema,
				cancelledDetail,
			),
			true,
		);
		assert.equal(
			cancelledDetail.run.status,
			"cancelled",
		);
		assert.equal(
			cancelledDetail.nodes[0]?.status,
			"cancelled",
		);
	} finally {
		settlePoll?.();
		await running?.catch(() => undefined);
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
