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
	MAX_DYNAMIC_NESTING,
	TOURNAMENT_DEFAULT_VARIANTS,
	TOURNAMENT_HARD_MAX_VARIANTS,
	asArray,
	validateTaskflow,
} from "../schema.ts";
import { parseGateVerdict, parseTournamentWinner } from "../deterministic.ts";
import { aggregateUsage, emptyUsage, type UsageStats } from "../usage.ts";
import { evaluateCondition, interpolate, interpolateValue, safeParse, tryEvaluateCondition, type InterpolationContext } from "../interpolate.ts";
import { kernelAttemptsOverBudget } from "./kernel-policy.ts";
import { abortableDelay, isFailed as isFailedResult, isTransientError, mapWithConcurrencyLimit, PHASE_TIMEOUT_ABORT_GRACE_MS } from "../runner-core.ts";
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
	warnings?: string[];
	promptStats?: StepResult["promptStats"];
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

async function runAgentCall(
	ctx: StepContext,
	phase: Phase,
	agentName: string,
	task: string,
	nodePath: string,
	mapIndex?: number,
	variantIndex?: number,
): Promise<{ result: RunResult; event: Event }> {
	const phaseTimeoutMs =
		typeof phase.timeout === "number" && Number.isFinite(phase.timeout) && phase.timeout >= 1000
			? phase.timeout
			: undefined;

	// --- Per-phase cwd resolution (0.2.4) ---
	// A literal string cwd is resolved relative to the flow cwd. Workspace
	// keywords (temp/dedicated/worktree) remain imperative-only.
	const effCwd = typeof phase.cwd === "string" && !/^(temp|dedicated|worktree)$/.test(phase.cwd)
		? (phase.cwd.startsWith("/") ? phase.cwd : `${ctx.deps.cwd}/${phase.cwd}`)
		: ctx.deps.cwd;

	// --- Context pre-read (0.2.4) ---
	// Read context files and prepend them to the task prompt, matching the
	// imperative runtime's resolvePhaseContext behavior.
	let effectiveTask = task;
	if (Array.isArray(phase.context) && phase.context.length > 0) {
		const contextParts: string[] = [];
		for (const file of phase.context) {
			if (typeof file !== "string") continue;
			try {
				const { readFileSync } = await import("node:fs");
				const { resolve } = await import("node:path");
				const filePath = resolve(effCwd, file);
				const content = readFileSync(filePath, "utf8");
				contextParts.push(`<context file="${file}">\n${content}\n</context>`);
			} catch {
				contextParts.push(`<context file="${file}">\n[file not found or unreadable]\n</context>`);
			}
		}
		if (contextParts.length > 0) {
			effectiveTask = `${contextParts.join("\n\n")}\n\n${task}`;
		}
	}

	// --- Explicit retry support (0.2.4) ---
	// The imperative runtime supports phase.retry = { max, backoffMs, factor }.
	// The kernel previously only did transient-error retries (up to 4 attempts).
	// Now we honor the declared retry.max for ALL failures (not just transient),
	// matching the imperative contract.
	const retryMax = phase.retry && typeof phase.retry === "object" ? (phase.retry.max ?? 0) : 0;
	const retryBackoffMs = phase.retry && typeof phase.retry === "object" ? (phase.retry.backoffMs ?? 2000) : 2000;
	const retryFactor = phase.retry && typeof phase.retry === "object" ? (phase.retry.factor ?? 2) : 2;
	const maxAttempts = Math.max(4, retryMax + 1); // at least 4 for transient retries

	const usages: UsageStats[] = [];
	let r: RunResult | undefined;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (ctx.deps.signal?.aborted) break;
		let timedOut = false;
		let terminalCommitted = false;
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
			const onTerminalCommit = () => {
				if (timedOut) return;
				terminalCommitted = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
			};
			ctx.promptCalls?.push(effectiveTask);
			const invocation = ctx.deps.runTask(
				effCwd,
				ctx.deps.agents,
				agentName,
				effectiveTask,
				{
					model: phase.model,
					thinking: phase.thinking,
					tools: phase.tools,
					cwd: effCwd,
					signal: callSignal,
					idleTimeoutMs: resolveIdleMs(phase, ctx.state.def),
					onTerminalCommit,
				},
				ctx.deps.globalThinking,
			);
			if (phaseTimeoutMs) {
				const timeoutFallback = new Promise<RunResult>((resolve) => {
					timer = setTimeout(() => {
						if (terminalCommitted) return;
						timedOut = true;
						timeoutController?.abort();
						forceReturnTimer = setTimeout(() => resolve({
							agent: agentName,
							task: effectiveTask,
							exitCode: 1,
							output: "",
							stderr: "",
							usage: emptyUsage(),
							stopReason: "error",
							errorMessage: `Phase runner did not stop within ${PHASE_TIMEOUT_ABORT_GRACE_MS}ms after abort`,
							phaseTimeout: true,
							completionSource: "phase-timeout",
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
				completionSource: "phase-timeout",
			};
		}
		usages.push(r.usage ? { ...emptyUsage(), ...r.usage } : emptyUsage());
		if (!isFailedResult(r)) break;
		if (kernelAttemptsOverBudget(ctx.state, phase.id, usages)) break;
		if (r.phaseTimeout || phase.idempotent === false) break;
		// Explicit retry: retry ALL failures up to retryMax, not just transient.
		const isTransient = isTransientError(r);
		const withinExplicitRetry = attempt < retryMax;
		const withinTransientRetry = isTransient && attempt < 3;
		if (!withinExplicitRetry && !withinTransientRetry) break;
		const wait = Math.min(60_000, retryBackoffMs * retryFactor ** attempt);
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
	const usage = aggregateUsage(usages);
	r = { ...r, usage, attempts: usages.length };
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
			completionSource: r.completionSource,
			reapedAfterTerminal: r.reapedAfterTerminal,
			terminalGraceMs: r.terminalGraceMs,
		},
	});
	return { result: r, event };
}

function interpCtx(ctx: StepContext, extra?: Partial<InterpolationContext>): InterpolationContext {
	return { args: ctx.args, steps: ctx.steps, onRead: (ref) => ctx.readRefs?.push(ref), ...extra };
}

/** Resolve the effective idle-watchdog ms for a phase on the kernel path:
 *  phase overrides flow; `undefined` when neither sets it (host default 300000
 *  applies). Mirrors `resolveIdleTimeoutMs` in runtime.ts — duplicated here
 *  because the kernel deliberately does not import runtime.ts (strangler cycle). */
export function resolveIdleMs(phase: Phase, def: Taskflow): number | undefined {
	const p = (phase as { idleTimeout?: unknown }).idleTimeout;
	if (typeof p === "number" && Number.isFinite(p)) return p;
	const f = def.idleTimeout;
	if (typeof f === "number" && Number.isFinite(f)) return f;
	return undefined;
}

/** Conservative prompt-size warning threshold in estimated tokens (mirrors the
 *  imperative runtime's PROMPT_SIZE_WARN_TOKENS). Crossed → a `warnings` entry. */
const KERNEL_PROMPT_SIZE_WARN_TOKENS = 32_000;

/** Compute prompt-size diagnostics for a resolved prompt (mirrors the imperative
 *  `promptSizeStats`: exact UTF-8 bytes, char count, ceil(chars/4) estTokens). */
function promptStatsFor(text: string): { bytes: number; chars: number; estTokens: number } {
	let chars = 0;
	for (const _char of text) chars++; // Unicode code points, not UTF-16 code units
	const bytes = Buffer.byteLength(text, "utf8");
	const estTokens = Math.ceil(chars / 4);
	return { bytes, chars, estTokens };
}

/** Build the promptStats StepResult field for one or more resolved prompts,
 *  appending a warning when any crosses the conservative threshold. */
export function buildPromptStats(prompts: string[]): {
	promptStats: NonNullable<StepResult["promptStats"]>;
	warnings: string[];
} {
	const calls = prompts.map(promptStatsFor);
	const warnings: string[] = [];
	for (const c of calls) {
		if (c.estTokens >= KERNEL_PROMPT_SIZE_WARN_TOKENS) {
			warnings.push(`Prompt size ≈${c.estTokens} tokens (${c.chars} chars, ${c.bytes} bytes) exceeds the conservative ${KERNEL_PROMPT_SIZE_WARN_TOKENS}-token warning threshold — the prompt may be approaching a model's context limit.`);
		}
	}
	return { promptStats: { calls }, warnings };
}

/** Aggregate stats over the completed `from[]` inputs for reduce diagnostics
 *  (kernel mirror of the imperative `reduceInputStats`). */
function reduceInputStatsKernel(state: StepContext["state"], phase: Phase): { count: number; totalBytes: number; totalChars: number; totalEstTokens: number } {
	const fromIds = asArray<string>(phase.from);
	let count = 0;
	let totalBytes = 0;
	let totalChars = 0;
	let totalEstTokens = 0;
	for (const id of fromIds) {
		const ps = state.phases[id];
		if (ps?.status === "done" && ps.output !== undefined) {
			count++;
			const s = promptStatsFor(ps.output);
			totalBytes += s.bytes;
			totalChars += s.chars;
			totalEstTokens += s.estTokens;
		}
	}
	return { count, totalBytes, totalChars, totalEstTokens };
}

/** Aggregate completed `from[]` outputs for a reduce phase's {previous.output}
 *  on the kernel path. Mirrors `aggregateReduceFrom` in runtime.ts — duplicated
 *  here because the kernel does not import runtime.ts. BREAKING (dogfood 1):
 *  one completed input → raw output; many → `### <id>\n\n<output>` joined by
 *  `\n\n---\n\n`; join:any includes only completed branches. Returns the ids
 *  aggregated (for observed reads) alongside the value. */
function aggregateReduceFromKernel(
	state: StepContext["state"],
	phase: Phase,
): { value: string | undefined; ids: string[] } {
	const fromIds = asArray<string>(phase.from);
	const completed: Array<{ id: string; output: string }> = [];
	for (const id of fromIds) {
		const ps = state.phases[id];
		if (ps?.status === "done" && ps.output !== undefined) {
			completed.push({ id, output: ps.output });
		}
	}
	if (completed.length === 0) return { value: undefined, ids: [] };
	if (completed.length === 1) return { value: completed[0].output, ids: [completed[0].id] };
	const value = completed.map((c) => `### ${c.id}\n\n${c.output}`).join("\n\n---\n\n");
	return { value, ids: completed.map((c) => c.id) };
}

/** reduce / agent-style single call. */
export async function executeReduceBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	// BREAKING (dogfood 1): a reduce phase's {previous.output} aggregates ALL
	// completed `from[]` outputs in from-array order (one → raw, many → joined).
	// The kernel path mirrors the imperative `aggregateReduceFrom` semantics.
	const reduceAgg = aggregateReduceFromKernel(ctx.state, phase);
	for (const id of reduceAgg.ids) ctx.readRefs?.push(`steps.${id}.output`);
	const task = interpolate(
		phase.task ?? "",
		interpCtx(ctx, reduceAgg.value !== undefined ? { previousOutput: reduceAgg.value } : {}),
	).text;
	const agentName = phase.agent ?? "executor";
	const { promptStats, warnings } = buildPromptStats([task]);
	const reduceInputs = reduceInputStatsKernel(ctx.state, phase);
	const psWithInputs = { ...promptStats, reduceInputs };
	try {
		const { result: r, event } = await runAgentCall(ctx, phase, agentName, task, phase.id);
		const failed = isFailedResult(r);
		return {
			midEvents: [event],
			output: r.output,
			status: r.phaseTimeout ? "timedOut" : failed ? "failed" : "done",
			error: failed ? r.errorMessage ?? r.stderr : undefined,
			usage: r.usage ?? emptyUsage(),
			promptStats: psWithInputs,
			warnings: warnings.length ? warnings : undefined,
		};
	} catch (e) {
		return {
			midEvents: [],
			status: "failed",
			error: e instanceof Error ? e.message : String(e),
			usage: emptyUsage(),
			promptStats: psWithInputs,
			warnings: warnings.length ? warnings : undefined,
		};
	}
}

/** Gate: LLM judge + parseGateVerdict (score/eval advanced paths stay on imperative). */
export async function executeGateBody(phase: Phase, ctx: StepContext): Promise<BodyResult> {
	// Zero-token eval auto-pass — MUST match imperative fail-safe (tryEvaluate + contains).
	if (Array.isArray(phase.eval) && phase.eval.length > 0) {
		const evalCtx = interpCtx(ctx);
		let allPassed = true;
		for (const check of phase.eval) {
			if (typeof check !== "string") {
				allPassed = false;
				break;
			}
			let expr = check;
			const containsIdx = expr.indexOf(" contains ");
			if (containsIdx > 0) {
				const lhs = expr.slice(0, containsIdx).trim();
				const rhs = expr.slice(containsIdx + " contains ".length).trim();
				const lhsVal = interpolate(lhs, evalCtx);
				if (lhsVal.missing.length > 0 || !lhsVal.text.includes(rhs)) {
					allPassed = false;
					break;
				}
				continue;
			}
			const { value: passed, error: evalErr } = tryEvaluateCondition(expr, evalCtx);
			if (evalErr || !passed) {
				allPassed = false;
				break;
			}
		}
		if (allPassed) {
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

	const defFailOpen = (diag: string): BodyResult => ({
		midEvents: [],
		output: "",
		status: "done",
		usage: emptyUsage(),
		// surface diagnostic without failing the run (matches runtime fail-open)
		error: undefined,
	});
	void defFailOpen; // used below; keep signature for clarity
	if (hasDef) {
		const inlineDepth = stack.filter((s) => s.startsWith("def:")).length;
		if (inlineDepth >= MAX_DYNAMIC_NESTING) {
			return {
				midEvents: [],
				output: "",
				status: "done",
				usage: emptyUsage(),
			};
		}
		const rawDef = (phase as { def?: unknown }).def;
		let parsed: unknown;
		if (typeof rawDef === "string") {
			parsed = safeParse(interpolate(rawDef, interpCtx(ctx)).text);
			if (parsed === undefined) {
				return { midEvents: [], output: "", status: "done", usage: emptyUsage() };
			}
		} else {
			parsed = rawDef;
		}
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
		// Dynamic hardening: LLM-authored defs are untrusted (script RCE, cwd escape, caps).
		const v = validateTaskflow(wrapped, { dynamic: true, cwd: ctx.deps.cwd });
		if (!v.ok) {
			return { midEvents: [], output: "", status: "done", usage: emptyUsage() };
		}
		// Pass the DECLARED def (unclamped). runNested clamps to effectiveDef
		// internally for dispatch, and its verifier preflight inspects opts.def — so
		// this makes the event kernel verify the same declared budget/concurrency
		// the imperative path verifies (wrapped), keeping the no-spend gate at parity
		// across engines (review of #84, issue 1).
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

	// Match runtime: push parent flowName so A→B→A cycles are detected.
	if (recursionKey === ctx.state.flowName || stack.includes(recursionKey) || stack.includes(ctx.state.flowName)) {
		return {
			midEvents: [],
			status: "failed",
			error: `flow phase '${phase.id}': recursive sub-flow ${[...stack, ctx.state.flowName, recursionKey].join(" -> ")}`,
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

	const provided: Record<string, unknown> = {};
	const withMap = phase.with;
	if (withMap && typeof withMap === "object") {
		for (const [k, v] of Object.entries(withMap)) {
			provided[k] = interpolateValue(v, interpCtx(ctx));
		}
	}

	const nextStack = hasDef
		? [...stack, ctx.state.flowName, recursionKey]
		: [...stack, ctx.state.flowName];
	const nested = await ctx.deps.runNested({
		def: subDef,
		args: provided,
		stack: nextStack,
		dynamic: hasDef,
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
