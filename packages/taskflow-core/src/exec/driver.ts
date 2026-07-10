/**
 * exec/driver — event-sourced schedule loop for all phase kinds (S2).
 *
 * **Default OFF.** Engaged when `deps.eventKernel === true` or
 * `PI_TASKFLOW_EVENT_KERNEL=1`, and only when {@link canUseEventKernel} admits
 * the def (no unsupported advanced features).
 */

import type { RunState } from "../store.ts";
import { resolveArgs, topoLayers, type Taskflow } from "../schema.ts";
import { aggregateUsage, emptyUsage } from "../usage.ts";
import type { TraceEvent, TraceSink } from "../trace.ts";
import { overBudget as overBudgetCheck } from "../deterministic.ts";
import { safeParse } from "../interpolate.ts";
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
import {
	clampSubFlowBudget,
	containsInterpolationPlaceholder,
	depsSatisfied,
	kernelUnsupportedReason,
} from "./kernel-policy.ts";

export { EVENT_KERNEL_PHASE_TYPES, kernelUnsupportedReason };

export interface EventKernelDeps {
	cwd: string;
	agents: AgentConfig[];
	runTask: RunTaskFn;
	signal?: AbortSignal;
	globalThinking?: string;
	usageAccounting?: "available" | "unavailable";
	trace?: TraceSink;
	persist?: (state: RunState) => void;
	onProgress?: (state: RunState) => void;
	eventKernel?: boolean;
	requestApproval?: (req: KernelApprovalRequest) => Promise<KernelApprovalDecision>;
	loadFlow?: (name: string) => Taskflow | undefined;
	_stack?: string[];
}

export interface EventKernelResult {
	state: RunState;
	finalOutput: string;
	ok: boolean;
	totalUsage: UsageStats;
}

/** True when types are known AND no advanced features force imperative fall-back. */
export function canUseEventKernel(
	def: Taskflow,
	loadFlow?: (name: string) => Taskflow | undefined,
	seen: Set<string> = new Set(),
): boolean {
	if (seen.has(def.name)) return false;
	const nextSeen = new Set(seen).add(def.name);
	const typesOk = (def.phases ?? []).every((p) => {
		const t = p.type ?? "agent";
		return (EVENT_KERNEL_PHASE_TYPES as readonly string[]).includes(t);
	});
	if (!typesOk) return false;
	if (kernelUnsupportedReason(def) !== undefined) return false;
	for (const phase of def.phases ?? []) {
		if ((phase.type ?? "agent") !== "flow") continue;
		let child: Taskflow | undefined;
		const raw = (phase as { def?: unknown }).def;
		if (raw !== undefined) {
			if (typeof raw === "string") {
				// Interpolated/runtime-generated definitions cannot be admitted statically.
				if (containsInterpolationPlaceholder(raw)) return false;
				try {
					const parsed = JSON.parse(raw) as unknown;
					if (Array.isArray(parsed)) child = { name: `${phase.id}-inline`, phases: parsed as Taskflow["phases"] };
					else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Taskflow).phases)) child = parsed as Taskflow;
				} catch {
					return false;
				}
			} else if (Array.isArray(raw)) {
				child = { name: `${phase.id}-inline`, phases: raw as Taskflow["phases"] };
			} else if (raw && typeof raw === "object" && Array.isArray((raw as Taskflow).phases)) {
				child = raw as Taskflow;
			}
		} else if (phase.use && loadFlow) {
			child = loadFlow(phase.use);
		}
		if (!child || !canUseEventKernel(child, loadFlow, nextSeen)) return false;
	}
	return true;
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

function runOverBudget(state: RunState): { over: boolean; reason: string } {
	const budget = state.def.budget;
	if (!budget) return { over: false, reason: "" };
	return overBudgetCheck({
		maxUSD: budget.maxUSD,
		maxTokens: budget.maxTokens,
		usages: Object.values(state.phases).map((p) => p.usage ?? emptyUsage()),
	});
}

