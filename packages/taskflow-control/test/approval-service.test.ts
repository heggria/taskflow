import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { ControlError } from "../src/errors.ts";
import type { VerifiedContext } from "../src/authorization.ts";
import type { ApprovalDecisionInput } from "../src/approval-service.ts";
import { approvalFixture } from "./fixtures/approval-worker.ts";

type Fixture = Awaited<ReturnType<typeof approvalFixture>>;
async function fixtureCase(fn: (f: Fixture, directory: string) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "tf-approval-"));
	let fixture: Fixture | undefined;
	try { fixture = await approvalFixture(directory); await fn(fixture, directory); }
	finally { fixture?.close(); rmSync(directory, { recursive: true, force: true }); }
}
const errorCode = (code: string) => (error: unknown) => error instanceof ControlError && error.code === code;
function decision(f: Fixture, requestId: string, kind: ApprovalDecisionInput["decision"] = "approve"): ApprovalDecisionInput {
	return { commandId: randomUUID(), runId: f.runId, approvalRequestId: requestId, expectedRunVersion: f.store.readRun(f.runId)!.runVersion, decision: kind };
}

test("durable request journals park before actual P16 release; pending CAS version follows release ack", async () => fixtureCase(async (f) => {
	const request = await f.service.request(f.context, f.request());
	const run = f.store.readRun(f.runId)!;
	assert.equal(request.status, "pending");
	assert.equal(run.status, "paused"); assert.equal(run.stage, "parked"); assert.equal(run.slot, "released");
	assert.equal(request.expectedRunVersion, run.runVersion);
	assert.equal((await f.coordinator.snapshot(f.context)).capacity.active, 0);
	assert.equal(f.store.readOutbox(f.runId).find((item) => item.kind === "approval.release")?.complete, true);
}));

test("three modes preserve headless rejection, negotiated optional durability and required feature failure", async () => {
	for (const mode of ["compat-auto-reject", "durable-optional", "durable-required"] as const) {
		await fixtureCase(async (f) => {
			f.set({ durable: false }); const seq = f.store.commitSeq;
			if (mode === "durable-required") {
				await assert.rejects(f.service.request(f.context, f.request({ mode })), errorCode("TF_FEATURE_REQUIRED"));
				assert.equal(f.store.commitSeq, seq);
			} else {
				const request = await f.service.request(f.context, f.request({ mode }));
				assert.equal(request.status, "rejected"); assert.equal(f.store.readRun(f.runId)!.status, "blocked");
				assert.equal((await f.coordinator.snapshot(f.context)).capacity.active, 0);
			}
		});
	}
	await fixtureCase(async (f) => assert.equal((await f.service.request(f.context, f.request({ mode: "durable-optional" }))).status, "pending"));
});

test("forged service context and unreached phase fail without journal mutation", async () => fixtureCase(async (f) => {
	const seq = f.store.commitSeq;
	await assert.rejects(f.service.request({ callerPrincipal: `os-user:${process.getuid?.() ?? 1000}` } as unknown as VerifiedContext, f.request()), errorCode("TF_AUTHORITY_REVOKED"));
	await assert.rejects(f.service.request(f.context, f.request({ nodeInstanceId: "invented" })), errorCode("TF_COMMAND_FAILED"));
	assert.equal(f.store.commitSeq, seq);
}));

test("two authenticated clients race one runVersion: exactly one decision command commits", async () => fixtureCase(async (f) => {
	const request = await f.service.request(f.context, f.request());
	const first = decision(f, request.approvalRequestId), second = { ...first, commandId: randomUUID(), decision: "reject" as const };
	const results = await Promise.allSettled([f.service.decide(f.context, first), f.service.decide(f.secondContext, second)]);
	assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
	assert.equal(results.filter((item) => item.status === "rejected" && errorCode("TF_STALE_VERSION")(item.reason)).length, 1);
	assert.equal([f.store.readCommand(first.commandId), f.store.readCommand(second.commandId)].filter(Boolean).length, 1);
	assert.notEqual(f.store.readApproval(request.approvalRequestId)!.status, "pending");
}));

