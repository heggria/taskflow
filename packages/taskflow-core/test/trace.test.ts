import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunResult, RunOptions } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { FileTraceSink, NoopTraceSink, readTrace, type TraceEvent, type TraceSink } from "../src/trace.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "trace-test-run",
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
	};
}

function mockRunner(respond: (task: string) => string): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => ({
		agent: agentName,
		task,
		exitCode: 0,
		output: respond(task),
		stderr: "",
		usage: { ...emptyUsage(), output: 10 },
		stopReason: "end",
	});
}

function baseDeps(runTask: RuntimeDeps["runTask"], trace?: TraceSink): RuntimeDeps {
	return { cwd: "/tmp", agents: AGENTS, runTask, persist: () => {}, onProgress: () => {}, trace };
}

/** A capturing sink that buffers every emit (no flush discard) for assertions. */
function captureSink(): { sink: TraceSink; events: TraceEvent[] } {
	const events: TraceEvent[] = [];
	return {
		events,
		sink: {
			emit: (e) => { events.push(e); },
			flush: () => {},
		},
	};
}

// ─── P1-2: host-agnostic invariant — no trace sink = identical result ────────

test("trace: a run with NO trace sink produces the same result as today", async () => {
	const def: Taskflow = {
		name: "notrace",
		phases: [
			{ id: "p1", type: "agent", agent: "a", task: "say hi", final: true },
		],
	};
	const deps = baseDeps(mockRunner(() => "hello"));
	// No `trace` field at all.
	assert.equal(deps.trace, undefined);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.ok, true);
	assert.equal(res.finalOutput, "hello");
	assert.equal(res.state.phases["p1"].status, "done");
});

test("trace: NoopTraceSink is a true no-op (never throws, run unaffected)", async () => {
	const def: Taskflow = {
		name: "noop",
		phases: [{ id: "p1", type: "agent", agent: "a", task: "x", final: true }],
	};
	const deps = baseDeps(mockRunner(() => "y"), NoopTraceSink);
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.finalOutput, "y");
});

// ─── emission: phase-start / subagent-call / phase-end ───────────────────────

test("trace: a single-agent run emits phase-start, subagent-call, phase-end", async () => {
	const def: Taskflow = {
		name: "single",
		phases: [{ id: "p1", type: "agent", agent: "a", task: "do work", final: true }],
	};
	const { sink, events } = captureSink();
	await executeTaskflow(mkState(def), baseDeps(mockRunner(() => "done"), sink));
	const kinds = events.map((e) => e.kind);
	assert.equal(kinds[0], "phase-start");
	assert.ok(kinds.includes("subagent-call"));
	assert.equal(kinds[kinds.length - 1], "phase-end");
	// The subagent-call carries the resolved task + the subagent's output.
	const call = events.find((e) => e.kind === "subagent-call")!;
	assert.equal(call.input?.agent, "a");
	assert.equal(call.input?.task, "do work");
	assert.equal(call.output?.text, "done");
	// phase-end carries the terminal status.
	const end = events.find((e) => e.kind === "phase-end")!;
	assert.equal(end.status, "done");
});

// ─── P1-3: map multi-emit — one subagent-call per item ───────────────────────

test("trace: a map phase emits a subagent-call event for every item", async () => {
	const def: Taskflow = {
		name: "maptrace",
		phases: [
			{
				id: "discover", type: "agent", agent: "a", output: "json",
				task: "list", final: false,
			},
			{
				id: "review", type: "map", over: "{steps.discover.json}", agent: "a",
				task: "review {item}", dependsOn: ["discover"],
			},
			{ id: "report", type: "agent", agent: "a", task: "merge", dependsOn: ["review"], final: true },
		],
	};
	const { sink, events } = captureSink();
	const runner = mockRunner((task) => {
		if (task === "list") return JSON.stringify(["f1", "f2", "f3"]);
		return `reviewed ${task}`;
	});
	await executeTaskflow(mkState(def), baseDeps(runner, sink));
	// Exactly three subagent-call events for the map items, plus discover + report.
	const calls = events.filter((e) => e.kind === "subagent-call" && e.phaseId === "review");
	assert.equal(calls.length, 3, "one subagent-call per map item");
	// Each carries the bound {item} — the discriminating factor for map items
	// (nodePath is the phase id unless ctx-sharing is on; the task text is what
	// distinguishes them).
	const items = calls.map((c) => c.input?.task).sort();
	assert.deepEqual(items, ["review f1", "review f2", "review f3"].sort());
	assert.equal(new Set(calls.map((c) => c.output?.text)).size, 3, "distinct outputs per item");
});

