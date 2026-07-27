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
	SingletonAuthorityError,
	type ExecutionProvider,
	type RunContinuation,
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

test("C7-B: a previously acknowledged foreign handle cannot reach terminal observation", async () => {
	const t = tempProject();
	try {
		const runId = "r-foreign-observation";
		const now = Date.now();
		let pollCalls = 0;
		let collectCalls = 0;
		const provider: ExecutionProvider = {
			name: "observation-provider",
			async submit() {
				throw new Error("scheduler must not re-submit an acknowledged durable attempt");
			},
			async collect() {
				collectCalls += 1;
				return { kind: "completed", output: "foreign-output" };
			},
			async poll() {
				pollCalls += 1;
				return { kind: "completed", output: "foreign-output" };
			},
			async cancel() {
				return { kind: "ambiguous" };
			},
			async reconcile() {
				return { kind: "completed", output: "foreign-output" };
			},
			loadHandle(handle) {
				if (handle !== "foreign-observation-handle") return null;
				return {
					handle,
					runId: "other-run:other-phase",
					providerName: "observation-provider",
					leaseEpoch: now,
					cwd: t.project,
					startedAt: now,
					status: "completed",
					stdout: "foreign-output",
				};
			},
		};
		const continuation: RunContinuation = {
			schemaVersion: 1,
			continuationId: "cont-foreign-observation",
			runId,
			projectId: "project-foreign-observation",
			controlDomainId: "domain-foreign-observation",
			boundPlanHash: "bound-foreign-observation",
			status: "active",
			phaseAttempts: [],
			phaseOutputs: {},
			activeAttempt: {
				attemptId: "att-foreign-observation",
				phaseId: "main",
				type: "script",
				idempotencyKey: `${runId}:main:att-foreign-observation`,
				providerName: "observation-provider",
				providerHandle: "foreign-observation-handle",
				state: "acknowledged",
				createdAt: now,
				updatedAt: now,
			},
			nextPhaseId: "main",
			createdAt: now,
			updatedAt: now,
			version: 1,
		};

		const scheduled = await schedulePhases(
			{
				name: "foreign-observation",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
			{ script: provider },
			{ runId, cwd: t.project, continuation, phaseDeadlineMs: 1 },
		);

		assert.equal(scheduled.ok, false, scheduled.error);
		assert.equal(scheduled.dispatchHandleInvalid?.stage, "terminal-observation");
		assert.equal(pollCalls, 0, "foreign handle must be rejected before poll");
		assert.equal(collectCalls, 0, "foreign handle must be rejected before collect");
		assert.equal(scheduled.checkpoint.activeAttempt?.state, "acknowledged");
		assert.equal(scheduled.checkpoint.activeAttempt?.providerHandle, "foreign-observation-handle");
	} finally {
		t.cleanup();
	}
});

test("C7-B: a provider without durable handle lookup cannot acknowledge or observe a new handle", async () => {
	const t = tempProject();
	try {
		let pollCalls = 0;
		const provider: ExecutionProvider = {
			name: "unverifiable-provider",
			async submit() {
				return { kind: "accepted", handle: "unverifiable-handle" };
			},
			async poll() {
				pollCalls += 1;
				return { kind: "completed", output: "must-not-trust" };
			},
			async cancel() {
				return { kind: "ambiguous" };
			},
			async reconcile() {
				return { kind: "ambiguous", reason: "no durable handle lookup" };
			},
		};

		const scheduled = await schedulePhases(
			{
				name: "unverifiable-provider",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
			{ script: provider },
			{ runId: "r-unverifiable", cwd: t.project, phaseDeadlineMs: 1 },
		);

		assert.equal(scheduled.ok, false, scheduled.error);
		assert.equal(scheduled.dispatchHandleInvalid?.stage, "acknowledgement");
		assert.equal(pollCalls, 0, "a handle without a durable record must not be observed");
		assert.equal(scheduled.checkpoint.activeAttempt?.state, "intent-recorded");
		assert.equal(scheduled.checkpoint.activeAttempt?.providerHandle, undefined);
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

test("adversarial: authority lost after durable intent never submits the real script", async () => {
	const t = tempProject();
	try {
		const marker = path.join(t.project, "authority-lost-before-submit.marker");
		let authorityChecks = 0;
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			// The first check admits the command. The next check must happen after
			// the durable intent and before ExecutionProvider.submit().
			mutationAuthority: () => {
				authorityChecks += 1;
				return authorityChecks === 1;
			},
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		try {
			const result = await host.admitAndRun({
				program: {
					name: "authority-lost-before-submit",
					phases: [
						{
							id: "write-marker",
							type: "script",
							run: [
								process.execPath,
								"-e",
								`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "submitted\\n")`,
							],
							final: true,
						},
					],
				},
				commandId: "authority-lost-before-submit",
			});

			assert.equal(result.ok, false);
			assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");
			assert.equal(result.error?.recoveryAction, "retry-same-command");
			assert.equal(result.error?.sideEffects, "none");
			assert.equal(result.receipt, undefined);
			assert.equal(authorityChecks, 2, "must re-check authority immediately before submit");
			assert.equal(fs.existsSync(marker), false, "real script must never be submitted");
			assert.equal(result.run?.status, "running");
			assert.equal(result.run?.stage, "executing");
			assert.ok(result.run?.reservationId, "durable intent keeps the capacity reservation held");

			const continuation = host.store.getContinuation(result.run!.runId);
			assert.equal(continuation?.activeAttempt?.phaseId, "write-marker");
			assert.equal(continuation?.activeAttempt?.state, "intent-recorded");
		} finally {
			host.close();
		}
	} finally {
		t.cleanup();
	}
});

test("adversarial: authority lost after host pre-check never reaches fenced script spawn", async () => {
	const t = tempProject();
	try {
		const marker = path.join(t.project, "authority-lost-inside-submit-fence.marker");
		let authorityChecks = 0;
		let durableFenceRevoked = false;
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			mutationAuthority: () => {
				authorityChecks += 1;
				// Permit admission and the scheduler's host pre-check. Simulate a
				// takeover immediately after that check, before provider spawn.
				if (authorityChecks === 2) durableFenceRevoked = true;
				return true;
			},
			mutationFence: <T>(fn: () => T): T => {
				if (durableFenceRevoked) {
					throw new SingletonAuthorityError("test takeover after provider pre-check");
				}
				return fn();
			},
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		try {
			const result = await host.admitAndRun({
				program: {
					name: "authority-lost-inside-submit-fence",
					phases: [
						{
							id: "write-marker",
							type: "script",
							run: [
								process.execPath,
								"-e",
								`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned\\n")`,
							],
							final: true,
						},
					],
				},
				commandId: "authority-lost-inside-submit-fence",
			});

			assert.equal(result.ok, false);
			assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");
			assert.equal(result.error?.sideEffects, "none");
			assert.equal(authorityChecks, 2, "host pre-check passed before the durable submit fence");
			assert.equal(fs.existsSync(marker), false, "fenced script provider must not spawn");
			assert.equal(result.receipt, undefined);
			assert.equal(result.run?.status, "running");
			assert.equal(result.run?.stage, "executing");
			assert.equal(host.store.getContinuation(result.run!.runId)?.activeAttempt?.state, "intent-recorded");
		} finally {
			host.close();
		}
	} finally {
		t.cleanup();
	}
});

test("adversarial: authority lost after script spawn retains a possible-side-effect intent", async () => {
	const t = tempProject();
	try {
		const marker = path.join(t.project, "authority-lost-after-spawn.marker");
		let authorityChecks = 0;
		let providerFenceEntered = false;
		let providerFenceCompleted = false;
		const host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			mutationAuthority: () => {
				authorityChecks += 1;
				// Admission is check 1; scheduler pre-submit is check 2. The inner
				// Script provider fence still observes authority at check 3.
				if (authorityChecks === 2) providerFenceEntered = true;
				return true;
			},
			mutationFence: <T>(fn: () => T): T => {
				if (providerFenceEntered && !providerFenceCompleted) {
					const result = fn();
					providerFenceCompleted = true;
					return result;
				}
				if (providerFenceCompleted) {
					throw new SingletonAuthorityError("test takeover after provider spawn acknowledgement");
				}
				return fn();
			},
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(t.project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		try {
			const result = await host.admitAndRun({
				program: {
					name: "authority-lost-after-spawn",
					phases: [
						{
							id: "write-marker",
							type: "script",
							run: [
								process.execPath,
								"-e",
								`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned\\n")`,
							],
							final: true,
						},
					],
				},
				commandId: "authority-lost-after-spawn",
			});

			assert.equal(result.ok, false);
			assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");
			assert.equal(result.error?.recoveryAction, "reconcile");
			assert.equal(result.error?.sideEffects, "possible");
			assert.equal(result.receipt, undefined);
			assert.equal(result.run?.status, "running");
			assert.equal(result.run?.stage, "executing");
			assert.ok(result.run?.reservationId, "accepted provider work keeps capacity held");
			assert.equal(authorityChecks, 3, "provider fence must re-check authority before spawn");

			for (let attempt = 0; attempt < 20 && !fs.existsSync(marker); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert.equal(fs.existsSync(marker), true, "script may already have an external side effect");
			const continuation = host.store.getContinuation(result.run!.runId);
			assert.equal(continuation?.activeAttempt?.state, "intent-recorded");
			assert.equal(continuation?.activeAttempt?.providerHandle, undefined);
		} finally {
			host.close();
		}
	} finally {
		t.cleanup();
	}
});
