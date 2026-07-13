/**
 * exec/step — per-node handlers for the event-sourced kernel (RFC §6.3, S2).
 *
 * Kernel covers `EVENT_KERNEL_PHASE_TYPES` (PHASE_TYPES minus `race`/`expand` —
 * currently 10 kinds). Complex paths live in `./step-kinds.ts`. Does **not**
 * import `runtime.ts` (avoids circular deps with the strangler).
 */

import type { Phase, Taskflow } from "../schema.ts";
import { dependenciesOf, MAX_DYNAMIC_MAP_ITEMS, PHASE_TYPES } from "../schema.ts";
import type { RunState } from "../store.ts";
import type { AgentConfig } from "../agents.ts";
import type { RunOptions, RunResult } from "../host/runner-types.ts";
import type { Event } from "./events.ts";
import { EVENT_SCHEMA_VERSION } from "./events.ts";
import { aggregateUsage, emptyUsage, type UsageStats } from "../usage.ts";
import {
	coerceArray,
	evaluateCondition,
	interpolate,
	safeParse,
	type InterpolationContext,
} from "../interpolate.ts";
import { abortableDelay, isFailed as isFailedResult, isTransientError, mapWithConcurrencyLimit, PHASE_TIMEOUT_ABORT_GRACE_MS } from "../runner-core.ts";
import {
	runScriptCommand,
	scriptResultToPhaseState,
	scriptSpawnErrorToPhaseState,
} from "../runtime/phases/script.ts";
import {
	executeApprovalBody,
	executeFlowBody,
	executeGateBody,
	executeLoopBody,
	executeReduceBody,
	executeTournamentBody,
} from "./step-kinds.ts";
import { kernelAttemptsOverBudget } from "./kernel-policy.ts";

/** All DSL phase types — S2 kernel is complete. */
/** Kernel kinds: original 10. Horizon B `race`/`expand` run on the imperative
 *  path until dedicated step handlers land (canUseEventKernel excludes them). */
export const EVENT_KERNEL_PHASE_TYPES = PHASE_TYPES.filter(
	(t) => t !== "race" && t !== "expand",
) as readonly (typeof PHASE_TYPES)[number][];
export type EventKernelPhaseType = (typeof EVENT_KERNEL_PHASE_TYPES)[number];

export type RunTaskFn = (
	cwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	opts: RunOptions,
	globalThinking?: string,
) => Promise<RunResult>;

/** Mirrors runtime ApprovalRequest — kept local to avoid step↔runtime cycles. */
export interface KernelApprovalRequest {
	phaseId: string;
	message: string;
	upstream?: string;
}
export interface KernelApprovalDecision {
	decision: "approve" | "reject" | "edit";
	note?: string;
}

export interface NestedFlowResult {
	finalOutput: string;
	ok: boolean;
	usage: UsageStats;
	events: Event[];
	blocked?: boolean;
}

export interface StepDeps {
	cwd: string;
	agents: AgentConfig[];
	runTask: RunTaskFn;
	signal?: AbortSignal;
	globalThinking?: string;
	requestApproval?: (req: KernelApprovalRequest) => Promise<KernelApprovalDecision>;
	loadFlow?: (name: string) => Taskflow | undefined;
	/** Sub-flow call stack (recursion guard). */
	stack?: string[];
	/** Nested flow runner (driver injects runEventKernel). */
	runNested?: (opts: {
		def: Taskflow;
		args: Record<string, unknown>;
		stack: string[];
	}) => Promise<NestedFlowResult>;
}

export interface StepContext {
	state: RunState;
	deps: StepDeps;
	steps: InterpolationContext["steps"];
	args: Record<string, unknown>;
}

export interface StepResult {
	events: Event[];
	output?: string;
	status: "done" | "failed" | "skipped" | "timedOut";
	error?: string;
	/** Token/cost usage for this phase (empty for script / skipped). */
	usage: UsageStats;
	/** Total runner attempts, including automatic transient retries. */
	attempts?: number;
	gate?: { verdict: "pass" | "block"; reason?: string };
	approval?: { decision: "approve" | "reject" | "edit"; note?: string; auto?: boolean };
	warnings?: string[];
}