// ─── readTrace: partial-line tolerance ───────────────────────────────────────

test("readTrace: skips blank lines and a trailing partial (corrupt) line", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-"));
	const file = path.join(dir, "run.trace.jsonl");
	const valid = (id: string): string => JSON.stringify({ ts: 1, runId: "r", phaseId: id, kind: "phase-start" });
	// Two valid lines, a blank line, and a truncated final line (crash mid-flush).
	fs.writeFileSync(file, `${valid("a")}\n\n${valid("b")}\n{"ts":2,"runId":"r","phaseId":"c","kind":"phase-sta`);
	const events = readTrace(file);
	assert.equal(events.length, 2);
	assert.deepEqual(events.map((e) => e.phaseId), ["a", "b"]);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("readTrace: a missing file returns [] (fail-open)", () => {
	assert.deepEqual(readTrace("/no/such/path/trace.jsonl"), []);
});

// ─── FileTraceSink: buffered round-trip + flush ──────────────────────────────

test("FileTraceSink: buffers per phase and flushes once at flush()", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-sink-"));
	const file = path.join(dir, "run.trace.jsonl");
	const sink = new FileTraceSink(file);
	const mk = (id: string): TraceEvent => ({ ts: Date.now(), runId: "r", phaseId: "p1", kind: "phase-start" });
	// Emit before flush → nothing on disk yet.
	sink.emit(mk("a"));
	sink.emit(mk("b"));
	assert.equal(readTrace(file).length, 0);
	// Flush → both land.
	sink.flush("p1");
	const events = readTrace(file);
	assert.equal(events.length, 2);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("FileTraceSink: never throws on an unwritable dir (fail-open)", () => {
	const sink = new FileTraceSink("/no/such/dir/run.trace.jsonl");
	sink.emit({ ts: 1, runId: "r", phaseId: "p", kind: "phase-start" });
	// flush must not throw.
	assert.doesNotThrow(() => sink.flush("p"));
});

test("FileTraceSink: creates missing parent dir on first flush (MCP constructs sink before saveRun)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "trace-mkdir-"));
	const nested = path.join(root, "flow-name", "run.trace.jsonl");
	// Parent flow-name/ does not exist yet — mirrors first-run MCP path.
	assert.equal(fs.existsSync(path.dirname(nested)), false);
	const sink = new FileTraceSink(nested);
	sink.emit({ ts: 1, runId: "r", phaseId: "hello", kind: "phase-start" });
	sink.emit({ ts: 2, runId: "r", phaseId: "hello", kind: "phase-end", status: "done" });
	assert.doesNotThrow(() => sink.flush("hello"));
	const events = readTrace(nested);
	assert.equal(events.length, 2);
	assert.equal(events[0]!.kind, "phase-start");
	assert.equal(events[1]!.kind, "phase-end");
	fs.rmSync(root, { recursive: true, force: true });
});

// ─── decision events: gate verdict + unreplayable marker ─────────────────────

test("trace: a gate phase emits a gate-verdict decision event", async () => {
	const def: Taskflow = {
		name: "gateflow",
		phases: [
			{ id: "g", type: "gate", agent: "a", task: "is it ok? VERDICT: PASS", final: true },
		],
	};
	const { sink, events } = captureSink();
	await executeTaskflow(mkState(def), baseDeps(mockRunner(() => "looks fine. VERDICT: PASS"), sink));
	const verdict = events.find((e) => e.kind === "decision" && e.decision?.type === "gate-verdict");
	assert.ok(verdict, "a gate-verdict decision event was emitted");
	assert.equal(verdict!.decision!.type, "gate-verdict");
	// The discriminated value field carries the parsed verdict.
	assert.equal((verdict!.decision as { value: string }).value, "pass");
});

test("trace: a context-sharing phase emits an unreplayable decision marker", async () => {
	const def: Taskflow = {
		name: "ctxflow",
		contextSharing: true,
		phases: [
			{ id: "p1", type: "agent", agent: "a", task: "use the blackboard", final: true },
		],
	};
	const { sink, events } = captureSink();
	await executeTaskflow(mkState(def), baseDeps(mockRunner(() => "ok"), sink));
	const marker = events.find((e) => e.kind === "decision" && e.decision?.type === "unreplayable");
	assert.ok(marker, "an unreplayable marker was emitted for the context-sharing phase");
	assert.equal((marker!.decision as { reason: string }).reason, "context-sharing");
});
