/** Real disk tests of the subordinate evidence mechanism, not host/auth integration. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalJson } from "taskflow-core/flowir/hash";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { ControlError, reconcileRequired } from "../src/errors.ts";
import { CONTROL_WIRE_SCHEMA_VERSION, type ArtifactRef, type ControlEvent } from "../src/schema/index.ts";
import { createEvidenceStore, evidenceEventHash, type EvidenceLedgerView,
	type EvidenceStoreOptions, type PreparedEvidenceReceipt } from "../src/store/evidence-store.ts";

const PROJECT = "10000000-0000-0000-0000-000000000001";
const DOMAIN = "10000000-0000-0000-0000-000000000002";
const RUN = "10000000-0000-0000-0000-000000000003";
const COMMAND = "10000000-0000-0000-0000-000000000004";
const META = { mediaType: "text/plain", storageClass: "local", redactionClass: "internal" };
const actor = Object.freeze({ authenticatedTestActor: Symbol("identity") });

function isCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof ControlError && error.code === code;
}

function fixture(t: TestContext) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tf-evidence-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const disk = path.join(root, "test-authoritative-ledger.json");
	const terminalFile = path.join(root, "test-terminal-evidence.json");
	const st = fs.statSync(root);
	let view: EvidenceLedgerView = { projectId: PROJECT, controlDomainId: DOMAIN,
		directoryBinding: { canonicalPath: root, device: String(st.dev), inode: String(st.ino) },
		anchorHash: "0".repeat(64), tipHash: "0".repeat(64), tipCommitSeq: 0,
		events: [], runs: {}, commands: {}, receipts: {} };
	const save = () => fs.writeFileSync(disk, JSON.stringify(view));
	const read = (): EvidenceLedgerView => JSON.parse(fs.readFileSync(disk, "utf8"));
	save();
	let revoked = false;
	let writesAllowed = true;
	const options: EvidenceStoreOptions = {
		storePath: root,
		ledger: { read, commitReceiptOnce: async (runId, prepared) => { assert.equal(runId, RUN); issue(prepared); }, async withWriter(operation) {
			if (!writesAllowed) throw new ControlError("TF_STALE_VERSION", "test writer fenced");
			return operation(read());
		} },
		authorize(candidate, scope) {
			if (candidate !== actor || scope.projectId !== PROJECT || scope.controlDomainId !== DOMAIN) throw new ControlError("TF_POLICY_DENIED", "denied");
			if (revoked) throw new ControlError("TF_AUTHORITY_REVOKED", "revoked");
			return { principal: "test-verified-principal", authorizationContextHash: "a".repeat(64) };
		},
		terminalEvidence: { verify(project, runId, evidenceId) {
			const evidence = JSON.parse(fs.readFileSync(terminalFile, "utf8")) as {
				mode: string; terminalEventId: string; evidenceCommit: string;
			};
			if (project.projectId !== PROJECT || project.controlDomainId !== DOMAIN || runId !== RUN
				|| evidenceId !== "test-durable-terminal" || evidence.mode !== "quiescent") throw reconcileRequired("test provider is still live/ambiguous/dirty");
			return { terminalStatus: "completed", terminalEventId: evidence.terminalEventId, evidenceCommit: evidence.evidenceCommit, providerOutcome: "completed" };
		} },
	};
	const append = (payload: ControlEvent["payload"], streamId = `run:${RUN}`): ControlEvent => {
		const seq = view.tipCommitSeq + 1;
		const event: ControlEvent = {
			eventId: `20000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
			schemaVersion: CONTROL_WIRE_SCHEMA_VERSION, projectId: PROJECT, controlDomainId: DOMAIN,
			streamId, streamSeq: seq, commitSeq: seq, causationId: COMMAND, correlationId: RUN,
			recordedAt: seq, payload,
		};
		const entry = { event, previousHash: view.tipHash, hash: evidenceEventHash(view.tipHash, event) };
		view = { ...view, tipHash: entry.hash, tipCommitSeq: seq, events: [...view.events, entry] };
		save();
		return event;
	};
	const terminal = (refs: ArtifactRef[] = []) => {
		const event = append({ kind: "run.terminal", status: "completed" });
		view = { ...view, runs: { [RUN]: {
			runId: RUN, eventIds: [event.eventId], boundPlanHash: "ir:approved-plan", artifactRefs: refs,
			terminalEvidenceId: "test-durable-terminal",
			assurance: { journalContinuity: true, providerOutcome: "completed", artifactIntegrity: "verified",
				provenance: { confidentiality: "internal", integrity: "project" },
				enforcement: { capabilities: { resolution: "contained", mutationMediation: "brokered",
					processIsolation: "none", revocation: "admission-only", baselinePolicyId: "test", hostProbeSha256: "a".repeat(64) } } },
			buildInfo: { packageVersion: "test", gitCommit: "5dec238", schemaVersion: 1 },
		} } };
		fs.writeFileSync(terminalFile, JSON.stringify({ mode: "quiescent", terminalEventId: event.eventId, evidenceCommit: view.tipHash }));
		save();
	};
	const issue = (prepared: PreparedEvidenceReceipt) => {
		assert.deepEqual(prepared.expectedTip, { commitSeq: view.tipCommitSeq, hash: view.tipHash });
		// Stand-in for owner's atomic issuance marker; test file is not production protocol.
		view = { ...view, receipts: { ...view.receipts, [RUN]: {
			receiptRef: prepared.receiptRef, manifestProofRef: prepared.manifestProofRef,
		} } };
		save();
	};
	return { root, disk, terminalFile, options, append, terminal, issue, read,
		open: () => createEvidenceStore(options),
		edit: (change: (view: EvidenceLedgerView) => void) => { view = read(); change(view); save(); },
		revoke: () => { revoked = true; }, fence: () => { writesAllowed = false; } };
}

function blob(root: string, ref: ArtifactRef): string { return path.join(root, "artifacts/sha256", ref.digest.slice(0, 2), ref.digest); }
function snapshot(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const item of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
		const file = path.join(item.parentPath, item.name);
		if (item.isFile()) result[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
		else if (item.isSymbolicLink()) result[path.relative(root, file)] = `link:${fs.readlinkSync(file)}`;
	}
	return result;
}

test("evidence artifacts: authorized run/command reads survive reopen; digest or staged orphan alone does not authorize", async (t) => {
	const f = fixture(t);
	const store = (await f.open());
	const ref = (await store.stageArtifact(Buffer.from("actual output"), META));
	await assert.rejects(async () => (await store.readArtifact(actor, { kind: "run", id: RUN }, ref)), isCode("TF_POLICY_DENIED"));
	f.terminal([ref]);
	f.edit((view) => { view.commands = { [COMMAND]: { responseArtifactRef: ref } }; });
	assert.equal((await (await f.open()).readArtifact(actor, { kind: "run", id: RUN }, ref)).toString(), "actual output");
	assert.equal((await (await f.open()).readArtifact(actor, { kind: "command", id: COMMAND }, ref)).toString(), "actual output");
	await assert.rejects(async () => (await store.readArtifact(actor, { kind: "run", id: RUN }, { ...ref, redactionClass: "public" })), isCode("TF_POLICY_DENIED"));
});

test("evidence authorization: forged actor, revoked permission, missing policy and another project deny disclosure", async (t) => {
	const f = fixture(t);
	const ref = (await (await f.open()).stageArtifact(Buffer.from("secret response"), META));
	f.terminal([ref]);
	await assert.rejects(async () => (await (await f.open()).readArtifact({ callerPrincipal: "cli", authorizationContextHash: "forged" }, { kind: "run", id: RUN }, ref)), isCode("TF_POLICY_DENIED"));
	f.revoke();
	await assert.rejects(async () => (await (await f.open()).readArtifact(actor, { kind: "run", id: RUN }, ref)), isCode("TF_AUTHORITY_REVOKED"));
	await assert.rejects(async () => await createEvidenceStore({ ...f.options, authorize: undefined } as unknown as EvidenceStoreOptions), isCode("TF_DURABILITY_FAILED"));
	const other = fixture(t);
	other.edit((view) => { view.projectId = "30000000-0000-0000-0000-000000000001"; });
	await assert.rejects(async () => (await (await other.open()).readArtifact(actor, { kind: "run", id: RUN }, ref)), isCode("TF_POLICY_DENIED"));
});

test("evidence writes: corrupt existing digest is never overwritten and stale writer cannot write", async (t) => {
	const f = fixture(t);
	const store = (await f.open());
	const ref = (await store.stageArtifact(Buffer.from("correct"), META));
	fs.writeFileSync(blob(f.root, ref), "corrupt");
	const before = snapshot(f.root);
	await assert.rejects(async () => (await store.stageArtifact(Buffer.from("correct"), META)), isCode("TF_DURABILITY_FAILED"));
	assert.deepEqual(snapshot(f.root), before);
	await assert.rejects(async () => (await store.stageArtifact(Buffer.from("other"), META)), /fail-closed/);
	f.fence();
	await assert.rejects(async () => (await (await f.open()).stageArtifact(Buffer.from("unfenced"), META)), isCode("TF_STALE_VERSION"));
});

test("evidence paths: secret labels, invalid refs, symlink destinations and directories are rejected", async (t) => {
	const f = fixture(t);
	await assert.rejects(async () => (await (await f.open()).stageArtifact(Buffer.from("secret"), { ...META, redactionClass: "secret" })), isCode("TF_POLICY_DENIED"));
	const ref = (await (await f.open()).stageArtifact(Buffer.from("untouched"), META));
	const target = path.join(f.root, "decoy");
	fs.writeFileSync(target, "untouched");
	fs.unlinkSync(blob(f.root, ref));
	fs.symlinkSync(target, blob(f.root, ref));
	await assert.rejects(async () => (await (await f.open()).stageArtifact(Buffer.from("untouched"), META)), isCode("TF_DURABILITY_FAILED"));
	assert.equal(fs.readFileSync(target, "utf8"), "untouched");
	await assert.rejects(async () => (await (await f.open()).assertDurableReferences([{ ...ref, digest: "../../decoy" }])), isCode("TF_DURABILITY_FAILED"));
	const other = fixture(t);
	fs.symlinkSync(f.root, path.join(other.root, "artifacts"));
	await assert.rejects(async () => (await (await other.open()).stageArtifact(Buffer.from("escaped"), META)), isCode("TF_DURABILITY_FAILED"));
});

test("evidence references: missing and wrong-size artifacts cannot be accepted", async (t) => {
	const f = fixture(t);
	const ref = (await (await f.open()).stageArtifact(Buffer.from("output"), META));
	await assert.rejects(async () => (await (await f.open()).assertDurableReferences([{ ...ref, size: ref.size + 1 }])), isCode("TF_DURABILITY_FAILED"));
	fs.unlinkSync(blob(f.root, ref));
	await assert.rejects(async () => (await (await f.open()).assertDurableReferences([ref])));
});

test("evidence Receipt: prepared is unreachable until issuance; exact immutable bytes and output survive restart/retry", async (t) => {
	const f = fixture(t);
	const store = (await f.open());
	const ref = (await store.stageArtifact(Buffer.from("final output"), META));
	f.terminal([ref]);
	const prepared = (await store.prepareFinalReceipt(RUN));
	await assert.rejects(async () => (await store.readReceipt(actor, RUN)), isCode("TF_POLICY_DENIED"));
	f.issue(prepared);
	const before = snapshot(f.root);
	const restarted = (await f.open());
	assert.deepEqual((await restarted.readReceipt(actor, RUN)), { receipt: prepared.receipt, verification: { artifactIntegrity: "verified" } });
	assert.deepEqual((await restarted.prepareFinalReceipt(RUN)).receipt, prepared.receipt);
	assert.deepEqual(snapshot(f.root), before);
	f.revoke();
	await assert.rejects(async () => (await restarted.readReceipt(actor, RUN)), isCode("TF_AUTHORITY_REVOKED"));
});

for (const mode of ["live", "ambiguous", "dirty-intent", "reconcile-exhausted", "force-released"]) {
	test(`evidence Receipt: ${mode} trusted terminal observation cannot mint a final Receipt`, async (t) => {
		const f = fixture(t);
		f.terminal();
		const evidence = JSON.parse(fs.readFileSync(f.terminalFile, "utf8"));
		fs.writeFileSync(f.terminalFile, JSON.stringify({ ...evidence, mode }));
		const before = snapshot(f.root);
		await assert.rejects(async () => (await (await f.open()).prepareFinalReceipt(RUN)), isCode("TF_RECONCILE_REQUIRED"));
		assert.deepEqual(snapshot(f.root), before);
	});
}

test("evidence Receipt: unknown/paused run or absent durable terminal reference cannot mint", async (t) => {
	const f = fixture(t);
	f.terminal();
	f.edit((view) => { delete view.runs[RUN].terminalEvidenceId; });
	await assert.rejects(async () => (await (await f.open()).prepareFinalReceipt(RUN)), isCode("TF_RECONCILE_REQUIRED"));
	f.terminal();
	const last = f.append({ kind: "reconcile.settled", outcome: "exhausted" });
	f.edit((view) => { view.runs[RUN].eventIds = [...view.runs[RUN].eventIds, last.eventId]; });
	await assert.rejects(async () => (await (await f.open()).prepareFinalReceipt(RUN)), isCode("TF_RECONCILE_REQUIRED"));
});

test("evidence Receipt: mismatched durable terminal status cannot mint", async (t) => {
	const f = fixture(t);
	f.terminal();
	const store = await createEvidenceStore({ ...f.options, terminalEvidence: {
		verify: async (...args) => ({ ...await f.options.terminalEvidence.verify(...args), terminalStatus: "failed" }),
	} });
	const before = snapshot(f.root);
	await assert.rejects(async () => (await store.prepareFinalReceipt(RUN)), isCode("TF_RECONCILE_REQUIRED"));
	assert.deepEqual(snapshot(f.root), before);
});

test("evidence authorization: unavailable live policy cannot reveal artifact bytes", async (t) => {
	const f = fixture(t);
	const ref = (await (await f.open()).stageArtifact(Buffer.from("withheld output"), META));
	f.terminal([ref]);
	const store = await createEvidenceStore({ ...f.options, authorize: () => { throw new ControlError("TF_POLICY_DENIED", "policy unavailable"); } });
	await assert.rejects(async () => (await store.readArtifact(actor, { kind: "run", id: RUN }, ref)), isCode("TF_POLICY_DENIED"));
});

test("evidence Receipt: tampered output is a failure rather than retention-unknown", async (t) => {
	const f = fixture(t);
	const ref = (await (await f.open()).stageArtifact(Buffer.from("checked output"), META));
	f.terminal([ref]);
	f.issue((await (await f.open()).prepareFinalReceipt(RUN)));
	fs.writeFileSync(blob(f.root, ref), "corrupt output");
	const before = snapshot(f.root);
	await assert.rejects(async () => (await (await f.open()).readReceipt(actor, RUN)), isCode("TF_DURABILITY_FAILED"));
	assert.deepEqual(snapshot(f.root), before);
});

test("evidence Receipt: missing retained artifact reports current unknown while issued bytes stay unchanged", async (t) => {
	const f = fixture(t);
	const store = (await f.open());
	const ref = (await store.stageArtifact(Buffer.from("retained later"), META));
	f.terminal([ref]);
	const prepared = (await store.prepareFinalReceipt(RUN));
	f.issue(prepared);
	const issuedBytes = fs.readFileSync(blob(f.root, prepared.receiptRef));
	fs.unlinkSync(blob(f.root, ref));
	const result = (await (await f.open()).readReceipt(actor, RUN));
	assert.equal(result.verification.artifactIntegrity, "unknown");
	assert.equal(result.receipt.assurance.artifactIntegrity, "verified");
	assert.deepEqual(fs.readFileSync(blob(f.root, prepared.receiptRef)), issuedBytes);
});

for (const which of ["receiptRef", "manifestProofRef"] as const) {
	test(`evidence corruption: damaged ${which} is rejected on restart and never overwritten`, async (t) => {
		const f = fixture(t);
		f.terminal();
		const prepared = (await (await f.open()).prepareFinalReceipt(RUN));
		f.issue(prepared);
		fs.writeFileSync(blob(f.root, prepared[which]), '{"torn":');
		const before = snapshot(f.root);
		await assert.rejects(async () => (await (await f.open()).readReceipt(actor, RUN)), isCode("TF_DURABILITY_FAILED"));
		await assert.rejects(async () => (await (await f.open()).prepareFinalReceipt(RUN)), isCode("TF_DURABILITY_FAILED"));
		assert.deepEqual(snapshot(f.root), before);
	});
}

test("evidence manifest: full event payload, domain, run membership and order are bound", async (t) => {
	const f = fixture(t);
	f.terminal();
	const prepared = (await (await f.open()).prepareFinalReceipt(RUN));
	f.issue(prepared);
	f.edit((view) => { view.events[0].event.payload = { kind: "run.terminal", status: "failed" }; });
	const before = snapshot(f.root);
	await assert.rejects(async () => (await f.open()), isCode("TF_DURABILITY_FAILED"));
	assert.deepEqual(snapshot(f.root), before);
	// Even if the trusted fixture re-hashes the changed ledger, issue-time root
	// cannot change with it. Whole-root rollback itself remains out of scope.
	f.edit((view) => {
		view.events[0].hash = evidenceEventHash(view.anchorHash, view.events[0].event);
		view.tipHash = view.events[0].hash;
	});
	await assert.rejects(async () => (await (await f.open()).readReceipt(actor, RUN)), isCode("TF_DURABILITY_FAILED"));
});

test("evidence manifest: reordered or duplicate event roster is rejected", async (t) => {
	const f = fixture(t);
	const first = f.append({ kind: "dispatch.acknowledged", providerJobHandle: "test-job" });
	f.terminal();
	f.edit((view) => { view.runs[RUN].eventIds = [...view.runs[RUN].eventIds, first.eventId]; });
	await assert.rejects(async () => (await (await f.open()).prepareFinalReceipt(RUN)), isCode("TF_DURABILITY_FAILED"));
	f.edit((view) => { view.runs[RUN].eventIds = [first.eventId, first.eventId]; });
	await assert.rejects(async () => (await (await f.open()).prepareFinalReceipt(RUN)), isCode("TF_DURABILITY_FAILED"));
});

test("evidence logical compaction: checkpoint floor survives restart and preserves Receipt/journal/artifact bytes", async (t) => {
	const f = fixture(t);
	const store = (await f.open());
	const ref = (await store.stageArtifact(Buffer.from("reachable after checkpoint"), META));
	f.terminal([ref]);
	const prepared = (await store.prepareFinalReceipt(RUN));
	f.issue(prepared);
	const receiptBytes = fs.readFileSync(blob(f.root, prepared.receiptRef));
	const chainBefore = f.read().events;
	const checkpoint = (await store.prepareCheckpoint(1));
	assert.deepEqual((await store.checkCursor({ nextCommitSeq: 1, leaseExpiresAt: 100 }, 1)), { minAvailableCommitSeq: 1 });
	f.append(checkpoint.eventPayload, "project:compaction");
	const reopened = (await f.open());
	await assert.rejects(async () => (await reopened.checkCursor({ nextCommitSeq: 1, leaseExpiresAt: 100 }, 1)), isCode("TF_CURSOR_EXPIRED"));
	assert.deepEqual((await reopened.checkCursor({ nextCommitSeq: 2, leaseExpiresAt: 100 }, 1)), { minAvailableCommitSeq: 2 });
	await assert.rejects(async () => (await reopened.checkCursor({ nextCommitSeq: 2, leaseExpiresAt: 1 }, 1)), isCode("TF_CURSOR_EXPIRED"));
	assert.deepEqual(f.read().events.slice(0, chainBefore.length), chainBefore);
	assert.deepEqual(fs.readFileSync(blob(f.root, prepared.receiptRef)), receiptBytes);
	assert.deepEqual((await reopened.readReceipt(actor, RUN)).receipt, prepared.receipt);
	assert.equal((await reopened.readArtifact(actor, { kind: "run", id: RUN }, ref)).toString(), "reachable after checkpoint");
	fs.writeFileSync(path.join(f.root, "compaction.json"), '{"throughCommitSeq":9000}');
	assert.equal((await (await f.open()).checkCursor({ nextCommitSeq: 2, leaseExpiresAt: 100 }, 1)).minAvailableCommitSeq, 2);
});

test("evidence checkpoints: future/backward/unverified chain does not move floor", async (t) => {
	const f = fixture(t);
	f.terminal();
	await assert.rejects(async () => (await (await f.open()).prepareCheckpoint(2)), isCode("TF_DURABILITY_FAILED"));
	f.append({ kind: "compaction.checkpoint", throughCommitSeq: 1 });
	await assert.rejects(async () => (await (await f.open()).prepareCheckpoint(1)), isCode("TF_DURABILITY_FAILED"));
	f.append({ kind: "compaction.checkpoint", throughCommitSeq: 100 });
	await assert.rejects(async () => (await (await f.open()).checkCursor({ nextCommitSeq: 101, leaseExpiresAt: 100 }, 1)), isCode("TF_DURABILITY_FAILED"));
});

test("evidence root: replaced project identity is rejected by an existing instance", async (t) => {
	const f = fixture(t);
	const store = (await f.open());
	f.edit((view) => { view.projectId = "30000000-0000-0000-0000-000000000001"; });
	await assert.rejects(async () => (await store.stageArtifact(Buffer.from("wrong project"), META)), isCode("TF_DURABILITY_FAILED"));
});

test("evidence canonical bytes match shared request hash serializer for JSON values", async () => {
	const value = { z: [null, false, "中文", 1.25], a: { omitted: undefined, c: true, b: "\\n" } };
	assert.equal(createHash("sha256").update(canonicalJson(value)).digest("hex"), createHash("sha256").update(canonicalJson(JSON.parse(canonicalJson(value)))).digest("hex"));
	assert.equal(canonicalJson(value), '{"a":{"b":"\\\\n","c":true},"z":[null,false,"中文",1.25]}');
	const edgeCases = { a: undefined, z: [undefined, NaN, Infinity, -Infinity] };
	assert.equal(canonicalJson(edgeCases), '{"z":[null,null,null,null]}');
	assert.equal(evidenceEventHash("0".repeat(64), edgeCases as unknown as ControlEvent),
		"52af6d5306197b5fae06e0056028533902376a65ba93d73e5d6a5d01e11caefc");
});

function barrier() {
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => { release = resolve; });
	return { waiting, release };
}

test("evidence asynchronous live policy: revoke during evaluation denies this request", async (t) => {
	const f = fixture(t);
	const ref = await (await f.open()).stageArtifact(Buffer.from("not disclosed"), META);
	f.terminal([ref]);
	const entered = barrier();
	const resume = barrier();
	const store = await createEvidenceStore({ ...f.options, authorize: async (...args) => {
		entered.release();
		await resume.waiting;
		return await f.options.authorize(...args);
	} });
	const reading = store.readArtifact(actor, { kind: "run", id: RUN }, ref);
	await entered.waiting;
	f.revoke();
	resume.release();
	await assert.rejects(reading, isCode("TF_AUTHORITY_REVOKED"));
});

test("evidence asynchronous live policy: reachability is reloaded after policy await", async (t) => {
	const f = fixture(t);
	const ref = await (await f.open()).stageArtifact(Buffer.from("now unreachable"), META);
	f.terminal([ref]);
	const entered = barrier();
	const resume = barrier();
	const store = await createEvidenceStore({ ...f.options, authorize: async (...args) => {
		entered.release();
		await resume.waiting;
		return await f.options.authorize(...args);
	} });
	const reading = store.readArtifact(actor, { kind: "run", id: RUN }, ref);
	await entered.waiting;
	f.edit((view) => { view.runs[RUN].artifactRefs = []; });
	resume.release();
	await assert.rejects(reading, isCode("TF_POLICY_DENIED"));
});

test("evidence asynchronous terminal verification: owner fence spans await and durable preparation", async (t) => {
	const f = fixture(t);
	f.terminal();
	const entered = barrier();
	const resume = barrier();
	let held = false;
	const store = await createEvidenceStore({ ...f.options,
		ledger: { read: async () => f.read(), commitReceiptOnce: f.options.ledger.commitReceiptOnce, withWriter: async (operation) => {
			assert.equal(held, false);
			held = true;
			try { return await operation(f.read()); } finally { held = false; }
		} },
		terminalEvidence: { verify: async (...args) => {
			assert.equal(held, true);
			entered.release();
			await resume.waiting;
			assert.equal(held, true);
			return await f.options.terminalEvidence.verify(...args);
		} },
		onDurabilityPoint: () => { assert.equal(held, true); },
	});
	const preparing = store.prepareFinalReceipt(RUN);
	await entered.waiting;
	assert.equal(held, true);
	assert.equal(fs.existsSync(path.join(f.root, "artifacts")), false);
	resume.release();
	const prepared = await preparing;
	assert.equal(held, false);
	f.issue(prepared);
	assert.deepEqual((await store.readReceipt(actor, RUN)).receipt, prepared.receipt);
});

test("evidence issue-once: owner fence spans async journal commit and retry returns the exact Receipt", async (t) => {
	const f = fixture(t);
	f.terminal();
	const entered = barrier();
	const resume = barrier();
	let held = false;
	let commits = 0;
	const store = await createEvidenceStore({ ...f.options, ledger: {
		read: async () => f.read(),
		withWriter: async (operation) => {
			assert.equal(held, false);
			held = true;
			try { return await operation(f.read()); } finally { held = false; }
		},
		commitReceiptOnce: async (runId, prepared) => {
			assert.equal(held, true);
			commits++;
			entered.release();
			await resume.waiting;
			assert.equal(held, true);
			await f.options.ledger.commitReceiptOnce(runId, prepared);
		},
	} });
	const issuing = store.issueFinalReceipt(RUN);
	await entered.waiting;
	assert.equal(held, true);
	assert.deepEqual(f.read().receipts, {});
	resume.release();
	const receipt = await issuing;
	assert.equal(held, false);
	assert.deepEqual(await store.issueFinalReceipt(RUN), receipt);
	assert.deepEqual(await (await f.open()).issueFinalReceipt(RUN), receipt);
	assert.equal(commits, 1);
});

test("evidence issue-once: lost commit acknowledgement recovers exact issued Receipt without reissuing", async (t) => {
	const f = fixture(t);
	f.terminal();
	const store = await createEvidenceStore({ ...f.options, ledger: { ...f.options.ledger,
		commitReceiptOnce: async (runId, prepared) => {
			await f.options.ledger.commitReceiptOnce(runId, prepared);
			throw new Error("injected lost reply after committed marker");
		},
	} });
	await assert.rejects(store.issueFinalReceipt(RUN), /injected lost reply/);
	const before = snapshot(f.root);
	const reopened = await f.open();
	assert.deepEqual(await reopened.issueFinalReceipt(RUN), (await reopened.readReceipt(actor, RUN)).receipt);
	assert.deepEqual(snapshot(f.root), before);
});

test("evidence issue-once: a commit hook that establishes no journal reachability cannot claim issuance", async (t) => {
	const f = fixture(t);
	f.terminal();
	const store = await createEvidenceStore({ ...f.options, ledger: { ...f.options.ledger, commitReceiptOnce: async () => {} } });
	await assert.rejects(store.issueFinalReceipt(RUN), isCode("TF_DURABILITY_FAILED"));
	await assert.rejects((await f.open()).readReceipt(actor, RUN), isCode("TF_POLICY_DENIED"));
});

for (const point of ["file-fsynced", "file-published"]) {
	test(`evidence SIGKILL: ${point} leaves only unreachable staging/orphan; reopen preserves bytes`, { skip: process.platform === "win32" }, async (t) => {
		const f = fixture(t);
		const moduleUrl = new URL("../src/store/evidence-store.ts", import.meta.url).href;
		const script = `
			import fs from 'node:fs';
			import { createEvidenceStore } from ${JSON.stringify(moduleUrl)};
			const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(f.disk)}, 'utf8'));
			const store = await createEvidenceStore({ storePath: ${JSON.stringify(f.root)},
				ledger: { read, withWriter: async operation => await operation(read()), commitReceiptOnce: async () => { throw Error('unused'); } },
				authorize: () => { throw Error('denied'); }, terminalEvidence: { verify: () => { throw Error('unused'); } },
				onDurabilityPoint: point => { if (point === ${JSON.stringify(point)}) process.kill(process.pid, 'SIGKILL'); }
			});
			(await store.stageArtifact(Buffer.from('crash output'), ${JSON.stringify(META)}));
		`;
		const result = spawnSync(process.execPath, ["--conditions=development", "--experimental-strip-types", "--input-type=module", "-e", script], { timeout: 10_000 });
		assert.equal(result.signal, "SIGKILL", result.stderr.toString());
		const before = snapshot(f.root);
		const store = (await f.open());
		assert.deepEqual(snapshot(f.root), before, "reopen may not erase forensic staging bytes");
		const ref = (await store.stageArtifact(Buffer.from("crash output"), META));
		await assert.rejects(async () => (await store.readArtifact(actor, { kind: "run", id: RUN }, ref)), isCode("TF_POLICY_DENIED"));
		assert.deepEqual(f.read().receipts, {});
	});
}

for (const level of ["root", "artifacts", "sha256", "bucket"] as const) {
	for (const replacement of ["symlink", "directory"] as const) {
		test(`evidence publication: ${level} ${replacement} replacement after fsync fails closed without redirected cleanup`, async (t) => {
			const f = fixture(t);
			const foreign = fixture(t);
			const bytes = Buffer.from("confined publication");
			const hash = createHash("sha256").update(bytes).digest("hex");
			const parts = ["artifacts", "sha256", hash.slice(0, 2)];
			const depth = { root: 0, artifacts: 1, sha256: 2, bucket: 3 }[level];
			const replaced = path.join(f.root, ...parts.slice(0, depth));
			const moved = path.join(foreign.root, "moved");
			let staged = "";
			const store = await createEvidenceStore({ ...f.options, onDurabilityPoint: (point) => {
				if (point !== "file-fsynced") return;
				staged = fs.readdirSync(path.join(f.root, ...parts)).find((file) => file.startsWith("."))!;
				fs.renameSync(replaced, moved);
				if (replacement === "symlink") fs.symlinkSync(moved, replaced, "dir");
				else {
					fs.mkdirSync(path.join(replaced, ...parts.slice(depth)), { recursive: true });
					fs.writeFileSync(path.join(replaced, ...parts.slice(depth), staged), "replacement forensic data");
				}
			} });
			await assert.rejects(store.stageArtifact(bytes, META), isCode("TF_DURABILITY_FAILED"));
			const movedBucket = path.join(moved, ...parts.slice(depth));
			assert.equal(fs.existsSync(path.join(movedBucket, hash)), false, "no published digest outside original directory");
			assert.deepEqual(fs.readFileSync(path.join(movedBucket, staged)), bytes, "original staging bytes preserved");
			if (replacement === "directory") assert.equal(fs.readFileSync(path.join(replaced, ...parts.slice(depth), staged), "utf8"), "replacement forensic data");
		});
	}
}

test("evidence publication: replacement after publish cannot acknowledge and cannot delete moved staging", async (t) => {
	const f = fixture(t);
	const foreign = fixture(t);
	const bytes = Buffer.from("published then replaced");
	const hash = createHash("sha256").update(bytes).digest("hex");
	const bucket = path.join(f.root, "artifacts", "sha256", hash.slice(0, 2));
	const moved = path.join(foreign.root, "moved");
	const store = await createEvidenceStore({ ...f.options, onDurabilityPoint: (point) => {
		if (point === "file-published") { fs.renameSync(bucket, moved); fs.symlinkSync(moved, bucket, "dir"); }
	} });
	await assert.rejects(store.stageArtifact(bytes, META), isCode("TF_DURABILITY_FAILED"));
	assert.equal(fs.readdirSync(moved).length, 2, "both digest and forensic staging bytes retained");
});

for (const kind of ["artifact", "receipt"] as const) {
	test(`evidence ${kind}: revoke during final async ledger read denies disclosure`, async (t) => {
		const f = fixture(t);
		const ref = await (await f.open()).stageArtifact(Buffer.from("revoked before disclosure"), META);
		f.terminal([ref]);
		await (await f.open()).issueFinalReceipt(RUN);
		const entered = barrier();
		const resume = barrier();
		let policyChecks = 0;
		const store = await createEvidenceStore({ ...f.options,
			authorize: async (...args) => { policyChecks++; return f.options.authorize(...args); },
			ledger: { ...f.options.ledger, read: async () => {
				if (policyChecks === 1) { entered.release(); await resume.waiting; }
				return f.read();
			} },
		});
		const reading = kind === "artifact" ? store.readArtifact(actor, { kind: "run", id: RUN }, ref) : store.readReceipt(actor, RUN);
		await entered.waiting;
		f.revoke();
		resume.release();
		await assert.rejects(reading, isCode("TF_AUTHORITY_REVOKED"));
		assert.equal(policyChecks, 2);
	});
}

test("evidence disclosure: serialized owner fence orders removal before reads and blocks mutations through authorization", async (t) => {
	const f = fixture(t);
	const ref = await (await f.open()).stageArtifact(Buffer.from("fenced output"), META);
	f.terminal([ref]);
	let tail = Promise.resolve();
	let held = false;
	const withWriter: EvidenceStoreOptions["ledger"]["withWriter"] = async (operation) => {
		const predecessor = tail;
		const released = barrier();
		tail = released.waiting;
		await predecessor;
		assert.equal(held, false);
		held = true;
		try { return await operation(f.read()); } finally { held = false; released.release(); }
	};
	const entered = barrier();
	const resume = barrier();
	const store = await createEvidenceStore({ ...f.options,
		ledger: { ...f.options.ledger, withWriter },
		authorize: async (...args) => { assert.equal(held, true); entered.release(); await resume.waiting; return f.options.authorize(...args); },
	});
	const reading = store.readArtifact(actor, { kind: "run", id: RUN }, ref);
	await entered.waiting;
	let removed = false;
	const removal = withWriter(async () => { f.edit((view) => { view.runs[RUN].artifactRefs = []; }); removed = true; });
	await Promise.resolve();
	assert.equal(removed, false, "journal mutator cannot run during the disclosure fence");
	resume.release();
	assert.equal((await reading).toString(), "fenced output");
	await removal;
	assert.equal(removed, true);
	await assert.rejects(store.readArtifact(actor, { kind: "run", id: RUN }, ref), isCode("TF_POLICY_DENIED"));
});
