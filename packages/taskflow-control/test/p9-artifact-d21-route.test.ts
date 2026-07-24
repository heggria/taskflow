/**
 * P9 legacy conflict, artifact URI ACL, D21 MCP control-plane route.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createControlHost,
	probeLegacyConflict,
	tryControlPlaneRun,
	validateArtifactUri,
} from "../src/index.ts";

function temp(): { home: string; project: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p9-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p9-proj-"));
	return {
		home,
		project,
		env: { ...process.env, TASKFLOW_HOME: home },
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

test("P9: recent .taskflow/runs activity → legacy conflict blocks admit", async () => {
	const t = temp();
	try {
		// Simulate 0.2-style run store activity
		const runs = path.join(t.project, ".taskflow", "runs");
		fs.mkdirSync(runs, { recursive: true });
		fs.writeFileSync(path.join(runs, "legacy-run.json"), JSON.stringify({ v: 2 }));

		const probe = probeLegacyConflict(t.project, { recentMs: 60_000 });
		assert.equal(probe.conflict, true);
		if (probe.conflict) assert.match(probe.marker, /runs/);

		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			skipSingleton: true,
			controlMode: "standalone",
		});
		const r = await host.admitAndRun({
			program: {
				name: "blocked",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.equal(r.ok, false);
		assert.equal(r.error?.code, "TF_LEGACY_CONFLICT");
		host.close();
	} finally {
		t.cleanup();
	}
});

test("P9: stale legacy dir outside recent window does not conflict", () => {
	const t = temp();
	try {
		const runs = path.join(t.project, ".taskflow", "runs");
		fs.mkdirSync(runs, { recursive: true });
		const f = path.join(runs, "old.json");
		fs.writeFileSync(f, "{}");
		const ancient = Date.now() - 24 * 60 * 60_000;
		fs.utimesSync(f, new Date(ancient / 1000), new Date(ancient / 1000));
		fs.utimesSync(runs, new Date(ancient / 1000), new Date(ancient / 1000));
		const probe = probeLegacyConflict(t.project, { recentMs: 60_000, now: Date.now() });
		assert.equal(probe.conflict, false);
	} finally {
		t.cleanup();
	}
});

test("artifact URI: relative ok; traversal and absolute escape rejected", () => {
	const t = temp();
	try {
		fs.writeFileSync(path.join(t.project, "out.txt"), "x");
		const ok = validateArtifactUri(t.project, "out.txt");
		assert.equal(ok.ok, true);
		if (ok.ok) {
			assert.match(ok.uri, /^artifact:\/\//);
			const rootReal = fs.realpathSync(t.project);
			assert.ok(
				ok.resolved === path.join(rootReal, "out.txt") || ok.resolved.startsWith(rootReal + path.sep),
				`resolved=${ok.resolved} root=${rootReal}`,
			);
		}

		const trav = validateArtifactUri(t.project, "../etc/passwd");
		assert.equal(trav.ok, false);

		const abs = validateArtifactUri(t.project, "/etc/passwd");
		assert.equal(abs.ok, false);

		const fileUri = validateArtifactUri(t.project, "file://out.txt");
		// relative after strip may resolve under project
		assert.equal(fileUri.ok, true);
	} finally {
		t.cleanup();
	}
});

test("D21 tryControlPlaneRun: DEFAULTS to ControlHost; exit 37 fails; agent handled (fails without llm)", async () => {
	const t = temp();
	try {
		// Default ON — no TASKFLOW_CONTROL_PLANE, no force
		const env = { ...t.env };
		delete env.TASKFLOW_CONTROL_PLANE;

		const ok = await tryControlPlaneRun(
			t.project,
			{
				name: "s",
				phases: [{ id: "main", type: "script", run: "echo route-ok", final: true }],
			},
			{ env, commandId: "route-1", principal: "test" },
		);
		assert.equal(ok.handled, true);
		if (ok.handled) {
			assert.equal(ok.ok, true);
			assert.equal(ok.viaControlHost, true);
			assert.match(ok.text, /route-ok|control-plane run completed/);
			assert.ok(ok.receiptId);
				assert.match(ok.text, /artifactIntegrity=ok/);
		}

		const fail = await tryControlPlaneRun(
			t.project,
			{
				name: "f",
				phases: [{ id: "main", type: "script", run: "exit 37", final: true }],
			},
			{ env, commandId: "route-fail" },
		);
		assert.equal(fail.handled, true);
		if (fail.handled) {
			assert.equal(fail.ok, false);
			assert.equal(fail.viaControlHost, true);
			assert.match(fail.text, /37|failed/i);
		}

		// Agent phases are handled by ControlHost; without llmProvider they fail closed
		// (no silent fallthrough to 0.2).
		const agentOnly = await tryControlPlaneRun(
			t.project,
			{
				name: "a",
				phases: [{ id: "main", type: "agent", agent: "executor", task: "x", final: true }],
			},
			{ env, commandId: "route-agent-no-llm" },
		);
		assert.equal(agentOnly.handled, true);
		if (agentOnly.handled) {
			assert.equal(agentOnly.ok, false);
			assert.equal(agentOnly.viaControlHost, true);
			assert.match(agentOnly.text, /LLM ExecutionProvider|no LLM|failed/i);
		}

		// Explicit opt-out → not handled (falls through to 0.2 engine)
		const off = await tryControlPlaneRun(
			t.project,
			{
				name: "s2",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
			{ env: { ...t.env, TASKFLOW_CONTROL_PLANE: "0" } },
		);
		assert.equal(off.handled, false);
	} finally {
		t.cleanup();
	}
});
