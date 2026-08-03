import {
	collectRefs,
	validateTaskflow,
	verifyTaskflow,
	type Taskflow,
} from "taskflow-core";
import { assertOnlyKeys, deepFreeze, fail, isRecord } from "./internal.ts";
import type {
	ModuleDefinition,
	ProjectDefinition,
} from "./types.ts";

const PROJECT_KEYS = ["desired", "observe", "maintain", "modules"] as const;
const MODULE_KEYS = ["desired", "maintain"] as const;

function isSingleTaskflow(value: unknown): value is Taskflow {
	return isRecord(value) && Array.isArray(value.phases);
}

function assertValidFlow(flow: unknown, label: string): Taskflow {
	const validation = validateTaskflow(flow);
	if (!validation.ok) {
		fail(label, `invalid Taskflow: ${validation.errors.join("; ")}`);
	}
	const taskflow = flow as Taskflow;
	const verification = verifyTaskflow(taskflow);
	if (!verification.ok) {
		const detail = verification.issues.map((issue) => issue.message).join("; ") || "failed";
		fail(label, `static verification failed: ${detail}`);
	}
	const ids = new Set(taskflow.phases.map((phase) => phase.id));
	for (const phase of taskflow.phases) {
		for (const ref of collectRefs(phase).steps) {
			if (!ids.has(ref)) {
				fail(
					label,
					`static verification failed: phase '${phase.id}' references unknown step '${ref}'`,
				);
			}
		}
	}
	return structuredClone(taskflow);
}

function normalizeDesiredMap(
	value: unknown,
	label: string,
): Record<string, string> {
	if (!isRecord(value)) {
		fail(
			label,
			"must be a plain object of non-empty strings (removed single-Flow string form is not accepted)",
		);
	}
	const out: Record<string, string> = {};
	for (const [key, text] of Object.entries(value)) {
		if (typeof text !== "string" || text.trim() === "") {
			fail(`${label}.${key}`, "must be a non-empty string");
		}
		out[key] = text.trim();
	}
	return out;
}

function normalizeFlowMap(
	value: unknown,
	label: string,
): Record<string, Taskflow> {
	if (!isRecord(value) || isSingleTaskflow(value)) {
		fail(
			label,
			"must be a plain object of Taskflows (removed single-Flow Taskflow form is not accepted)",
		);
	}
	const out: Record<string, Taskflow> = {};
	for (const [key, flow] of Object.entries(value)) {
		out[key] = assertValidFlow(flow, `${label}.${key}`);
	}
	return out;
}

function assertMatchingKeys(
	desired: Readonly<Record<string, string>>,
	maintain: Readonly<Record<string, Taskflow>>,
	label: string,
): void {
	const desiredKeys = Object.keys(desired).sort();
	const maintainKeys = Object.keys(maintain).sort();
	if (
		desiredKeys.length !== maintainKeys.length ||
		desiredKeys.some((key, index) => key !== maintainKeys[index])
	) {
		fail(label, "desired and maintain keys must match exactly");
	}
}

function normalizeModule(value: unknown, label: string): ModuleDefinition {
	if (!isRecord(value)) fail(label, "must be a plain object");
	assertOnlyKeys(value, MODULE_KEYS, label);
	const desired = normalizeDesiredMap(value.desired, `${label}.desired`);
	const maintain = normalizeFlowMap(value.maintain, `${label}.maintain`);
	assertMatchingKeys(desired, maintain, label);
	return { desired, maintain };
}

function normalizeModules(
	value: unknown,
): Readonly<Record<string, ModuleDefinition>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) fail("project.modules", "must be a plain object");
	const out: Record<string, ModuleDefinition> = {};
	for (const [key, module] of Object.entries(value)) {
		out[key] = normalizeModule(module, `project.modules.${key}`);
	}
	return out;
}

export function defineProject(value: ProjectDefinition): ProjectDefinition {
	if (!isRecord(value)) fail("project", "must be a plain object");
	assertOnlyKeys(value, PROJECT_KEYS, "project");
	if (typeof value.observe !== "function") fail("project.observe", "must be a function");

	// Reject the removed single-Flow form explicitly (string desired and/or one Taskflow).
	if (typeof value.desired === "string") {
		fail(
			"project.desired",
			"must be a plain object of non-empty strings (removed single-Flow string form is not accepted)",
		);
	}
	if (isSingleTaskflow(value.maintain)) {
		fail(
			"project.maintain",
			"must be a plain object of Taskflows (removed single-Flow Taskflow form is not accepted)",
		);
	}

	const modules = normalizeModules(
		"modules" in value ? value.modules : undefined,
	);
	const desired = normalizeDesiredMap(value.desired, "project.desired");
	const maintain = normalizeFlowMap(value.maintain, "project.maintain");
	assertMatchingKeys(desired, maintain, "project");

	const normalized: ProjectDefinition = {
		desired,
		observe: value.observe,
		maintain,
		...(modules === undefined ? {} : { modules }),
	};
	return deepFreeze(normalized);
}
