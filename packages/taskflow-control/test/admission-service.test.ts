import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { openControlStore } from "../src/store/store.ts";
import { openCoordinatorStore } from "../src/store/coordinator-store.ts";
import { coordinatorOptions, withProject, type AdmissionWorkerConfig } from "./fixtures/admission-worker.ts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function setup(ttlMs = 250): Promise<AdmissionWorkerConfig> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-real-admission-")); roots.push(root);
	const projectPath = path.join(root, "project"), coordinatorPath = path.join(root, "coordinator");
	const store = openControlStore(projectPath), header = store.header, runId = randomUUID();
	store.createRun({ projectId: header.projectId, controlDomainId: header.controlDomainId, runId, runVersion: 0, status: "running", stage: "queued", slot: "none", needsOperator: false,
		boundPlanHash: `plan:${"1".repeat(64)}`, policyHash: "2".repeat(64), authorityEpoch: 1 });
	store.close();
	const config: AdmissionWorkerConfig = { projectPath, coordinatorPath, mode: "recover", reservation: {
		reservationId: randomUUID(), projectId: header.projectId, projectControlDomainId: header.controlDomainId,
		runId, state: "reserved", slots: 1, coordinatorEpoch: 1, reservedExpiresAt: 0,
	} };
	const coordinator = await openCoordinatorStore(coordinatorPath, coordinatorOptions(config));
	try { config.reservation = (await coordinator.reserve({ ...config.reservation, ttlMs }, {})).reservation; }
	finally { coordinator.close(); }
	return config;
}
const worker = fileURLToPath(new URL("./fixtures/admission-worker.ts", import.meta.url));
function start(config: AdmissionWorkerConfig) {
	const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types", worker, JSON.stringify(config)], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let stdout = "", stderr = "";
	child.stdout!.on("data", (chunk) => { stdout += chunk; }); child.stderr!.on("data", (chunk) => { stderr += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
	const done = new Promise<{ signal: string | null; code: number | null; data?: { ok: boolean; code?: string; result?: unknown }; stderr: string }>((resolve, reject) => {
		child.once("error", reject); child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, data: stdout.trim() ? JSON.parse(stdout.trim()) : undefined, stderr }); });
	});
	const ready = config.waitForStart ? new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error(`worker exited before barrier: ${stderr}`))); }) : Promise.resolve();
	return { child, done, ready };
}
async function run(config: AdmissionWorkerConfig) { return start(config).done; }
async function expiry(config: AdmissionWorkerConfig) { await sleep(Math.max(0, config.reservation.reservedExpiresAt! - Date.now()) + 20); }
async function snapshot(config: AdmissionWorkerConfig) {
	const coordinator = await openCoordinatorStore(config.coordinatorPath, coordinatorOptions(config));
	try { return await coordinator.snapshot({}); } finally { coordinator.close(); }
}

test("real project journal: abandonment is immutable and late admission/dispatch remain rejected after restart", async () => {
	const config = await setup(); await expiry(config);
	const recovered = await snapshot(config); assert.equal(recovered.capacity.active, 0);
	assert.equal(recovered.reservations[0]!.reservation.state, "expired");
	const decision = await withProject(config.projectPath, (_service, store) => store.readAdmission(config.reservation));
	assert.equal(decision?.status, "abandoned"); assert.ok(decision!.decisionCommitSeq > 0);
	for (const mode of ["admit", "dispatch"] as const) {
		const late = await run({ ...config, mode }); assert.equal(late.data?.code, "TF_ADMISSION_BINDING_CONFLICT", JSON.stringify(late));
	}
	assert.equal((await snapshot(config)).capacity.active, 0);
});

