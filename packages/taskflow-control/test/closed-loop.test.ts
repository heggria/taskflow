/**
 * §23 GA closed-loop tests — drive shipped ControlHost / bootstrap APIs.
 * No soft assertions: capacity/attach/idempotency/park must hard-fail when wrong.
 * Multi-process races use parallel spawn + shared start barrier so children overlap.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	bootstrapControl,
	createControlHost,
	createMockExecutionProvider,
	openControlRegistry,
	openProjectControlStore,
	openUserCoordinatorStore,
	CAPACITY_OCCUPYING_STATES,
	canNormalRelease,
	DEFAULT_CONTROL_MODE,
	assertControlModeExplicit,
	type ControlEvent,
} from "../src/index.ts";
import { parentReleaseStart } from "./helpers/mp-barrier.mts";

const helpersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");

interface MpChildResult {
	status: number;
	stdout: string;
	stderr: string;
	id: string;
}

/**
 * Launch N children in parallel (non-blocking spawn + Promise.all).
 * Shared barrier: each child writes ready-${id}, parent drops `start` only after
 * all are ready so open/reserve/bootstrap critical sections truly collide.
 */
async function runMpHelpersParallel(
	script: string,
	argsList: string[][],
	opts?: { timeoutMs?: number },
): Promise<MpChildResult[]> {
	const timeoutMs = opts?.timeoutMs ?? 30_000;
	const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-mp-barrier-"));
	const scriptPath = path.join(helpersDir, script);

	const children: Array<{
		id: string;
		child: ChildProcess;
		done: Promise<MpChildResult>;
	}> = [];

	for (let i = 0; i < argsList.length; i++) {
		const id = String(i);
		const child = spawn(
			process.execPath,
			["--conditions=development", "--experimental-strip-types", scriptPath, ...argsList[i]!],
			{
				env: {
					...process.env,
					TF_MP_BARRIER: barrierDir,
					TF_MP_ID: id,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const done = new Promise<MpChildResult>((resolve) => {
			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf-8");
			child.stderr?.setEncoding("utf-8");
			child.stdout?.on("data", (c: string) => {
				stdout += c;
			});
			child.stderr?.on("data", (c: string) => {
				stderr += c;
			});
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
				resolve({ status: 124, stdout, stderr: stderr + "\nparent timeout", id });
			}, timeoutMs);
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ status: code ?? 1, stdout, stderr, id });
			});
		});
		children.push({ id, child, done });
	}

	// Wait until every child has parked on the barrier, then release together.
	parentReleaseStart(barrierDir, argsList.length, timeoutMs);

	const results = await Promise.all(children.map((c) => c.done));
	try {
		fs.rmSync(barrierDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	return results;
}

function tempEnv(): { env: NodeJS.ProcessEnv; home: string; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-ctrl-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-ctrl-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	return {
		env,
		home,
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

const SCRIPT_FLOW = {
	name: "fresh-install",
	phases: [{ id: "main", type: "script", run: "true", final: true }],
};

test("fresh install auto: one run → Receipt with bound plan identity", async () => {
	const t = tempEnv();
	try {
		assert.equal(DEFAULT_CONTROL_MODE, "auto");
		const { host, controlMode, role } = bootstrapControl({
			projectRoot: t.project,
			env: t.env,
			provider: createMockExecutionProvider({ outcome: "completed", output: "hello" }),
		});
		assert.equal(controlMode, "auto");
		assert.ok(role === "writer" || role === "attach");
		// Fresh install is the first client → writer
		assert.equal(host.role, "writer");
		assert.equal(host.canMutate, true);

		const result = await host.admitAndRun({ program: SCRIPT_FLOW, callerPrincipal: "test" });
		assert.equal(result.ok, true, JSON.stringify(result.error));
		assert.ok(result.receipt, "Receipt must be present");
		assert.equal(result.run?.status, "completed");
		assert.equal(result.run?.stage, "terminal");
		assert.ok(result.receipt!.boundPlanHash.startsWith("bp:"));
		assert.ok(result.receipt!.eventManifest.length >= 1);
		assert.ok(result.receipt!.startCommitSeq >= 1);
		assert.ok(result.receipt!.endCommitSeq >= result.receipt!.startCommitSeq);
		assert.equal(result.receipt!.projectId, host.projectId);
		assert.equal(result.receipt!.controlDomainId, host.controlDomainId);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("concurrent client start: single writer; attach cannot admit (no dual writers)", async () => {
	const t = tempEnv();
	try {
		const a = bootstrapControl({
			projectRoot: t.project,
			env: t.env,
			holderId: "client-a",
			provider: createMockExecutionProvider(),
		});
		const b = bootstrapControl({
			projectRoot: t.project,
			env: t.env,
			holderId: "client-b",
			provider: createMockExecutionProvider(),
		});
		assert.equal(a.host.projectId, b.host.projectId);
		assert.equal(a.host.controlDomainId, b.host.controlDomainId);

		const writers = [a, b].filter((x) => x.host.role === "writer" && x.host.canMutate);
		const attaches = [a, b].filter((x) => x.host.role === "attach" && !x.host.canMutate);
		assert.equal(writers.length, 1, "exactly one multi-mount writer");
		assert.equal(attaches.length, 1, "loser must attach read-only");
		assert.equal(a.host.singleton?.lock.endpoint, b.host.singleton?.lock.endpoint);

		const writer = writers[0]!.host;
		const attach = attaches[0]!.host;

		// Writer can admit
		const wRun = await writer.admitAndRun({ program: SCRIPT_FLOW, commandId: "writer-cmd" });
		assert.equal(wRun.ok, true, JSON.stringify(wRun.error));
		assert.ok(wRun.receipt);

		// Attach must NOT mint a second authority path (no Run/Receipt)
		const aRun = await attach.admitAndRun({ program: SCRIPT_FLOW, commandId: "attach-cmd" });
		assert.equal(aRun.ok, false);
		assert.equal(aRun.error?.code, "TF_AUTHORITY_REVOKED");
		assert.equal(aRun.receipt, undefined);
		// Store still has only the writer's run
		assert.equal(writer.store.listRuns().length, 1);
		assert.equal(attach.store.listRuns().length, 1);
		// Attach may still observe snapshots
		const snap = attach.getSnapshot(wRun.run!.runId);
		assert.ok(snap);
		assert.equal(snap!.run.status, "completed");

		a.host.close();
		b.host.close();
	} finally {
		t.cleanup();
	}
});

test("registry wipe + reopen restores projectId/domainId from store header", () => {
	const t = tempEnv();
	try {
		const host1 = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider(),
		});
		const projectId = host1.projectId;
		const domainId = host1.controlDomainId;
		host1.registry.wipe();
		assert.equal(host1.registry.list().length, 0);
		host1.close();

		const host2 = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider(),
		});
		assert.equal(host2.projectId, projectId);
		assert.equal(host2.controlDomainId, domainId);
		const entry = host2.registry.getByProjectId(projectId);
		assert.ok(entry);
		assert.equal(entry!.controlDomainId, domainId);
		host2.close();
	} finally {
		t.cleanup();
	}
});

test("silent auto→standalone is impossible via assertControlModeExplicit", () => {
	assert.throws(
		() => assertControlModeExplicit("auto", "standalone"),
		/forbidden: silent controlMode auto/,
	);
	assert.doesNotThrow(() => assertControlModeExplicit("standalone", "standalone"));
	assert.doesNotThrow(() => assertControlModeExplicit(undefined, "auto"));
});

test("maxActiveRuns capacity: N admitted occupy; N+1 always TF_CAPACITY_EXCEEDED; slots≡1", async () => {
	const t = tempEnv();
	try {
		// hang + reconcile budget 1 → both occupy as orphan-suspect (never release)
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 10 },
		});
		// Capacity lives on the host's coordinator (project-local for standalone).
		host.coordinator.setMaxActiveRuns(2, {
			commandId: "cmd-max",
			callerPrincipal: "op",
			requestBody: { maxActiveRuns: 2 },
		});
		assert.equal(host.coordinator.maxActiveRuns, 2);

		const r1 = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "c1" });
		const r2 = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "c2" });
		// Both must have runs that still hold capacity
		assert.ok(r1.run, JSON.stringify(r1.error));
		assert.ok(r2.run, JSON.stringify(r2.error));
		assert.equal(host.coordinator.occupyingCount(), 2);

		const r3 = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "c3" });
		// Hard requirement — not soft if
		assert.equal(r3.ok, false);
		assert.equal(r3.error?.code, "TF_CAPACITY_EXCEEDED");
		assert.equal(host.coordinator.occupyingCount(), 2);

		for (const r of host.coordinator.listReservations()) {
			assert.equal(r.slots, 1);
		}
		host.close();
	} finally {
		t.cleanup();
	}
});

