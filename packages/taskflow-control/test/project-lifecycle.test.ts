import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { after, test } from "node:test";
import { openControlStore } from "../src/store/store.ts";
import { createControlEvidenceStore } from "../src/store/evidence-adapter.ts";
import { rebindMovedProject, createProjectClone, exportProjectEvidence, type ProjectLifecycleAuthority } from "../src/store/project-lifecycle.ts";
import { ControlError } from "../src/errors.ts";
import type { ApprovalRun } from "../src/approval-service.ts";
import type { ReceiptAssurance } from "../src/schema/evidence.ts";
const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const context = Object.freeze({ token: Symbol("operator") });
const authority: ProjectLifecycleAuthority<object> = { authorize(candidate) {
	if (candidate !== context) throw new ControlError("TF_POLICY_DENIED", "unverified context");
	return { principal: "test:verified-operator", operator: true };
} };
function root() { const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tf-lifecycle-")); roots.push(dir); return dir; }
function bytes(directory: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name of fs.readdirSync(directory, { recursive: true }).sort()) {
		const file = path.join(directory, String(name)); if (fs.statSync(file).isFile()) result[String(name)] = fs.readFileSync(file).toString("base64");
	}
	return result;
}
function run(store: ReturnType<typeof openControlStore>): ApprovalRun {
	return { runId: randomUUID(), projectId: store.header.projectId, controlDomainId: store.header.controlDomainId,
		status: "completed", stage: "terminal", slot: "released", needsOperator: false, runVersion: 0,
		boundPlanHash: "ir:plan", policyHash: "a".repeat(64), authorityEpoch: 1 };
}

test("verified same-inode move preserves IDs and journal bytes then actual store reopens", async () => {
	const base = root(), from = path.join(base, "old"), to = path.join(base, "moved");
	const store = openControlStore(from); store.createRun(run(store)); const header = store.header; store.close();
	const before = bytes(from); fs.renameSync(from, to);
	assert.throws(() => openControlStore(to), { code: "TF_DURABILITY_FAILED" });
	const rebound = await rebindMovedProject(to, context, authority);
	assert.equal(rebound.projectId, header.projectId); assert.equal(rebound.controlDomainId, header.controlDomainId);
	assert.equal(rebound.directoryBinding.canonicalPath, to);
	const after = bytes(to); delete before.header; delete after.header; assert.deepEqual(after, before);
	const reopened = openControlStore(to); assert.equal(reopened.listRuns().length, 1); reopened.close();
});

test("move refuses an actual live writer even after its directory is renamed", async () => {
	const base = root(), from = path.join(base, "old"), to = path.join(base, "moved"), store = openControlStore(from);
	fs.renameSync(from, to); const before = bytes(to);
	try { await assert.rejects(rebindMovedProject(to, context, authority), { code: "TF_DURABILITY_FAILED" }); assert.deepEqual(bytes(to), before); }
	finally { store.close(); }
});

test("copied identity cannot be adopted; clone creates new empty project/domain and preserves copied evidence", async () => {
	const base = root(), source = path.join(base, "source"), copy = path.join(base, "copied"), fresh = path.join(base, "new");
	const store = openControlStore(source); store.createRun(run(store)); const original = store.header; store.close();
	fs.cpSync(source, copy, { recursive: true }); const before = bytes(copy);
	await assert.rejects(rebindMovedProject(copy, context, authority, "adopt"), { code: "TF_DURABILITY_FAILED" });
	const created = await createProjectClone(copy, fresh, context, authority);
	assert.notEqual(created.projectId, original.projectId); assert.notEqual(created.controlDomainId, original.controlDomainId);
	assert.deepEqual(bytes(copy), before); assert.deepEqual(bytes(source), before);
	const reopened = openControlStore(fresh); assert.equal(reopened.commitSeq, 0); assert.deepEqual(reopened.listRuns(), []); reopened.close();
	await assert.rejects(createProjectClone(source, copy, context, authority), { code: "TF_DURABILITY_FAILED" }); assert.deepEqual(bytes(copy), before);
});

test("rebind denies old binding reuse and active/ambiguous project runs", async () => {
	for (const reason of ["old-path", "running", "unknown"] as const) {
		const base = root(), from = path.join(base, "old"), to = path.join(base, "moved"), store = openControlStore(from);
		if (reason !== "old-path") store.createRun({ ...run(store), status: reason, stage: "executing", slot: "committed" });
		store.close(); fs.renameSync(from, to); if (reason === "old-path") fs.mkdirSync(from);
		const before = bytes(to); await assert.rejects(rebindMovedProject(to, context, authority), { code: "TF_DURABILITY_FAILED" }); assert.deepEqual(bytes(to), before);
	}
});

test("operator verification and live authority revocation protect identity changes and export", async () => {
	const base = root(), from = path.join(base, "old"), to = path.join(base, "moved"), store = openControlStore(from); store.close(); fs.renameSync(from, to);
	const before = bytes(to); await assert.rejects(rebindMovedProject(to, {}, authority), { code: "TF_POLICY_DENIED" });
	let calls = 0;
	const revoked: ProjectLifecycleAuthority<object> = { authorize(candidate, scope) { if (++calls > 1) throw new ControlError("TF_AUTHORITY_REVOKED", "revoked"); return authority.authorize(candidate, scope); } };
	await assert.rejects(rebindMovedProject(to, context, revoked), { code: "TF_AUTHORITY_REVOKED" }); assert.deepEqual(bytes(to), before);
	calls = 0; await assert.rejects(exportProjectEvidence(to, "readonly", context, revoked), { code: "TF_AUTHORITY_REVOKED" }); assert.deepEqual(bytes(to), before);
});

