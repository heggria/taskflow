import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { ControlError } from "../src/errors.ts";
import { commandRequestHash } from "../src/schema/commands.ts";
import { openCoordinatorStore, type CoordinatorStoreOptions, type CoordinatorReleaseProof, type CoordinatorIdentity, type UserCoordinatorStore } from "../src/store/coordinator-store.ts";
import type { ConcurrencyReservation } from "../src/schema/coordinator.ts";

const roots: string[] = [];
const makePath = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-coordinator-")); roots.push(root); return path.join(root, "user-private"); };
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const bytes = (directory: string) => fs.readFileSync(path.join(directory, "coordinator.json"), "utf8");
const binding = (overrides = {}) => ({ reservationId: randomUUID(), projectId: randomUUID(), projectControlDomainId: randomUUID(), runId: randomUUID(), ttlMs: 60_000, ...overrides });
const errorCode = (code: string) => (error: unknown) => error instanceof ControlError && error.code === code;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
type Context = object;
function authority(max = 2, epoch = 1) {
	const identities = new WeakMap<Context, CoordinatorIdentity>();
	const context = {}; identities.set(context, { principal: "user:one", ownerId: "owner:one", operator: false });
	const operator = {}; identities.set(operator, { principal: "operator:one", ownerId: "owner:operator", operator: true });
	let leaseEpoch = epoch, leaseExpired = false, revoked = false;
	let releaseOverride: Partial<CoordinatorReleaseProof> = {};
	let admissionOverride: Partial<{ projectAdmitCommitSeq: number; runVersion: number }> = {};
	let admissionUnavailable = false;
	let admissionHook: (() => Promise<void>) | undefined;
	let releaseHook: (() => Promise<void>) | undefined;
	const seenBindings: ConcurrencyReservation[] = [];
	const options: CoordinatorStoreOptions<Context> = { initialMaxActiveRuns: max, epoch, holderId: "fixture-host", authority: {
		readLease: () => ({ holderId: "fixture-host", fencingEpoch: leaseEpoch, endpoint: "test://coordinator", expiresAt: Date.now() + (leaseExpired ? -1 : 60_000) }),
		authorize: (ctx, _operation, row) => {
			if (row) seenBindings.push(structuredClone(row));
			const identity = identities.get(ctx); if (!identity || revoked) throw new ControlError("TF_AUTHORITY_REVOKED", "opaque host authority was not verified");
			return structuredClone(identity);
		},
		readAdmission: async (row) => {
			await admissionHook?.(); if (admissionUnavailable) return null;
			const proofFile = path.join(admissionDirectory ?? "", "test-project-admission.json");
			if (admissionDirectory && fs.existsSync(proofFile)) return JSON.parse(fs.readFileSync(proofFile, "utf8"));
			return row.projectAdmitCommitSeq === undefined && admissionOverride.projectAdmitCommitSeq === undefined
				? { status: "not-admitted" as const, reservationId: row.reservationId, projectId: row.projectId, projectControlDomainId: row.projectControlDomainId, runId: row.runId, runVersion: 0 }
				: { ...row, projectAdmitCommitSeq: row.projectAdmitCommitSeq!, runVersion: 1, ...admissionOverride };
		},
		abandonAdmissionIfAbsent: async (row) => {
			if (admissionUnavailable) throw new Error("project unavailable");
			const observed = await options.authority.readAdmission(row);
			if (observed && !("status" in observed)) return observed;
			return { status: "abandoned" as const, reservationId: row.reservationId, projectId: row.projectId,
				projectControlDomainId: row.projectControlDomainId, runId: row.runId, runVersion: 0, abandonmentCommitSeq: 1 };
		},
		readRelease: async (row) => { await releaseHook?.(); return { ...row, projectAdmitCommitSeq: row.projectAdmitCommitSeq!, runVersion: 2, proofId: "trusted-ledger-provider-proof", status: "completed", stage: "terminal", requiresReadmission: false, providerNoLiveProcessTree: true, noAmbiguousJobs: true, reconcileTimeoutOnly: false, ...releaseOverride }; },
	} };
	let admissionDirectory: string | undefined;
	return { options, context, operator, seenBindings,
		issue: (identity: CoordinatorIdentity) => { const ctx = {}; identities.set(ctx, identity); return ctx; },
		revoke: () => { revoked = true; }, lease: (newEpoch: number, expired = false) => { leaseEpoch = newEpoch; leaseExpired = expired; },
		release: (proof: Partial<CoordinatorReleaseProof>) => { releaseOverride = proof; }, admission: (proof: typeof admissionOverride) => { admissionOverride = proof; },
		unavailableAdmission: () => { admissionUnavailable = true; }, projectLedger: (directory: string) => { admissionDirectory = directory; },
		waitAdmission: (hook: () => Promise<void>) => { admissionHook = hook; }, waitRelease: (hook: () => Promise<void>) => { releaseHook = hook; },
	};
}
async function admitted(store: UserCoordinatorStore<Context>, context: Context, input = binding()) {
	await store.reserve(input, context); return store.commit(input.reservationId, { projectAdmitCommitSeq: 7 }, context);
}
const worker = fileURLToPath(new URL("./fixtures/coordinator-worker.ts", import.meta.url));
async function runWorker(config: Record<string, unknown>) {
	const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types", worker, JSON.stringify(config)], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
	try {
		const close = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
		if (close.signal) return { ...close, stderr, stdout, data: undefined };
		assert.ok(stdout.trim(), `worker produced no result: ${stderr}`);
		return { ...close, stderr, stdout, data: JSON.parse(stdout.trim()) as { ok: boolean; code?: string; result?: unknown } };
	} finally { clearTimeout(timer); }
}

