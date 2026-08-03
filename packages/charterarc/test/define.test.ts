import assert from "node:assert/strict";
import { test } from "node:test";
import type { Taskflow } from "taskflow-core";
import { defineProject } from "../src/index.ts";

const maintenance: Taskflow = {
	name: "maintain-test-project",
	phases: [{ id: "repair", type: "agent", task: "repair", final: true }],
};

const observe = async () => ({
	status: "satisfied" as const,
	facts: { check: "passed" },
});

test("defineProject: normalizes one exact Project / optional Module / Flow surface", () => {
	const project = defineProject({
		desired: { release: " main is releasable " },
		observe,
		maintain: { release: maintenance },
		modules: {
			docs: {
				desired: { catalog: " docs stay complete " },
				maintain: { catalog: { ...maintenance, name: "maintain-docs" } },
			},
		},
	});

	assert.deepEqual(Object.keys(project).sort(), ["desired", "maintain", "modules", "observe"]);
	assert.equal(project.desired.release, "main is releasable");
	assert.equal(project.maintain.release?.name, "maintain-test-project");
	assert.equal(project.modules?.docs?.desired.catalog, "docs stay complete");
	assert.equal(project.modules?.docs?.maintain.catalog?.name, "maintain-docs");
	assert.equal(project.observe, observe);
	assert.equal(Object.isFrozen(project), true);
	assert.equal(Object.isFrozen(project.maintain.release), true);
});

test("defineProject: rejects a non-function observer", () => {
	assert.throws(
		() => defineProject({
			desired: { release: "healthy" },
			observe: ["git"],
			maintain: { release: maintenance },
		} as never),
		/CHARTERARC_INVALID_PROJECT\.OBSERVE.*function/,
	);
});

test("defineProject: rejects unknown fields, unmatched routes, and invalid Taskflows", () => {
	assert.throws(
		() => defineProject({
			desired: { release: "healthy" },
			observe,
			maintain: { release: maintenance },
			extra: true,
		} as never),
		/unknown field 'extra'/,
	);
	assert.throws(
		() => defineProject({
			desired: { release: "healthy" },
			observe,
			maintain: { tests: maintenance },
		}),
		/desired and maintain keys must match exactly/,
	);
	assert.throws(
		() => defineProject({
			desired: { release: "healthy" },
			observe,
			maintain: { release: { name: "invalid", phases: [] } },
		}),
		/invalid Taskflow/,
	);
	assert.throws(
		() => defineProject({
			desired: { release: "healthy" },
			observe,
			maintain: {
				release: {
					name: "not-detached",
					phases: [
						{ id: "x", task: "x", callback: () => undefined } as never,
					],
				},
			},
		}),
	);
});

test("defineProject: rejects the removed single-Flow form and a second project identity", () => {
	assert.throws(
		() => defineProject({
			desired: "healthy",
			observe,
			maintain: maintenance,
		} as never),
		/project\.desired.*plain object|removed single-Flow/i,
	);
	assert.throws(
		() => defineProject({
			name: "duplicate-project-name",
			desired: { release: "healthy" },
			observe,
			maintain: { release: maintenance },
		} as never),
		/unknown field 'name'/,
	);
});
