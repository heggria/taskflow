/**
 * exec/driver — event-sourced schedule loop for **all** phase kinds (S2 complete).
 *
 * **Default OFF.** Engaged when `deps.eventKernel === true` or
 * `PI_TASKFLOW_EVENT_KERNEL=1`. Does not import the body of `runtime.ts`.
 */

import type { RunState } from "../store.ts";
import { topoLayers, type Taskflow } from "../schema.ts";
import { aggregateUsage, emptyUsage } from "../usage.ts";
import type { TraceEvent, TraceSink } from "../trace.ts";
import {
	EVENT_KERNEL_PHASE_TYPES,
	stepPhase,
	type KernelApprovalDecision,
	type KernelApprovalRequest,
	type NestedFlowResult,
	type RunTaskFn,
	type StepContext,
	type StepDeps,
} from "./step.ts";
import { foldEvents } from "./fold.ts";
import { EVENT_SCHEMA_VERSION, type Event } from "./events.ts";
import type { AgentConfig } from "../agents.ts";
import type { UsageStats } from "../usage.ts";

export { EVENT_KERNEL_PHASE_TYPES };

export interface EventKernelDeps {
	cwd: string;
	agents: AgentConfig[];
	runTask: RunTaskFn;
	signal?: AbortSignal;
	globalThinking?: string;
	trace?: TraceSink;
	persist?: (state: RunState) => void;
	onProgress?: (state: RunState) => void;
	eventKernel?: boolean;
	requestApproval?: (req: KernelApprovalRequest) => Promise<KernelApprovalDecision>;
	loadFlow?: (name: string) => Taskflow | undefined;
	/** Recursion stack for nested flow phases. */
	_stack?: string[];
}

export interface EventKernelResult {
	state: RunState;
	finalOutput: string;
	ok: boolean;
	totalUsage: UsageStats;
}

/** True when every phase type is in the kernel set (all 10 kinds). */
export function canUseEventKernel(def: Taskflow): boolean {
	return (def.phases ?? []).every((p) => {
		const t = p.type ?? "agent";
		return (EVENT_KERNEL_PHASE_TYPES as readonly string[]).includes(t);
	});
}

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

function resolveArgs(def: Taskflow): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	if (def.args) {
		for (const [k, v] of Object.entries(def.args)) {
			args[k] =
				typeof v === "object" && v && v !== null && "default" in (v as object)
					? (v as { default: unknown }).default
					: v;
		}
	}
	return args;
}

/**
 * Run a Taskflow on the event kernel (all phase kinds).
 * Caller must have checked {@link canUseEventKernel}.
 */
export async function runEventKernel(state: RunState, deps: EventKernelDeps): Promise<EventKernelResult> {
	const def = state.def;
	const layers = topoLayers(def.phases);
	const steps: StepContext["steps"] = {};
	const args = { ...resolveArgs(def), ...state.args };

	state.status = "running";
	const allEvents: Event[] = [];
	let gateBlocked = false;
	let gateReason = "";

	const runNested = async (opts: {
		def: Taskflow;
		args: Record<string, unknown>;
		stack: string[];
	}): Promise<NestedFlowResult> => {
		const childState: RunState = {
			runId: `${state.runId}/nested-${opts.def.name}`,
			flowName: opts.def.name,
			def: opts.def,
			args: opts.args,
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: deps.cwd,
		};
		const child = await runEventKernel(childState, {
			...deps,
			_stack: opts.stack,
		});
		// Collect events from child phases via fold of traces — child already emitted
		// to same trace sink; nested events are those just emitted. Return empty mid
		// events list for parent phase (sink already has them); usage/output matter.
		return {
			finalOutput: child.finalOutput,
			ok: child.ok,
			usage: child.totalUsage,
			events: [],
			blocked: child.state.status === "blocked",
		};
	};

	const stepDeps: StepDeps = {
		cwd: deps.cwd,
		agents: deps.agents,
		runTask: deps.runTask,
		signal: deps.signal,
		globalThinking: deps.globalThinking,
		requestApproval: deps.requestApproval,
		loadFlow: deps.loadFlow,
		stack: deps._stack ?? [],
		runNested,
	};

	for (const layer of layers) {
		if (deps.signal?.aborted) break;
		for (const phase of layer) {
			if (deps.signal?.aborted) break;
			if (gateBlocked) {
				const startedAt = Date.now();
				const skipErr = gateReason || "Upstream gate blocked";
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

			const depsOk = (phase.dependsOn ?? []).every((d) => {
				const s = state.phases[d]?.status;
				return s === "done" || s === "skipped";
			});
			if (!depsOk) {
				const startedAt = Date.now();
				const skipErr = "Upstream dependency not satisfied";
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
				gate: result.gate,
				approval: result.approval,
				...(result.status === "timedOut" ? { timedOut: true as const } : {}),
			};
			if (result.status === "done" && result.output !== undefined) {
				steps[phase.id] = {
					output: result.output,
					json: undefined,
				};
			}
			if (result.gate?.verdict === "block") {
				gateBlocked = true;
				gateReason = result.gate.reason || "Gate blocked";
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
			const foldStatus = f.status;
			if (ps.status === "done" && foldStatus === "done") continue;
			if (ps.status === "failed" && foldStatus === "failed") continue;
			if (ps.status === "skipped" && foldStatus === "skipped") continue;
			if (ps.timedOut && foldStatus === "timedOut") continue;
			if (String(ps.status) !== String(foldStatus)) {
				console.warn(`[taskflow] event-kernel fold status drift phase=${id} state=${ps.status} fold=${foldStatus}`);
			}
		}
	}

	const failed = Object.values(state.phases).some((p) => p.status === "failed" || p.timedOut);
	const finals = def.phases.filter((p) => p.final);
	const finalPhase = finals[finals.length - 1] ?? def.phases[def.phases.length - 1];
	let finalOutput = finalPhase ? (state.phases[finalPhase.id]?.output ?? "") : "";
	if (gateBlocked) {
		finalOutput = `Gate blocked the workflow.${gateReason ? `\nReason: ${gateReason}` : ""}${finalOutput ? `\n\n${finalOutput}` : ""}`;
	}
	state.status = failed
		? "failed"
		: deps.signal?.aborted
			? "paused"
			: gateBlocked
				? "blocked"
				: "completed";
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
