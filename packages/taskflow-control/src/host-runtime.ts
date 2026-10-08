/** Authenticated mounted-project command service. All lifecycle facts are written
 * through ControlStore; coordinator authority reads those same durable facts. */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { getBuildInfo, compileTaskflowToIR, validateTaskflow, type Taskflow } from "taskflow-core";
import { Value } from "typebox/value";
import { ControlError } from "./errors.ts";
import { LegacyConflictGuard } from "./legacy-conflict.ts";
import { ProjectRegistry, type ProjectMount } from "./project-registry.ts";
import { type AuthorizationAuthority, type VerifiedContext } from "./authorization.ts";
import { UserCoordinatorStore } from "./store/coordinator-store.ts";
import { ProjectAdmissionService } from "./admission-service.ts";
import { RuntimeTeExecutionProvider } from "./runtime-provider.ts";
import { commandRequestHash, type CommandRecord, type ControlEventPayload } from "./schema/commands.ts";
import { CONTROL_WIRE_SCHEMA_VERSION, UuidSchema } from "./schema/common.ts";
import type { BoundPlan } from "./schema/plan.ts";
import type { RunSnapshot } from "./schema/run.ts";
import { ApprovalService, type ApprovalRun, type ApprovalDecisionInput, type ApprovalAuthority } from "./approval-service.ts";
import type { ApprovalMode, ApprovalRequest as DurableApprovalRequest } from "./schema/approval.ts";
import type { ArtifactRef } from "./schema/evidence.ts";
import { decodeApprovalEdit, validateApprovalOutputEdit, validateApprovalPlanEdit, MAX_APPROVAL_EDIT_BYTES } from "./approval-edits.ts";
import type { ApprovalRequest, ApprovalDecision } from "taskflow-core";
import type { CoordinatorLease, ConcurrencyReservation } from "./schema/coordinator.ts";
import type { EvidenceStore, TerminalEvidenceObservation } from "./store/evidence-store.ts";
import { explainControlEvidence } from "./store/evidence-explanation.ts";
import type { ControlStore } from "./store/store.ts";

export interface HostRuntimeOptions {
 registry: ProjectRegistry; authorization: AuthorizationAuthority; provider: RuntimeTeExecutionProvider;
 controlHome: string; epoch: () => number; holderId: () => string; liveLease: () => CoordinatorLease | null;
 maxActiveRuns?: number;
 durableApprovalAvailable?: (context:VerifiedContext)=>boolean;
 evidenceFactory?: (mount: ProjectMount, verify: HostRuntime["verifyTerminal"]) => EvidenceStore | Promise<EvidenceStore>;
}
function fail(message: string): never { throw new ControlError("TF_COMMAND_FAILED", message); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("RPC requires an object"); return value as Record<string, unknown>; }
function id(value: unknown): string { if (!Value.Check(UuidSchema, value)) fail("UUID required"); return value as string; }
const fact = (payload: ControlEventPayload) => ({ eventId: randomUUID(), recordedAt: Date.now(), payload });

