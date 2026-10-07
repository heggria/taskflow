import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {mkdtempSync,readFileSync,writeFileSync,rmSync,unlinkSync,renameSync,mkdirSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {test} from "node:test";
import {approvalFixture} from "./fixtures/approval-worker.ts";
import {ControlError} from "../src/errors.ts";
import {openControlStore} from "../src/store/store.ts";
import {commandRequestHash} from "../src/schema/commands.ts";
import {ApprovalService, type ApprovalDecisionInput} from "../src/approval-service.ts";
import {createAuthorizationAuthority,AUTHORIZATION_CAPABILITIES} from "../src/authorization.ts";
const code=(c:string)=>(e:unknown)=>e instanceof ControlError&&e.code===c;
async function setup(){const directory=mkdtempSync(join(tmpdir(),"tf-real-replay-"));const f=await approvalFixture(directory);const request=await f.service.request(f.context,f.request());const input:ApprovalDecisionInput={commandId:randomUUID(),runId:f.runId,approvalRequestId:request.approvalRequestId,expectedRunVersion:f.store.readRun(f.runId)!.runVersion,decision:"approve"};return {directory,f,input,journal:join(directory,"project-store/journal/000001.jsonl")};}

test("real journal identical competing clients converge before stale CAS with one exact response",async()=>{const {directory,f,input,journal}=await setup();try{
 const before=f.store.commitSeq;const [a,b]=await Promise.all([f.service.decide(f.context,input),f.service.decide(f.secondContext,input)]);
 assert.deepEqual(a,b);assert.equal(f.store.commitSeq,before+1);const bytes=readFileSync(journal);
 await f.service.cancel(f.context,{commandId:randomUUID(),runId:f.runId,expectedRunVersion:f.store.readRun(f.runId)!.runVersion});
 const changed=readFileSync(journal);assert.deepEqual(await f.service.decide(f.context,input),a);assert.deepEqual(readFileSync(journal),changed);assert.ok(changed.length>bytes.length);
}finally{f.close();rmSync(directory,{recursive:true,force:true});}});

test("same command changed body conflicts; authorized other principal cannot disclose; revoked caller denied",async()=>{const {directory,f,input,journal}=await setup();try{
 await f.service.decide(f.context,input);const bytes=readFileSync(journal);
 await assert.rejects(f.service.decide(f.context,{...input,decision:"reject"}),code("TF_IDEMPOTENCY_CONFLICT"));
 const record=f.store.readCommand(input.commandId)!;
 assert.throws(()=>f.store.readCommittedCommand({...record,callerPrincipal:"other-authorized-principal"}),code("TF_CROSS_PRINCIPAL_COMMAND"));
 f.set({revoked:true});await assert.rejects(f.service.decide(f.context,input),code("TF_AUTHORITY_REVOKED"));assert.deepEqual(readFileSync(journal),bytes);
}finally{f.close();rmSync(directory,{recursive:true,force:true});}});

test("real fsynced decision killed before transport ack replays exact response in fresh store", {skip:process.platform==="win32"},async()=>{
 const {directory,f,input,journal}=await setup();const file=join(directory,"input.json");writeFileSync(file,JSON.stringify(input));f.close();
 try{
  const child=spawnSync(process.execPath,["--conditions=development","--experimental-strip-types",join(import.meta.dirname,"fixtures/approval-replay-worker.ts")],{env:{...process.env,TF_REPLAY_DIRECTORY:directory,TF_REPLAY_INPUT:file},encoding:"utf8",timeout:15000});
  assert.equal(child.signal,"SIGKILL",child.stderr);assert.equal(child.stdout,"");
  const bytes=readFileSync(journal), batches=bytes.toString().trim().split("\n").map(line=>JSON.parse(line));
  const commits=batches.filter(b=>b.command?.commandId===input.commandId);assert.equal(commits.length,1);
  const expected=commits[0].responseJson;
  const fresh=await approvalFixture(directory);try{assert.equal(JSON.stringify(await fresh.service.decide(fresh.context,input)),expected);assert.deepEqual(readFileSync(journal),bytes);}finally{fresh.close();}
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test("cancel response is immutable across restart and later lifecycle changes",async()=>{const {directory,f,journal}=await setup();try{
 const input={commandId:randomUUID(),runId:f.runId,expectedRunVersion:f.store.readRun(f.runId)!.runVersion};const response=await f.service.cancel(f.context,input);const bytes=readFileSync(journal);f.close();
 const fresh=await approvalFixture(directory);try{assert.deepEqual(await fresh.service.cancel(fresh.context,input),response);assert.deepEqual(readFileSync(journal),bytes);}finally{fresh.close();}
}finally{f.close();rmSync(directory,{recursive:true,force:true});}});

for(const damage of ["truncate","response","delete"] as const) test(`committed response ${damage} fails closed while live and after restart without rewriting bytes`,async()=>{
 const {directory,f,input,journal}=await setup();try{
  await f.service.decide(f.context,input);const original=readFileSync(journal);
  if(damage==="truncate") writeFileSync(journal,original.subarray(0,original.length-5));
  else if(damage==="response") writeFileSync(journal,original.toString().replace('"responseJson":','"lostResponseJson":'));
  else unlinkSync(journal);
  const damaged=damage==="delete"?undefined:readFileSync(journal);
  await assert.rejects(f.service.decide(f.context,input),code("TF_DURABILITY_FAILED"));f.close();
  assert.throws(()=>openControlStore(join(directory,"project-store")),code("TF_DURABILITY_FAILED"));
  if(damaged) assert.deepEqual(readFileSync(journal),damaged);
 }finally{f.close();rmSync(directory,{recursive:true,force:true});}
});

test("same UUID has independent authority in two real project/domain journals",async()=>{
 const one=await setup(),two=await setup();try{
  two.input.commandId=one.input.commandId;
  const a=await one.f.service.decide(one.f.context,one.input), b=await two.f.service.decide(two.f.context,two.input);
  assert.notEqual(a.runId,b.runId);
  const record=one.f.store.readCommand(one.input.commandId)!;
  assert.throws(()=>two.f.store.readCommittedCommand({...record,requestHash:commandRequestHash(one.input)}),code("TF_DURABILITY_FAILED"));
  assert.equal(one.f.store.readCommittedCommand(record)?.responseJson,JSON.stringify(a));
 }finally{one.f.close();two.f.close();rmSync(one.directory,{recursive:true,force:true});rmSync(two.directory,{recursive:true,force:true});}
});

for(const damage of ["header","projection-symlink"] as const) test(`project ${damage} replacement cannot disclose or overwrite another directory`,async()=>{
 const {directory,f,input}=await setup();try{
  await f.service.decide(f.context,input);
  if(damage==="header") {
   const header=join(directory,"project-store/header"); writeFileSync(header,"broken identity");
   await assert.rejects(f.service.decide(f.context,input),code("TF_DURABILITY_FAILED"));
   assert.equal(readFileSync(header,"utf8"),"broken identity");
  } else {
   f.close(); const projections=join(directory,"project-store/projections"),outside=join(directory,"outside");
   renameSync(projections,projections+".saved");mkdirSync(outside);writeFileSync(join(outside,"commands.json"),"external-owner-data");symlinkSync(outside,projections);
   assert.throws(()=>openControlStore(join(directory,"project-store")),code("TF_DURABILITY_FAILED"));
   assert.equal(readFileSync(join(outside,"commands.json"),"utf8"),"external-owner-data");
  }
 }finally{f.close();rmSync(directory,{recursive:true,force:true});}
});

test("independently verified authorized audience principal cannot replay another principal command",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"tf-real-principal-"));const f=await approvalFixture(directory);
 try {
  const binding={projectId:f.store.header.projectId,controlDomainId:f.store.header.controlDomainId,projectRoot:directory};
  const other=createAuthorizationAuthority({ownerUid:process.getuid!(),bootstrapSecret:randomBytes(32),credentialIssuerId:"other",hostBaseline:AUTHORIZATION_CAPABILITIES,loadLivePolicy:()=>({host:{}})});
  const context=other.issueStandalone(binding),principal=other.identity(context).principal;
  const request=await f.service.request(f.context,f.request({audience:[principal]}));
  const input:ApprovalDecisionInput={commandId:randomUUID(),runId:f.runId,approvalRequestId:request.approvalRequestId,expectedRunVersion:f.store.readRun(f.runId)!.runVersion,decision:"approve"};
  await f.service.decide(f.context,input);
  const service=new ApprovalService(f.store,{...f.service.authority,authorize:async(ctx,scope)=>{
   const decision=await other.authorize(ctx,{...binding,operation:scope.operation==="read"?"read":"submit",...(scope.operation==="read"?{}:{commandKind:"approval.decide" as const})});
   assert.ok(scope.request?.audience?.includes(decision.callerPrincipal));return decision;
  }});
  const bytes=readFileSync(join(directory,"project-store/journal/000001.jsonl"));
  await assert.rejects(service.decide(context,input),code("TF_CROSS_PRINCIPAL_COMMAND"));
  assert.deepEqual(readFileSync(join(directory,"project-store/journal/000001.jsonl")),bytes);
 }finally{f.close();rmSync(directory,{recursive:true,force:true});}
});
