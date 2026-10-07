/**
 * Authoritative per-project append journal. A lifetime OS writer lock excludes
 * competing hosts; an async fence serializes evidence work with lifecycle CAS.
 * V1 submit records stay readable. Chained V2 batches atomically bind run state,
 * approvals/outboxes, commands and immutable responses, admission decisions,
 * receipts and evidence metadata. Corrupt or incomplete bytes are preserved.
 * Storage ports are trusted in-process APIs: live authorization belongs to the
 * service/host before lookup and again before result disclosure.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ArtifactRef, Receipt, BuildInfoWire, ReceiptAssurance } from "../schema/evidence.ts";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import { ControlError } from "../errors.ts";
import {
	CONTROL_WIRE_SCHEMA_VERSION,
	CommandRecordSchema,
	ControlEventSchema,
	ControlStoreHeaderSchema,
	type CommandRecord,
	type ControlEvent,
	type ControlStoreHeader,
	type ControlStoreStatus,
} from "../schema/index.ts";

import { JOURNAL_GENESIS, journalHash, validJournalBatch, ProjectStateSchema, type JournalBatch, type LifecycleBatch, type AdmissionBinding, type AdmissionDecision } from "./journal.ts";
import type { ApprovalRun, ApprovalJournalState, ApprovalMutation, ApprovalCommit, ApprovalJournalEvent, CommandBinding } from "../approval-service.ts";
export type { AdmissionBinding, AdmissionDecision } from "./journal.ts";
export const CONTROL_CRASH_ENV = "TASKFLOW_CONTROL_CRASH_AT";

export type ControlCrashPoint =
	| "header-fsynced"
	| "journal-append"
	| "projection-rebuild"
 | "lifecycle-committed";

const LOCK_NAME = "writer.lock";
const HEADER_NAME = "header";
const COMMIT_SEQ_NAME = "commit-seq.json";
const JOURNAL_DIR = "journal";
const JOURNAL_SEGMENT = "000001.jsonl";
const PROJECTIONS_DIR = "projections";
const COMMAND_INDEX = "commands.json";
const COMMANDS_DIR = "commands";
const RECEIPTS_DIR = "receipts";

export interface OpenControlStoreOptions {
	projectId?: string;
	controlDomainId?: string;
	now?: () => number;
}

export interface CommitBatchInput {
	command: CommandRecord;
	events: readonly ControlEvent[];
}

export interface ControlStoreSnapshot {
	header: ControlStoreHeader;
	commitSeq: number;
	status: ControlStoreStatus;
}

interface WriterLock {
	ownerId: string;
	pid: number;
	acquiredAt: number;
}

export class ControlStore {
	readonly storePath: string;
	#header: ControlStoreHeader;
	#commitSeq: number;
	#status: ControlStoreStatus = "healthy";
	#closed = false;
	readonly #releaseWriter: () => void;
	#commandIndex = new Map<string, CommandRecord>();
 #states = new Map<string, ApprovalJournalState>();
 #responses = new Map<string, { record: CommandRecord; responseJson: string; state: ApprovalJournalState }>();
 #admissions = new Map<string, AdmissionDecision>();
 #tip = JOURNAL_GENESIS;
 #writerProof: string;
 #headerProof: string;
 #writing = false;
 #fence = new AsyncLocalStorage<symbol>();
 #fenceOwner?: symbol;
 #fenceQueue: Promise<unknown> = Promise.resolve();

	constructor(storePath: string, header: ControlStoreHeader, commitSeq: number, commands: readonly CommandRecord[], releaseWriter: () => void, batches: JournalBatch[] = []) {
		this.#releaseWriter = releaseWriter;
		this.storePath = storePath;
  this.#writerProof = fs.readFileSync(path.join(storePath, LOCK_NAME), "utf8");
  this.#headerProof = fs.readFileSync(path.join(storePath, HEADER_NAME), "utf8");
		this.#header = structuredClone(header);
		this.#commitSeq = commitSeq;
		for (const command of commands) this.#commandIndex.set(command.commandId, structuredClone(command));
 for (const batch of batches) this.#apply(batch);
	}

	get header(): ControlStoreHeader {
		return structuredClone(this.#header);
	}

	get commitSeq(): number {
		return this.#commitSeq;
	}

	get status(): ControlStoreStatus {
		return this.#status;
	}

	readCommand(commandId: string): CommandRecord | undefined {
		this.#assertOpen();
		const command = this.#commandIndex.get(commandId);
		return command === undefined ? undefined : structuredClone(command);
	}

	snapshot(): ControlStoreSnapshot {
		this.#assertOpen();
		return { header: this.header, commitSeq: this.#commitSeq, status: this.#status };
	}

	appendBatch(input: CommitBatchInput): { commitSeq: number; command: CommandRecord } {
		this.#assertOpen(); this.#assertFence();
		if (this.#status === "fail-closed") {
			throw durabilityFailed("control store is fail-closed; refusing mutation");
		}
		try { this.readJournal(); } catch (error) { this.#status = "fail-closed"; throw durabilityFailed(String(error)); }
  if (input.command.kind !== "run.submit") {
			throw durabilityFailed(`beta.2 store only accepts run.submit; got ${input.command.kind}`);
		}
		if (input.events.length === 0) {
			throw durabilityFailed("atomic batch requires at least one ControlEvent");
		}
		for (const event of input.events) {
			if (!Value.Check(ControlEventSchema, event)) {
				throw durabilityFailed("ControlEvent failed schema check");
			}
		}
		if (!Value.Check(CommandRecordSchema, {
			...input.command,
			projectId: this.#header.projectId,
			controlDomainId: this.#header.controlDomainId,
		})) {
			// Validate after identity rewrite below; pre-check kind/required fields first.
		}

		const nextSeq = this.#commitSeq + 1;
		let command: CommandRecord = {
			...input.command,
			projectId: this.#header.projectId,
			controlDomainId: this.#header.controlDomainId,
			firstCommitSeq: nextSeq,
			lastCommitSeq: nextSeq,
		};
		if (!Value.Check(CommandRecordSchema, command)) {
			throw durabilityFailed("CommandRecord failed schema check");
		}
		// Keep authoritative records independent of both caller-owned nested
		// input and the copies returned by append/read/snapshot boundaries.
		command = structuredClone(command);
		if (this.#commandIndex.has(command.commandId)) {
			// Matching audit fields cannot authorize disclosure (RFC §9.4).
			// This S3 path only appends a journal batch; it never submits TE work.
			throw new ControlError(
				"TF_IDEMPOTENCY_CONFLICT",
				`command ${command.commandId} is already committed; authorized command-result replay is not implemented without a live authorization boundary`,
				{ recoveryAction: "none", sideEffects: "none" },
			);
		}
		const events: ControlEvent[] = input.events.map((event, index) => ({
			...structuredClone(event),
			projectId: this.#header.projectId,
			controlDomainId: this.#header.controlDomainId,
			commitSeq: nextSeq,
			commandId: command.commandId,
			commandEventIndex: index,
		}));

		const record: JournalBatch = {
			recordKind: "commit-batch",
			commitSeq: nextSeq,
			command,
			events,
		};
		// Once persistence begins, a failure can leave a complete or torn journal
		// record behind. Only reopening/recovery can establish its outcome; never
		// reuse this instance's old sequence number after an ambiguous write.
		try {
			crashDuringJournalAppend(journalPath(this.storePath));
			appendJsonLineDurable(journalPath(this.storePath), record);
			writeJsonAtomicHardened(commitSeqPath(this.storePath), { commitSeq: nextSeq });
			const nextIndex = new Map(this.#commandIndex);
			nextIndex.set(command.commandId, command);
			maybeCrash("projection-rebuild");
			writeJsonAtomicHardened(commandIndexPath(this.storePath), Object.fromEntries(nextIndex));
			this.#commandIndex = nextIndex;
			this.#commitSeq = nextSeq;
   this.#apply(record);
		} catch (error) {
			this.#status = "fail-closed";
			throw durabilityFailed(`control store persistence failed; close and reopen to recover: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { commitSeq: nextSeq, command: structuredClone(command) };
	}

 /** Trusted in-process storage ports; callers must authorize disclosure. */
 readRun(runId: string): ApprovalRun | undefined { this.readJournal(); return structuredClone(this.#states.get(runId)?.run); }
 listRuns(): ApprovalRun[] { this.readJournal(); return [...this.#states.values()].map(s => structuredClone(s.run)); }
 readRunState(runId: string): ApprovalJournalState | undefined { this.readJournal(); return structuredClone(this.#states.get(runId)); }
 readApproval(id: string) { this.readJournal(); for (const s of this.#states.values()) { const request = s.approvals.find(a => a.approvalRequestId === id); if (request) return structuredClone(request); } }
 listApprovals() { this.readJournal(); return [...this.#states.values()].flatMap(s => structuredClone(s.approvals)); }
 readOutbox(runId: string) { this.readJournal(); return structuredClone(this.#states.get(runId)?.outbox ?? []); }
 readCommittedCommand(binding: CommandBinding): { record: CommandRecord; responseJson: string } | undefined {
  this.readJournal(); this.#assertIdentity(binding.projectId, binding.controlDomainId);
  const record = this.#commandIndex.get(binding.commandId); if (!record) return;
  if (record.callerPrincipal !== binding.callerPrincipal) throw new ControlError("TF_CROSS_PRINCIPAL_COMMAND", "command belongs to another principal");
  if (record.kind !== binding.kind || record.requestHash !== binding.requestHash) throw new ControlError("TF_IDEMPOTENCY_CONFLICT", "command identity has different request content");
  const saved = this.#responses.get(binding.commandId);
  if (!saved) throw durabilityFailed("committed command has no immutable response");
  return structuredClone({ record: saved.record, responseJson: saved.responseJson });
 }
 createRun(run: ApprovalRun, events: readonly ApprovalJournalEvent[] = [], result?: {command: CommandRecord; responseJson: string}): ApprovalRun {
  this.#assertOpen(); if (this.#states.has(run.runId)) throw new ControlError("TF_IDEMPOTENCY_CONFLICT", "run already exists");
  const state = { run: structuredClone(run), approvals: [], outbox: [] };
  this.#commitLifecycle(state, events, result?.command, result?.responseJson); return structuredClone(run);
 }
 mutateRun(runId: string, expectedRunVersion: number, build: (state: ApprovalJournalState, meta: {commitSeq: number}) => ApprovalMutation, binding?: CommandBinding): ApprovalCommit {
  this.#assertOpen();
  if (binding) {
   const previous = this.readCommittedCommand(binding);
   if (previous) { const saved = this.#responses.get(binding.commandId)!; return {...structuredClone(saved.state), commitSeq: saved.record.lastCommitSeq, responseJson: saved.responseJson}; }
  }
  if (this.#writing) throw durabilityFailed("nested project mutations are forbidden");
  const state = this.#states.get(runId);
  if (!state || state.run.runVersion !== expectedRunVersion) throw new ControlError("TF_STALE_VERSION", "run version changed");
  this.#writing = true;
  try {
   const next = build(structuredClone(state), {commitSeq: this.#commitSeq + 1});
   if (next.run.runId !== runId || next.run.runVersion !== expectedRunVersion + 1) throw durabilityFailed("mutation must advance the same run exactly once");
   if (binding && next.command && (next.command.commandId !== binding.commandId || next.command.requestHash !== binding.requestHash || next.command.callerPrincipal !== binding.callerPrincipal || next.command.kind !== binding.kind)) throw durabilityFailed("mutation command differs from checked identity");
   this.#commitLifecycle({run:next.run, approvals:next.approvals, outbox:next.outbox}, next.events, next.command, next.responseJson);
   return {...structuredClone({run:next.run, approvals:next.approvals, outbox:next.outbox}), commitSeq:this.#commitSeq, ...(next.responseJson !== undefined ? {responseJson:next.responseJson}: {})};
  } finally { this.#writing = false; }
 }
 readAdmission(binding: AdmissionBinding): AdmissionDecision | undefined {
  this.readJournal(); this.#assertIdentity(binding.projectId, binding.projectControlDomainId);
  const prior = this.#admissions.get(binding.reservationId);
  if (prior && prior.runId !== binding.runId) throw durabilityFailed("reservation is bound to another run");
  if(prior) return structuredClone(prior);
  const run=this.#states.get(binding.runId)?.run;
  if(run?.reservationId===binding.reservationId&&run.projectAdmitCommitSeq) return {...binding,status:"admitted",decisionCommitSeq:run.projectAdmitCommitSeq,runVersion:run.runVersion};
  return undefined;
 }
 admitRun(binding: AdmissionBinding, expectedRunVersion: number): AdmissionDecision { return this.decideAdmission(binding, "admitted", expectedRunVersion); }
 abandonAdmissionIfAbsent(binding: AdmissionBinding): AdmissionDecision { return this.decideAdmission(binding, "abandoned"); }
 decideAdmission(binding: AdmissionBinding, status: "admitted" | "abandoned", expectedRunVersion?: number): AdmissionDecision {
  const prior = this.readAdmission(binding); if (prior) return prior;
  const old = this.#states.get(binding.runId);
  // Upgrade pre-existing admission facts before allowing an abandonment decision.
  if (old?.run.reservationId === binding.reservationId && old.run.projectAdmitCommitSeq) return { ...binding, status:"admitted", decisionCommitSeq:old.run.projectAdmitCommitSeq, runVersion:old.run.runVersion };
  if (status === "admitted" && (!old || old.run.status !== "running" || !["linked","queued"].includes(old.run.stage) || old.run.requiresReadmission || old.run.runVersion !== expectedRunVersion)) throw new ControlError("TF_STALE_VERSION", "admission run version changed");
  const decision: AdmissionDecision = {...binding, status, decisionCommitSeq:this.#commitSeq+1, runVersion: status === "admitted" ? old!.run.runVersion+1 : old?.run.runVersion ?? 0};
  const projection = status === "admitted" ? {...structuredClone(old!), run:{...old!.run, status:"running" as const, stage:"admitted" as const, slot:"reserved" as const, reservationId:binding.reservationId, projectAdmitCommitSeq:decision.decisionCommitSeq, runVersion:decision.runVersion}} : undefined;
  this.#commitLifecycle(projection, [], undefined, undefined, decision); return structuredClone(decision);
 }
 get journalTip(): {commitSeq:number; hash:string} { this.#assertOpen(); return {commitSeq:this.#commitSeq,hash:this.#tip}; }
 readJournal(): JournalBatch[] {
  this.#assertOpen();
  const batches=readJournalBatches(journalPath(this.storePath)); let tip=JOURNAL_GENESIS,seq=0;
  for (const b of batches) {
   if (b.commitSeq !== ++seq || b.events.some(e=>e.projectId!==this.#header.projectId||e.controlDomainId!==this.#header.controlDomainId) || b.recordKind==="lifecycle-batch" && b.previousHash!==tip) throw durabilityFailed("journal changed or lost identity");
   tip=b.recordKind==="lifecycle-batch"?b.contentHash:journalHash(b);
  }
  if(seq!==this.#commitSeq||tip!==this.#tip) throw durabilityFailed("journal differs from held writer state");
  const file=journalPath(this.storePath); if(fs.existsSync(file)) {const bytes=fs.readFileSync(file); if(bytes.length&&bytes.at(-1)!==10) throw durabilityFailed("journal has torn trailing evidence");}
  return structuredClone(batches);
 }
 withWriter<T>(operation:()=>Promise<T>):Promise<T> {
  if(this.#fenceOwner && this.#fence.getStore()===this.#fenceOwner) return operation();
  const task=this.#fenceQueue.then(async()=>{
   this.#assertOpen(); const owner=Symbol("project-writer"); this.#fenceOwner=owner;
   try { return await this.#fence.run(owner,operation); } finally { this.#fenceOwner=undefined; }
  }); this.#fenceQueue=task.catch(()=>{}); return task;
 }
 recordRunEvidence(runId:string, metadata:{buildInfo:BuildInfoWire;assurance:ReceiptAssurance}):void {
  const records=this.readJournal();
  const prior=records.find(b=>b.recordKind==="lifecycle-batch"&&b.evidenceMetadata?.runId===runId) as LifecycleBatch|undefined;
  if(prior) {if(JSON.stringify(prior.evidenceMetadata)!==JSON.stringify({runId,...metadata})) throw durabilityFailed("run evidence metadata is immutable"); return;}
  const old=this.#states.get(runId); if(!old) throw durabilityFailed("run does not exist");
  const next={...structuredClone(old),run:{...old.run,runVersion:old.run.runVersion+1}};
  this.#commitLifecycle(next,[],undefined,undefined,undefined,{evidenceMetadata:{runId,...metadata}});
 }
 appendReceipt(runId:string, evidence:{receipt:Receipt;receiptRef:ArtifactRef;manifestProofRef:ArtifactRef}, expectedBatchTip:{commitSeq:number;hash:string}):void {
  this.#checkTip(expectedBatchTip);
  if(this.readJournal().some(b=>b.recordKind==="lifecycle-batch"&&b.receipt?.runId===runId)) throw new ControlError("TF_IDEMPOTENCY_CONFLICT","receipt already issued");
  const old=this.#states.get(runId); if(!old||evidence.receipt.runId!==runId||!["completed","failed","blocked","cancelled"].includes(old.run.status)) throw durabilityFailed("receipt requires same terminal run");
  const next={...structuredClone(old),run:{...old.run,runVersion:old.run.runVersion+1}};
  this.#commitLifecycle(next,[{eventId:crypto.randomUUID(),recordedAt:Date.now(),payload:{kind:"receipt.issued",receipt:evidence.receipt}}],undefined,undefined,undefined,evidence);
 }
 appendCheckpoint(throughCommitSeq:number, expectedBatchTip:{commitSeq:number;hash:string}):void {
  this.#checkTip(expectedBatchTip);
  const run=[...this.#states.values()][0]; if(!run||throughCommitSeq<1||throughCommitSeq>this.#commitSeq) throw durabilityFailed("invalid compaction checkpoint");
  const next={...structuredClone(run),run:{...run.run,runVersion:run.run.runVersion+1}};
  this.#commitLifecycle(next,[{eventId:crypto.randomUUID(),recordedAt:Date.now(),payload:{kind:"compaction.checkpoint",throughCommitSeq}}]);
 }
 #checkTip(tip:{commitSeq:number;hash:string}) { this.readJournal(); if(tip.commitSeq!==this.#commitSeq||tip.hash!==this.#tip) throw new ControlError("TF_STALE_VERSION","journal tip changed"); }

 #assertIdentity(projectId: string, controlDomainId: string) {
  if (projectId !== this.#header.projectId || controlDomainId !== this.#header.controlDomainId) throw durabilityFailed("project/domain differs from authoritative store header");
 }
 #apply(batch: JournalBatch) {
  this.#tip = batch.recordKind === "lifecycle-batch" ? batch.contentHash : journalHash(batch);
  if (batch.command) this.#commandIndex.set(batch.command.commandId, structuredClone(batch.command));
  if (batch.recordKind !== "lifecycle-batch") return;
  if (batch.projection) this.#states.set(batch.projection.run.runId, structuredClone(batch.projection));
  if (batch.admission) this.#admissions.set(batch.admission.reservationId, structuredClone(batch.admission));
  if (batch.command && batch.responseJson !== undefined && batch.projection) this.#responses.set(batch.command.commandId, {record:structuredClone(batch.command), responseJson:batch.responseJson, state:structuredClone(batch.projection)});
 }
 #commitLifecycle(projection: ApprovalJournalState | undefined, facts: readonly ApprovalJournalEvent[], command?: CommandRecord, responseJson?: string, admission?: AdmissionDecision, evidence?: Pick<LifecycleBatch,"receipt"|"receiptRef"|"manifestProofRef"|"evidenceMetadata">) {
  this.#assertOpen(); this.#assertFence(); this.readJournal(); if (this.#status === "fail-closed") throw durabilityFailed("store is fail-closed");
  if (projection) {
   this.#assertIdentity(projection.run.projectId, projection.run.controlDomainId);
   if (!Value.Check(ProjectStateSchema, projection) || projection.approvals.some(a => a.runId !== projection.run.runId) || projection.outbox.some(o => o.runId !== projection.run.runId)) throw durabilityFailed("invalid project projection");
  }
  const seq = this.#commitSeq + 1;
  if(projection) {
   const previous=this.#states.get(projection.run.runId);
   for(const intent of projection.outbox) {
    if(intent.kind!=="approval.readmission" || previous?.outbox.some(old=>old.intentId===intent.intentId)) continue;
    const r=intent.reservation, run=projection.run, winner=this.#admissions.get(r.reservationId);
    if(winner || admission || r.projectId!==run.projectId || r.projectControlDomainId!==run.controlDomainId || r.runId!==run.runId || run.reservationId!==r.reservationId || intent.projectAdmitCommitSeq!==seq || run.projectAdmitCommitSeq!==seq || run.stage!=="admitted") throw new ControlError("TF_STALE_VERSION","readmission lost admission arbitration or binding changed");
    admission={reservationId:r.reservationId,projectId:r.projectId,projectControlDomainId:r.projectControlDomainId,runId:r.runId,status:"admitted",decisionCommitSeq:seq,runVersion:run.runVersion};
   }
  }
  if (command) {
   this.#assertIdentity(command.projectId, command.controlDomainId);
   if (this.#commandIndex.has(command.commandId)) throw new ControlError("TF_IDEMPOTENCY_CONFLICT", "command already exists");
   command = {...structuredClone(command), firstCommitSeq:seq, lastCommitSeq:seq};
   if (responseJson === undefined || !projection) throw durabilityFailed("lifecycle command requires immutable response and projection");
   try { JSON.parse(responseJson); } catch { throw durabilityFailed("invalid command response JSON"); }
  } else if (responseJson !== undefined) throw durabilityFailed("response requires a command");
  const id = crypto.randomUUID(), runId = projection?.run.runId ?? admission!.runId;
  const entries: ApprovalJournalEvent[] = facts.length ? structuredClone([...facts]) : [{eventId:id, recordedAt:Date.now(), payload: projection ? {kind:"run.snapshot", run:projection.run} : {kind:"reconcile.started", attempt:1}}];
  const events: ControlEvent[] = entries.map((fact,index) => ({...fact, schemaVersion:2, projectId:this.#header.projectId, controlDomainId:this.#header.controlDomainId, streamId:runId, streamSeq:seq, commitSeq:seq, causationId:command?.commandId ?? id, correlationId:runId, ...(command ? {commandId:command.commandId,commandEventIndex:index}: {})}));
  const body: Omit<LifecycleBatch,"contentHash"> = {recordKind:"lifecycle-batch", schemaVersion:2, commitSeq:seq, previousHash:this.#tip, events, ...(projection ? {projection:structuredClone(projection)}:{}), ...(command ? {command}:{}), ...(responseJson !== undefined ? {responseJson}:{}), ...(admission ? {admission}: {}), ...evidence};
  const batch: LifecycleBatch = {...body, contentHash:journalHash(body)};
  if (!validJournalBatch(batch)) throw durabilityFailed("lifecycle batch schema invalid");
  try {
   crashDuringJournalAppend(journalPath(this.storePath)); appendJsonLineDurable(journalPath(this.storePath), batch);
   maybeCrash("lifecycle-committed");
   writeJsonAtomicHardened(commitSeqPath(this.storePath), {commitSeq:seq});
   this.#apply(batch); this.#commitSeq = seq;
  } catch (e) { this.#status = "fail-closed"; throw durabilityFailed(`lifecycle persistence failed: ${String(e)}`); }
 }

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#releaseWriter();
	}

 #assertFence():void { if(this.#fenceOwner && this.#fence.getStore()!==this.#fenceOwner) throw new ControlError("TF_STALE_VERSION","project writer is held by another operation"); }
 #assertOpen(): void {
  if (this.#closed) throw durabilityFailed("control store is closed");
  const st=fs.lstatSync(this.storePath), binding=this.#header.directoryBinding;
  for(const child of [LOCK_NAME,HEADER_NAME,JOURNAL_DIR,PROJECTIONS_DIR,COMMANDS_DIR,RECEIPTS_DIR]) assertNotSymlink(path.join(this.storePath,child));
  if(fs.readFileSync(path.join(this.storePath,HEADER_NAME),"utf8")!==this.#headerProof) throw durabilityFailed("durable project header changed");
  if(fs.readFileSync(path.join(this.storePath,LOCK_NAME),"utf8")!==this.#writerProof) throw durabilityFailed("project writer ownership changed");
  if(st.isSymbolicLink()||String(st.dev)!==binding.device||String(st.ino)!==binding.inode||fs.realpathSync(this.storePath)!==binding.canonicalPath) throw durabilityFailed("store directory identity changed");
 }

}

export function openControlStore(storePath: string, options: OpenControlStoreOptions = {}): ControlStore {
	const resolved = path.resolve(storePath);
	ensureDirectory(resolved);
	const releaseWriter = acquireWriterLock(resolved);

	try {
		const existingHeader = readHeader(resolved);
		if (existingHeader === undefined) {
			// A missing identity is only an uninitialized store when nothing else
			// exists. Never assign a new project ID or reset an existing ledger.
			// Other contenders can be preparing their unpublished lock files.
			const candidateName = /^\.writer\.lock-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
			if (fs.readdirSync(resolved, { withFileTypes: true }).some((entry) =>
				entry.name !== LOCK_NAME && !(entry.isFile() && candidateName.test(entry.name)))) {
				throw durabilityFailed(`missing control store header in nonempty store at ${resolved}`);
			}
			const header = createHeader(resolved, options);
			writeJsonAtomicHardened(headerPath(resolved), header);
			maybeCrash("header-fsynced");
			writeJsonAtomicHardened(commitSeqPath(resolved), { commitSeq: 0 });
			ensureDirectory(path.join(resolved, JOURNAL_DIR));
			ensureDirectory(path.join(resolved, PROJECTIONS_DIR));
			ensureDirectory(path.join(resolved, COMMANDS_DIR));
			ensureDirectory(path.join(resolved, RECEIPTS_DIR));
			fsyncDirectory(resolved);
			return new ControlStore(resolved, header, 0, [], releaseWriter);
		}

		// Recovery may rewrite projections, so verify the authoritative binding
		// first. A copied/moved/replaced store is not proof of the same project.
		// Never reset UUIDs or rewrite historical evidence to make it attach.
		if (options.projectId && options.projectId !== existingHeader.projectId || options.controlDomainId && options.controlDomainId !== existingHeader.controlDomainId) throw durabilityFailed("requested identity differs from existing store");
  const binding = existingHeader.directoryBinding;
		const stat = fs.statSync(resolved);
		if (binding.canonicalPath !== fs.realpathSync(resolved)
			|| binding.device !== String(stat.dev) || binding.inode !== String(stat.ino)) {
			throw durabilityFailed("control store directory identity changed; explicit verified rebind or a new project store is required");
		}
		for (const child of [JOURNAL_DIR,PROJECTIONS_DIR,COMMANDS_DIR,RECEIPTS_DIR]) assertNotSymlink(path.join(resolved,child));
  const recovered = recoverFromJournal(resolved, existingHeader);
		return new ControlStore(resolved, existingHeader, recovered.commitSeq, recovered.commands, releaseWriter, recovered.batches);
	} catch (error) {
		releaseWriter();
		throw error;
	}
}

function createHeader(storePath: string, options: OpenControlStoreOptions): ControlStoreHeader {
	const st = fs.statSync(storePath);
	return {
		projectId: options.projectId ?? crypto.randomUUID(),
		controlDomainId: options.controlDomainId ?? crypto.randomUUID(),
		schemaVersion: CONTROL_WIRE_SCHEMA_VERSION,
		directoryBinding: {
			canonicalPath: fs.realpathSync(storePath),
			device: String(st.dev),
			inode: String(st.ino),
		},
	};
}

function readHeader(storePath: string): ControlStoreHeader | undefined {
	const file = headerPath(storePath);
	assertNotSymlink(file);
	if (!fs.existsSync(file)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw durabilityFailed(`unreadable control store header at ${file}`);
	}
	if (!Value.Check(ControlStoreHeaderSchema, raw)) {
		throw durabilityFailed(`malformed control store header at ${file}`);
	}
	return raw;
}

function recoverFromJournal(
	storePath: string,
	header: ControlStoreHeader,
): { commitSeq: number; commands: CommandRecord[]; batches: JournalBatch[] } {
 const batches = readJournalBatches(journalPath(storePath));
 const commands: CommandRecord[] = [], commandIds = new Set<string>();
 const runs = new Map<string, ApprovalJournalState>(), admissions = new Set<string>();
 let commitSeq = 0, tip = JOURNAL_GENESIS;
 for (const batch of batches) {
  if (batch.commitSeq !== commitSeq + 1) throw durabilityFailed("journal sequence gap");
  if (batch.command) {
   const c = batch.command;
   if (c.projectId !== header.projectId || c.controlDomainId !== header.controlDomainId || commandIds.has(c.commandId) || c.firstCommitSeq !== batch.commitSeq || c.lastCommitSeq !== batch.commitSeq) throw durabilityFailed("journal command binding/sequence invalid");
   commandIds.add(c.commandId); commands.push(c);
  }
  for (const [index,event] of batch.events.entries()) {
   if (event.projectId !== header.projectId || event.controlDomainId !== header.controlDomainId || event.commitSeq !== batch.commitSeq || (batch.command && (event.commandId !== batch.command.commandId || event.commandEventIndex !== index)) || (!batch.command && event.commandId !== undefined)) throw durabilityFailed("journal event binding/sequence invalid");
  }
  if (batch.recordKind === "lifecycle-batch") {
   if (batch.previousHash !== tip) throw durabilityFailed("journal hash chain mismatch");
   if (batch.command && (batch.responseJson === undefined || !batch.projection)) throw durabilityFailed("missing immutable command response");
   if (batch.responseJson !== undefined) { if (!batch.command) throw durabilityFailed("orphan command response"); try { JSON.parse(batch.responseJson); } catch { throw durabilityFailed("invalid immutable response"); } }
   if (batch.projection) {
    const state = batch.projection, run = state.run, old = runs.get(run.runId);
    if (run.projectId !== header.projectId || run.controlDomainId !== header.controlDomainId || state.approvals.some(a => a.runId !== run.runId) || state.outbox.some(o => o.runId !== run.runId) || (old && run.runVersion !== old.run.runVersion + 1)) throw durabilityFailed("journal projection binding/version invalid");
    runs.set(run.runId,state);
   }
   if (batch.admission) {
    const d = batch.admission;
    if (d.projectId !== header.projectId || d.projectControlDomainId !== header.controlDomainId || d.decisionCommitSeq !== batch.commitSeq || admissions.has(d.reservationId)) throw durabilityFailed("admission binding invalid");
    admissions.add(d.reservationId);
   }
   tip = batch.contentHash;
  } else tip = journalHash(batch);
  commitSeq = batch.commitSeq;
 }

	const onDiskSeq = readCommitSeqFile(storePath);
	if (onDiskSeq !== undefined && onDiskSeq > commitSeq) {
		throw durabilityFailed(
			`mixed state: commit-seq.json (${onDiskSeq}) is ahead of journal (${commitSeq})`,
		);
	}
	// Validate the complete authoritative state before any recovery write. A
	// torn tail is recoverable only when the preceding ledger is consistent.
	// Damaged/torn evidence is preserved; recovery never rewrites journal bytes.
	ensureDirectory(path.join(storePath, JOURNAL_DIR));
	ensureDirectory(path.join(storePath, PROJECTIONS_DIR));
	ensureDirectory(path.join(storePath, COMMANDS_DIR));
	ensureDirectory(path.join(storePath, RECEIPTS_DIR));
	writeJsonAtomicHardened(commitSeqPath(storePath), { commitSeq });
	writeJsonAtomicHardened(
		commandIndexPath(storePath),
		Object.fromEntries(commands.map((command) => [command.commandId, command])),
	);
	return { commitSeq, commands, batches };
}

function readCommitSeqFile(storePath: string): number | undefined {
	const file = commitSeqPath(storePath);
	assertNotSymlink(file);
	if (!fs.existsSync(file)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw durabilityFailed(`unreadable commit-seq.json at ${file}`);
	}
	if (!raw || typeof raw !== "object" || !("commitSeq" in raw)
		|| typeof raw.commitSeq !== "number" || !Number.isSafeInteger(raw.commitSeq) || raw.commitSeq < 0) {
		throw durabilityFailed(`malformed commit-seq.json at ${file}`);
	}
	return raw.commitSeq;
}

function readJournalBatches(filePath: string): JournalBatch[] {
	assertNotSymlink(filePath);
	if (!fs.existsSync(filePath)) return [];
	const raw = fs.readFileSync(filePath);
	const text = raw.toString("utf8");
	if (raw.length && raw[raw.length-1] !== 10) throw durabilityFailed("incomplete journal tail; preserve evidence for explicit recovery");
 const lines = text.split("\n");
	const complete = text.endsWith("\n") ? lines.slice(0, -1) : lines.slice(0, -1);
	// Every authoritative line must be complete; damaged bytes remain untouched.
	const batches: JournalBatch[] = [];
	for (const line of complete) {
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw durabilityFailed("journal contains a complete but unreadable line");
		}
  if (!validJournalBatch(parsed)) throw durabilityFailed("journal contains a malformed commit batch");
		batches.push(parsed as JournalBatch);
	}
	return batches;
}

/** Publish a fully written owner atomically; a visible lock is never half-written. */
export function acquireWriterLock(storePath: string): () => void {
	const lockPath = path.join(storePath, LOCK_NAME);
	const owner: WriterLock = { ownerId: crypto.randomUUID(), pid: process.pid, acquiredAt: Date.now() };
	const contents = JSON.stringify(owner);
	const candidatePath = path.join(storePath, `.${LOCK_NAME}-${owner.ownerId}`);
	const fd = fs.openSync(candidatePath, "wx", 0o600);
	try {
		try {
			fs.writeFileSync(fd, contents);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				// Hard-link creation is exclusive, unlike rename (which overwrites).
				fs.linkSync(candidatePath, lockPath);
				fsyncDirectory(storePath);
				return () => releaseWriterLock(lockPath, contents);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (reclaimDeadWriter(lockPath)) continue;
				throw durabilityFailed(`control store already has a live or unverified writer at ${storePath}`);
			}
		}
		throw durabilityFailed(`could not acquire control store writer lock at ${storePath}`);
	} finally {
		try { fs.unlinkSync(candidatePath); } catch { /* best effort */ }
	}
}

function releaseWriterLock(lockPath: string, contents: string): void {
	try {
		assertNotSymlink(lockPath);
		// The exact acquisition owns the lock, not every store in this process.
		if (fs.readFileSync(lockPath, "utf8") !== contents) return;
		fs.unlinkSync(lockPath);
	} catch {
		/* best effort */
	}
}

function reclaimDeadWriter(lockPath: string): boolean {
	let contents: string;
	try {
		assertNotSymlink(lockPath);
		contents = fs.readFileSync(lockPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
	if (!isVerifiedDeadWriter(contents)) return false;
	// Serialize reclamation of this exact generation. Without this claim, two
	// reclaimers can both observe a dead PID and one can unlink the other's
	// newly acquired lock. A crashed reclaimer leaves an unverified claim:
	// fail closed for operator recovery rather than risk a second writer.
	const generation = crypto.createHash("sha256").update(contents).digest("hex");
	const claimPath = `${lockPath}.reclaim-${generation}`;
	try {
		fs.mkdirSync(claimPath, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		assertNotSymlink(lockPath);
		if (fs.readFileSync(lockPath, "utf8") !== contents) return true;
		if (!isVerifiedDeadWriter(contents)) return false;
		fs.unlinkSync(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	} finally {
		fs.rmdirSync(claimPath);
	}
}

function isVerifiedDeadWriter(contents: string): boolean {
	try {
		const raw: unknown = JSON.parse(contents);
		if (!raw || typeof raw !== "object" || !("pid" in raw)
			|| typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid <= 0
			|| !("acquiredAt" in raw) || typeof raw.acquiredAt !== "number"
			|| !Number.isSafeInteger(raw.acquiredAt) || raw.acquiredAt < 0
			|| ("ownerId" in raw && (typeof raw.ownerId !== "string"
				|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.ownerId)))) return false;
		process.kill(raw.pid, 0);
		return false;
	} catch (error) {
		// Empty, malformed, inaccessible, and EPERM locks are unverified/live.
		// Only the OS confirming that the recorded process is gone allows steal.
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

export function maybeCrash(point: ControlCrashPoint): void {
	if (process.env[CONTROL_CRASH_ENV] === point) {
		process.kill(process.pid, "SIGKILL");
	}
}

/** SIGKILL after a torn (unterminated) journal write — process-level A4. */
function crashDuringJournalAppend(filePath: string): void {
	if (process.env[CONTROL_CRASH_ENV] !== "journal-append") return;
	ensureDirectory(path.dirname(filePath));
	const fd = fs.openSync(filePath, "a", 0o600);
	try {
		fs.writeSync(fd, Buffer.from("{\"recordKind\":\"commit-batch\""));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	process.kill(process.pid, "SIGKILL");
}

export function writeJsonAtomicHardened(filePath: string, value: unknown): void {
	assertNotSymlink(filePath);
	const directory = path.dirname(filePath);
	ensureDirectory(directory);
	let temp = "";
	let fd = -1;
	for (let attempt = 0; attempt < 8; attempt++) {
		temp = path.join(directory, `.${crypto.randomUUID()}`);
		try {
			fd = fs.openSync(temp, "wx", 0o600);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
	}
	if (fd < 0) throw durabilityFailed(`could not create exclusive temp file for ${filePath}`);
	try {
		fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		assertNotSymlink(filePath);
		fs.renameSync(temp, filePath);
		fsyncDirectory(directory);
	} catch (error) {
		try { fs.unlinkSync(temp); } catch { /* best effort */ }
		throw error;
	}
}

function appendJsonLineDurable(filePath: string, record: unknown): void {
	assertNotSymlink(filePath);
	ensureDirectory(path.dirname(filePath));
	const existed = fs.existsSync(filePath);
 if (existed) { const raw=fs.readFileSync(filePath); if(raw.length&&raw.at(-1)!==10) throw durabilityFailed("refusing append after incomplete journal tail"); }
	const fd = fs.openSync(filePath, "a", 0o600);
	try {
		const data = Buffer.from(`${JSON.stringify(record)}\n`);
		let offset = 0;
		while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	if (!existed) fsyncDirectory(path.dirname(filePath));
}

function assertNotSymlink(filePath: string): void {
	try {
		const st = fs.lstatSync(filePath);
		if (st.isSymbolicLink()) {
			throw durabilityFailed(`refusing to touch symlink at ${filePath}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

function ensureDirectory(directory: string): void {
	assertNotSymlink(directory);
 fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
 assertNotSymlink(directory);
}

function fsyncDirectory(directory: string): void {
	try {
		const fd = fs.openSync(directory, "r");
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
 } catch (error) {
  const code=(error as NodeJS.ErrnoException).code;
  // Only explicit platform lack of directory-fsync support is tolerated.
  // I/O, capacity and permission failures must never become a successful commit.
  if(code === "EINVAL" || code === "ENOTSUP" || process.platform === "win32" && (code === "EISDIR" || code === "EPERM")) return;
  throw error;
 }
}

function durabilityFailed(message: string): ControlError {
	return new ControlError("TF_DURABILITY_FAILED", message, {
		recoveryAction: "none",
		sideEffects: "unknown",
	});
}

function headerPath(storePath: string): string {
	return path.join(storePath, HEADER_NAME);
}

function commitSeqPath(storePath: string): string {
	return path.join(storePath, COMMIT_SEQ_NAME);
}

function journalPath(storePath: string): string {
	return path.join(storePath, JOURNAL_DIR, JOURNAL_SEGMENT);
}

function commandIndexPath(storePath: string): string {
	return path.join(storePath, PROJECTIONS_DIR, COMMAND_INDEX);
}

export function controlStorePaths(storePath: string) {
	return {
		header: headerPath(storePath),
		commitSeq: commitSeqPath(storePath),
		journal: journalPath(storePath),
		commandIndex: commandIndexPath(storePath),
		lock: path.join(storePath, LOCK_NAME),
	};
}