export class HostRuntime {
 readonly options: HostRuntimeOptions;
 readonly coordinator: UserCoordinatorStore<VerifiedContext>;
 readonly #evidence = new Map<string, Promise<EvidenceStore>>();
 readonly #approvals = new Map<string, ApprovalService<VerifiedContext>>();
 readonly #linked = new Map<string, {flow:Taskflow; plan:BoundPlan}>();
 #closed = false;
 readonly #submitting = new Set<string>();
 readonly #refreshes = new Map<string,Promise<ApprovalRun>>();
 constructor(options: HostRuntimeOptions) {
  this.options = options;
  this.coordinator = new UserCoordinatorStore(path.join(options.controlHome, "coordinator"), { initialMaxActiveRuns: options.maxActiveRuns ?? 1,
   epoch: options.epoch(), holderId: options.holderId(), authority: {
    readLease: options.liveLease,
    authorize: async (context, operation, reservation) => {
     const identity = options.authorization.identity(context);
     const mount = options.registry.resolve(reservation?.projectId ?? identity.binding.projectId);
     const kind = operation === "forceRelease" ? "coordinator.forceRelease" : operation === "setMaxActiveRuns" ? "coordinator.setMaxActiveRuns" : "run.submit";
     const decision = await this.#authorize(context, mount, operation === "snapshot" || operation === "readReservation" ? "read" : "submit", kind);
     return { principal: decision.principal, ownerId: decision.principal, operator: operation === "forceRelease" || operation === "setMaxActiveRuns" };
    },
    readAdmission: reservation => this.#admission(reservation).readAdmission(reservation),
    abandonAdmissionIfAbsent: reservation => this.#admission(reservation).abandonAdmissionIfAbsent(reservation),
    readRelease: async reservation => {
     const store = options.registry.resolve(reservation.projectId).store;
     const run = store.readRun(reservation.runId); if (!run) fail("release run is absent");
     const observed = await options.provider.observe(run.runId);
     const quiet = await options.provider.quiescence(run.runId);
     return { reservationId: reservation.reservationId, projectId: run.projectId, projectControlDomainId: run.controlDomainId, runId: run.runId,
      projectAdmitCommitSeq: run.projectAdmitCommitSeq!, runVersion: run.runVersion, proofId: observed.evidenceCommit,
      status: run.status, stage: run.stage, requiresReadmission: !!run.requiresReadmission,
      providerNoLiveProcessTree: quiet.quiescent, noAmbiguousJobs: observed.status !== "ambiguous" && quiet.noPendingResourceIntents,
      reconcileTimeoutOnly: false };
    },
   } });
 }
 async initialize() { await this.coordinator.initialize(); }
 close() { this.#closed = true; this.coordinator.close(); }
 #admission(r: ConcurrencyReservation) { return new ProjectAdmissionService(this.options.registry.resolve(r.projectId).store); }
 async #authorize(context: VerifiedContext, mount: ProjectMount, operation: "read" | "submit" | "replay", commandKind?: "run.submit" | "run.cancel" | "approval.decide" | "coordinator.setMaxActiveRuns" | "coordinator.forceRelease") {
  const h = mount.store.header;
  return this.options.authorization.authorize(context, { projectId: h.projectId, controlDomainId: h.controlDomainId, projectRoot: mount.projectRoot, operation, ...(commandKind ? { commandKind } : {}) });
 }
 #mutate(store: ControlStore, run: ApprovalRun, changes: Partial<RunSnapshot>, payloads: ControlEventPayload[] = []) {
  return store.mutateRun(run.runId, run.runVersion, state => { const next = { ...state.run, ...changes, runVersion: state.run.runVersion + 1 };
   return { ...state, run: next, events: [...payloads.map(fact), fact({ kind: "run.snapshot", run: next })] }; }).run;
 }
 async dispatch(context: VerifiedContext, method: string, raw: unknown): Promise<unknown> {
  const body = raw === undefined ? {} : object(structuredClone(raw));
  const identity = this.options.authorization.identity(context);
  const projectId = body.projectId === undefined ? identity.binding.projectId : id(body.projectId);
  const mount = this.options.registry.resolve(projectId);
  if (body.controlDomainId !== undefined && body.controlDomainId !== mount.store.header.controlDomainId) throw new ControlError("TF_POLICY_DENIED", "request control domain mismatch");
  await this.#authorize(context, mount, "read");
  switch (method) {
   case "projects.list": return [{ projectId, controlDomainId: mount.store.header.controlDomainId, name: path.basename(mount.projectRoot) }];
   case "control.store.header": return mount.store.header;
   case "control.store.status": return mount.store.snapshot();
   case "coordinator.status": {
    const snapshot = await this.coordinator.snapshot(context);
    await this.#authorize(context, mount, "read");
    return { ...snapshot,
     reservations: snapshot.reservations.filter(row => row.reservation.projectId === projectId && row.reservation.projectControlDomainId === mount.store.header.controlDomainId),
     commands: snapshot.commands.filter(command => command.record.callerPrincipal === identity.principal && (typeof command.result === "number" || command.result.reservation.projectId === projectId && command.result.reservation.projectControlDomainId === mount.store.header.controlDomainId)),
    };
   }
   case "coordinator.setMaxActiveRuns": return this.coordinator.setMaxActiveRuns({commandId:id(body.commandId),maxActiveRuns:body.maxActiveRuns as number},context);
   case "coordinator.forceRelease": return this.coordinator.forceRelease(id(body.reservationId),{commandId:id(body.commandId),riskAcknowledgement:body.riskAcknowledgement as true,reason:body.reason as string},context);
   case "runs.list": return mount.store.listRuns();
   case "commands.submit": return this.#submit(context, mount, body);
   case "runs.get": case "runs.status": case "runs.wait": {
    const runId = id(body.runId); const run = mount.store.readRun(runId); if (!run) fail("run does not exist in this project");
    if (method === "runs.wait" && !["completed", "failed", "blocked", "cancelled"].includes(run.status)) await this.options.provider.wait(runId);
    await this.#refresh(context, mount, runId);
    await this.#authorize(context, mount, "read");
    return mount.store.readRun(runId);
   }
   case "runs.cancel": return this.#cancel(context,mount,body);
   case "runs.result": { await this.#authorize(context,mount,"replay","run.submit"); const runId=id(body.runId); if (!mount.store.readRun(runId)) fail("run is absent"); const observed=await this.options.provider.observe(runId); await this.#authorize(context,mount,"replay","run.submit"); return observed; }
   case "approvals.stageEdit": {
    const runId=id(body.runId),kind=body.editKind;
    if(!["output","plan"].includes(String(kind)) || typeof body.content!=="string" || Buffer.byteLength(body.content)>MAX_APPROVAL_EDIT_BYTES)fail("stageEdit requires bounded output or plan text");
    await this.#authorize(context,mount,"submit","approval.decide");
    const run=mount.store.readRun(runId);if(!run || run.status!=="paused")fail("edit artifact requires a paused approval run");
    const evidence=await this.#evidenceStore(mount);
    const artifact=await evidence.stageArtifact(Buffer.from(body.content,"utf8"),{mediaType:kind==="output"?"text/plain; charset=utf-8":"application/json",storageClass:"project",redactionClass:"internal"});
    await evidence.assertDurableReferences([artifact]);await this.#authorize(context,mount,"submit","approval.decide");
    mount.store.mutateRun(runId,run.runVersion,state=>{
     if(state.run.status!=="paused")fail("approval changed before artifact staging");
     const next={...state.run,runVersion:state.run.runVersion+1};
     return {...state,run:next,approvals:state.approvals.map(item=>item.status==="pending"?{...item,expectedRunVersion:next.runVersion}:item),events:[fact({kind:"artifact.recorded",runId,commandKind:"approval.decide",artifact}),fact({kind:"run.snapshot",run:next})]};
    });
    return artifact;
   }
   case "approval.decide": case "approvals.decide": {
    const input = {commandId:id(body.commandId),runId:id(body.runId),approvalRequestId:id(body.approvalRequestId),expectedRunVersion:body.expectedRunVersion as number,decision:body.decision as ApprovalDecisionInput["decision"],...(body.editArtifactRef!==undefined?{editArtifactRef:body.editArtifactRef as ApprovalDecisionInput["editArtifactRef"]}:{}),...(body.editKind!==undefined?{editKind:body.editKind as "output"|"plan"}:{})};
    const needsRecovery=!this.options.provider.hasLiveExecution(input.runId) && mount.store.readRun(input.runId)?.status==="paused";
    if(needsRecovery){
     const recovered=this.options.provider.recoverableExecution(input.runId);this.#linked.set(input.runId,{plan:recovered.plan,flow:recovered.flow});
    }
    const decision=await this.#approvalService(mount).decide(context,input);
    if(needsRecovery) await this.#resume(context,mount,input.runId);
    return decision;
   }
   case "runs.resume": return this.#resume(context,mount,id(body.runId));
   case "approvals.expire": return this.#approvalService(mount).expireDue(context);
   case "approvals.readmit": return this.#approvalService(mount).readmit(context,{approvalRequestId:id(body.approvalRequestId),expectedRunVersion:body.expectedRunVersion as number});
   case "approvals.list": return mount.store.listApprovals();
   case "evidence.why": return explainControlEvidence(mount.store,context,id(body.runId),{
    authorize:async()=>this.#authorize(context,mount,"replay","run.submit"),readDiagnostic:runId=>this.options.provider.readDiagnostic(runId)
   },{effectId:body.effectId as string|undefined,phaseId:body.phaseId as string|undefined,seeds:body.seeds as string[]|undefined});
   case "receipts.get": {
    const evidence = await this.#evidenceStore(mount); const receipt=await evidence.readReceipt(context, id(body.runId)); return receipt.receipt;
   }
   default: fail(`unsupported authenticated RPC ${method}`);
  }
 }
 async #submit(context: VerifiedContext, mount: ProjectMount, body: Record<string, unknown>) {
  if (Object.keys(body).some(key => !["projectId", "controlDomainId", "commandId", "kind", "flow", "args", "approvalMode"].includes(key))) fail("submit contains untrusted or unsupported fields");
  if (body.kind !== "run.submit") fail("commands.submit requires kind run.submit");
  const commandId = id(body.commandId); const auth = await this.#authorize(context, mount, "submit", "run.submit");
  const h = mount.store.header;
  const binding = { commandId, kind: "run.submit" as const, callerPrincipal: auth.principal, requestHash: commandRequestHash(body), projectId: h.projectId, controlDomainId: h.controlDomainId };
  const previous = mount.store.readCommittedCommand(binding); if (previous) { await this.#authorize(context, mount, "replay", "run.submit"); return JSON.parse(previous.responseJson); }
  new LegacyConflictGuard(mount.projectRoot,mount.store.storePath).assertMayAttempt();
  const validation = validateTaskflow(body.flow); if (!validation.ok) fail(validation.errors.join("; "));
  let mode = (body.approvalMode ?? "compat-auto-reject") as ApprovalMode; if (!["compat-auto-reject","durable-optional","durable-required"].includes(mode)) fail("invalid approval mode");
  if(mode!=="compat-auto-reject" && !this.options.durableApprovalAvailable?.(context)){if(mode==="durable-required")throw new ControlError("TF_FEATURE_REQUIRED","durable-approval was not negotiated by this authenticated client");mode="compat-auto-reject";}
  const flow = structuredClone(body.flow) as Taskflow; const args = body.args === undefined ? {} : object(body.args);
  const compiled = await compileTaskflowToIR(flow); const probe = await this.options.provider.probe();
  if (!compiled.hash || compiled.usedFallbackHash) throw new ControlError("TF_COMMAND_FAILED", "flow cannot be content-addressed at Link");
  const runId = randomUUID(); const owner = { runId, phaseId: "control", attemptId: randomUUID(), unitId: "run", ancestry: [] };
  const planBody = { schemaVersion: CONTROL_WIRE_SCHEMA_VERSION as typeof CONTROL_WIRE_SCHEMA_VERSION, projectId: h.projectId, controlDomainId: h.controlDomainId, planId: randomUUID(),
   bindings: [{ name: "invocation", path: { workspace: "invocation", intent: "existing-directory" as const, access: "read-write" as const } }],
   spawnTemplate: { allowedAgentClasses: ["configured"], allowedProviderClasses: ["te-resources"], maxToolCallsPerStep: 0, maxEffectsPerNode: 1000, maxChildren: 1000, maxDepth: 32, budgetShare: 1 },
   savedFlowPins: [], grantRefs: [], claims: [{ name: "irHash", value: compiled.hash }], enforcementCapabilities: probe.capabilities,
   dynamicPolicy: { hostCeiling: { maxActiveRuns: this.options.maxActiveRuns ?? 1 }, authorizationContextHash: auth.authorizationContextHash } };
  const plan: BoundPlan = { ...planBody, boundPlanHash: `plan:${commandRequestHash(planBody)}` };
  this.#linked.set(runId,{flow,plan});
  const run: ApprovalRun = { runId, projectId: h.projectId, controlDomainId: h.controlDomainId, status: "running", stage: "linked", slot: "none", needsOperator: false, runVersion: 0,
   boundPlanHash: plan.boundPlanHash, policyHash: commandRequestHash(auth.effectivePolicy), authorityEpoch: this.options.epoch(), owner };
  const response = { runId, projectId: h.projectId, controlDomainId: h.controlDomainId, status: "accepted" };
  let reservation: ConcurrencyReservation | undefined;
  const preparation = await this.options.provider.prepareExecution({ plan, flow, args, projectRoot: mount.projectRoot, principal: auth.principal, owner, controlDomainId: h.controlDomainId,
   requestApproval: request => this.#requestApproval(context,mount,runId,request,mode),
   dispatchFence: activate => {if(!reservation)fail("dispatch reservation missing");return this.#dispatchFence(context,mount,reservation.reservationId,activate);},
   beforeDispatch: async () => {
    if (!reservation) fail("dispatch has no admission binding");
    const row = await this.coordinator.readReservation(reservation.reservationId, context); if (!row) fail("dispatch reservation missing");
    await this.#authorize(context, mount, "submit", "run.submit");
    const lease = this.options.liveLease();
    if (!lease || lease.fencingEpoch !== run.authorityEpoch || lease.expiresAt <= Date.now()) throw new ControlError("TF_AUTHORITY_REVOKED", "dispatch fencing epoch is no longer live");
    new ProjectAdmissionService(mount.store).assertDispatch(row.reservation);
   } });
  if (preparation.outcome !== "accepted") throw new ControlError("TF_PROVIDER_AMBIGUOUS", "TE preparation did not accept");
  await this.#authorize(context, mount, "submit", "run.submit");
  const raced = mount.store.readCommittedCommand(binding); if (raced) return JSON.parse(raced.responseJson);
  const command: CommandRecord = { ...binding, authorizationContextHash: auth.authorizationContextHash, status: "accepted", firstCommitSeq: 1, lastCommitSeq: 1, recordedAt: Date.now() };
  this.#submitting.add(runId);
  mount.store.createRun(run, [fact({ kind: "run.snapshot", run })], { command, responseJson: JSON.stringify(response) });

  try {
   reservation = (await this.coordinator.reserve({ projectId: h.projectId, projectControlDomainId: h.controlDomainId, runId, ttlMs: 30000 }, context)).reservation;
   const proof = new ProjectAdmissionService(mount.store).admit(reservation, mount.store.readRun(runId)!.runVersion);
   reservation = (await this.coordinator.commit(reservation.reservationId, { projectAdmitCommitSeq: proof.projectAdmitCommitSeq, attemptId: owner.attemptId }, context)).reservation;
   this.#mutate(mount.store, mount.store.readRun(runId)!, { slot: "committed", stage: "admitted" });
   const result = await this.options.provider.submit({ preparationId: preparation.fulfillment.preparationId, owner, controlDomainId: h.controlDomainId });
   if (result.outcome === "accepted") this.#mutate(mount.store, mount.store.readRun(runId)!, { stage: "executing" }, [{ kind: "dispatch.acknowledged", providerJobHandle: result.providerJobHandle }]);
   else this.#mutate(mount.store, mount.store.readRun(runId)!, { status: "unknown", stage: "reconciling", needsOperator: true }, [{ kind: "dispatch.ambiguous" }]);
  } catch {
   // The command is already durable: report its original acceptance, preserve
   // admission/capacity evidence, and expose uncertainty through run state.
   this.#mutate(mount.store, mount.store.readRun(runId)!, { status: "unknown", stage: "reconciling", needsOperator: true }, [{ kind: "dispatch.ambiguous" }]);
  }
  this.#submitting.delete(runId);
  await this.#authorize(context, mount, "replay", "run.submit"); return response;
 }
 async #dispatchFence<T>(context:VerifiedContext,mount:ProjectMount,reservationId:string,activate:()=>T):Promise<T>{
  return this.coordinator.withDispatch(reservationId,context,async row=>{
   await this.#authorize(context,mount,"submit","run.submit");
   return ()=>{
    const current=this.options.registry.resolve(row.reservation.projectId);
    const run=current.store.readRun(row.reservation.runId),lease=this.options.liveLease();
    if(!run||!lease||lease.fencingEpoch!==this.options.epoch()||run.authorityEpoch!==lease.fencingEpoch||lease.expiresAt<=Date.now())throw new ControlError("TF_AUTHORITY_REVOKED","dispatch authority is no longer live");
    this.options.authorization.identity(context);
    new ProjectAdmissionService(current.store).assertDispatch(row.reservation);
    new LegacyConflictGuard(current.projectRoot,current.store.storePath).assertMayAttempt();
    return activate();
   };
  });
 }
 async #resume(context:VerifiedContext,mount:ProjectMount,runId:string){
  await this.#authorize(context,mount,"submit","run.submit");
  if(this.options.provider.hasLiveExecution(runId))return mount.store.readRun(runId);
  new LegacyConflictGuard(mount.projectRoot,mount.store.storePath).assertMayAttempt();
  let saved=this.options.provider.recoverableExecution(runId);this.#linked.set(runId,{plan:saved.plan,flow:saved.flow});
  let current=mount.store.readRun(runId);if(!current)fail("resume run missing");
  const decision=mount.store.listApprovals().filter(a=>a.runId===runId && ["approved","edited","rejected","expired","cancelled"].includes(a.status)).at(-1);
  if(!decision)throw new ControlError("TF_RECONCILE_REQUIRED","pending approval must be decided before continuation");
  // The prior host may have committed readmission before dying at the still
  // waiting checkpoint. That reservation/owner cannot authorize this process.
  // Recovery above proves the old writer dead; only fresh TE quiescence permits
  // parking and normally releasing its capacity before another readmission.
  if(["approved","edited"].includes(decision.status) && !current.requiresReadmission){
   if(current.status!=="running"||current.stage!=="admitted"||current.slot!=="committed")throw new ControlError("TF_RECONCILE_REQUIRED","only an interrupted committed readmission may be re-parked");
   const quiet=await this.options.provider.quiescence(runId);
   if(!quiet.quiescent||!quiet.noPendingResourceIntents)throw new ControlError("TF_RECONCILE_REQUIRED","prior readmission is not quiescent");
   await this.#authorize(context,mount,"submit","run.submit");
   current=this.#mutate(mount.store,current,{status:"paused",stage:"parked",requiresReadmission:true,needsOperator:false});
   await this.#approvalService(mount).park(context,{runId,expectedRunVersion:current.runVersion});
   current=mount.store.readRun(runId)!;
  }
  if(["approved","edited"].includes(decision.status) && current.requiresReadmission)await this.#approvalService(mount).readmit(context,{approvalRequestId:decision.approvalRequestId,expectedRunVersion:current.runVersion});
  if(decision.status==="edited" && decision.editKind==="plan"){
   const edit=await this.#readApprovalEdit(context,mount,current,decision,{kind:"plan",artifact:decision.editArtifactRef!});
   if(edit.kind!=="plan")fail("plan edit missing");await this.options.provider.applyApprovalPlan(runId,decision.nodeInstanceId,edit.flow);
   saved=this.options.provider.recoverableExecution(runId);this.#linked.set(runId,{plan:saved.plan,flow:saved.flow});
  }
  const run=mount.store.readRun(runId)!;
  const beforeDispatch=async()=>{
   await this.#authorize(context,mount,"submit","run.submit");
   if(!["approved","edited"].includes(decision.status))return; // rejection resumes only the waiting approval; core blocks its dependents
   const row=await this.coordinator.readReservation(run.reservationId!,context);await this.#authorize(context,mount,"submit","run.submit");
   if(!row)fail("resumed reservation missing");new ProjectAdmissionService(mount.store).assertDispatch(row.reservation);
  };
  await this.options.provider.resumeExecution(runId,{...saved,owner:run.owner!,beforeDispatch,dispatchFence:["approved","edited"].includes(decision.status)?activate=>this.#dispatchFence(context,mount,run.reservationId!,activate):undefined,requestApproval:request=>this.#requestApproval(context,mount,runId,request,"durable-required")});
  return mount.store.readRun(runId);
 }
 async #cancel(context: VerifiedContext, mount: ProjectMount, body: Record<string,unknown>) {
  const input={commandId:id(body.commandId),runId:id(body.runId),expectedRunVersion:body.expectedRunVersion as number};
  const auth=await this.#authorize(context,mount,"submit","run.cancel"), h=mount.store.header;
  const binding={commandId:input.commandId,kind:"run.cancel" as const,requestHash:commandRequestHash(input),callerPrincipal:auth.principal,projectId:h.projectId,controlDomainId:h.controlDomainId};
  const prior=mount.store.readCommittedCommand(binding); if(prior) return JSON.parse(prior.responseJson);
  const response={runId:input.runId,status:"cancellation-requested"};
  mount.store.mutateRun(input.runId,input.expectedRunVersion,(state,meta)=>{
   if (["completed","failed","blocked","cancelled"].includes(state.run.status)) throw new ControlError("TF_STALE_VERSION","terminal run cannot be cancelled");
   const run={...state.run,status:"unknown" as const,stage:"reconciling" as const,needsOperator:true,requiresReadmission:false,runVersion:state.run.runVersion+1};
   return {...state,run,approvals:state.approvals.map(a=>a.status==="pending"?{...a,status:"cancelled" as const,decidedAt:Date.now()}:a),events:[fact({kind:"run.snapshot",run})],command:{...binding,authorizationContextHash:auth.authorizationContextHash,status:"accepted",firstCommitSeq:meta.commitSeq,lastCommitSeq:meta.commitSeq,recordedAt:Date.now()},responseJson:JSON.stringify(response)};
  },binding);
  await this.options.provider.cancel({providerJobHandle:input.runId});
  await this.#refresh(context,mount,input.runId);
  await this.#authorize(context,mount,"replay","run.cancel"); return response;
 }
 async #readApprovalEdit(context:VerifiedContext,mount:ProjectMount,run:ApprovalRun,request:DurableApprovalRequest,edit:{kind:"output"|"plan";artifact:ArtifactRef}){
  if(!Number.isSafeInteger(edit.artifact.size)||edit.artifact.size<0||edit.artifact.size>MAX_APPROVAL_EDIT_BYTES)fail("approval edit artifact exceeds the supported size");
  const evidence=await this.#evidenceStore(mount);
  const bytes=await evidence.readArtifact(context,{kind:"run",id:run.runId},edit.artifact);
  const text=decodeApprovalEdit(bytes,edit.artifact,edit.kind);
  const diagnostic=this.options.provider.readDiagnostic(run.runId);
  if(!diagnostic || diagnostic.projectId!==run.projectId || diagnostic.controlDomainId!==run.controlDomainId)throw new ControlError("TF_RECONCILE_REQUIRED","edit checkpoint is unavailable");
  if(edit.kind==="output")return {kind:"output" as const,output:validateApprovalOutputEdit(diagnostic.state,request.nodeInstanceId,text)};
  let candidate:unknown;try{candidate=JSON.parse(text);}catch{fail("approval plan artifact is not JSON");}
  return {kind:"plan" as const,...await validateApprovalPlanEdit(diagnostic.state,request.nodeInstanceId,candidate)};
 }
 #approvalService(mount:ProjectMount):ApprovalService<VerifiedContext> {
  let service=this.#approvals.get(mount.store.header.projectId); if(service)return service;
  const authority:ApprovalAuthority<VerifiedContext>={
   authorize:async(context,scope)=>this.#authorize(context,mount,scope.operation==="read"?"read":"submit",scope.operation==="decide"?"approval.decide":scope.operation==="cancel"?"run.cancel":"run.submit"),
   validateRequest:async(_context,run,node)=>{ if(!this.#linked.get(run.runId)?.flow.phases.some(p=>p.id===node && p.type==="approval")) throw new ControlError("TF_AUTHORITY_REVOKED","approval node is not in linked flow"); },
   negotiateDurability:async(context)=>this.options.durableApprovalAvailable?.(context)===true,
   quiescence:async(_context,run)=>{const q=await this.options.provider.quiescence(run.runId);return {proofId:q.proofId,projectId:run.projectId,projectControlDomainId:run.controlDomainId,runId:run.runId,projectAdmitCommitSeq:run.projectAdmitCommitSeq!,providerNoLiveProcessTree:q.quiescent,noAmbiguousJobs:q.quiescent,noPendingResourceIntents:q.noPendingResourceIntents,reconcileTimeoutOnly:false};},
   validateEdit:async(context,run,request,edit)=>{await this.#readApprovalEdit(context,mount,run,request,edit);},
   prepareReadmission:async(context,run,request)=>{
    new LegacyConflictGuard(mount.projectRoot,mount.store.storePath).assertMayAttempt();
    const linked=this.#linked.get(run.runId);if(!linked)throw new ControlError("TF_RECONCILE_REQUIRED","lost live continuation requires operator reconciliation");
    if(request.status==="edited" && request.editKind==="plan"){
     const edit=await this.#readApprovalEdit(context,mount,run,request,{kind:"plan",artifact:request.editArtifactRef!});if(edit.kind!=="plan")fail("plan edit missing");linked.flow=edit.flow;
    }
    const auth=await this.#authorize(context,mount,"submit","run.submit");
    const ir=request.editKind==="output"?{hash:this.options.provider.readDiagnostic(run.runId)?.state.flowDefHash}:await compileTaskflowToIR(linked.flow);if(!ir.hash)fail("readmission Link failed");
    const policyHash=commandRequestHash(auth.effectivePolicy); const fragmentBody={schemaVersion:CONTROL_WIRE_SCHEMA_VERSION as typeof CONTROL_WIRE_SCHEMA_VERSION,projectId:run.projectId,controlDomainId:run.controlDomainId,fragmentId:randomUUID(),parentBoundPlanHash:run.boundPlanHash,...(run.boundFragmentHash?{parentBoundFragmentHash:run.boundFragmentHash}:{}),sourceEventId:request.decisionEventId!,sourceCommitSeq:request.decisionCommitSeq!,fragmentIRHash:ir.hash,fragmentPolicyHash:`policy:${policyHash}`,capabilitySetHash:`caps:${commandRequestHash(linked.plan.enforcementCapabilities)}`,authorityEpoch:this.options.epoch()};
    return {fragment:{...fragmentBody,boundFragmentHash:`fragment:${commandRequestHash(fragmentBody)}`,executionSemanticHash:ir.hash},owner:{runId:run.runId,phaseId:request.nodeInstanceId,attemptId:randomUUID(),unitId:randomUUID(),ancestry:[]},policyHash,authorizationContextHash:auth.authorizationContextHash};
   },
   validateReadmission:async(context,run,intent)=>{await this.#authorize(context,mount,"submit","run.submit");if(run.authorityEpoch!==this.options.epoch()||run.policyHash!==intent.policyHash)throw new ControlError("TF_AUTHORITY_REVOKED","readmission authority changed");},
   reserve:async(context,run)=>(await this.coordinator.reserve({projectId:run.projectId,projectControlDomainId:run.controlDomainId,runId:run.runId,ttlMs:30000},context)).reservation,
   commitReservation:async(context,intent)=>{await this.coordinator.commit(intent.reservation.reservationId,{projectAdmitCommitSeq:intent.projectAdmitCommitSeq,attemptId:intent.owner.attemptId},context);},
   normalRelease:async(context,intent)=>{await this.coordinator.normalRelease(intent.reservationId,context);},
  };
  service=new ApprovalService(mount.store,authority);this.#approvals.set(mount.store.header.projectId,service);return service;
 }
 async #requestApproval(context:VerifiedContext,mount:ProjectMount,runId:string,request:ApprovalRequest,mode:ApprovalMode):Promise<ApprovalDecision>{
  const service=this.#approvalService(mount),run=mount.store.readRun(runId)!;
  const previous=mount.store.listApprovals().filter(item=>item.runId===runId && item.nodeInstanceId===request.phaseId).at(-1);
  const pending=previous ?? await service.request(context,{runId,expectedRunVersion:run.runVersion,nodeInstanceId:request.phaseId,mode,allowedDecisions:["approve","reject","edit"],owner:this.options.authorization.identity(context).principal,deadline:Date.now()+86400000,timeoutPolicy:"durable-expire"});
  for(;;){
   if(this.#closed)throw new ControlError("TF_RECONCILE_REQUIRED","control owner stopped during approval");
   const current=mount.store.readApproval(pending.approvalRequestId)!;
   if(current.status!=="pending"){
    if(!["approved","edited"].includes(current.status))return {decision:"reject",note:current.status};
    const latest=mount.store.readRun(runId)!;
    if(latest.requiresReadmission && !["released","none"].includes(latest.slot)){
     const q=await this.options.provider.quiescence(runId);
     if(!q.quiescent){await new Promise<void>(resolve=>setTimeout(resolve,20));continue;}
     await service.park(context,{runId,expectedRunVersion:latest.runVersion});
    }
    if(latest.requiresReadmission)await service.readmit(context,{approvalRequestId:current.approvalRequestId,expectedRunVersion:mount.store.readRun(runId)!.runVersion});
    const admitted=mount.store.readRun(runId)!;const row=await this.coordinator.readReservation(admitted.reservationId!,context);await this.#authorize(context,mount,"submit","run.submit");
    if(!row)fail("readmission reservation missing");new ProjectAdmissionService(mount.store).assertDispatch(row.reservation);
    let decision:ApprovalDecision={decision:"approve"};
    if(current.status==="edited"){
     const edit=await this.#readApprovalEdit(context,mount,admitted,current,{kind:current.editKind!,artifact:current.editArtifactRef!});
     if(edit.kind==="output")decision={decision:"edit",note:edit.output};
     else{await this.options.provider.applyApprovalPlan(runId,current.nodeInstanceId,edit.flow);this.#linked.get(runId)!.flow=edit.flow;decision={decision:"edit",note:"Plan updated"};}
    }
    return this.#dispatchFence(context,mount,admitted.reservationId!,()=>decision);
   }
   const nowRun=mount.store.readRun(runId)!;
   if(nowRun.status==="paused" && nowRun.stage==="reconciling"){
    const q=await this.options.provider.quiescence(runId);
    if(q.quiescent)try{await service.park(context,{runId,expectedRunVersion:nowRun.runVersion});}catch(error){if(!(error instanceof ControlError)||error.code!=="TF_STALE_VERSION")throw error;}
   }
   if(current.deadline<=Date.now())await service.expireDue(context);
   await new Promise<void>(resolve=>setTimeout(resolve,20));
  }
 }
 async #refresh(context: VerifiedContext, mount: ProjectMount, runId: string) {
  let pending=this.#refreshes.get(runId);if(!pending){pending=this.#refreshOnce(context,mount,runId);this.#refreshes.set(runId,pending);void pending.finally(()=>this.#refreshes.delete(runId)).catch(()=>{});}
  await pending;await this.#authorize(context,mount,"read");return mount.store.readRun(runId)!;
 }
 async #refreshOnce(context: VerifiedContext, mount: ProjectMount, runId: string) {
  let run = mount.store.readRun(runId)!;
  const terminalEvent = mount.store.readJournal().flatMap(batch=>batch.events).find(event=>event.streamId===runId && event.payload.kind==="run.terminal");
  let observed; try { observed = await this.options.provider.observe(runId); } catch(error) {
   if(this.#submitting.has(runId)||["completed","failed","blocked","cancelled"].includes(run.status))return run;
   if(error instanceof ControlError && error.code==="TF_DURABILITY_FAILED")throw error;
   return run.status==="unknown"?run:this.#mutate(mount.store,run,{status:"unknown",stage:"reconciling",needsOperator:true},[{kind:"reconcile.settled",outcome:"exhausted"}]);
  }
  if (observed.projectId !== run.projectId || observed.controlDomainId !== run.controlDomainId) throw new ControlError("TF_AUTHORITY_REVOKED", "provider evidence belongs to another project");
  await this.#authorize(context, mount, "read");
  run = mount.store.readRun(runId)!;
  if (observed.status === "running") return run;
  if (observed.status === "ambiguous" || !observed.noPendingResourceIntents) {
   if (run.status !== "unknown") run = this.#mutate(mount.store, run, { status: "unknown", stage: "reconciling", needsOperator: true }, [{ kind: "reconcile.settled", outcome: "exhausted" }]);
   return run;
  }
  if (!terminalEvent) {
  const probe = await this.options.provider.probe();
  if(this.options.evidenceFactory && observed.finalOutput !== undefined){
   const evidence=await this.#evidenceStore(mount);
   const artifact=await evidence.stageArtifact(Buffer.from(observed.finalOutput),{mediaType:"text/plain; charset=utf-8",storageClass:"project",redactionClass:"internal"});
   await evidence.assertDurableReferences([artifact]);
   this.#mutate(mount.store,mount.store.readRun(runId)!,{},[{kind:"artifact.recorded",runId,commandKind:"run.submit",artifact}]);
  }
  mount.store.recordRunEvidence(runId, { buildInfo: getBuildInfo(), assurance: { journalContinuity: true, providerOutcome: observed.status === "completed" ? "completed" : "failed", artifactIntegrity: "unknown", provenance: { confidentiality: "internal", integrity: "project" }, enforcement: { capabilities: probe.capabilities } } });
  run = mount.store.readRun(runId)!;
  run = this.#mutate(mount.store, run, { status: observed.status, stage: "terminal", needsOperator: false }, [{ kind: "run.terminal", status: observed.status }]);
  }
  if (run.reservationId && run.slot !== "released") { await this.coordinator.normalRelease(run.reservationId, context); run = this.#mutate(mount.store, mount.store.readRun(runId)!, { slot: "released" }); }
  if (this.options.evidenceFactory) await (await this.#evidenceStore(mount)).issueFinalReceipt(runId);
  return run;
 }
 async #evidenceStore(mount: ProjectMount): Promise<EvidenceStore> { let e = this.#evidence.get(mount.store.header.projectId); if (!e) { if (!this.options.evidenceFactory) throw new ControlError("TF_FEATURE_REQUIRED", "evidence adapter is not configured"); e = Promise.resolve(this.options.evidenceFactory(mount, this.verifyTerminal.bind(this))); this.#evidence.set(mount.store.header.projectId, e); } return e; }
 async verifyTerminal(project: {projectId: string; controlDomainId: string}, runId: string, eventId: string):Promise<TerminalEvidenceObservation> {
  const store = this.options.registry.resolve(project.projectId).store;
  if (store.header.controlDomainId !== project.controlDomainId) throw new ControlError("TF_POLICY_DENIED", "evidence domain mismatch");
  const events = store.readJournal().flatMap(batch => batch.events);
  const event = events.find(event => event.eventId === eventId && event.streamId === runId && event.payload.kind === "run.terminal");
  const observed = await this.options.provider.observe(runId);
  const quiet = await this.options.provider.quiescence(runId);
  if (!quiet.quiescent || !quiet.noPendingResourceIntents) throw new ControlError("TF_RECONCILE_REQUIRED","current TE quiescence is not proven");
  if (!event || event.payload.kind !== "run.terminal" || !["completed","failed","blocked","cancelled"].includes(observed.status) || observed.runId !== runId || observed.projectId !== project.projectId || observed.controlDomainId !== project.controlDomainId || observed.status !== event.payload.status || !observed.noPendingResourceIntents) throw new ControlError("TF_RECONCILE_REQUIRED", "terminal event has no matching TE observation");
  return { terminalStatus: event.payload.status as TerminalEvidenceObservation["terminalStatus"], terminalEventId: eventId, evidenceCommit: observed.evidenceCommit, providerOutcome: observed.status === "completed" ? "completed" as const : "failed" as const };
 }
}