test("committed slot not TTL-released; forceRelease only via CoordinatorCommandRecord", () => {
	const t = tempEnv();
	try {
		const coord = openUserCoordinatorStore(t.env);
		const rsv = coord.reserve({ coordinatorEpoch: 1, ttlMs: 1 });
		assert.ok(rsv);
		coord.commitReservation(rsv!.reservationId, {
			projectId: "p",
			projectControlDomainId: "d",
			runId: "r",
			projectAdmitCommitSeq: 1,
		});
		coord.reclaimExpiredReserved(Date.now() + 10_000);
		const still = coord.getReservation(rsv!.reservationId);
		assert.equal(still?.state, "committed");
		assert.ok(CAPACITY_OCCUPYING_STATES.includes(still!.state));

		assert.throws(() =>
			coord.normalRelease(rsv!.reservationId, {
				noLiveOrAmbiguousSideEffects: false,
				runIsTerminal: true,
				runIsParkedAndFutureDispatchRequiresReadmission: false,
			}),
		);

		const { reservation, command } = coord.forceRelease(rsv!.reservationId, {
			commandId: "force-1",
			callerPrincipal: "op",
			requestBody: { reservationId: rsv!.reservationId, riskAcknowledged: true },
		});
		assert.equal(reservation.state, "released");
		assert.equal(reservation.operatorOverridden, true);
		assert.equal(command.kind, "forceRelease");
		assert.ok(coord.getCommand("force-1"));
	} finally {
		t.cleanup();
	}
});

