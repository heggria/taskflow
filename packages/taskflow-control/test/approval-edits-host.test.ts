import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import type { Taskflow } from "taskflow-core";
import { ControlHost } from "../src/control-host.ts";
import { RuntimeTeExecutionProvider } from "../src/runtime-provider.ts";
import { ProjectRegistry } from "../src/project-registry.ts";
import { AUTHORIZATION_CAPABILITIES, createAuthorizationAuthority, type VerifiedContext } from "../src/authorization.ts";
import { createControlEvidenceStore } from "../src/store/evidence-adapter.ts";
import type { ArtifactRef } from "../src/schema/evidence.ts";

async function fixture() {
 const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"approval-edit-host-")),root=path.join(base,"project");fs.mkdirSync(root);
 const registry=new ProjectRegistry(path.join(base,"registry.json")),mount=registry.mount(path.join(root,".taskflow/control"),root);
 const authority=createAuthorizationAuthority({ownerUid:process.getuid!(),bootstrapSecret:randomBytes(32),hostBaseline:AUTHORIZATION_CAPABILITIES,
  loadLivePolicy:(_principal,binding)=>({host:{capabilities:AUTHORIZATION_CAPABILITIES.map(kind=>({kind,scopeRoot:binding.projectRoot}))}})});
 const context=authority.issueStandalone({projectId:mount.store.header.projectId,controlDomainId:mount.store.header.controlDomainId,projectRoot:root});
 const provider=new RuntimeTeExecutionProvider(path.join(base,"provider"));
 const host=new ControlHost({mode:"standalone",trustedInProcessFeatures:["durable-approval"],controlHome:path.join(base,"home"),registry,authorization:authority,provider,
  evidenceFactory:(project,verify)=>createControlEvidenceStore(project.store,{terminalEvidence:{verify},authorize:(actor,scope)=>authority.authorize(actor as VerifiedContext,{projectId:scope.projectId,controlDomainId:scope.controlDomainId,projectRoot:project.projectRoot,operation:"replay",commandKind:"approval.decide"})})});
 await host.start();
 async function submit(flow:Taskflow,ctx=context,project=mount){
  const {runId}=await host.dispatchAuthenticated<{runId:string}>(ctx,"commands.submit",{commandId:randomUUID(),kind:"run.submit",approvalMode:"durable-required",flow});
  const until=Date.now()+10000;
  while(Date.now()<until){const run=project.store.readRun(runId)!;if(run.stage==="parked"&&run.slot==="released")return runId;await new Promise(r=>setTimeout(r,10));}
  throw new Error("run did not park");
 }
 async function stage(runId:string,editKind:"output"|"plan",content:string,ctx=context){return host.dispatchAuthenticated<ArtifactRef>(ctx,"approvals.stageEdit",{runId,editKind,content});}
 async function decide(runId:string,editKind:"output"|"plan",editArtifactRef:ArtifactRef){
  const approval=mount.store.listApprovals().find(a=>a.runId===runId&&a.status==="pending")!;
  return host.dispatchAuthenticated(context,"approval.decide",{commandId:randomUUID(),runId,approvalRequestId:approval.approvalRequestId,expectedRunVersion:mount.store.readRun(runId)!.runVersion,decision:"edit",editKind,editArtifactRef});
 }
 return {base,root,mount,registry,authority,context,provider,host,submit,stage,decide,async close(){host.stop();await Promise.all(mount.store.listRuns().map(run=>provider.wait(run.runId)));registry.close();fs.rmSync(base,{recursive:true,force:true});}};
}
const flow:Taskflow={name:"edited-approval",phases:[{id:"before",type:"script",run:"printf x >> before-count",idempotent:false},{id:"approval",type:"approval",dependsOn:["before"],task:"Edit?"},{id:"after",type:"script",dependsOn:["approval"],run:["printf","%s","{steps.approval.output}"]}]};

