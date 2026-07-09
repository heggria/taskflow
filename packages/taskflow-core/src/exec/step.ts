/**
 * exec/step — per-node handlers for the event-sourced kernel (RFC §6.3, S2).
 *
 * First slice: **agent** and **script** only. Each handler executes one node
 * and returns events to append (it does not mutate RunState — fold does that).
 *
 * Deliberately does **not** import `runtime.ts` (avoids circular deps with the
 * strangler switch that imports this package).
 */

import { spawn } from "node:child_process";
import type { Phase } from "../schema.ts";
import type { RunState } from "../store.ts";
import type { AgentConfig } from "../agents.ts";
import type { RunOptions, RunResult } from "../host/runner-types.ts";
import type { Event } from "./events.ts";
import { EVENT_SCHEMA_VERSION } from "./events.ts";
import { emptyUsage, type UsageStats } from "../usage.ts";
import { evaluateCondition, interpolate, type InterpolationContext } from "../interpolate.ts";

export type RunTaskFn = (
	cwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	opts: RunOptions,
	globalThinking?: string,
) => Promise<RunResult>;

export interface StepDeps {
	cwd: string;
	agents: AgentConfig[];
	runTask: RunTaskFn;
	signal?: AbortSignal;
	globalThinking?: string;
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
}

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

/** Run a shell script phase (no LLM). Captures stdout. */
export async function stepScript(phase: Phase, ctx: StepContext): Promise<StepResult> {
	return stepPhase({ ...phase, type: "script" }, ctx) as Promise<StepResult>;
}

/** Run a single agent phase via the injected runner. */
export async function stepAgent(phase: Phase, ctx: StepContext): Promise<StepResult> {
	return stepPhase({ ...phase, type: "agent" }, ctx) as Promise<StepResult>;
}

async function executeScriptBody(
	phase: Phase,
	ctx: StepContext,
): Promise<{ midEvents: Event[]; output?: string; status: StepResult["status"]; error?: string; usage: UsageStats }> {
	const run = phase.run;
	if (!run || (Array.isArray(run) && run.length === 0)) {
		const err = "script phase missing `run`";
		return { midEvents: [], status: "failed", error: err, usage: emptyUsage() };
	}
	const argv = Array.isArray(run) ? run.map(String) : ["bash", "-lc", String(run)];
	const [cmd, ...args] = argv;
	const timeoutMs = typeof phase.timeout === "number" ? phase.timeout : 120_000;
	const cwd = ctx.deps.cwd;

	const result = await new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
		const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const t = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, timeoutMs);
		child.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (e) => {
			clearTimeout(t);
			resolve({ code: 1, stdout, stderr: e.message, timedOut: false });
		});
		child.on("close", (code) => {
			clearTimeout(t);
			resolve({ code: code ?? 1, stdout, stderr, timedOut });
		});
	});

	const status: StepResult["status"] = result.timedOut ? "timedOut" : result.code === 0 ? "done" : "failed";
	const text = result.stdout.trimEnd();
	const usage = emptyUsage(); // scripts spend zero LLM tokens
	const midEvents: Event[] = [
		baseEvent(ctx, phase.id, "subagent-call", {
			input: {
				agent: "script",
				task: argv.join(" "),
				nodePath: phase.id,
			},
			output: {
				text,
				usage,
				stopReason: result.timedOut ? "timeout" : result.code === 0 ? "end" : "error",
			},
		}),
	];
	return {
		midEvents,
		output: text,
		status,
		error: status === "failed" ? result.stderr || `exit ${result.code}` : undefined,
		usage,
	};
}

async function executeAgentBody(
	phase: Phase,
	ctx: StepContext,
): Promise<{ midEvents: Event[]; output?: string; status: StepResult["status"]; error?: string; usage: UsageStats }> {
	const interpCtx: InterpolationContext = {
		args: ctx.args,
		steps: ctx.steps,
	};
	const task = interpolate(phase.task ?? "", interpCtx).text;
	const agentName = phase.agent ?? "executor";

	try {
		const r = await ctx.deps.runTask(
			ctx.deps.cwd,
			ctx.deps.agents,
			agentName,
			task,
			{
				model: phase.model,
				thinking: phase.thinking,
				tools: phase.tools,
				cwd: ctx.deps.cwd,
				signal: ctx.deps.signal,
			},
			ctx.deps.globalThinking,
		);
		const failed = (r.exitCode ?? 0) !== 0 || !!r.errorMessage;
		const status: StepResult["status"] = r.phaseTimeout ? "timedOut" : failed ? "failed" : "done";
		const usage = r.usage ? { ...emptyUsage(), ...r.usage } : emptyUsage();
		const midEvents: Event[] = [
			baseEvent(ctx, phase.id, "subagent-call", {
				input: {
					agent: agentName,
					model: phase.model,
					task,
					nodePath: phase.id,
				},
				output: {
					text: r.output ?? "",
					model: r.model,
					usage,
					stopReason: r.stopReason,
				},
			}),
		];
		return {
			midEvents,
			output: r.output,
			status,
			error: failed ? r.errorMessage ?? r.stderr : undefined,
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
	const type = phase.type ?? "agent";
	if (type !== "script" && type !== "agent") return null;

	const events: Event[] = [baseEvent(ctx, phase.id, "phase-start")];

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

	const body = type === "script" ? await executeScriptBody(phase, ctx) : await executeAgentBody(phase, ctx);
	events.push(...body.midEvents);
	events.push(
		baseEvent(ctx, phase.id, "phase-end", {
			status: body.status,
			error: body.error,
		}),
	);
	return {
		events,
		output: body.output,
		status: body.status,
		error: body.error,
		usage: body.usage,
	};
}
