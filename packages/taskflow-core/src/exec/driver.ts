/**
 * exec/driver — event-sourced schedule loop for all phase kinds (S2).
 *
 * **Default OFF.** Engaged when `deps.eventKernel === true` or
 * `PI_TASKFLOW_EVENT_KERNEL=1`, and only when {@link canUseEventKernel} admits
 * the def (no unsupported advanced features).
 */

import type { RunState } from "../store.ts";
import { dependenciesOf, resolveArgs, topoLayers, type Budget, type Phase, type Taskflow, validateTaskflow } from "../schema.ts";
import { resolveFinalOutput } from "../final-output.ts";
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
	usageAccounting?: "available" | "tokens-only" | "unavailable";
	trace?: TraceSink;
	persist?: (state: RunState) => void;
	onProgress?: (state: RunState) => void;
	eventKernel?: boolean;
	requestApproval?: (req: KernelApprovalRequest) => Promise<KernelApprovalDecision>;
	loadFlow?: (name: string) => Taskflow | undefined;
	_stack?: string[];
	_dynamic?: boolean;
}

export interface EventKernelResult {
	state: RunState;
	finalOutput: string;
	ok: boolean;
	totalUsage: UsageStats;
	/** Id of the PhaseState whose output supplied finalOutput (0.2.0 dogfood
	 *  issue 6). Mirrors `RuntimeResult.outputSourcePhaseId`; the event kernel
	 *  delegates final-phase selection to the shared `resolveFinalOutput`
	 *  helper so attribution matches the imperative path exactly. */
	outputSourcePhaseId?: string;
}

/** True when types are known AND no advanced features force imperative fall-back. */
export function canUseEventKernel(
	def: Taskflow,
	loadFlow?: (name: string) => Taskflow | undefined,
	seen: Set<string> = new Set(),
	inheritedBudget?: Budget,
): boolean {
	if (seen.has(def.name)) return false;
	const nextSeen = new Set(seen).add(def.name);
	const typesOk = (def.phases ?? []).every((p) => {
		const t = p.type ?? "agent";
		return (EVENT_KERNEL_PHASE_TYPES as readonly string[]).includes(t);
	});
	if (!typesOk) return false;
	// A parent run-wide budget also governs every nested call. Admission must
	// evaluate the child with that inherited ceiling; otherwise a parent whose
	// only phase is `flow` can smuggle a budgeted map/parallel/loop/tournament
	// into the kernel and fail only after execution has already started.
	const effectiveBudget = def.budget ?? inheritedBudget;
	const effectiveDef = effectiveBudget === def.budget ? def : { ...def, budget: effectiveBudget };
	if (kernelUnsupportedReason(effectiveDef) !== undefined) return false;
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
		if (!child || !canUseEventKernel(child, loadFlow, nextSeen, effectiveBudget)) return false;
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
	phase: Phase,
	status: Event["status"],
	error?: string,
): void {
	const start: Event = {
		v: EVENT_SCHEMA_VERSION,
		ts: Date.now(),
		runId,
		phaseId: phase.id,
		kind: "phase-start",
		dependencies: dependenciesOf(phase),
		optional: phase.optional === true,
	};
	const end: Event = {
		v: EVENT_SCHEMA_VERSION,
		ts: Date.now(),
		runId,
		phaseId: phase.id,
		kind: "phase-end",
		status,
		error,
	};
	allEvents.push(start, end);
	safeTraceEmit(deps, start);
	safeTraceEmit(deps, end);
	safeTraceFlush(deps, phase.id);
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
	/** Output of the blocking gate/approval phase (included in the gate prefix). */
	let gateOutput = "";
	/** Id of the blocking gate/approval phase (source of `gateOutput`). */
	let gatePhaseId: string | undefined;
	let budgetBlocked = false;
	let budgetReason = "";

	const runNested = async (opts: {
		def: Taskflow;
		args: Record<string, unknown>;
		stack: string[];
		dynamic?: boolean;
	}): Promise<NestedFlowResult> => {
		const nestedArgs = resolveArgs(opts.def, opts.args);
		const dynamic = deps._dynamic === true || opts.dynamic === true;
		const validation = validateTaskflow(opts.def, { args: nestedArgs, cwd: deps.cwd, dynamic });
		if (!validation.ok) {
			return {
				finalOutput: `Nested flow invocation is invalid: ${validation.errors.join("; ")}`,
				ok: false,
				usage: emptyUsage(),
				events: [],
				blocked: false,
			};
		}
		if (deps.usageAccounting === "unavailable" && (opts.def.budget || def.budget)) {
			return {
				finalOutput: `Usage accounting is unavailable; refusing budgeted nested flow '${opts.def.name}'`,
				ok: false,
				usage: emptyUsage(),
				events: [],
				blocked: false,
			};
		}
		const effectiveBudget = opts.def.budget ?? def.budget;
		if (deps.usageAccounting === "tokens-only" && effectiveBudget?.maxUSD !== undefined) {
			throw new Error(
				"This host reports tokens but not cost, so budget.maxUSD cannot be enforced. " +
					"Use budget.maxTokens or a host with cost accounting.",
			);
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
			args: nestedArgs,
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: deps.cwd,
		};
		const child = await runEventKernel(childState, {
			...deps,
			_dynamic: dynamic ? true : undefined,
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
				emitLifecycle(deps, allEvents, state.runId, phase, "skipped", skipReason);
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
			const readRefs: string[] = [];
			const promptCalls: string[] = [];
			const ctx: StepContext = { state, deps: stepDeps, steps, args, readRefs, promptCalls };
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

			const observedReads = Array.from(new Set(
				readRefs
					.map((ref) => /^steps\.([A-Za-z0-9_-]+)\b/.exec(ref)?.[1])
					.filter((id): id is string => typeof id === "string"),
			)).map((stepId) => ({ stepId, version: state.phases[stepId]?.inputHash }));

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
				warnings: result.warnings,
				...(observedReads.length ? { reads: observedReads } : {}),
				// Prompt-size diagnostics (parity with imperative PhaseState.promptStats).
				...(result.promptStats ? { promptStats: result.promptStats } : {}),
				// Match the imperative audit marker: an idempotent:false phase
				// records that its side effect may have fired, unless its guard skipped
				// all execution.
				...(phase.idempotent === false && result.status !== "skipped" ? { sideEffect: true as const } : {}),
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
				gateOutput = result.output ?? "";
				gatePhaseId = phase.id;
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

	// Match imperative priority: aborted → gate/budget blocked → failed → completed
	state.status = deps.signal?.aborted
		? "paused"
		: gateBlocked || budgetBlocked
			? "blocked"
			: anyFailed
				? "failed"
				: "completed";

	const { finalOutput, outputSourcePhaseId } = resolveFinalOutput(def.phases, state, {
		gate: gateBlocked,
		gateReason,
		gateOutput,
		gatePhaseId,
		budget: budgetBlocked,
		budgetReason,
	});

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
		outputSourcePhaseId,
	};
}