function emitLifecycle(
	deps: EventKernelDeps,
	allEvents: Event[],
	runId: string,
	phaseId: string,
	status: Event["status"],
	error?: string,
): void {
	const start: Event = {
		v: EVENT_SCHEMA_VERSION,
		ts: Date.now(),
		runId,
		phaseId,
		kind: "phase-start",
	};
	const end: Event = {
		v: EVENT_SCHEMA_VERSION,
		ts: Date.now(),
		runId,
		phaseId,
		kind: "phase-end",
		status,
		error,
	};
	allEvents.push(start, end);
	safeTraceEmit(deps, start);
	safeTraceEmit(deps, end);
	safeTraceFlush(deps, phaseId);
}

/**
 * Run a Taskflow on the event kernel.
 * Caller must have checked {@link canUseEventKernel}.
 */
export async function runEventKernel(state: RunState, deps: EventKernelDeps): Promise<EventKernelResult> {
	const def = state.def;
	const layers = topoLayers(def.phases);
	const steps: StepContext["steps"] = {};
	const args = resolveArgs(def, state.args);
	const byId = new Map(def.phases.map((p) => [p.id, p]));

	state.status = "running";
	const allEvents: Event[] = [];
	let gateBlocked = false;
	let gateReason = "";
	let budgetBlocked = false;
	let budgetReason = "";

	const runNested = async (opts: {
		def: Taskflow;
		args: Record<string, unknown>;
		stack: string[];
	}): Promise<NestedFlowResult> => {
		if (deps.usageAccounting === "unavailable" && (opts.def.budget || def.budget)) {
			return {
				finalOutput: `Usage accounting is unavailable; refusing budgeted nested flow '${opts.def.name}'`,
				ok: false,
				usage: emptyUsage(),
				events: [],
				blocked: false,
			};
		}
		const parentSpent = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
		const effectiveDef = clampSubFlowBudget(opts.def, def.budget, parentSpent);
		// Re-admit nested defs — parent admission must not smuggle race/expand
		// or score/retry/… into the kernel path (silent semantic drift).
		if (!canUseEventKernel(effectiveDef, deps.loadFlow)) {
			const reason =
				kernelUnsupportedReason(effectiveDef) ??
				"nested flow contains phase kinds or features the event kernel cannot execute";
			return {
				finalOutput: `Nested flow rejected by event kernel: ${reason}`,
				ok: false,
				usage: emptyUsage(),
				events: [],
				blocked: false,
			};
		}
		const childState: RunState = {
			// No `/` — validateRunId rejects path separators if ever persisted.
			runId: `${state.runId}-n-${effectiveDef.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40)}`,
			flowName: effectiveDef.name,
			def: effectiveDef,
			args: opts.args,
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: deps.cwd,
		};
		const child = await runEventKernel(childState, {
			...deps,
			// A trace file belongs to exactly one runId. Nested flow events are
			// intentionally isolated; the parent flow phase is marked unreplayable
			// by the imperative path rather than polluting the parent's event log.
			trace: undefined,
			_stack: opts.stack,
		});
		const childErr = Object.values(child.state.phases)
			.map((p) => p.error)
			.find((e) => !!e);
		return {
			finalOutput: child.ok ? child.finalOutput : childErr || child.finalOutput || "sub-flow failed",
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
			let skipReason: string | undefined;
			if (gateBlocked) skipReason = `Gate blocked${gateReason ? `: ${gateReason}` : ""}`;
			else if (budgetBlocked) skipReason = `Budget exceeded${budgetReason ? `: ${budgetReason}` : ""}`;
			else {
				const dep = depsSatisfied(phase, state.phases, byId);
				if (!dep.ok) skipReason = dep.skipReason;
			}

			if (skipReason) {
				if (skipReason.startsWith("Budget exceeded")) {
					budgetBlocked = true;
					const be: Event = {
						v: EVENT_SCHEMA_VERSION,
						ts: Date.now(),
						runId: state.runId,
						phaseId: phase.id,
						kind: "decision",
						decision: { type: "budget-hit", value: budgetReason || "budget", reason: skipReason },
					};
					allEvents.push(be);
					safeTraceEmit(deps, be);
				}
				const startedAt = Date.now();
				emitLifecycle(deps, allEvents, state.runId, phase.id, "skipped", skipReason);
				state.phases[phase.id] = {
					id: phase.id,
					status: "skipped",
					error: skipReason,
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
			const phaseJson = phase.output === "json" ? safeParse(result.output ?? "") : undefined;

			state.phases[phase.id] = {
				id: phase.id,
				status: st,
				output: result.output,
				json: phaseJson,
				error: result.error,
				startedAt,
				endedAt: Date.now(),
				usage: result.usage ?? emptyUsage(),
				attempts: result.attempts,
				gate: result.gate,
				approval: result.approval,
				...(result.status === "timedOut" ? { timedOut: true as const } : {}),
			};
			if (result.status === "done" && result.output !== undefined) {
				steps[phase.id] = {
					output: result.output,
					// Always best-effort parse so {steps.X.json.field} works for JSON agents
					json: phaseJson ?? safeParse(result.output),
				};
			}
			if (result.gate?.verdict === "block") {
				gateBlocked = true;
				gateReason = result.gate.reason || "Gate blocked";
			}
			const ob = runOverBudget(state);
			if (ob.over) {
				budgetBlocked = true;
				budgetReason = ob.reason;
				const be: Event = {
					v: EVENT_SCHEMA_VERSION,
					ts: Date.now(),
					runId: state.runId,
					phaseId: phase.id,
					kind: "decision",
					decision: { type: "budget-hit", value: "budget", reason: ob.reason },
				};
				allEvents.push(be);
				safeTraceEmit(deps, be);
				// stepPhase already flushed this phase's lifecycle batch.
				safeTraceFlush(deps, phase.id);
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

	// Soft fold drift check
	const folded = foldEvents(allEvents);
	for (const [id, ps] of Object.entries(state.phases)) {
		const f = folded.phases[id];
		if (!f || f.status === "pending" || f.status === "running") continue;
		if (ps.timedOut && f.status === "timedOut") continue;
		if (String(ps.status) === String(f.status)) continue;
		if (ps.status === "done" && f.status === "blocked") continue; // fold gate intermediate
		console.warn(`[taskflow] event-kernel fold status drift phase=${id} state=${ps.status} fold=${f.status}`);
	}

		const anyFailed = Object.entries(state.phases).some(
			([id, p]) => p.status === "failed" && !byId.get(id)?.optional,
		);
		const finals = def.phases.filter((p) => p.final);
		const finalPhase = finals[finals.length - 1] ?? def.phases[def.phases.length - 1];
		let finalState = finalPhase ? state.phases[finalPhase.id] : undefined;
		if (!finalState || finalState.status !== "done") {
			const doneInOrder = def.phases.map((p) => state.phases[p.id]).filter((p) => p?.status === "done");
			if (doneInOrder.length) finalState = doneInOrder[doneInOrder.length - 1];
		}
		let finalOutput = finalState?.output ?? "";
	if (gateBlocked) {
		finalOutput = `Gate blocked the workflow.${gateReason ? `\nReason: ${gateReason}` : ""}${finalOutput ? `\n\n${finalOutput}` : ""}`;
	} else if (budgetBlocked) {
		finalOutput = `Budget exceeded — run halted.${budgetReason ? `\nReason: ${budgetReason}` : ""}${finalOutput ? `\n\n${finalOutput}` : ""}`;
	}

	// Match imperative priority: aborted → gate/budget blocked → failed → completed
	state.status = deps.signal?.aborted
		? "paused"
		: gateBlocked || budgetBlocked
			? "blocked"
			: anyFailed
				? "failed"
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
