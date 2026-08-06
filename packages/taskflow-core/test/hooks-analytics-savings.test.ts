import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildHookPayload,
	dispatchHooks,
	validateFlowHooks,
	validateWebhookUrl,
	type FlowHooks,
} from "../src/hooks.ts";
import { formatSavingsLine, formatRecomputeSavingsHeader, countPhaseOutcomes } from "../src/savings.ts";
import { analyzeFlowRuns, formatAnalyticsReport } from "../src/analytics.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { newRunId, saveRun, type RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";
import { resolveApprovalDecision } from "../src/runtime/phases/approval-wait.ts";
import { validateTaskflow } from "../src/schema.ts";

test("webhook URL: https and localhost http ok; other http rejected", () => {
	assert.equal(validateWebhookUrl("https://example.com/h"), null);
	assert.equal(validateWebhookUrl("http://127.0.0.1:9/h"), null);
	assert.equal(validateWebhookUrl("http://localhost/h"), null);
	assert.match(validateWebhookUrl("http://evil.com/h") ?? "", /https/);
});

test("validateFlowHooks rejects shell-string command", () => {
	const errs = validateFlowHooks({
		onComplete: [{ type: "command", run: "curl http://x" as unknown as string[] }],
	});
	assert.ok(errs.some((e) => /string array/.test(e)));
});

test("savings line reports reused/rerun/cutoff", () => {
	const line = formatSavingsLine({
		dryRun: false,
		rerun: ["a", "b"],
		reused: ["c", "d", "e"],
		cutoff: ["f"],
	});
	assert.match(line, /reused 3/);
	assert.match(line, /rerun 2/);
	assert.match(line, /cutoff 1/);
	assert.match(line, /saved ~/);
	assert.match(formatRecomputeSavingsHeader({ dryRun: true, seeds: ["a"], rerun: ["a"], reused: [], cutoff: [] }), /DRY RUN/);
});

test("countPhaseOutcomes counts cache hits", () => {
	const c = countPhaseOutcomes({
		a: { id: "a", status: "done", cacheHit: "cross-run", usage: emptyUsage() },
		b: { id: "b", status: "failed", usage: emptyUsage() },
		c: { id: "c", status: "skipped", usage: emptyUsage() },
	});
	assert.equal(c.total, 3);
	assert.equal(c.cached, 1);
	assert.equal(c.failed, 1);
});

