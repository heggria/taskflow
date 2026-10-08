import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RuntimeTeExecutionProvider } from "../src/runtime-provider.ts";

const fixture = fileURLToPath(new URL("./fixtures/runtime-restart-worker.ts", import.meta.url));
function launch(base: string, action: string) {
 const child = fork(fixture, [base, action], { execArgv: ["--conditions=development", "--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
 let output = "";
 child.stdout?.on("data", data => { output += data; }); child.stderr?.on("data", data => { output += data; });
 const message = new Promise<Record<string, unknown>>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`worker ${action} timed out: ${output}`)), 20000);
  child.once("message", value => { clearTimeout(timer); const result = value as Record<string, unknown>; result.kind === "error" ? reject(new Error(String(result.error))) : resolve(result); });
  child.once("exit", code => { clearTimeout(timer); reject(new Error(`worker ${action} exited ${code}: ${output}`)); });
  child.once("error", reject);
 });
 return { child, message };
}
async function stop(child: ChildProcess) {
 if (child.exitCode !== null || child.signalCode !== null) return;
 const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
}

test("SIGKILL at real runtime approval resumes in fresh host without replaying completed scripts", { timeout: 45000 }, async () => {
 const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "control-runtime-restart-"));
 const first = launch(base, "start"); let second: ReturnType<typeof launch> | undefined;
 try {
  const parked = await first.message; assert.equal(parked.kind, "parked");
  const runId = String(parked.runId), root = path.join(base, "project");
  const durable = JSON.parse(fs.readFileSync(path.join(base, "provider", `${runId}.json`), "utf8"));
  assert.equal(durable.checkpoint.writer.pid, first.child.pid);
  assert.equal(typeof durable.checkpoint.writer.birthToken, "string");
  assert.ok(durable.checkpoint.writer.birthToken.length > 0);
  assert.deepEqual(durable.checkpoint.state.foregroundOwner.approvalWait, ["approve"]);
  assert.equal(durable.checkpoint.state.phases.before.status, "done");
  assert.equal(durable.checkpoint.state.phases.before.output, "before-output");
  assert.equal(fs.readFileSync(path.join(root, "before-count"), "utf8"), "x");
  assert.equal(fs.existsSync(path.join(root, "after-count")), false);
  const observer = new RuntimeTeExecutionProvider(path.join(base, "provider"));
  const diagnostic = observer.readDiagnostic(runId)!;
  assert.equal(diagnostic.state.phases.before?.output, "before-output");
  assert.equal(diagnostic.projectRoot, root);
  assert.equal(diagnostic.controlDirectory, path.join(base, "provider", "resources", diagnostic.projectId));
  diagnostic.state.phases.before!.output = "caller mutation";
  assert.equal(observer.readDiagnostic(runId)!.state.phases.before?.output, "before-output");
  assert.throws(() => observer.recoverableExecution(runId), /alive or unobservable/);
  assert.equal((await observer.quiescence(runId)).quiescent, false);
  await stop(first.child);
  assert.equal(observer.recoverableExecution(runId).flow.name, "kill-approval-restart");
  assert.equal((await observer.quiescence(runId)).quiescent, true);
  second = launch(base, "resume"); const result = await second.message;
  assert.equal(result.kind, "completed");
  assert.equal((result.run as { status: string }).status, "completed");
  assert.equal((result.observation as { finalOutput: string }).finalOutput, "after-output");
  assert.equal(observer.readDiagnostic(runId)!.state.status, "completed");
  assert.equal(fs.readFileSync(path.join(root, "before-count"), "utf8"), "x");
  assert.equal(fs.readFileSync(path.join(root, "after-count"), "utf8"), "x");
 } finally { await stop(first.child); if (second) await stop(second.child); fs.rmSync(base, { recursive: true, force: true }); }
});

for (const [editKind,boundary] of [["output","commit"],["plan","commit"],["plan","readmitted"]] as const) test(`SIGKILL at ${boundary} ${editKind} edit restarts its real effects exactly once`,{timeout:45000},async()=>{
 const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"control-edit-restart-"));
 const children:ChildProcess[]=[];
 try{
  const first=launch(base,editKind==="output"?"start-output":"start");children.push(first.child);const parked=await first.message;await stop(first.child);
  const second=launch(base,`${editKind}-${boundary}-pause`);children.push(second.child);const edited=await second.message;
  assert.equal(edited.kind,"edited");assert.equal((edited.approval as {status:string}).status,"edited");
  if(boundary==="readmitted")assert.equal((edited.run as {slot:string}).slot,"committed");
  assert.equal(fs.readFileSync(path.join(base,"project","before-count"),"utf8"),"x");assert.equal(fs.existsSync(path.join(base,"project","after-count")),false);
  await stop(second.child);
  const third=launch(base,"resume-committed");children.push(third.child);const result=await third.message;
  assert.equal(result.kind,"completed");assert.equal((result.run as {status:string}).status,"completed");
  assert.equal((result.observation as {finalOutput:string}).finalOutput,`restart-edited-${editKind}`);
  assert.equal(fs.readFileSync(path.join(base,"project","before-count"),"utf8"),"x");assert.equal(fs.readFileSync(path.join(base,"project","after-count"),"utf8"),"x");
  assert.equal((result.run as {runId:string}).runId,parked.runId);
  if(boundary==="readmitted")assert.notEqual((result.run as {owner:{attemptId:string}}).owner.attemptId,(edited.run as {owner:{attemptId:string}}).owner.attemptId);
 }finally{for(const child of children)await stop(child);fs.rmSync(base,{recursive:true,force:true});}
});
