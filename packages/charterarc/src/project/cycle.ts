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
	FlowSelection,
	ModuleDefinition,
	ObservationResult,
	ObservationStatus,
	ProjectDefinition,
	ProjectOutcome,
	ProjectRuntime,
} from "./types.ts";

const DEFAULT_OBSERVE_TIMEOUT_MS = 30_000;
const OBSERVATION_KEYS = ["status", "summary", "facts", "target"] as const;
const TARGET_KEYS = ["desired", "module"] as const;
const OBSERVATION_STATUSES = new Set<ObservationStatus>(["satisfied", "drifted", "unknown"]);

/**
 * Runtime-normalized observation. The public `ObservationResult` type is the
 * authoring contract (facts required; drift requires target; non-drift forbids
 * target). Normalization still accepts malformed observer payloads and demotes
 * them fail-closed via authorize / unknown paths.
 */
type NormalizedObservation = {
	readonly status: ObservationStatus;
	readonly summary?: string;
	readonly facts?: Readonly<Record<string, unknown>>;
	readonly target?: { readonly desired?: string; readonly module?: string };
};

function normalizeObservation(value: unknown): NormalizedObservation {
	if (!isRecord(value)) fail("observer", "must return a plain object");
	assertOnlyKeys(value, OBSERVATION_KEYS, "observer");
	if (!OBSERVATION_STATUSES.has(value.status as ObservationStatus)) {
		fail("observer.status", "must be satisfied, drifted, or unknown");
	}
	const status = value.status as ObservationStatus;
	const summary =
		value.summary === undefined ? undefined : requiredText(value.summary, "observer.summary");

	// Facts are required: missing or non-record evidence cannot claim satisfaction
	// or authorize mutation (fail-closed demotion, not throw).
	if (value.facts === undefined || !isRecord(value.facts)) {
		return {
			status: "unknown",
			...(summary === undefined ? {} : { summary }),
		};
	}
	const facts = value.facts;

	let target: NormalizedObservation["target"];
	if (value.target !== undefined) {
		if (!isRecord(value.target)) {
			return {
				status: "unknown",
				facts,
				...(summary === undefined ? {} : { summary }),
			};
		}
		assertOnlyKeys(value.target, TARGET_KEYS, "observer.target");
		const desired =
			value.target.desired === undefined
				? undefined
				: requiredText(value.target.desired, "observer.target.desired");
		const module =
			value.target.module === undefined
				? undefined
				: requiredText(value.target.module, "observer.target.module");
		target = {
			...(desired === undefined ? {} : { desired }),
			...(module === undefined ? {} : { module }),
		};
	}

	// Healthy / unknown snapshots cannot carry mutation authority (`target`).
	if (status !== "drifted" && target !== undefined) {
		return {
			status: "unknown",
			facts,
			...(summary === undefined ? {} : { summary }),
		};
	}

	return {
		status,
		facts,
		...(summary === undefined ? {} : { summary }),
		...(target === undefined ? {} : { target }),
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
): Promise<NormalizedObservation> {
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

function resolveModule(
	project: ProjectDefinition,
	moduleId: string,
): ModuleDefinition | undefined {
	const modules = project.modules;
	if (modules === undefined) return undefined;
	return modules[moduleId];
}

/**
 * Resolve zero or one Flow from a drifted observation.
 * Unbound / missing targets on multi-Flow projects yield no selection
 * (caller demotes to unknown — unknown grants no authority).
 */
function resolveSelection(
	project: ProjectDefinition,
	observation: NormalizedObservation,
): { selection: FlowSelection; flow: Taskflow; desiredText: string } | undefined {
	if (observation.status !== "drifted") return undefined;

	const target = observation.target;
	if (target === undefined || target.desired === undefined) return undefined;

	if (target.module !== undefined) {
		const module = resolveModule(project, target.module);
		if (module === undefined) return undefined;
		const flow = module.maintain[target.desired];
		const desiredText = module.desired[target.desired];
		if (flow === undefined || desiredText === undefined) return undefined;
		return {
			selection: {
				module: target.module,
				desired: target.desired,
				flow: flow.name,
			},
			flow,
			desiredText,
		};
	}

	const flow = project.maintain[target.desired];
	const desiredText = project.desired[target.desired];
	if (flow === undefined || desiredText === undefined) return undefined;
	return {
		selection: { desired: target.desired, flow: flow.name },
		flow,
		desiredText,
	};
}

/** Publish a runtime snapshot as the public ObservationResult contract. */
function toObservationResult(observation: NormalizedObservation): ObservationResult {
	const facts = observation.facts ?? {};
	const summary =
		observation.summary === undefined ? {} : { summary: observation.summary };
	if (observation.status === "drifted") {
		const desired = observation.target?.desired;
		if (desired === undefined) {
			// Public contract: confirmed drift must identify a desired target.
			// Unbound multi-Flow drift is demoted before publication; single-Flow
			// may still authorize via project identity — surface facts only.
			return { status: "unknown", facts, ...summary };
		}
		return {
			status: "drifted",
			facts,
			target: {
				desired,
				...(observation.target?.module === undefined
					? {}
					: { module: observation.target.module }),
			},
			...summary,
		};
	}
	return {
		status: observation.status,
		facts,
		...summary,
	};
}

/** Multi-Flow drifted observations without a bound Flow become unknown. */
function authorizeObservation(
	project: ProjectDefinition,
	observation: NormalizedObservation,
): {
	observation: ObservationResult;
	bound?: { selection: FlowSelection; flow: Taskflow; desiredText: string };
} {
	if (observation.status !== "drifted") {
		return { observation: toObservationResult(observation) };
	}
	const bound = resolveSelection(project, observation);
	if (bound !== undefined) {
		return { observation: toObservationResult(observation), bound };
	}
	return {
		observation: {
			status: "unknown",
			facts: observation.facts ?? {},
			...(observation.summary === undefined ? {} : { summary: observation.summary }),
		},
	};
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

function buildRunArgs(
	observation: ObservationResult | NormalizedObservation,
	bound: { selection: FlowSelection; flow: Taskflow; desiredText: string },
): Record<string, unknown> {
	return {
		charterarc: {
			selection: bound.selection,
			desired: bound.desiredText,
			snapshot: observation,
		},
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
	const rawBefore = await observeProject(stableProject, stableRuntime);
	const { observation: before, bound } = authorizeObservation(stableProject, rawBefore);

	if (before.status === "satisfied") {
		return {
			status: "satisfied",
			ok: true,
			before,
		};
	}
	if (before.status === "unknown" || bound === undefined) {
		return {
			status: "unknown",
			ok: false,
			before,
		};
	}

	const args = buildRunArgs(before, bound);

	let run: FlowRunResult;
	try {
		run = await executeMaintenance(bound.flow, args, stableRuntime.taskflow);
	} catch (error) {
		run = {
			ok: false,
			finalOutput: error instanceof Error ? error.message : String(error),
		};
	}
	const after = toObservationResult(await observeProject(stableProject, stableRuntime));
	return {
		status: after.status,
		// Fail-closed: observed satisfaction is not enough if the Run failed.
		ok: after.status === "satisfied" && run.ok,
		before,
		run,
		after,
		selection: bound.selection,
	};
}
