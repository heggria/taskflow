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

test("retention: cleanup throttling is isolated per project", async () => {
	const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-retention-root-a-"));
	const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-retention-root-b-"));
	fs.mkdirSync(path.join(cwdA, ".pi"));
	fs.mkdirSync(path.join(cwdB, ".pi"));
	try {
		const seed = await import(`../src/store.ts?retention-roots-seed=${Date.now()}`) as typeof import("../src/store.ts");
		for (const cwd of [cwdA, cwdB]) {
			seed.saveRun(state(cwd, "old-a", "completed"), { maxKeep: 0, maxAgeDays: 0 });
			seed.saveRun(state(cwd, "old-b", "failed"), { maxKeep: 0, maxAgeDays: 0 });
		}

		const cleanup = await import(`../src/store.ts?retention-roots-cleanup=${Date.now()}`) as typeof import("../src/store.ts");
		cleanup.saveRun(state(cwdA, "active-a", "running"), { maxKeep: 1, maxAgeDays: 0 });
		cleanup.saveRun(state(cwdB, "active-b", "running"), { maxKeep: 1, maxAgeDays: 0 });

		for (const cwd of [cwdA, cwdB]) {
			assert.equal(
				cleanup.listRuns(cwd, 20).filter((run) => run.status !== "running").length,
				1,
				"one busy project must not suppress another project's retention pass",
			);
		}
	} finally {
		fs.rmSync(cwdA, { recursive: true, force: true });
		fs.rmSync(cwdB, { recursive: true, force: true });
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

test("retention: cleanup does not follow a flow-directory symlink outside the runs root", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-retention-dir-symlink-"));
	fs.mkdirSync(path.join(cwd, ".pi"));
	try {
		const store = await import(`../src/store.ts?retention-dir-symlink=${Date.now()}`) as typeof import("../src/store.ts");
		const root = store.runsDir(cwd);
		const externalDir = path.join(cwd, "external-runs");
		fs.mkdirSync(root, { recursive: true });
		fs.mkdirSync(externalDir);

		const victim = state(cwd, "victim", "failed");
		victim.updatedAt = 1;
		const victimPath = path.join(externalDir, "victim.json");
		fs.writeFileSync(victimPath, JSON.stringify(victim));
		try {
			fs.symlinkSync(externalDir, path.join(root, "retention"));
		} catch (error) {
			t.skip(`symlink unavailable: ${String(error)}`);
			return;
		}
		fs.writeFileSync(
			path.join(root, "index.json"),
			JSON.stringify([store.extractIndexEntry(victim, "retention/victim.json")]),
		);

		const trigger = state(cwd, "trigger", "running");
		trigger.flowName = "retention-trigger";
		trigger.def = { ...flow, name: "retention-trigger" };
		store.saveRun(trigger, { maxKeep: 1, maxAgeDays: 1 });

		assert.equal(fs.readFileSync(victimPath, "utf-8"), JSON.stringify(victim));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("retention: cleanup does not follow context artifact symlinks", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-retention-artifact-symlink-"));
	fs.mkdirSync(path.join(cwd, ".pi"));
	try {
		const store = await import(`../src/store.ts?retention-artifact-symlink=${Date.now()}`) as typeof import("../src/store.ts");
		store.saveRun(state(cwd, "victim", "failed"), { maxKeep: 0, maxAgeDays: 0 });
		const root = store.runsDir(cwd);
		const indexFile = path.join(root, "index.json");
		const entries = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as Array<{
			runId: string;
			updatedAt: number;
			relPath: string;
		}>;
		const entry = entries.find((candidate) => candidate.runId === "victim");
		assert.ok(entry);
		const runFile = path.join(root, ...entry.relPath.split("/"));
		const persisted = JSON.parse(fs.readFileSync(runFile, "utf-8")) as RunState;
		persisted.updatedAt = 1;
		entry.updatedAt = 1;
		fs.writeFileSync(runFile, JSON.stringify(persisted));
		fs.writeFileSync(indexFile, JSON.stringify(entries));

		const externalCtx = path.join(cwd, "external-ctx");
		const externalRun = path.join(externalCtx, "victim");
		fs.mkdirSync(externalRun, { recursive: true });
		const sentinel = path.join(externalRun, "sentinel.txt");
		fs.writeFileSync(sentinel, "keep");
		try {
			fs.symlinkSync(externalCtx, path.join(root, "ctx"));
		} catch (error) {
			t.skip(`symlink unavailable: ${String(error)}`);
			return;
		}

		const cleanup = await import(`../src/store.ts?retention-artifact-cleanup=${Date.now()}`) as typeof import("../src/store.ts");
		cleanup.saveRun(state(cwd, "trigger", "running"), { maxKeep: 1, maxAgeDays: 1 });

		assert.equal(fs.readFileSync(sentinel, "utf-8"), "keep");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("retention: forged run cwd cannot remove another project's control records", async () => {
	const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-retention-control-a-"));
	const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-retention-control-b-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-retention-agent-"));
	const previousAgentDir = process.env.TASKFLOW_AGENT_DIR;
	process.env.TASKFLOW_AGENT_DIR = agentDir;
	fs.mkdirSync(path.join(cwdA, ".pi"));
	fs.mkdirSync(path.join(cwdB, ".pi"));
	try {
		const suffix = Date.now();
		const store = await import(`../src/store.ts?retention-control=${suffix}`) as typeof import("../src/store.ts");
		const control = await import(`../src/detached-control.ts?retention-control=${suffix}`) as typeof import("../src/detached-control.ts");
		const root = store.runsDir(cwdA);
		const flowDir = path.join(root, "retention");
		fs.mkdirSync(flowDir, { recursive: true });

		const forged = state(cwdB, "victim", "failed");
		forged.updatedAt = 1;
		fs.writeFileSync(path.join(flowDir, "victim.json"), JSON.stringify(forged));
		fs.writeFileSync(
			path.join(root, "index.json"),
			JSON.stringify([store.extractIndexEntry(forged, "retention/victim.json")]),
		);
		control.requestDetachedCancel(cwdB, "victim", "belongs to project B");
		const marker = control.detachedCancelRequestPath(cwdB, "victim");
		assert.ok(fs.existsSync(marker));

		store.saveRun(state(cwdA, "trigger", "running"), { maxKeep: 1, maxAgeDays: 1 });

		assert.ok(fs.existsSync(marker), "project A retention must not mutate project B's control plane");
	} finally {
		if (previousAgentDir === undefined) delete process.env.TASKFLOW_AGENT_DIR;
		else process.env.TASKFLOW_AGENT_DIR = previousAgentDir;
		fs.rmSync(cwdA, { recursive: true, force: true });
		fs.rmSync(cwdB, { recursive: true, force: true });
		fs.rmSync(agentDir, { recursive: true, force: true });
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
