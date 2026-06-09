/**
 * Tests for isTransientError() — the heuristic that decides whether a failed
 * subagent result should be retried (rate limits, overload, timeouts, 5xx).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientError, type RunResult } from "../extensions/runner.ts";
import { emptyUsage } from "../extensions/usage.ts";

function mkResult(overrides: Partial<RunResult> = {}): RunResult {
	return {
		agent: "a",
		task: "t",
		exitCode: 0,
		output: "ok",
		stderr: "",
		usage: emptyUsage(),
		stopReason: "end",
		...overrides,
	};
}

// ── Positive cases: should be transient ─────────────────────────────

test("isTransientError: rate limit in errorMessage", () => {
	assert.equal(isTransientError(mkResult({ errorMessage: "rate limit exceeded" })), true);
	assert.equal(isTransientError(mkResult({ errorMessage: "Rate_Limit hit" })), true);
	assert.equal(isTransientError(mkResult({ errorMessage: "too many requests" })), true);
});

test("isTransientError: HTTP 429/502/503/504 in any field", () => {
	assert.equal(isTransientError(mkResult({ stderr: "HTTP 429 Too Many Requests" })), true);
	assert.equal(isTransientError(mkResult({ output: "502 Bad Gateway" })), true);
	assert.equal(isTransientError(mkResult({ errorMessage: "503 Service Unavailable" })), true);
	assert.equal(isTransientError(mkResult({ stderr: "504 Gateway Timeout" })), true);
});

test("isTransientError: overloaded / service unavailable", () => {
	assert.equal(isTransientError(mkResult({ errorMessage: "server overloaded" })), true);
	assert.equal(isTransientError(mkResult({ stderr: "service temporarily unavailable" })), true);
	assert.equal(isTransientError(mkResult({ output: "Service Unavailable" })), true);
});

test("isTransientError: timeout variants", () => {
	assert.equal(isTransientError(mkResult({ errorMessage: "connection timeout" })), true);
	assert.equal(isTransientError(mkResult({ stderr: "request timed out" })), true);
	assert.equal(isTransientError(mkResult({ errorMessage: "ETIMEDOUT" })), true);
	assert.equal(isTransientError(mkResult({ stderr: "ECONNRESET" })), true);
	assert.equal(isTransientError(mkResult({ errorMessage: "socket hang up" })), true);
});

test("isTransientError: scans across errorMessage + stderr + output", () => {
	// The heuristic concatenates all three fields — a hit in any one is enough.
	assert.equal(isTransientError(mkResult({ errorMessage: "boom", stderr: "", output: "429 rate limit" })), true);
	assert.equal(isTransientError(mkResult({ errorMessage: "", stderr: "overloaded", output: "" })), true);
});

// ── Negative cases: should NOT be transient ─────────────────────────

test("isTransientError: abort is never transient (user-initiated)", () => {
	assert.equal(isTransientError(mkResult({ stopReason: "aborted", errorMessage: "rate limit" })), false);
});

test("isTransientError: hard errors are not transient", () => {
	assert.equal(isTransientError(mkResult({ errorMessage: "Unknown agent: foo" })), false);
	assert.equal(isTransientError(mkResult({ stderr: "syntax error in task" })), false);
	assert.equal(isTransientError(mkResult({ exitCode: 1, output: "validation failed" })), false);
});

test("isTransientError: empty/normal results are not transient", () => {
	assert.equal(isTransientError(mkResult()), false);
	assert.equal(isTransientError(mkResult({ errorMessage: "" })), false);
	assert.equal(isTransientError(mkResult({ stderr: "" })), false);
});

test("isTransientError: 400/401/403/404 are client errors, not transient", () => {
	assert.equal(isTransientError(mkResult({ errorMessage: "400 Bad Request" })), false);
	assert.equal(isTransientError(mkResult({ stderr: "401 Unauthorized" })), false);
	assert.equal(isTransientError(mkResult({ errorMessage: "403 Forbidden" })), false);
	assert.equal(isTransientError(mkResult({ stderr: "404 Not Found" })), false);
});

test("isTransientError: 'timeout' as substring of a non-transient message is still detected", () => {
	// The regex matches 'timeout' anywhere — this is intentional (fail-retry
	// is safer than fail-permanently when in doubt).
	assert.equal(isTransientError(mkResult({ errorMessage: "Operation timeout during auth" })), true);
});