test("deadline expires during trusted edit validation: no late approve/edit command survives", async () => fixtureCase(async (f) => {
	const request = await f.service.request(f.context, f.request({ deadline: Date.now() + 1000 }));
	f.set({ editDelay: 1100 });
	const edit = { ...decision(f, request.approvalRequestId, "edit"), editKind: "output" as const, editArtifactRef: f.artifact() };
	await assert.rejects(f.service.decide(f.context, edit), errorCode("TF_STALE_VERSION"));
	assert.equal(f.store.readApproval(request.approvalRequestId)!.status, "expired");
	assert.equal(f.store.readRun(f.runId)!.status, "blocked"); assert.equal(f.store.readCommand(edit.commandId), undefined);
	await assert.rejects(f.service.decide(f.context, decision(f, request.approvalRequestId)), errorCode("TF_STALE_VERSION"));
}));

test("cancel wins before decide, and approve then cancel cannot be resurrected by park/drain", async () => {
	for (const approveFirst of [false, true]) await fixtureCase(async (f) => {
		const request = await f.service.request(f.context, f.request()), old = decision(f, request.approvalRequestId);
		if (approveFirst) await f.service.decide(f.context, old);
		await f.service.cancel(f.context, { commandId: randomUUID(), runId: f.runId, expectedRunVersion: f.store.readRun(f.runId)!.runVersion });
		const terminal = f.store.readRun(f.runId)!;
		assert.equal(terminal.status, "cancelled");
		await assert.rejects(f.service.park(f.context, { runId: f.runId, expectedRunVersion: terminal.runVersion }), errorCode("TF_STALE_VERSION"));
		await f.service.drainReleases(f.context);
		assert.equal(f.store.readRun(f.runId)!.status, "cancelled"); assert.equal(f.store.readRun(f.runId)!.stage, "terminal");
		if (!approveFirst) {
			assert.equal(f.store.readApproval(request.approvalRequestId)!.status, "cancelled");
			await assert.rejects(f.service.decide(f.context, old), errorCode("TF_STALE_VERSION"));
		}
	});
});

test("non-quiescent rejection holds capacity until fresh terminal settlement; history never reopens", async () => fixtureCase(async (f) => {
	f.set({ quiescent: false });
	const request = await f.service.request(f.context, f.request());
	assert.equal(f.store.readRun(f.runId)!.stage, "reconciling");
	await f.service.decide(f.context, decision(f, request.approvalRequestId, "reject"));
	assert.equal(f.store.readRun(f.runId)!.status, "blocked"); assert.equal((await f.coordinator.snapshot(f.context)).capacity.active, 1);
	await assert.rejects(f.service.releaseTerminal(f.context, { runId: f.runId, expectedRunVersion: f.store.readRun(f.runId)!.runVersion }), errorCode("TF_RECONCILE_REQUIRED"));
	f.set({ quiescent: true });
	await f.service.releaseTerminal(f.context, { runId: f.runId, expectedRunVersion: f.store.readRun(f.runId)!.runVersion });
	assert.equal(f.store.readRun(f.runId)!.status, "blocked"); assert.equal(f.store.readRun(f.runId)!.slot, "released");
	assert.equal((await f.coordinator.snapshot(f.context)).capacity.active, 0);
}));

test("edited guidance is contract checked and persisted; only plan edits require re-Link", async () => {
	for (const editKind of ["output", "plan"] as const) await fixtureCase(async (f) => {
		const request = await f.service.request(f.context, f.request()), artifact = f.artifact();
		const edit = { ...decision(f, request.approvalRequestId, "edit"), editKind, editArtifactRef: artifact };
		f.set({ invalidEdit: true });
		await assert.rejects(f.service.decide(f.context, edit), errorCode("TF_COMMAND_FAILED"));
		assert.equal(f.store.readApproval(request.approvalRequestId)!.status, "pending");
		f.set({ invalidEdit: false }); await f.service.decide(f.context, edit);
		assert.deepEqual(f.store.readApproval(request.approvalRequestId)!.editArtifactRef, artifact);
		assert.equal(f.store.readApproval(request.approvalRequestId)!.status, "edited");
		await f.service.readmit(f.context, { approvalRequestId: request.approvalRequestId, expectedRunVersion: f.store.readRun(f.runId)!.runVersion });
		assert.equal(f.relinks(), editKind === "plan" ? 1 : 0);
	});
});

