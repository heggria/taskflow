/** Real ControlStore journal integration; provider observation is a trusted test port. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { openControlStore } from "../src/store/store.ts";
import { createControlEvidenceStore, compactControlEvidence, readControlEvidence, type ControlEvidenceOptions } from "../src/store/evidence-adapter.ts";
import { ControlError } from "../src/errors.ts";
import type { ApprovalRun } from "../src/approval-service.ts";
import type { ArtifactRef, ReceiptAssurance } from "../src/schema/index.ts";

const assurance: ReceiptAssurance = { journalContinuity: true, providerOutcome: "ambiguous", artifactIntegrity: "unknown",
	provenance: { confidentiality: "internal", integrity: "project" }, enforcement: { capabilities: {
		resolution: "contained", mutationMediation: "brokered", processIsolation: "none", revocation: "admission-only",
		baselinePolicyId: "adapter-test-policy", hostProbeSha256: "a".repeat(64),
	} } };
const buildInfo = { packageVersion: "adapter-test", gitCommit: "durable-build-identity", schemaVersion: 2 };
const code = (expected: string) => (error: unknown) => error instanceof ControlError && error.code === expected;

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-real-evidence-"));
	let store = openControlStore(path.join(root, "project"));
	t.after(() => { store.close(); fs.rmSync(root, { force: true, recursive: true }); });
	const actor = Object.freeze({ identity: Symbol("verified") });
	let revoked = false;
	let observedTerminal = true;
	const run: ApprovalRun = { runId: randomUUID(), projectId: store.header.projectId, controlDomainId: store.header.controlDomainId,
		status: "running", stage: "executing", slot: "committed", needsOperator: false, runVersion: 0,
		boundPlanHash: "ir:actual-plan", policyHash: "a".repeat(64), authorityEpoch: 1 };
	store.createRun(run);
	store.recordRunEvidence(run.runId, { buildInfo, assurance });
	const options: ControlEvidenceOptions = {
		authorize(candidate, scope) {
			if (candidate !== actor || scope.projectId !== run.projectId || scope.controlDomainId !== run.controlDomainId) throw new ControlError("TF_POLICY_DENIED", "unverified actor or wrong project");
			if (revoked) throw new ControlError("TF_AUTHORITY_REVOKED", "revoked by current policy");
			return { principal: "test:authenticated", authorizationContextHash: "b".repeat(64) };
		},
		terminalEvidence: { verify(project, runId, evidenceId) {
			const terminal = store.readJournal().flatMap(b => b.events).find(e => e.eventId === evidenceId);
			if (!observedTerminal || project.projectId !== run.projectId || runId !== run.runId || terminal?.payload.kind !== "run.terminal") throw new ControlError("TF_RECONCILE_REQUIRED", "no trusted provider observation");
			if (terminal.payload.status !== "completed") throw new Error("unexpected test terminal");
			return { terminalStatus: terminal.payload.status, terminalEventId: terminal.eventId,
				evidenceCommit: "trusted-provider-observation", providerOutcome: "completed" };
		} },
	};
	return { root, run, actor, options, get store() { return store; },
		open: () => createControlEvidenceStore(store, options),
		reopen() { store.close(); store = openControlStore(path.join(root, "project")); },
		revoke() { revoked = true; }, unobserve() { observedTerminal = false; },
		terminal(ref?: ArtifactRef) {
			const current = store.readRun(run.runId)!;
			store.mutateRun(run.runId, current.runVersion, state => ({ ...state,
				run: { ...state.run, status: "completed", stage: "terminal", runVersion: state.run.runVersion + 1 },
				events: [...(ref ? [{ eventId: randomUUID(), recordedAt: Date.now(), payload: { kind: "artifact.recorded" as const, runId: run.runId, commandKind: "run.submit" as const, artifact: ref } }] : []),
					{ eventId: randomUUID(), recordedAt: Date.now(), payload: { kind: "run.terminal", status: "completed" } }],
			}));
		},
	};
}
function blob(root: string, ref: ArtifactRef) { return path.join(root, "project/artifacts/sha256", ref.digest.slice(0, 2), ref.digest); }

test("real ledger: atomic receipt refs survive restart and preserve manifest through issuance", async t => {
	const f = fixture(t), evidence = await f.open();
	const ref = await evidence.stageArtifact(Buffer.from("durable output"), { mediaType: "text/plain", storageClass: "local", redactionClass: "internal" });
	f.terminal(ref);
	const before = readControlEvidence(f.store);
	const batches = f.store.readJournal();
	const last = batches.at(-1)!;
	assert.notEqual(before.tipHash, last.recordKind === "lifecycle-batch" && last.contentHash);
	const receipt = await evidence.issueFinalReceipt(f.run.runId);
	assert.deepEqual(receipt.eventManifest, before.runs[f.run.runId].eventIds);
	const issuance = f.store.readJournal().at(-1)!;
	assert.equal(issuance.recordKind, "lifecycle-batch");
	if (issuance.recordKind !== "lifecycle-batch") assert.fail();
	assert.ok(issuance.receiptRef && issuance.manifestProofRef);
	assert.deepEqual(issuance.receipt, receipt);
	const seq = f.store.commitSeq;
	f.reopen();
	assert.deepEqual((await (await f.open()).readReceipt(f.actor, f.run.runId)).receipt, receipt);
	assert.deepEqual(await (await f.open()).issueFinalReceipt(f.run.runId), receipt);
	assert.equal(f.store.commitSeq, seq);
	assert.equal((await (await f.open()).readArtifact(f.actor, { kind: "run", id: f.run.runId }, ref)).toString(), "durable output");
});

test("real ledger: staged receipt without journal issuance stays unreachable", async t => {
	const f = fixture(t); f.terminal();
	const evidence = await f.open();
	await evidence.prepareFinalReceipt(f.run.runId);
	f.reopen();
	await assert.rejects((await f.open()).readReceipt(f.actor, f.run.runId), code("TF_POLICY_DENIED"));
	assert.equal(Object.keys(readControlEvidence(f.store).receipts).length, 0);
});

test("real ledger: damaged receipt is preserved and never regenerated", async t => {
	const f = fixture(t); f.terminal();
	await (await f.open()).issueFinalReceipt(f.run.runId);
	const ref = readControlEvidence(f.store).receipts[f.run.runId].receiptRef;
	fs.writeFileSync(blob(f.root, ref), "damaged");
	f.reopen();
	await assert.rejects((await f.open()).issueFinalReceipt(f.run.runId), code("TF_DURABILITY_FAILED"));
	assert.equal(fs.readFileSync(blob(f.root, ref), "utf8"), "damaged");
});

test("real ledger: revoked and forged actors cannot read committed receipt", async t => {
	const f = fixture(t); f.terminal(); const evidence = await f.open();
	await evidence.issueFinalReceipt(f.run.runId);
	await assert.rejects(evidence.readReceipt({ principal: "test:authenticated" }, f.run.runId), code("TF_POLICY_DENIED"));
	f.revoke();
	await assert.rejects(evidence.readReceipt(f.actor, f.run.runId), code("TF_AUTHORITY_REVOKED"));
});

test("real ledger: terminal journal status alone cannot issue a receipt", async t => {
	const f = fixture(t); f.terminal(); f.unobserve();
	await assert.rejects((await f.open()).issueFinalReceipt(f.run.runId), code("TF_RECONCILE_REQUIRED"));
	assert.equal(Object.keys(readControlEvidence(f.store).receipts).length, 0);
});

test("real ledger: writer fence blocks mutations while terminal verification awaits", async t => {
	const f = fixture(t); f.terminal();
	let release!: () => void, entered!: () => void;
	const waiting = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	const verify = f.options.terminalEvidence.verify;
	f.options.terminalEvidence = { async verify(...args) { entered(); await gate; return verify(...args); } };
	const evidence = await f.open(); const issuance = evidence.issueFinalReceipt(f.run.runId);
	await waiting;
	const run = f.store.readRun(f.run.runId)!;
	assert.throws(() => f.store.mutateRun(run.runId, run.runVersion, state => ({ ...state, run: { ...state.run, runVersion: state.run.runVersion + 1 }, events: [] })));
	release(); await issuance;
});

test("real ledger: immutable build and assurance metadata reject replacement", async t => {
	const f = fixture(t);
	const seq = f.store.commitSeq;
	f.store.recordRunEvidence(f.run.runId, { buildInfo, assurance });
	assert.equal(f.store.commitSeq, seq);
	assert.throws(() => f.store.recordRunEvidence(f.run.runId, { buildInfo: { ...buildInfo, gitCommit: "other-build" }, assurance }));
});


test("real ledger: compaction checkpoint expires cursors while old receipt and all journal bytes survive", async t => {
	const f = fixture(t); f.terminal(); const evidence = await f.open();
	const receipt = await evidence.issueFinalReceipt(f.run.runId);
	const through = f.store.commitSeq;
	const journal = path.join(f.store.storePath, "journal/000001.jsonl");
	const before = fs.readFileSync(journal);
	await compactControlEvidence(f.store, evidence, through);
	assert.deepEqual(fs.readFileSync(journal).subarray(0, before.length), before);
	await assert.rejects(evidence.checkCursor({ nextCommitSeq: through, leaseExpiresAt: 100 }, 1), code("TF_CURSOR_EXPIRED"));
	assert.equal((await evidence.checkCursor({ nextCommitSeq: through + 1, leaseExpiresAt: 100 }, 1)).minAvailableCommitSeq, through + 1);
	f.reopen();
	assert.deepEqual((await (await f.open()).readReceipt(f.actor, f.run.runId)).receipt, receipt);
});

for (const point of ["file-published", "lifecycle-committed"] as const) test(`real ledger: SIGKILL at ${point} recovers atomic receipt reachability`, async t => {
	const f = fixture(t); f.terminal();
	const storePath = f.store.storePath; f.store.close();
	const child = spawnSync(process.execPath, ["--conditions=development", "--experimental-strip-types",
		new URL("./fixtures/evidence-adapter-crash.mts", import.meta.url).pathname, storePath, f.run.runId, point],
		{ encoding: "utf8", timeout: 15000 });
	assert.equal(child.signal, "SIGKILL", child.stderr);
	f.reopen();
	const view = readControlEvidence(f.store);
	assert.equal(Object.hasOwn(view.receipts, f.run.runId), point === "lifecycle-committed");
	const evidence = await f.open();
	if (point === "file-published") await assert.rejects(evidence.readReceipt(f.actor, f.run.runId), code("TF_POLICY_DENIED"));
	else assert.equal((await evidence.readReceipt(f.actor, f.run.runId)).receipt.runId, f.run.runId);
	const receipt = await evidence.issueFinalReceipt(f.run.runId);
	assert.equal(receipt.runId, f.run.runId);
	assert.equal(f.store.readJournal().filter(batch => batch.recordKind === "lifecycle-batch" && batch.receipt).length, 1);
});

test("real ledgers: identical staged bytes in another project do not grant reachability", async t => {
	const a = fixture(t), b = fixture(t), ea = await a.open(), eb = await b.open();
	const meta = { mediaType: "text/plain", storageClass: "local", redactionClass: "internal" };
	const ref = await ea.stageArtifact(Buffer.from("shared digest"), meta);
	assert.deepEqual(await eb.stageArtifact(Buffer.from("shared digest"), meta), ref);
	a.terminal(ref); b.terminal();
	await ea.issueFinalReceipt(a.run.runId);
	await assert.rejects(ea.readReceipt(b.actor, a.run.runId), code("TF_POLICY_DENIED"));
	await assert.rejects(eb.readArtifact(b.actor, { kind: "run", id: b.run.runId }, ref), code("TF_POLICY_DENIED"));
	await assert.rejects(eb.readReceipt(b.actor, a.run.runId), code("TF_POLICY_DENIED"));
});

test("real ledger: policy revoked after first authorization denies final disclosure", async t => {
	const f = fixture(t); f.terminal();
	await (await f.open()).issueFinalReceipt(f.run.runId);
	const authorize = f.options.authorize;
	f.options.authorize = async (...args) => {
		const decision = await authorize(...args);
		f.revoke();
		return decision;
	};
	await assert.rejects((await f.open()).readReceipt(f.actor, f.run.runId), code("TF_AUTHORITY_REVOKED"));
});

test("real ledger: damaged committed journal is rejected without replacement", async t => {
	const f = fixture(t); f.terminal(); const evidence = await f.open();
	await evidence.issueFinalReceipt(f.run.runId);
	const file = path.join(f.store.storePath, "journal/000001.jsonl");
	const damaged = fs.readFileSync(file, "utf8").replace("durable-build-identity", "changed-build-identity");
	fs.writeFileSync(file, damaged);
	await assert.rejects(evidence.readReceipt(f.actor, f.run.runId), code("TF_DURABILITY_FAILED"));
	assert.equal(fs.readFileSync(file, "utf8"), damaged);
});


test("real ledger: preterminal approval artifact reachability requires same committed run without Receipt metadata", async t => {
	const f = fixture(t), evidence = await f.open();
	const pending = { ...f.run, runId: randomUUID(), status: "paused" as const, stage: "parked" as const, runVersion: 0 };
	f.store.createRun(pending);
	const ref = await evidence.stageArtifact(Buffer.from("approved edit"), { mediaType: "text/plain", storageClass: "local", redactionClass: "internal" });
	await assert.rejects(evidence.readArtifact(f.actor, { kind: "run", id: pending.runId }, ref), code("TF_POLICY_DENIED"));
	f.store.mutateRun(pending.runId, pending.runVersion, state => ({ ...state, run: { ...state.run, runVersion: 1 },
		events: [{ eventId: randomUUID(), recordedAt: Date.now(), payload: { kind: "artifact.recorded", runId: pending.runId, commandKind: "approval.decide", artifact: ref } }] }));
	assert.equal(Object.hasOwn(readControlEvidence(f.store).runs, pending.runId), false);
	assert.equal((await evidence.readArtifact(f.actor, { kind: "run", id: pending.runId }, ref)).toString(), "approved edit");
	await assert.rejects(evidence.readArtifact(f.actor, { kind: "run", id: f.run.runId }, ref), code("TF_POLICY_DENIED"));
	f.reopen();
	assert.equal((await (await f.open()).readArtifact(f.actor, { kind: "run", id: pending.runId }, ref)).toString(), "approved edit");
});
