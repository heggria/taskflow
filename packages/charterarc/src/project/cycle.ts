import {
	directoryIdentity,
	executeTaskflow,
	newRunId,
	type RunState,
	type Taskflow,
} from "taskflow-core";
import { defineProject } from "./define.ts";
import { assertOnlyKeys, fail, isRecord, requiredText } from "./internal.ts";
import type {
	FlowRunResult,
	ObservationResult,
	ObservationStatus,
	ProjectDefinition,
	ProjectOutcome,
	ProjectRuntime,
} from "./types.ts";

const DEFAULT_OBSERVE_TIMEOUT_MS = 30_000;
const OBSERVATION_KEYS = ["status", "summary"] as const;
const OBSERVATION_STATUSES = new Set<ObservationStatus>(["satisfied", "drifted", "unknown"]);

function normalizeObservation(value: ObservationResult): ObservationResult {
	if (!isRecord(value)) fail("observer", "must return a plain object");
	assertOnlyKeys(value, OBSERVATION_KEYS, "observer");
	if (!OBSERVATION_STATUSES.has(value.status)) {
		fail("observer.status", "must be satisfied, drifted, or unknown");
	}
	const summary =
		value.summary === undefined ? undefined : requiredText(value.summary, "observer.summary");
	return {
		status: value.status,
		...(summary === undefined ? {} : { summary }),
	};
}

function observeTimeoutMs(deps: Pick<ProjectRuntime, "observeTimeoutMs">): number {
	const timeout = deps.observeTimeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS;
	if (!Number.isFinite(timeout) || timeout < 1) {
		throw new TypeError("CHARTERARC_INVALID_OBSERVE_TIMEOUT: must be a finite number >= 1");
	}
	return timeout;
}

function observationErrorSummary(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.trim() || "observer failed";
}

async function observeProject(
	project: ProjectDefinition,
	deps: ProjectRuntime,
): Promise<ObservationResult> {
	const controller = new AbortController();
	const timeout = observeTimeoutMs(deps);
	const parentSignal = deps.taskflow.signal;
	const onParentAbort = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) onParentAbort();
	else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error(`observer timed out after ${timeout}ms`)),
		timeout,
	);

	try {
		controller.signal.throwIfAborted();
		const result = await Promise.race([
			project.observe({
				cwd: deps.taskflow.cwd,
				signal: controller.signal,
			}),
			new Promise<never>((_resolve, reject) => {
				const rejectOnAbort = () =>
					reject(
						controller.signal.reason instanceof Error
							? controller.signal.reason
							: new Error("observer was aborted"),
					);
				if (controller.signal.aborted) rejectOnAbort();
				else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
			}),
		]);
		// An observer may resolve from its abort callback before the competing
		// rejection microtask wins. Abort never authorizes evidence or mutation.
		controller.signal.throwIfAborted();
		return normalizeObservation(result);
	} catch (error) {
		return {
			status: "unknown",
			summary: observationErrorSummary(error),
		};
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onParentAbort);
	}
}

async function executeMaintenance(
	taskflow: Taskflow,
	args: Record<string, unknown>,
	runtime: ProjectRuntime["taskflow"],
): Promise<FlowRunResult> {
	const now = Date.now();
	const state: RunState = {
		runId: newRunId(taskflow.name),
		flowName: taskflow.name,
		def: taskflow,
		args,
		status: "running",
		phases: {},
		createdAt: now,
		updatedAt: now,
		cwd: runtime.cwd,
		invocationRootSnapshot: directoryIdentity(runtime.cwd),
	};
	const result = await executeTaskflow(state, runtime);
	// Mirror Taskflow's runner→deps lift so outcome surfaces the same accounting mode
	// the engine used (deps.usageAccounting, else runTask.usageAccounting).
	const runnerUsageAccounting = (
		runtime.runTask as
			| (NonNullable<ProjectRuntime["taskflow"]["runTask"]> & {
					usageAccounting?: ProjectRuntime["taskflow"]["usageAccounting"];
			  })
			| undefined
	)?.usageAccounting;
	const usageAccounting = runtime.usageAccounting ?? runnerUsageAccounting;
	return {
		ok: result.ok,
		finalOutput: result.finalOutput,
		usage: result.totalUsage,
		...(usageAccounting !== undefined ? { usageAccounting } : {}),
	};
}

export async function runProject(
	project: ProjectDefinition,
	deps: ProjectRuntime,
): Promise<ProjectOutcome> {
	// ProjectDefinition is structurally public, so callers can bypass
	// defineProject() or mutate their object while an observer is awaiting.
	// Re-validate the raw object so a second project identity (e.g. `name`) is
	// rejected the same way as defineProject — do not silently strip keys.
	const stableProject = defineProject(project);
	// Keep observation, execution, and re-observation on the same cwd and host
	// bindings even if the caller mutates its runtime object while observing.
	const cwd = deps.taskflow.cwd;
	const stableRuntime: ProjectRuntime = {
		observeTimeoutMs: deps.observeTimeoutMs,
		taskflow: {
			...deps.taskflow,
			cwd: directoryIdentity(cwd)?.canonicalPath ?? cwd,
		},
	};
	const before = await observeProject(stableProject, stableRuntime);
	if (before.status === "satisfied") {
		return {
			status: "satisfied",
			ok: true,
			before,
		};
	}
	if (before.status === "unknown") {
		return {
			status: "unknown",
			ok: false,
			before,
		};
	}
	const args = {
		charterarc: {
			project: stableProject.maintain.name,
			desired: stableProject.desired,
			observation: before,
		},
	};

	let run: FlowRunResult;
	try {
		run = await executeMaintenance(stableProject.maintain, args, stableRuntime.taskflow);
	} catch (error) {
		run = {
			ok: false,
			finalOutput: error instanceof Error ? error.message : String(error),
		};
	}
	const after = await observeProject(stableProject, stableRuntime);
	return {
		status: after.status,
		// Fail-closed: observed satisfaction is not enough if the Run failed.
		ok: after.status === "satisfied" && run.ok,
		before,
		run,
		after,
	};
}