type BodyResult = {
	midEvents: Event[];
	output?: string;
	status: StepResult["status"];
	error?: string;
	usage: UsageStats;
	attempts?: number;
	gate?: StepResult["gate"];
	approval?: StepResult["approval"];
	warnings?: string[];
};

function baseEvent(
	ctx: StepContext,
	phaseId: string,
	kind: Event["kind"],
	extra: Partial<Event> = {},
): Event {
	return {
		v: EVENT_SCHEMA_VERSION,
		ts: Date.now(),
		runId: ctx.state.runId,
		phaseId,
		kind,
		...extra,
	};
}

/** Accumulate usage from subagent-call events in a result. */
export function usageFromEvents(events: readonly Event[]): UsageStats {
	const u = emptyUsage();
	for (const e of events) {
		const usage = e.output?.usage;
		if (!usage) continue;
		u.input += usage.input ?? 0;
		u.output += usage.output ?? 0;
		u.cacheRead += usage.cacheRead ?? 0;
		u.cacheWrite += usage.cacheWrite ?? 0;
		u.cost += usage.cost ?? 0;
		u.turns += usage.turns ?? 0;
		if (typeof usage.contextTokens === "number") u.contextTokens = usage.contextTokens;
	}
	return u;
}

/** Format fan-out results like the imperative runtime's mergePhaseState text. */
function combineFanoutText(results: RunResult[]): string {
	return results
		.map((r, i) => {
			const label = `### [${i + 1}/${results.length}] ${r.agent}${isFailedResult(r) ? " (failed)" : ""}`;
			const content = isFailedResult(r) ? r.errorMessage || r.stderr || r.output : r.output;
			return `${label}\n\n${content}`;
		})
		.join("\n\n---\n\n");
}

/** Run a shell script phase (no LLM). Captures stdout. */
export async function stepScript(phase: Phase, ctx: StepContext): Promise<StepResult> {
	return stepPhase({ ...phase, type: "script" }, ctx) as Promise<StepResult>;
}

/** Run a single agent phase via the injected runner. */
export async function stepAgent(phase: Phase, ctx: StepContext): Promise<StepResult> {
	return stepPhase({ ...phase, type: "agent" }, ctx) as Promise<StepResult>;
}

async function executeScriptBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	const run = phase.run;
	if (!run || (Array.isArray(run) && run.length === 0)) {
		const err = "script phase missing `run`";
		return { midEvents: [], status: "failed", error: err, usage: emptyUsage() };
	}
	const argv = Array.isArray(run) ? run.map(String) : [String(run)];
	const timeoutMs = phase.timeout ?? 60_000;
	let phaseState;
	try {
		const result = await runScriptCommand({
			interpRunText: argv,
			arrayForm: Array.isArray(run),
			cwd: ctx.deps.cwd,
			signal: ctx.deps.signal,
			timeoutMs,
		});
		phaseState = scriptResultToPhaseState(phase, result, { inputHash: "", timeoutMs });
	} catch (err) {
		phaseState = scriptSpawnErrorToPhaseState(phase.id, err, { inputHash: "" });
	}
	const status: StepResult["status"] = phaseState.timedOut
		? "timedOut"
		: phaseState.status === "done"
			? "done"
			: "failed";
	const text = phaseState.output ?? "";
	const usage = emptyUsage();
	const midEvents: Event[] = [
		baseEvent(ctx, phase.id, "subagent-call", {
			input: {
				agent: "script",
				task: Array.isArray(run) ? argv.join(" ") : String(run),
				nodePath: phase.id,
			},
			output: {
				text,
				usage,
				stopReason: phaseState.timedOut ? "timeout" : phaseState.status === "done" ? "end" : "error",
			},
		}),
	];
	return {
		midEvents,
		output: text,
		status,
		error: status === "done" ? undefined : phaseState.error,
		usage,
	};
}