test("reconcile exhaustion: unknown + needs-operator + no Receipt; wait returns TF_RECONCILE_REQUIRED", async () => {
	const t = tempEnv();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "ambiguous", ambiguousForever: true }),
			reconcileBudget: { maxAttempts: 2, deadlineMs: 1000 },
		});
		const result = await host.admitAndRun({ program: SCRIPT_FLOW });
		assert.equal(result.ok, false);
		assert.equal(result.run?.status, "unknown");
		assert.equal(result.run?.stage, "reconciling");
		assert.equal(result.run?.needsOperator, true);
		assert.equal(result.error?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(result.error?.recoveryAction, "operator");
		assert.equal(result.receipt, undefined);
		assert.equal(host.store.getReceiptForRun(result.run!.runId), null);

		const snap = await host.wait(result.run!.runId);
		assert.equal(snap.run.status, "unknown");
		assert.equal(snap.controlError?.code, "TF_RECONCILE_REQUIRED");
		assert.equal(snap.receipt, null);

		const rsv = host.coordinator.getReservation(result.run!.reservationId!);
		assert.ok(rsv);
		assert.equal(rsv!.state, "orphan-suspect");
		host.close();
	} finally {
		t.cleanup();
	}
});

test("parkForApproval refuses while provider live; succeeds after quiesce (D38)", async () => {
	const t = tempEnv();
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const admitted = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "park-1" });
		const runId = admitted.run?.runId;
		assert.ok(runId);
		const reservationId = admitted.run!.reservationId;
		assert.ok(reservationId);
		const before = host.coordinator.occupyingCount();
		assert.ok(before >= 1);

		// Still live → park denied, slot held
		const refused = await host.parkForApproval(runId!);
		assert.equal(refused.ok, false);
		assert.equal(refused.error?.code, "TF_PROVIDER_AMBIGUOUS");
		assert.equal(host.coordinator.getReservation(reservationId!)?.state, "orphan-suspect");
		assert.equal(host.coordinator.occupyingCount(), before);

		// Quiesce provider → park allowed, slot released
		provider.quiesceAll?.();
		const parked = await host.parkForApproval(runId!);
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		assert.equal(parked.run?.status, "paused");
		assert.equal(parked.run?.stage, "parked");
		assert.equal(host.coordinator.getReservation(reservationId!)?.state, "released");
		assert.ok(host.coordinator.occupyingCount() < before);

		const approved = await host.approve(runId!);
		assert.equal(approved.ok, true);
		assert.equal(approved.run?.status, "completed");
		assert.ok(approved.receipt);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("idempotent commandId returns the bound run, not another project's receipt", async () => {
	const t = tempEnv();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "completed", output: "first" }),
		});
		const a = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "cmd-A", callerPrincipal: "u" });
		const b = await host.admitAndRun({ program: SCRIPT_FLOW, commandId: "cmd-B", callerPrincipal: "u" });
		assert.equal(a.ok, true);
		assert.equal(b.ok, true);
		assert.notEqual(a.run!.runId, b.run!.runId);

		const replayA = await host.admitAndRun({
			program: SCRIPT_FLOW,
			commandId: "cmd-A",
			callerPrincipal: "u",
		});
		assert.equal(replayA.ok, true);
		assert.equal(replayA.run!.runId, a.run!.runId);
		assert.equal(replayA.receipt?.runId, a.run!.runId);
		assert.notEqual(replayA.run!.runId, b.run!.runId);

		const replayB = await host.admitAndRun({
			program: SCRIPT_FLOW,
			commandId: "cmd-B",
			callerPrincipal: "u",
		});
		assert.equal(replayB.run!.runId, b.run!.runId);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("Project ControlStore: concurrent opens assign distinct commitSeq (no journal overwrite)", () => {
	const t = tempEnv();
	try {
		const s1 = openProjectControlStore(t.project);
		const s2 = openProjectControlStore(t.project);
		const mk = (i: number): { events: ControlEvent[]; run: import("../src/types.ts").RunProjection } => ({
			events: [
				{
					eventId: `ev-${i}`,
					schemaVersion: 1,
					controlDomainId: s1.header.controlDomainId,
					streamId: `run-${i}`,
					streamSeq: 1,
					commitSeq: 0,
					projectId: s1.header.projectId,
					recordedAt: Date.now(),
					payload: { type: "Generic", kind: "test", data: { i } },
				},
			],
			run: {
				runId: `run-${i}`,
				projectId: s1.header.projectId,
				controlDomainId: s1.header.controlDomainId,
				status: "running",
				stage: "executing",
				boundPlanHash: "bp:x",
				needsOperator: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runVersion: 1,
			},
		});
		const results: Array<{ start: number; end: number }> = [];
		// Interleave commits from two store handles
		for (let i = 0; i < 8; i++) {
			const store = i % 2 === 0 ? s1 : s2;
			const batch = mk(i);
			const r = store.commit(batch);
			results.push({ start: r.commitSeqStart, end: r.commitSeqEnd });
		}
		const starts = results.map((r) => r.start);
		assert.equal(new Set(starts).size, starts.length, `duplicate commitSeq starts: ${starts.join(",")}`);
		// Journal files must all exist and not share ranges
		const journalDir = path.join(t.project, ".taskflow", "control", "journal");
		const files = fs.readdirSync(journalDir).filter((f) => f.endsWith(".json")).sort();
		assert.equal(files.length, 8);
	} finally {
		t.cleanup();
	}
});