test("real Host consumes contract-validated output edit without changing semantic plan",{timeout:20000},async()=>{
 const f=await fixture();try{
  const runId=await f.submit(flow),before=f.provider.readDiagnostic(runId)!.state.flowDefHash;
  const artifact=await f.stage(runId,"output","reviewed output");await f.decide(runId,"output",artifact);
  await f.host.dispatchAuthenticated(f.context,"runs.wait",{runId});
  assert.equal((await f.provider.observe(runId)).finalOutput,"reviewed output");
  assert.equal(f.provider.readDiagnostic(runId)!.state.flowDefHash,before);
  assert.equal(fs.readFileSync(path.join(f.root,"before-count"),"utf8"),"x");
 }finally{await f.close();}
});

test("real Host relinks an edited downstream script and preserves completed effects",{timeout:20000},async()=>{
 const f=await fixture();try{
  const runId=await f.submit(flow),before=f.provider.readDiagnostic(runId)!.state.flowDefHash;
  const edited=structuredClone(flow);edited.phases[2]!.run="printf x >> edited-count; printf edited-plan";
  const artifact=await f.stage(runId,"plan",JSON.stringify(edited));await f.decide(runId,"plan",artifact);
  await f.host.dispatchAuthenticated(f.context,"runs.wait",{runId});
  assert.equal((await f.provider.observe(runId)).finalOutput,"edited-plan");
  assert.notEqual(f.provider.readDiagnostic(runId)!.state.flowDefHash,before);
  assert.equal(fs.readFileSync(path.join(f.root,"before-count"),"utf8"),"x");assert.equal(fs.readFileSync(path.join(f.root,"edited-count"),"utf8"),"x");
 }finally{await f.close();}
});

test("bad output, completed phase edits, graph edits and cross-project edit artifacts fail closed",{timeout:20000},async()=>{
 const f=await fixture();try{
  const runId=await f.submit(flow);
  await assert.rejects(f.decide(runId,"output",await f.stage(runId,"output","  ")),/must not be empty/);
  const changed=structuredClone(flow);changed.phases[0]!.run="printf replay";
  await assert.rejects(f.decide(runId,"plan",await f.stage(runId,"plan",JSON.stringify(changed))),/completed, active/);
  const changedGraph=structuredClone(flow);changedGraph.phases[2]!.dependsOn=["before"];changedGraph.phases[2]!.run="printf unsafe";
  await assert.rejects(f.decide(runId,"plan",await f.stage(runId,"plan",JSON.stringify(changedGraph))),/dependencies/);
  await assert.rejects(f.decide(runId,"plan",await f.stage(runId,"plan",JSON.stringify({...flow,concurrency:1}))),/top-level/);
  const otherRoot=path.join(f.base,"other");fs.mkdirSync(otherRoot);const other=f.registry.mount(path.join(otherRoot,".taskflow/control"),otherRoot);
  const otherContext=f.authority.issueStandalone({projectId:other.store.header.projectId,controlDomainId:other.store.header.controlDomainId,projectRoot:otherRoot});
  const otherId=await f.submit(flow,otherContext,other),foreign=await f.stage(otherId,"output","foreign",otherContext);
  await assert.rejects(f.decide(runId,"output",foreign),/authorized ledger reference/);
  assert.equal(f.mount.store.listApprovals().find(a=>a.runId===runId)!.status,"pending");
  f.host.stop();await f.provider.wait(otherId);
 }finally{await f.close();}
});

test("approval edit cannot consume bytes that differ from the committed artifact digest",{timeout:20000},async()=>{
 const f=await fixture();try{
  const runId=await f.submit(flow),artifact=await f.stage(runId,"output","original output");
  fs.writeFileSync(path.join(f.mount.store.storePath,"artifacts/sha256",artifact.digest.slice(0,2),artifact.digest),"tampered output");
  await assert.rejects(f.decide(runId,"output",artifact),/bytes do not match/);
  assert.equal(f.mount.store.listApprovals().find(a=>a.runId===runId)!.status,"pending");
 }finally{await f.close();}
});
