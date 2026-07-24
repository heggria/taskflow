import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	WEB_IMPLEMENTED_ANALYSIS_HANDLER_IDS,
	createWebAnalysisHandlers,
} from "../src/web-analysis-service.ts";
import { createControlHost } from "../src/control-host.ts";
import {
	createMockExecutionProvider,
	type ExecutionProvider,
} from "../src/provider.ts";
import { createWebCursorCodec } from "../src/web-cursor.ts";
import {
	WebRecomputePreviewSchema,
	type WebHandlerContext,
} from "../src/web-protocol.ts";
import { WebReadServiceError } from "../src/web-read-service.ts";

function context(observedAt: number): WebHandlerContext {
	return {
		requestId: "request-analysis",
		listenerId: "listener-analysis",
		principalId: "principal-analysis",
		principalDisplayName: "Local user",
		principalHash: `sha256:${"e".repeat(64)}`,
		observedAt,
		sessionAbsoluteExpiresAt: observedAt + 60_000,
	};
}

test("recompute preview is transitive, bounded, and performs zero provider calls/writes", async () => {
	assert.deepEqual(WEB_IMPLEMENTED_ANALYSIS_HANDLER_IDS, [
		"runRecomputePreview",
	]);
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-analysis-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const base = createMockExecutionProvider({
		outcome: "completed",
		output: "done",
	});
	let providerCalls = 0;
	const provider: ExecutionProvider = {
		...base,
		async submit(request) {
			providerCalls += 1;
			return base.submit(request);
		},
	};
	const host = createControlHost({
		projectRoot: project,
		controlMode: "standalone",
		skipSingleton: true,
		scriptProvider: provider,
		env: { ...process.env, TASKFLOW_HOME: home },
	});
	try {
		const admitted = await host.admitAndRun({
			commandId: "cmd-analysis-source",
			callerPrincipal: "principal-analysis",
			program: {
				name: "analysis-source",
				phases: [
					{
						id: "a",
						type: "script",
						run: "a",
					},
					{
						id: "b",
						type: "script",
						run: "b",
						dependsOn: ["a"],
					},
					{
						id: "c",
						type: "script",
						run: "c",
						dependsOn: ["b"],
						final: true,
					},
				],
			},
		});
		assert.equal(admitted.ok, true);
		assert.ok(admitted.run);
		providerCalls = 0;
		const beforeCommitSeq =
			host.store.nextCommitSeq();
		const observedAt = Date.now();
		const handlers = createWebAnalysisHandlers(host, {
			cursorCodec: createWebCursorCodec({
				key: Buffer.alloc(32, 43),
				listenerId: "listener-analysis",
			}),
		});
		const preview =
			await handlers.runRecomputePreview(
				{
					params: {
						projectId: host.projectId,
						controlDomainId:
							host.controlDomainId,
						runId: admitted.run.runId,
					},
					query: {},
					body: {
						expectedRunVersion:
							admitted.run.runVersion,
						phaseIds: ["a"],
					},
				},
				context(observedAt),
			);
		assert.equal(
			Value.Check(
				WebRecomputePreviewSchema,
				preview,
			),
			true,
		);
		assert.deepEqual(preview.requestedPhaseIds, ["a"]);
		assert.deepEqual(preview.affectedPhaseIds, [
			"a",
			"b",
			"c",
		]);
		assert.deepEqual(
			preview.affectedNodeInstanceIds,
			["a", "b", "c"],
		);
		assert.equal(preview.reAdmissionRequired, true);
		assert.equal(providerCalls, 0);
		assert.equal(
			host.store.nextCommitSeq(),
			beforeCommitSeq,
		);
		assert.ok(admitted.run);
		const admittedRun = admitted.run;

		await assert.rejects(
			async () =>
				handlers.runRecomputePreview(
					{
						params: {
							projectId: host.projectId,
							controlDomainId:
								host.controlDomainId,
							runId: admittedRun.runId,
						},
						query: {},
						body: {
							expectedRunVersion:
								admittedRun.runVersion -
								1,
							phaseIds: ["a"],
						},
					},
					context(observedAt),
				),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code ===
					"TF_STALE_VERSION",
		);
		assert.equal(providerCalls, 0);
		assert.equal(
			host.store.nextCommitSeq(),
			beforeCommitSeq,
		);
	} finally {
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
