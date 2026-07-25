/**
 * P7 BoundFragment dual hashes + D21 control-plane authority surface checks.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	bindControlHostTools,
	bindFragment,
	bootstrapControl,
	createControlHost,
	createHostLlmExecutionProvider,
	createScriptExecutionProvider,
	fragmentSemanticMatch,
	hashBoundFragment,
	inspectProjectControlStore,
	projectBoundFragmentLinksDir,
	projectBoundFragmentsDir,
} from "../src/index.ts";

const fragA = {
	name: "dyn",
	phases: [{ id: "n1", type: "script", run: "echo a", final: true }],
};
const fragB = {
	name: "dyn",
	phases: [{ id: "n1", type: "script", run: "echo b", final: true }],
};

test("P7 BoundFragment: dual hashes; semantic change changes both; reuse gate", () => {
	const a = bindFragment({ fragment: fragA, parentBoundPlanHash: "bp:parent1" });
	assert.match(a.boundFragmentHash, /^bf:[0-9a-f]{64}$/);
	assert.match(a.executionSemanticHash, /^es:[0-9a-f]{64}$/);

	const a2 = bindFragment({ fragment: fragA, parentBoundPlanHash: "bp:parent1" });
	assert.equal(a.boundFragmentHash, a2.boundFragmentHash);
	assert.equal(a.executionSemanticHash, a2.executionSemanticHash);
	assert.equal(fragmentSemanticMatch(a, a2), true);

	const b = bindFragment({ fragment: fragB, parentBoundPlanHash: "bp:parent1" });
	assert.notEqual(a.boundFragmentHash, b.boundFragmentHash);
	assert.notEqual(a.executionSemanticHash, b.executionSemanticHash);
	assert.equal(fragmentSemanticMatch(a, b), false);

	// Parent plan identity is part of reuse gate
	const otherParent = bindFragment({ fragment: fragA, parentBoundPlanHash: "bp:other" });
	assert.equal(fragmentSemanticMatch(a, otherParent), false);

	// raw hash helper agrees
	const h = hashBoundFragment(fragA, { parentBoundPlanHash: "bp:parent1" });
	assert.equal(h.boundFragmentHash, a.boundFragmentHash);
});

test("P7 dynamic path: ControlHost journals fragment body, link provenance, nodes, and recovery", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-bound-fragment-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	let placeholderLlmCalls = 0;
	const host = createControlHost({
		projectRoot: project,
		env: { ...process.env, TASKFLOW_HOME: home },
		controlMode: "standalone",
		skipSingleton: true,
		scriptProvider: createScriptExecutionProvider({
			stateDir: path.join(
				project,
				".taskflow",
				"control",
				"provider-jobs",
			),
		}),
		llmProvider: createHostLlmExecutionProvider({
			runTask: async () => {
				placeholderLlmCalls += 1;
				return {
					ok: true,
					output: "placeholder",
					exitCode: 0,
				};
			},
		}),
	});
	try {
		const result = await host.admitAndRun({
			commandId: "cmd-dynamic-fragment",
			program: {
				name: "dynamic",
				phases: [
					{
						id: "grow",
						type: "expand",
						expandMode: "graft",
						def: {
							name: "linked-fragment",
							phases: [
								{
									id: "child-a",
									type: "script",
									run: "printf a",
								},
								{
									id: "child-b",
									type: "script",
									run: "printf b",
									dependsOn: ["child-a"],
									final: true,
								},
							],
						},
						final: true,
					},
				],
			},
		});
		assert.equal(result.ok, true, JSON.stringify(result.error));
		assert.equal(
			placeholderLlmCalls,
			0,
			"expand must execute its linked children, not a placeholder LLM prompt",
		);
		assert.equal(result.run?.finalOutput, "b");
		assert.match(
			result.run?.boundFragmentHash ?? "",
			/^bf:[a-f0-9]{64}$/u,
		);
		assert.equal(
			result.receipt?.boundFragmentHash,
			result.run?.boundFragmentHash,
		);
		assert.equal(
			result.receipt?.assurance.provenance,
			"ok",
		);
		const linked = host.store.listBoundFragmentsForRun(
			result.run!.runId,
		);
		assert.equal(linked.length, 1);
		assert.deepEqual(
			{
				parent: linked[0]?.link.parentNodeInstanceId,
				origin: linked[0]?.link.originPhaseId,
				kind: linked[0]?.link.linkKind,
				dynamic: linked[0]?.link.dynamicNodeCount,
				static: linked[0]?.link.staticNodeCount,
			},
			{
				parent: "grow",
				origin: "grow",
				kind: "graft-promote",
				dynamic: 2,
				static: 2,
			},
		);
		assert.ok(
			(linked[0]?.link.createdAtCommitSeq ?? 0) > 0,
		);
		assert.deepEqual(
			result.run?.nodes
				?.filter(
					(node) => node.origin === "bound-fragment",
				)
				.map((node) => [
					node.phaseId,
					node.boundFragmentHash,
					node.status,
				]),
			[
				[
					"child-a",
					result.run?.boundFragmentHash,
					"completed",
				],
				[
					"child-b",
					result.run?.boundFragmentHash,
					"completed",
				],
			],
		);
		assert.deepEqual(
			result.run?.attempts?.map((attempt) => ({
				nodeInstanceId:
					attempt.nodeInstanceId,
				status: attempt.status,
				provider: attempt.provider,
				providerJobHandlePresent:
					attempt.providerJobHandlePresent,
			})),
			[
				{
					nodeInstanceId:
						result.run?.nodes?.find(
							(node) =>
								node.phaseId ===
								"child-a",
						)?.nodeInstanceId,
					status: "completed",
					provider: "script",
					providerJobHandlePresent: true,
				},
				{
					nodeInstanceId:
						result.run?.nodes?.find(
							(node) =>
								node.phaseId ===
								"child-b",
						)?.nodeInstanceId,
					status: "completed",
					provider: "script",
					providerJobHandlePresent: true,
				},
				{
					nodeInstanceId: "grow",
					status: "completed",
					provider: undefined,
					providerJobHandlePresent: false,
				},
			],
		);

		for (const directory of [
			projectBoundFragmentsDir(project),
			projectBoundFragmentLinksDir(project),
		]) {
			for (const file of fs.readdirSync(directory)) {
				fs.unlinkSync(path.join(directory, file));
			}
		}
		const recovery = host.store.recoverFromJournal();
		assert.equal(recovery.rebuiltBoundFragments, 1);
		assert.equal(recovery.rebuiltBoundFragmentLinks, 1);
		const inspected = inspectProjectControlStore(project, {
			projectId: host.projectId,
			controlDomainId: host.controlDomainId,
		});
		assert.equal(inspected.ok, true);
		if (!inspected.ok) return;
		assert.equal(inspected.snapshot.boundFragments.length, 1);
		assert.equal(
			inspected.snapshot.boundFragmentLinks.length,
			1,
		);
	} finally {
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("P7 dynamic path: nested descendant failure blocks the parent and Receipt", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-bound-fragment-fail-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	const leaked = path.join(project, "must-not-run");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const host = createControlHost({
		projectRoot: project,
		env: { ...process.env, TASKFLOW_HOME: home },
		controlMode: "standalone",
		skipSingleton: true,
		scriptProvider: createScriptExecutionProvider({
			stateDir: path.join(
				project,
				".taskflow",
				"control",
				"provider-jobs",
			),
		}),
	});
	try {
		const result = await host.admitAndRun({
			commandId: "cmd-dynamic-fragment-fail",
			program: {
				name: "dynamic-failure",
				phases: [
					{
						id: "grow",
						type: "expand",
						expandMode: "nested",
						def: {
							name: "nested-fragment",
							phases: [
								{
									id: "real-failure",
									type: "script",
									run: "exit 29",
								},
								{
									id: "must-not-run",
									type: "script",
									dependsOn: [
										"real-failure",
									],
									run: `printf leaked > "${leaked}"`,
									final: true,
								},
							],
						},
						final: true,
					},
				],
			},
		});
		assert.equal(result.ok, false);
		assert.equal(result.receipt, undefined);
		assert.equal(result.run?.status, "failed");
		assert.equal(fs.existsSync(leaked), false);
		assert.deepEqual(
			result.run?.nodes
				?.filter(
					(node) =>
						node.origin ===
						"bound-fragment",
				)
				.map((node) => [
					node.phaseId,
					node.status,
				]),
			[
				["real-failure", "failed"],
				["must-not-run", "blocked"],
			],
		);
		assert.equal(
			host.store.getReceiptForRun(
				result.run!.runId,
			),
			null,
		);
	} finally {
		host.close();
		fs.rmSync(root, {
			recursive: true,
			force: true,
		});
	}
});

test("P7 dynamic path: settled descendants survive approval restart without replay", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-bound-fragment-approval-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	const beforeMarker = path.join(project, "before");
	const afterMarker = path.join(project, "after");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const env = { ...process.env, TASKFLOW_HOME: home };
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		host = createControlHost({
			projectRoot: project,
			env,
			controlMode: "standalone",
			skipSingleton: true,
		});
		const parked = await host.admitAndRun({
			commandId: "cmd-dynamic-approval-admit",
			program: {
				name: "dynamic-before-approval",
				phases: [
					{
						id: "grow",
						type: "expand",
						expandMode: "graft",
						def: {
							name: "before-fragment",
							phases: [
								{
									id: "before",
									type: "script",
									run: `test ! -e "${beforeMarker}" && printf once > "${beforeMarker}" && printf before`,
									final: true,
								},
							],
						},
					},
					{
						id: "review",
						type: "approval",
						dependsOn: ["grow"],
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
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		assert.equal(parked.run?.status, "paused");
		assert.equal(parked.run?.stage, "parked");
		const runId = parked.run!.runId;
		const expectedRunVersion = parked.run!.runVersion;
		const approvalRequestId =
			parked.run!.approvalRequestId!;
		host.close();
		host = createControlHost({
			projectRoot: project,
			env,
			controlMode: "standalone",
			skipSingleton: true,
		});
		const completed = await host.approve(runId, {
			commandId: "cmd-dynamic-approval-approve",
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
			completed.run?.nodes
				?.filter(
					(node) =>
						node.origin ===
						"bound-fragment",
				)
				.map((node) => [
					node.phaseId,
					node.status,
					node.attemptCount,
				]),
			[["before", "completed", 1]],
		);
		assert.equal(
			completed.receipt?.assurance.provenance,
			"ok",
		);
		assert.equal(
			host.store.listBoundFragmentsForRun(runId).length,
			1,
			"approval continuation must reuse the exact linked fragment",
		);
		const dynamicNodeInstanceId =
			completed.run?.nodes?.find(
				(node) => node.phaseId === "before",
			)?.nodeInstanceId;
		const events = host.store.readEvents(
			1,
			host.store.nextCommitSeq(),
		);
		assert.equal(
			events.filter(
				(event) =>
					event.payload.type ===
					"BoundFragmentLinked",
			).length,
			1,
			"approval continuation must not append a duplicate fragment link",
		);
		assert.ok(
			events.some((event) => {
				const payload = event.payload as {
					type?: string;
					kind?: string;
					data?: {
						nodeInstanceId?: string;
					};
				};
				return (
					payload.type === "Generic" &&
					payload.kind ===
						"PhaseAttemptStarted" &&
					payload.data?.nodeInstanceId ===
						dynamicNodeInstanceId
				);
			}),
			"dynamic provider checkpoints must use the durable NodeInstance id",
		);
	} finally {
		host?.close();
		fs.rmSync(root, {
			recursive: true,
			force: true,
		});
	}
});

test("D21: CLI/daemon bootstrap + MCP bind use ControlHost; production default is script not mock", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-d21-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-d21-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		// bootstrap standalone → ControlHost with script default
		const { host, role } = bootstrapControl({
			projectRoot: project,
			env,
			controlMode: "standalone",
		});
		assert.equal(role, "standalone-local");
		assert.equal(typeof host.admitAndRun, "function");
		assert.equal(typeof host.getSnapshot, "function");
		assert.equal(host.canMutate, true);

		// Production default: no allowMockProvider → real script provider path
		const r = await host.admitAndRun({
			program: {
				name: "d21",
				phases: [{ id: "main", type: "script", run: "echo d21-ok", final: true }],
			},
			commandId: "d21-cmd",
		});
		assert.equal(r.ok, true, JSON.stringify(r.error));
		assert.equal(r.run?.providerName, "script");
		assert.match(r.run?.finalOutput ?? "", /d21-ok/);
		assert.ok(r.receipt);

		// Same surface via MCP bind tools
		const host2 = createControlHost({
			projectRoot: project,
			env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createScriptExecutionProvider({
				stateDir: path.join(project, ".taskflow", "control", "provider-jobs-2"),
			}),
		});
		const tools = bindControlHostTools(host2);
		assert.equal(typeof tools.run, "function");
		assert.equal(typeof tools.approve, "function");
		assert.equal(typeof tools.edit, "function");
		const fail = await tools.run({
			define: {
				name: "f",
				phases: [{ id: "main", type: "script", run: "exit 37", final: true }],
			},
			commandId: "d21-fail",
		});
		assert.equal(fail.ok, false);
		assert.equal(fail.run?.status, "failed");
		assert.equal(fail.receipt, undefined);

		host.close();
		host2.close();
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("D21: event-kernel remains opt-in OFF by default (no silent dual scheduler in control plane)", async () => {
	// Control plane does not import/run event-kernel. Prove core default OFF via env contract.
	assert.notEqual(process.env.PI_TASKFLOW_EVENT_KERNEL, "1");
	// Dynamic import of core driver for documentation of default
	const driverPath = path.resolve(
		process.cwd(),
		"packages/taskflow-core/src/exec/driver.ts",
	);
	const src = fs.readFileSync(driverPath, "utf-8");
	assert.match(src, /Default OFF/);
	assert.match(src, /PI_TASKFLOW_EVENT_KERNEL=1/);
});