test("P16 reserve is globally metered, scope-authorized, one slot, with detached inputs/outputs", async () => {
	const directory = makePath(), auth = authority(1), store = await openCoordinatorStore(directory, auth.options);
	try {
		const input = binding(), result = await store.reserve(input, auth.context);
		assert.equal(result.reservation.slots, 1); assert.equal(auth.seenBindings[0]?.projectId, input.projectId);
		result.reservation.state = "released"; input.projectId = randomUUID();
		assert.equal((await store.readReservation(result.reservation.reservationId, auth.context))!.reservation.state, "reserved");
		const before = bytes(directory);
		await assert.rejects(store.reserve(binding(), auth.context), errorCode("TF_CAPACITY_EXCEEDED"));
		await assert.rejects(store.reserve(binding(), { principal: "user:one", ownerId: "owner:one", operator: true }), errorCode("TF_AUTHORITY_REVOKED"));
		assert.equal(bytes(directory), before);
		assert.equal((await store.snapshot(auth.context)).capacity.active, 1);
	} finally { store.close(); }
});

test("P16 32 real processes race across projects: exactly N slots and N+1 fails closed", { timeout: 60_000 }, async () => {
	const directory = makePath(), auth = authority(8), store = await openCoordinatorStore(directory, auth.options);
	try {
		const results = await Promise.all(Array.from({ length: 32 }, (_, index) => runWorker({ path: directory, mode: "reserve", max: 8, identity: { principal: `user:${index}`, ownerId: `owner:${index}`, operator: false }, input: binding() })));
		assert.equal(results.filter((r) => r.data?.ok).length, 8, results.map((r) => r.stderr + r.stdout).join("\n"));
		assert.equal(results.filter((r) => r.data?.code === "TF_CAPACITY_EXCEEDED").length, 24);
		const snapshot = await store.snapshot(auth.context);
		assert.deepEqual(snapshot.capacity, { maxActiveRuns: 8, active: 8, reserved: 8, committed: 0, orphanSuspect: 0 });
		assert.equal(new Set(snapshot.reservations.map((r) => r.reservation.projectId)).size, 8);
	} finally { store.close(); }
});

test("P16 racing first opens create exactly one durable authority before enforcing capacity", { timeout: 30_000 }, async () => {
	const directory = makePath();
	const results = await Promise.all(Array.from({ length: 8 }, (_, index) => runWorker({ path: directory, mode: "reserve", max: 2, identity: { principal: `bootstrap:${index}`, ownerId: `owner:${index}`, operator: false }, input: binding() })));
	assert.equal(results.filter((r) => r.data?.ok).length, 2, results.map((r) => r.stderr + r.stdout).join("\n"));
	assert.equal(results.filter((r) => r.data?.code === "TF_CAPACITY_EXCEEDED").length, 6);
	const auth = authority(2), store = await openCoordinatorStore(directory, auth.options);
	try { assert.equal((await store.snapshot(auth.context)).capacity.active, 2); assert.equal(JSON.parse(bytes(directory)).audit.filter((r: { action: string }) => r.action === "initialize").length, 1); }
	finally { store.close(); }
});

test("P16 only pre-admit reserved expires; committed and orphan-suspect never use TTL", async () => {
	const directory = makePath(), auth = authority(3), store = await openCoordinatorStore(directory, auth.options);
	try {
		const expiring = binding({ ttlMs: 80 }); await store.reserve(expiring, auth.context);
		const committed = await admitted(store, auth.context), orphan = await admitted(store, auth.context);
		await store.markOrphanSuspect(orphan.reservation.reservationId, auth.context);
		await sleep(100);
		const snapshot = await store.snapshot(auth.context);
		assert.equal(snapshot.capacity.active, 2); assert.equal(snapshot.capacity.committed, 1); assert.equal(snapshot.capacity.orphanSuspect, 1);
		assert.equal(snapshot.commitSeq, JSON.parse(bytes(directory)).commitSeq, "expiry-triggered snapshot reports the published seq");
		assert.equal((await store.readReservation(expiring.reservationId, auth.context))!.reservation.state, "expired");
		for (const row of [committed, orphan]) {
			await assert.rejects(store.renew(row.reservation.reservationId, { ttlMs: 10 }, auth.context), errorCode("TF_ADMISSION_BINDING_CONFLICT"));
			assert.equal((await store.renew(row.reservation.reservationId, {}, auth.context)).reservation.reservedExpiresAt, undefined);
		}
	} finally { store.close(); }
});

