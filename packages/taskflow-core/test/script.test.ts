import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { type Taskflow, validateTaskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

// The script phase shells out, so tests invoke `node -e` (guaranteed on PATH in
// CI) rather than assuming any particular unix utility. String-form `run` uses
// the shell; array-form is a direct execvp-style spawn (no shell, injection-safe).

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "test-run",
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	};
}

/** A runner that must never fire — script phases spend zero tokens and never
 *  touch the agent runner. If a test trips this, the phase was misrouted. */
const agentRunnerMustNotRun: RuntimeDeps["runTask"] = async () => {
	throw new Error("agent runner should not be called for a script phase");
};

function baseDeps(runTask: RuntimeDeps["runTask"] = agentRunnerMustNotRun, signal?: AbortSignal): RuntimeDeps {
	return { cwd: process.cwd(), agents: AGENTS, runTask, persist: () => {}, onProgress: () => {}, signal };
}

/** An agent runner returning canned output — used by the agent→script chain. */
function cannedRunner(output: string): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => ({
		agent: agentName,
		task,
		exitCode: 0,
		output,
		stderr: "",
		usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
		stopReason: "end",
	});
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test("script validate: requires 'run'", () => {
	const r = validateTaskflow({ name: "s", phases: [{ id: "a", type: "script", final: true }] });
	assert.equal(r.ok, false);
	assert.match(r.errors.join("\n"), /Phase 'a' \(script\) requires 'run'/);
});

test("script validate: array 'run' must be non-empty with a valid first element", () => {
	const empty = validateTaskflow({ name: "s", phases: [{ id: "a", type: "script", run: [], final: true }] });
	assert.equal(empty.ok, false);
	assert.match(empty.errors.join("\n"), /array must be non-empty/);

	const blankHead = validateTaskflow({ name: "s", phases: [{ id: "a", type: "script", run: ["", "x"], final: true }] });
	assert.equal(blankHead.ok, false);
	assert.match(blankHead.errors.join("\n"), /array must be non-empty/);
});

