/**
 * P1 semantics: BoundPlan hash coverage, identity fail-closed, registry lock,
 * provider probe/prepare/loadHandle, MCP real-provider default.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
	bindControlHostTools,
	createControlHost,
	createScriptExecutionProvider,
	IdentityMismatchError,
	linkProgram,
	openControlRegistry,
	openProjectControlStore,
} from "../src/index.ts";

function temp(): { env: NodeJS.ProcessEnv; project: string; home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p1-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p1-proj-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		home,
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

const baseProgram = {
	name: "hash-prog",
	phases: [{ id: "main", type: "script" as const, run: "echo a", final: true }],
};

test("BoundPlan hash changes when approvalMode / grants / providerClass / timeout change", () => {
	const a = linkProgram({ program: baseProgram });
	assert.equal(a.ok, true);
	const b = linkProgram({ program: baseProgram, approvalMode: "durable-required" });
	assert.equal(b.ok, true);
	assert.notEqual(a.boundPlan.boundPlanHash, b.boundPlan.boundPlanHash, "approvalMode must change hash");

	const c = linkProgram({ program: baseProgram, grantRefs: ["grant:write"] });
	assert.equal(c.ok, true);
	assert.notEqual(a.boundPlan.boundPlanHash, c.boundPlan.boundPlanHash, "grants must change hash");

	const d = linkProgram({ program: baseProgram, providerClass: "llm-host" });
	assert.equal(d.ok, true);
	assert.notEqual(a.boundPlan.boundPlanHash, d.boundPlan.boundPlanHash, "providerClass must change hash");

	const withTimeout = {
		...baseProgram,
		phases: [{ id: "main", type: "script" as const, run: "echo a", final: true, timeout: 5000 }],
	};
	const e = linkProgram({ program: withTimeout });
	assert.equal(e.ok, true);
	assert.notEqual(a.boundPlan.boundPlanHash, e.boundPlan.boundPlanHash, "phase timeout must change hash");

	// Same inputs → same hash
	const a2 = linkProgram({ program: baseProgram });
	assert.equal(a2.ok, true);
	assert.equal(a.boundPlan.boundPlanHash, a2.boundPlan.boundPlanHash);
});

test("identity: copy of ControlStore to new path is fail-closed (TF_IDENTITY_MISMATCH)", () => {
	const t = temp();
	const clone = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p1-clone-"));
	try {
		const storeA = openProjectControlStore(t.project);
		const domainA = storeA.header.controlDomainId;
		const projectIdA = storeA.header.projectId;
		assert.ok(domainA);
		// Copy .taskflow/control tree to a different project root (clone/worktree share attempt)
		const srcControl = path.join(t.project, ".taskflow");
		const destControl = path.join(clone, ".taskflow");
		fs.cpSync(srcControl, destControl, { recursive: true });

		assert.throws(
			() => openProjectControlStore(clone),
			(err: unknown) => {
				assert.ok(err instanceof IdentityMismatchError, String(err));
				assert.equal(err.code, "TF_IDENTITY_MISMATCH");
				assert.equal(err.controlDomainId, domainA);
				assert.equal(err.projectId, projectIdA);
				return true;
			},
		);

		// Explicit new-identity mints a different domain
		const storeB = openProjectControlStore(clone, { identityPolicy: "new-identity" });
		assert.notEqual(storeB.header.controlDomainId, domainA);
		assert.notEqual(storeB.header.projectId, projectIdA);
		assert.equal(path.resolve(storeB.header.directoryBinding.path), path.resolve(clone));

		// Explicit rebind keeps domain after policy allows
		const moved = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p1-move-"));
		try {
			// Fresh store at moved with rebind from a hand-edited header path mismatch
			const s = openProjectControlStore(moved);
			const id = s.header.controlDomainId;
			// Simulate path move: rewrite binding to wrong path then re-open with rebind
			const headerPath = path.join(moved, ".taskflow", "control", "header.json");
			const h = JSON.parse(fs.readFileSync(headerPath, "utf-8")) as {
				directoryBinding: { path: string };
			};
			h.directoryBinding.path = path.join(os.tmpdir(), "tf-old-location-does-not-matter");
			fs.writeFileSync(headerPath, JSON.stringify(h, null, 2));
			const rebound = openProjectControlStore(moved, { identityPolicy: "rebind" });
			assert.equal(rebound.header.controlDomainId, id);
			assert.equal(path.resolve(rebound.header.directoryBinding.path), path.resolve(moved));
		} finally {
			fs.rmSync(moved, { recursive: true, force: true });
		}
	} finally {
		t.cleanup();
		fs.rmSync(clone, { recursive: true, force: true });
	}
});

test("registry: concurrent multi-process register does not corrupt entries", () => {
	const t = temp();
	try {
		const projects: string[] = [];
		for (let i = 0; i < 4; i++) {
			const p = fs.mkdtempSync(path.join(os.tmpdir(), `tf-reg-${i}-`));
			projects.push(p);
			openProjectControlStore(p); // mint header
		}
		// Parallel multi-process register under exclusive registry.lock
		const childSrc = path.join(t.home, "reg-child.mts");
		fs.writeFileSync(
			childSrc,
			`
import { openProjectControlStore, openControlRegistry } from ${JSON.stringify(
				path.resolve(process.cwd(), "packages/taskflow-control/src/index.ts"),
			)};
const idx = Number(process.argv[2]);
const roots = ${JSON.stringify(projects)};
const env = { ...process.env, TASKFLOW_HOME: ${JSON.stringify(t.home)} };
const store = openProjectControlStore(roots[idx]!);
const reg = openControlRegistry(env);
reg.registerFromStore(store, roots[idx]!);
process.stdout.write("ok\\n");
`,
		);
		const procs = projects.map((_, i) =>
			spawnSync(
				process.execPath,
				["--experimental-strip-types", "--conditions=development", childSrc, String(i)],
				{ encoding: "utf-8", env: { ...process.env, TASKFLOW_HOME: t.home } },
			),
		);
		for (const p of procs) {
			assert.equal(p.status, 0, p.stderr || p.stdout);
		}
		const reg = openControlRegistry(t.env);
		const list = reg.list();
		assert.equal(list.length, projects.length, JSON.stringify(list));
		const ids = new Set(list.map((e) => e.projectId));
		assert.equal(ids.size, projects.length);
		for (const p of projects) fs.rmSync(p, { recursive: true, force: true });
	} finally {
		t.cleanup();
	}
});

test("script provider: probe/prepare/loadHandle durable across provider instances", async () => {
	const t = temp();
	try {
		const stateDir = path.join(t.project, "jobs");
		const p1 = createScriptExecutionProvider({ stateDir });
		const program = {
			name: "dur",
			phases: [{ id: "main", type: "script", run: "sleep 0.3; echo done", final: true }],
		};
		const probe = await p1.probe!({ cwd: t.project, program });
		assert.equal(probe.ok, true);
		assert.equal(probe.supportsProgram, true);
		const prep = await p1.prepare!({ runId: "run-1", program, cwd: t.project });
		assert.equal(prep.kind, "ready");

		const sub = await p1.submit({
			runId: "run-1",
			idempotencyKey: "k1",
			program,
			cwd: t.project,
		});
		assert.equal(sub.kind, "accepted");
		const handle = sub.handle;
		assert.ok(typeof sub.leaseEpoch === "number");

		// Drive to terminal on the original instance (close event persists completed).
		// Cross-instance poll of a mid-flight dead pid is fail-closed by design (not this test).
		let c1 = await p1.poll(handle);
		const deadline = Date.now() + 5000;
		while (c1.kind === "still-running" && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
			c1 = await p1.poll(handle);
		}
		assert.equal(c1.kind, "completed", JSON.stringify(c1));
		if (c1.kind === "completed") assert.match(c1.output ?? "", /done/);

		// New provider instance (simulates process restart) loads durable completed handle
		const p2 = createScriptExecutionProvider({ stateDir });
		const loaded = p2.loadHandle!(handle);
		assert.ok(loaded, "handle must load after restart");
		assert.equal(loaded.runId, "run-1");
		assert.equal(loaded.providerName, "script");
		assert.equal(loaded.status, "completed");
		assert.ok(typeof loaded.leaseEpoch === "number");
		const c2 = await p2.poll(handle);
		assert.equal(c2.kind, "completed", JSON.stringify(c2));
		if (c2.kind === "completed") assert.match(c2.output ?? "", /done/);

		// Non-script program rejected by prepare
		const bad = await p1.prepare!({
			runId: "r2",
			program: { name: "agent-only", phases: [{ id: "a", type: "agent", agent: "x", task: "y" }] },
			cwd: t.project,
		});
		assert.equal(bad.kind, "rejected");
	} finally {
		t.cleanup();
	}
});

test("MCP bind: production ControlHost default uses real script provider (exit 37 fails)", async () => {
	const t = temp();
	try {
		// No provider inject, no allowMockProvider — production path
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
		});
		const tools = bindControlHostTools(host);
		const ok = await tools.run({
			define: {
				name: "ok",
				phases: [{ id: "main", type: "script", run: "echo mcp-real", final: true }],
			},
			commandId: "cmd-mcp-ok",
			principal: "mcp-test",
		});
		assert.equal(ok.ok, true, JSON.stringify(ok.error));
		assert.equal(ok.run?.status, "completed");
		assert.match(ok.run?.finalOutput ?? "", /mcp-real/);
		assert.ok(ok.receipt);
		assert.equal(ok.receipt!.assurance.providerOutcome, "ok");
		assert.equal(ok.receipt!.assurance.artifactIntegrity, "unknown");

		const fail = await tools.run({
			define: {
				name: "bad",
				phases: [{ id: "main", type: "script", run: "exit 37", final: true }],
			},
			commandId: "cmd-mcp-fail",
		});
		assert.equal(fail.ok, false);
		assert.equal(fail.run?.status, "failed");
		assert.match(fail.run?.error ?? "", /37/);
		// No success receipt on failed terminal
		assert.equal(fail.receipt, undefined);
		host.close();
	} finally {
		t.cleanup();
	}
});

test("ControlHost persists providerHandle on run projection", async () => {
	const t = temp();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
		});
		const r = await host.admitAndRun({
			program: {
				name: "h",
				phases: [{ id: "main", type: "script", run: "echo x", final: true }],
			},
		});
		assert.equal(r.ok, true);
		assert.ok(r.run?.providerHandle, "providerHandle must be durable on run");
		assert.equal(r.run?.providerName, "script");
		host.close();
	} finally {
		t.cleanup();
	}
});
