/**
 * Event-kernel handlers for remaining phase kinds (S2 completion):
 * reduce, gate, approval, loop, tournament, flow.
 *
 * Intentionally does not import runtime.ts. Nested flows go through
 * `StepDeps.runNested` (injected by driver).
 */

import type { Phase, Taskflow } from "../schema.ts";
import {
	LOOP_DEFAULT_MAX_ITERATIONS,
	LOOP_HARD_MAX_ITERATIONS,
	TOURNAMENT_DEFAULT_VARIANTS,
	TOURNAMENT_HARD_MAX_VARIANTS,
	validateTaskflow,
} from "../schema.ts";
import { parseGateVerdict, parseTournamentWinner } from "../deterministic.ts";
import { aggregateUsage, emptyUsage, type UsageStats } from "../usage.ts";
import { evaluateCondition, interpolate, safeParse, type InterpolationContext } from "../interpolate.ts";
import { mapWithConcurrencyLimit } from "../runner-core.ts";
import type { Event } from "./events.ts";
import { EVENT_SCHEMA_VERSION } from "./events.ts";
import type { StepContext, StepResult } from "./step.ts";
import type { RunResult } from "../host/runner-types.ts";

type BodyResult = {
	midEvents: Event[];
	output?: string;
	status: StepResult["status"];
	error?: string;
	usage: UsageStats;
	gate?: { verdict: "pass" | "block"; reason?: string };
	approval?: { decision: "approve" | "reject" | "edit"; note?: string; auto?: boolean };
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

function isFailedResult(r: RunResult): boolean {
	return (r.exitCode ?? 0) !== 0 || !!r.errorMessage || r.stopReason === "error" || r.stopReason === "aborted";
}

async function runAgentCall(
	ctx: StepContext,
	phase: Phase,
	agentName: string,
	task: string,
	nodePath: string,
	mapIndex?: number,
	variantIndex?: number,
): Promise<{ result: RunResult; event: Event }> {
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
	const usage = r.usage ? { ...emptyUsage(), ...r.usage } : emptyUsage();
	const event = baseEvent(ctx, phase.id, "subagent-call", {
		input: {
			agent: agentName,
			model: phase.model,
			task,
			nodePath,
			mapIndex,
			variantIndex,
		},
		output: {
			text: r.output ?? "",
			model: r.model,
			usage,
			stopReason: r.stopReason,
		},
	});
	return { result: { ...r, usage }, event };
}

function interpCtx(ctx: StepContext, extra?: Partial<InterpolationContext>): InterpolationContext {
	return { args: ctx.args, steps: ctx.steps, ...extra };
}

/** reduce / agent-style single call. */
export async function executeReduceBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	const task = interpolate(phase.task ?? "", interpCtx(ctx)).text;
	const agentName = phase.agent ?? "executor";
	try {
		const { result: r, event } = await runAgentCall(ctx, phase, agentName, task, phase.id);
		const failed = isFailedResult(r);
		return {
			midEvents: [event],
			output: r.output,
			status: r.phaseTimeout ? "timedOut" : failed ? "failed" : "done",
			error: failed ? r.errorMessage ?? r.stderr : undefined,
			usage: r.usage ?? emptyUsage(),
		};
	} catch (e) {
		return {
			midEvents: [],
			status: "failed",
			error: e instanceof Error ? e.message : String(e),
			usage: emptyUsage(),
		};
	}
}