async function runOneAgent(
	ctx: StepContext,
	phase: Phase,
	agentName: string,
	task: string,
	nodePath: string,
	mapIndex?: number,
): Promise<{ result: RunResult; event: Event }> {
	// Per-phase timeout: AbortController chained to run signal (matches runtime).
	const phaseTimeoutMs =
		typeof phase.timeout === "number" && Number.isFinite(phase.timeout) && phase.timeout >= 1000
			? phase.timeout
			: undefined;
	const attempts: UsageStats[] = [];
	let r: RunResult | undefined;
	for (let attempt = 0; attempt < 4; attempt++) {
		if (ctx.deps.signal?.aborted) break;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let forceReturnTimer: ReturnType<typeof setTimeout> | undefined;
		let onParentAbort: (() => void) | undefined;
		let callSignal: AbortSignal | undefined = ctx.deps.signal;
		let timeoutController: AbortController | undefined;
		if (phaseTimeoutMs) {
			const ac = new AbortController();
			timeoutController = ac;
			callSignal = ac.signal;
			if (ctx.deps.signal?.aborted) ac.abort();
			else if (ctx.deps.signal) {
				onParentAbort = () => ac.abort();
				ctx.deps.signal.addEventListener("abort", onParentAbort, { once: true });
			}
		}
		try {
			const invocation = ctx.deps.runTask(
				ctx.deps.cwd,
				ctx.deps.agents,
				agentName,
				task,
				{
					model: phase.model,
					thinking: phase.thinking,
					tools: phase.tools,
					cwd: ctx.deps.cwd,
					signal: callSignal,
				},
				ctx.deps.globalThinking,
			);
			if (phaseTimeoutMs) {
				const timeoutFallback = new Promise<RunResult>((resolve) => {
					timer = setTimeout(() => {
						timedOut = true;
						timeoutController?.abort();
						forceReturnTimer = setTimeout(() => resolve({
							agent: agentName,
							task,
							exitCode: 1,
							output: "",
							stderr: "",
							usage: emptyUsage(),
							stopReason: "error",
							errorMessage: `Phase runner did not stop within ${PHASE_TIMEOUT_ABORT_GRACE_MS}ms after abort`,
							phaseTimeout: true,
						}), PHASE_TIMEOUT_ABORT_GRACE_MS);
					}, phaseTimeoutMs);
				});
				r = await Promise.race([invocation, timeoutFallback]);
			} else {
				r = await invocation;
			}
		} finally {
			if (timer) clearTimeout(timer);
			if (forceReturnTimer) clearTimeout(forceReturnTimer);
			if (onParentAbort) ctx.deps.signal?.removeEventListener("abort", onParentAbort);
		}
		if (timedOut) {
			r = {
				...r,
				exitCode: r.exitCode === 0 ? 1 : r.exitCode,
				stopReason: "error",
				errorMessage: `Phase timed out after ${phaseTimeoutMs}ms (subagent aborted)`,
				phaseTimeout: true,
			};
		}
		attempts.push(r.usage ? { ...emptyUsage(), ...r.usage } : emptyUsage());
		if (!isFailedResult(r)) break;
		// The current phase has not been committed to state yet. Include prior
		// completed run usage plus every attempt made here before admitting a
		// transient retry, matching the imperative runner's live usage guard.
		if (kernelAttemptsOverBudget(ctx.state, phase.id, attempts)) break;
		if (r.phaseTimeout || phase.idempotent === false || !isTransientError(r) || attempt >= 3) break;
		const wait = Math.min(60_000, (phase.retry?.backoffMs ?? 2_000) * 2 ** attempt);
		await abortableDelay(wait, ctx.deps.signal);
	}
	if (!r) {
		r = {
			agent: agentName,
			task,
			exitCode: 1,
			output: "",
			stderr: "Aborted before execution",
			usage: emptyUsage(),
			stopReason: "aborted",
			errorMessage: "Aborted before execution",
		};
	}
	const usage = aggregateUsage(attempts);
	r = { ...r, usage, attempts: attempts.length };
	const event = baseEvent(ctx, phase.id, "subagent-call", {
		input: {
			agent: agentName,
			model: phase.model,
			task,
			nodePath,
			mapIndex,
		},
		output: {
			text: r.output ?? "",
			model: r.model,
			usage,
			stopReason: r.stopReason,
		},
	});
	return { result: r, event };
}

