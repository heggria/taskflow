import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	drainPendingSpawns,
	initCtxDir,
	MAX_SUBFLOW_BYTES,
	queueSpawn,
} from "../src/context-store.ts";

async function tmpCtx(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "spawn-xor-"));
	return initCtxDir(dir);
}

test("spawn-xor: a pure subflow assignment (no task) is accepted", async () => {
	const ctx = await tmpCtx();
	const n = queueSpawn(ctx, "parent", [
		{ subflow: { phases: [{ id: "a", type: "agent", agent: "scout", task: "do x" }] } },
	]);
	assert.equal(n, 1);
	const drained = drainPendingSpawns(ctx, "parent");
	assert.equal(drained.length, 1);
	assert.ok(drained[0].subflow, "subflow preserved through queue+drain");
	assert.equal(drained[0].task, undefined, "no synthetic task added");
});

test("spawn-xor: flat task still works (backward compat)", async () => {
	const ctx = await tmpCtx();
	queueSpawn(ctx, "p", [{ task: "flat", agent: "analyst" }]);
	const d = drainPendingSpawns(ctx, "p");
	assert.equal(d[0].task, "flat");
	assert.equal(d[0].agent, "analyst");
	assert.equal(d[0].subflow, undefined);
});

test("spawn-xor: assignment with BOTH task and subflow is rejected", async () => {
	const ctx = await tmpCtx();
	assert.throws(
		() => queueSpawn(ctx, "p", [{ task: "t", subflow: { phases: [] } }]),
		/both 'task' and 'subflow'/,
	);
});

test("spawn-xor: assignment with NEITHER task nor subflow is rejected", async () => {
	const ctx = await tmpCtx();
	assert.throws(() => queueSpawn(ctx, "p", [{ agent: "scout" }]), /exactly one of 'task'/);
	assert.throws(() => queueSpawn(ctx, "p", [{ task: "  " }]), /exactly one of 'task'/);
});

test("spawn-xor: non-object assignment is rejected", async () => {
	const ctx = await tmpCtx();
	// @ts-expect-error deliberately wrong shape
	assert.throws(() => queueSpawn(ctx, "p", ["just a string"]), /must be an object/);
});

test("spawn-xor: oversized subflow is rejected", async () => {
	const ctx = await tmpCtx();
	const huge = { phases: [{ id: "a", type: "agent", task: "x".repeat(MAX_SUBFLOW_BYTES + 1) }] };
	assert.throws(() => queueSpawn(ctx, "p", [{ subflow: huge }]), /subflow exceeds/);
});

test("spawn-xor: defaultAgent is preserved, agent is ignored on subflow", async () => {
	const ctx = await tmpCtx();
	queueSpawn(ctx, "p", [{ subflow: { phases: [{ id: "a", type: "agent", task: "x" }] }, defaultAgent: "scout" }]);
	const d = drainPendingSpawns(ctx, "p");
	assert.equal(d[0].defaultAgent, "scout");
	assert.equal(d[0].agent, undefined);
});

test("spawn-xor: mixed batch of flat + subflow assignments", async () => {
	const ctx = await tmpCtx();
	const n = queueSpawn(ctx, "p", [
		{ task: "flat one" },
		{ subflow: { phases: [{ id: "a", type: "agent", task: "y" }] }, defaultAgent: "analyst" },
	]);
	assert.equal(n, 2);
	const d = drainPendingSpawns(ctx, "p");
	assert.equal(d.length, 2);
	assert.equal(d[0].task, "flat one");
	assert.ok(d[1].subflow);
});
