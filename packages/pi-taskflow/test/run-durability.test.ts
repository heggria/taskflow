import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { listRuns, directoryIdentity, resumeSourceAfterOwnerExit, isQuiescentApprovalCheckpoint, forkRunForResume, probeProcess, type RunState } from "taskflow-core";
import registerTaskflow from "../src/index.ts";

test("Pi checkpoints: rapid script completions are on disk before opening approval", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-checkpoint-"));
	try {
		let registered: ToolDefinition | undefined;
		registerTaskflow({ on() {}, registerCommand() {}, registerTool(t: ToolDefinition) { if (t.name === "taskflow") registered = t; } } as unknown as ExtensionAPI);
		assert.ok(registered);
		let checkpoint: RunState | undefined;
		const result = await registered.execute("checkpoint", { action: "run", define: { name: "rapid-checkpoints", phases: [
			{ id: "one", type: "script", run: "printf FIRST" },
			{ id: "two", type: "script", run: "printf SECOND", dependsOn: ["one"] },
			{ id: "review", type: "approval", task: "Hold", dependsOn: ["two"] },
		] } }, undefined, undefined, { cwd, mode: "rpc", hasUI: true, ui: {
			notify() {}, async select() { checkpoint = listRuns(cwd)[0]; return "Approve"; },
		} } as unknown as ExtensionToolContext);
		assert.equal(result.isError, false, JSON.stringify(result));
		assert.ok(checkpoint);
		assert.equal(checkpoint.phases.one?.status, "done");
		assert.equal(checkpoint.phases.one.output, "FIRST");
		assert.equal(checkpoint.phases.two?.status, "done");
		assert.equal(checkpoint.phases.two.output, "SECOND");
		assert.deepEqual(checkpoint.foregroundOwner?.approvalWait, ["review"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

function checkpoint(cwd: string): RunState {
	return {
		runId: "interrupted", flowName: "owner", cwd, args: {}, createdAt: 1, updatedAt: 1, status: "running",
		def: { name: "owner", phases: [{ id: "review", type: "approval", task: "Hold" }] },
		phases: { review: { id: "review", status: "running" } },
		invocationRootSnapshot: directoryIdentity(cwd),
		foregroundOwner: { version: 1, pid: 2147483647, instanceId: "opaque-instance", startedAt: 1, approvalWait: ["review"] },
	};
}

test("orphan resume: only a dead-owner approval checkpoint forks without mutating parent", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-owner-"));
	try {
		const parent = checkpoint(cwd);
		const before = JSON.stringify(parent);
		const source = resumeSourceAfterOwnerExit(parent, { cwd, inspectProcess: () => "dead" });
		assert.ok(source.ok);
		const child = forkRunForResume(source.value, { cwd, host: "pi" });
		assert.equal(child.parentRunId, parent.runId);
		assert.notEqual(child.runId, parent.runId);
		assert.equal(child.foregroundOwner, undefined);
		assert.equal(child.foregroundInterruption?.kind, "approval-owner-exit");
		assert.equal(JSON.stringify(parent), before);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("orphan resume: alive, EPERM, other errors and same PID remain closed", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-owner-"));
	try {
		for (const code of [undefined, "EPERM", "EACCES", "EIO", "EINVAL"]) {
			const parent = checkpoint(cwd);
			const before = JSON.stringify(parent);
			const source = resumeSourceAfterOwnerExit(parent, { cwd, inspectProcess: (pid) => probeProcess(pid, () => {
				if (code) throw Object.assign(new Error("unobservable"), { code });
			}) });
			assert.equal(source.ok, false, String(code));
			assert.equal(JSON.stringify(parent), before);
		}
		const parent = checkpoint(cwd);
		parent.foregroundOwner!.pid = process.pid;
		parent.foregroundOwner!.instanceId = "different-opaque-token";
		assert.equal(resumeSourceAfterOwnerExit(parent, { cwd, inspectProcess: () => assert.fail("same PID is not death proof") }).ok, false);
		assert.equal(resumeSourceAfterOwnerExit(checkpoint(cwd), { cwd, inspectProcess: () => { throw new Error("unexpected"); } }).ok, false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("orphan resume: malformed owner and missing checkpoint/root evidence are rejected before probing", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-owner-"));
	try {
		for (const patch of [
			{ foregroundOwner: undefined },
			...[0, -1, 1.5, 2147483648, NaN].map((pid) => ({ foregroundOwner: { ...checkpoint(cwd).foregroundOwner!, pid } })),
			{ invocationRootSnapshot: undefined },
			{ foregroundOwner: { ...checkpoint(cwd).foregroundOwner!, approvalWait: undefined } },
			{ foregroundOwner: { ...checkpoint(cwd).foregroundOwner!, instanceId: "" } },
			{ foregroundOwner: { ...checkpoint(cwd).foregroundOwner!, approvalWait: ["missing"] } },
		]) {
			assert.equal(resumeSourceAfterOwnerExit({ ...checkpoint(cwd), ...patch }, { cwd, inspectProcess: () => assert.fail("invalid evidence must not probe") }).ok, false);
		}
		const inflight = checkpoint(cwd);
		inflight.def.phases.push({ id: "writer", type: "script", run: "sleep 10" });
		inflight.phases.writer = { id: "writer", status: "running" };
		assert.equal(resumeSourceAfterOwnerExit(inflight, { cwd, inspectProcess: () => "dead" }).ok, false);
		inflight.foregroundOwner!.approvalWait = ["review", "writer"];
		assert.equal(resumeSourceAfterOwnerExit(inflight, { cwd, inspectProcess: () => "dead" }).ok, false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("orphan resume: physical root replacement/different project rejects, canonical alias accepts", { skip: process.platform === "win32" }, () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-owner-"));
	const other = mkdtempSync(join(tmpdir(), "pi-other-"));
	const alias = `${cwd}-alias`;
	try {
		const parent = checkpoint(cwd);
		assert.equal(resumeSourceAfterOwnerExit(parent, { cwd: other, inspectProcess: () => "dead" }).ok, false);
		symlinkSync(cwd, alias);
		assert.equal(resumeSourceAfterOwnerExit(parent, { cwd: alias, inspectProcess: () => "dead" }).ok, true);
		renameSync(cwd, `${cwd}-old`);
		mkdirSync(cwd);
		assert.equal(resumeSourceAfterOwnerExit(parent, { cwd, inspectProcess: () => "dead" }).ok, false, "same lexical path with replacement directory must reject");
		rmSync(cwd, { recursive: true });
		renameSync(`${cwd}-old`, cwd);
		parent.invocationRootSnapshot!.inode = "different-inode";
		assert.equal(resumeSourceAfterOwnerExit(parent, { cwd, inspectProcess: () => "dead" }).ok, false);
		assert.equal(resumeSourceAfterOwnerExit(checkpoint(cwd), { cwd: join(cwd, "gone"), inspectProcess: () => "dead" }).ok, false);
	} finally { rmSync(alias, { force: true }); rmSync(cwd, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test("orphan resume: old failed/paused override repair stays compatible, terminal stays rejected", () => {
	for (const status of ["failed", "paused", "completed", "blocked"] as const) {
		const parent = checkpoint("/unused");
		parent.status = status;
		delete parent.foregroundOwner;
		const source = resumeSourceAfterOwnerExit(parent, { cwd: "/unused", inspectProcess: () => assert.fail("normal history requires no owner probe") });
		assert.ok(source.ok);
		if (status === "failed" || status === "paused") assert.ok(forkRunForResume(source.value, { host: "pi" }));
		else assert.throws(() => forkRunForResume(source.value), /not resumable/);
	}
});

test("orphan resume: graph must block future siblings before a durable approval marker is valid", () => {
	const parent = checkpoint("/unused");
	parent.def.phases.push({ id: "writer", type: "script", run: "sleep 10" });
	assert.equal(isQuiescentApprovalCheckpoint(parent, ["review"]), false, "not-yet-started runnable child invalidates quiescence");
	parent.def.phases[1].dependsOn = ["review"];
	assert.equal(isQuiescentApprovalCheckpoint(parent, ["review"]), true);
	parent.def.phases[1].join = "any";
	assert.equal(isQuiescentApprovalCheckpoint(parent, ["review"]), false, "any-join cannot prove mandatory approval blocking");
});

test("orphan resume: timed approval cannot prove quiescence even with a saved waiting marker", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-timed-owner-"));
	try {
		for (const onExpire of ["approve", "reject", "fail"] as const) {
			const parent = checkpoint(cwd);
			parent.def.phases[0].timeoutMs = 1000;
			parent.def.phases[0].onExpire = onExpire;
			assert.equal(isQuiescentApprovalCheckpoint(parent, ["review"]), false, onExpire);
			assert.equal(resumeSourceAfterOwnerExit(parent, { cwd, inspectProcess: () => assert.fail("timed marker must reject before probing") }).ok, false);
		}
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("Pi checkpoint: same-layer runnable child prevents approval recovery even before its start", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-parallel-checkpoint-"));
	try {
		let registered: ToolDefinition | undefined;
		registerTaskflow({ on() {}, registerCommand() {}, registerTool(t: ToolDefinition) { if (t.name === "taskflow") registered = t; } } as unknown as ExtensionAPI);
		assert.ok(registered);
		let checkpoint: RunState | undefined;
		await registered.execute("checkpoint", { action: "run", define: { name: "parallel-checkpoint", concurrency: 2, phases: [
			{ id: "review", type: "approval", task: "Hold" },
			{ id: "writer", type: "script", run: "sleep 0.1; printf OTHER" },
		] } }, undefined, undefined, { cwd, mode: "rpc", hasUI: true, ui: {
			notify() {}, async select() { checkpoint = listRuns(cwd)[0]; return "Approve"; },
		} } as unknown as ExtensionToolContext);
		assert.ok(checkpoint);
		assert.equal(checkpoint.foregroundOwner?.approvalWait, undefined);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
