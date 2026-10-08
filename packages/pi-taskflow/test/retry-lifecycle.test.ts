import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RunOptions } from "taskflow-core";
import { createPiSubagentRunner, isFailed } from "../src/runner.ts";

const start = [{ type: "agent_start" }, { type: "turn_start" }];
const settled = { type: "agent_settled" };
const end = (willRetry?: boolean) => ({ type: "agent_end", willRetry });
const assistant = (text: string, stopReason = "stop", errorMessage?: string) => ({
	type: "message_end",
	message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, errorMessage },
});
const failure = assistant("", "error", "429 rate limit exceeded");
const retry = { type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 100, errorMessage: "429 rate limit exceeded" };

interface Batch { events: unknown[]; delay?: number }

async function runStream(batches: Batch[], opts: RunOptions = {}, leaky = true) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-retry-"));
	const entry = path.join(dir, "pi.mjs");
	fs.writeFileSync(entry, `#!${process.execPath}\n` +
		`const batches=${JSON.stringify(batches)};\n` +
		`for (const batch of batches) { if (batch.delay) await new Promise(r=>setTimeout(r,batch.delay)); for (const event of batch.events) process.stdout.write(JSON.stringify(event)+"\\n"); }\n` +
		(leaky ? `setInterval(()=>{},1000);\n` : ""));
	fs.chmodSync(entry, 0o755);
	const previous = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = entry;
	try {
		return await createPiSubagentRunner({ resourceProfile: "isolated", extensions: [], terminalGraceMs: 40 })
			.runTask(dir, [{ name: "test", description: "", systemPrompt: "", source: "user", filePath: "" }], "test", "retry", { idleTimeoutMs: 10_000, ...opts });
	} finally {
		if (previous === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("Pi retry: real failed message survives backoff and clears its error on successful recovery", async () => {
	const result = await runStream([
		{ events: [...start, failure, end(true), retry] },
		{ delay: 100, events: [...start, assistant("RECOVERED"), { type: "auto_retry_end", success: true, attempt: 1 }, end(false), settled] },
	]);
	assert.equal(isFailed(result), false);
	assert.equal(result.output, "RECOVERED");
	assert.equal(result.errorMessage, undefined);
	assert.equal(result.completionSource, "terminal-reap");
	assert.equal(result.usage.turns, 2);
});

test("Pi retry: legacy agent_end and clean exit can recover a failed attempt", async () => {
	const result = await runStream([
		{ events: [...start, failure, end(), retry] },
		{ delay: 80, events: [...start, assistant("LEGACY_RECOVERED"), end()] },
	], {}, false);
	assert.equal(isFailed(result), false);
	assert.equal(result.output, "LEGACY_RECOVERED");
	assert.equal(result.completionSource, "process-exit");
});

test("Pi retry: exhausted attempts remain failures even if Pi exits zero", async () => {
	const result = await runStream([
		{ events: [...start, failure, end(true), retry] },
		{ delay: 80, events: [...start, assistant("", "error", "503 retry exhausted"), end(false), { type: "auto_retry_end", success: false, finalError: "503 retry exhausted" }, settled] },
	], {}, false);
	assert.equal(isFailed(result), true);
	assert.match(result.errorMessage ?? "", /503 retry exhausted/);
	assert.equal(result.reapedAfterTerminal, undefined);
});

test("Pi retry: a final error at agent_settled stops a leaky process without waiting for idle timeout", async () => {
	const result = await runStream([{ events: [...start, assistant("", "error", "invalid API key"), end(false), settled] }]);
	assert.equal(isFailed(result), true);
	assert.match(result.errorMessage ?? "", /invalid API key/);
	assert.equal(result.idleTimeout, undefined);
});

test("Pi retry: legacy final error is retained on clean exit without settled", async () => {
	const result = await runStream([{ events: [...start, failure, end()] }], {}, false);
	assert.equal(isFailed(result), true);
	assert.match(result.errorMessage ?? "", /429 rate limit exceeded/);
});

test("Pi retry: overflow compaction can recover after agent_end willRetry false", async () => {
	const result = await runStream([
		{ events: [...start, assistant("", "error", "maximum context length exceeded"), end(false), { type: "compaction_start", reason: "overflow" }] },
		{ delay: 100, events: [{ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true }, ...start, assistant("COMPACTED"), end(false), settled] },
	]);
	assert.equal(isFailed(result), false);
	assert.equal(result.output, "COMPACTED");
});

test("Pi retry: retry exhaustion may still recover through overflow compaction", async () => {
	const result = await runStream([
		{ events: [...start, failure, end(true), retry] },
		{ delay: 80, events: [...start, assistant("", "error", "context overflow"), end(false), { type: "auto_retry_end", success: false, finalError: "context overflow" }, { type: "compaction_start", reason: "overflow" }] },
		{ delay: 80, events: [{ type: "compaction_end", willRetry: true }, ...start, assistant("COMPACTION_RECOVERY"), end(false), settled] },
	]);
	assert.equal(isFailed(result), false);
	assert.equal(result.output, "COMPACTION_RECOVERY");
});

for (const type of ["compaction_start", "auto_compaction_start", "auto_retry_start"]) {
	test(`Pi retry: ${type} revokes terminal grace before a later lifecycle`, async () => {
		const result = await runStream([
			{ events: [...start, assistant("STALE"), end(false), { type }] },
			{ delay: 100, events: [...start, assistant("LATEST"), end(false), settled] },
		]);
		assert.equal(isFailed(result), false);
		assert.equal(result.output, "LATEST");
	});
}

test("Pi retry: successful response survives non-retrying threshold compaction", async () => {
	const result = await runStream([
		{ events: [...start, assistant("COMPLETED"), end(false), { type: "compaction_start", reason: "threshold" }] },
		{ delay: 100, events: [{ type: "compaction_end", willRetry: false }, settled] },
	]);
	assert.equal(isFailed(result), false);
	assert.equal(result.output, "COMPLETED");
});

test("Pi retry: recovery through multiple tool-use turns clears old errors", async () => {
	const result = await runStream([
		{ events: [...start, failure, end(true), retry] },
		{ delay: 80, events: [...start, assistant("WORKING", "toolUse"), { type: "auto_retry_end", success: true },
			{ type: "tool_execution_start" }, { type: "message_end", message: { role: "toolResult", content: [], usage: { output: 10, cost: { total: 0.5 } } } },
			{ type: "turn_start" }, assistant("STILL_WORKING", "toolUse"), { type: "tool_execution_end" }, { type: "turn_start" }, assistant("DONE"), end(false), settled] },
	]);
	assert.equal(isFailed(result), false);
	assert.equal(result.output, "DONE");
	assert.equal(result.usage.turns, 4);
});

test("Pi retry: host cancellation during backoff stays an abort", async () => {
	const controller = new AbortController();
	const result = await runStream([{ events: [...start, assistant("BACKOFF", "error", "429 rate limit exceeded"), end(true), retry] }], {
		signal: controller.signal,
		onLive: () => setTimeout(() => controller.abort(), 20),
	});
	assert.equal(isFailed(result), true);
	assert.equal(result.stopReason, "aborted");
	assert.equal(result.completionSource, "abort");
});

test("Pi retry: missing recovery remains bounded by the idle watchdog", async () => {
	let sawFailure = false;
	const result = await runStream([{ events: [...start, failure, end(true), retry] }], {
		idleTimeoutMs: 2000,
		onLive: () => { sawFailure = true; },
	});
	assert.equal(sawFailure, true, "the watchdog must expire during backoff, after the failed attempt was observed");
	assert.equal(isFailed(result), true);
	assert.equal(result.completionSource, "idle-timeout");
	assert.equal(result.idleTimeout, true);
});

test("Pi retry: explicit protocol errors and aborted assistant messages remain immediately fatal", async () => {
	for (const event of [{ type: "error", message: "explicit failure" }, assistant("", "aborted", "aborted by Pi")]) {
		const result = await runStream([{ events: [...start, event] }]);
		assert.equal(isFailed(result), true);
		assert.equal(result.idleTimeout, undefined);
		assert.match(result.errorMessage ?? "", /explicit failure|aborted by Pi/);
	}
});


for (const prefix of ["compaction", "auto_compaction"]) {
	for (const reason of ["threshold", "overflow"]) {
		test(`Pi retry: legacy ${prefix} ${reason} without retry preserves a successful clean exit`, async () => {
			// Pi 0.80.3 CLI emits agent_end(false), then compaction_start/end,
			// and exits cleanly. It has no agent_settled event.
			const result = await runStream([
				{ events: [...start, assistant("LEGACY_COMPLETED"), end(false), { type: `${prefix}_start`, reason }] },
				{ delay: 100, events: [{ type: `${prefix}_end`, reason, aborted: false, willRetry: false }] },
			], {}, false);
			assert.equal(isFailed(result), false);
			assert.equal(result.output, "LEGACY_COMPLETED");
			assert.equal(result.completionSource, "process-exit");
		});
	}
	test(`Pi retry: legacy ${prefix} announcing retry cannot retain a stale successful answer`, async () => {
		const result = await runStream([
			{ events: [...start, assistant("STALE"), end(false), { type: `${prefix}_start`, reason: "overflow" }] },
			{ delay: 100, events: [{ type: `${prefix}_end`, reason: "overflow", aborted: false, willRetry: true }] },
		], {}, false);
		assert.equal(isFailed(result), true);
		assert.equal(result.reapedAfterTerminal, undefined);
	});
}
