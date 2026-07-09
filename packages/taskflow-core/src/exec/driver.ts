/**
 * exec/driver — event-sourced schedule loop for agent + script (S2 strangler).
 *
 * **Default OFF.** Engaged when `deps.eventKernel === true` or
 * `PI_TASKFLOW_EVENT_KERNEL=1`. Unsupported phase kinds fall through to the
 * imperative `executeTaskflow` (caller responsibility).
 *
 * Does not import the body of `runtime.ts` — only shared store/schema/usage.
 */

import type { RunState } from "../store.ts";
import { topoLayers, type Taskflow } from "../schema.ts";
import { aggregateUsage, emptyUsage } from "../usage.ts";
import type { TraceEvent, TraceSink } from "../trace.ts";
import { stepPhase, type RunTaskFn, type StepContext, type StepDeps } from "./step.ts";
import { foldEvents } from "./fold.ts";
import { EVENT_SCHEMA_VERSION, type Event } from "./events.ts";
import type { AgentConfig } from "../agents.ts";
import type { UsageStats } from "../usage.ts";

export interface EventKernelDeps {
	cwd: string;
	agents: AgentConfig[];
	runTask: RunTaskFn;
	signal?: AbortSignal;
	globalThinking?: string;
	trace?: TraceSink;
	persist?: (state: RunState) => void;
	onProgress?: (state: RunState) => void;
	/** Explicit strangler switch. */
	eventKernel?: boolean;
}

export interface EventKernelResult {
	state: RunState;
	finalOutput: string;
	ok: boolean;
	totalUsage: UsageStats;
}

/** True when every phase is agent or script (S2 first slice). */
export function canUseEventKernel(def: Taskflow): boolean {
	return (def.phases ?? []).every((p) => {
		const t = p.type ?? "agent";
		return t === "agent" || t === "script";
	});
}

/** Whether the strangler event kernel should run this invocation. */
export function eventKernelEnabled(deps: { eventKernel?: boolean }): boolean {
	if (deps.eventKernel === true) return true;
	if (deps.eventKernel === false) return false;
	return process.env.PI_TASKFLOW_EVENT_KERNEL === "1" || process.env.PI_TASKFLOW_EVENT_KERNEL === "true";
}

function safeTraceEmit(deps: EventKernelDeps, event: Event): void {
	try {
		deps.trace?.emit(event as unknown as TraceEvent);
	} catch {
		/* fail-open */
	}
}

function safeTraceFlush(deps: EventKernelDeps, phaseId: string): void {
	try {
		deps.trace?.flush(phaseId);
	} catch {
		/* fail-open */
	}
}

/**
 * Run a Taskflow on the event kernel (agent+script only).
 * Caller must have checked {@link canUseEventKernel}.
 */