test("P16 project admission is proven, unique, and cannot commit after proof crosses TTL", async () => {
	const directory = makePath(), auth = authority(3), store = await openCoordinatorStore(directory, auth.options);
	try {
		const first = binding(); await admitted(store, auth.context, first);
		const second = { ...first, reservationId: randomUUID() }; await store.reserve(second, auth.context);
		const before = bytes(directory);
		await assert.rejects(store.commit(second.reservationId, { projectAdmitCommitSeq: 7 }, auth.context), errorCode("TF_ADMISSION_BINDING_CONFLICT"));
		assert.equal(bytes(directory), before);
		const short = binding({ ttlMs: 30 }); await store.reserve(short, auth.context);
		auth.waitAdmission(() => sleep(40));
		await assert.rejects(store.commit(short.reservationId, { projectAdmitCommitSeq: 7 }, auth.context), errorCode("TF_ADMISSION_BINDING_CONFLICT"));
		assert.equal((await store.readReservation(short.reservationId, auth.context))!.reservation.state, "expired");
	} finally { store.close(); }
});

test("P16 a wrong admission commit sequence never crosses the global capacity binding", async () => {
	const directory = makePath(), auth = authority(1), store = await openCoordinatorStore(directory, auth.options);
	try {
		const input = binding(); await store.reserve(input, auth.context); auth.admission({ projectAdmitCommitSeq: 6 });
		const before = bytes(directory);
		await assert.rejects(store.commit(input.reservationId, { projectAdmitCommitSeq: 7 }, auth.context), errorCode("TF_ADMISSION_BINDING_CONFLICT"));
		assert.equal(bytes(directory), before); assert.equal((await store.snapshot(auth.context)).capacity.reserved, 1);
	} finally { store.close(); }
});

for (const [name, proof] of Object.entries({ liveChild: { providerNoLiveProcessTree: false }, ambiguousJob: { noAmbiguousJobs: false }, reconcileTimeout: { reconcileTimeoutOnly: true }, staleSeq: { projectAdmitCommitSeq: 6 }, staleVersion: { runVersion: 0 }, wrongProject: { projectId: randomUUID() }, unknown: { status: "unknown" }, parkedNoReadmission: { status: "paused", stage: "parked", requiresReadmission: false } })) {
	 test(`P16 normalRelease rejects ${name} without changing authoritative bytes`, async () => {
		const directory = makePath(), auth = authority(), store = await openCoordinatorStore(directory, auth.options);
		try {
			const row = await admitted(store, auth.context); auth.release(proof);
			const before = bytes(directory);
			await assert.rejects(store.normalRelease(row.reservation.reservationId, auth.context), errorCode("TF_RECONCILE_REQUIRED"));
			assert.equal(bytes(directory), before); assert.equal((await store.snapshot(auth.context)).capacity.active, 1);
		} finally { store.close(); }
	});
}

test("P16 parked release, concurrent retries and restart preserve prior row and allow fresh readmission", async () => {
	const directory = makePath(), auth = authority(1); let store = await openCoordinatorStore(directory, auth.options);
	try {
		const input = binding(), row = await admitted(store, auth.context, input);
		auth.release({ status: "paused", stage: "parked", requiresReadmission: true });
		const releases = await Promise.all(Array.from({ length: 8 }, () => store.normalRelease(row.reservation.reservationId, auth.context)));
		for (const result of releases) assert.deepEqual(result, releases[0]);
		const before = bytes(directory); store.close(); store = await openCoordinatorStore(directory, auth.options);
		assert.deepEqual(await store.normalRelease(input.reservationId, auth.context), releases[0]); assert.equal(bytes(directory), before);
		const newContext = auth.issue({ principal: "user:one", ownerId: "owner:fresh", operator: false });
		const fresh = await admitted(store, newContext, { ...input, reservationId: randomUUID() });
		assert.equal(fresh.ownerId, "owner:fresh"); assert.notEqual(fresh.reservation.reservationId, input.reservationId);
		await assert.rejects(store.normalRelease(input.reservationId, newContext), errorCode("TF_AUTHORITY_REVOKED"));
	} finally { store.close(); }
});