/** Gate: LLM judge + parseGateVerdict (score/eval advanced paths stay on imperative). */
export async function executeGateBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	// Zero-token eval auto-pass when all eval conditions are truthy.
	if (Array.isArray(phase.eval) && phase.eval.length > 0) {
		const ctxI = interpCtx(ctx);
		const allPass = phase.eval.every((e) => evaluateCondition(String(e), ctxI));
		if (allPass) {
			return {
				midEvents: [
					baseEvent(ctx, phase.id, "decision", {
						decision: { type: "gate-verdict", value: "pass", reason: "eval checks passed" },
					}),
				],
				output: "PASS (eval checks passed — no LLM call)",
				status: "done",
				usage: emptyUsage(),
				gate: { verdict: "pass", reason: "eval checks passed" },
			};
		}
	}

	let task = interpolate(phase.task ?? "", interpCtx(ctx)).text;
	if (phase.output !== "json" || !phase.expect) {
		if (!/VERDICT\s*[:=]/i.test(task)) {
			task =
				`${task}\n\n--- Required output format ---\n` +
				`End your response with exactly one line:\nVERDICT: PASS\nor\nVERDICT: BLOCK`;
		}
	}
	const agentName = phase.agent ?? "executor";
	try {
		const { result: r, event } = await runAgentCall(ctx, phase, agentName, task, phase.id);
		const failed = isFailedResult(r);
		if (failed) {
			return {
				midEvents: [event],
				output: r.output,
				status: r.phaseTimeout ? "timedOut" : "failed",
				error: r.errorMessage ?? r.stderr,
				usage: r.usage ?? emptyUsage(),
			};
		}
		const v = parseGateVerdict(r.output ?? "");
		const midEvents: Event[] = [
			event,
			baseEvent(ctx, phase.id, "decision", {
				decision: { type: "gate-verdict", value: v.verdict, reason: v.reason },
			}),
		];
		return {
			midEvents,
			output: r.output,
			status: "done",
			usage: r.usage ?? emptyUsage(),
			gate: { verdict: v.verdict, reason: v.reason },
		};
	} catch (e) {
		return {
			midEvents: [],
			status: "failed",
			error: e instanceof Error ? e.message : String(e),
			usage: emptyUsage(),
		};
	}
}

/** Approval: interactive or auto-reject (fail-open, matches runtime). */
export async function executeApprovalBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	const message = interpolate(phase.task ?? "Approve to continue?", interpCtx(ctx)).text;
	const upstream = Object.values(ctx.steps).map((s) => s.output).filter(Boolean).at(-1);

	if (!ctx.deps.requestApproval) {
		const reason = "(auto-rejected: no interactive approver available)";
		return {
			midEvents: [
				baseEvent(ctx, phase.id, "decision", {
					decision: { type: "gate-verdict", value: "block", reason },
				}),
			],
			output: reason,
			status: "done",
			usage: emptyUsage(),
			gate: { verdict: "block", reason },
			approval: { decision: "reject", auto: true },
		};
	}

	const decision = await ctx.deps.requestApproval({
		phaseId: phase.id,
		message,
		upstream,
	});
	const note = decision.note?.trim();
	const output = note || `(${decision.decision})`;
	const gate =
		decision.decision === "reject"
			? { verdict: "block" as const, reason: note || "Rejected by user" }
			: undefined;
	const midEvents: Event[] = gate
		? [
				baseEvent(ctx, phase.id, "decision", {
					decision: { type: "gate-verdict", value: "block", reason: gate.reason },
				}),
			]
		: [];
	return {
		midEvents,
		output,
		status: "done",
		usage: emptyUsage(),
		gate,
		approval: { decision: decision.decision, note },
	};
}

/** Loop: until / convergence / maxIterations (no reflexion — imperative for that). */
export async function executeLoopBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	const agentName = phase.agent ?? "executor";
	const rawMax = phase.maxIterations ?? LOOP_DEFAULT_MAX_ITERATIONS;
	const maxIters = Math.max(1, Math.min(LOOP_HARD_MAX_ITERATIONS, Math.floor(rawMax)));
	const convergence = phase.convergence !== false;
	const midEvents: Event[] = [];
	const usages: UsageStats[] = [];
	let lastOutput = "";
	let prevOutput: string | undefined;
	let stop: "until" | "convergence" | "maxIterations" | "failed" | "aborted" = "maxIterations";

	for (let i = 1; i <= maxIters; i++) {
		if (ctx.deps.signal?.aborted) {
			stop = "aborted";
			break;
		}
		const bodyCtx = interpCtx(ctx, {
			locals: {
				loop: { iteration: i, lastOutput, maxIterations: maxIters },
			},
		});
		// Also expose loop via steps-style: interpolate uses locals for loop.* if head is loop
		const task = interpolate(phase.task ?? "", bodyCtx).text;
		const { result: r, event } = await runAgentCall(ctx, phase, agentName, task, `${phase.id}#iter-${i}`, i - 1);
		midEvents.push(event);
		usages.push(r.usage ?? emptyUsage());
		if (isFailedResult(r)) {
			return {
				midEvents,
				output: lastOutput || r.output,
				status: r.phaseTimeout ? "timedOut" : "failed",
				error: r.errorMessage ?? r.stderr ?? `loop failed at iteration ${i}`,
				usage: aggregateUsage(usages),
			};
		}
		prevOutput = lastOutput;
		lastOutput = r.output ?? "";
		if (phase.until !== undefined) {
			const untilCtx = interpCtx(ctx, {
				locals: {
					loop: { iteration: i, lastOutput, maxIterations: maxIters },
				},
				// until often references steps.<this>.json — mirror via steps update
				steps: {
					...ctx.steps,
					[phase.id]: { output: lastOutput, json: safeParse(lastOutput) },
				},
			});
			if (evaluateCondition(phase.until, untilCtx)) {
				stop = "until";
				break;
			}
		}
		if (convergence && prevOutput !== undefined && prevOutput === lastOutput) {
			stop = "convergence";
			break;
		}
	}

	void stop;
	return {
		midEvents,
		output: lastOutput,
		status: "done",
		usage: aggregateUsage(usages),
	};
}

