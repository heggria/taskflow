import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	createControlHost,
	createMockExecutionProvider,
	createWebReplayHandlers,
	WebReadServiceError,
	WebReplayResultSchema,
	type ExecutionProvider,
	type WebHandlerContext,
} from "../src/index.ts";

function context(): WebHandlerContext {
	return {
		requestId: "request-replay",
		listenerId: "listener-replay",
		principalId: "principal-replay",
		principalDisplayName: "Replay Tester",
		principalHash: `sha256:${"b".repeat(64)}`,
		observedAt: 1_800_000_000_000,
		sessionAbsoluteExpiresAt: 1_800_028_800_000,
	};
}

test("Web replay uses the current trace artifact with zero provider calls and zero durable writes", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-replay-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const base = createMockExecutionProvider({
		outcome: "completed",
		output: "recorded-output",
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
			commandId: "cmd-replay-source",
			program: {
				name: "replay-source",
				phases: [
					{
						id: "filter",
						type: "script",
						run: "filter",
						when: "true",
					},
					{
						id: "consumer",
						type: "script",
						run: "consumer",
						dependsOn: ["filter"],
						final: true,
					},
				],
			},
		});
		assert.equal(admitted.ok, true);
		assert.ok(admitted.run);
		assert.ok(admitted.receipt);
		const trace = admitted.receipt!.artifactRefs
			.map((artifactId) =>
				host.store.getArtifact(artifactId),
			)
			.find(
				(artifact) =>
					artifact?.role === "replay-trace",
			);
		assert.ok(trace);
		providerCalls = 0;
		const beforeCommitSeq = host.store.nextCommitSeq();
		const handlers = createWebReplayHandlers(host);
		const input = {
			params: {
				projectId: host.projectId,
				controlDomainId: host.controlDomainId,
				runId: admitted.run!.runId,
			},
			query: {},
			body: {
				traceArtifactDigest: trace!.digest,
				overrides: [
					{
						targetId: "filter",
						kind: "condition-result" as const,
						value: false,
					},
				],
			},
		};
		const result = await handlers.runReplay(
			input,
			context(),
		);
		assert.equal(
			Value.Check(WebReplayResultSchema, result),
			true,
		);
		assert.deepEqual(result.proof, {
			providerCalls: 0,
			durableWrites: 0,
		});
		assert.equal(providerCalls, 0);
		assert.equal(
			host.store.nextCommitSeq(),
			beforeCommitSeq,
		);
		assert.ok(
			result.decisionFold.some((decision) =>
				decision.includes('"outcome":"would-skip"'),
			),
		);
		assert.ok(
			result.unreplayableBranches.includes(
				"consumer",
			),
		);

		await assert.rejects(
			async () =>
				handlers.runReplay(
					{
						...input,
						body: {
							traceArtifactDigest: `sha256:${"f".repeat(64)}`,
							overrides: [],
						},
					},
					context(),
				),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code === "TF_NOT_FOUND",
		);
		await assert.rejects(
			async () =>
				handlers.runReplay(
					{
						...input,
						body: {
							...input.body,
							overrides: [
								input.body.overrides[0]!,
								input.body.overrides[0]!,
							],
						},
					},
					context(),
				),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code ===
					"TF_INVALID_ARGUMENT",
		);
	} finally {
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
