import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { runsDir, probeProcess } from "taskflow-core";
import { LegacyConflictGuard } from "../src/legacy-conflict.ts";
import { ControlError } from "../src/errors.ts";
import { ProjectRegistry } from "../src/project-registry.ts";
import { createAuthorizationAuthority, AUTHORIZATION_CAPABILITIES } from "../src/authorization.ts";
import { RuntimeTeExecutionProvider } from "../src/runtime-provider.ts";
import { ControlHost } from "../src/control-host.ts";

const worker = fileURLToPath(new URL("./fixtures/legacy-writer.ts", import.meta.url));
const isConflict = (error: unknown) => error instanceof ControlError && error.code === "TF_LEGACY_CONFLICT" && error.recoveryAction === "operator";
function setup() {
 const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tf-legacy-")));
 const root = path.join(base, "project"), store = path.join(root, ".taskflow", "control"); fs.mkdirSync(store, { recursive: true });
 return { base, root, store, guard: new LegacyConflictGuard(root, store) };
}
async function writer(root: string) {
 const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types", worker, root], { stdio: ["ignore", "pipe", "pipe"] });
 const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
 const record = await new Promise<{ pid: number; runId: string }>((resolve, reject) => {
  let text = "", stderr = ""; const timer = setTimeout(() => { child.kill(); reject(new Error(`legacy writer timeout ${stderr}`)); }, 5000);
  child.stderr.on("data", data => { stderr += String(data); });
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.stdout.on("data", data => { text += String(data); if (text.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(text.split("\n")[0])); } });
 });
 return { ...record, async stop() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed; } };
}

test("observed old writer freezes fresh Host admission until stopped and explicitly acknowledged", { timeout: 20000 }, async () => {
 const f = setup(), registry = new ProjectRegistry(path.join(f.base, "registry.json"));
 const mount = registry.mount(f.store, f.root);
 const authority = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: randomBytes(32), hostBaseline: AUTHORIZATION_CAPABILITIES, loadLivePolicy: () => ({ host: { capabilities: AUTHORIZATION_CAPABILITIES.map(kind => ({ kind, scopeRoot: f.root })) } }) });
 const context = authority.issueStandalone({ projectId: mount.store.header.projectId, controlDomainId: mount.store.header.controlDomainId, projectRoot: f.root });
 const host = new ControlHost({ mode: "standalone", controlHome: path.join(f.base, "home"), registry, authorization: authority, provider: new RuntimeTeExecutionProvider(path.join(f.base, "provider")) });
 const legacy = await writer(f.root);
 try {
  await host.start();
  const index = path.join(runsDir(f.root), "index.json"), before = fs.readFileSync(index);
  const seq = mount.store.snapshot().commitSeq;
  const request = { commandId: randomUUID(), kind: "run.submit", flow: { name: "after-old", phases: [{ id: "work", type: "script", run: [process.execPath, "-e", "process.stdout.write('after-old-writer')"] }] } };
  await assert.rejects(host.dispatchAuthenticated(context, "commands.submit", request), isConflict);
  assert.equal(mount.store.snapshot().commitSeq, seq); assert.deepEqual(fs.readFileSync(index), before);
  assert.equal(probeProcess(legacy.pid), "alive"); assert.throws(() => f.guard.acknowledgeStopped(), isConflict);
  await legacy.stop(); assert.equal(probeProcess(legacy.pid), "dead");
  assert.throws(() => new LegacyConflictGuard(f.root, f.store).assertMayAttempt(), isConflict);
  f.guard.acknowledgeStopped(); f.guard.assertMayAttempt();
  const accepted = await host.dispatchAuthenticated<{ runId: string }>(context, "commands.submit", request);
  const terminal = await host.dispatchAuthenticated<{ status: string }>(context, "runs.wait", { runId: accepted.runId }); assert.equal(terminal.status, "completed");
  assert.deepEqual(fs.readFileSync(index), before);
 } finally { await legacy.stop(); host.stop(); registry.close(); fs.rmSync(f.base, { recursive: true, force: true }); }
});

test("captured PID remains blocking after its legacy record is hidden; unknown owner cannot be acknowledged by removal", { timeout: 10000 }, async () => {
 const f = setup(), legacy = await writer(f.root);
 try {
  assert.throws(() => f.guard.assertMayAttempt(), isConflict);
  const record = path.join(runsDir(f.root), "old-writer", `${legacy.runId}.json`);
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, "utf8")), status: "completed" }));
  assert.ok(f.guard.inspect().some(observation => observation.pid === legacy.pid), "a terminal label does not prove the recorded owner stopped");
  fs.unlinkSync(record);
  assert.throws(() => f.guard.acknowledgeStopped(), isConflict); assert.equal(probeProcess(legacy.pid), "alive");
  await legacy.stop(); f.guard.acknowledgeStopped(); f.guard.assertMayAttempt();
  const lock = path.join(runsDir(f.root), "index.json.lock"); fs.writeFileSync(lock, "{}");
  assert.throws(() => f.guard.assertMayAttempt(), isConflict); fs.unlinkSync(lock);
  assert.throws(() => f.guard.acknowledgeStopped(), isConflict);
  fs.writeFileSync(lock, JSON.stringify({ pid: legacy.pid, ts: Date.now() }));
  f.guard.acknowledgeStopped(); f.guard.assertMayAttempt();
 } finally { await legacy.stop(); fs.rmSync(f.base, { recursive: true, force: true }); }
});

test("legacy inspection does not rebuild index and refuses symlink or oversized evidence", () => {
 const f = setup();
 try {
  const root = runsDir(f.root); fs.mkdirSync(root, { recursive: true });
  f.guard.assertMayAttempt(); assert.equal(fs.existsSync(path.join(root, "index.json")), false);
  fs.writeFileSync(path.join(root, "large.json"), " ".repeat(1024 * 1024 + 1)); assert.throws(() => f.guard.assertMayAttempt(), isConflict);
  fs.unlinkSync(path.join(root, "large.json")); fs.symlinkSync(f.store, path.join(root, "outside"));
  assert.ok(f.guard.inspect().some(observation => observation.path.endsWith("outside")));
 } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});