test("real project admit fsync then SIGKILL recovers committed capacity before any dispatch", async () => {
	const config = await setup(1500);
	const killed = await run({ ...config, mode: "admit", killAfterDecision: true }); assert.equal(killed.signal, "SIGKILL", killed.stderr);
	// The project decision alone never authorizes dispatch on a reserved row.
	await withProject(config.projectPath, (service) => assert.throws(() => service.assertDispatch(config.reservation), { code: "TF_ADMISSION_BINDING_CONFLICT" }));
	await expiry(config); const recovered = await snapshot(config);
	assert.equal(recovered.capacity.active, 1); assert.equal(recovered.capacity.committed, 1);
	assert.equal((await run({ ...config, mode: "dispatch" })).data?.ok, true);
	const coordinator = await openCoordinatorStore(config.coordinatorPath, coordinatorOptions(config));
	try { await assert.rejects(coordinator.reserve({ ...config.reservation, reservationId: randomUUID(), runId: randomUUID(), ttlMs: 1000 }, {}), { code: "TF_CAPACITY_EXCEEDED" }); }
	finally { coordinator.close(); }
});

test("durable project abandonment survives coordinator SIGKILL before capacity publication", async () => {
	const config = await setup(); await expiry(config);
	const killed = await run({ ...config, mode: "recover", killAfterDecision: true }); assert.equal(killed.signal, "SIGKILL", killed.stderr);
	const raw = JSON.parse(fs.readFileSync(path.join(config.coordinatorPath, "coordinator.json"), "utf8"));
	assert.equal(raw.reservations[config.reservation.reservationId].reservation.state, "reserved");
	assert.equal((await run({ ...config, mode: "admit" })).data?.code, "TF_ADMISSION_BINDING_CONFLICT");
	assert.equal((await snapshot(config)).capacity.active, 0);
});

test("two real processes race actual project journal ADMIT versus ABANDON; only durable winner can dispatch", { timeout: 30_000 }, async () => {
	for (let index = 0; index < 6; index++) {
		const config = await setup(600);
		const a = start({ ...config, mode: "admit", waitForStart: true }), b = start({ ...config, mode: "abandon", waitForStart: true });
		await Promise.all([a.ready, b.ready]); a.child.send("go"); b.child.send("go");
		const results = await Promise.all([a.done, b.done]);
		assert.ok(results[1]!.data?.ok, JSON.stringify(results));
		const decision = await withProject(config.projectPath, (_service, store) => store.readAdmission(config.reservation));
		assert.ok(decision); await expiry(config); const state = await snapshot(config);
		assert.equal(state.capacity.active, decision.status === "admitted" ? 1 : 0);
		const dispatch = await run({ ...config, mode: "dispatch" });
		assert.equal(dispatch.data?.ok, decision.status === "admitted", JSON.stringify({ results, decision, dispatch }));
		const journal = fs.readFileSync(path.join(config.projectPath, "journal", "000001.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(journal.filter((batch) => batch.admission?.reservationId === config.reservation.reservationId).length, 1);
	}
});

test("read-only absence never releases capacity without an explicit abandonment authority", async () => {
	const config = await setup(); await expiry(config);
	const options = coordinatorOptions(config); delete options.authority.abandonAdmissionIfAbsent;
	const coordinator = await openCoordinatorStore(config.coordinatorPath, options);
	try { assert.equal((await coordinator.snapshot({})).capacity.active, 1); }
	finally { coordinator.close(); }
	await withProject(config.projectPath, (_service, store) => assert.equal(store.readAdmission(config.reservation), undefined));
});

test("cross-project admission, wrong coordinator sequence, and corrupt ledger fail closed", async () => {
	const config = await setup(2000);
	await withProject(config.projectPath, (service) => {
		assert.throws(() => service.admit({ ...config.reservation, projectId: randomUUID() }, 0), { code: "TF_ADMISSION_BINDING_CONFLICT" });
		const admitted = service.admit(config.reservation, 0);
		assert.throws(() => service.assertDispatch({ ...config.reservation, state: "committed", projectAdmitCommitSeq: admitted.projectAdmitCommitSeq + 1 }), { code: "TF_ADMISSION_BINDING_CONFLICT" });
	});
	const journalPath = path.join(config.projectPath, "journal", "000001.jsonl");
	fs.appendFileSync(journalPath, '{"corrupt":true}\n'); const before = fs.readFileSync(journalPath);
	assert.throws(() => openControlStore(config.projectPath), { code: "TF_DURABILITY_FAILED" });
	assert.deepEqual(fs.readFileSync(journalPath), before);
});
