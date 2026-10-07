/** Concrete TE provider. A durable intent precedes execution; only an awaited
 * runtime plus settled TE journal can prove terminal state. Restart can continue
 * an exact approval checkpoint after the old writer is proven dead; every other
 * lost live handle remains ambiguous and is never re-submitted. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { executeTaskflow, directoryIdentity, validateTaskflow, validateInvocationArgs, compileTaskflowToIR, type Taskflow, type RunState, type RuntimeDeps, type ApprovalRequest, type ApprovalDecision } from "taskflow-core";
import { createResolveOnlyWorkspaceSession, WriteIntentJournal } from "taskflow-core/control-execution";
import { commandRequestHash } from "./schema/commands.ts";
import type { BoundPlan } from "./schema/plan.ts";
import type { ExecutionOwner } from "./schema/te-mirrors.ts";
import type { PrepareResult, ProviderEvent, PollResult, CancelResult, CollectResult, ReconcileResult, SubmitResult } from "./schema/transport.ts";
import type { ExecutionProvider } from "./te-provider.ts";
import { writeJsonAtomicHardened } from "./store/store.ts";
import type { EvidenceDiagnostic } from "./store/evidence-explanation.ts";
import { ControlError } from "./errors.ts";
import { captureRuntimeCheckpoint, isWaitingRuntimeCheckpoint, ownRuntimeState, recoverRuntimeCheckpoint, type RuntimeCheckpoint } from "./runtime-checkpoint.ts";
import { validateApprovalPlanEdit } from "./approval-edits.ts";

export interface RuntimeExecutionInput {
 plan: BoundPlan; flow: Taskflow; args: Record<string, unknown>; projectRoot: string; principal: string;
 owner: ExecutionOwner; controlDomainId: string;
 beforeDispatch: () => Promise<void>;
 dispatchFence?: <T>(activate: () => T) => Promise<T>;
 requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}
export interface RuntimeObservation {
 runId: string; projectId: string; controlDomainId: string; providerJobHandle: string;
 status: "running" | "completed" | "failed" | "blocked" | "cancelled" | "ambiguous";
 finalOutput?: string; evidenceCommit: string; noPendingResourceIntents: boolean;
}
interface DurableJob {
 version: 1; runId: string; projectId: string; controlDomainId: string; owner: ExecutionOwner;
 projectRoot: string; planHash: string; providerJobHandle: string;
 status: RuntimeObservation["status"]; finalOutput?: string; noPendingResourceIntents: boolean;
 execution?: Pick<RuntimeExecutionInput, "plan" | "flow" | "args" | "projectRoot" | "principal" | "owner" | "controlDomainId">;
 checkpoint?: RuntimeCheckpoint;
 digest: string;
}
interface LiveJob { promise: Promise<void>; abort: AbortController; state: RunState; job: Omit<DurableJob, "digest">; persist: () => void; }
const unavailable = (message: string) => ({ outcome: "ambiguous" as const, message });

export class RuntimeTeExecutionProvider implements ExecutionProvider {
 readonly kind = "te-resources" as const;
 readonly directory: string;
 readonly #identity: { dev: number; ino: number };
 readonly #preparations = new Map<string, RuntimeExecutionInput>();
 readonly #live = new Map<string, LiveJob>();
 readonly #waiting = new Set<string>();
 readonly #deps: Pick<RuntimeDeps, "agents" | "runTask" | "usageAccounting">;
 constructor(directory: string, deps: Pick<RuntimeDeps, "agents" | "runTask" | "usageAccounting"> = { agents: [] }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new ControlError("TF_DURABILITY_FAILED", "provider directory cannot be a symbolic link");
  this.directory = fs.realpathSync(directory); this.#identity = fs.statSync(this.directory); this.#deps = deps;
 }
 async probe() {
  return { outcome: "accepted" as const, capabilities: { processIsolation: "none" as const, resolution: "contained" as const,
   mutationMediation: "brokered" as const, revocation: "admission-only" as const, baselinePolicyId: "taskflow-resolve-only",
   hostProbeSha256: commandRequestHash({ backend: "taskflow-resolve-only", platform: process.platform, arch: process.arch, node: process.version, processIsolation: "none" }) } };
 }
 async prepare(): Promise<PrepareResult> { throw new ControlError("TF_COMMAND_FAILED", "concrete TE preparation requires linked execution input"); }
 async prepareExecution(input: RuntimeExecutionInput): Promise<PrepareResult> {
  const check = validateTaskflow(input.flow);
  const errors = [...check.errors, ...validateInvocationArgs(input.flow, input.args)];
  if (errors.length) throw new ControlError("TF_COMMAND_FAILED", errors.join("; "));
  await compileTaskflowToIR(input.flow); // real compilation, not a caller-supplied plan claim
  const preparationId = randomUUID();
  this.#preparations.set(preparationId, { ...input, plan: structuredClone(input.plan), flow: structuredClone(input.flow), args: structuredClone(input.args) });
  return { outcome: "accepted", fulfillment: { preparationId, enforcementCapabilities: input.plan.enforcementCapabilities } };
 }
 #check() { const st = fs.lstatSync(this.directory); if (!st.isDirectory() || st.dev !== this.#identity.dev || st.ino !== this.#identity.ino) throw new ControlError("TF_DURABILITY_FAILED", "provider directory identity changed"); }
 #file(handle: string) { if (!/^[a-f0-9-]{36}$/.test(handle)) throw new ControlError("TF_COMMAND_FAILED", "invalid provider handle"); this.#check(); return path.join(this.directory, `${handle}.json`); }
 #read(handle: string): DurableJob | undefined {
  const file = this.#file(handle);
  let raw: DurableJob; try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("symbolic link"); raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new ControlError("TF_DURABILITY_FAILED", "provider record unavailable or corrupt"); }
  const { digest, ...body } = raw;
  if (raw.version !== 1 || raw.providerJobHandle !== handle || digest !== commandRequestHash(body)) throw new ControlError("TF_DURABILITY_FAILED", "provider record checksum mismatch");
  this.#check(); return raw;
 }
 #write(job: Omit<DurableJob, "digest">) { this.#check(); writeJsonAtomicHardened(this.#file(job.providerJobHandle), { ...job, digest: commandRequestHash(job) }); this.#check(); }
 async submit(req: { preparationId: string; owner: ExecutionOwner; controlDomainId: string }): Promise<SubmitResult> {
  const input = this.#preparations.get(req.preparationId);
  if (!input || commandRequestHash(req.owner) !== commandRequestHash(input.owner) || req.controlDomainId !== input.controlDomainId) throw new ControlError("TF_AUTHORITY_REVOKED", "preparation identity does not match");
  this.#preparations.delete(req.preparationId); // one-shot even if dispatch fails
  const handle = input.owner.runId;
  if (this.#read(handle)) return unavailable("existing durable job must be reconciled, never resubmitted");
  return this.#start(handle, input);
 }
 hasLiveExecution(handle: string): boolean { return this.#live.has(handle); }
 async applyApprovalPlan(handle: string, phaseId: string, flow: Taskflow): Promise<void> {
  const saved = this.#read(handle);
  if (!saved?.execution || !saved.checkpoint || !isWaitingRuntimeCheckpoint(saved.checkpoint)) throw new ControlError("TF_RECONCILE_REQUIRED", "plan edit requires a durable approval checkpoint");
  const live = this.#live.get(handle);
  if (!live) recoverRuntimeCheckpoint(saved.checkpoint, saved.projectRoot);
  const edit = await validateApprovalPlanEdit(saved.checkpoint.state, phaseId, flow);
  if (this.#read(handle)?.digest !== saved.digest) throw new ControlError("TF_STALE_VERSION", "checkpoint changed during plan edit validation");
  const state = live?.state ?? saved.checkpoint.state;
  // Fixed DAG layers retain these phase objects. Update only validated,
  // unstarted phase bodies so their next dispatch sees the newly linked plan.
  for (let i = 0; i < state.def.phases.length; i++) {
   const phase = state.def.phases[i]!, next = edit.flow.phases[i]!;
   if (commandRequestHash(phase) === commandRequestHash(next)) continue;
   for (const key of Object.keys(phase)) delete (phase as Record<string, unknown>)[key];
   Object.assign(phase, structuredClone(next));
  }
  state.flowDefHash = edit.irHash; state.phaseFingerprints = undefined; state.updatedAt = Date.now();
  if (live) { live.job.execution!.flow = state.def; live.persist(); }
  else { const { digest: _digest, ...job } = saved; job.execution!.flow = state.def; this.#write(job); }
 }
 /** Read actual persisted execution evidence, including terminal checkpoints.
  * Availability is not a claim that this checkpoint is safe to resume. */
 readDiagnostic(handle: string): EvidenceDiagnostic | undefined {
  const job = this.#read(handle);
  if (!job?.checkpoint) return undefined;
  const state = job.checkpoint.state;
  if (!state || job.runId !== handle || state.runId !== handle || !/^[a-f0-9-]{36}$/.test(job.projectId)
   || job.execution && (job.execution.plan.projectId !== job.projectId || job.execution.plan.controlDomainId !== job.controlDomainId
    || job.execution.controlDomainId !== job.controlDomainId || job.execution.plan.boundPlanHash !== job.planHash
    || job.execution.projectRoot !== job.projectRoot || commandRequestHash(job.execution.flow) !== commandRequestHash(state.def))) {
   throw new ControlError("TF_DURABILITY_FAILED", "diagnostic checkpoint execution identity mismatch");
  }
  return { runId: job.runId, projectId: job.projectId, controlDomainId: job.controlDomainId, state: structuredClone(state),
   controlDirectory: path.join(this.directory, "resources", job.projectId), projectRoot: job.projectRoot };
 }
 recoverableExecution(handle: string): NonNullable<DurableJob["execution"]> {
  const job = this.#read(handle);
  if (!job || job.status !== "running" || !job.execution || this.#live.has(handle)) throw new ControlError("TF_RECONCILE_REQUIRED", "runtime is not a recoverable orphan");
  recoverRuntimeCheckpoint(job.checkpoint, job.projectRoot);
  if (job.execution.plan.boundPlanHash !== job.planHash || job.execution.plan.projectId !== job.projectId
   || job.execution.controlDomainId !== job.controlDomainId || job.checkpoint?.state.runId !== handle
   || commandRequestHash(job.execution.flow) !== commandRequestHash(job.checkpoint.state.def)) throw new ControlError("TF_DURABILITY_FAILED", "checkpoint execution identity mismatch");
  return structuredClone(job.execution);
 }
 async resumeExecution(handle: string, input: RuntimeExecutionInput): Promise<SubmitResult> {
  const execution = this.recoverableExecution(handle), job = this.#read(handle)!;
  if (input.owner.runId !== handle || commandRequestHash(execution.plan) !== commandRequestHash(input.plan)
   || commandRequestHash(execution.flow) !== commandRequestHash(input.flow) || commandRequestHash(execution.args) !== commandRequestHash(input.args)
   || execution.projectRoot !== input.projectRoot || execution.controlDomainId !== input.controlDomainId) throw new ControlError("TF_AUTHORITY_REVOKED", "resume cannot alter the linked execution");
  const quiet = await this.quiescence(handle);
  if (!quiet.quiescent) throw new ControlError("TF_RECONCILE_REQUIRED", "checkpoint has unresolved TE effects");
  return this.#start(handle, input, job);
 }
 async #start(handle: string, input: RuntimeExecutionInput, previous?: DurableJob): Promise<SubmitResult> {
  const abort = new AbortController();
  const controlDirectory = path.join(this.directory, "resources", input.plan.projectId);
  const session = await createResolveOnlyWorkspaceSession({ invocationRoot: input.projectRoot, controlDirectory, principalId: input.principal, signal: abort.signal });
  const binding = await session.bindPhase({ invocationRoot: input.projectRoot, runId: input.owner.runId, phaseId: input.owner.phaseId, argDefinitions: input.flow.args ?? {}, argValues: input.args });
  await input.beforeDispatch();
  const activate = (): SubmitResult => {
   const current = this.#read(handle);
   if (this.#live.has(handle) || (previous ? current?.digest !== previous.digest : !!current)) throw new ControlError("TF_RECONCILE_REQUIRED", "runtime writer changed before dispatch");
   const state: RunState = previous ? recoverRuntimeCheckpoint(previous.checkpoint, input.projectRoot)
    : { runId: input.owner.runId, flowName: input.flow.name, def: input.flow, args: input.args, status: "running", phases: {}, createdAt: Date.now(), updatedAt: Date.now(), cwd: input.projectRoot, invocationRootSnapshot: directoryIdentity(input.projectRoot) };
   const writer = ownRuntimeState(state), waiting = new Set<string>();
   const job: Omit<DurableJob, "digest"> = { version: 1, runId: input.owner.runId, projectId: input.plan.projectId, controlDomainId: input.controlDomainId,
    owner: input.owner, projectRoot: input.projectRoot, planHash: input.plan.boundPlanHash, providerJobHandle: handle, status: "running", noPendingResourceIntents: false,
    execution: { plan: input.plan, flow: input.flow, args: input.args, projectRoot: input.projectRoot, principal: input.principal, owner: input.owner, controlDomainId: input.controlDomainId } };
   const persist = () => { job.checkpoint = captureRuntimeCheckpoint(state, writer, waiting); this.#write(job); };
   // Claim the checkpoint before execution. Any crash after this intent and before
   // the next verified wait is ambiguous, so a retry cannot duplicate dispatch.
   persist();
   const live: LiveJob = { abort, promise: Promise.resolve(), state, job, persist }; this.#live.set(handle, live);
   live.promise = (async () => {
    try {
     const result = await executeTaskflow(state, { ...this.#deps, cwd: input.projectRoot, signal: abort.signal,
      workspaceSession: session, workspaceControlDirectory: controlDirectory, cwdBridgeMode: "resolve-only",
      _workspaceBinding: binding, _cwdBoundary: input.projectRoot, _disableCache: true,
      ...(previous ? { _approvalCheckpointContinuation: { runId: state.runId } } : {}),
      persist: () => { try { persist(); } catch (error) { abort.abort(); throw error; } },
      requestApproval: input.requestApproval ? async request => {
       waiting.add(request.phaseId); this.#waiting.add(handle);
       try { persist(); return await input.requestApproval!(request); }
       finally { waiting.delete(request.phaseId); if (!waiting.size) this.#waiting.delete(handle); persist(); }
      } : undefined });
     const intents = await new WriteIntentJournal({ directory: controlDirectory, journalEpoch: 1 }).listIntents();
     const clean = !intents.some(intent => intent.owner.runId === input.owner.runId && ["pending", "dirty-unknown"].includes(intent.status));
     const status = !clean ? "ambiguous" : abort.signal.aborted ? "cancelled" : result.state.status === "paused" ? "ambiguous" : result.state.status;
     this.#write({ ...job, status, finalOutput: result.finalOutput, noPendingResourceIntents: clean });
    } catch { this.#write({ ...job, status: "ambiguous", noPendingResourceIntents: false }); }
    finally { this.#live.delete(handle); }
   })();
   return { outcome: "accepted", providerJobHandle: handle };
  };
  return input.dispatchFence ? input.dispatchFence(activate) : activate();
 }
 #recoverable(job: DurableJob): boolean {
  if (job.status !== "running" || !job.execution) return false;
  try { recoverRuntimeCheckpoint(job.checkpoint, job.projectRoot); return true; } catch { return false; }
 }
 async observe(handle: string): Promise<RuntimeObservation> {
  const job = this.#read(handle);
  if (!job) throw new ControlError("TF_RECONCILE_REQUIRED", "provider has no durable execution evidence");
  const status = job.status === "running" && !this.#live.has(handle) && !this.#recoverable(job) ? "ambiguous" : job.status;
  return { runId: job.runId, projectId: job.projectId, controlDomainId: job.controlDomainId, providerJobHandle: handle, status,
   finalOutput: job.finalOutput, evidenceCommit: job.digest, noPendingResourceIntents: job.noPendingResourceIntents };
 }
 async quiescence(handle: string): Promise<{ proofId: string; quiescent: boolean; noPendingResourceIntents: boolean }> {
  const job = this.#read(handle); if (!job) return { proofId: "unobserved", quiescent: false, noPendingResourceIntents: false };
  const intents = await new WriteIntentJournal({ directory: path.join(this.directory, "resources", job.projectId), journalEpoch: 1 }).listIntents();
  const clean = !intents.some(intent => intent.owner.runId === job.runId && ["pending", "dirty-unknown"].includes(intent.status));
  return { proofId: commandRequestHash({ digest: job.digest, intents }), quiescent: clean && (this.#waiting.has(handle) && isWaitingRuntimeCheckpoint(job.checkpoint) || !this.#live.has(handle) && (this.#recoverable(job) || !["running", "ambiguous"].includes(job.status))), noPendingResourceIntents: clean };
 }
 async poll(req: { providerJobHandle: string }): Promise<PollResult> { const s = await this.observe(req.providerJobHandle); return s.status === "ambiguous" ? unavailable("runtime outcome is not proven") : { outcome: "accepted", status: s.status === "running" ? "running" : s.status === "completed" ? "completed" : "failed" }; }
 async cancel(req: { providerJobHandle: string }): Promise<CancelResult> { const live = this.#live.get(req.providerJobHandle); if (live) { live.abort.abort(); await live.promise; } const s = await this.observe(req.providerJobHandle); return s.status === "ambiguous" || s.status === "running" ? unavailable("quiescent cancellation is not proven") : { outcome: "accepted", cancelled: s.status === "cancelled" }; }
 async collect(req: { providerJobHandle: string }): Promise<CollectResult> { const s = await this.observe(req.providerJobHandle); return ["running", "ambiguous"].includes(s.status) ? unavailable("runtime output is not terminal") : { outcome: "accepted", providerJobHandle: req.providerJobHandle }; }
 async reconcile(req: { providerJobHandle: string }): Promise<ReconcileResult> { const s = await this.observe(req.providerJobHandle); return s.status === "ambiguous" ? { outcome: "accepted", providerState: "exhausted" } : { outcome: "accepted", providerState: s.status === "running" ? "running" : "terminal" }; }
 async *watch(req: { providerJobHandle: string }): AsyncIterable<ProviderEvent> { const live = this.#live.get(req.providerJobHandle); if (live) await live.promise; const s = await this.observe(req.providerJobHandle); yield { kind: "terminal", outcome: s.status === "completed" ? "completed" : s.status === "ambiguous" || s.status === "running" ? "ambiguous" : "failed" }; }
 async wait(handle: string): Promise<RuntimeObservation> { await this.#live.get(handle)?.promise; return this.observe(handle); }
}
