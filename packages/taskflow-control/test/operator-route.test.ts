import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapLocalAuthority, provisionLocalOperator, operatorPolicyPath, readPrivateFile } from "../src/local-bootstrap.ts";
import { answerAuthorizationChallenge } from "../src/authorization.ts";
import type { CoordinatorSnapshot, StoredReservation } from "../src/store/coordinator-store.ts";
import type { RunSnapshot } from "../src/schema/run.ts";

const cli = fileURLToPath(new URL("../src/control-cli.ts", import.meta.url));
function setup() {
 const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tf-operator-")));
 const home = path.join(base, "home"), root = path.join(base, "project"), other = path.join(base, "other");
 fs.mkdirSync(root); fs.mkdirSync(other);
 return { base, home, root, other };
}
interface Reply { id?: number; error?: { code: number }; result?: { isError?: boolean; content: { text: string }[]; tools?: { name: string }[] } }
function launch(args: string[]) {
 const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types", cli, ...args], { stdio: "pipe" });
 let stdout = "", stderr = "", buffer = "", sequence = 0;
 const pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
 child.stdout.on("data", data => {
  stdout += String(data); buffer += String(data);
  for (;;) {
   const end = buffer.indexOf("\n"); if (end < 0) break;
   const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
   const reply = JSON.parse(line) as Reply;
   if (reply.id !== undefined) { pending.get(reply.id)?.resolve(reply); pending.delete(reply.id); }
  }
 });
 child.stderr.on("data", data => { stderr += String(data); });
 const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.once("close", code => {
  for (const waiter of pending.values()) waiter.reject(new Error(`child exited: ${stderr}`));
  pending.clear(); resolve({ code, stdout, stderr });
 }));
 return {
  child, done, output: () => ({ stdout, stderr }),
  request(method: string, params: unknown = {}): Promise<Reply> {
   const id = ++sequence;
   return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method} ${stderr}`)); }, 15_000);
    pending.set(id, { resolve(reply) { clearTimeout(timer); resolve(reply); }, reject(error) { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
   });
  },
  async stop(signal: NodeJS.Signals = "SIGTERM") {
   if (child.exitCode !== null || child.signalCode !== null) return;
   child.kill(signal); const timer = setTimeout(() => child.kill("SIGKILL"), 3_000); await done; clearTimeout(timer);
  },
 };
}
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
 const deadline = Date.now() + 15_000;
 for (;;) {
  const value = await read(); if (accept(value)) return value;
  assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
  await new Promise(resolve => setTimeout(resolve, 30));
 }
}
async function initialize(session: ReturnType<typeof launch>) {
 const reply = await session.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "operator-process-test", version: "1" } });
 assert.equal(reply.error, undefined);
}
async function tool<T>(session: ReturnType<typeof launch>, name: string, args: Record<string, unknown> = {}): Promise<T> {
 const reply = await session.request("tools/call", { name: `taskflow_control_${name}`, arguments: args });
 assert.equal(reply.error, undefined, JSON.stringify(reply));
 assert.equal(reply.result?.isError, undefined, JSON.stringify(reply));
 return JSON.parse(reply.result!.content[0]!.text) as T;
}
async function toolDenied(session: ReturnType<typeof launch>, name: string, args: Record<string, unknown>) {
 const reply = await session.request("tools/call", { name: `taskflow_control_${name}`, arguments: args });
 assert.equal(reply.result?.isError, true, JSON.stringify(reply));
 assert.match(reply.result!.content[0]!.text, /TF_POLICY_DENIED|TF_AUTHORITY_REVOKED/);
}

test("operator bootstrap is separate, explicit, scope-bound and live-revocable", async () => {
 const f = setup();
 try {
  const local = bootstrapLocalAuthority(f.home, [f.root, f.other]);
  assert.equal(fs.existsSync(path.join(f.home, "operator.key")), false);
  const binding = { projectId: randomUUID(), controlDomainId: randomUUID(), projectRoot: f.root };
  const request = { ...binding, operation: "submit" as const, commandKind: "coordinator.setMaxActiveRuns" as const };
  const ordinary = local.authorization.issueStandalone(binding);
  await assert.rejects(local.authorization.authorize(ordinary, request), /baseline/);
  assert.throws(() => local.authorization.createOperatorChallenge!(binding), /absent/);
  provisionLocalOperator(f.home, f.root);
  const challenge = local.authorization.createOperatorChallenge!(binding);
  assert.match(challenge.principal, /\/credential:operator$/);
  assert.throws(() => local.authorization.authenticate(challenge.id, answerAuthorizationChallenge(local.secret, challenge)), /proof failed/);
  const second = local.authorization.createOperatorChallenge!(binding);
  const context = local.authorization.authenticate(second.id, answerAuthorizationChallenge(readPrivateFile(path.join(f.home, "operator.key")), second));
  assert.equal((await local.authorization.authorize(context, request)).capability.kind, "coordinator.setMaxActiveRuns");
  await assert.rejects(local.authorization.authorize(ordinary, request), /baseline/);
  await assert.rejects(local.authorization.authorize(context, { ...request, projectRoot: f.other, projectId: randomUUID() }), /project\/domain/);
  const file = operatorPolicyPath(f.home, f.root), policy = JSON.parse(readPrivateFile(file).toString());
  policy.capabilities = []; fs.writeFileSync(file, JSON.stringify(policy));
  await assert.rejects(local.authorization.authorize(context, request), /capability/);
  // Provisioning again must not overwrite deliberate revocation.
  provisionLocalOperator(f.home, f.root);
  assert.deepEqual(JSON.parse(readPrivateFile(file).toString()).capabilities, []);
  fs.unlinkSync(path.join(f.home, "operator.key"));
  assert.throws(() => local.authorization.identity(context), /absent/);
  assert.equal(local.authorization.identity(ordinary).binding.projectId, binding.projectId);
 } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test("CLI and MCP operator routes deny defaults, preserve project isolation and replay audited unknown release after restart", { timeout: 120_000 }, async () => {
 const f = setup();
 const sessions: ReturnType<typeof launch>[] = [];
 const start = (args: string[]) => { const process = launch(args); sessions.push(process); return process; };
 const common = ["--root", f.root, "--control-home", f.home];
 const command = async (args: string[], success = true) => {
  const result = await start([...args, ...common]).done;
  assert.equal(result.code, success ? 0 : 1, result.stderr + result.stdout); return result;
 };
 const serve = async () => {
  const server = start(["serve", ...common, "--root", f.other]);
  const output = await until(server.output, output => output.stdout.includes("\n"), "server ready");
  return { server, info: JSON.parse(output.stdout.split("\n")[0]!) as { projects: { projectId: string }[] } };
 };
 try {
  let { server, info } = await serve();
  const initial = fs.readFileSync(path.join(f.home, "coordinator", "coordinator.json"));
  assert.equal(fs.existsSync(path.join(f.home, "operator.key")), false);
  const capacityCommand = randomUUID();
  assert.match((await command(["set-max-active-runs", "--command-id", capacityCommand, "--max-active-runs", "2"], false)).stderr, /TF_POLICY_DENIED/);
  assert.deepEqual(fs.readFileSync(path.join(f.home, "coordinator", "coordinator.json")), initial);
  await command(["operator-provision"]);
  const ordinary = start(["mcp", ...common]); await initialize(ordinary);
  const ordinaryTools = (await ordinary.request("tools/list")).result!.tools!;
  assert.equal(ordinaryTools.length, 13);
  assert.equal(ordinaryTools.some(t => /force_release|set_max_active_runs/.test(t.name)), false);
  assert.equal((await ordinary.request("tools/call", { name: "taskflow_control_set_max_active_runs", arguments: { commandId: capacityCommand, maxActiveRuns: 2 } })).error?.code, -32602);
  assert.equal(JSON.parse((await command(["set-max-active-runs", "--operator", "--command-id", capacityCommand, "--max-active-runs", "2"])).stdout), 2);
  const operator = start(["mcp", ...common, "--operator"]); await initialize(operator);
  assert.equal((await operator.request("tools/list")).result!.tools!.length, 15);
  assert.equal(await tool(operator, "set_max_active_runs", { commandId: capacityCommand, maxActiveRuns: 2 }), 2);
  const otherHeader = JSON.parse(fs.readFileSync(path.join(f.other, ".taskflow", "control", "header"), "utf8"));
  assert.ok(info.projects.some(p => p.projectId === otherHeader.projectId));
  await toolDenied(operator, "set_max_active_runs", { projectId: otherHeader.projectId, commandId: randomUUID(), maxActiveRuns: 3 });

  const otherOrdinary = start(["mcp", "--root", f.other, "--control-home", f.home]); await initialize(otherOrdinary);
  const otherRun = await tool<{ runId: string }>(otherOrdinary, "submit", { commandId: randomUUID(), flow: { name: "other-project", phases: [{ id: "done", type: "script", run: "printf other" }] } });
  await until(() => tool<RunSnapshot>(otherOrdinary, "status", { runId: otherRun.runId }), run => run.status === "completed", "other run complete");
  const b = await tool<CoordinatorSnapshot>(otherOrdinary, "coordinator");
  const bReservation = b.reservations.find(row => row.reservation.runId === otherRun.runId)!;
  assert.ok(bReservation);
  const scoped = await tool<CoordinatorSnapshot>(operator, "coordinator");
  assert.equal(JSON.stringify(scoped).includes(bReservation.reservation.reservationId), false);
  const beforeCrossProject = fs.readFileSync(path.join(f.home, "coordinator", "coordinator.json"));
  await toolDenied(operator, "force_release", { commandId: randomUUID(), reservationId: bReservation.reservation.reservationId, riskAcknowledgement: true, reason: "must not release another project" });
  assert.deepEqual(fs.readFileSync(path.join(f.home, "coordinator", "coordinator.json")), beforeCrossProject);

  const accepted = await tool<{ runId: string }>(ordinary, "submit", { commandId: randomUUID(), flow: { name: "unknown-owner", phases: [{ id: "work", type: "script", run: [process.execPath, "-e", "require('node:fs').writeFileSync('started','yes');setTimeout(()=>process.stdout.write('done'),1500)"] }] } });
  await until(() => fs.existsSync(path.join(f.root, "started")), Boolean, "real script started");
  await server.stop("SIGKILL"); await ordinary.stop(); await operator.stop(); await otherOrdinary.stop();
  // The actual child can finish, but the dead owner cannot publish terminal proof.
  await new Promise(resolve => setTimeout(resolve, 1700));
  ({ server } = await serve());
  const restartedOrdinary = start(["mcp", ...common]); await initialize(restartedOrdinary);
  const unknown = await tool<RunSnapshot>(restartedOrdinary, "status", { runId: accepted.runId });
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.stage, "reconciling");
  const snapshot = JSON.parse((await command(["coordinator-status", "--operator"])).stdout) as CoordinatorSnapshot;
  const held = snapshot.reservations.find(row => row.reservation.runId === accepted.runId)!;
  assert.ok(["committed", "orphan-suspect"].includes(held.reservation.state));
  const releaseCommand = randomUUID(), reason = "Owner died; explicitly accept uncertain process outcome";
  const release = ["force-release", "--operator", "--command-id", releaseCommand, "--reservation", held.reservation.reservationId, "--reason", reason];
  assert.match((await command(release, false)).stderr, /acknowledge-risk/);
  const released = JSON.parse((await command([...release, "--acknowledge-risk"])).stdout) as StoredReservation;
  assert.equal(released.releaseKind, "force"); assert.equal(released.concurrencyGuarantee, "operator-overridden");
  assert.equal(released.reservation.state, "released");
  await restartedOrdinary.stop(); await server.stop();
  const legacyFile = path.join(f.home, "coordinator", "coordinator.json");
  const legacyBytes = fs.readFileSync(legacyFile);
  const legacyEpoch = JSON.parse(legacyBytes.toString()).fencingEpoch as number;
  assert.ok(legacyEpoch >= 2);
  // Emulate an old installation: its recovered ledger survives graceful
  // shutdown, but old code never wrote the new persistent generation file.
  fs.unlinkSync(path.join(f.home, "coordinator-epoch.json"));
  const corrupt = JSON.parse(legacyBytes.toString()); corrupt.fencingEpoch += 100;
  fs.writeFileSync(legacyFile, JSON.stringify(corrupt));
  const corruptBytes = fs.readFileSync(legacyFile);
  assert.match((await command(["coordinator-status", "--mode", "auto"], false)).stderr, /TF_DURABILITY_FAILED/);
  assert.deepEqual(fs.readFileSync(legacyFile), corruptBytes);
  assert.equal(fs.existsSync(path.join(f.home, "coordinator-epoch.json")), false);
  assert.equal(fs.existsSync(path.join(f.home, "singleton.lock.json")), false);
  fs.writeFileSync(legacyFile, legacyBytes);
  ({ server } = await serve());
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.home, "coordinator-epoch.json"), "utf8")).fencingEpoch > legacyEpoch);
  await server.stop();
  ({ server } = await serve());
  const beforeReplay = fs.readFileSync(path.join(f.home, "coordinator", "coordinator.json"));
  const replay = await command([...release, "--acknowledge-risk"]);
  assert.equal(replay.stdout, JSON.stringify(released) + "\n");
  assert.equal(JSON.parse((await command(["set-max-active-runs", "--operator", "--command-id", capacityCommand, "--max-active-runs", "2"])).stdout), 2);
  assert.deepEqual(fs.readFileSync(path.join(f.home, "coordinator", "coordinator.json")), beforeReplay);
  const final = JSON.parse((await command(["coordinator-status", "--operator"])).stdout) as CoordinatorSnapshot;
  assert.equal(final.concurrencyGuarantee, "operator-overridden");
  const audit = final.commands.find(c => c.record.commandId === releaseCommand)!;
  assert.deepEqual(audit.request, { kind: "forceRelease", reservationId: held.reservation.reservationId, riskAcknowledgement: true, reason });
  assert.match(audit.record.callerPrincipal, /\/credential:operator$/);
  assert.equal(final.commands.filter(c => c.record.commandId === releaseCommand).length, 1);
  const liveOperator = start(["mcp", ...common, "--operator"]); await initialize(liveOperator);
  assert.deepEqual(await tool(liveOperator, "force_release", { commandId: releaseCommand, reservationId: held.reservation.reservationId, riskAcknowledgement: true, reason }), released);
  const missingAcknowledgement = await liveOperator.request("tools/call", { name: "taskflow_control_force_release", arguments: { commandId: randomUUID(), reservationId: held.reservation.reservationId, reason } });
  assert.equal(missingAcknowledgement.error?.code, -32602);
  const alteredRetry = await liveOperator.request("tools/call", { name: "taskflow_control_force_release", arguments: { commandId: releaseCommand, reservationId: held.reservation.reservationId, riskAcknowledgement: true, reason: "different request" } });
  assert.match(alteredRetry.result!.content[0]!.text, /TF_IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(fs.readFileSync(path.join(f.home, "coordinator", "coordinator.json")), beforeReplay);
  const policyFile = operatorPolicyPath(f.home, f.root), policy = JSON.parse(readPrivateFile(policyFile).toString());
  policy.capabilities = []; fs.writeFileSync(policyFile, JSON.stringify(policy));
  const beforeRevoked = fs.readFileSync(path.join(f.home, "coordinator", "coordinator.json"));
  await toolDenied(liveOperator, "force_release", { commandId: releaseCommand, reservationId: held.reservation.reservationId, riskAcknowledgement: true, reason });
  assert.match((await command([...release, "--acknowledge-risk"], false)).stderr, /TF_POLICY_DENIED/);
  assert.deepEqual(fs.readFileSync(path.join(f.home, "coordinator", "coordinator.json")), beforeRevoked);
 } finally {
  for (const session of sessions.reverse()) await session.stop();
  fs.rmSync(f.base, { recursive: true, force: true });
 }
});