test("restart preserves pending approval and readmits under fresh policy/reservation/owner/fragment", async () => fixtureCase(async (original, directory) => {
	const old = original.store.readRun(original.runId)!;
	const request = await original.service.request(original.context, original.request());
	original.close();
	const fresh = await approvalFixture(directory);
	try {
		assert.equal((await fresh.service.read(fresh.context, request.approvalRequestId)).status, "pending");
		await fresh.service.decide(fresh.context, decision(fresh, request.approvalRequestId));
		fresh.set({ policyHash: "b".repeat(64) });
		const journal = join(directory, "project-store", "journal", "000001.jsonl"), prefix = readFileSync(journal);
		const run = await fresh.service.readmit(fresh.context, { approvalRequestId: request.approvalRequestId, expectedRunVersion: fresh.store.readRun(fresh.runId)!.runVersion });
		assert.equal(run.stage, "admitted"); assert.equal(run.slot, "committed"); assert.equal(run.policyHash, "b".repeat(64));
		assert.notEqual(run.reservationId, old.reservationId); assert.notEqual(run.owner!.attemptId, old.owner!.attemptId);
		assert.ok(run.boundFragmentHash); assert.equal(run.requiresReadmission, false);
		assert.equal((await fresh.coordinator.snapshot(fresh.context)).capacity.active, 1);
		assert.deepEqual(readFileSync(journal).subarray(0, prefix.length), prefix, "old journal bytes are never rewritten");
	} finally { fresh.close(); }
}));

test("durable release and admission outboxes resume after both cross-ledger interruption windows", async () => {
	for (const window of ["release", "admission"] as const) await fixtureCase(async (original, directory) => {
		let requestId: string;
		if (window === "release") {
			original.set({ releaseFailure: true });
			await assert.rejects(original.service.request(original.context, original.request()), /interruption after coordinator release/);
			requestId = original.store.listApprovals()[0].approvalRequestId;
		} else {
			requestId = (await original.service.request(original.context, original.request())).approvalRequestId;
			await original.service.decide(original.context, decision(original, requestId)); original.set({ commitFailure: true });
			await assert.rejects(original.service.readmit(original.context, { approvalRequestId: requestId, expectedRunVersion: original.store.readRun(original.runId)!.runVersion }), /interruption before coordinator commit/);
		}
		original.close(); const fresh = await approvalFixture(directory);
		try {
			if (window === "release") { await fresh.service.drainReleases(fresh.context); assert.equal(fresh.store.readRun(fresh.runId)!.slot, "released"); }
			else {
				await fresh.service.readmit(fresh.context, { approvalRequestId: requestId, expectedRunVersion: fresh.store.readRun(fresh.runId)!.runVersion });
				assert.equal(fresh.store.readRun(fresh.runId)!.slot, "committed");
			}
			assert.ok(fresh.store.readOutbox(fresh.runId).every((item) => item.complete));
		} finally { fresh.close(); }
	});
});

