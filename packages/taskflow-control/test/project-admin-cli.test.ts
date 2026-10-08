import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openControlStore } from "../src/store/store.ts";
import type { ProjectForensicExport } from "../src/store/project-lifecycle.ts";
const cli=fileURLToPath(new URL("../src/project-admin-cli.ts",import.meta.url));
function invoke(args:string[]){const result=spawnSync(process.execPath,["--conditions=development","--experimental-strip-types",cli,...args],{encoding:"utf8",timeout:10000});assert.equal(result.error,undefined);return result;}
function snapshot(root:string){const files:Record<string,string>={};function walk(dir:string){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);if(fs.lstatSync(file).isDirectory())walk(file);else files[path.relative(root,file)]=createHash("sha256").update(fs.readFileSync(file)).digest("hex");}}walk(root);return files;}
function fixture(){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"tf-admin-"))),source=path.join(base,"ledger");
 const store=openControlStore(source),h=store.header;
 const run={runId:randomUUID(),projectId:h.projectId,controlDomainId:h.controlDomainId,status:"completed" as const,stage:"terminal" as const,slot:"released" as const,needsOperator:false,runVersion:0,boundPlanHash:`plan:${"a".repeat(64)}`,policyHash:"b".repeat(64),authorityEpoch:1};
 store.createRun(run,[{eventId:randomUUID(),recordedAt:Date.now(),payload:{kind:"run.terminal",status:"completed"}}]);store.close();
 return {base,source,header:h,close:()=>fs.rmSync(base,{recursive:true,force:true})};
}
test("offline move-rebind process preserves IDs and all journal bytes for the same moved inode",()=>{
 const f=fixture();try{
  const before=snapshot(f.source),identity=fs.statSync(f.source),moved=path.join(f.base,"moved");fs.renameSync(f.source,moved);
  const result=invoke(["move-rebind","--store",moved]);assert.equal(result.status,0,result.stderr);
  const header=JSON.parse(result.stdout).header;assert.equal(header.projectId,f.header.projectId);assert.equal(header.controlDomainId,f.header.controlDomainId);
  assert.equal(header.directoryBinding.canonicalPath,moved);assert.equal(String(identity.ino),header.directoryBinding.inode);
  const after=snapshot(moved);delete before.header;delete after.header;assert.deepEqual(after,before);assert.equal(fs.existsSync(f.source),false);
 }finally{f.close();}
});
test("clone process creates fresh identities with no copied history and refuses existing copied ledgers",()=>{
 const f=fixture();try{
  const before=snapshot(f.source),destination=path.join(f.base,"clone");
  const result=invoke(["clone","--store",f.source,"--destination",destination]);assert.equal(result.status,0,result.stderr);
  const body=JSON.parse(result.stdout);assert.notEqual(body.header.projectId,f.header.projectId);assert.notEqual(body.header.controlDomainId,f.header.controlDomainId);assert.equal(body.historyCopied,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination,"commit-seq.json"),"utf8")).commitSeq,0);assert.deepEqual(snapshot(f.source),before);
  const copy=path.join(f.base,"copied");fs.cpSync(f.source,copy,{recursive:true});fs.chmodSync(copy,0o700);const copied=snapshot(copy);
  const rejected=invoke(["clone","--store",f.source,"--destination",copy]);assert.equal(rejected.status,1);assert.deepEqual(snapshot(copy),copied);assert.deepEqual(snapshot(f.source),before);
  const adopt=invoke(["move-rebind","--store",copy]);assert.equal(adopt.status,1);assert.match(adopt.stderr,/copy\/adopt exclusivity/);assert.deepEqual(snapshot(copy),copied);
 }finally{f.close();}
});
test("damaged forensic export process preserves raw bytes, declares no execution promise, never overwrites",()=>{
 const f=fixture();try{
  const journal=path.join(f.source,"journal/000001.jsonl");fs.appendFileSync(journal,'{"broken":');const damaged=fs.readFileSync(journal),before=snapshot(f.source),output=path.join(f.base,"evidence.json");
  const result=invoke(["export","--store",f.source,"--output",output]);assert.equal(result.status,0,result.stderr);
  const exported=JSON.parse(fs.readFileSync(output,"utf8")) as ProjectForensicExport;
  assert.equal(exported.integrity,"damaged");assert.equal(exported.executePromise,false);assert.equal(exported.exportKind,"readonly");
  assert.deepEqual(Buffer.from(exported.files.find(file=>file.path==="journal/000001.jsonl")!.bytesBase64!,"base64"),damaged);
  assert.equal(fs.statSync(output).mode&0o777,0o600);assert.deepEqual(snapshot(f.source),before);
  const saved=fs.readFileSync(output);const rejected=invoke(["export","--store",f.source,"--output",output]);assert.equal(rejected.status,1);assert.deepEqual(fs.readFileSync(output),saved);assert.deepEqual(snapshot(f.source),before);
  const lossy=path.join(f.base,"lossy.json");assert.equal(invoke(["export","--store",f.source,"--output",lossy,"--kind","lossy"]).status,0);
  assert.ok((JSON.parse(fs.readFileSync(lossy,"utf8")) as ProjectForensicExport).files.every(file=>file.bytesBase64===undefined));
 }finally{f.close();}
});
test("offline CLI rejects public directories and source symlinks without mutation",()=>{
 const f=fixture();try{
  const before=snapshot(f.source);fs.chmodSync(f.source,0o755);
  const denied=invoke(["export","--store",f.source,"--output",path.join(f.base,"no.json")]);assert.equal(denied.status,1);assert.match(denied.stderr,/0700/);
  fs.chmodSync(f.source,0o700);const link=path.join(f.base,"link");fs.symlinkSync(f.source,link);
  assert.equal(invoke(["export","--store",link,"--output",path.join(f.base,"no.json")]).status,1);
  assert.deepEqual(snapshot(f.source),before);assert.equal(fs.existsSync(path.join(f.base,"no.json")),false);
 }finally{f.close();}
});
