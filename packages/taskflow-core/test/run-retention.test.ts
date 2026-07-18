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

test("retention: a crafted index path cannot delete outside the runs root", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-retention-path-"));
	fs.mkdirSync(path.join(cwd, ".pi"));
	try {
		const seed = await import(`../src/store.ts?retention-path-seed=${Date.now()}`) as typeof import("../src/store.ts");
		const root = seed.runsDir(cwd);
		fs.mkdirSync(root, { recursive: true });

		const sentinel = path.join(cwd, ".pi", "sentinel");
		fs.writeFileSync(sentinel, "do not delete");
		fs.utimesSync(sentinel, new Date(1_000), new Date(1_000));
		const malicious = {
			...seed.extractIndexEntry(state(cwd, "escape", "failed"), "../../sentinel"),
			updatedAt: 1,
		};
		fs.writeFileSync(path.join(root, "index.json"), JSON.stringify([malicious]));

		const cleanup = await import(`../src/store.ts?retention-path-cleanup=${Date.now()}`) as typeof import("../src/store.ts");
		cleanup.saveRun(state(cwd, "trigger", "running"), { maxKeep: 1, maxAgeDays: 1 });

		assert.equal(fs.readFileSync(sentinel, "utf-8"), "do not delete");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("retention: cleanup rechecks a candidate under its run lock", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-retention-race-"));
	fs.mkdirSync(path.join(cwd, ".pi"));
	try {
		const seed = await import(`../src/store.ts?retention-race-seed=${Date.now()}`) as typeof import("../src/store.ts");
		seed.saveRun(state(cwd, "resumed", "failed"), { maxKeep: 0, maxAgeDays: 0 });
		const root = seed.runsDir(cwd);
		const indexFile = path.join(root, "index.json");
		const entries = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as Array<{
			runId: string;
			status: RunState["status"];
			updatedAt: number;
			relPath: string;
		}>;
		const candidate = entries.find((entry) => entry.runId === "resumed");
		assert.ok(candidate);

		const runFile = path.join(root, ...candidate.relPath.split("/"));
		const resumed = JSON.parse(fs.readFileSync(runFile, "utf-8")) as RunState;
		resumed.status = "running";
		resumed.updatedAt = Date.now() + 10_000;
		fs.writeFileSync(runFile, JSON.stringify(resumed));
		// Make the old mtime-only guard select this file, proving that snapshot
		// identity rather than timestamp heuristics protects the resumed run.
		fs.utimesSync(runFile, new Date(1_000), new Date(1_000));
		candidate.status = "failed";
		candidate.updatedAt = 1;
		fs.writeFileSync(indexFile, JSON.stringify(entries));

		const cleanup = await import(`../src/store.ts?retention-race-cleanup=${Date.now()}`) as typeof import("../src/store.ts");
		cleanup.saveRun(state(cwd, "trigger", "running"), { maxKeep: 1, maxAgeDays: 1 });

		assert.equal(cleanup.loadRun(cwd, "resumed")?.status, "running");
		assert.ok(cleanup.listRuns(cwd, 20).some((run) => run.runId === "resumed" && run.status === "running"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("run index: list does not follow a run-file symlink outside the runs root", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-index-symlink-"));
	fs.mkdirSync(path.join(cwd, ".pi"));
	try {
		const store = await import(`../src/store.ts?retention-symlink=${Date.now()}`) as typeof import("../src/store.ts");
		const root = store.runsDir(cwd);
		const flowDir = path.join(root, "retention");
		fs.mkdirSync(flowDir, { recursive: true });

		const externalState = state(cwd, "symlinked", "completed");
		externalState.updatedAt += 10_000;
		const validState = state(cwd, "valid", "completed");
		const externalFile = path.join(cwd, "outside-run.json");
		fs.writeFileSync(externalFile, JSON.stringify(externalState));
		fs.writeFileSync(path.join(flowDir, "valid.json"), JSON.stringify(validState));
		try {
			fs.symlinkSync(externalFile, path.join(flowDir, "symlinked.json"));
		} catch (error) {
			t.skip(`symlink unavailable: ${String(error)}`);
			return;
		}
		fs.writeFileSync(
			path.join(root, "index.json"),
			JSON.stringify([
				store.extractIndexEntry(externalState, "retention/symlinked.json"),
				store.extractIndexEntry(validState, "retention/valid.json"),
			]),
		);

		assert.deepEqual(store.listRuns(cwd, 1).map((run) => run.runId), ["valid"]);
		assert.equal(store.loadRun(cwd, "symlinked"), null);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