test("P16 forceRelease requires operator+risk, durable command hash/principal and fresh replay authorization", async () => {
	const directory = makePath(), auth = authority(1); let store = await openCoordinatorStore(directory, auth.options);
	try {
		const row = await admitted(store, auth.context), input = { commandId: randomUUID(), riskAcknowledgement: true as const, reason: "operator reviewed unknown provider" };
		const before = bytes(directory);
		await assert.rejects(store.forceRelease(row.reservation.reservationId, input, auth.context), errorCode("TF_POLICY_DENIED"));
		await assert.rejects(store.forceRelease(row.reservation.reservationId, { ...input, riskAcknowledgement: false as unknown as true }, auth.operator), errorCode("TF_POLICY_DENIED"));
		assert.equal(bytes(directory), before);
		const released = await store.forceRelease(row.reservation.reservationId, input, auth.operator);
		assert.equal(released.concurrencyGuarantee, "operator-overridden"); assert.equal((await store.snapshot(auth.operator)).capacity.active, 0);
		const published = bytes(directory); store.close(); store = await openCoordinatorStore(directory, auth.options);
		assert.deepEqual(await store.forceRelease(row.reservation.reservationId, input, auth.operator), released); assert.equal(bytes(directory), published);
		await assert.rejects(store.forceRelease(row.reservation.reservationId, { ...input, reason: "changed" }, auth.operator), errorCode("TF_IDEMPOTENCY_CONFLICT"));
		const other = auth.issue({ principal: "operator:other", ownerId: "owner:other", operator: true });
		await assert.rejects(store.forceRelease(row.reservation.reservationId, input, other), errorCode("TF_CROSS_PRINCIPAL_COMMAND"));
		auth.revoke(); await assert.rejects(store.forceRelease(row.reservation.reservationId, input, auth.operator), errorCode("TF_AUTHORITY_REVOKED"));
		assert.equal(bytes(directory), published);
	} finally { store.close(); }
});

test("P16 capacity command cannot overbook or replay a different request and command outputs are detached", async () => {
	const directory = makePath(), auth = authority(2), store = await openCoordinatorStore(directory, auth.options);
	try {
		await admitted(store, auth.context); await admitted(store, auth.context);
		await assert.rejects(store.setMaxActiveRuns({ commandId: randomUUID(), maxActiveRuns: 1 }, auth.operator), errorCode("TF_CAPACITY_EXCEEDED"));
		const input = { commandId: randomUUID(), maxActiveRuns: 3 };
		assert.equal(await store.setMaxActiveRuns(input, auth.operator), 3);
		const before = bytes(directory), command = await store.readCommand(input.commandId, auth.operator);
		command!.record.callerPrincipal = "attacker";
		assert.equal(await store.setMaxActiveRuns(input, auth.operator), 3); assert.equal(bytes(directory), before);
		await assert.rejects(store.setMaxActiveRuns({ ...input, maxActiveRuns: 4 }, auth.operator), errorCode("TF_IDEMPOTENCY_CONFLICT"));
	} finally { store.close(); }
});

for (const change of ["revoke", "epoch", "expired", "close"] as const) {
	test(`P16 ${change} during asynchronous provider proof aborts publication`, async () => {
		const directory = makePath(), auth = authority(), store = await openCoordinatorStore(directory, auth.options);
		try {
			const row = await admitted(store, auth.context), entered = deferred(), proceed = deferred();
			auth.waitRelease(async () => { entered.resolve(); await proceed.promise; });
			const before = bytes(directory), pending = store.normalRelease(row.reservation.reservationId, auth.context);
			await entered.promise;
			if (change === "revoke") auth.revoke(); else if (change === "epoch") auth.lease(2); else if (change === "expired") auth.lease(1, true); else store.close();
			proceed.resolve(); await assert.rejects(pending, errorCode(change === "close" ? "TF_DURABILITY_FAILED" : "TF_AUTHORITY_REVOKED"));
			assert.equal(bytes(directory), before);
		} finally { store.close(); }
	});
}

test("P16 newer persistent epoch fences an otherwise live old host", async () => {
	const directory = makePath(), oldAuth = authority(), old = await openCoordinatorStore(directory, oldAuth.options), newAuth = authority(2, 2);
	const newer = await openCoordinatorStore(directory, newAuth.options);
	try { const before = bytes(directory); await assert.rejects(old.reserve(binding(), oldAuth.context), errorCode("TF_AUTHORITY_REVOKED")); assert.equal(bytes(directory), before); assert.equal((await newer.snapshot(newAuth.context)).fencingEpoch, 2); }
	finally { old.close(); newer.close(); }
});