async function executeAgentBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	const interpCtx: InterpolationContext = {
		args: ctx.args,
		steps: ctx.steps,
	};
	const task = interpolate(phase.task ?? "", interpCtx).text;
	const agentName = phase.agent ?? "executor";

	try {
		const { result: r, event } = await runOneAgent(ctx, phase, agentName, task, phase.id);
		const failed = isFailedResult(r);
		const status: StepResult["status"] = r.phaseTimeout ? "timedOut" : failed ? "failed" : "done";
		const usage = r.usage ? { ...emptyUsage(), ...r.usage } : emptyUsage();
		return {
			midEvents: [event],
			output: r.output,
			status,
			error: failed ? r.errorMessage ?? r.stderr : undefined,
			usage,
			attempts: r.attempts,
		};
	} catch (e) {
		const err = e instanceof Error ? e.message : String(e);
		return { midEvents: [], status: "failed", error: err, usage: emptyUsage() };
	}
}

/** Resolve map-item template; supports default `{item}` and custom `as` aliases via locals. */
function resolveMapTask(template: string, phase: Phase, ctx: StepContext, item: unknown): string {
	const loopVar = phase.as ?? "item";
	return interpolate(template, {
		args: ctx.args,
		steps: ctx.steps,
		locals: { [loopVar]: item },
	}).text;
}

async function executeMapBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	const interpCtx: InterpolationContext = { args: ctx.args, steps: ctx.steps };
	const overResolved = interpolate(phase.over ?? "", interpCtx).text;
	const arr = coerceArray(safeParse(overResolved)) ?? coerceArray(overResolved);
	if (!arr) {
		const err = `map phase '${phase.id}': 'over' (${phase.over}) did not resolve to an array`;
		return { midEvents: [], status: "failed", error: err, usage: emptyUsage() };
	}
	const concurrency = typeof phase.concurrency === "number" && phase.concurrency > 0 ? phase.concurrency : 8;
	const agentName = phase.agent ?? "executor";
	const dynamic = (ctx.deps.stack ?? []).some((frame) => frame.startsWith("def:"));
	const truncated = dynamic && arr.length > MAX_DYNAMIC_MAP_ITEMS;
	const admitted = truncated ? arr.slice(0, MAX_DYNAMIC_MAP_ITEMS) : arr;
	const tasks = admitted.map((item) => ({
		agent: agentName,
		task: resolveMapTask(phase.task ?? "", phase, ctx, item),
	}));

	try {
		const midEvents: Event[] = [];
		const results = await mapWithConcurrencyLimit(tasks, concurrency, async (it, idx) => {
			const { result, event } = await runOneAgent(
				ctx,
				phase,
				it.agent,
				it.task,
				`${phase.id}#item-${idx}`,
				idx,
			);
			midEvents.push(event);
			return result;
		});
		// Order events by mapIndex for stable fold/trace
		midEvents.sort((a, b) => (a.input?.mapIndex ?? 0) - (b.input?.mapIndex ?? 0));
		const anyFailed = results.some(isFailedResult);
		const anyTimedOut = results.some((r) => r.phaseTimeout);
		const usage = aggregateUsage(results.map((r) => r.usage ?? emptyUsage()));
		const errors = results.filter(isFailedResult).map((r) => `${r.agent}: ${r.errorMessage ?? r.stderr}`);
		return {
			midEvents,
			output: combineFanoutText(results),
			status: anyTimedOut ? "timedOut" : anyFailed ? "failed" : "done",
			error: errors.length ? errors.join("; ") : undefined,
			usage,
			warnings: truncated
				? [`map fan-out truncated to MAX_DYNAMIC_MAP_ITEMS (${MAX_DYNAMIC_MAP_ITEMS}) inside a dynamic sub-flow`]
				: undefined,
		};
	} catch (e) {
		const err = e instanceof Error ? e.message : String(e);
		return { midEvents: [], status: "failed", error: err, usage: emptyUsage() };
	}
}

