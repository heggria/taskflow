/**
 * E2E smoke test for the backward-compatible cross-run cache key (H1 M3).
 *
 * Proves the migration contract end-to-end through the REAL runtime + REAL
 * on-disk CacheStore (mock runner — no live `pi` or model access needed):
 *   - an identical re-run is free ($0.00): the v2 key written by run 1 hits in run 2
 *   - a pre-seeded LEGACY entry (no-flowdef) still hits via the read-only fallback
 *   - a pre-seeded BARE entry (unversioned flowdef) still hits via the 3rd-tier fallback
 *   - a legacy hit does NOT write-through under the v2 key (cache size stable)
 *
 * Run:  node --experimental-strip-types test/e2e-cache-migration.mts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "taskflow-core";
import { CacheStore } from "taskflow-core";
import { cacheKeys, executeTaskflow, type PhaseCacheCtx, type RuntimeDeps } from "taskflow-core";
import type { RunResult, RunOptions } from "../src/runner.ts";
import { compileTaskflowToIR } from "../extensions/flowir/index.ts";
import type { Taskflow } from "taskflow-core";
import type { RunState } from "taskflow-core";
import { emptyUsage } from "taskflow-core";

const C = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
	bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
	hl: (s: string) => `\x1b[36m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

let failures = 0;
const assert = (cond: boolean, msg: string) => {
	if (cond) console.log(`  ${C.ok("✓")} ${msg}`);
	else {
		console.log(`  ${C.bad("✗")} ${msg}`);
		failures++;
	}
};

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-cache-mig-"));
}

function mkState(def: Taskflow, cwd: string): RunState {
	return {
		runId: `run-${Math.random().toString(36).slice(2, 8)}`,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

function countingRunner(counter: { n: number }): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		counter.n++;
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: `out:${task}#${counter.n}`,
			stderr: "",
			usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
			stopReason: "end",
		};
	};
}

async function ccFor(def: Taskflow, cwd: string, store: CacheStore, phaseId: string): Promise<PhaseCacheCtx> {
	const ir = await compileTaskflowToIR(def);
	return {
		scope: "cross-run",
		fingerprint: "",
		store,
		prior: undefined,
		phaseId,
		flowName: def.name,
		runId: "seed",
		flowDefHash: ir.hash,
	};
}

async function main() {
	const def: Taskflow = {
		name: "e2e-mig",
		phases: [{ id: "p", type: "agent", agent: "a", task: "fixed", cache: { scope: "cross-run" }, final: true }],
	};

	console.log(C.bold("\nCache Migration E2E\n"));

	// --- 1. identical re-run is free ---
	console.log(C.hl("▸ identical re-run is free ($0.00)"));
	{
		const dir = tmpDir();
		const counter = { n: 0 };
		const store = new CacheStore(dir);
		const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };
		await executeTaskflow(mkState(def, dir), deps);
		const r2 = await executeTaskflow(mkState(def, dir), deps);
		assert(counter.n === 1, `run 1 executes once (${counter.n}=1), run 2 free → ${counter.n}`);
		assert(r2.state.phases.p.cacheHit === "cross-run", "run 2 phase p is a cross-run cache hit");
		fs.rmSync(dir, { recursive: true, force: true });
	}
	console.log();

	// --- 2. legacy (no-flowdef) entry hits via fallback ---
	console.log(C.hl("▸ legacy (no-flowdef) entry hits via read-only fallback"));
	{
		const dir = tmpDir();
		const store = new CacheStore(dir);
		const cc = await ccFor(def, dir, store, "p");
		const ck = cacheKeys(cc, ["p", "a", "", "fixed"]);
		store.put({ key: ck.legacyKey, createdAt: Date.now(), output: "LEGACY", state: undefined });
		const counter = { n: 0 };
		const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };
		const r = await executeTaskflow(mkState(def, dir), deps);
		assert(counter.n === 0, "legacy entry hit — no execution");
		assert(r.state.phases.p.output === "LEGACY", "served the legacy entry's output");
		assert(store.get(ck.key) === null, "no v2 write-through (legacy left to age out)");
		fs.rmSync(dir, { recursive: true, force: true });
	}
	console.log();

	// --- 3. bare (unversioned flowdef) entry hits via 3rd-tier fallback ---
	console.log(C.hl("▸ bare (unversioned flowdef) entry hits via 3rd-tier fallback"));
	{
		const dir = tmpDir();
		const store = new CacheStore(dir);
		const cc = await ccFor(def, dir, store, "p");
		const ck = cacheKeys(cc, ["p", "a", "", "fixed"]);
		store.put({ key: ck.bareKey, createdAt: Date.now(), output: "BARE", state: undefined });
		const counter = { n: 0 };
		const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };
		const r = await executeTaskflow(mkState(def, dir), deps);
		assert(counter.n === 0, "bare entry hit via 3rd-tier fallback — no execution");
		assert(r.state.phases.p.output === "BARE", "served the bare entry's output");
		fs.rmSync(dir, { recursive: true, force: true });
	}
	console.log();

	if (failures === 0) {
		console.log(C.ok(C.bold("All Cache Migration E2E checks passed.")));
	} else {
		console.log(C.bad(C.bold(`${failures} Cache Migration E2E check(s) FAILED.`)));
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(C.bad(`E2E crashed: ${e instanceof Error ? e.stack : String(e)}`));
	process.exit(1);
});
