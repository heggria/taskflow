import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connectUdsClient } from "../src/uds.ts";
import type { Receipt } from "../src/schema/evidence.ts";
import { defaultServerHello } from "../src/control-host.ts";
import { bootstrapLocalAuthority, policyPath, readPrivateFile } from "../src/local-bootstrap.ts";

const cli = fileURLToPath(new URL("../src/control-cli.ts", import.meta.url));
function temp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tf-cli-"))); }
function start(args: string[]) {
 const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types", cli, ...args], { stdio: "pipe", env: { ...process.env, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" } });
 let stdout = "", stderr = "";
 child.stdout.on("data", data => { stdout += String(data); }); child.stderr.on("data", data => { stderr += String(data); });
 const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.on("close", code => resolve({ code, stdout, stderr })));
 return { child, done, output: () => ({ stdout, stderr }) };
}
async function stop(child: ChildProcessWithoutNullStreams) {
 if (child.exitCode !== null || child.signalCode !== null) return;
 const done = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGTERM");
 const timeout = setTimeout(() => child.kill("SIGKILL"), 3000); await done; clearTimeout(timeout);
}
async function ready(process: ReturnType<typeof start>) {
 const deadline = Date.now() + 10000;
 while (!process.output().stdout.includes("\n")) {
  if (process.child.exitCode !== null || Date.now() > deadline) throw new Error(`CLI not ready: ${JSON.stringify(process.output())}`);
  await new Promise(resolve => setTimeout(resolve, 25));
 }
 return JSON.parse(process.output().stdout.split("\n")[0]);
}
function flow(root: string) {
 const file = path.join(root, "flow.json");
 fs.writeFileSync(file, JSON.stringify({ name: "cli-script", phases: [{ id: "write-proof", type: "script", run: [process.execPath, "-e", "require('node:fs').writeFileSync('executed.txt','real-script'); process.stdout.write('real-output')"], final: true }] }));
 return file;
}
test("CLI fresh default auto executes real script and persists a terminal run", { timeout: 20000 }, async () => {
 const base = temp(); const root = path.join(base, "project"); fs.mkdirSync(root); const home = path.join(base, "home"); const file = flow(root);
 const running = start(["run", "--root", root, "--control-home", home, "--flow", file]);
 try {
  const result = await running.done; assert.equal(result.code, 0, result.stderr + result.stdout);
  const body = JSON.parse(result.stdout); assert.equal(body.run.status, "completed"); assert.equal(body.run.slot, "released"); assert.equal(body.result.finalOutput, "real-output");
  assert.equal(fs.readFileSync(path.join(root, "executed.txt"), "utf8"), "real-script");
  assert.equal(readPrivateFile(path.join(home, "bootstrap.key")).length, 32);
  assert.ok(fs.existsSync(path.join(home, "registry.json")));
 } finally { await stop(running.child); fs.rmSync(base, { recursive: true, force: true }); }
});
test("CLI interrupt commits cancellation and retains capacity for an ambiguous script mutation", { timeout: 20000 }, async () => {
 const base = temp(), root = path.join(base, "project"), home = path.join(base, "home"); fs.mkdirSync(root);
 const file = path.join(root, "flow.json");
 fs.writeFileSync(file, JSON.stringify({ name: "interrupt", phases: [{ id: "wait", type: "script", run: [process.execPath, "-e", "require('node:fs').writeFileSync('started.txt','started'); setTimeout(()=>require('node:fs').writeFileSync('late.txt','unexpected'),10000)"], final: true }] }));
 const running = start(["run", "--root", root, "--control-home", home, "--flow", file]);
 try {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(root, "started.txt"))) {
   assert.equal(running.child.exitCode, null, running.output().stderr);
   assert.ok(Date.now() < deadline, "script never started"); await new Promise(resolve => setTimeout(resolve, 20));
  }
  running.child.kill("SIGINT");
  const result = await running.done; assert.equal(result.code, 1, result.stderr + result.stdout);
  const body = JSON.parse(result.stdout); assert.equal(body.run.status, "unknown"); assert.equal(body.run.slot, "committed"); assert.equal(body.run.needsOperator, true);
  assert.equal(fs.existsSync(path.join(root, "late.txt")), false);
  const journal = fs.readFileSync(path.join(root, ".taskflow", "control", "journal", "000001.jsonl"), "utf8");
  assert.match(journal, /"kind":"run.cancel"/);
  assert.doesNotMatch(journal, /"kind":"run.terminal"/);
 } finally { await stop(running.child); fs.rmSync(base, { recursive: true, force: true }); }
});
test("CLI serve accepts authenticated process attach, status, and console handoff without printing secrets", { timeout: 25000 }, async () => {
 const base = temp(); const root = path.join(base, "project"); fs.mkdirSync(root); const home = path.join(base, "home"); const file = flow(root);
 const server = start(["serve", "--root", root, "--control-home", home, "--console"]);
 try {
  const info = await ready(server); const handoff = JSON.parse(readPrivateFile(info.browserHandoffFile).toString());
  assert.equal(handoff.url, info.consoleUrl); assert.ok(handoff.token.length > 30);
  assert.ok(!server.output().stdout.includes(handoff.token)); assert.ok(!info.consoleUrl.includes("token"));
  const unauthenticated = await connectUdsClient({ endpointPath: info.control.endpoint, clientHello: defaultServerHello() });
  try {
   await assert.rejects(unauthenticated.rpc("runs.list", {}), /authenticate/);
   const challenge = await unauthenticated.rpc<{ id: string }>("auth.challenge", {});
   await assert.rejects(unauthenticated.rpc("auth.authenticate", { challengeId: challenge.id, proof: "0".repeat(64) }), /proof failed/);
   await assert.rejects(unauthenticated.rpc("runs.list", {}), /authenticate/);
  } finally { unauthenticated.close(); }
  const client = start(["run", "--root", root, "--control-home", home, "--flow", file]);
  const run = await client.done; assert.equal(run.code, 0, run.stderr + run.stdout); const result = JSON.parse(run.stdout);
  assert.equal(result.run.status, "completed");
  const session = await fetch(`${handoff.url}/api/session`, { method: "POST", headers: { "content-type": "application/json", origin: handoff.url }, body: JSON.stringify({ token: handoff.token }) });
  assert.equal(session.status, 200, await session.text());
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const receiptResponse = await fetch(`${handoff.url}/api/projects/${result.projectId}/runs/${result.runId}/receipt?controlDomainId=${result.controlDomainId}`, { headers: { cookie } });
  assert.equal(receiptResponse.status, 200, await receiptResponse.clone().text());
  const { result: receipt } = await receiptResponse.json() as { result: Receipt }; assert.equal(receipt.runId, result.runId); assert.equal(receipt.assurance.providerOutcome, "completed");
  const status = await start(["status", "--root", root, "--control-home", home, "--run", result.runId]).done;
  assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).control.singleton, "attached");
  const policyFile = policyPath(home, root); const policy = JSON.parse(readPrivateFile(policyFile).toString()); policy.capabilities = [];
  fs.writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
  const denied = await start(["status", "--root", root, "--control-home", home]).done;
  assert.equal(denied.code, 1); assert.match(denied.stderr, /TF_POLICY_DENIED/);
 } finally { await stop(server.child); fs.rmSync(base, { recursive: true, force: true }); }
});
test("bootstrap denies permissive or symbolic-link credential paths and preserves existing policy", () => {
 const root = temp(); const home = path.join(root, "home");
 try {
  const first = bootstrapLocalAuthority(home, [root]); const key = path.join(home, "bootstrap.key");
  fs.chmodSync(key, 0o644); assert.throws(() => bootstrapLocalAuthority(home, [root]), /owner, mode or identity/); fs.chmodSync(key, 0o600);
  const saved = path.join(home, "saved"); fs.renameSync(key, saved); fs.symlinkSync(saved, key);
  assert.throws(() => bootstrapLocalAuthority(home, [root]), /symbolic-link/); fs.unlinkSync(key); fs.renameSync(saved, key);
  const file = policyPath(home, root); fs.writeFileSync(file, JSON.stringify({ version: 1, projectRoot: root, capabilities: [], revokedPrincipals: [] }));
  const again = bootstrapLocalAuthority(home, [root]); assert.deepEqual(again.secret, first.secret);
  assert.deepEqual(JSON.parse(readPrivateFile(file).toString()).capabilities, []);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI multi-project server routes distinct roots and coordinated absence fails closed", { timeout: 25000 }, async () => {
 const base = temp(); const roots = [path.join(base, "one"), path.join(base, "two")]; for (const root of roots) fs.mkdirSync(root);
 const home = path.join(base, "home"), file = flow(roots[1]);
 const server = start(["serve", "--root", roots[0], "--root", roots[1], "--control-home", home]);
 try {
  const info = await ready(server); assert.equal(info.projects.length, 2);
  const result = await start(["run", "--root", roots[1], "--control-home", home, "--flow", file]).done;
  assert.equal(result.code, 0, result.stderr + result.stdout); assert.equal(fs.readFileSync(path.join(roots[1], "executed.txt"), "utf8"), "real-script");
  assert.equal(fs.existsSync(path.join(roots[0], "executed.txt")), false);
  const first = await start(["status", "--root", roots[0], "--control-home", home]).done;
  assert.equal(first.code, 0, first.stderr); assert.deepEqual(JSON.parse(first.stdout).result, []);
  await stop(server.child);
  const unavailable = await start(["status", "--root", roots[0], "--control-home", home]).done;
  assert.equal(unavailable.code, 1); assert.match(unavailable.stderr, /TF_JOURNAL_UNAVAILABLE/);
 } finally { await stop(server.child); fs.rmSync(base, { recursive: true, force: true }); }
});
