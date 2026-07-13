import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import {
	createResolveOnlyWorkspaceSession,
	WORKSPACE_RECONCILE_ACKNOWLEDGEMENT,
	workspaceReconcileAllowedFromEnv,
	type ResolveOnlyPhaseBinding,
} from "../src/resources/execution.ts";
import { WriteIntentJournal } from "../src/resources/journal.ts";
import { PersistentFileMutex } from "../src/resources/persistence.ts";
import type { RunResult } from "../src/host/runner-types.ts";
import { emptyUsage } from "../src/usage.ts";

const agents: AgentConfig[] = [{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" }];

function result(exitCode = 0): RunResult {
	return {
		agent: "a",
		task: "work",
		exitCode,
		output: exitCode === 0 ? "ok" : "",
		stderr: "",
		usage: emptyUsage(),
		stopReason: exitCode === 0 ? "end" : "error",
		...(exitCode === 0 ? {} : { errorMessage: "failed" }),
	};
}

function fixture(): { root: string; control: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-execution-root-"));
	fs.mkdirSync(path.join(root, "packages", "api"), { recursive: true });
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-execution-control-"));
	return { root, control };
}

test("workspace reconciliation host opt-in accepts only the exact explicit mode", () => {
	assert.equal(workspaceReconcileAllowedFromEnv("explicit"), true);
	for (const value of [undefined, "", "1", "true", "EXPLICIT", "explicit "]) {
		assert.equal(workspaceReconcileAllowedFromEnv(value), false);
	}
});

async function binding(root: string, control: string, leaseTimeoutMs = 500): Promise<ResolveOnlyPhaseBinding> {
	const session = await createResolveOnlyWorkspaceSession({
		invocationRoot: root,
		controlDirectory: control,
		leaseTimeoutMs,
	});
	return session.bindPhase({
		invocationRoot: root,
		runId: "run-1",
		phaseId: "work",
		argName: "package",
		argDefinitions: { package: { type: "relative-path", required: true } },
		argValues: { package: "packages/api" },
	});
}

test("resolve-only execution binds typed cwd and commits a durable generation", async () => {
	const { root, control } = fixture();
	try {
		const bound = await binding(root, control);
		assert.equal(bound.assurance, "resolve-only-no-sandbox");
		assert.equal(bound.absolutePath, fs.realpathSync(path.join(root, "packages/api")));
		const run = await bound.runAgent({
			agents,
			agentName: "a",
			task: "work",
			opts: { cwd: bound.absolutePath },
			invoke: async () => {
				fs.writeFileSync(path.join(bound.absolutePath, "created.txt"), "ok");
				return result();
			},
		});
		assert.equal(run.exitCode, 0);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const intents = await journal.listIntents();
		assert.equal(intents.length, 1);
		assert.equal(intents[0].status, "committed-generation");
		assert.equal(intents[0].commitGeneration, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("cross-session overlapping writers contend on the persistent lease", async () => {
	const { root, control } = fixture();
	let releaseFirst!: () => void;
	const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
	let firstEntered!: () => void;
	const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
	try {
		const first = await binding(root, control, 1000);
		const second = await binding(root, control, 50);
		const firstRun = first.runAgent({
			agents,
			agentName: "a",
			task: "first",
			opts: { cwd: first.absolutePath },
			invoke: async () => {
				firstEntered();
				await firstMayFinish;
				return result();
			},
		});
		await entered;
		const blocked = await second.runAgent({
			agents,
			agentName: "a",
			task: "second",
			opts: { cwd: second.absolutePath },
			invoke: async () => result(),
		});
		assert.equal(blocked.exitCode, 1);
		assert.match(blocked.errorMessage ?? "", /Lease timeout/);
		releaseFirst();
		assert.equal((await firstRun).exitCode, 0);
	} finally {
		releaseFirst?.();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("session startup does not recover a live writer's pending intent", async () => {
	const { root, control } = fixture();
	let releaseFirst!: () => void;
	const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
	let firstEntered!: () => void;
	const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
	try {
		const first = await binding(root, control, 1000);
		const firstRun = first.runAgent({
			agents,
			agentName: "a",
			task: "first",
			opts: { cwd: first.absolutePath },
			invoke: async () => {
				firstEntered();
				await firstMayFinish;
				return result();
			},
		});
		await entered;

		const concurrentSession = await createResolveOnlyWorkspaceSession({
			invocationRoot: root,
			controlDirectory: control,
			leaseTimeoutMs: 50,
		});
		const concurrent = await concurrentSession.bindPhase({
			invocationRoot: root,
			runId: "run-2",
			phaseId: "work",
			argName: "package",
			argDefinitions: { package: { type: "relative-path", required: true } },
			argValues: { package: "packages/api" },
		});
		const blocked = await concurrent.runAgent({
			agents,
			agentName: "a",
			task: "second",
			opts: { cwd: concurrent.absolutePath },
			invoke: async () => result(),
		});
		assert.match(blocked.errorMessage ?? "", /Lease timeout/);

		releaseFirst();
		assert.equal((await firstRun).exitCode, 0);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const intents = await journal.listIntents();
		assert.equal(intents.length, 1);
		assert.equal(intents[0].status, "committed-generation");
	} finally {
		releaseFirst?.();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("a failed writer is blocked until explicit reconciliation, then writing resumes", async () => {
	const { root, control } = fixture();
	try {
		const first = await binding(root, control);
		const failed = await first.runAgent({
			agents,
			agentName: "a",
			task: "partial",
			opts: { cwd: first.absolutePath },
			invoke: async () => {
				fs.writeFileSync(path.join(first.absolutePath, "partial.txt"), "partial");
				return result(1);
			},
		});
		assert.equal(failed.exitCode, 1);

		const second = await binding(root, control);
		let calls = 0;
		const blocked = await second.runAgent({
			agents,
			agentName: "a",
			task: "retry",
			opts: { cwd: second.absolutePath },
			invoke: async () => {
				calls++;
				return result();
			},
		});
		assert.equal(calls, 0);
		assert.match(blocked.errorMessage ?? "", /TFWS_RESOURCE_DIRTY/);

		const reconciler = await createResolveOnlyWorkspaceSession({
			invocationRoot: root,
			controlDirectory: control,
		});
		await assert.rejects(
			reconciler.reconcile({ acknowledgement: WORKSPACE_RECONCILE_ACKNOWLEDGEMENT }),
			/TFWS_RECONCILE_NOT_AUTHORIZED/,
		);
		const authorizedReconciler = await createResolveOnlyWorkspaceSession({
			invocationRoot: root,
			controlDirectory: control,
			allowReconcile: true,
		});
		await assert.rejects(
			authorizedReconciler.reconcile({ acknowledgement: "yes" }),
			/TFWS_RECONCILE_ACK_REQUIRED/,
		);
		const reconciled = await authorizedReconciler.reconcile({
			acknowledgement: WORKSPACE_RECONCILE_ACKNOWLEDGEMENT,
			reason: "test inspected current workspace state",
		});
		assert.equal(reconciled.generation, 1);
		assert.equal(reconciled.reconciledIntentIds.length, 1);

		const third = await binding(root, control);
		const resumed = await third.runAgent({
			agents,
			agentName: "a",
			task: "after-reconcile",
			opts: { cwd: third.absolutePath },
			invoke: async () => {
				calls++;
				return result();
			},
		});
		assert.equal(resumed.exitCode, 0);
		assert.equal(calls, 1);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		assert.deepEqual((await journal.listIntents()).map((intent) => intent.status), [
			"reconciled",
			"committed-generation",
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("binding rejects an argument-selected symlink escape before execution", async (t) => {
	if (process.platform === "win32") return t.skip("symlink privileges are platform-specific");
	const { root, control } = fixture();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-execution-outside-"));
	try {
		fs.symlinkSync(outside, path.join(root, "escape"), "dir");
		const session = await createResolveOnlyWorkspaceSession({ invocationRoot: root, controlDirectory: control });
		await assert.rejects(session.bindPhase({
			invocationRoot: root,
			runId: "run-1",
			phaseId: "work",
			argName: "package",
			argDefinitions: { package: { type: "relative-path" } },
			argValues: { package: "escape" },
		}), /TFWS_PATH_ESCAPE/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("an authorized session fails closed if the invocation path is replaced by a new inode", async () => {
	const { root, control } = fixture();
	const moved = `${root}-moved`;
	try {
		const bound = await binding(root, control);
		fs.renameSync(root, moved);
		fs.mkdirSync(path.join(root, "packages", "api"), { recursive: true });
		let calls = 0;
		const rejected = await bound.runAgent({
			agents,
			agentName: "a",
			task: "must-not-run",
			opts: { cwd: bound.absolutePath },
			invoke: async () => {
				calls++;
				return result();
			},
		});
		assert.equal(calls, 0);
		assert.equal(rejected.exitCode, 1);
		assert.match(rejected.errorMessage ?? "", /TFWS_IDENTITY_MISMATCH/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(moved, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("root replacement during an active writer is dirty-unknown, never committed success", async () => {
	const { root, control } = fixture();
	const moved = `${root}-moved`;
	try {
		const bound = await binding(root, control);
		const rejected = await bound.runAgent({
			agents,
			agentName: "a",
			task: "replace-root",
			opts: { cwd: bound.absolutePath },
			invoke: async () => {
				fs.renameSync(root, moved);
				fs.mkdirSync(path.join(root, "packages", "api"), { recursive: true });
				return result();
			},
		});
		assert.equal(rejected.exitCode, 1);
		assert.match(rejected.errorMessage ?? "", /TFWS_IDENTITY_MISMATCH/);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		assert.deepEqual((await journal.listIntents()).map((intent) => intent.status), ["dirty-unknown"]);
		assert.equal(await journal.getDomainGeneration((await journal.listIntents())[0].resourceDomainId), 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(moved, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("root replacement while post-resolution awaits the journal is still dirty-unknown", async () => {
	const { root, control } = fixture();
	const moved = `${root}-moved`;
	let finishInvoke!: () => void;
	const invokeMayFinish = new Promise<void>((resolve) => { finishInvoke = resolve; });
	let enteredInvoke!: () => void;
	const invokeEntered = new Promise<void>((resolve) => { enteredInvoke = resolve; });
	let releaseJournal: (() => void) | undefined;
	try {
		const bound = await binding(root, control, 1_000);
		const run = bound.runAgent({
			agents,
			agentName: "a",
			task: "post-resolve-root-race",
			opts: { cwd: bound.absolutePath },
			invoke: async () => {
				enteredInvoke();
				await invokeMayFinish;
				return result();
			},
		});
		await invokeEntered;

		const journalLockPath = path.join(control, "resource-journal.lock");
		const journalMutex = new PersistentFileMutex(journalLockPath, { pollMs: 1 });
		releaseJournal = await journalMutex.acquire();
		finishInvoke();

		const queueDirectory = `${journalLockPath}.queue`;
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline) {
			const waitingTickets = fs.readdirSync(queueDirectory)
				.filter((name) => name.startsWith("ticket-")).length;
			if (waitingTickets >= 2) break;
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(
			fs.readdirSync(queueDirectory).filter((name) => name.startsWith("ticket-")).length >= 2,
			"post-execution resolver is waiting behind the held journal mutex",
		);

		fs.renameSync(root, moved);
		fs.mkdirSync(path.join(root, "packages", "api"), { recursive: true });
		releaseJournal();
		releaseJournal = undefined;

		const rejected = await run;
		assert.equal(rejected.exitCode, 1);
		assert.match(rejected.errorMessage ?? "", /TFWS_IDENTITY_MISMATCH/);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		assert.deepEqual((await journal.listIntents()).map((intent) => intent.status), ["dirty-unknown"]);
	} finally {
		finishInvoke?.();
		releaseJournal?.();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(moved, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("abort while terminal commit waits on the permit mutex is dirty-unknown", async () => {
	const { root, control } = fixture();
	const controller = new AbortController();
	let finishInvoke!: () => void;
	const invokeMayFinish = new Promise<void>((resolve) => { finishInvoke = resolve; });
	let enteredInvoke!: () => void;
	const invokeEntered = new Promise<void>((resolve) => { enteredInvoke = resolve; });
	let releasePermit: (() => void) | undefined;
	try {
		const bound = await binding(root, control, 1_000);
		const run = bound.runAgent({
			agents,
			agentName: "a",
			task: "abort-during-terminal-commit",
			opts: { cwd: bound.absolutePath, signal: controller.signal },
			invoke: async () => {
				enteredInvoke();
				await invokeMayFinish;
				return result();
			},
		});
		await invokeEntered;
		const permitLockPath = path.join(control, "mutation-permits.lock");
		releasePermit = await new PersistentFileMutex(permitLockPath, { pollMs: 1 }).acquire();
		finishInvoke();
		const queueDirectory = `${permitLockPath}.queue`;
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline &&
			fs.readdirSync(queueDirectory).filter((name) => name.startsWith("ticket-")).length < 2) {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(fs.readdirSync(queueDirectory).filter((name) => name.startsWith("ticket-")).length >= 2);
		controller.abort();
		releasePermit();
		releasePermit = undefined;

		const rejected = await run;
		assert.equal(rejected.exitCode, 1);
		assert.match(rejected.errorMessage ?? "", /ABORT_ERR/);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		assert.deepEqual((await journal.listIntents()).map((intent) => intent.status), ["dirty-unknown"]);
		assert.equal(await journal.getDomainGeneration((await journal.listIntents())[0].resourceDomainId), 0);
	} finally {
		finishInvoke?.();
		releasePermit?.();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("cwd replacement while terminal commit waits on the permit mutex is dirty-unknown", async () => {
	const { root, control } = fixture();
	const cwd = path.join(root, "packages", "api");
	const moved = `${cwd}-moved`;
	let finishInvoke!: () => void;
	const invokeMayFinish = new Promise<void>((resolve) => { finishInvoke = resolve; });
	let enteredInvoke!: () => void;
	const invokeEntered = new Promise<void>((resolve) => { enteredInvoke = resolve; });
	let releasePermit: (() => void) | undefined;
	try {
		const bound = await binding(root, control, 1_000);
		const run = bound.runAgent({
			agents,
			agentName: "a",
			task: "cwd-replacement-during-terminal-commit",
			opts: { cwd: bound.absolutePath },
			invoke: async () => {
				enteredInvoke();
				await invokeMayFinish;
				return result();
			},
		});
		await invokeEntered;
		const permitLockPath = path.join(control, "mutation-permits.lock");
		releasePermit = await new PersistentFileMutex(permitLockPath, { pollMs: 1 }).acquire();
		finishInvoke();
		const queueDirectory = `${permitLockPath}.queue`;
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline &&
			fs.readdirSync(queueDirectory).filter((name) => name.startsWith("ticket-")).length < 2) {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(fs.readdirSync(queueDirectory).filter((name) => name.startsWith("ticket-")).length >= 2);
		fs.renameSync(cwd, moved);
		fs.mkdirSync(cwd);
		releasePermit();
		releasePermit = undefined;

		const rejected = await run;
		assert.equal(rejected.exitCode, 1);
		assert.match(rejected.errorMessage ?? "", /TFWS_IDENTITY_MISMATCH/);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		assert.deepEqual((await journal.listIntents()).map((intent) => intent.status), ["dirty-unknown"]);
	} finally {
		finishInvoke?.();
		releasePermit?.();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("abort retains a live non-cooperative writer and makes its late success dirty", async () => {
	const { root, control } = fixture();
	const controller = new AbortController();
	let finishOld!: () => void;
	const oldMayFinish = new Promise<void>((resolve) => { finishOld = resolve; });
	let enteredOld!: () => void;
	const oldEntered = new Promise<void>((resolve) => { enteredOld = resolve; });
	try {
		const first = await binding(root, control, 1_000);
		const oldRun = first.runAgent({
			agents,
			agentName: "a",
			task: "non-cooperative",
			opts: { cwd: first.absolutePath, signal: controller.signal },
			invoke: async () => {
				enteredOld();
				await oldMayFinish;
				return result();
			},
		});
		await oldEntered;
		controller.abort();

		const second = await binding(root, control, 50);
		let secondCalls = 0;
		const overlap = await second.runAgent({
			agents,
			agentName: "a",
			task: "must-wait",
			opts: { cwd: second.absolutePath },
			invoke: async () => {
				secondCalls++;
				return result();
			},
		});
		assert.equal(secondCalls, 0);
		assert.match(overlap.errorMessage ?? "", /Lease timeout/);

		const reconciler = await createResolveOnlyWorkspaceSession({
			invocationRoot: root,
			controlDirectory: control,
			leaseTimeoutMs: 50,
			allowReconcile: true,
		});
		await assert.rejects(reconciler.reconcile({
			acknowledgement: WORKSPACE_RECONCILE_ACKNOWLEDGEMENT,
		}), /Lease timeout/);

		finishOld();
		const late = await oldRun;
		assert.equal(late.exitCode, 1);
		assert.match(late.errorMessage ?? "", /ABORT_ERR/);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		assert.deepEqual((await journal.listIntents()).map((intent) => intent.status), ["dirty-unknown"]);

		const third = await binding(root, control, 500);
		let lateRetryCalls = 0;
		const blockedAfterLateSuccess = await third.runAgent({
			agents,
			agentName: "a",
			task: "blocked-before-reconcile",
			opts: { cwd: third.absolutePath },
			invoke: async () => {
				lateRetryCalls++;
				return result();
			},
		});
		assert.equal(lateRetryCalls, 0);
		assert.match(blockedAfterLateSuccess.errorMessage ?? "", /TFWS_RESOURCE_DIRTY/);

		const reconciled = await reconciler.reconcile({
			acknowledgement: WORKSPACE_RECONCILE_ACKNOWLEDGEMENT,
			reason: "test accepted late-abort filesystem state",
		});
		assert.equal(reconciled.reconciledIntentIds.length, 1);
		const fourth = await binding(root, control, 500);
		assert.equal((await fourth.runAgent({
			agents,
			agentName: "a",
			task: "after-reconcile",
			opts: { cwd: fourth.absolutePath },
			invoke: async () => result(),
		})).exitCode, 0);
	} finally {
		finishOld?.();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});