/** Tournament: N variants + judge. */
export async function executeTournamentBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	const mode = phase.mode === "aggregate" ? "aggregate" : "best";
	const ctxI = interpCtx(ctx);
	let competitors: Array<{ agent: string; task: string }>;
	if (phase.branches && phase.branches.length > 0) {
		competitors = phase.branches.map((b) => ({
			agent: b.agent ?? phase.agent ?? "executor",
			task: interpolate(b.task, ctxI).text,
		}));
	} else {
		const n = Math.max(2, Math.min(TOURNAMENT_HARD_MAX_VARIANTS, Math.floor(phase.variants ?? TOURNAMENT_DEFAULT_VARIANTS)));
		const body = interpolate(phase.task ?? "", ctxI).text;
		const agent = phase.agent ?? "executor";
		competitors = Array.from({ length: n }, () => ({ agent, task: body }));
	}

	const concurrency = typeof phase.concurrency === "number" && phase.concurrency > 0 ? phase.concurrency : 8;
	const midEvents: Event[] = [];
	const results = await mapWithConcurrencyLimit(competitors, concurrency, async (it, idx) => {
		const { result, event } = await runAgentCall(
			ctx,
			phase,
			it.agent,
			it.task,
			`${phase.id}#variant-${idx + 1}`,
			undefined,
			idx + 1,
		);
		midEvents.push(event);
		return result;
	});
	midEvents.sort((a, b) => (a.input?.variantIndex ?? 0) - (b.input?.variantIndex ?? 0));

	const ok = results.filter((r) => !isFailedResult(r));
	const usage = aggregateUsage(results.map((r) => r.usage ?? emptyUsage()));
	if (ok.length === 0) {
		return {
			midEvents,
			status: "failed",
			error: `tournament '${phase.id}': all ${competitors.length} variants failed`,
			usage,
		};
	}
	if (ok.length === 1) {
		const winnerIdx = results.indexOf(ok[0]) + 1;
		midEvents.push(
			baseEvent(ctx, phase.id, "decision", {
				decision: { type: "tournament-winner", value: winnerIdx, reason: "only surviving variant" },
			}),
		);
		return { midEvents, output: ok[0].output, status: "done", usage };
	}

	const labelled = results
		.map((r, i) => `### Variant ${i + 1}${isFailedResult(r) ? " (failed)" : ""}\n\n${r.output}`)
		.join("\n\n---\n\n");
	const rubric =
		interpolate(phase.judge ?? "", ctxI).text.trim() ||
		"Pick the single best variant on correctness, completeness, and clarity.";
	const directive =
		mode === "best"
			? `End with: WINNER: <number> (1–${results.length})`
			: `Synthesize the best answer, then end with: WINNER: <number>`;
	const judgeTask = `${rubric}\n\n${labelled}\n\n${directive}`;
	const judgeAgent = phase.judgeAgent ?? phase.agent ?? "executor";
	const { result: judgeRes, event: judgeEv } = await runAgentCall(
		ctx,
		phase,
		judgeAgent,
		judgeTask,
		`${phase.id}#judge`,
	);
	midEvents.push(judgeEv);
	const totalUsage = aggregateUsage([usage, judgeRes.usage ?? emptyUsage()]);

	if (isFailedResult(judgeRes)) {
		midEvents.push(
			baseEvent(ctx, phase.id, "decision", {
				decision: { type: "tournament-winner", value: results.indexOf(ok[0]) + 1, reason: "judge failed" },
			}),
		);
		return { midEvents, output: ok[0].output, status: "done", usage: totalUsage };
	}

	const { winner, reason } = parseTournamentWinner(judgeRes.output ?? "", results.length);
	const winnerResult = results[winner - 1];
	const chosen = !winnerResult || isFailedResult(winnerResult) ? ok[0] : winnerResult;
	const winnerIdx = results.indexOf(chosen) + 1;
	const output = mode === "aggregate" ? judgeRes.output : chosen.output;
	midEvents.push(
		baseEvent(ctx, phase.id, "decision", {
			decision: { type: "tournament-winner", value: winnerIdx, reason },
		}),
	);
	return { midEvents, output, status: "done", usage: totalUsage };
}

