/**
 * Dual-client approval CAS (P15): expectedRunVersion first-commit-wins.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createControlHost,
	createMockExecutionProvider,
} from "../src/index.ts";

const SCRIPT_FLOW = {
	name: "cas-flow",
	phases: [{ id: "main", type: "script", run: "true", final: true }],
};

function temp(): { env: NodeJS.ProcessEnv; project: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cas-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cas-proj-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

test("dual-client approval CAS: stale expectedRunVersion loses", async () => {
	const t = temp();
	try {
		const provider = createMockExecutionProvider({ outcome: "hang" });
		// Two ControlHosts share the same project store (dual client).
		const a = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const b = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider,
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});

		const admitted = await a.admitAndRun({ program: SCRIPT_FLOW, commandId: "cas-1" });
		const runId = admitted.run!.runId;
		provider.quiesceAll?.();

		// Client A parks with current version
		const snap = a.getSnapshot(runId)!;
		const v0 = snap.run.runVersion;
		const parked = await a.parkForApproval(runId, { expectedRunVersion: v0 });
		assert.equal(parked.ok, true, JSON.stringify(parked.error));
		const vParked = parked.run!.runVersion;
		assert.ok(vParked > v0);

		// Client B still has stale version → approve must CAS-fail
		const stale = await b.approve(runId, { expectedRunVersion: v0 });
		assert.equal(stale.ok, false);
		assert.equal(stale.error?.code, "TF_STALE_VERSION");

		// Fresh version wins
		const fresh = await b.approve(runId, { expectedRunVersion: vParked });
		assert.equal(fresh.ok, true, JSON.stringify(fresh.error));
		assert.equal(fresh.run?.status, "completed");
		assert.ok(fresh.receipt);

		// Third approve with old parked version fails (already terminal)
		const again = await a.approve(runId, { expectedRunVersion: vParked });
		assert.equal(again.ok, false);
		assert.ok(
			again.error?.code === "TF_STALE_VERSION" || again.error?.code === "TF_INVALID_ARGUMENT",
		);

		a.close();
		b.close();
	} finally {
		t.cleanup();
	}
});

test("cancel CAS: stale version rejected", async () => {
	const t = temp();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createMockExecutionProvider({ outcome: "hang" }),
			reconcileBudget: { maxAttempts: 1, deadlineMs: 5 },
		});
		const r = await host.admitAndRun({ program: SCRIPT_FLOW });
		const runId = r.run!.runId;
		const v = r.run!.runVersion;
		const bad = await host.cancel(runId, { expectedRunVersion: v - 1 });
		assert.equal(bad.ok, false);
		assert.equal(bad.error?.code, "TF_STALE_VERSION");
		const ok = await host.cancel(runId, { expectedRunVersion: host.getSnapshot(runId)!.run.runVersion });
		assert.equal(ok.ok, true);
		assert.equal(ok.run?.status, "cancelled");
		host.close();
	} finally {
		t.cleanup();
	}
});
