import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { CacheStore } from "../src/cache.ts";
import { queueSpawn } from "../src/context-store.ts";
import { directoryIdentity, normalizeRelativePath, resolveCwdArg } from "../src/cwd-bridge.ts";
import { canUseEventKernel } from "../src/exec/driver.ts";
import type { RunResult } from "../src/host/runner-types.ts";
import { WriteIntentJournal } from "../src/resources/journal.ts";
import { executeTaskflow, recomputeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { validateTaskflow, type Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

function makeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-cwd-bridge-"));
	fs.mkdirSync(path.join(root, "packages", "api"), { recursive: true });
	fs.mkdirSync(path.join(root, "packages", "web"), { recursive: true });
	return root;
}

function state(def: Taskflow, root: string, args: Record<string, unknown>): RunState {
	return {
		runId: "cwd-bridge-run",
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: root,
	};
}

function success(agent: string, task: string, output = "ok"): RunResult {
	return { agent, task, exitCode: 0, output, stderr: "", usage: emptyUsage(), stopReason: "end" };
}

function bridgeDef(phases?: Taskflow["phases"]): Taskflow {
	return {
		name: "cwd-bridge",
		args: { package: { type: "relative-path", required: true } },
		phases: phases ?? [
			{ id: "work", type: "agent", agent: "a", task: "review", cwd: "{args.package}", final: true },
		],
	};
}

test("relative-path grammar accepts a portable subtree and rejects ambiguous/escaping forms", () => {
	assert.deepEqual(normalizeRelativePath("packages/api"), { ok: true, value: "packages/api" });
	for (const bad of ["", ".", "..", "a/../b", "a//b", "/tmp/x", "C:/x", "C:\\x", "\\\\server\\share", "a\\b", "a\0b", "a\nlog", "a\u001bescape", "CON", "COM¹", "x/LPT².txt", "x/NUL.txt", "a/late.", "a/late "]) {
		const result = normalizeRelativePath(bad);
		assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
	}
});

test("resolver anchors to invocation root, not process.cwd, and requires an existing directory", () => {
	const root = makeRoot();
	try {
		assert.notEqual(fs.realpathSync(root), fs.realpathSync(process.cwd()));
		const ok = resolveCwdArg(root, "package", "packages/api", "resolve-only");
		assert.equal(ok.ok, true);
		if (ok.ok) assert.equal(ok.value.absolutePath, fs.realpathSync(path.join(root, "packages/api")));

		for (const value of ["missing", "../outside"]) {
			const result = resolveCwdArg(root, "package", value, "resolve-only");
			assert.equal(result.ok, false);
		}
		fs.writeFileSync(path.join(root, "file.txt"), "x");
		assert.equal(resolveCwdArg(root, "package", "file.txt", "resolve-only").ok, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("resolver rejects a symlink escaping the invocation root and permits an in-root target", (t) => {
	if (process.platform === "win32") {
		t.skip("symlink creation requires platform-specific privileges");
		return;
	}
	const root = makeRoot();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-cwd-outside-"));
	try {
		fs.symlinkSync(outside, path.join(root, "escape"), "dir");
		assert.equal(resolveCwdArg(root, "package", "escape", "resolve-only").ok, false);
		fs.symlinkSync(path.join(root, "packages/api"), path.join(root, "inside"), "dir");
		const inside = resolveCwdArg(root, "package", "inside", "resolve-only");
		assert.equal(inside.ok, true);
		if (inside.ok) assert.equal(inside.value.absolutePath, fs.realpathSync(path.join(root, "packages/api")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("runtime fails closed before spawn unless the host explicitly enables resolve-only", async () => {
	const root = makeRoot();
	let calls = 0;
	try {
		const def = bridgeDef();
		const result = await executeTaskflow(state(def, root, { package: "packages/api" }), {
			cwd: root,
			agents: AGENTS,
			runTask: async (_cwd, _agents, agent, task) => {
				calls++;
				return success(agent, task);
			},
		});
		assert.equal(result.ok, false);
		assert.equal(calls, 0);
		assert.match(result.state.phases.work.error ?? "", /TF_CWD_BRIDGE_DISABLED/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a false when guard skips before cwd capability binding", async () => {
	const root = makeRoot();
	let calls = 0;
	try {
		const def = bridgeDef([
			{ id: "work", type: "agent", agent: "a", task: "never", cwd: "{args.package}", when: "1 == 2", final: true },
		]);
		const result = await executeTaskflow(state(def, root, { package: "missing" }), {
			cwd: root,
			agents: AGENTS,
			runTask: async (_cwd, _agents, agent, task) => {
				calls++;
				return success(agent, task);
			},
		});
		assert.equal(result.ok, true);
		assert.equal(result.state.phases.work.status, "skipped");
		assert.equal(calls, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("agent and script phases receive the same canonical argument-selected cwd", async () => {
	const root = makeRoot();
	let agentCwd = "";
	try {
		const def = bridgeDef([
			{ id: "agent", type: "agent", agent: "a", task: "review", cwd: "{args.package}" },
			{
				id: "script",
				type: "script",
				run: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
				cwd: "{args.package}",
				dependsOn: ["agent"],
				final: true,
			},
		]);
		const result = await executeTaskflow(state(def, root, { package: "packages/api" }), {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			runTask: async (cwd, _agents, agent, task, opts) => {
				agentCwd = opts.cwd ?? cwd;
				return success(agent, task);
			},
		});
		const expected = fs.realpathSync(path.join(root, "packages/api"));
		assert.equal(result.ok, true);
		assert.equal(agentCwd, expected);
		assert.equal(result.finalOutput, expected);
		assert.match(result.state.phases.agent.warnings?.join("\n") ?? "", /resolve-only/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("cwd bridge coordinates flat ctx_spawn descendants with independent durable intents", async () => {
	const root = makeRoot();
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-cwd-spawn-control-"));
	try {
		const def = bridgeDef([
			{
				id: "work",
				type: "agent",
				agent: "a",
				task: "parent",
				cwd: "{args.package}",
				shareContext: true,
				final: true,
			},
		]);
		let calls = 0;
		const result = await executeTaskflow(state(def, root, { package: "packages/api" }), {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			workspaceControlDirectory: control,
			agents: AGENTS,
			runTask: async (cwd, _agents, agent, task, opts) => {
				calls++;
				const selected = opts.cwd ?? cwd;
				if (task === "parent") {
					fs.writeFileSync(path.join(selected, "parent.txt"), "parent");
					queueSpawn(opts.ctxDir!, opts.nodeId!, [{ task: "child" }]);
				} else {
					fs.writeFileSync(path.join(selected, "child.txt"), "child");
				}
				return success(agent, task);
			},
		});
		assert.equal(result.ok, true);
		assert.equal(calls, 2);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const intents = await journal.listIntents();
		assert.equal(intents.length, 2);
		assert.ok(intents.every((intent) => intent.status === "committed-generation"));
		assert.equal(new Set(intents.map((intent) => intent.owner.unitId)).size, 2);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("a failed workspace ctx_spawn descendant fails the phase and leaves a durable dirty intent", async () => {
	const root = makeRoot();
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-cwd-spawn-failure-control-"));
	try {
		const def = bridgeDef([{
			id: "work",
			type: "agent",
			agent: "a",
			task: "parent",
			cwd: "{args.package}",
			shareContext: true,
			final: true,
		}]);
		let calls = 0;
		const result = await executeTaskflow(state(def, root, { package: "packages/api" }), {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			workspaceControlDirectory: control,
			agents: AGENTS,
			runTask: async (cwd, _agents, agent, task, opts) => {
				calls++;
				const selected = opts.cwd ?? cwd;
				if (task === "parent") {
					queueSpawn(opts.ctxDir!, opts.nodeId!, [{ task: "child" }]);
					return success(agent, task);
				}
				fs.writeFileSync(path.join(selected, "partial-child.txt"), "partial");
				return {
					...success(agent, task, ""),
					exitCode: 1,
					stopReason: "error",
					errorMessage: "child failed after mutation",
				};
			},
		});
		assert.equal(calls, 2);
		assert.equal(result.ok, false);
		assert.match(result.state.phases.work.error ?? "", /ctx_spawn descendant failed.*child failed/i);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		assert.deepEqual((await journal.listIntents()).map((intent) => intent.status), [
			"committed-generation",
			"dirty-unknown",
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("cwd bridge race cancellation aborts a loser waiting on the write lease", async () => {
	const root = makeRoot();
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-cwd-race-control-"));
	try {
		const def = bridgeDef([{
			id: "race",
			type: "race",
			cwd: "{args.package}",
			cancelLosers: true,
			branches: [{ agent: "a", task: "candidate-a" }, { agent: "a", task: "candidate-b" }],
			final: true,
		}]);
		const calls: string[] = [];
		const result = await executeTaskflow(state(def, root, { package: "packages/api" }), {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			workspaceControlDirectory: control,
			agents: AGENTS,
			runTask: async (_cwd, _agents, agent, task) => {
				calls.push(task);
				return success(agent, task, task);
			},
		});
		assert.equal(result.ok, true);
		assert.equal(calls.length, 1, "the cancelled loser never invokes after waiting on the exclusive lease");
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		assert.deepEqual((await journal.listIntents()).map((intent) => intent.status), ["committed-generation"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("cwd bridge disables resume/cache reuse across the entire flow", async () => {
	const root = makeRoot();
	const seen: string[] = [];
	try {
		const def = bridgeDef([
			{ id: "writer", type: "agent", agent: "a", task: "same-output", cwd: "{args.package}" },
			{ id: "reader", type: "agent", agent: "a", task: "read files", dependsOn: ["writer"], final: true },
		]);
		const runState = state(def, root, { package: "packages/api" });
		const deps: RuntimeDeps = {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			cacheScopeDefault: "cross-run",
			runTask: async (cwd, _agents, agent, task, opts) => {
				seen.push(`${task}:${opts.cwd ?? cwd}`);
				return success(agent, task, "unchanged");
			},
		};
		assert.equal((await executeTaskflow(runState, deps)).ok, true);
		runState.args.package = "packages/web";
		assert.equal((await executeTaskflow(runState, deps)).ok, true);
		assert.equal(seen.length, 4, "writer and downstream reader both re-executed on resume");
		assert.match(seen[0], /packages\/api$/);
		assert.match(seen[2], /packages\/web$/);
		assert.equal(runState.phases.writer.cacheHit, undefined);
		assert.equal(runState.phases.reader.cacheHit, undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("cwd bridge refuses resume against a different invocation root", async () => {
	const rootA = makeRoot();
	const rootB = makeRoot();
	let calls = 0;
	try {
		const def = bridgeDef();
		const runState = state(def, rootA, { package: "packages/api" });
		const runTask: RuntimeDeps["runTask"] = async (_cwd, _agents, agent, task) => {
			calls++;
			return success(agent, task);
		};
		assert.equal((await executeTaskflow(runState, { cwd: rootA, cwdBridgeMode: "resolve-only", agents: AGENTS, runTask })).ok, true);
		const rebound = await executeTaskflow(runState, { cwd: rootB, cwdBridgeMode: "resolve-only", agents: AGENTS, runTask });
		assert.equal(rebound.ok, false);
		assert.match(rebound.finalOutput, /persisted root/);
		assert.equal(calls, 1);
	} finally {
		fs.rmSync(rootA, { recursive: true, force: true });
		fs.rmSync(rootB, { recursive: true, force: true });
	}
});

test("persisted bridge taint survives saved-flow downgrade and keeps root/cache/recompute closed", async () => {
	const rootA = makeRoot();
	const rootB = makeRoot();
	try {
		const bridgeChild = bridgeDef();
		const plainChild: Taskflow = {
			name: bridgeChild.name,
			args: bridgeChild.args,
			phases: [{ id: "work", type: "agent", agent: "a", task: "plain", final: true }],
		};
		const parent: Taskflow = {
			name: "tainted-parent",
			phases: [
				{ id: "child", type: "flow", use: bridgeChild.name, with: { package: "packages/api" } },
				{ id: "after", type: "agent", agent: "a", task: "read files", dependsOn: ["child"], final: true },
			],
		};
		let currentChild = bridgeChild;
		let calls = 0;
		const deps = (cwd: string): RuntimeDeps => ({
			cwd,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			cacheScopeDefault: "cross-run",
			loadFlow: (name) => name === currentChild.name ? currentChild : undefined,
			runTask: async (_cwd, _agents, agent, task) => {
				calls++;
				return success(agent, task, "same");
			},
		});

		const runState = state(parent, rootA, {});
		assert.equal((await executeTaskflow(runState, deps(rootA))).ok, true);
		assert.ok(runState.cwdRootBinding);
		assert.equal(calls, 2);

		currentChild = plainChild;
		const rebound = await executeTaskflow(runState, deps(rootB));
		assert.equal(rebound.ok, false, "definition downgrade must not permit root rebinding");
		assert.match(rebound.finalOutput, /persisted root/);
		assert.equal(calls, 2);

		assert.equal((await executeTaskflow(runState, deps(rootA))).ok, true);
		assert.equal(calls, 4, "tainted child and downstream phases both re-run without cache reuse");
		await assert.rejects(
			recomputeTaskflow(runState, deps(rootA), ["child"], { dryRun: false }),
			/unavailable for cwd-bridge flows/,
		);
	} finally {
		fs.rmSync(rootA, { recursive: true, force: true });
		fs.rmSync(rootB, { recursive: true, force: true });
	}
});

test("a fresh bridge run may consume a pre-seeded external dependency", async () => {
	const root = makeRoot();
	let calls = 0;
	try {
		const def = bridgeDef([
			{
				id: "work",
				type: "agent",
				agent: "a",
				task: "review {steps.src.output}",
				cwd: "{args.package}",
				dependsOn: ["src"],
				final: true,
			},
		]);
		const runState = state(def, root, { package: "packages/api" });
		runState.phases.src = {
			id: "src",
			status: "done",
			output: "seed",
			usage: emptyUsage(),
			endedAt: Date.now(),
		};
		const result = await executeTaskflow(runState, {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			runTask: async (_cwd, _agents, agent, task) => {
				calls++;
				return success(agent, task);
			},
		});
		assert.equal(result.ok, true);
		assert.equal(calls, 1);
		assert.ok(runState.cwdRootBinding);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("cwd bridge refuses resume after an invocation-root symlink is retargeted", async (t) => {
	if (process.platform === "win32") {
		t.skip("symlink creation requires platform-specific privileges");
		return;
	}
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-cwd-link-"));
	const rootA = path.join(parent, "root-a");
	const rootB = path.join(parent, "root-b");
	const link = path.join(parent, "current");
	fs.mkdirSync(path.join(rootA, "packages", "api"), { recursive: true });
	fs.mkdirSync(path.join(rootB, "packages", "api"), { recursive: true });
	fs.symlinkSync(rootA, link, "dir");
	let calls = 0;
	try {
		const def = bridgeDef();
		const runState = state(def, link, { package: "packages/api" });
		const firstIdentity = directoryIdentity(link);
		assert.ok(firstIdentity);
		const runTask: RuntimeDeps["runTask"] = async (_cwd, _agents, agent, task) => {
			calls++;
			return success(agent, task);
		};
		assert.equal((await executeTaskflow(runState, { cwd: link, cwdBridgeMode: "resolve-only", agents: AGENTS, runTask })).ok, true);
		assert.deepEqual(runState.cwdRootBinding, firstIdentity);
		fs.unlinkSync(link);
		fs.symlinkSync(rootB, link, "dir");
		const resumed = await executeTaskflow(runState, { cwd: link, cwdBridgeMode: "resolve-only", agents: AGENTS, runTask });
		assert.equal(resumed.ok, false);
		assert.match(resumed.finalOutput, /persisted root/);
		assert.equal(calls, 1);
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("cwd bridge refuses live recompute until workspace state can be restored", async () => {
	const root = makeRoot();
	try {
		const def = bridgeDef();
		const runState = state(def, root, { package: "packages/api" });
		const deps: RuntimeDeps = {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			runTask: async (_cwd, _agents, agent, task) => success(agent, task),
		};
		assert.equal((await executeTaskflow(runState, deps)).ok, true);
		await assert.rejects(recomputeTaskflow(runState, deps, ["work"], { dryRun: false }), /unavailable for cwd-bridge flows/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a saved child cwd bridge disables parent flow and downstream reuse", async () => {
	const root = makeRoot();
	let calls = 0;
	try {
		const child = bridgeDef();
		const parent: Taskflow = {
			name: "cwd-parent",
			phases: [
				{ id: "child", type: "flow", use: child.name, with: { package: "packages/api" } },
				{ id: "after", type: "agent", agent: "a", task: "read child files", dependsOn: ["child"], final: true },
			],
		};
		const runState = state(parent, root, {});
		const deps: RuntimeDeps = {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			loadFlow: (name) => name === child.name ? child : undefined,
			runTask: async (_cwd, _agents, agent, task) => {
				calls++;
				return success(agent, task, "same");
			},
		};
		assert.equal((await executeTaskflow(runState, deps)).ok, true);
		assert.equal((await executeTaskflow(runState, deps)).ok, true);
		assert.equal(calls, 4, "child writer and parent downstream phase both reran");
		assert.equal(runState.phases.child.cacheHit, undefined);
		assert.equal(runState.phases.after.cacheHit, undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("saved-flow loading is snapshotted and capability changes fail closed on resume", async () => {
	const root = makeRoot();
	let loads = 0;
	let calls = 0;
	try {
		const plainChild: Taskflow = {
			name: "changing-child",
			args: { package: { type: "relative-path", required: true } },
			phases: [{ id: "work", type: "agent", agent: "a", task: "plain", final: true }],
		};
		const bridgeChild: Taskflow = {
			...plainChild,
			phases: [{ id: "work", type: "agent", agent: "a", task: "mutate", cwd: "{args.package}", final: true }],
		};
		const parent: Taskflow = {
			name: "changing-parent",
			phases: [{ id: "child", type: "flow", use: "changing-child", with: { package: "packages/api" }, final: true }],
		};
		const runState = state(parent, root, {});
		// Pi/MCP capture this at run creation, including for ordinary flows. It is
		// only launch provenance and must not pre-authorize later bridge use.
		runState.invocationRootSnapshot = directoryIdentity(root);
		const deps: RuntimeDeps = {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			loadFlow: () => (++loads % 2 === 1 ? plainChild : bridgeChild),
			runTask: async (_cwd, _agents, agent, task) => {
				calls++;
				return success(agent, task, "same");
			},
		};
		assert.equal((await executeTaskflow(runState, deps)).ok, true);
		assert.equal(runState.cwdRootBinding, undefined);
		const resumed = await executeTaskflow(runState, deps);
		assert.equal(resumed.ok, false);
		assert.match(resumed.finalOutput, /persisted root/);
		assert.equal(loads, 2, "each top-level execution observes one immutable saved-flow snapshot");
		assert.equal(calls, 1, "a bridge introduced after the first run cannot execute as an unbound capability");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a production-style launch root snapshot does not taint ordinary cache or recompute", async () => {
	const root = makeRoot();
	let calls = 0;
	try {
		const def: Taskflow = {
			name: "plain-production-state",
			phases: [{ id: "work", type: "agent", agent: "a", task: "plain", final: true }],
		};
		const runState = state(def, root, {});
		runState.invocationRootSnapshot = directoryIdentity(root);
		const deps: RuntimeDeps = {
			cwd: root,
			agents: AGENTS,
			runTask: async (_cwd, _agents, agent, task) => {
				calls++;
				return success(agent, task, `output-${calls}`);
			},
		};
		assert.equal((await executeTaskflow(runState, deps)).ok, true);
		assert.equal(calls, 1);
		assert.equal((await executeTaskflow(runState, deps)).ok, true);
		assert.equal(calls, 1, "ordinary within-run resume remains enabled");
		await assert.doesNotReject(recomputeTaskflow(runState, deps, ["work"], { dryRun: false }));
		assert.equal(calls, 2, "ordinary live recompute remains enabled");
		assert.equal(runState.cwdRootBinding, undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("saved-flow snapshot is detached from later mutation of the loader-owned object", async () => {
	const root = makeRoot();
	let observedCwd = "";
	try {
		const child: Taskflow = {
			name: "mutable-child",
			args: { package: { type: "relative-path", required: true } },
			phases: [{ id: "work", type: "agent", agent: "a", task: "plain", final: true }],
		};
		const parent: Taskflow = {
			name: "mutable-parent",
			phases: [{ id: "child", type: "flow", use: child.name, with: { package: "packages/api" }, final: true }],
		};
		const runState = state(parent, root, {});
		const result = await executeTaskflow(runState, {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			loadFlow: () => {
				queueMicrotask(() => {
					child.phases[0]!.cwd = "{args.package}";
				});
				return child;
			},
			runTask: async (cwd, _agents, agent, task, opts) => {
				observedCwd = opts.cwd ?? cwd;
				return success(agent, task);
			},
		});
		assert.equal(result.ok, true);
		assert.equal(fs.realpathSync(observedCwd), fs.realpathSync(root));
		assert.equal(runState.cwdRootBinding, undefined, "the immutable plain snapshot did not gain cwd authority");
		assert.equal(child.phases[0]!.cwd, "{args.package}", "the loader-owned object did mutate independently");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a bridge-selected flow cannot expand its inherited cwd boundary", async () => {
	const root = makeRoot();
	let calls = 0;
	try {
		const child: Taskflow = {
			name: "escaping-child",
			phases: [{ id: "escape", type: "agent", agent: "a", task: "escape", cwd: "../web", final: true }],
		};
		const parent = bridgeDef([
			{ id: "child", type: "flow", use: child.name, cwd: "{args.package}", final: true },
		]);
		const result = await executeTaskflow(state(parent, root, { package: "packages/api" }), {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			loadFlow: (name) => name === child.name ? child : undefined,
			runTask: async (_cwd, _agents, agent, task) => {
				calls++;
				return success(agent, task);
			},
		});
		assert.equal(result.ok, false);
		assert.match(result.state.phases.child.error ?? "", /TF_CWD_BOUNDARY_ESCAPE/);
		assert.equal(calls, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("cwd-bridge context pre-read cannot cross its lexical or symlink boundary", async (t) => {
	if (process.platform === "win32") {
		t.skip("symlink creation requires platform-specific privileges");
		return;
	}
	const root = makeRoot();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-cwd-context-outside-"));
	fs.writeFileSync(path.join(root, "packages", "web", "secret.txt"), "lexical-secret");
	fs.writeFileSync(path.join(outside, "secret.txt"), "symlink-secret");
	fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "packages", "api", "link.txt"), "file");
	try {
		for (const context of [["packages/web/secret.txt"], ["packages/api/link.txt"]]) {
			let calls = 0;
			const def = bridgeDef([
				{ id: "work", type: "agent", agent: "a", task: "review", cwd: "{args.package}", context, final: true },
			]);
			const result = await executeTaskflow(state(def, root, { package: "packages/api" }), {
				cwd: root,
				cwdBridgeMode: "resolve-only",
				agents: AGENTS,
				runTask: async (_cwd, _agents, agent, task) => {
					calls++;
					return success(agent, task);
				},
			});
			assert.equal(result.ok, false);
			assert.match(result.finalOutput, /TF_CWD_BOUNDARY_ESCAPE/);
			assert.equal(calls, 0);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("plain gate retry restores the parent cwd capability before re-running upstream", async () => {
	const root = makeRoot();
	fs.writeFileSync(path.join(root, "root-context.txt"), "root-only");
	const sourceCwds: string[] = [];
	const gateCwds: string[] = [];
	let gateCalls = 0;
	try {
		const def = bridgeDef([
			{ id: "source", type: "agent", agent: "a", task: "source", context: ["root-context.txt"] },
			{
				id: "check",
				type: "gate",
				agent: "a",
				task: "judge",
				cwd: "{args.package}",
				dependsOn: ["source"],
				onBlock: "retry",
				retry: { max: 1, backoffMs: 0 },
				final: true,
			},
		]);
		const result = await executeTaskflow(state(def, root, { package: "packages/api" }), {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			runTask: async (cwd, _agents, agent, task, opts) => {
				const effectiveCwd = opts.cwd ?? cwd;
				if (task.includes("judge")) {
					gateCwds.push(effectiveCwd);
					gateCalls++;
					return success(agent, task, gateCalls === 1 ? "VERDICT: BLOCK" : "VERDICT: PASS");
				}
				sourceCwds.push(effectiveCwd);
				return success(agent, task, "source-output");
			},
		});
		assert.equal(result.ok, true);
		assert.equal(sourceCwds.length, 2);
		assert.ok(sourceCwds.every((cwd) => fs.realpathSync(cwd) === fs.realpathSync(root)));
		assert.equal(gateCwds.length, 2);
		assert.ok(gateCwds.every((cwd) => cwd === fs.realpathSync(path.join(root, "packages/api"))));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("score gate retry restores the parent cwd capability before re-scoring upstream", async () => {
	const root = makeRoot();
	fs.writeFileSync(path.join(root, "root-context.txt"), "root-only");
	const sourceCwds: string[] = [];
	try {
		const def = bridgeDef([
			{ id: "source", type: "agent", agent: "a", task: "source", context: ["root-context.txt"] },
			{
				id: "check",
				type: "gate",
				cwd: "{args.package}",
				dependsOn: ["source"],
				onBlock: "retry",
				retry: { max: 1, backoffMs: 0 },
				score: { target: "{steps.source.output}", scorers: [{ type: "contains", value: "GOOD" }] },
				final: true,
			},
		]);
		const result = await executeTaskflow(state(def, root, { package: "packages/api" }), {
			cwd: root,
			cwdBridgeMode: "resolve-only",
			agents: AGENTS,
			runTask: async (cwd, _agents, agent, task, opts) => {
				sourceCwds.push(opts.cwd ?? cwd);
				return success(agent, task, sourceCwds.length === 1 ? "bad" : "GOOD");
			},
		});
		assert.equal(result.ok, true);
		assert.equal(result.state.phases.check.gate?.verdict, "pass");
		assert.equal(sourceCwds.length, 2);
		assert.ok(sourceCwds.every((cwd) => fs.realpathSync(cwd) === fs.realpathSync(root)));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("saved child cache identity includes its inherited execution cwd", async () => {
	const root = makeRoot();
	let calls = 0;
	try {
		const child: Taskflow = {
			name: "cwd-sensitive-child",
			phases: [{ id: "where", type: "agent", agent: "a", task: "pwd", final: true }],
		};
		const parent: Taskflow = {
			name: "two-child-roots",
			phases: [
				{ id: "api", type: "flow", use: child.name, cwd: "packages/api" },
				{ id: "web", type: "flow", use: child.name, cwd: "packages/web", dependsOn: ["api"], final: true },
			],
		};
		const cacheStore = new CacheStore(root);
		const result = await executeTaskflow(state(parent, root, {}), {
			cwd: root,
			agents: AGENTS,
			loadFlow: (name) => name === child.name ? child : undefined,
			cacheStore,
			cacheScopeDefault: "cross-run",
			runTask: async (cwd, _agents, agent, task, opts) => {
				calls++;
				return success(agent, task, opts.cwd ?? cwd);
			},
		});
		assert.equal(result.ok, true);
		assert.equal(calls, 2);
		assert.equal(result.state.phases.api.output, path.join(root, "packages/api"));
		assert.equal(result.state.phases.web.output, path.join(root, "packages/web"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a throwing saved-flow loader cannot escape the run state closure", async () => {
	const root = makeRoot();
	try {
		const def: Taskflow = {
			name: "lazy-loader",
			phases: [{ id: "unused", type: "flow", use: "unavailable", when: "false", final: true }],
		};
		const result = await executeTaskflow(state(def, root, {}), {
			cwd: root,
			agents: AGENTS,
			loadFlow: () => { throw new Error("loader exploded"); },
			runTask: async (_cwd, _agents, agent, task) => success(agent, task),
		});
		assert.equal(result.ok, true);
		assert.equal(result.state.status, "completed");
		assert.equal(result.state.phases.unused.status, "skipped");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("schema enforces typed values, required args, dynamic-flow denial, and no cross-run cache", () => {
	const def = bridgeDef();
	assert.equal(validateTaskflow(def, { args: {}, cwd: process.cwd() }).ok, false);
	assert.match(validateTaskflow(def, { args: {}, cwd: process.cwd() }).errors.join("\n"), /Missing required argument 'package'/);
	assert.match(validateTaskflow(def, { args: { package: 3 }, cwd: process.cwd() }).errors.join("\n"), /must be a string/);
	assert.match(validateTaskflow(def, { dynamic: true, cwd: process.cwd() }).errors.join("\n"), /cwd selection is not allowed/);

	const crossRun = bridgeDef([{ id: "work", type: "agent", task: "x", cwd: "{args.package}", cache: { scope: "cross-run" }, final: true }]);
	assert.match(validateTaskflow(crossRun).errors.join("\n"), /cannot use cache\.scope 'cross-run'/);

	const unsupportedPattern = {
		name: "dynamic-pattern",
		args: { value: { type: "string", pattern: "(a+)+$", default: "a" } },
		phases: [{ id: "work", type: "agent", task: "x", final: true }],
	} as unknown as Taskflow;
	assert.equal(validateTaskflow(unsupportedPattern, { dynamic: true }).ok, false, "regex patterns are not part of the 0.2.1 arg schema");
});

test("validation reports malformed argument specs without throwing", () => {
	const malformedArgs = [
		null,
		[],
		{ nullSpec: null },
		{ arraySpec: [] },
		{ primitiveSpec: 1 },
		{ objectValues: { type: "enum", values: {} } },
		{ stringValues: { type: "enum", values: "x" } },
	];
	for (const args of malformedArgs) {
		const malformed = {
			name: "malformed-args",
			args,
			phases: [{ id: "work", type: "agent", task: "x", final: true }],
		};
		assert.doesNotThrow(() => validateTaskflow(malformed, { args: { objectValues: "x", stringValues: "x" } }));
		const result = validateTaskflow(malformed, { args: { objectValues: "x", stringValues: "x" } });
		assert.equal(result.ok, false);
		assert.ok(result.errors.length > 0);
	}
});

test("flow version remains informational and does not invalidate legacy args", () => {
	const def: Taskflow = {
		name: "legacy-v2",
		version: 2,
		args: { package: { default: "packages/api" }, advisory: { required: true } },
		phases: [{ id: "work", type: "agent", task: "{args.package}", final: true }],
	};
	const validation = validateTaskflow(def, { args: { package: "packages/web", extra: true } });
	assert.equal(validation.ok, true);
	assert.match(validation.warnings.join("\n"), /remains advisory/);
});

test("event kernel keeps every phase-local cwd on the imperative runtime", () => {
	assert.equal(canUseEventKernel(bridgeDef()), false);
});