async function executeParallelBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	const branches = phase.branches ?? [];
	if (branches.length === 0) {
		return {
			midEvents: [],
			status: "failed",
			error: `parallel phase '${phase.id}': empty branches`,
			usage: emptyUsage(),
		};
	}
	const concurrency = typeof phase.concurrency === "number" && phase.concurrency > 0 ? phase.concurrency : 8;
	const interpCtx: InterpolationContext = { args: ctx.args, steps: ctx.steps };
	const tasks = branches.map((b) => ({
		agent: b.agent ?? phase.agent ?? "executor",
		task: interpolate(b.task, interpCtx).text,
	}));

	try {
		const midEvents: Event[] = [];
		const results = await mapWithConcurrencyLimit(tasks, concurrency, async (it, idx) => {
			const { result, event } = await runOneAgent(
				ctx,
				phase,
				it.agent,
				it.task,
				`${phase.id}#branch-${idx}`,
				idx,
			);
			midEvents.push(event);
			return result;
		});
		midEvents.sort((a, b) => (a.input?.mapIndex ?? 0) - (b.input?.mapIndex ?? 0));
		const anyFailed = results.some(isFailedResult);
		const anyTimedOut = results.some((r) => r.phaseTimeout);
		const usage = aggregateUsage(results.map((r) => r.usage ?? emptyUsage()));
		const errors = results.filter(isFailedResult).map((r) => `${r.agent}: ${r.errorMessage ?? r.stderr}`);
		return {
			midEvents,
			output: combineFanoutText(results),
			status: anyTimedOut ? "timedOut" : anyFailed ? "failed" : "done",
			error: errors.length ? errors.join("; ") : undefined,
			usage,
		};
	} catch (e) {
		const err = e instanceof Error ? e.message : String(e);
		return { midEvents: [], status: "failed", error: err, usage: emptyUsage() };
	}
}

/**
 * Dispatch one phase kind. Returns null if kind is not handled by this slice.
 * Emits phase-start → optional when-guard decision → work → phase-end.
 */
export async function stepPhase(phase: Phase, ctx: StepContext): Promise<StepResult | null> {
	const type = (phase.type ?? "agent") as string;
	if (!(EVENT_KERNEL_PHASE_TYPES as readonly string[]).includes(type)) return null;

	const events: Event[] = [
		baseEvent(ctx, phase.id, "phase-start", {
			dependencies: dependenciesOf(phase),
			optional: phase.optional === true,
		}),
	];
	if (type === "flow") {
		events.push(
			baseEvent(ctx, phase.id, "decision", {
				decision: { type: "unreplayable", reason: "inner-flow" },
			}),
		);
	}

	// when-guard (fail-open evaluateCondition matches imperative runtime)
	if (phase.when !== undefined) {
		const interpCtx: InterpolationContext = { args: ctx.args, steps: ctx.steps };
		const whenResult = evaluateCondition(phase.when, interpCtx);
		events.push(
			baseEvent(ctx, phase.id, "decision", {
				decision: {
					type: "when-guard",
					expression: phase.when,
					result: whenResult,
				},
			}),
		);
		if (!whenResult) {
			const err = `Condition not met: ${phase.when}`;
			events.push(baseEvent(ctx, phase.id, "phase-end", { status: "skipped", error: err }));
			return { events, status: "skipped", error: err, usage: emptyUsage() };
		}
	}

	let body: BodyResult & {
		gate?: StepResult["gate"];
		approval?: StepResult["approval"];
	};
	if (type === "script") body = await executeScriptBody(phase, ctx);
	else if (type === "map") body = await executeMapBody(phase, ctx);
	else if (type === "parallel") body = await executeParallelBody(phase, ctx);
	else if (type === "reduce") body = await executeReduceBody(phase, ctx);
	else if (type === "gate") body = await executeGateBody(phase, ctx);
	else if (type === "approval") body = await executeApprovalBody(phase, ctx);
	else if (type === "loop") body = await executeLoopBody(phase, ctx);
	else if (type === "tournament") body = await executeTournamentBody(phase, ctx);
	else if (type === "flow") body = await executeFlowBody(phase, ctx);
	else body = await executeAgentBody(phase, ctx);

	events.push(...body.midEvents);
	const endStatus =
		body.gate?.verdict === "block" && body.status === "done"
			? "done" // phase completes; run-level blocked handled by driver
			: body.status;
	events.push(
		baseEvent(ctx, phase.id, "phase-end", {
			status: endStatus === "timedOut" ? "timedOut" : endStatus,
			error: body.error,
		}),
	);
	return {
		events,
		output: body.output,
		status: body.status,
		error: body.error,
		usage: body.usage,
		attempts: body.attempts,
		gate: body.gate,
		approval: body.approval,
		warnings: body.warnings,
	};
}