test("script validate: string 'run' with an interpolation placeholder is rejected (injection guard)", () => {
	for (const run of ["echo {steps.gen.output}", "echo {args.name}", "cat {steps.a.b.c}"]) {
		const r = validateTaskflow({ name: "s", phases: [{ id: "a", type: "script", run, final: true }] });
		assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(run)}`);
		assert.match(r.errors.join("\n"), /must not contain interpolation placeholders/);
	}
});

test("script validate: array 'run' with placeholders is allowed (safe by argv isolation)", () => {
	const r = validateTaskflow({
		name: "s",
		phases: [
			{ id: "gen", type: "agent", agent: "a", task: "draft" },
			{ id: "a", type: "script", run: ["echo", "{steps.gen.output}"], dependsOn: ["gen"], final: true },
		],
	});
	assert.equal(r.ok, true, r.errors.join("; "));
});

test("script validate: plain string 'run' without placeholders is allowed", () => {
	const r = validateTaskflow({ name: "s", phases: [{ id: "a", type: "script", run: "echo hi && ls", final: true }] });
	assert.equal(r.ok, true, r.errors.join("; "));
});

test("script validate: retry, output:json, and out-of-range timeout are rejected", () => {
	const retry = validateTaskflow({ name: "s", phases: [{ id: "a", type: "script", run: "echo x", retry: { max: 2 }, final: true }] });
	assert.match(retry.errors.join("\n"), /'retry' is not supported for script phases/);

	const json = validateTaskflow({ name: "s", phases: [{ id: "a", type: "script", run: "echo x", output: "json", final: true }] });
	assert.match(json.errors.join("\n"), /'output:"json"' is not supported/);

	for (const timeout of [999, 300001, "5s"]) {
		const r = validateTaskflow({ name: "s", phases: [{ id: "a", type: "script", run: "echo x", timeout, final: true }] });
		assert.equal(r.ok, false, `timeout ${timeout} should be rejected`);
		assert.match(r.errors.join("\n"), /'timeout' must be a number between 1000 and 300000/);
	}

	const ok = validateTaskflow({ name: "s", phases: [{ id: "a", type: "script", run: "echo x", timeout: 5000, final: true }] });
	assert.equal(ok.ok, true, ok.errors.join("; "));
});

test("script validate: run/input are rejected on non-script phases; timeout is allowed on agent phases", () => {
	const run = validateTaskflow({ name: "s", phases: [{ id: "a", type: "agent", agent: "a", task: "t", run: "echo x", final: true }] });
	assert.match(run.errors.join("\n"), /'run' is only valid for script phases/);

	const input = validateTaskflow({ name: "s", phases: [{ id: "a", type: "agent", agent: "a", task: "t", input: "hi", final: true }] });
	assert.match(input.errors.join("\n"), /'input' is only valid for script phases/);

	// timeout is now valid on agent-running phases (feat: per-phase timeout)
	const timeout = validateTaskflow({ name: "s", phases: [{ id: "a", type: "agent", agent: "a", task: "t", timeout: 5000, final: true }] });
	assert.equal(timeout.ok, true, timeout.errors.join("; "));

	// but rejected on approval/flow phases
	const approval = validateTaskflow({ name: "s", phases: [{ id: "a", type: "approval", prompt: "ok?", timeout: 5000, final: true }] });
	assert.match(approval.errors.join("\n"), /'timeout' is not supported for approval phases/);
});

// ---------------------------------------------------------------------------
// runtime — happy paths
// ---------------------------------------------------------------------------

test("script run: string form captures stdout (trimmed) with zero token usage", async () => {
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: "echo hello world", final: true }],
	};
	const res = await executeTaskflow(mkState(def), baseDeps());
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.a.status, "done");
	assert.equal(res.finalOutput, "hello world");
	assert.equal(res.state.phases.a.usage?.output ?? 0, 0);
	assert.equal(res.totalUsage.output ?? 0, 0);
});

test("script run: array form spawns directly (no shell)", async () => {
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: ["node", "-e", "process.stdout.write('arr-ok')"], final: true }],
	};
	const res = await executeTaskflow(mkState(def), baseDeps());
	assert.equal(res.ok, true);
	assert.equal(res.finalOutput, "arr-ok");
});

test("script run: 'input' is piped to stdin with interpolation", async () => {
	const echoStdin = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('in['+d+']'))";
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: ["node", "-e", echoStdin], input: "payload-{args.n}", final: true }],
	};
	const res = await executeTaskflow(mkState(def, { n: "7" }), baseDeps());
	assert.equal(res.ok, true);
	assert.equal(res.finalOutput, "in[payload-7]");
});

test("script run: array element interpolation resolves upstream refs", async () => {
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: ["node", "-e", "process.stdout.write('n='+process.argv[1])", "{args.n}"], final: true }],
	};
	const res = await executeTaskflow(mkState(def, { n: "42" }), baseDeps());
	assert.equal(res.ok, true);
	assert.equal(res.finalOutput, "n=42");
});

// ---------------------------------------------------------------------------
// integration with other phases
// ---------------------------------------------------------------------------

test("script integration: agent output flows into a script via stdin", async () => {
	const echoStdin = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('SAVED:'+d))";
	const def: Taskflow = {
		name: "s",
		phases: [
			{ id: "gen", type: "agent", agent: "a", task: "draft" },
			{ id: "save", type: "script", run: ["node", "-e", echoStdin], input: "{steps.gen.output}", dependsOn: ["gen"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def), baseDeps(cannedRunner("DRAFT_TEXT")));
	assert.equal(res.ok, true);
	assert.equal(res.finalOutput, "SAVED:DRAFT_TEXT");
});

test("script integration: skipped by an unmet 'when' condition", async () => {
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: "echo should-not-run", when: "{args.go} == 'yes'", final: true }],
	};
	const res = await executeTaskflow(mkState(def, { go: "no" }), baseDeps());
	assert.equal(res.state.phases.a.status, "skipped");
});

// ---------------------------------------------------------------------------
// security — injection isolation at runtime
// ---------------------------------------------------------------------------

test("script security: array form isolates shell metacharacters in interpolated args", async () => {
	// A malicious upstream value flows into an array-form argv. execvp passes it
	// as a single argument, so the embedded `; touch <marker>` is never parsed by
	// a shell. We prove isolation via a side effect: the marker must NOT appear.
	const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tf-script-")), "pwned");
	const printArg = "process.stdout.write('arg=['+process.argv[1]+']')";
	const evil = `; touch ${marker} #`;
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: ["node", "-e", printArg, "{args.evil}"], final: true }],
	};
	const res = await executeTaskflow(mkState(def, { evil }), baseDeps());
	assert.equal(res.ok, true);
	// The whole payload arrives verbatim as one argv element...
	assert.equal(res.finalOutput, `arg=[${evil}]`);
	// ...and the injected `touch` never ran — no shell interpreted the `;`.
	assert.equal(fs.existsSync(marker), false, "injected command executed — argv isolation broken");
});

