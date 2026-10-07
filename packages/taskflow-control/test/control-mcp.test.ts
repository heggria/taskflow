import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { policyPath, readPrivateFile } from "../src/local-bootstrap.ts";

const cli = fileURLToPath(new URL("../src/control-cli.ts", import.meta.url));
interface RpcResponse { id: number | null; result?: unknown; error?: { code: number; message: string } }
function launch(args: string[]) {
 const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types", cli, ...args], { stdio: "pipe" });
 let stdout = "", stderr = "", buffer = "", sequence = 0;
 const messages: RpcResponse[] = [];
 const waiting = new Map<number, { resolve(value: RpcResponse): void; reject(error: Error): void }>();
 child.stderr.on("data", data => { stderr += String(data); });
 child.stdout.on("data", data => {
  stdout += String(data); buffer += String(data);
  for (;;) {
   const end = buffer.indexOf("\n"); if (end === -1) break;
   const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
   let message: RpcResponse;
   try { message = JSON.parse(line); } catch { throw new Error(`non-JSON protocol output: ${line}`); }
   messages.push(message);
   if (message.id !== null) { waiting.get(message.id)?.resolve(message); waiting.delete(message.id); }
  }
 });
 const done = new Promise<number | null>(resolve => child.on("close", code => {
  for (const waiter of waiting.values()) waiter.reject(new Error(`MCP exited ${code}: ${stderr}`));
  resolve(code);
 }));
 return {
  child, messages, done, output: () => ({ stdout, stderr }),
  request(method: string, params?: unknown): Promise<RpcResponse> {
   const id = ++sequence;
   return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP ${method} timed out: ${stderr}`)); }, 10000);
    waiting.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
   });
  },
  async stop() {
   if (child.exitCode !== null || child.signalCode !== null) return;
   child.stdin.end(); child.kill("SIGTERM");
   const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await done; clearTimeout(timer);
  },
 };
}
type Session = ReturnType<typeof launch>;
async function initialize(session: Session) {
 const reply = await session.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "control-process-test", version: "1" } });
 assert.equal(reply.error, undefined); session.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
}
async function tool(session: Session, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
 const reply = await session.request("tools/call", { name: `taskflow_control_${name}`, arguments: args });
 assert.equal(reply.error, undefined, JSON.stringify(reply));
 const result = reply.result as { isError?: boolean; content: { type: string; text: string }[] };
 assert.equal(result.isError, undefined, JSON.stringify(result));
 return JSON.parse(result.content[0].text);
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
 const deadline = Date.now() + 10000;
 for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error(`condition timed out: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 30)); }
}
function setup() {
 const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tf-mcp-")));
 const root = path.join(base, "project"), second = path.join(base, "other"), home = path.join(base, "home");
 fs.mkdirSync(root); fs.mkdirSync(second);
 return { base, root, second, home };
}
function scriptFlow() {
 return { name: "mcp-script", phases: [
  { id: "intermediate", type: "script", run: [process.execPath, "-e", "process.stdout.write('PRIVATE_INTERMEDIATE_MARKER')"] },
  { id: "final", type: "script", dependsOn: ["intermediate"], run: [process.execPath, "-e", "require('node:fs').writeFileSync('executed.txt','real-mcp');process.stdout.write('mcp-final')"], final: true },
 ] };
}