test("readonly/lossy exports include actual journal and issued Receipt evidence without source writes", async () => {
	const base = root(), directory = path.join(base, "project"), store = openControlStore(directory), value = run(store);
	store.createRun(value);
	const assurance: ReceiptAssurance = { journalContinuity: true, providerOutcome: "completed", artifactIntegrity: "verified",
		provenance: { confidentiality: "internal", integrity: "project" }, enforcement: { capabilities: {
			resolution: "contained", mutationMediation: "brokered", processIsolation: "none", revocation: "admission-only", baselinePolicyId: "test", hostProbeSha256: "a".repeat(64) } } };
	store.recordRunEvidence(value.runId, { buildInfo: { packageVersion: "test", gitCommit: "commit", schemaVersion: 2 }, assurance });
	store.mutateRun(value.runId, store.readRun(value.runId)!.runVersion, state => ({ ...state, run: { ...state.run, runVersion: state.run.runVersion + 1 }, events: [{ eventId: randomUUID(), recordedAt: Date.now(), payload: { kind: "run.terminal", status: "completed" } }] }));
	const evidence = await createControlEvidenceStore(store, { authorize: () => ({ principal: "test", authorizationContextHash: "a".repeat(64) }),
		terminalEvidence: { verify: (_project, _run, eventId) => ({ terminalStatus: "completed", terminalEventId: eventId, evidenceCommit: "provider-proof", providerOutcome: "completed" }) } });
	const receipt = await evidence.issueFinalReceipt(value.runId); store.close();
	const before = bytes(directory);
	for (const kind of ["readonly", "lossy"] as const) {
		const output = await exportProjectEvidence(directory, kind, context, authority);
		assert.equal(output.executePromise, false); assert.equal(output.integrity, "verified"); assert.deepEqual(output.receipts, [receipt]);
		assert.ok(output.journal.length > 0); assert.ok(output.files.some(file => file.path.startsWith("artifacts/sha256/")));
		for (const file of output.files) {
			if (kind === "readonly") assert.equal(createHash("sha256").update(Buffer.from(file.bytesBase64!, "base64")).digest("hex"), file.sha256);
			else assert.equal(file.bytesBase64, undefined);
		}
		assert.deepEqual(bytes(directory), before);
	}
});

test("damaged journal remains exportable as raw forensic evidence but cannot authorize move", async () => {
	const base = root(), from = path.join(base, "old"), to = path.join(base, "moved"), store = openControlStore(from); store.createRun(run(store)); store.close();
	fs.appendFileSync(path.join(from, "journal/000001.jsonl"), '{"torn":'); const before = bytes(from);
	const exported = await exportProjectEvidence(from, "readonly", context, authority);
	assert.equal(exported.integrity, "damaged"); assert.equal(exported.executePromise, false); assert.ok(exported.diagnostics.some(s => s.includes("incomplete")));
	assert.equal(exported.files.find(f => f.path === "journal/000001.jsonl")!.bytesBase64, before["journal/000001.jsonl"]); assert.deepEqual(bytes(from), before);
	fs.renameSync(from, to); await assert.rejects(rebindMovedProject(to, context, authority), { code: "TF_DURABILITY_FAILED" }); assert.deepEqual(bytes(to), before);
});

test("source changes during export are rejected; symlink evidence cannot escape source", async () => {
	const base = root(), directory = path.join(base, "project"), store = openControlStore(directory); store.close();
	let calls = 0; const changing: ProjectLifecycleAuthority<object> = { authorize(candidate, scope) {
		if (++calls === 2) fs.writeFileSync(path.join(directory, "receipts", "changed"), "new evidence");
		return authority.authorize(candidate, scope);
	} };
	await assert.rejects(exportProjectEvidence(directory, "readonly", context, changing), { code: "TF_DURABILITY_FAILED" });
	fs.symlinkSync(path.join(directory, "header"), path.join(directory, "receipts", "link"));
	await assert.rejects(exportProjectEvidence(directory, "readonly", context, authority), { code: "TF_DURABILITY_FAILED" });
});

test("explicit adopt works only for a proven same-inode move, not a copy whose original is absent", async () => {
	const base = root(), original = path.join(base, "original"), moved = path.join(base, "moved"), copied = path.join(base, "copied");
	const store = openControlStore(original); const header = store.header; store.close();
	fs.cpSync(original, copied, { recursive: true }); fs.renameSync(original, moved);
	const before = bytes(copied);
	await assert.rejects(rebindMovedProject(copied, context, authority, "adopt"), { code: "TF_DURABILITY_FAILED" }); assert.deepEqual(bytes(copied), before);
	const adopted = await rebindMovedProject(moved, context, authority, "adopt");
	assert.equal(adopted.projectId, header.projectId); assert.equal(adopted.controlDomainId, header.controlDomainId);
	const reopened = openControlStore(moved); assert.deepEqual(reopened.header, adopted); reopened.close();
});
