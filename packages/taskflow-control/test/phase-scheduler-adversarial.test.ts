/**
 * Adversarial phase-scheduler tests (mandate 1 / required GA evidence):
 * - multi-script DAG: both scripts run; first marker must exist
 * - mixed agent+script: both execute; agent cannot be skipped
 * - upstream failure: no success Receipt; downstream skipped
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createControlHost,
	createHostLlmExecutionProvider,
	createScriptExecutionProvider,
	schedulePhases,
} from "../src/index.ts";

function tempProject(): { project: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-sched-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-home-"));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_TASKFLOW_BUILTIN_AGENTS_DIR: "",
	};
	delete env.TASKFLOW_CONTROL_PLANE;
	return {
		project,
		env,
		cleanup: () => {
			fs.rmSync(project, { recursive: true, force: true });
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}

test("adversarial: two dependent scripts both run; first marker must exist", async () => {
	const t = tempProject();
	try {
		const marker1 = path.join(t.project, "marker-a.txt");
		const marker2 = path.join(t.project, "marker-b.txt");
		const program = {
			name: "two-scripts",
			phases: [
				{
					id: "a",
					type: "script",
					run: `echo first > "${marker1}" && echo from-a`,
					final: false,
				},
				{
					id: "b",
					type: "script",
					dependsOn: ["a"],
					run: `test -f "${marker1}" && echo second > "${marker2}" && echo from-b`,
					final: true,
				},
			],
		};
		const scheduled = await schedulePhases(
			program,
			{ script: createScriptExecutionProvider() },
			{ runId: "r1", cwd: t.project, phaseDeadlineMs: 15_000 },
		);
		assert.equal(scheduled.ok, true, scheduled.error);
		assert.equal(scheduled.attempts.length, 2);
		assert.equal(scheduled.attempts[0]!.status, "completed");
		assert.equal(scheduled.attempts[1]!.status, "completed");
		assert.ok(fs.existsSync(marker1), "first marker must exist");
		assert.ok(fs.existsSync(marker2), "second marker must exist");
		assert.match(scheduled.finalOutput ?? "", /from-b/);
	} finally {
		t.cleanup();
	}
});

test("adversarial: mixed agent+script executes both; agent cannot be skipped", async () => {
	const t = tempProject();
	try {
		const scriptMarker = path.join(t.project, "script-ran.txt");
		const agentMarker = path.join(t.project, "agent-ran.txt");
		let agentCalls = 0;
		const llm = createHostLlmExecutionProvider({
			runTask: async (req) => {
				agentCalls += 1;
				fs.writeFileSync(agentMarker, `agent:${req.agent}:${req.task}`);
				return { ok: true, output: `agent-out:${req.task}`, exitCode: 0 };
			},
		});
		const program = {
			name: "mixed",
			phases: [
				{
					id: "scr",
					type: "script",
					run: `echo script-ok > "${scriptMarker}" && echo script-out`,
				},
				{
					id: "ag",
					type: "agent",
					agent: "executor",
					dependsOn: ["scr"],
					task: "do-work",
					final: true,
				},
			],
		};
		const scheduled = await schedulePhases(
			program,
			{ script: createScriptExecutionProvider(), llm },
			{ runId: "r-mix", cwd: t.project, phaseDeadlineMs: 15_000 },
		);
		assert.equal(scheduled.ok, true, scheduled.error);
		assert.equal(agentCalls, 1, "agent provider must be invoked");
		assert.ok(fs.existsSync(scriptMarker), "script phase must run");
		assert.ok(fs.existsSync(agentMarker), "agent phase must run");
		assert.equal(scheduled.attempts.find((a) => a.phaseId === "scr")?.status, "completed");
		assert.equal(scheduled.attempts.find((a) => a.phaseId === "ag")?.status, "completed");
		assert.match(scheduled.finalOutput ?? "", /agent-out:do-work/);
	} finally {
		t.cleanup();
	}
});

test("adversarial: upstream failure prevents downstream; no success Receipt", async () => {
	const t = tempProject();
	try {
		const downMarker = path.join(t.project, "should-not-exist.txt");
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			scriptProvider: createScriptExecutionProvider(),
		});
		try {
			const result = await host.admitAndRun({
				program: {
					name: "upfail",
					phases: [
						{ id: "up", type: "script", run: "exit 42" },
						{
							id: "down",
							type: "script",
							dependsOn: ["up"],
							run: `echo leaked > "${downMarker}"`,
							final: true,
						},
					],
				},
				commandId: "cmd-upfail",
				callerPrincipal: "test",
			});
			assert.equal(result.ok, false);
			assert.equal(result.receipt, undefined);
			assert.equal(result.run?.status, "failed");
			assert.ok(!fs.existsSync(downMarker), "downstream must not run after upstream failure");
			// snapshot must not claim success receipt
			assert.equal(result.snapshot?.receipt, null);
		} finally {
			host.close();
		}
	} finally {
		t.cleanup();
	}
});

test("adversarial: agent without llmProvider fails closed (no skip)", async () => {
	const t = tempProject();
	try {
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			scriptProvider: createScriptExecutionProvider(),
			// no llmProvider
		});
		try {
			const result = await host.admitAndRun({
				program: {
					name: "agent-only",
					phases: [
						{
							id: "a",
							type: "agent",
							agent: "executor",
							task: "hello",
							final: true,
						},
					],
				},
				commandId: "cmd-no-llm",
			});
			assert.equal(result.ok, false);
			assert.match(result.run?.error ?? result.error?.message ?? "", /LLM ExecutionProvider|no LLM/i);
			assert.equal(result.receipt, undefined);
		} finally {
			host.close();
		}
	} finally {
		t.cleanup();
	}
});

test("adversarial: ControlHost mixed agent+script with llm signs Receipt only after both", async () => {
	const t = tempProject();
	try {
		const scriptMarker = path.join(t.project, "h-script.txt");
		let agentCalls = 0;
		const llm = createHostLlmExecutionProvider({
			runTask: async () => {
				agentCalls += 1;
				return { ok: true, output: "llm-done", exitCode: 0 };
			},
		});
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			scriptProvider: createScriptExecutionProvider(),
			llmProvider: llm,
		});
		try {
			const result = await host.admitAndRun({
				program: {
					name: "host-mix",
					phases: [
						{
							id: "s",
							type: "script",
							run: `echo ok > "${scriptMarker}" && echo s-out`,
						},
						{
							id: "a",
							type: "agent",
							dependsOn: ["s"],
							agent: "executor",
							task: "finish",
							final: true,
						},
					],
				},
				commandId: "cmd-host-mix",
			});
			assert.equal(result.ok, true, result.error?.message ?? result.run?.error);
			assert.equal(agentCalls, 1);
			assert.ok(fs.existsSync(scriptMarker));
			assert.ok(result.receipt);
			assert.equal(result.receipt?.assurance.providerOutcome, "ok");
			assert.match(result.run?.finalOutput ?? "", /llm-done/);
		} finally {
			host.close();
		}
	} finally {
		t.cleanup();
	}
});