/** Nested flow: saved `use` or inline `def` via StepDeps.runNested. */
export async function executeFlowBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	const hasDef = (phase as { def?: unknown }).def !== undefined;
	const stack = ctx.deps.stack ?? [];
	let subDef: Taskflow | undefined;
	let recursionKey: string;

	if (hasDef) {
		const rawDef = (phase as { def?: unknown }).def;
		let parsed: unknown;
		if (typeof rawDef === "string") {
			parsed = safeParse(interpolate(rawDef, interpCtx(ctx)).text);
			if (parsed === undefined) {
				return {
					midEvents: [],
					output: "",
					status: "done",
					usage: emptyUsage(),
					error: undefined,
				};
			}
		} else {
			parsed = rawDef;
		}
		// Normalize
		let wrapped: Taskflow | undefined;
		if (Array.isArray(parsed)) {
			wrapped = { name: `${phase.id}-inline`, phases: parsed as Taskflow["phases"] };
		} else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Taskflow).phases)) {
			const o = parsed as Taskflow;
			wrapped = { ...o, name: o.name || `${phase.id}-inline` };
		}
		if (!wrapped) {
			return { midEvents: [], output: "", status: "done", usage: emptyUsage() };
		}
		if (wrapped.phases.length === 0) {
			return { midEvents: [], output: "", status: "done", usage: emptyUsage() };
		}
		const v = validateTaskflow(wrapped);
		if (!v.ok) {
			return { midEvents: [], output: "", status: "done", usage: emptyUsage() };
		}
		subDef = wrapped;
		recursionKey = `def:${subDef.name}`;
	} else {
		const useName = phase.use;
		if (!useName) {
			return {
				midEvents: [],
				status: "failed",
				error: `flow phase '${phase.id}' requires 'use' or 'def'`,
				usage: emptyUsage(),
			};
		}
		if (!ctx.deps.loadFlow) {
			return {
				midEvents: [],
				status: "failed",
				error: `flow phase '${phase.id}': no sub-flow loader available`,
				usage: emptyUsage(),
			};
		}
		subDef = ctx.deps.loadFlow(useName);
		if (!subDef) {
			return {
				midEvents: [],
				status: "failed",
				error: `flow phase '${phase.id}': saved flow not found: '${useName}'`,
				usage: emptyUsage(),
			};
		}
		recursionKey = useName;
	}

	if (recursionKey === ctx.state.flowName || stack.includes(recursionKey)) {
		return {
			midEvents: [],
			status: "failed",
			error: `flow phase '${phase.id}': recursive sub-flow`,
			usage: emptyUsage(),
		};
	}

	if (!ctx.deps.runNested) {
		return {
			midEvents: [],
			status: "failed",
			error: `flow phase '${phase.id}': nested runner not available`,
			usage: emptyUsage(),
		};
	}

	// Resolve `with` args
	const provided: Record<string, unknown> = {};
	const withMap = phase.with;
	if (withMap && typeof withMap === "object") {
		for (const [k, v] of Object.entries(withMap)) {
			provided[k] = typeof v === "string" ? interpolate(v, interpCtx(ctx)).text : v;
		}
	}

	const nested = await ctx.deps.runNested({
		def: subDef,
		args: provided,
		stack: [...stack, recursionKey],
	});

	return {
		midEvents: nested.events,
		output: nested.finalOutput,
		status: nested.ok ? "done" : "failed",
		error: nested.ok ? undefined : nested.finalOutput || "sub-flow failed",
		usage: nested.usage,
		gate: nested.blocked ? { verdict: "block", reason: "sub-flow blocked" } : undefined,
	};
}