test("file hook writes summary payload without finalOutput field content leak pattern", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-hooks-"));
	try {
		const hookPath = "hooks/out.json";
		const state: RunState = {
			runId: "run_test_hooks_1",
			flowName: "hooked",
			def: {
				name: "hooked",
				phases: [{ id: "s", type: "script", run: "true", final: true }],
				hooks: {
					onComplete: [{ type: "file", path: hookPath }],
				},
			} as RunState["def"],
			args: {},
			status: "completed",
			phases: {
				s: { id: "s", status: "done", output: "SECRET_TRANSCRIPT", usage: emptyUsage() },
			},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: dir,
			finalOutput: "SECRET_FINAL",
		};
		const payload = buildHookPayload("complete", state);
		assert.equal(payload.schema, "taskflow.hook.v1");
		assert.ok(!("finalOutput" in payload));
		assert.ok(!JSON.stringify(payload).includes("SECRET_TRANSCRIPT"));

		const r = await dispatchHooks(state, {
			cwd: dir,
			hooks: state.def.hooks as FlowHooks,
		});
		assert.equal(r.dispatched, 1);
		assert.equal(r.errors.length, 0);
		const written = JSON.parse(fs.readFileSync(path.join(dir, hookPath), "utf8"));
		assert.equal(written.schema, "taskflow.hook.v1");
		assert.equal(written.event, "complete");
		assert.ok(!JSON.stringify(written).includes("SECRET_TRANSCRIPT"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("executeTaskflow dispatches onComplete file hook", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-hooks-run-"));
	try {
		const def = {
			name: "hook-run",
			hooks: { onComplete: [{ type: "file" as const, path: ".taskflow/hooks/last.json" }] },
			phases: [{ id: "s", type: "script" as const, run: "true", final: true }],
		};
		const v = validateTaskflow(def);
		assert.equal(v.ok, true, v.errors.join("; "));
		const state: RunState = {
			runId: newRunId("hook-run"),
			flowName: "hook-run",
			def: def as RunState["def"],
			args: {},
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: dir,
		};
		const deps: RuntimeDeps = {
			cwd: dir,
			agents: [],
			runTask: async () => ({
				agent: "script",
				task: "true",
				exitCode: 0,
				output: "ok",
				stderr: "",
				usage: emptyUsage(),
			}),
		};
		const res = await executeTaskflow(state, deps);
		assert.equal(res.ok, true);
		const p = path.join(dir, ".taskflow/hooks/last.json");
		assert.ok(fs.existsSync(p), "hook file should exist");
		const body = JSON.parse(fs.readFileSync(p, "utf8"));
		assert.equal(body.schema, "taskflow.hook.v1");
		assert.equal(body.event, "complete");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("approval timeout onExpire reject fires without human", async () => {
	const resolved = await resolveApprovalDecision({
		phase: { id: "ap", type: "approval", task: "ok?", timeoutMs: 1000, onExpire: "reject" } as never,
		message: "ok?",
		requestApproval: () => new Promise(() => {}), // never resolves
	});
	assert.equal(resolved.kind, "decision");
	if (resolved.kind === "decision") {
		assert.equal(resolved.decision.decision, "reject");
		assert.equal(resolved.auto, true);
		assert.match(resolved.decision.note ?? "", /expired/);
	}
});

test("approval timeout onExpire approve auto-continues", async () => {
	const resolved = await resolveApprovalDecision({
		phase: { id: "ap", type: "approval", task: "ok?", timeoutMs: 1000, onExpire: "approve" } as never,
		message: "ok?",
		requestApproval: () => new Promise(() => {}),
	});
	assert.equal(resolved.kind, "decision");
	if (resolved.kind === "decision") {
		assert.equal(resolved.decision.decision, "approve");
		assert.equal(resolved.auto, true);
	}
});

test("approval timeout onExpire fail", async () => {
	const resolved = await resolveApprovalDecision({
		phase: { id: "ap", type: "approval", task: "ok?", timeoutMs: 1000, onExpire: "fail" } as never,
		message: "ok?",
		requestApproval: () => new Promise(() => {}),
	});
	assert.equal(resolved.kind, "fail");
	if (resolved.kind === "fail") assert.equal(resolved.error, "approval-expired");
});

test("schema: approval timeoutMs validation", () => {
	const bad = validateTaskflow({
		name: "x",
		phases: [{ id: "a", type: "agent", task: "t", timeoutMs: 5000, final: true }],
	});
	assert.ok(bad.errors.some((e) => /timeoutMs/.test(e)));

	const good = validateTaskflow({
		name: "x",
		phases: [{ id: "a", type: "approval", task: "ok?", timeoutMs: 5000, onExpire: "reject", final: true }],
	});
	assert.equal(good.ok, true, good.errors.join("; "));
});

test("analytics empty history is friendly", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-analytics-"));
	try {
		const a = analyzeFlowRuns(dir, "missing-flow", { last: 5 });
		assert.equal(a.runs, 0);
		assert.match(formatAnalyticsReport(a), /no runs/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("analytics aggregates synthetic runs", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-analytics2-"));
	try {
		const now = Date.now();
		for (let i = 0; i < 3; i++) {
			const state: RunState = {
				runId: `run_analytics_${i}`,
				flowName: "demo",
				def: { name: "demo", phases: [{ id: "p", type: "script", run: "true", final: true }] } as RunState["def"],
				args: {},
				status: i === 0 ? "failed" : "completed",
				phases: {
					p: {
						id: "p",
						status: i === 0 ? "failed" : "done",
						startedAt: now,
						endedAt: now + 1000 * (i + 1),
						usage: emptyUsage(),
						...(i === 2 ? { cacheHit: "cross-run" as const } : {}),
					},
				},
				createdAt: now - 10_000 + i,
				updatedAt: now - 10_000 + i + 1000 * (i + 1),
				cwd: dir,
			};
			saveRun(state);
		}
		const a = analyzeFlowRuns(dir, "demo", { last: 10 });
		assert.equal(a.runs, 3);
		assert.equal(a.statusHistogram.failed, 1);
		assert.equal(a.statusHistogram.completed, 2);
		assert.ok(a.perPhase.some((p) => p.phaseId === "p" && p.runs === 3));
		assert.match(formatAnalyticsReport(a), /demo/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