test("P16 authority lease which expires while being read does not permit publication", async () => {
	const directory = makePath(), auth = authority(), store = await openCoordinatorStore(directory, auth.options);
	try {
		const before = bytes(directory);
		auth.options.authority.readLease = async () => { const expiresAt = Date.now() + 10; await sleep(25); return { holderId: "fixture-host", fencingEpoch: 1, endpoint: "test://coordinator", expiresAt }; };
		await assert.rejects(store.reserve(binding(), auth.context), errorCode("TF_AUTHORITY_REVOKED"));
		assert.equal(bytes(directory), before);
	} finally { store.close(); }
});

for (const crash of ["before-state-write", "after-state-write"] as const) {
	test(`P16 SIGKILL ${crash} recovers complete reserve and admission states`, { timeout: 30_000 }, async () => {
		const directory = makePath(), auth = authority(1); let store = await openCoordinatorStore(directory, auth.options);
		try {
			const input = binding(), identity = { principal: "user:one", ownerId: "owner:one", operator: false };
			const child = await runWorker({ path: directory, max: 1, mode: "reserve", input, identity, crash });
			assert.equal(child.signal, "SIGKILL", child.stderr + child.stdout);
			store.close(); store = await openCoordinatorStore(directory, auth.options);
			assert.equal((await store.snapshot(auth.context)).capacity.active, crash === "before-state-write" ? 0 : 1);
			await store.reserve(input, auth.context);
			const commit = await runWorker({ path: directory, max: 1, mode: "commit", input, identity, crash });
			assert.equal(commit.signal, "SIGKILL", commit.stderr + commit.stdout);
			store.close(); store = await openCoordinatorStore(directory, auth.options);
			const row = await store.readReservation(input.reservationId, auth.context);
			assert.equal(row!.reservation.state, crash === "before-state-write" ? "reserved" : "committed");
			assert.equal((await store.snapshot(auth.context)).capacity.active, 1);
		} finally { store.close(); }
	});
}

for (const mode of ["normalRelease", "forceRelease"] as const) {
	for (const crash of ["before-state-write", "after-state-write"] as const) {
		test(`P16 ${mode} SIGKILL ${crash} preserves complete capacity/result/audit`, { timeout: 30_000 }, async () => {
			const directory = makePath(), auth = authority(1); let store = await openCoordinatorStore(directory, auth.options);
			try {
				const input = binding(); await admitted(store, auth.context, input);
				const commandId = randomUUID(), identity = mode === "forceRelease" ? { principal: "operator:one", ownerId: "owner:operator", operator: true } : { principal: "user:one", ownerId: "owner:one", operator: false };
				const result = await runWorker({ path: directory, max: 1, mode, input, identity, crash, commandId });
				assert.equal(result.signal, "SIGKILL", result.stderr + result.stdout);
				store.close(); store = await openCoordinatorStore(directory, auth.options);
				assert.equal((await store.snapshot(auth.context)).capacity.active, crash === "before-state-write" ? 1 : 0);
				const context = mode === "forceRelease" ? auth.operator : auth.context;
				const retry = () => mode === "forceRelease" ? store.forceRelease(input.reservationId, { commandId, riskAcknowledgement: true, reason: "operator reviewed unknown provider" }, context) : store.normalRelease(input.reservationId, context);
				const released = await retry(), published = bytes(directory);
				assert.deepEqual(await retry(), released); assert.equal(bytes(directory), published);
				if (mode === "forceRelease") assert.equal((await store.readCommand(commandId, auth.operator))!.record.status, "completed");
			} finally { store.close(); }
		});
	}
}

test("P16 eight process-level release retries preserve one durable released record", { timeout: 30_000 }, async () => {
	const directory = makePath(), auth = authority(1), store = await openCoordinatorStore(directory, auth.options);
	try {
		const input = binding(); await admitted(store, auth.context, input);
		const results = await Promise.all(Array.from({ length: 8 }, () => runWorker({ path: directory, mode: "normalRelease", max: 1, input, identity: { principal: "user:one", ownerId: "owner:one", operator: false } })));
		for (const result of results) { assert.equal(result.data?.ok, true, result.stderr + result.stdout); assert.deepEqual(result.data?.result, results[0]!.data?.result); }
		const raw = JSON.parse(bytes(directory)); assert.equal(raw.audit.filter((r: { action: string }) => r.action === "normalRelease").length, 1);
		assert.equal((await store.snapshot(auth.context)).capacity.active, 0);
	} finally { store.close(); }
});

test("P16 reopened store rejects backward wall clock without reclaim or publication", async () => {
	const directory = makePath(), auth = authority(), store = await openCoordinatorStore(directory, auth.options);
	try {
		await admitted(store, auth.context); const before = bytes(directory);
		const result = await runWorker({ path: directory, mode: "snapshot", input: binding(), identity: { principal: "user:one", ownerId: "owner:one", operator: false }, clockOffset: -60_000 });
		assert.equal(result.data?.code, "TF_AUTHORITY_REVOKED"); assert.equal(bytes(directory), before);
	} finally { store.close(); }
});

