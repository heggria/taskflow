import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { RunState, Taskflow } from "../src/index.ts";

const flow: Taskflow = {
	name: "retention",
	phases: [{ id: "done", type: "script", run: "true", final: true }],
};

function state(cwd: string, runId: string, status: RunState["status"]): RunState {
	const now = Date.now();
	return {
		runId,
		flowName: flow.name,
		def: flow,
		args: {},
		status,
		phases: {},
		createdAt: now,
		updatedAt: now,
		cwd,
	};
}

test("retention: paused and blocked history is bounded while running work is preserved", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-retention-"));
	fs.mkdirSync(path.join(cwd, ".pi"));
	try {
		// Query-bearing imports create isolated module instances so the internal
		// cleanup throttle can be deterministically exercised without a sleep.
		const seed = await import(`../src/store.ts?retention-seed=${Date.now()}`) as typeof import("../src/store.ts");
		for (const [runId, status] of [
			["paused-a", "paused"],
			["paused-b", "paused"],
			["blocked-a", "blocked"],
			["blocked-b", "blocked"],
		] as const) {
			seed.saveRun(state(cwd, runId, status), { maxKeep: 0, maxAgeDays: 0 });
		}

		const cleanup = await import(`../src/store.ts?retention-cleanup=${Date.now()}`) as typeof import("../src/store.ts");
		cleanup.saveRun(state(cwd, "active", "running"), { maxKeep: 1, maxAgeDays: 0 });

		const runs = cleanup.listRuns(cwd, 20);
		assert.equal(runs.filter((run) => run.status !== "running").length, 1);
		assert.ok(runs.some((run) => run.runId === "active" && run.status === "running"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