// ---------------------------------------------------------------------------
// robustness — failures, limits, timeout
// ---------------------------------------------------------------------------

test("script robustness: non-zero exit fails the phase and captures stderr", async () => {
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: ["node", "-e", "process.stderr.write('boom');process.exit(3)"], final: true }],
	};
	const res = await executeTaskflow(mkState(def), baseDeps());
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.a.status, "failed");
	assert.match(res.state.phases.a.error ?? "", /exited with code 3/);
	assert.match(res.state.phases.a.error ?? "", /boom/);
});

test("script robustness: a missing binary fails the phase (spawn error)", async () => {
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: ["this-binary-does-not-exist-xyz-42"], final: true }],
	};
	const res = await executeTaskflow(mkState(def), baseDeps());
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.a.status, "failed");
	assert.match(res.state.phases.a.error ?? "", /Script error/);
});

test("script robustness: stdout is capped at 1 MB with a truncation marker", async () => {
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: ["node", "-e", "process.stdout.write('x'.repeat(3*1024*1024))"], final: true }],
	};
	const res = await executeTaskflow(mkState(def), baseDeps());
	assert.equal(res.ok, true);
	assert.ok(res.finalOutput.length <= 1_048_576 + 64, `output length ${res.finalOutput.length} exceeds cap`);
	assert.match(res.finalOutput, /\[stdout truncated at 1 MB\]/);
});

test("script robustness: a runaway process is killed at the timeout", async () => {
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: ["node", "-e", "setInterval(()=>{},1e9)"], timeout: 1000, final: true }],
	};
	const t0 = Date.now();
	const res = await executeTaskflow(mkState(def), baseDeps());
	const elapsed = Date.now() - t0;
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.a.status, "failed");
	assert.match(res.state.phases.a.error ?? "", /timed out after 1000ms/);
	assert.ok(elapsed < 5000, `timeout took too long: ${elapsed}ms`);
});

test("script robustness: timeout kills background descendants that hold the shell open", { skip: process.platform === "win32" }, async () => {
	const def: Taskflow = {
		name: "s-tree",
		phases: [{ id: "a", type: "script", run: ["bash", "-lc", "sleep 5 & wait"], timeout: 1000, final: true }],
	};
	const t0 = Date.now();
	const res = await executeTaskflow(mkState(def), baseDeps());
	const elapsed = Date.now() - t0;
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.a.timedOut, true);
	assert.ok(elapsed < 2500, `process-tree timeout took too long: ${elapsed}ms`);
});

test("script robustness: normal exit reaps a background process holding stdio", { skip: process.platform === "win32" }, async () => {
	const def: Taskflow = {
		name: "s-background",
		phases: [{ id: "a", type: "script", run: ["bash", "-lc", "sleep 3 &"], final: true }],
	};
	const started = Date.now();
	const res = await executeTaskflow(mkState(def), baseDeps());
	assert.equal(res.ok, true);
	assert.ok(Date.now() - started < 1000, "background descendant must be reaped at direct-child exit");
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

test("script cancellation: an abort mid-run fails the phase without waiting for it", async () => {
	const ac = new AbortController();
	const def: Taskflow = {
		name: "s",
		phases: [{ id: "a", type: "script", run: ["node", "-e", "setTimeout(()=>process.stdout.write('done'),4000)"], final: true }],
	};
	const p = executeTaskflow(mkState(def), baseDeps(agentRunnerMustNotRun, ac.signal));
	setTimeout(() => ac.abort(), 150);
	const t0 = Date.now();
	const res = await p;
	const elapsed = Date.now() - t0;
	assert.equal(res.ok, false);
	assert.ok(elapsed < 3000, `abort did not interrupt the child promptly: ${elapsed}ms`);
});