test("P16 project-admit fsync then host SIGKILL before coordinator commit must never TTL-free its run", { timeout: 20_000 }, async () => {
	const directory = makePath(), auth = authority(1); auth.projectLedger(directory);
	let store = await openCoordinatorStore(directory, auth.options);
	try {
		const input = binding({ ttlMs: 3000 }); await store.reserve(input, auth.context);
		const child = await runWorker({ path: directory, max: 1, mode: "persist-admission", input, identity: { principal: "user:one", ownerId: "owner:one", operator: false } });
		assert.equal(child.signal, "SIGKILL", child.stderr + child.stdout);
		const before = JSON.parse(bytes(directory)); assert.equal(before.reservations[input.reservationId].reservation.state, "reserved");
		await sleep(Math.max(0, before.reservations[input.reservationId].reservation.reservedExpiresAt - Date.now()) + 30);
		store.close(); store = await openCoordinatorStore(directory, auth.options);
		const recovered = await store.readReservation(input.reservationId, auth.context);
		assert.equal(recovered!.reservation.state, "committed"); assert.equal(recovered!.reservation.projectAdmitCommitSeq, 7); assert.equal(recovered!.reservation.reservedExpiresAt, undefined);
		assert.equal((await store.snapshot(auth.context)).capacity.active, 1);
		await assert.rejects(store.reserve(binding(), auth.context), errorCode("TF_CAPACITY_EXCEEDED"));
	} finally { store.close(); }
});

test("P16 unavailable admission evidence retains expired reserved capacity", async () => {
	const directory = makePath(), auth = authority(1), store = await openCoordinatorStore(directory, auth.options);
	try {
		const input = binding({ ttlMs: 30 }); await store.reserve(input, auth.context); auth.unavailableAdmission(); await sleep(50);
		const before = bytes(directory);
		assert.equal((await store.snapshot(auth.context)).capacity.active, 1);
		assert.equal((await store.readReservation(input.reservationId, auth.context))!.reservation.state, "reserved");
		await assert.rejects(store.reserve(binding(), auth.context), errorCode("TF_CAPACITY_EXCEEDED")); assert.equal(bytes(directory), before);
	} finally { store.close(); }
});

test("P16 failed project ledger read and another reservation's admission proof both retain expired capacity", async () => {
	const directory = makePath(), auth = authority(1), store = await openCoordinatorStore(directory, auth.options);
	try {
		const input = binding({ ttlMs: 30 }); await store.reserve(input, auth.context); await sleep(50);
		const before = bytes(directory);
		auth.options.authority.readAdmission = () => { throw new Error("project ledger unavailable"); };
		assert.equal((await store.snapshot(auth.context)).capacity.active, 1); assert.equal(bytes(directory), before);
		auth.options.authority.readAdmission = () => ({ ...input, reservationId: randomUUID(), projectAdmitCommitSeq: 7, runVersion: 1 });
		assert.equal((await store.snapshot(auth.context)).capacity.active, 1); assert.equal(bytes(directory), before);
	} finally { store.close(); }
});

test("P16 missing authoritative state cannot bootstrap over committed capacity", async () => {
	const directory = makePath(), auth = authority(1), store = await openCoordinatorStore(directory, auth.options);
	await admitted(store, auth.context); store.close();
	const file = path.join(directory, "coordinator.json"), displaced = path.join(directory, "displaced-coordinator.json");
	fs.renameSync(file, displaced); const original = fs.readFileSync(displaced, "utf8"), genesis = fs.readFileSync(path.join(directory, "coordinator.identity.json"), "utf8");
	await assert.rejects(openCoordinatorStore(directory, auth.options), errorCode("TF_DURABILITY_FAILED"));
	assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(displaced, "utf8"), original); assert.equal(fs.readFileSync(path.join(directory, "coordinator.identity.json"), "utf8"), genesis);
	fs.renameSync(displaced, file); const recovered = await openCoordinatorStore(directory, auth.options);
	try { assert.equal((await recovered.snapshot(auth.context)).capacity.active, 1); await assert.rejects(recovered.reserve(binding(), auth.context), errorCode("TF_CAPACITY_EXCEEDED")); } finally { recovered.close(); }
});

