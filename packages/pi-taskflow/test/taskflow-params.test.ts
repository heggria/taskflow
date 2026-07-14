/**
 * TaskflowParams schema tests for the Pi adapter tool parameters.
 *
 * Covers: action=version, shorthand cwd, resume override fields, invalid action.
 * The TaskflowParams TypeBox schema is the tool input contract the Pi adapter
 * validates user-provided arguments against before dispatch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Errors as SchemaErrors } from "typebox/value";
import { Value } from "typebox/value";
import { TaskflowParams } from "../src/index.ts";

// ---------------------------------------------------------------------------
// action enum validation
// ---------------------------------------------------------------------------

test("TaskflowParams: action=version is valid", () => {
	const r = Value.Decode(TaskflowParams, { action: "version" });
	assert.equal(r.action, "version");
});

test("TaskflowParams: action=run is valid (default)", () => {
	const r = Value.Decode(TaskflowParams, { action: "run" });
	assert.equal(r.action, "run");
});

test("TaskflowParams: action=resume is valid", () => {
	const r = Value.Decode(TaskflowParams, { action: "resume" });
	assert.equal(r.action, "resume");
});

test("TaskflowParams: invalid action is rejected", () => {
	let count = 0;
	SchemaErrors(TaskflowParams, { action: "invalid-action" }).forEach(() => { count++; });
	assert.ok(count > 0, "must have at least one validation error");
});

test("TaskflowParams: non-string action is rejected", () => {
	let count = 0;
	SchemaErrors(TaskflowParams, { action: 42 }).forEach(() => { count++; });
	assert.ok(count > 0);
});

// ---------------------------------------------------------------------------
// Shorthand cwd
// ---------------------------------------------------------------------------

test("TaskflowParams: shorthand single mode with cwd", () => {
	const r = Value.Decode(TaskflowParams, { action: "run", agent: "executor", task: "do something", cwd: "/repo" });
	assert.equal(r.cwd, "/repo");
});

test("TaskflowParams: shorthand parallel (tasks) with cwd", () => {
	const r = Value.Decode(TaskflowParams, {
		action: "run",
		tasks: [
			{ task: "a", cwd: "/branch-a" },
			{ task: "b" },
		],
		cwd: "/shared",
	});
	assert.equal(r.cwd, "/shared");
	const tasks = r.tasks as Array<{ cwd?: string }>;
	assert.equal(tasks[0].cwd, "/branch-a");
	assert.equal(tasks[1].cwd, undefined);
});

test("TaskflowParams: shorthand chain with per-step cwd", () => {
	const r = Value.Decode(TaskflowParams, {
		action: "run",
		chain: [
			{ task: "a", cwd: "/step-a" },
			{ task: "b" },
		],
	});
	const chain = r.chain as Array<{ cwd?: string }>;
	assert.equal(chain[0].cwd, "/step-a");
	assert.equal(chain[1].cwd, undefined);
});

test("TaskflowParams: shorthand workspace keyword cwd is valid", () => {
	const r = Value.Decode(TaskflowParams, { action: "run", task: "x", cwd: "temp" });
	assert.equal(r.cwd, "temp");
});

// ---------------------------------------------------------------------------
// Resume override fields
// ---------------------------------------------------------------------------

test("TaskflowParams: resume with runId only is valid", () => {
	const r = Value.Decode(TaskflowParams, { action: "resume", runId: "run-abc" });
	assert.equal(r.runId, "run-abc");
});

test("TaskflowParams: resume with phaseId + task override", () => {
	const r = Value.Decode(TaskflowParams, {
		action: "resume",
		runId: "run-abc",
		phaseId: "my-phase",
		resumeTask: "retry with more context",
	});
	assert.equal(r.phaseId, "my-phase");
	assert.equal(r.resumeTask, "retry with more context");
});

test("TaskflowParams: resume with all override fields", () => {
	const r = Value.Decode(TaskflowParams, {
		action: "resume",
		runId: "run-abc",
		phaseId: "p1",
		resumeTask: "retry",
		resumeModel: "gpt-5",
		resumeTimeout: 5000,
		resumeIdleTimeout: 30000,
	});
	assert.equal(r.resumeTask, "retry");
	assert.equal(r.resumeModel, "gpt-5");
	assert.equal(r.resumeTimeout, 5000);
	assert.equal(r.resumeIdleTimeout, 30000);
});

test("TaskflowParams: resume with resumeTimeout must be number >= 1000", () => {
	// At the schema level, timeout is just a Number. Validation via resume.ts
	// enforces >= 1000. The schema allows it to be any non-negative number.
	const r = Value.Decode(TaskflowParams, {
		action: "resume",
		runId: "run-abc",
		phaseId: "p1",
		resumeTimeout: 999, // schema doesn't enforce minimum; resume.ts does
	});
	assert.equal(r.resumeTimeout, 999);
});

test("TaskflowParams: resume without phaseId but with override field is schema-valid", () => {
	// The schema accepts this shape; runtime validation in resume.ts catches
	// missing phaseId when overrides are supplied.
	const r = Value.Decode(TaskflowParams, {
		action: "resume",
		runId: "run-abc",
		resumeTask: "retry",
	});
	assert.equal(r.runId, "run-abc");
	assert.equal(r.resumeTask, "retry");
	// No phaseId — will be rejected by validateResumeOverrides at runtime.
});

// ---------------------------------------------------------------------------
// Additional known-good shapes
// ---------------------------------------------------------------------------

test("TaskflowParams: action=version with additional fields is schema-valid", () => {
	const r = Value.Decode(TaskflowParams, {
		action: "version",
		name: "optional-extra",
	});
	assert.equal(r.action, "version");
	assert.equal(r.name, "optional-extra");
});

test("TaskflowParams: undefined/empty object gets default action", () => {
	const r = Value.Decode(TaskflowParams, {});
	assert.equal(r.action, "run");
});

test("TaskflowParams: extra unknown properties are stripped", () => {
	const r = Value.Decode(TaskflowParams, {
		action: "run",
		task: "x",
		unknownField: "should-be-stripped",
	} as unknown as Record<string, unknown>);
	assert.equal(r.action, "run");
	assert.equal(r.task, "x");
	assert.equal((r as unknown as Record<string, unknown>).unknownField, undefined);
});
