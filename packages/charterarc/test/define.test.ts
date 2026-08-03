import assert from "node:assert/strict";
import { test } from "node:test";
import type { Taskflow } from "taskflow-core";
import {
	defineProject,
	type ProjectDefinition,
} from "../src/index.ts";

const maintenance: Taskflow = {
	name: "maintain-test-project",
	phases: [{ id: "repair", type: "agent", task: "repair", final: true }],
};

test("defineProject: reuses the maintenance Taskflow name instead of a second identity", () => {
	const observe = async () => ({ status: "satisfied" as const });
	const project = defineProject({
		desired: " main is releasable ",
		observe,
		maintain: maintenance,
	});

	assert.deepEqual(Object.keys(project).sort(), ["desired", "maintain", "observe"]);
	assert.equal(project.desired, "main is releasable");
	assert.equal(project.observe, observe);
	assert.equal(project.maintain.name, "maintain-test-project");
});

test("defineProject: rejects a non-function observer", () => {
	assert.throws(
		() =>
			defineProject({
				desired: "healthy",
				observe: ["git"],
				maintain: maintenance,
			} as never),
		/CHARTERARC_INVALID_PROJECT\.OBSERVE.*function/,
	);
});

test("defineProject: rejects unknown fields and invalid Taskflows", () => {
	assert.throws(
		() =>
			defineProject({
				desired: "healthy",
				observe: async () => ({ status: "satisfied" }),
				maintain: maintenance,
				extra: true,
			} as never),
		/unknown field 'extra'/,
	);
	assert.throws(
		() =>
			defineProject({
				desired: "healthy",
				observe: async () => ({ status: "satisfied" }),
				maintain: { name: "invalid", phases: [] },
			}),
		/invalid Taskflow/,
	);
	assert.throws(
		() =>
			defineProject({
				desired: "healthy",
				observe: async () => ({ status: "satisfied" }),
				maintain: {
					name: "not-detached",
					phases: [
						{ id: "x", task: "x", callback: () => undefined } as never,
					],
				},
			}),
	);
});

test("defineProject: rejects a second project identity instead of keeping a compatibility alias", () => {
	const legacyDeclaration = {
		// @ts-expect-error Project identity is the existing maintenance Taskflow name.
		name: "duplicate-project-name",
		desired: "healthy",
		observe: async () => ({ status: "satisfied" as const }),
		maintain: maintenance,
	} satisfies ProjectDefinition;

	assert.throws(
		() => defineProject(legacyDeclaration as never),
		/unknown field 'name'/,
	);
});
