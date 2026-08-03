import { validateTaskflow } from "taskflow-core";
import { assertOnlyKeys, deepFreeze, fail, isRecord, requiredText } from "./internal.ts";
import type { ProjectDefinition } from "./types.ts";

const PROJECT_KEYS = ["desired", "observe", "maintain"] as const;

export function defineProject(value: ProjectDefinition): ProjectDefinition {
	if (!isRecord(value)) fail("project", "must be a plain object");
	assertOnlyKeys(value, PROJECT_KEYS, "project");
	const desired = requiredText(value.desired, "project.desired");
	if (typeof value.observe !== "function") fail("project.observe", "must be a function");

	const maintain = structuredClone(value.maintain);
	const validation = validateTaskflow(maintain);
	if (!validation.ok) {
		fail("project.maintain", `invalid Taskflow: ${validation.errors.join("; ")}`);
	}

	// Project identity is maintain.name only — no second project-level name field.
	const normalized: ProjectDefinition = {
		desired,
		observe: value.observe,
		maintain,
	};
	return deepFreeze(normalized);
}