test("D37 predicates: canNormalRelease pure function", () => {
	assert.equal(
		canNormalRelease({
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: true,
			runIsParkedAndFutureDispatchRequiresReadmission: false,
		}),
		true,
	);
	assert.equal(
		canNormalRelease({
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: false,
			runIsParkedAndFutureDispatchRequiresReadmission: true,
		}),
		true,
	);
	assert.equal(
		canNormalRelease({
			noLiveOrAmbiguousSideEffects: false,
			runIsTerminal: true,
			runIsParkedAndFutureDispatchRequiresReadmission: false,
		}),
		false,
	);
});

test("openProjectControlStore header is authority for identity", () => {
	const t = tempEnv();
	try {
		const s1 = openProjectControlStore(t.project);
		const id = s1.header.projectId;
		const dom = s1.header.controlDomainId;
		const s2 = openProjectControlStore(t.project);
		assert.equal(s2.header.projectId, id);
		assert.equal(s2.header.controlDomainId, dom);
		const reg = openControlRegistry(t.env);
		reg.registerFromStore(s2, t.project);
		reg.wipe();
		const s3 = openProjectControlStore(t.project);
		assert.equal(s3.header.projectId, id);
	} finally {
		t.cleanup();
	}
});

test("multi-process concurrent first-open: single projectId/controlDomainId on durable header", async () => {
	const t = tempEnv();
	try {
		const N = 8;
		// True overlap: parallel spawn + shared start barrier (not serial spawnSync).
		const children = await runMpHelpersParallel(
			"mp-open-store.mts",
			Array.from({ length: N }, () => [t.project]),
		);
		const results: Array<{ projectId: string; controlDomainId: string; pid: number }> = [];
		for (const c of children) {
			assert.equal(c.status, 0, `child ${c.id} failed: ${c.stderr}\n${c.stdout}`);
			results.push(
				JSON.parse(c.stdout) as {
					projectId: string;
					controlDomainId: string;
					pid: number;
				},
			);
		}
		assert.equal(results.length, N);
		const projectIds = new Set(results.map((r) => r.projectId));
		const domainIds = new Set(results.map((r) => r.controlDomainId));
		assert.equal(projectIds.size, 1, `forked projectIds: ${[...projectIds].join(",")}`);
		assert.equal(domainIds.size, 1, `forked domainIds: ${[...domainIds].join(",")}`);

		const durable = JSON.parse(
			fs.readFileSync(path.join(t.project, ".taskflow", "control", "header.json"), "utf-8"),
		) as { projectId: string; controlDomainId: string };
		assert.equal(durable.projectId, results[0]!.projectId);
		assert.equal(durable.controlDomainId, results[0]!.controlDomainId);

		const parent = openProjectControlStore(t.project);
		assert.equal(parent.header.projectId, durable.projectId);
		assert.equal(parent.header.controlDomainId, durable.controlDomainId);
	} finally {
		t.cleanup();
	}
});

