#!/usr/bin/env node
/** Offline, explicit local-operator P3/P10 workflows. No RPC request can create
 * this authority; it is bound to the invoking OS user and configured paths. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import { ControlError } from "./errors.ts";
import { ControlStoreHeaderSchema } from "./schema/header.ts";
import { readPrivateFile } from "./local-bootstrap.ts";
import { createProjectClone, exportProjectEvidence, rebindMovedProject,
 type ProjectLifecycleAuthority, type ProjectLifecycleOperation } from "./store/project-lifecycle.ts";

const HELP = `Offline project identity and evidence maintenance (local OS owner only).

  taskflow-project-admin move-rebind --store MOVED_STORE
  taskflow-project-admin clone --store SOURCE_STORE --destination NEW_STORE
  taskflow-project-admin export --store STORE --output NEW_JSON [--kind readonly|lossy]

Stop writers before moving the directory. move-rebind verifies the moved store's
original device/inode and refuses copies, active writers, or ambiguous runs.
Clone creates an empty ledger with fresh project/domain IDs; source history stays
untouched. Export writes a new private JSON file, preserves damaged journal bytes
in readonly mode, and always declares executePromise:false. No destination is
overwritten. Source store and destination parent must be owned private directories.
`;
function fail(message: string): never { throw new ControlError("TF_POLICY_DENIED", message, {recoveryAction:"operator",sideEffects:"none"}); }
function privateDirectory(input:string):{path:string;dev:number;ino:number} {
 const absolute=path.resolve(input);
 for(let current=absolute;;){const stat=fs.lstatSync(current);if(stat.isSymbolicLink())fail("operator paths cannot contain symbolic links");const parent=path.dirname(current);if(parent===current)break;current=parent;}
 const stat=fs.lstatSync(absolute);
 if(!process.getuid || !stat.isDirectory() || stat.uid!==process.getuid() || (stat.mode&0o077)!==0)fail("operator directory must be owned by this OS user with mode 0700");
 return {path:fs.realpathSync(absolute),dev:stat.dev,ino:stat.ino};
}
function missing(file:string) { try {fs.lstatSync(file);fail("destination already exists; choose a new path");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;} }
function publishExclusive(file:string,bytes:Buffer,check:()=>void){
 check();missing(file);
 const temporary=path.join(path.dirname(file),`.project-export-${randomUUID()}`);
 const fd=fs.openSync(temporary,"wx",0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{check();fs.linkSync(temporary,file);const dir=fs.openSync(path.dirname(file),"r");try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
 finally{fs.unlinkSync(temporary);}
}
export async function runProjectAdminCli(argv=process.argv.slice(2)):Promise<number>{
 if(argv.length===0||argv.includes("--help")){process.stdout.write(HELP);return 0;}
 const operation=argv[0];if(!["move-rebind","clone","export"].includes(operation))fail("unknown project administration operation");
 const flags=new Map<string,string>();
 for(let index=1;index<argv.length;index+=2){const key=argv[index],value=argv[index+1];if(!["--store","--destination","--output","--kind"].includes(key)||!value||value.startsWith("--")||flags.has(key))fail("invalid or duplicate administration argument");flags.set(key,value);}
 if(!flags.has("--store"))fail("--store is required");
 const allowed=operation==="move-rebind"?["--store"]:operation==="clone"?["--store","--destination"]:["--store","--output","--kind"];
 if([...flags.keys()].some(key=>!allowed.includes(key)))fail("argument does not apply to this operation");
 const source=privateDirectory(flags.get("--store")!);
 const raw:unknown=JSON.parse(readPrivateFile(path.join(source.path,"header")).toString("utf8"));
 if(!Value.Check(ControlStoreHeaderSchema,raw))fail("invalid authoritative store header");
 const header=raw, uid=process.getuid!();
 const destinationInput=operation==="clone"?flags.get("--destination"):operation==="export"?flags.get("--output"):undefined;
 if(operation!=="move-rebind"&&!destinationInput)fail(operation==="clone"?"--destination is required":"--output is required");
 const destination=destinationInput?path.resolve(destinationInput):undefined;
 const parent=destination?privateDirectory(path.dirname(destination)):undefined;
 if(destination){if(destination===source.path||destination.startsWith(source.path+path.sep))fail("destination must be outside the source ledger");missing(destination);}
 const token=Object.freeze(Object.create(null)) as object;
 const check=()=>{
  if(process.getuid!()!==uid)fail("operator OS identity changed");
  const current=privateDirectory(source.path);if(current.dev!==source.dev||current.ino!==source.ino)fail("source directory identity changed");
  if(parent){const latest=privateDirectory(parent.path);if(latest.dev!==parent.dev||latest.ino!==parent.ino)fail("destination parent identity changed");}
 };
 const authority:ProjectLifecycleAuthority<object>={authorize(context,scope){
  check();if(context!==token||scope.operation!==operation as ProjectLifecycleOperation||scope.header.projectId!==header.projectId||scope.header.controlDomainId!==header.controlDomainId)fail("operator context does not authorize this identity operation");
  if(scope.destination!==undefined && scope.destination!==(operation==="move-rebind"?source.path:destination))fail("operator destination changed");
  return {principal:`os-user:${uid}`,operator:true};
 }};
 if(operation==="move-rebind"){
  const result=await rebindMovedProject(source.path,token,authority);
  process.stdout.write(JSON.stringify({operation,header:result})+"\n");return 0;
 }
 if(operation==="clone"){
  const result=await createProjectClone(source.path,destination!,token,authority);
  process.stdout.write(JSON.stringify({operation,header:result,historyCopied:false})+"\n");return 0;
 }
 const kind=flags.get("--kind")??"readonly";if(kind!=="readonly"&&kind!=="lossy")fail("export kind must be readonly or lossy");
 const result=await exportProjectEvidence(source.path,kind,token,authority);
 publishExclusive(destination!,Buffer.from(JSON.stringify(result,null,2)+"\n"),check);
 process.stdout.write(JSON.stringify({operation,exportKind:kind,executePromise:false,integrity:result.integrity,fileCount:result.files.length,output:destination})+"\n");return 0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 runProjectAdminCli().then(code=>{process.exitCode=code;},error=>{process.stderr.write(JSON.stringify({error:error instanceof ControlError?error.code:"TF_BOOTSTRAP_FAILED",message:error instanceof Error?error.message:"project administration failed"})+"\n");process.exitCode=1;});
}
