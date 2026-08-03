import {
	directoryIdentity,
	executeTaskflow,
	newRunId,
	verifyTaskflow,
	type RunState,
	type Taskflow,
} from "taskflow-core";
import type {
	FlowRunResult,
	FlowSelection,
	ObservationResult,
	ProjectDefinition,
	ProjectOutcome,
	ProjectRuntime,
} from "../../src/project/types.ts";

const DEFAULT_OBSERVE_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownSnapshot(value: unknown, summary?: string): ObservationResult {
	const facts = isRecord(value) && isRecord(value.facts) ? value.facts : {};
	return {
		status: "unknown",
		facts,
		...(summary === undefined ? {} : { summary }),
	};
}

function normalizeSnapshot(value: unknown): ObservationResult {
	if (!isRecord(value)) return unknownSnapshot(value);
	if (Object.keys(value).some((key) => !["status", "facts", "summary", "target"].includes(key))) {
		return unknownSnapshot(value);
	}
	if (!isRecord(value.facts)) return unknownSnapshot(value);
	if (value.summary !== undefined && (typeof value.summary !== "string" || value.summary.trim() === "")) {
		return unknownSnapshot(value);
	}
	const summary = value.summary as string | undefined;
	if (value.status === "satisfied" || value.status === "unknown") {
		if (value.target !== undefined) return unknownSnapshot(value, summary);
		return { status: value.status, facts: value.facts, ...(summary === undefined ? {} : { summary }) };
	}
	if (value.status !== "drifted" || !isRecord(value.target)) {
		return unknownSnapshot(value, summary);
	}
	if (Object.keys(value.target).some((key) => !["desired", "module"].includes(key))) {
		return unknownSnapshot(value, summary);
	}
	if (typeof value.target.desired !== "string" || value.target.desired.trim() === "") {
		return unknownSnapshot(value, summary);
	}
	if (
		value.target.module !== undefined &&
		(typeof value.target.module !== "string" || value.target.module.trim() === "")
	) {
		return unknownSnapshot(value, summary);
	}
	return {
		status: "drifted",
		facts: value.facts,
		target: {
			desired: value.target.desired.trim(),
			...(value.target.module === undefined ? {} : { module: value.target.module.trim() }),
		},
		...(summary === undefined ? {} : { summary }),
	};
}

async function observe(
	project: ProjectDefinition,
	runtime: ProjectRuntime,
): Promise<ObservationResult> {
	const controller = new AbortController();
	const parentSignal = runtime.taskflow.signal;
	const onParentAbort = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) onParentAbort();
	else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
	const timeoutMs = runtime.observeTimeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS;
	const timer = setTimeout(
		() => controller.abort(new Error(`observer timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	try {
		controller.signal.throwIfAborted();
		const value = await Promise.race([
			project.observe({ cwd: runtime.taskflow.cwd, signal: controller.signal }),
			new Promise<never>((_resolve, reject) => {
				const onAbort = () => reject(
					controller.signal.reason instanceof Error
						? controller.signal.reason
						: new Error("observer aborted"),
				);
				if (controller.signal.aborted) onAbort();
				else controller.signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
		controller.signal.throwIfAborted();
		return normalizeSnapshot(value);
	} catch (error) {
		return unknownSnapshot(
			undefined,
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onParentAbort);
	}
}

function select(
	project: ProjectDefinition,
	snapshot: ObservationResult,
): { selection: FlowSelection; flow: Taskflow; desired: string } | undefined {
	if (snapshot.status !== "drifted") return undefined;
	const scope = snapshot.target.module === undefined
		? project
		: project.modules?.[snapshot.target.module];
	if (scope === undefined) return undefined;
	const flow = scope.maintain[snapshot.target.desired];
	const desired = scope.desired[snapshot.target.desired];
	if (flow === undefined || desired === undefined) return undefined;
	return {
		selection: {
			desired: snapshot.target.desired,
			flow: flow.name,
			...(snapshot.target.module === undefined ? {} : { module: snapshot.target.module }),
		},
		flow,
		desired,
	};
}

async function execute(
	flow: Taskflow,
	args: Record<string, unknown>,
	runtime: ProjectRuntime["taskflow"],
): Promise<FlowRunResult> {
	const now = Date.now();
	const state: RunState = {
		runId: newRunId(flow.name),
		flowName: flow.name,
		def: flow,
		args,
		status: "running",
		phases: {},
		createdAt: now,
		updatedAt: now,
		cwd: runtime.cwd,
		invocationRootSnapshot: directoryIdentity(runtime.cwd),
	};
	const result = await executeTaskflow(state, runtime);
	return {
		ok: result.ok,
		finalOutput: result.finalOutput,
		usage: result.totalUsage,
	};
}

/**
 * Deliberately favorable plain-Taskflow comparison: it reuses CharterArc's
 * declaration types and omits declaration validation, cloning, and freezing.
 * A real copy in each consumer would still own every branch below.
 */
export async function runPlainTaskflowProject(
	project: ProjectDefinition,
	runtime: ProjectRuntime,
): Promise<ProjectOutcome> {
	const canonicalCwd = directoryIdentity(runtime.taskflow.cwd)?.canonicalPath ?? runtime.taskflow.cwd;
	const stableRuntime: ProjectRuntime = {
		observeTimeoutMs: runtime.observeTimeoutMs,
		taskflow: { ...runtime.taskflow, cwd: canonicalCwd },
	};
	const before = await observe(project, stableRuntime);
	if (before.status === "satisfied") return { status: "satisfied", ok: true, before };
	if (before.status === "unknown") return { status: "unknown", ok: false, before };

	const selected = select(project, before);
	if (selected === undefined || !verifyTaskflow(selected.flow).ok) {
		return {
			status: "unknown",
			ok: false,
			before: unknownSnapshot(before, "selected Flow is missing or failed static verification"),
		};
	}

	const args = {
		charterarc: {
			selection: selected.selection,
			desired: selected.desired,
			snapshot: before,
		},
	};
	let run: FlowRunResult;
	try {
		run = await execute(selected.flow, args, stableRuntime.taskflow);
	} catch (error) {
		run = {
			ok: false,
			finalOutput: error instanceof Error ? error.message : String(error),
		};
	}
	const after = await observe(project, stableRuntime);
	return {
		status: after.status,
		ok: after.status === "satisfied" && run.ok,
		before,
		run,
		after,
		selection: selected.selection,
	};
}
