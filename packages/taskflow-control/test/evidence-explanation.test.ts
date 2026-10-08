import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { openControlStore } from "../src/store/store.ts";
import { explainControlEvidence, type EvidenceExplanationOptions } from "../src/store/evidence-explanation.ts";
import { ControlError } from "../src/errors.ts";

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-why-real-ledger-"));
	const store = openControlStore(path.join(root, "store"));
	const runId = randomUUID();
	store.createRun({ runId, projectId: store.header.projectId, controlDomainId: store.header.controlDomainId,
		status: "running", stage: "queued", slot: "none", needsOperator: false, runVersion: 0,
		boundPlanHash: "ir:actual-test", policyHash: "a".repeat(64), authorityEpoch: 1 });
	const actor = {}, options: EvidenceExplanationOptions = {
		authorize(candidate) { if (candidate !== actor) throw new ControlError("TF_POLICY_DENIED", "denied");
			return { principal: "test-verified", authorizationContextHash: "a".repeat(64) }; },
		readDiagnostic() { return undefined; },
	};
	return { store, runId, root, actor, options, close() { store.close(); fs.rmSync(root, { force: true, recursive: true }); } };
}

test("why: pre-dispatch run explains actual lifecycle with explicit checkpoint absence", async () => {
	const f = setup(); try {
		const why = await explainControlEvidence(f.store, f.actor, f.runId, f.options);
		assert.equal(why.stage, "queued"); assert.equal(why.receiptIssued, false);
		assert.equal(why.checkpoint.available, false);
		assert.equal(why.lifecycle.length, 1);
		assert.equal(why.lifecycle[0].payload.kind, "run.snapshot");
	} finally { f.close(); }
});

test("why: live revocation during diagnostic await prevents disclosure", async () => {
	const f = setup(); try {
		let revoked = false;
		f.options.authorize = () => { if (revoked) throw new ControlError("TF_AUTHORITY_REVOKED", "revoked"); return { principal: "verified", authorizationContextHash: "a".repeat(64) }; };
		f.options.readDiagnostic = async () => { await Promise.resolve(); revoked = true; return undefined; };
		await assert.rejects(explainControlEvidence(f.store, f.actor, f.runId, f.options), (error: unknown) => error instanceof ControlError && error.code === "TF_AUTHORITY_REVOKED");
	} finally { f.close(); }
});

test("why: provider checkpoint bound to another project is rejected", async () => {
	const f = setup(); try {
		f.options.readDiagnostic = () => ({ runId: f.runId, projectId: randomUUID(), controlDomainId: f.store.header.controlDomainId,
			controlDirectory: path.join(f.root, "resources"), projectRoot: f.root,
			state: { cwd: f.root, runId: f.runId, flowName: "wrong-project", def: { name: "wrong-project", phases: [] }, phases: {}, args: {}, status: "running", createdAt: 1, updatedAt: 1 } });
		await assert.rejects(explainControlEvidence(f.store, f.actor, f.runId, f.options), (error: unknown) => error instanceof ControlError && error.code === "TF_DURABILITY_FAILED");
	} finally { f.close(); }
});
