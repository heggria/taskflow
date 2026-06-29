import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCacheScope } from "../src/index.ts";

// The `incremental` flag (flow-level def.incremental, or the invocation-level
// override) maps to the run-wide default cache scope. Default is the safe
// run-only (cross-run reuse is opt-in); the invocation override wins over the
// flow setting. This pins the C-option contract: capability given, default
// NOT flipped.

test("resolveCacheScope: default (neither set) is run-only — safe, no flip", () => {
	assert.equal(resolveCacheScope(undefined, undefined), "run-only");
});

test("resolveCacheScope: flow.incremental=true opts the whole flow into cross-run", () => {
	assert.equal(resolveCacheScope(undefined, true), "cross-run");
});

test("resolveCacheScope: flow.incremental=false stays run-only", () => {
	assert.equal(resolveCacheScope(undefined, false), "run-only");
});

test("resolveCacheScope: invocation override wins over the flow setting", () => {
	// override=true beats flow=false
	assert.equal(resolveCacheScope(true, false), "cross-run");
	// override=false beats flow=true (lets a user force a fresh run)
	assert.equal(resolveCacheScope(false, true), "run-only");
});

test("resolveCacheScope: override undefined falls back to the flow setting", () => {
	assert.equal(resolveCacheScope(undefined, true), "cross-run");
	assert.equal(resolveCacheScope(undefined, false), "run-only");
});
