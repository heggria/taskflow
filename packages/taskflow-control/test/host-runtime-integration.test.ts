import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { ControlHost } from "../src/control-host.ts";
import { RuntimeTeExecutionProvider } from "../src/runtime-provider.ts";
import { ProjectRegistry } from "../src/project-registry.ts";
import { AUTHORIZATION_CAPABILITIES, createAuthorizationAuthority } from "../src/authorization.ts";
import type { RunSnapshot } from "../src/schema/run.ts";

async function fixture(features:readonly string[] = ["durable-approval"]) {
 const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "control-host-real-"));
 const root = path.join(base,"project"); fs.mkdirSync(root);
 const registry = new ProjectRegistry(path.join(base,"registry.json"));
 const mount = registry.mount(path.join(root,".taskflow","control"),root);
 let allowed = true;
 const authority = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: randomBytes(32), hostBaseline: AUTHORIZATION_CAPABILITIES,
  loadLivePolicy: () => ({host:{capabilities: allowed ? AUTHORIZATION_CAPABILITIES.map(kind=>({kind,scopeRoot:root})) : []}}) });
 const context = authority.issueStandalone({projectId:mount.store.header.projectId,controlDomainId:mount.store.header.controlDomainId,projectRoot:root});
 const provider = new RuntimeTeExecutionProvider(path.join(base,"provider"));
 const host = new ControlHost({mode:"standalone",controlHome:path.join(base,"home"),registry,authorization:authority,provider,trustedInProcessFeatures:features});
 await host.start();
 return {base,root,registry,mount,authority,context,provider,host,revoke:()=>{allowed=false;},close:()=>{host.stop();registry.close();fs.rmSync(base,{recursive:true,force:true});}};
}
test("real Host submits through project admission and TE runtime, persists exact response and terminal result", async()=>{
 const f = await fixture(); try {
  const body={commandId:randomUUID(),kind:"run.submit",flow:{name:"actual-script",phases:[{id:"work",type:"script",run:"printf real-runtime"}]}};
  const accepted = await f.host.dispatchAuthenticated<{runId:string}>(f.context,"commands.submit",body);
  const run = await f.host.dispatchAuthenticated<RunSnapshot>(f.context,"runs.wait",{runId:accepted.runId});
  assert.equal(run.status,"completed"); assert.equal(run.slot,"released");
  assert.equal((await f.provider.observe(run.runId)).finalOutput,"real-runtime");
  assert.deepEqual(await f.host.dispatchAuthenticated(f.context,"commands.submit",body),accepted);
  assert.equal(f.mount.store.listRuns().length,1);
  const wal = fs.readFileSync(path.join(f.base,"provider","resources",run.projectId,"resource-journal.wal.jsonl"),"utf8");
  assert.match(wal,/write-intent/); assert.match(wal,/write-commit/);
  f.revoke(); await assert.rejects(f.host.dispatchAuthenticated(f.context,"commands.submit",body), /capability/);
 } finally {f.close();}
});
test("forged body authority is rejected before any project write", async()=>{
 const f=await fixture();try {
  const seq=f.mount.store.snapshot().commitSeq;
  await assert.rejects(f.host.dispatchAuthenticated(f.context,"commands.submit",{command:{callerPrincipal:"operator"},events:[]}),/untrusted/);
  assert.equal(f.mount.store.snapshot().commitSeq,seq);
 }finally{f.close();}
});
test("actual TE approval parks, durable decision replays exactly, readmission resumes downstream once",{timeout:20000},async()=>{
 const f=await fixture();try{
  const accepted=await f.host.dispatchAuthenticated<{runId:string}>(f.context,"commands.submit",{commandId:randomUUID(),kind:"run.submit",approvalMode:"durable-required",flow:{name:"human",phases:[{id:"approval",type:"approval",task:"Approve?"},{id:"work",type:"script",dependsOn:["approval"],run:"printf approved-runtime"}]}});
  let approvals=f.mount.store.listApprovals();const deadline=Date.now()+5000;
  while(!approvals.length&&Date.now()<deadline){await new Promise(r=>setTimeout(r,20));approvals=f.mount.store.listApprovals();}
  assert.equal(approvals.length,1); assert.equal(approvals[0]!.status,"pending");
  let parked=f.mount.store.readRun(accepted.runId)!;
  while(parked.slot!=="released"&&Date.now()<deadline){await new Promise(r=>setTimeout(r,20));parked=f.mount.store.readRun(accepted.runId)!;}
  assert.equal(parked.stage,"parked");assert.equal(parked.slot,"released");
  const body={commandId:randomUUID(),runId:accepted.runId,approvalRequestId:approvals[0]!.approvalRequestId,expectedRunVersion:parked.runVersion,decision:"approve"};
  const decided=await f.host.dispatchAuthenticated(f.context,"approval.decide",body);
  const completed=await f.host.dispatchAuthenticated<RunSnapshot>(f.context,"runs.wait",{runId:accepted.runId});
  assert.equal(completed.status,"completed");assert.equal(completed.slot,"released");
  assert.deepEqual(await f.host.dispatchAuthenticated(f.context,"approval.decide",body),decided);
  assert.equal((await f.provider.observe(completed.runId)).finalOutput,"approved-runtime");
 }finally{f.close();}
});
test("durable-required fails before command commit without negotiated feature; optional auto-rejects",async()=>{
 const f=await fixture([]);try{
  const flow={name:"feature-skew",phases:[{id:"review",type:"approval",task:"Approve?"}]};
  const seq=f.mount.store.snapshot().commitSeq;
  await assert.rejects(f.host.dispatchAuthenticated(f.context,"commands.submit",{commandId:randomUUID(),kind:"run.submit",approvalMode:"durable-required",flow}),/not negotiated/);
  assert.equal(f.mount.store.snapshot().commitSeq,seq);
  const accepted=await f.host.dispatchAuthenticated<{runId:string}>(f.context,"commands.submit",{commandId:randomUUID(),kind:"run.submit",approvalMode:"durable-optional",flow});
  const run=await f.host.dispatchAuthenticated<RunSnapshot>(f.context,"runs.wait",{runId:accepted.runId});
  assert.equal(run.status,"blocked");assert.equal(run.slot,"released");
  assert.equal(f.mount.store.listApprovals()[0]!.status,"rejected");
 }finally{f.close();}
});