// Build valid legacy state, including a recomputed audit digest, so this checks
// the semantic D3 invariant rather than merely tripping a checksum mismatch.
function editDurableState(directory: string, edit: (state: any) => void) {
	const state = JSON.parse(bytes(directory)); edit(state);
	const last = state.audit.at(-1); last.stateDigest = commandRequestHash({ fencingEpoch: state.fencingEpoch, maxActiveRuns: state.maxActiveRuns, reservations: state.reservations, commands: state.commands });
	const { hash: _auditHash, ...auditBody } = last; last.hash = commandRequestHash(auditBody);
	const { stateHash: _stateHash, ...body } = state; state.stateHash = commandRequestHash(body);
	fs.writeFileSync(path.join(directory, "coordinator.json"), JSON.stringify(state));
}
for (const state of ["released", "expired", "committed", "orphan-suspect"] as const) {
	test(`P16 legacy TTL residue on ${state} ${state === "released" || state === "expired" ? "reopens" : "fails closed"}`, async () => {
		const directory = makePath(), auth = authority(), store = await openCoordinatorStore(directory, auth.options);
		const row = await admitted(store, auth.context); store.close();
		editDurableState(directory, (data) => { const target = data.reservations[row.reservation.reservationId].reservation; target.state = state; target.reservedExpiresAt = Date.now() + 60_000; });
		const before = bytes(directory);
		if (state === "released" || state === "expired") { const reopened = await openCoordinatorStore(directory, auth.options); try { assert.equal((await reopened.snapshot(auth.context)).capacity.active, 0); } finally { reopened.close(); } }
		else await assert.rejects(openCoordinatorStore(directory, auth.options), errorCode("TF_ADMISSION_BINDING_CONFLICT"));
		assert.equal(bytes(directory), before);
	});
}

test("P16 reopening rejects a semantically duplicated admitted binding even with valid checksums", async () => {
	const directory = makePath(), auth = authority(2), store = await openCoordinatorStore(directory, auth.options);
	const row = await admitted(store, auth.context); store.close();
	editDurableState(directory, (data) => {
		const id = randomUUID(), duplicate = structuredClone(data.reservations[row.reservation.reservationId]);
		duplicate.reservation.reservationId = id; duplicate.reservation.state = "orphan-suspect"; data.reservations[id] = duplicate;
	});
	const before = bytes(directory);
	await assert.rejects(openCoordinatorStore(directory, auth.options), errorCode("TF_ADMISSION_BINDING_CONFLICT")); assert.equal(bytes(directory), before);
});

test("P16 host cannot open without all trusted authority callbacks", async () => {
	const directory = makePath(), auth = authority();
	const invalid = { ...auth.options, authority: { ...auth.options.authority, readRelease: undefined } } as unknown as CoordinatorStoreOptions<Context>;
	await assert.rejects(openCoordinatorStore(directory, invalid), errorCode("TF_AUTHORITY_REVOKED"));
	assert.equal(fs.existsSync(path.join(directory, "coordinator.json")), false);
});

test("P16 copied/moved authority, tampered audit and symlink state fail closed", async () => {
	const directory = makePath(), auth = authority(), store = await openCoordinatorStore(directory, auth.options);
	await admitted(store, auth.context); store.close();
	const copy = directory + "-copy"; fs.cpSync(directory, copy, { recursive: true });
	const copiedBytes = bytes(copy); await assert.rejects(openCoordinatorStore(copy, auth.options), errorCode("TF_DURABILITY_FAILED")); assert.equal(bytes(copy), copiedBytes);
	const moved = directory + "-moved"; fs.renameSync(directory, moved);
	await assert.rejects(openCoordinatorStore(moved, auth.options), errorCode("TF_DURABILITY_FAILED"));
	fs.renameSync(moved, directory);
	const original = bytes(directory), raw = JSON.parse(original); raw.audit[0].action = "forged"; fs.writeFileSync(path.join(directory, "coordinator.json"), JSON.stringify(raw));
	await assert.rejects(openCoordinatorStore(directory, auth.options), errorCode("TF_DURABILITY_FAILED"));
	fs.writeFileSync(path.join(directory, "coordinator.json"), original); fs.renameSync(path.join(directory, "coordinator.json"), path.join(directory, "outside.json"));
	fs.symlinkSync(path.join(directory, "outside.json"), path.join(directory, "coordinator.json"));
	await assert.rejects(openCoordinatorStore(directory, auth.options), errorCode("TF_DURABILITY_FAILED")); assert.equal(fs.readFileSync(path.join(directory, "outside.json"), "utf8"), original);
});

async function waitForQueueSize(directory: string, minimum: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const entries = fs.readdirSync(path.join(directory, "writer.lock.queue"));
		if (entries.length >= minimum) return;
		await sleep(5);
	}
	assert.fail(`expected ${minimum} actual persistent mutex contenders`);
}