test("MCP owner uses authenticated real execution, closed tools, durable results and receipts", { timeout: 30000 }, async () => {
 const { base, root, home } = setup(); let session = launch(["mcp", "--root", root, "--control-home", home]);
 try {
  assert.equal((await session.request("tools/list")).error?.code, -32600);
  session.child.stdin.write("null\n{bad-json\n");
  await initialize(session);
  const listed = (await session.request("tools/list")).result as { tools: { name: string; inputSchema: { additionalProperties: boolean } }[] };
  assert.equal(listed.tools.length, 12); assert.ok(listed.tools.every(entry => entry.inputSchema.additionalProperties === false));
  for (const forged of [{ principal: "owner" }, { callerPrincipal: "owner" }, { projectRoot: root }, { permissions: ["*"] }, { authorizationContextHash: "fake" }]) {
   assert.equal((await session.request("tools/call", { name: "taskflow_control_runs", arguments: forged })).error?.code, -32602);
  }
  assert.equal((await session.request("tools/call", { name: "taskflow_control_cancel", arguments: { runId: "bad", commandId: randomUUID() } })).error?.code, -32602);
  const accepted = await tool(session, "submit", { commandId: randomUUID(), flow: scriptFlow() });
  const runId = accepted.runId as string;
  const status = await until(() => tool(session, "status", { runId }), run => run.status === "completed");
  assert.equal(status.slot, "released");
  const result = await tool(session, "result", { runId }); assert.equal(result.finalOutput, "mcp-final");
  const receipt = await tool(session, "receipt", { runId }); assert.equal(receipt.runId, runId);
  assert.ok(await tool(session, "why", { runId }));
  assert.equal(fs.readFileSync(path.join(root, "executed.txt"), "utf8"), "real-mcp");
  assert.ok(!session.output().stdout.includes("PRIVATE_INTERMEDIATE_MARKER"));
  assert.ok(session.messages.some(message => message.error?.code === -32700));
  assert.ok(session.messages.some(message => message.error?.code === -32600 && message.id === null));
  await session.stop();
  session = launch(["mcp", "--root", root, "--control-home", home]); await initialize(session);
  assert.equal((await tool(session, "status", { runId })).status, "completed");
  assert.equal((await tool(session, "result", { runId })).finalOutput, "mcp-final");
 } finally { await session.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});

test("MCP stages real approval edits and enforces changed command permission before applying them", { timeout: 30000 }, async () => {
 const { base, root, home } = setup(); const session = launch(["mcp", "--root", root, "--control-home", home]);
 const flow = { name: "mcp-edit", phases: [{ id: "approval", type: "approval", task: "Review output" }, { id: "final", type: "script", dependsOn: ["approval"], run: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "{steps.approval.output}"], final: true }] };
 try {
  await initialize(session);
  const accepted = await tool(session, "submit", { commandId: randomUUID(), flow, approvalMode: "durable-required" });
  const runId = accepted.runId;
  await until(() => tool(session, "status", { runId }), value => value.status === "paused");
  const artifact = await tool(session, "approval_stage_edit", { runId, editKind: "output", content: "edited-mcp-result" });
  assert.equal(artifact.mediaType, "text/plain; charset=utf-8");
  assert.ok(!session.output().stdout.includes("edited-mcp-result"));
  const status = await tool(session, "status", { runId });
  const approvals = await tool(session, "approvals") as unknown as { approvalRequestId: string }[];
  const decision = { runId, commandId: randomUUID(), approvalRequestId: approvals[0].approvalRequestId, expectedRunVersion: status.runVersion, decision: "edit", editKind: "output", editArtifactRef: artifact };
  const file = policyPath(home, root), policy = JSON.parse(readPrivateFile(file).toString());
  fs.writeFileSync(file, JSON.stringify({ ...policy, capabilities: policy.capabilities.filter((kind: string) => kind !== "approval.decide") }), { mode: 0o600 });
  const denied = await session.request("tools/call", { name: "taskflow_control_approval_decide", arguments: decision });
  assert.equal((denied.result as { isError: boolean }).isError, true);
  assert.equal((await tool(session, "status", { runId })).status, "paused");
  fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  await tool(session, "approval_decide", decision);
  await until(() => tool(session, "status", { runId }), value => value.status === "completed");
  assert.equal((await tool(session, "result", { runId })).finalOutput, "edited-mcp-result");
 } finally { await session.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});

test("MCP attach retains its project scope and live policy enforcement", { timeout: 30000 }, async () => {
 const { base, root, second, home } = setup();
 const owner = launch(["serve", "--root", root, "--root", second, "--control-home", home]);
 let session: Session | undefined;
 try {
  await until(async () => owner.output().stdout, value => value.includes("\n"));
  const info = JSON.parse(owner.output().stdout.split("\n")[0]) as { projects: { projectId: string; projectRoot: string }[] };
  session = launch(["mcp", "--root", root, "--control-home", home]); await initialize(session);
  const projects = await tool(session, "projects") as unknown as { projectId: string }[];
  assert.equal(projects.length, 1);
  const otherId = info.projects.find(project => project.projectId !== projects[0].projectId)!.projectId;
  const denied = await session.request("tools/call", { name: "taskflow_control_runs", arguments: { projectId: otherId } });
  assert.equal((denied.result as { isError: boolean }).isError, true);
  const accepted = await tool(session, "submit", { commandId: randomUUID(), flow: scriptFlow() });
  await until(() => tool(session!, "status", { runId: accepted.runId }), value => value.status === "completed");
  assert.equal(fs.existsSync(path.join(second, "executed.txt")), false);
  assert.equal((await tool(session, "result", { runId: accepted.runId })).finalOutput, "mcp-final");
  const policyFile = policyPath(home, root), policy = JSON.parse(readPrivateFile(policyFile).toString());
  policy.capabilities = []; fs.writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
  const revoked = await session.request("tools/call", { name: "taskflow_control_runs", arguments: {} });
  assert.equal((revoked.result as { isError: boolean }).isError, true);
  const secret = readPrivateFile(path.join(home, "bootstrap.key"));
  assert.ok(!session.output().stdout.includes(secret.toString("hex")));
  assert.ok(!session.output().stdout.includes(secret.toString("base64")));
 } finally { await session?.stop(); await owner.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});

test("MCP durable approval and cancellation are Host operations", { timeout: 30000 }, async () => {
 const { base, root, home } = setup(); const session = launch(["mcp", "--root", root, "--control-home", home]);
 const approvalFlow = { name: "mcp-approval", phases: [{ id: "approval", type: "approval", task: "Approve?" }, { id: "final", type: "script", dependsOn: ["approval"], run: [process.execPath, "-e", "process.stdout.write('approved-mcp')"], final: true }] };
 try {
  await initialize(session);
  const accepted = await tool(session, "submit", { commandId: randomUUID(), flow: approvalFlow, approvalMode: "durable-required" });
  const parked = await until(() => tool(session, "status", { runId: accepted.runId }), value => value.status === "paused");
  const approvals = await tool(session, "approvals") as unknown as { approvalRequestId: string; status: string }[];
  assert.equal(approvals.length, 1); assert.equal(approvals[0].status, "pending");
  await tool(session, "approval_decide", { commandId: randomUUID(), runId: accepted.runId, approvalRequestId: approvals[0].approvalRequestId, expectedRunVersion: parked.runVersion, decision: "approve" });
  await until(() => tool(session, "status", { runId: accepted.runId }), value => value.status === "completed");
  assert.equal((await tool(session, "result", { runId: accepted.runId })).finalOutput, "approved-mcp");
  const pending = await tool(session, "submit", { commandId: randomUUID(), flow: approvalFlow, approvalMode: "durable-required" });
  const paused = await until(() => tool(session, "status", { runId: pending.runId }), value => value.status === "paused");
  await tool(session, "cancel", { commandId: randomUUID(), runId: pending.runId, expectedRunVersion: paused.runVersion });
  const cancelled = await until(() => tool(session, "status", { runId: pending.runId }), value => value.status === "cancelled");
  assert.equal(cancelled.slot, "released");
 } finally { await session.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});
