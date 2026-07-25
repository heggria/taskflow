import assert from "node:assert/strict";
import { test } from "node:test";
import {
	INITIAL_WEB_SESSION_LIFECYCLE_STATE,
	reduceWebSessionLifecycle,
	shouldSurfaceWebBootFailure,
} from "../src/session-lifecycle.ts";

test("session lifecycle: pending local scope is cleared only by its matching request", () => {
	const pending = reduceWebSessionLifecycle(
		INITIAL_WEB_SESSION_LIFECYCLE_STATE,
		{ type: "termination-started", scope: "all" },
	);
	assert.equal(pending.pendingScope, "all");
	assert.equal(
		reduceWebSessionLifecycle(pending, {
			type: "termination-cancelled",
			scope: "current",
		}),
		pending,
	);
	assert.deepEqual(
		reduceWebSessionLifecycle(pending, {
			type: "termination-cancelled",
			scope: "all",
		}),
		{},
	);
});

test("session lifecycle: successful revoke-all preserves its exact wider scope", () => {
	const pending = reduceWebSessionLifecycle(
		INITIAL_WEB_SESSION_LIFECYCLE_STATE,
		{ type: "termination-started", scope: "all" },
	);
	const terminated = reduceWebSessionLifecycle(pending, {
		type: "termination-succeeded",
		scope: "all",
	});
	assert.deepEqual(terminated, {
		terminatedScope: "all",
	});
	assert.deepEqual(
		reduceWebSessionLifecycle(terminated, {
			type: "unauthorized",
		}),
		{ terminatedScope: "all" },
	);
});

test("session lifecycle: 401 never upgrades an unconfirmed revoke-all intent", () => {
	const pending = reduceWebSessionLifecycle(
		INITIAL_WEB_SESSION_LIFECYCLE_STATE,
		{ type: "termination-started", scope: "all" },
	);
	assert.deepEqual(
		reduceWebSessionLifecycle(pending, {
			type: "unauthorized",
		}),
		{ terminatedScope: "current" },
	);
});

test("session lifecycle: later successful revoke-all upgrades a raced current-tab 401", () => {
	const unauthorized = reduceWebSessionLifecycle(
		INITIAL_WEB_SESSION_LIFECYCLE_STATE,
		{ type: "unauthorized" },
	);
	assert.deepEqual(
		reduceWebSessionLifecycle(unauthorized, {
			type: "termination-succeeded",
			scope: "all",
		}),
		{ terminatedScope: "all" },
	);
});

test("session lifecycle: cold-bootstrap 401 cannot be overwritten by generic boot failure", () => {
	const terminated = reduceWebSessionLifecycle(
		INITIAL_WEB_SESSION_LIFECYCLE_STATE,
		{ type: "unauthorized" },
	);
	assert.equal(shouldSurfaceWebBootFailure(terminated), false);
	assert.equal(
		shouldSurfaceWebBootFailure(
			INITIAL_WEB_SESSION_LIFECYCLE_STATE,
		),
		true,
	);
});
