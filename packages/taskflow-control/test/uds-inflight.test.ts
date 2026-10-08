import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startUdsServer, connectUdsClient } from "../src/uds.ts";
import { defaultServerHello } from "../src/control-host.ts";

test("one flooding client and a throwing disconnect hook cannot exhaust or crash the shared UDS host", {timeout:10000}, async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"tf-uds-limit-")));
 let release!:()=>void; const hold=new Promise<void>(resolve=>{release=resolve;});let active=0;let max=0;
 const endpointPath=path.join(dir,"sock");
 const server=await startUdsServer({endpointPath,serverHello:defaultServerHello(),getFencingEpoch:()=>1,
  onDisconnect:()=>{throw new Error("isolated cleanup failure");},
  handleRpc:async(method)=>{if(method==="ping")return "healthy";active++;max=Math.max(max,active);await hold;active--;return "done";}});
 const client=await connectUdsClient({endpointPath,clientHello:defaultServerHello()});
 try{
  const requests=Array.from({length:65},()=>client.rpc("hold",{}));
  const settled=await Promise.allSettled(requests);
  assert.ok(settled.some(result=>result.status==="rejected"));assert.equal(max,64);
  const healthy=await connectUdsClient({endpointPath,clientHello:defaultServerHello()});
  try{assert.equal(await healthy.rpc("ping",{}),"healthy");}finally{healthy.close();}
 }finally{release();client.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
