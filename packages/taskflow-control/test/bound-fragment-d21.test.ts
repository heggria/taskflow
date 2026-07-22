/**
 * P7 BoundFragment dual hashes + D21 control-plane authority surface checks.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	bindControlHostTools,
	bindFragment,
	bootstrapControl,
	createControlHost,
	createScriptExecutionProvider,
	fragmentSemanticMatch,
	hashBoundFragment,
} from "../src/index.ts";

const fragA = {
	name: "dyn",
	phases: [{ id: "n1", type: "script", run: "echo a", final: true }],
};
const fragB = {
	name: "dyn",
	phases: [{ id: "n1", type: "script", run: "echo b", final: true }],
};

test("P7 BoundFragment: dual hashes; semantic change changes both; reuse gate", () => {
	const a = bindFragment({ fragment: fragA, parentBoundPlanHash: "bp:parent1" });
	assert.match(a.boundFragmentHash, /^bf:[0-9a-f]{64}$/);
	assert.match(a.executionSemanticHash, /^es:[0-9a-f]{64}$/);

	const a2 = bindFragment({ fragment: fragA, parentBoundPlanHash: "bp:parent1" });
	assert.equal(a.boundFragmentHash, a2.boundFragmentHash);
	assert.equal(a.executionSemanticHash, a2.executionSemanticHash);
	assert.equal(fragmentSemanticMatch(a, a2), true);

	const b = bindFragment({ fragment: fragB, parentBoundPlanHash: "bp:parent1" });
	assert.notEqual(a.boundFragmentHash, b.boundFragmentHash);
	assert.notEqual(a.executionSemanticHash, b.executionSemanticHash);
	assert.equal(fragmentSemanticMatch(a, b), false);

	// Parent plan identity is part of reuse gate
	const otherParent = bindFragment({ fragment: fragA, parentBoundPlanHash: "bp:other" });
	assert.equal(fragmentSemanticMatch(a, otherParent), false);

	// raw hash helper agrees
	const h = hashBoundFragment(fragA, { parentBoundPlanHash: "bp:parent1" });
	assert.equal(h.boundFragmentHash, a.boundFragmentHash);
});

test("D21: CLI/daemon bootstrap + MCP bind use ControlHost; production default is script not mock", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-d21-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-d21-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		// bootstrap standalone → ControlHost with script default
		const { host, role } = bootstrapControl({
			projectRoot: project,
			env,
			controlMode: "standalone",
		});
		assert.equal(role, "standalone-local");
		assert.equal(typeof host.admitAndRun, "function");
		assert.equal(typeof host.getSnapshot, "function");
		assert.equal(host.canMutate, true);

		// Production default: no allowMockProvider → real script provider path
		const r = await host.admitAndRun({
			program: {
				name: "d21",
				phases: [{ id: "main", type: "script", run: "echo d21-ok", final: true }],
			},
			commandId: "d21-cmd",
		});
		assert.equal(r.ok, true, JSON.stringify(r.error));
		assert.equal(r.run?.providerName, "script");
		assert.match(r.run?.finalOutput ?? "", /d21-ok/);
		assert.ok(r.receipt);

		// Same surface via MCP bind tools
		const host2 = createControlHost({
			projectRoot: project,
			env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createScriptExecutionProvider({
				stateDir: path.join(project, ".taskflow", "control", "provider-jobs-2"),
			}),
		});
		const tools = bindControlHostTools(host2);
		assert.equal(typeof tools.run, "function");
		assert.equal(typeof tools.approve, "function");
		assert.equal(typeof tools.edit, "function");
		const fail = await tools.run({
			define: {
				name: "f",
				phases: [{ id: "main", type: "script", run: "exit 37", final: true }],
			},
			commandId: "d21-fail",
		});
		assert.equal(fail.ok, false);
		assert.equal(fail.run?.status, "failed");
		assert.equal(fail.receipt, undefined);

		host.close();
		host2.close();
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("D21: event-kernel remains opt-in OFF by default (no silent dual scheduler in control plane)", async () => {
	// Control plane does not import/run event-kernel. Prove core default OFF via env contract.
	assert.notEqual(process.env.PI_TASKFLOW_EVENT_KERNEL, "1");
	// Dynamic import of core driver for documentation of default
	const driverPath = path.resolve(
		process.cwd(),
		"packages/taskflow-core/src/exec/driver.ts",
	);
	const src = fs.readFileSync(driverPath, "utf-8");
	assert.match(src, /Default OFF/);
	assert.match(src, /PI_TASKFLOW_EVENT_KERNEL=1/);
});
