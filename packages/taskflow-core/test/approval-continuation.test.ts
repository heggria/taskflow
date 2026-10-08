import test from "node:test";
import assert from "node:assert/strict";
import { executeTaskflow } from "../src/runtime.ts";
import type { RunState } from "../src/store.ts";

test("exact approval continuation preserves a gate that blocked while another branch waited", async () => {
 const state: RunState = { runId: "checkpoint", flowName: "blocked-checkpoint", def: { name: "blocked-checkpoint", phases: [
  { id: "gate", type: "approval", task: "First independent gate" },
  { id: "waiting", type: "approval", task: "Second independent gate" },
  { id: "effect", type: "script", dependsOn: ["waiting"], run: "exit 77" },
 ] }, args: {}, cwd: process.cwd(), status: "running", createdAt: 1, updatedAt: 1,
 foregroundOwner: { version: 1, pid: process.pid, instanceId: "verified-host", startedAt: 1, approvalWait: ["waiting"] },
 phases: { gate: { id: "gate", status: "done", gate: { verdict: "block", reason: "Already rejected" }, output: "Blocked output" }, waiting: { id: "waiting", status: "running" } } };
 const result = await executeTaskflow(state, { cwd: process.cwd(), agents: [], _disableCache: true,
  _approvalCheckpointContinuation: { runId: state.runId }, requestApproval: async () => { throw new Error("blocked approval must not run again"); } });
 assert.equal(result.state.status, "blocked");
 assert.equal(result.state.phases.effect?.status, "skipped");
 assert.match(result.finalOutput, /Already rejected[\s\S]*Blocked output/);
});

test("exact continuation rejects a marker that leaves independent work runnable", async () => {
 const state: RunState = { runId: "unsafe", flowName: "unsafe", def: { name: "unsafe", phases: [
  { id: "waiting", type: "approval", task: "Wait" }, { id: "effect", type: "script", run: "exit 77" },
 ] }, args: {}, cwd: process.cwd(), status: "running", createdAt: 1, updatedAt: 1,
 foregroundOwner: { version: 1, pid: process.pid, instanceId: "host", startedAt: 1, approvalWait: ["waiting"] },
 phases: { waiting: { id: "waiting", status: "running" } } };
 await assert.rejects(executeTaskflow(state, { cwd: process.cwd(), agents: [], _approvalCheckpointContinuation: { runId: state.runId } }), /quiescent checkpoint/);
});