export async function runEventKernel(state: RunState, deps: EventKernelDeps): Promise<EventKernelResult> {
	const def = state.def;
	const layers = topoLayers(def.phases);
	const steps: StepContext["steps"] = {};
	const args: Record<string, unknown> = {};
	if (def.args) {
		for (const [k, v] of Object.entries(def.args)) {
			args[k] = typeof v === "object" && v && v !== null && "default" in (v as object) ? (v as { default: unknown }).default : v;
		}
	}

	state.status = "running";
	const allEvents: Event[] = [];
	const stepDeps: StepDeps = {
		cwd: deps.cwd,
		agents: deps.agents,
		runTask: deps.runTask,
		signal: deps.signal,
		globalThinking: deps.globalThinking,
	};

	for (const layer of layers) {
		if (deps.signal?.aborted) break;
		for (const phase of layer) {
			if (deps.signal?.aborted) break;
			const depsOk = (phase.dependsOn ?? []).every((d) => {
				const s = state.phases[d]?.status;
				return s === "done" || s === "skipped";
			});
			if (!depsOk) {
				const startedAt = Date.now();
				const skipErr = "Upstream dependency not satisfied";
				// Synthetic lifecycle so fold/replay see a complete phase.
				const skipEvents: Event[] = [
					{
						v: EVENT_SCHEMA_VERSION,
						ts: startedAt,
						runId: state.runId,
						phaseId: phase.id,
						kind: "phase-start",
					},
					{
						v: EVENT_SCHEMA_VERSION,
						ts: Date.now(),
						runId: state.runId,
						phaseId: phase.id,
						kind: "phase-end",
						status: "skipped",
						error: skipErr,
					},
				];
				for (const e of skipEvents) {
					allEvents.push(e);
					safeTraceEmit(deps, e);
				}
				safeTraceFlush(deps, phase.id);
				state.phases[phase.id] = {
					id: phase.id,
					status: "skipped",
					error: skipErr,
					startedAt,
					endedAt: Date.now(),
					usage: emptyUsage(),
				};
				continue;
			}

			const startedAt = Date.now();
			state.phases[phase.id] = { id: phase.id, status: "running", startedAt };
			const ctx: StepContext = { state, deps: stepDeps, steps, args };
			const result = await stepPhase(phase, ctx);
			if (!result) {
				state.phases[phase.id] = {
					id: phase.id,
					status: "failed",
					error: `event kernel cannot handle type ${phase.type}`,
					endedAt: Date.now(),
					usage: emptyUsage(),
				};
				continue;
			}
			for (const e of result.events) {
				allEvents.push(e);
				safeTraceEmit(deps, e);
			}
			safeTraceFlush(deps, phase.id);

			// PhaseStatus is pending|running|done|failed|skipped; timeouts are
			// failed + timedOut:true (matches the imperative runtime).
			const st =
				result.status === "skipped"
					? "skipped"
					: result.status === "failed" || result.status === "timedOut"
						? "failed"
						: "done";
			state.phases[phase.id] = {
				id: phase.id,
				status: st,
				output: result.output,
				error: result.error,
				startedAt,
				endedAt: Date.now(),
				usage: result.usage ?? emptyUsage(),
				...(result.status === "timedOut" ? { timedOut: true as const } : {}),
			};
			if (result.status === "done" && result.output !== undefined) {
				steps[phase.id] = { output: result.output };
			}
			try {
				deps.persist?.(state);
			} catch {
				/* fail-open */
			}
			try {
				deps.onProgress?.(state);
			} catch {
				/* fail-open */
			}
		}
	}

	const folded = foldEvents(allEvents);
	for (const [id, ps] of Object.entries(state.phases)) {
		const f = folded.phases[id];
		if (f && f.status !== "pending" && f.status !== "running") {
			// Map timedOut on fold to failed-like for comparison — fold uses timedOut status
			const foldStatus = f.status;
			if (ps.status === "done" && foldStatus === "done") continue;
			if (ps.status === "failed" && foldStatus === "failed") continue;
			if (ps.status === "skipped" && foldStatus === "skipped") continue;
			if (ps.timedOut && foldStatus === "timedOut") continue;
			// soft warn only
			if (String(ps.status) !== String(foldStatus)) {
				console.warn(`[taskflow] event-kernel fold status drift phase=${id} state=${ps.status} fold=${foldStatus}`);
			}
		}
	}

	const failed = Object.values(state.phases).some((p) => p.status === "failed" || p.timedOut);
	const finals = def.phases.filter((p) => p.final);
	const finalPhase = finals[finals.length - 1] ?? def.phases[def.phases.length - 1];
	const finalOutput = finalPhase ? (state.phases[finalPhase.id]?.output ?? "") : "";
	state.status = failed ? "failed" : deps.signal?.aborted ? "paused" : "completed";
	const totalUsage = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
	try {
		deps.persist?.(state);
	} catch {
		/* ignore */
	}
	return {
		state,
		finalOutput,
		ok: state.status === "completed",
		totalUsage,
	};
}
