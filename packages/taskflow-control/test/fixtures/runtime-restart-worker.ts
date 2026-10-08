import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { ControlHost } from "../../src/control-host.ts";
import { ProjectRegistry } from "../../src/project-registry.ts";
import { RuntimeTeExecutionProvider, type RuntimeExecutionInput } from "../../src/runtime-provider.ts";
import { AUTHORIZATION_CAPABILITIES, createAuthorizationAuthority, type VerifiedContext } from "../../src/authorization.ts";
import { createControlEvidenceStore } from "../../src/store/evidence-adapter.ts";
import type { ArtifactRef } from "../../src/schema/evidence.ts";
import type { RunSnapshot } from "../../src/schema/run.ts";

const [base, action] = process.argv.slice(2) as [string, string];
const root = path.join(base, "project");
fs.mkdirSync(root, { recursive: true });
const registry = new ProjectRegistry(path.join(base, "registry.json"));
const mount = registry.mount(path.join(root, ".taskflow", "control"), root);
const authority = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: randomBytes(32), hostBaseline: AUTHORIZATION_CAPABILITIES,
 loadLivePolicy: () => ({ host: { capabilities: AUTHORIZATION_CAPABILITIES.map(kind => ({ kind, scopeRoot: root })) } }) });
const context = authority.issueStandalone({ projectId: mount.store.header.projectId, controlDomainId: mount.store.header.controlDomainId, projectRoot: root });
class CrashBoundaryProvider extends RuntimeTeExecutionProvider {
 #recoveries=0;
 override recoverableExecution(handle:string) {
  const execution=super.recoverableExecution(handle);
  if(action.endsWith("commit-pause") && ++this.#recoveries===2){
   // Fault injection after the real approval journal commit, before readmission.
   process.send!({kind:"edited",runId:handle,approval:mount.store.listApprovals().find(item=>item.runId===handle)});
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  }
  return execution;
 }
 override async resumeExecution(handle:string,input:RuntimeExecutionInput){
  if(action.endsWith("readmitted-pause")){
   process.send!({kind:"edited",runId:handle,approval:mount.store.listApprovals().find(item=>item.runId===handle),run:mount.store.readRun(handle)});
   await new Promise(()=>{});
  }
  return super.resumeExecution(handle,input);
 }
}
const provider = new CrashBoundaryProvider(path.join(base, "provider"));
const host = new ControlHost({ mode: "standalone", trustedInProcessFeatures: ["durable-approval"], controlHome: path.join(base, "home"), registry, authorization: authority, provider,
 evidenceFactory:(project,verify)=>createControlEvidenceStore(project.store,{terminalEvidence:{verify},authorize:(actor,scope)=>authority.authorize(actor as VerifiedContext,{projectId:scope.projectId,controlDomainId:scope.controlDomainId,projectRoot:project.projectRoot,operation:"replay",commandKind:"approval.decide"})}) });
await host.start();
try {
 if (action.startsWith("start")) {
  const accepted = await host.dispatchAuthenticated<{ runId: string }>(context, "commands.submit", {
   commandId: randomUUID(), kind: "run.submit", approvalMode: "durable-required",
   flow: { name: "kill-approval-restart", phases: [
    { id: "before", type: "script", run: "printf x >> before-count; printf before-output", idempotent: false },
    { id: "approve", type: "approval", dependsOn: ["before"], task: "Proceed?" },
    { id: "after", type: "script", dependsOn: ["approve"], run: action==="start-output"?"printf x >> after-count; cat":"printf x >> after-count; printf after-output", ...(action==="start-output"?{input:"{steps.approve.output}"}:{}), idempotent: false },
   ] },
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
   const run = mount.store.readRun(accepted.runId)!;
   if (run.stage === "parked" && run.slot === "released") {
    process.send!({ kind: "parked", runId: accepted.runId, pid: process.pid });
    await new Promise(() => {});
   }
   await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("approval never parked");
 } else {
  const approval = mount.store.listApprovals().find(item => item.status === "pending" || action==="resume-committed" && item.status==="edited")!;
  if (!approval) throw new Error("missing durable pending approval");
  const run = mount.store.readRun(approval.runId)!;
  if(action==="resume-committed")await host.dispatchAuthenticated(context,"runs.resume",{runId:run.runId});
  else if(action.endsWith("pause")){
   const editKind=action.startsWith("plan")?"plan":"output";
   const edited=structuredClone(provider.readDiagnostic(run.runId)!.state.def);
   edited.phases.find(phase=>phase.id==="after")!.run="printf x >> after-count; printf restart-edited-plan";
   const artifact=await host.dispatchAuthenticated<ArtifactRef>(context,"approvals.stageEdit",{runId:run.runId,editKind,content:editKind==="plan"?JSON.stringify(edited):"restart-edited-output"});
   await host.dispatchAuthenticated(context,"approval.decide",{commandId:randomUUID(),runId:run.runId,approvalRequestId:approval.approvalRequestId,expectedRunVersion:mount.store.readRun(run.runId)!.runVersion,decision:"edit",editKind,editArtifactRef:artifact});
  }else await host.dispatchAuthenticated(context, "approval.decide", { commandId: randomUUID(), runId: run.runId, approvalRequestId: approval.approvalRequestId,
   expectedRunVersion: run.runVersion, decision: "approve" });
  const final = await host.dispatchAuthenticated<RunSnapshot>(context, "runs.wait", { runId: run.runId });
  process.send!({ kind: "completed", run: final, observation: await provider.observe(run.runId) });
 }
} catch (error) {
 process.send!({ kind: "error", error: error instanceof Error ? error.stack : String(error) });
 process.exitCode = 1;
} finally {
 host.stop(); registry.close(); process.disconnect?.();
}