test("P16 dispatch holds persistent capacity fence through preparation and synchronous launch against another process", { timeout: 20_000 }, async () => {
	const directory = makePath(), auth = authority(1), store = await openCoordinatorStore(directory, auth.options);
	const entered = deferred(), proceed = deferred();
	let activations = 0, releaseFinished = false;
	try {
		const input = binding(), row = await admitted(store, auth.context, input);
		const dispatch = store.withDispatch(input.reservationId, auth.context, async (observed) => {
			assert.deepEqual(observed, row); entered.resolve(); await proceed.promise;
			return () => {
				assert.equal(releaseFinished, false);
				assert.equal(JSON.parse(bytes(directory)).reservations[input.reservationId].reservation.state, "committed");
				activations++; return "activated";
			};
		});
		await entered.promise;
		const releasing = runWorker({ path: directory, mode: "forceRelease", max: 1,
			identity: { principal: "operator:one", ownerId: "owner:operator", operator: true }, input,
			commandId: randomUUID() }).then((result) => { releaseFinished = true; return result; });
		await waitForQueueSize(directory, 2);
		assert.equal(releaseFinished, false); assert.equal(activations, 0);
		assert.equal(JSON.parse(bytes(directory)).reservations[input.reservationId].reservation.state, "committed");
		proceed.resolve(); assert.equal(await dispatch, "activated");
		assert.equal((await releasing).data?.ok, true); assert.equal(activations, 1);
		assert.equal((await store.readReservation(input.reservationId, auth.context))?.reservation.state, "released");
		await assert.rejects(store.withDispatch(input.reservationId, auth.context, async () => () => { activations++; }), errorCode("TF_ADMISSION_BINDING_CONFLICT"));
		assert.equal(activations, 1);
	} finally { proceed.resolve(); store.close(); }
});

for (const changed of ["epoch", "expired", "revoked", "closed"] as const) {
	test(`P16 dispatch denies ${changed} authority after asynchronous preparation before activation`, async () => {
		const directory = makePath(), auth = authority(1), store = await openCoordinatorStore(directory, auth.options);
		const entered = deferred(), proceed = deferred(); let activations = 0;
		try {
			const input = binding(); await admitted(store, auth.context, input); const before = bytes(directory);
			const dispatch = store.withDispatch(input.reservationId, auth.context, async () => {
				entered.resolve(); await proceed.promise; return () => { activations++; };
			});
			await entered.promise;
			if (changed === "epoch") auth.lease(2);
			else if (changed === "expired") auth.lease(1, true);
			else if (changed === "revoked") auth.revoke();
			else store.close();
			proceed.resolve();
			await assert.rejects(dispatch, errorCode(changed === "closed" ? "TF_DURABILITY_FAILED" : "TF_AUTHORITY_REVOKED"));
			assert.equal(activations, 0); assert.equal(bytes(directory), before);
		} finally { proceed.resolve(); store.close(); }
	});
}

test("P16 preparing dispatch cannot make a second process overbook committed capacity", { timeout: 20_000 }, async () => {
	const directory = makePath(), auth = authority(1), store = await openCoordinatorStore(directory, auth.options);
	const entered = deferred(), proceed = deferred(); let activated = false;
	try {
		const input = binding(); await admitted(store, auth.context, input);
		const dispatch = store.withDispatch(input.reservationId, auth.context, async () => {
			entered.resolve(); await proceed.promise; return () => { activated = true; };
		});
		await entered.promise;
		const racing = runWorker({ path: directory, mode: "reserve", max: 1,
			identity: { principal: "other", ownerId: "other", operator: false }, input: binding() });
		await waitForQueueSize(directory, 2); assert.equal(activated, false);
		proceed.resolve(); await dispatch;
		assert.equal((await racing).data?.code, "TF_CAPACITY_EXCEEDED");
		assert.equal((await store.snapshot(auth.context)).capacity.active, 1);
	} finally { proceed.resolve(); store.close(); }
});

for (const changed of ["expired", "closed"] as const) {
	test(`P16 dispatch denies ${changed} during final awaited lease read`, async () => {
		const directory = makePath(), auth = authority(1), store = await openCoordinatorStore(directory, auth.options);
		const entered = deferred(), proceed = deferred(); let preparing = false, activations = 0;
		const readLease = auth.options.authority.readLease;
		try {
			const input = binding(); await admitted(store, auth.context, input);
			auth.options.authority.readLease = async () => {
				const lease = await readLease();
				if (preparing) {
					entered.resolve(); await proceed.promise;
					if (changed === "expired") lease!.expiresAt = Date.now() - 1;
				}
				return lease;
			};
			const dispatch = store.withDispatch(input.reservationId, auth.context, async () => {
				preparing = true; return () => { activations++; };
			});
			await entered.promise; if (changed === "closed") store.close(); proceed.resolve();
			await assert.rejects(dispatch, errorCode(changed === "closed" ? "TF_DURABILITY_FAILED" : "TF_AUTHORITY_REVOKED"));
			assert.equal(activations, 0);
		} finally { proceed.resolve(); store.close(); }
	});
}