test("revocation and stale owner block admission; fake principal cannot disclose pending history", async () => fixtureCase(async (f) => {
	const request = await f.service.request(f.context, f.request());
	await assert.rejects(f.service.read({ callerPrincipal: request.owner } as unknown as VerifiedContext, request.approvalRequestId), errorCode("TF_AUTHORITY_REVOKED"));
	await f.service.decide(f.context, decision(f, request.approvalRequestId));
	f.set({ reusedOwner: true });
	await assert.rejects(f.service.readmit(f.context, { approvalRequestId: request.approvalRequestId, expectedRunVersion: f.store.readRun(f.runId)!.runVersion }), errorCode("TF_AUTHORITY_REVOKED"));
	f.set({ reusedOwner: false, revoked: true }); const seq = f.store.commitSeq;
	await assert.rejects(f.service.readmit(f.context, { approvalRequestId: request.approvalRequestId, expectedRunVersion: f.store.readRun(f.runId)!.runVersion }), errorCode("TF_AUTHORITY_REVOKED"));
	assert.equal(f.store.commitSeq, seq); assert.equal(f.store.readRun(f.runId)!.stage, "queued");
}));

test("real worker process persists pending decision across SIGKILL and fresh-host admission", { skip: process.platform === "win32" }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "tf-approval-process-"));
	const children: ReturnType<typeof spawn>[] = [], exited = new Set<ReturnType<typeof spawn>>();
	function start() {
		const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types", join(import.meta.dirname, "fixtures", "approval-worker.ts")],
			{ env: { ...process.env, TF_APPROVAL_WORKER_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
		children.push(child); let buffer = "", stderr = "";
		const messages: any[] = [], listeners: (() => void)[] = [];
		child.stdout!.on("data", (data) => { buffer += data.toString(); let index: number; while ((index = buffer.indexOf("\n")) >= 0) { messages.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); } listeners.splice(0).forEach((fn) => fn()); });
		child.stderr!.on("data", (data) => { stderr += data.toString(); });
		const closed = new Promise<void>((resolve) => child.once("close", () => { exited.add(child); listeners.splice(0).forEach((fn) => fn()); resolve(); }));
		async function receive(predicate: (value: any) => boolean) {
			const deadline = Date.now() + 15_000;
			while (!messages.some(predicate)) {
				if (exited.has(child)) throw new Error(`worker exited: ${stderr}`);
				if (Date.now() >= deadline) throw new Error(`worker deadline: ${stderr}`);
				await new Promise<void>((resolve) => { const timer = setTimeout(() => { const at = listeners.indexOf(wake); if (at >= 0) listeners.splice(at, 1); resolve(); }, 1000); const wake = () => { clearTimeout(timer); resolve(); }; listeners.push(wake); });
			}
			const at = messages.findIndex(predicate); return messages.splice(at, 1)[0];
		}
		return { child, closed, ready: () => receive((item) => item.ready === true), rpc: async (body: unknown) => {
			const id = randomUUID(); child.stdin!.write(JSON.stringify({ ...(body as object), id }) + "\n");
			const result = await receive((item) => item.id === id); assert.equal(result.ok, true, JSON.stringify(result)); return result.result;
		} };
	}
	try {
		const seed = start(); await seed.ready(); const request = await seed.rpc({ action: "request" });
		seed.child.kill("SIGKILL"); await seed.closed;
		const fresh = start(), ready = await fresh.ready(); assert.equal(ready.runId, request.runId);
		assert.equal((await fresh.rpc({ action: "read", approvalRequestId: request.approvalRequestId })).status, "pending");
		await fresh.rpc({ action: "decide", client: 2, body: { commandId: randomUUID(), runId: request.runId, approvalRequestId: request.approvalRequestId, expectedRunVersion: request.expectedRunVersion, decision: "approve" } });
		const run = await fresh.rpc({ action: "run" });
		const admitted = await fresh.rpc({ action: "readmit", body: { approvalRequestId: request.approvalRequestId, expectedRunVersion: run.runVersion } });
		assert.equal(admitted.stage, "admitted"); assert.equal(admitted.slot, "committed"); assert.ok(admitted.boundFragmentHash);
		fresh.child.stdin!.end(); await fresh.closed;
	} finally {
		await Promise.all(children.filter((child) => !exited.has(child)).map((child) => new Promise<void>((resolve) => { child.once("close", () => resolve()); child.kill("SIGKILL"); })));
		rmSync(directory, { recursive: true, force: true });
	}
});