test("multi-process concurrent bootstrap: shared identity under parallel barrier", async () => {
	const t = tempEnv();
	try {
		const N = 4;
		const children = await runMpHelpersParallel(
			"mp-bootstrap.mts",
			Array.from({ length: N }, (_, i) => [t.project, t.home, `mp-holder-${i}`]),
		);
		const results: Array<{
			projectId: string;
			controlDomainId: string;
			role: string;
			canMutate: boolean;
		}> = [];
		for (const c of children) {
			assert.equal(c.status, 0, `bootstrap child ${c.id} failed: ${c.stderr}\n${c.stdout}`);
			results.push(JSON.parse(c.stdout));
		}
		const projectIds = new Set(results.map((r) => r.projectId));
		const domainIds = new Set(results.map((r) => r.controlDomainId));
		assert.equal(projectIds.size, 1, `forked projectIds: ${[...projectIds].join(",")}`);
		assert.equal(domainIds.size, 1);

		const durable = JSON.parse(
			fs.readFileSync(path.join(t.project, ".taskflow", "control", "header.json"), "utf-8"),
		) as { projectId: string; controlDomainId: string };
		assert.equal(durable.projectId, results[0]!.projectId);
		assert.equal(durable.controlDomainId, results[0]!.controlDomainId);
		assert.ok(results.every((r) => r.projectId === durable.projectId));
	} finally {
		t.cleanup();
	}
});

test("multi-process concurrent reserve: capacity never exceeds maxActiveRuns", async () => {
	const t = tempEnv();
	try {
		const coord = openUserCoordinatorStore(t.env);
		coord.setMaxActiveRuns(2, {
			commandId: "mp-max",
			callerPrincipal: "op",
			requestBody: { maxActiveRuns: 2 },
		});
		assert.equal(coord.maxActiveRuns, 2);

		const N = 8;
		// Parallel barriered reserve — without state.lock this oversubscribes.
		const children = await runMpHelpersParallel(
			"mp-reserve.mts",
			Array.from({ length: N }, () => [t.home]),
		);
		let okCount = 0;
		for (const c of children) {
			assert.equal(c.status, 0, `reserve child ${c.id} failed: ${c.stderr}\n${c.stdout}`);
			const parsed = JSON.parse(c.stdout) as { ok: boolean; occupying: number };
			if (parsed.ok) okCount += 1;
		}
		assert.ok(okCount <= 2, `okCount=${okCount} exceeded maxActiveRuns=2`);
		const final = openUserCoordinatorStore(t.env);
		assert.ok(final.occupyingCount() <= 2, `occupying=${final.occupyingCount()}`);
		assert.ok(okCount >= 1, "at least one reserve should succeed");
	} finally {
		t.cleanup();
	}
});
