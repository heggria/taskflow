/**
 * Taskflow runtime — the orchestration engine.
 *
 * Resolves the phase DAG into topological layers and executes each phase by
 * delegating to isolated subagents. Intermediate phase outputs live here (in
 * RunState) and never enter the host conversation's context window — only the
 * final phase output is returned to the caller.
 *
 * Supports resume: phases whose resolved input hash matches a cached completed
 * result are skipped.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { AgentConfig } from "./agents.ts";
import { coerceArray, evaluateCondition, interpolate, type InterpolationContext, safeParse } from "./interpolate.ts";
import { isFailed, type LiveUpdate, mapWithConcurrencyLimit, runAgentTask, type RunResult } from "./runner.ts";
import { aggregateUsage, emptyUsage, type UsageStats } from "./usage.ts";
import { type Budget, dependenciesOf, finalPhase, type Phase, resolveArgs, type Taskflow, topoLayers } from "./schema.ts";
import { hashInput, newRunId, type PhaseState, type RunState } from "./store.ts";

/** A human-in-the-loop approval request raised by an `approval` phase. */
export interface ApprovalRequest {
	phaseId: string;
	/** Interpolated prompt shown to the human. */
	message: string;
	/** Output of the immediately-upstream phase, for context. */
	upstream?: string;
}

/** The human's decision. `edit` carries guidance passed downstream as the phase output. */
export interface ApprovalDecision {
	decision: "approve" | "reject" | "edit";
	note?: string;
}

export interface RuntimeDeps {
	cwd: string;
	agents: AgentConfig[];
	globalThinking?: string;
	signal?: AbortSignal;
	/** Persist run state after each phase (for resume). */
	persist?: (state: RunState) => void;
	/** Live progress callback for TUI streaming. */
	onProgress?: (state: RunState) => void;
	/** Injectable task runner (defaults to spawning a real subagent). Enables testing. */
	runTask?: typeof runAgentTask;
	/** Resolve an `approval` phase. Omit for non-interactive runs (auto-approve). */
	requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
	/** Resolve a saved taskflow by name for `flow` (sub-workflow) phases. */
	loadFlow?: (name: string) => Taskflow | undefined;
	/** Internal: sub-flow call stack, for recursion detection. */
	_stack?: string[];
}

export interface RuntimeResult {
	state: RunState;
	finalOutput: string;
	ok: boolean;
	totalUsage: UsageStats;
}

function buildInterpolationContext(
	state: RunState,
	previousOutput: string | undefined,
	locals?: Record<string, unknown>,
): InterpolationContext {
	const steps: Record<string, { output: string; json?: unknown }> = {};
	for (const [id, ps] of Object.entries(state.phases)) {
		if (ps.status === "done" && ps.output !== undefined) {
			steps[id] = { output: ps.output, json: ps.json };
		}
	}
	return { args: state.args, steps, previousOutput, locals };
}

function resultToPhaseState(id: string, r: RunResult, inputHash: string, parseJson: boolean): PhaseState {
	const failed = isFailed(r);
	const attempts = attemptsOf(r);
	return {
		id,
		status: failed ? "failed" : "done",
		output: r.output,
		json: parseJson && !failed ? safeParse(r.output) : undefined,
		usage: r.usage,
		model: r.model,
		attempts: attempts > 1 ? attempts : undefined,
		error: failed ? r.errorMessage || r.stderr || r.output : undefined,
		inputHash,
		endedAt: Date.now(),
	};
}

/** Attempts recorded by the retry wrapper (defaults to 1). */
function attemptsOf(r: RunResult): number {
	const a = r.attempts;
	return typeof a === "number" && a > 0 ? a : 1;
}

/** Cancellable delay used between retry attempts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (ms <= 0) return resolve();
		let onAbort: (() => void) | undefined;
		const t = setTimeout(() => {
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal) {
			if (signal.aborted) {
				clearTimeout(t);
				return resolve();
			}
			onAbort = () => {
				clearTimeout(t);
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function failPhase(id: string, error: string): PhaseState {
	return { id, status: "failed", error, inputHash: hashInput(id, error), endedAt: Date.now(), usage: emptyUsage() };
}

/** Aggregate run cost/tokens so far and test against the budget. */
function overBudget(state: RunState): { over: boolean; reason: string } {
	const budget: Budget | undefined = state.def.budget;
	if (!budget) return { over: false, reason: "" };
	const u = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
	if (budget.maxUSD !== undefined && u.cost > budget.maxUSD) {
		return { over: true, reason: `cost $${u.cost.toFixed(3)} exceeded cap $${budget.maxUSD}` };
	}
	if (budget.maxTokens !== undefined && u.input + u.output > budget.maxTokens) {
		return { over: true, reason: `tokens ${u.input + u.output} exceeded cap ${budget.maxTokens}` };
	}
	return { over: false, reason: "" };
}

/** Merge several sub-results into a single PhaseState (for map/parallel). */
function mergePhaseState(
	id: string,
	results: RunResult[],
	inputHash: string,
	parseJson: boolean,
): PhaseState {
	const budgetSkips = results.filter((r) => r.stopReason === "budget-skipped");
	const ran = results.filter((r) => r.stopReason !== "budget-skipped");
	const anyFailed = ran.some(isFailed);
	const usage = aggregateUsage(results.map((r) => r.usage));
	// B12: surface the model(s) used in the fan-out so consumers can show
	// which model produced the merged output.
	const model = ran.find((r) => r.model !== undefined)?.model;
	// Combine outputs as a labelled list; also expose a JSON array of outputs.
	const combinedText = ran
		.map((r, i) => `### [${i + 1}/${ran.length}] ${r.agent}${isFailed(r) ? " (failed)" : ""}\n\n${r.output}`)
		.join("\n\n---\n\n");
	// Only successful runs feed the parsed JSON array (no error/skip strings).
	const jsonArray = parseJson ? ran.filter((r) => !isFailed(r)).map((r) => safeParse(r.output) ?? r.output) : undefined;
	const failedCount = ran.filter(isFailed).length;
	const attempts = results.reduce((sum, r) => sum + attemptsOf(r), 0);
	const errors = ran.filter(isFailed).map((r) => `${r.agent}: ${r.errorMessage ?? r.stderr}`);
	if (budgetSkips.length) errors.push(`${budgetSkips.length} item(s) skipped: budget exceeded`);
	return {
		id,
		status: anyFailed ? "failed" : "done",
		output: combinedText,
		json: jsonArray,
		usage,
		model,
		attempts: attempts > results.length ? attempts : undefined,
		budgetTruncated: budgetSkips.length > 0 || undefined,
		subProgress: { done: ran.length, total: results.length, running: 0, failed: failedCount },
		error: errors.length ? errors.join("; ") : undefined,
		inputHash,
		endedAt: Date.now(),
	};
}

/**
 * A live-update sink that mirrors a subagent's streaming progress into a single
 * phase's state row, then notifies the TUI. Shared by all single-agent phases.
 */
function liveSink(state: RunState, phaseId: string, emitProgress: () => void): (l: LiveUpdate) => void {
	return (l: LiveUpdate) => {
		const live = state.phases[phaseId];
		if (live) {
			live.liveText = l.text;
			live.usage = l.usage;
			live.model = l.model;
		}
		emitProgress();
	};
}


/**
 * Pre-read files listed in a phase's `context` field and return them as
 * markdown code blocks. Handles:
 * - literal paths
 * - interpolation refs (e.g. `{steps.scout.json}` resolving to `["a.ts"]`)
 * - per-file truncation via `contextLimit`
 *
 * The result is a single string that should be prepended to the phase task so
 * the subagent never needs to spend turns on file exploration.
 */
const CONTEXT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TOTAL_CONTEXT_CHARS = 200_000;

async function resolvePhaseContext(
	phase: Phase,
	ctx: InterpolationContext,
): Promise<string> {
	const entries = phase.context;
	if (!entries || entries.length === 0) return "";
	const limit = phase.contextLimit ?? 8000;

	const paths: string[] = [];
	for (const entry of entries) {
		const r = interpolate(entry, ctx);
		if (r.text !== entry) {
			// Resolved — may be a JSON array from {steps.X.json}
			const parsed = safeParse(r.text);
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					if (typeof item === "string" && item.trim()) paths.push(item.trim());
				}
			} else if (typeof r.text === "string" && r.text.trim()) {
				paths.push(r.text.trim());
			}
		} else {
			// Unchanged — literal path
			paths.push(entry);
		}
	}

	const unique = Array.from(new Set(paths));

	// Diagnose JSON blobs masquerading as file paths — common when a context
	// entry like {steps.discover.output} resolves to {"files":[...]} instead
	// of a flat path or JSON array. The author should use {steps.discover.json.files}.
	const jsonBlobs = unique.filter((p) => p.startsWith("{"));
	for (const blob of jsonBlobs) {
		console.warn(
			`[taskflow] Context entry "${blob.slice(0, 80)}…" looks like a JSON object, not a file path. ` +
				`Use {steps.<id>.json.<field>} to extract a specific field.`,
		);
	}
	const filtered = jsonBlobs.length ? unique.filter((p) => !p.startsWith("{")) : unique;

	const blocks: string[] = [];
	for (const p of filtered) {
		try {
			const abs = path.resolve(p);
			const stat = fs.statSync(abs);
			if (!stat.isFile()) continue;
			if (stat.size > CONTEXT_MAX_FILE_BYTES) continue;
			const content = fs.readFileSync(abs, "utf-8");
			const truncated =
				content.length > limit
					? content.slice(0, limit) + `\n... [truncated ${content.length - limit} chars]`
					: content;
			const ext = path.extname(p).slice(1) || "txt";
			blocks.push(`## File: ${p}\n\n\`\`\`${ext}\n${truncated}\n\`\`\``);
		} catch {
			console.warn(`[taskflow] Skipped unreadable context file: ${p}`);
		}
	}

	// Safety cap: truncate total context when too many files are listed.
	let result = blocks.join("\n\n") + "\n\n";
	if (result.length > MAX_TOTAL_CONTEXT_CHARS) {
		result = result.slice(0, MAX_TOTAL_CONTEXT_CHARS) + `\n\n... [truncated ${result.length - MAX_TOTAL_CONTEXT_CHARS} total chars]`;
	}
	return result;
}


async function executePhase(
	phase: Phase,
	state: RunState,
	deps: RuntimeDeps,
	prior: PhaseState | undefined,
	emitProgress: () => void,
): Promise<PhaseState> {
	const type = phase.type ?? "agent";
	const concurrency = phase.concurrency ?? state.def.concurrency ?? 8;
	const previousOutput = lastCompletedOutput(state, phase);
	const run = deps.runTask ?? runAgentTask;

	// Resolve context pre-read files once, before any type branching.
	// The content is prepended to every task so the subagent never spends
	// turns on file exploration for files the flow author already knows.
	const ctx = buildInterpolationContext(state, previousOutput);
	const preRead = await resolvePhaseContext(phase, ctx);

	const baseRun = (agentName: string, task: string, onLive?: (l: LiveUpdate) => void) =>
		run(
			deps.cwd,
			deps.agents,
			agentName,
			task,
			{
				model: phase.model,
				thinking: phase.thinking,
				tools: phase.tools,
				cwd: phase.cwd,
				signal: deps.signal,
				onLive,
			},
			deps.globalThinking,
		);

	// Wrap each subagent call in the phase's retry policy. Usage is summed across
	// attempts; the attempt count rides along on the result for the TUI.
	const retry = phase.retry;
	const runOne = async (agentName: string, task: string, onLive?: (l: LiveUpdate) => void): Promise<RunResult> => {
		const maxAttempts = Math.max(1, 1 + Math.max(0, Math.floor(retry?.max ?? 0)));
		const usages: UsageStats[] = [];
		let last: RunResult | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (deps.signal?.aborted) break;
			last = await baseRun(agentName, task, onLive);
			usages.push(last.usage);
			// B6: aggregate and surface cumulative usage before the retry decision,
			// so the TUI / budget guard see the in-flight spend on every attempt.
			const liveRetry = state.phases[phase.id];
			if (liveRetry) liveRetry.usage = aggregateUsage(usages);
			if (!isFailed(last)) break;
			// Stop retrying on abort or once the run is over budget.
			if (deps.signal?.aborted || overBudget(state).over) break;
			if (attempt < maxAttempts - 1) {
				const wait = Math.min(60000, Math.round((retry?.backoffMs ?? 0) * (retry?.factor ?? 1) ** attempt));
				await delay(wait, deps.signal);
			}
		}
		// Aborted before any attempt ran → return a clean aborted result (no crash).
		if (!last) {
			return {
				agent: agentName,
				task,
				exitCode: 1,
				output: "",
				stderr: "Aborted before execution",
				usage: emptyUsage(),
				stopReason: "aborted",
				errorMessage: "Aborted before execution",
				attempts: 0,
			};
		}
		if (usages.length > 1) last.usage = aggregateUsage(usages);
		last.attempts = usages.length;
		return last;
	};

	const parseJson = phase.output === "json";

	// Runs a list of sub-tasks with live fan-out progress + aggregate live usage/activity.
	const runFanout = async (items: Array<{ agent: string; task: string }>): Promise<RunResult[]> => {
		let done = 0;
		let running = 0;
		let failed = 0;
		const total = items.length;
		const live = state.phases[phase.id];
		const liveUsages: UsageStats[] = items.map(() => emptyUsage());
		let latestText = "";
		let latestModel: string | undefined;
		const refresh = () => {
			if (live) {
				live.subProgress = { done, total, running, failed };
				live.usage = aggregateUsage(liveUsages);
				live.liveText = latestText;
				live.model = latestModel;
			}
			emitProgress();
		};
		refresh();
		return mapWithConcurrencyLimit(items, concurrency, async (it, idx) => {
			// Budget guard: stop spawning new fan-out items once the run is over budget.
			if (overBudget(state).over) {
				done++;
				refresh();
				return {
					agent: it.agent,
					task: it.task,
					exitCode: 0,
					output: "(skipped: budget exceeded)",
					stderr: "",
					usage: emptyUsage(),
					stopReason: "budget-skipped",
				} satisfies RunResult;
			}
			running++;
			refresh();
			const r = await runOne(it.agent, it.task, (l) => {
				liveUsages[idx] = l.usage;
				if (l.text) latestText = l.text;
				if (l.model) latestModel = l.model;
				refresh();
			});
			running--;
			done++;
			if (isFailed(r)) failed++;
			liveUsages[idx] = r.usage;
			refresh();
			return r;
		});
	};

	// Single-agent phases: agent, gate, and reduce all run one subagent on an
	// interpolated task. gate additionally parses a verdict; reduce simply pulls
	// its inputs from `from` phases (already exposed via interpolation).
	if (type === "agent" || type === "gate" || type === "reduce") {
		const { text } = interpolate(phase.task ?? "", ctx);
		const fullTask = preRead + text;
		const agentName = resolveAgent(phase.agent, deps, state);
		const inputHash = hashInput(phase.id, agentName, fullTask);
		const cached = cachedPhase(prior, inputHash);
		if (cached) return cached;

		const r = await runOne(agentName, fullTask, liveSink(state, phase.id, emitProgress));
		const ps = resultToPhaseState(phase.id, r, inputHash, parseJson);
		if (type === "gate" && ps.status === "done") ps.gate = parseGateVerdict(r.output);
		return ps;
	}

	if (type === "parallel") {
		const branches = (phase.branches ?? []).map((b) => {
			const r = interpolate(b.task, ctx);
			return {
				agent: resolveAgent(b.agent ?? phase.agent, deps, state),
				task: preRead + r.text,
			};
		});
		const inputHash = hashInput(phase.id, JSON.stringify(branches));
		const cached = cachedPhase(prior, inputHash);
		if (cached) return cached;

		const results = await runFanout(branches);
		return mergePhaseState(phase.id, results, inputHash, parseJson);
	}

	if (type === "map") {
		const overResolved = interpolate(phase.over ?? "", ctx).text;
		// `over` may itself be a placeholder that resolved to a JSON string.
		const arr = coerceArray(safeParse(overResolved)) ?? coerceArray(directRef(phase.over ?? "", state));
		if (!arr) {
			return {
				id: phase.id,
				status: "failed",
				error: `map phase '${phase.id}': 'over' (${phase.over}) did not resolve to an array`,
				inputHash: hashInput(phase.id, "no-array"),
				endedAt: Date.now(),
				usage: emptyUsage(),
			};
		}
		const loopVar = phase.as ?? "item";
		const tasks = arr.map((item) => {
			const localCtx = buildInterpolationContext(state, previousOutput, { [loopVar]: item });
			return {
				agent: resolveAgent(phase.agent, deps, state),
				task: preRead + interpolate(phase.task ?? "", localCtx).text,
			};
		});
		const inputHash = hashInput(phase.id, JSON.stringify(tasks));
		const cached = cachedPhase(prior, inputHash);
		if (cached) return cached;

		const results = await runFanout(tasks);
		return mergePhaseState(phase.id, results, inputHash, parseJson);
	}

	if (type === "approval") {
		const ctx = buildInterpolationContext(state, previousOutput);
		const message = interpolate(phase.task ?? "Approve to continue?", ctx).text;
		const inputHash = hashInput(phase.id, "approval", message);
		const cached = cachedPhase(prior, inputHash);
		if (cached) return cached;

		// Non-interactive (headless/CI/tests): auto-approve, fail-open, but record it.
		if (!deps.requestApproval) {
			return {
				id: phase.id,
				status: "done",
				output: "(auto-approved: no interactive approver available)",
				approval: { decision: "approve", auto: true },
				usage: emptyUsage(),
				inputHash,
				endedAt: Date.now(),
			};
		}
		const decision = await deps.requestApproval({ phaseId: phase.id, message, upstream: previousOutput });
		const note = decision.note?.trim();
		const ps: PhaseState = {
			id: phase.id,
			status: "done",
			output: note || `(${decision.decision})`,
			approval: { decision: decision.decision, note },
			usage: emptyUsage(),
			inputHash,
			endedAt: Date.now(),
		};
		// A rejection halts the flow via the same mechanism as a blocking gate.
		if (decision.decision === "reject") {
			ps.gate = { verdict: "block", reason: note || "Rejected by user" };
		}
		return ps;
	}

	if (type === "flow") {
		const ctx = buildInterpolationContext(state, previousOutput);
		const name = phase.use;
		if (!name) return failPhase(phase.id, `flow phase '${phase.id}' requires 'use'`);
		if (!deps.loadFlow) return failPhase(phase.id, `flow phase '${phase.id}': no sub-flow loader available`);
		const subDef = deps.loadFlow(name);
		if (!subDef) return failPhase(phase.id, `flow phase '${phase.id}': saved flow not found: '${name}'`);
		const stack = deps._stack ?? [];
		if (name === state.flowName || stack.includes(name)) {
			return failPhase(phase.id, `flow phase '${phase.id}': recursive sub-flow ${[...stack, state.flowName, name].join(" -> ")}`);
		}
		// Resolve sub-flow args (interpolate string values), then apply declared defaults.
		const provided: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(phase.with ?? {})) {
			provided[k] = typeof v === "string" ? interpolate(v, ctx).text : v;
		}
		const subArgs = resolveArgs(subDef, provided);
		const inputHash = hashInput(phase.id, `flow:${name}`, preRead, JSON.stringify(subArgs));
		const cached = cachedPhase(prior, inputHash);
		if (cached) return cached;

		const live = state.phases[phase.id];
		// Sub-flows enforce their own budget; if they declare none, inherit the
		// parent cap as a soft per-flow ceiling (best-effort — spend does not cross
		// flow boundaries, so the parent's already-spent total is not subtracted).
		const subDefEffective = subDef.budget || !state.def.budget ? subDef : { ...subDef, budget: state.def.budget };
		const subState: RunState = {
			runId: newRunId(subDef.name),
			flowName: subDef.name,
			def: subDefEffective,
			args: subArgs,
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: phase.cwd ?? deps.cwd,
		};
		// B8: pass this flow phase's preRead content to every sub-flow phase by
		// wrapping runTask — sub-phase preRead still gets prepended on top of it.
		const baseRunTask = deps.runTask ?? runAgentTask;
		const subRunTask: typeof runAgentTask = (cwd, agents, agentName, subTask, opts, globalThinking) =>
			baseRunTask(cwd, agents, agentName, preRead + subTask, opts, globalThinking);
		const subResult = await executeTaskflow(subState, {
			...deps,
			// Override deps.cwd with the flow phase's own cwd so that sub-flow
			// phases without an explicit cwd derive their subagents from the
			// flow's cwd (not the caller's cwd).
			cwd: phase.cwd ?? deps.cwd,
			runTask: subRunTask,
			_stack: [...stack, state.flowName],
			persist: undefined,
			onProgress: () => {
				if (live) {
					const ph = Object.values(subState.phases);
					// B-F015: `done` must include both success and failure so the
					// renderer's `done - failed` shows the true success count.
					live.subProgress = {
						done: ph.filter((p) => p.status === "done" || p.status === "failed").length,
						total: subDef.phases.length,
						running: ph.filter((p) => p.status === "running").length,
						failed: ph.filter((p) => p.status === "failed").length,
					};
					const cur = ph.find((p) => p.status === "running");
					if (cur) live.liveText = `↳ ${cur.id}${cur.liveText ? `: ${cur.liveText}` : ""}`;
					live.usage = aggregateUsage(ph.map((p) => p.usage ?? emptyUsage()));
				}
				emitProgress();
			},
		});
		const sp = Object.values(subState.phases);
		return {
			id: phase.id,
			status: subResult.ok ? "done" : "failed",
			output: subResult.finalOutput,
			json: parseJson ? safeParse(subResult.finalOutput) : undefined,
			usage: subResult.totalUsage,
			// B-F015: include failed in `done` so the renderer's
			// `done - failed` formula gives the success count (matches the
			// map/parallel runner's overlapping-counter convention).
			subProgress: {
				done: sp.filter((p) => p.status === "done" || p.status === "failed").length,
				total: subDef.phases.length,
				running: 0,
				failed: sp.filter((p) => p.status === "failed").length,
			},
			error: subResult.ok ? undefined : `sub-flow '${name}' ${subResult.state.status}`,
			inputHash,
			endedAt: Date.now(),
		};
	}

	return {
		id: phase.id,
		status: "failed",
		error: `Unknown phase type: ${type}`,
		endedAt: Date.now(),
		usage: emptyUsage(),
	};
}

/** Resolve a `{steps.x.json}`-style ref directly to its parsed value (bypassing stringify). */
function directRef(over: string, state: RunState): unknown {
	const m = over.match(/^\{steps\.([a-zA-Z0-9_-]+)\.(output|json)(?:\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*))?\}$/);
	if (!m) return undefined;
	const step = state.phases[m[1]];
	if (!step || step.status !== "done") return undefined;
	let value: unknown;
	if (m[2] === "json") value = step.json ?? safeParse(step.output ?? "");
	else value = safeParse(step.output ?? "");
	if (m[3]) {
		for (const key of m[3].split(".")) {
			if (value == null || typeof value !== "object") return undefined;
			value = (value as Record<string, unknown>)[key];
		}
	}
	return value;
}

function lastCompletedOutput(state: RunState, phase: Phase): string | undefined {
	const deps = dependenciesOf(phase);
	for (let i = deps.length - 1; i >= 0; i--) {
		const ps = state.phases[deps[i]];
		if (ps?.status === "done") return ps.output;
	}
	return undefined;
}

function cachedPhase(prior: PhaseState | undefined, inputHash: string): PhaseState | null {
	if (prior && prior.status === "done" && prior.inputHash === inputHash) {
		return { ...prior, status: "done" };
	}
	return null;
}

/**
 * Resolve an agent name against available agents. Falls back to the default
 * agent if the requested agent isn't found, logging a warning via safeEmit.
 */
function resolveAgent(name: string | undefined, deps: RuntimeDeps, state: RunState): string {
	const resolved = name ?? defaultAgent(deps);
	if (name && !deps.agents.some((a) => a.name === name)) {
		const fallback = defaultAgent(deps);
		// Log only once per run to avoid noise.
		if (!(state as any).__unknownAgentWarned) {
			(state as any).__unknownAgentWarned = new Set<string>();
		}
		if (!(state as any).__unknownAgentWarned.has(name)) {
			(state as any).__unknownAgentWarned.add(name);
			console.warn(`[taskflow] Unknown agent "${name}", falling back to "${fallback}". Use action=agents to list available agents.`);
		}
		return fallback;
	}
	return resolved;
}

function defaultAgent(deps: RuntimeDeps): string {
	return deps.agents[0]?.name ?? "default";
}

/**
 * Parse a gate phase's output into a verdict. Blocks the flow only on an
 * explicit negative signal; ambiguous output passes (fail-open).
 * Accepts JSON ({continue|pass: bool} or {verdict: "..."}) or a text marker
 * `VERDICT: PASS|BLOCK|FAIL|STOP|OK|REJECT|HALT` (last occurrence wins).
 */
export function parseGateVerdict(output: string): { verdict: "pass" | "block"; reason?: string } {
	const json = safeParse(output);
	if (json && typeof json === "object") {
		const o = json as Record<string, unknown>;
		if (typeof o.continue === "boolean") return { verdict: o.continue ? "pass" : "block", reason: asReason(o.reason) };
		if (typeof o.pass === "boolean") return { verdict: o.pass ? "pass" : "block", reason: asReason(o.reason) };
		if (typeof o.verdict === "string") {
			// Note: do NOT include standalone "no" — natural-language verdicts like
			// "No issues found" / "no errors" would otherwise be false-positive BLOCK.
			// Fail-open covers any ambiguous text.
			const block = /block|fail|stop|reject|halt/i.test(o.verdict);
			return { verdict: block ? "block" : "pass", reason: asReason(o.reason) };
		}
	}
	const matches = [...output.matchAll(/VERDICT\s*[:=]\s*(PASS|BLOCK|FAIL|STOP|OK|REJECT|HALT)/gi)];
	if (matches.length) {
		const v = matches[matches.length - 1][1].toUpperCase();
		const pass = v === "PASS" || v === "OK";
		return { verdict: pass ? "pass" : "block" };
	}
	return { verdict: "pass" };
}

function asReason(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Best-effort invocation of the user-provided `persist` + `onProgress` callbacks.
 *
 * A throw from a host-supplied callback must NEVER replace the runtime's
 * outcome — neither the original crash message in `executeTaskflow`'s catch
 * block, nor the final output of a successful run. Callbacks are observability
 * hooks; the run survives their failure.
 *
 * Used at every "checkpoint" call site (phase start, phase end, terminal state).
 * For high-frequency live updates inside a phase, see `safeProgress` below.
 */
function safeEmit(deps: RuntimeDeps, state: RunState): void {
	try {
		deps.persist?.(state);
	} catch {
		// user callback — must not break the run
	}
	try {
		deps.onProgress?.(state);
	} catch {
		// user callback — must not break the run
	}
}

/**
 * Like `safeEmit` but for the high-frequency live-update channel only.
 * Skips `persist` (which is intentionally checkpoint-only) and swallows any
 * throw from the user-supplied `onProgress` so a misbehaving TUI sink cannot
 * disrupt an in-flight phase.
 */
function safeProgress(deps: RuntimeDeps, state: RunState): void {
	try {
		deps.onProgress?.(state);
	} catch {
		// user callback — must not break the run
	}
}

/**
 * Execute a full taskflow. Mutates and persists `state` as it progresses.
 */
function ensureImplicitGate(def: Taskflow): void {
	// Respect explicit opt-out
	if ((def as any).implicitGate === false) return;

	const hasGate = def.phases.some(
		(p) => p.type === "gate" || p.type === "approval" || p.id === "_implicit-gate",
	);
	if (hasGate || def.phases.length === 0) return;

	// The last existing phase is the effective "final" phase — pin it so the
	// injected gate doesn't become the finalOutput.
	const lastPhase = def.phases[def.phases.length - 1];
	if (!lastPhase.final && !def.phases.some((p) => p.final)) {
		lastPhase.final = true;
	}

	const allIds = def.phases.map((p) => p.id);
	def.phases.push({
		id: "_implicit-gate",
		type: "gate",
		dependsOn: allIds,
		agent: "reviewer",
		task: `Review all phase outputs from this taskflow for accuracy and consistency.

For each upstream phase, scan its output for:
1. **Factual accuracy**: Any file paths, line numbers, or code snippets that are wrong?
2. **Internal contradictions**: Do any phases contradict each other?
3. **Completeness**: Is any output truncated, empty, or anomalously short?
4. **Hallucination markers**: Wrong file names, impossible line ranges, circular logic, information not in the given context.

Output:
- If ALL outputs look consistent and plausible: output **VERDICT: PASS** with a one-line summary.
- If ANY issues found: output **VERDICT: BLOCK** listing each issue with the phase ID and specific concern.`,
	});
}

export async function executeTaskflow(state: RunState, deps: RuntimeDeps): Promise<RuntimeResult> {
	const def: Taskflow = state.def;
	ensureImplicitGate(def);
	try {
		return await runTaskflowLayers(state, deps);
	} catch (e) {
		// A thrown phase must not leave the run wedged in "running" (which breaks
		// resume). Mark any in-flight phase + the run as failed, persist, and return.
		const message = e instanceof Error ? e.message : String(e);
		for (const p of Object.values(state.phases)) {
			if (p.status === "running") {
				p.status = "failed";
				p.error = p.error ?? message;
				p.endedAt = Date.now();
			}
		}
		state.status = "failed";
		safeEmit(deps, state);
		const totalUsage = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
		return { state, finalOutput: `Taskflow '${def.name}' crashed: ${message}`, ok: false, totalUsage };
	}
}

async function runTaskflowLayers(state: RunState, deps: RuntimeDeps): Promise<RuntimeResult> {
	const def: Taskflow = state.def;
	const layers = topoLayers(def.phases);

	state.status = "running";
	safeEmit(deps, state);

	let aborted = false;
	let gateBlocked = false;
	let gateReason = "";
	let gateOutput = "";
	// `budgetBlocked` gates the skipping of remaining phases once the cap is hit.
	// `budgetSkipped` records that a phase was *actually* skipped/truncated for
	// budget — only then is the run terminal-status "blocked" (a cap crossed by the
	// very last phase, with nothing left to skip, must NOT mark a good run failed).
	let budgetBlocked = false;
	let budgetSkipped = false;
	let budgetReason = "";
	const byId = new Map(def.phases.map((p) => [p.id, p]));

	for (const layer of layers) {
		if (deps.signal?.aborted) {
			aborted = true;
			break;
		}
		// Phases within a layer have no inter-dependencies → run concurrently.
		const layerConcurrency = Math.max(1, def.concurrency ?? 8);
		await mapWithConcurrencyLimit(layer, layerConcurrency, async (phase) => {
			// Snapshot prior state BEFORE marking running, so resume cache checks work.
			const prior = state.phases[phase.id];

			// Determine whether this phase should run, or be skipped (and why).
			const deps_ = dependenciesOf(phase);
			const join = phase.join ?? "all";
			// An `optional` dependency that failed still counts as satisfied.
			const depOk = (d: string): boolean => {
				const s = state.phases[d]?.status;
				if (s === "done") return true;
				if (s === "failed" && byId.get(d)?.optional) return true;
				return false;
			};
			const depsSatisfied =
				deps_.length === 0 ? true : join === "any" ? deps_.some(depOk) : deps_.every(depOk);

			let skipReason: string | undefined;
			if (gateBlocked) skipReason = `Gate blocked${gateReason ? `: ${gateReason}` : ""}`;
			else if (budgetBlocked) skipReason = `Budget exceeded${budgetReason ? `: ${budgetReason}` : ""}`;
			else if (!depsSatisfied)
				skipReason = join === "any" ? "All dependencies failed or were skipped" : "Upstream dependency not satisfied";
			else if (phase.when !== undefined) {
				const condCtx = buildInterpolationContext(state, lastCompletedOutput(state, phase));
				if (!evaluateCondition(phase.when, condCtx)) skipReason = `Condition not met: ${phase.when}`;
			}

			if (skipReason) {
				if (skipReason.startsWith("Budget exceeded")) budgetSkipped = true;
				state.phases[phase.id] = {
					id: phase.id,
					status: "skipped",
					error: skipReason,
					endedAt: Date.now(),
					usage: emptyUsage(),
				};
				safeEmit(deps, state);
				return;
			}

			const startedAt = Date.now();
			state.phases[phase.id] = {
				...(state.phases[phase.id] ?? { id: phase.id }),
				id: phase.id,
				status: "running",
				startedAt,
			};
			safeProgress(deps, state);

			const ps = await executePhase(phase, state, deps, prior, () => safeProgress(deps, state));
			// Preserve the phase start time: executePhase returns a fresh PhaseState
			// that omits startedAt (cached/resumed results carry their own).
			state.phases[phase.id] = ps.startedAt ? ps : { ...ps, startedAt };
			// A blocking verdict (gate phase OR a rejected approval) halts the flow.
			const ptype = phase.type ?? "agent";
			if (ps.gate?.verdict === "block" && (ptype === "gate" || ptype === "approval")) {
				gateBlocked = true;
				gateReason = ps.gate.reason ?? "";
				gateOutput = ps.output ?? "";
			}
			// A fan-out cut short by the cap is itself a budget skip.
			if (ps.budgetTruncated) {
				budgetBlocked = true;
				budgetSkipped = true;
				if (!budgetReason) budgetReason = "fan-out truncated by budget";
			}
			// Budget ceiling: once exceeded, remaining phases are skipped.
			const ob = overBudget(state);
			if (ob.over && !budgetBlocked) {
				budgetBlocked = true;
				budgetReason = ob.reason;
			}
			safeEmit(deps, state);
		});
	}

	const fp = finalPhase(def.phases);
	let finalState = state.phases[fp.id];
	// If the designated final phase produced no output (skipped/blocked), fall
	// back to the last phase (in definition order) that actually completed.
	if (!finalState || finalState.status !== "done") {
		const doneInOrder = def.phases.map((p) => state.phases[p.id]).filter((p) => p?.status === "done");
		if (doneInOrder.length) finalState = doneInOrder[doneInOrder.length - 1];
	}
	// A failed non-optional phase fails the run; optional failures are tolerated.
	const anyFailed = Object.entries(state.phases).some(
		([id, p]) => p.status === "failed" && !byId.get(id)?.optional,
	);

	state.status = aborted
		? "paused"
		: gateBlocked || budgetSkipped
			? "blocked"
			: anyFailed
				? "failed"
				: "completed";
	safeEmit(deps, state);

	let finalOutput = finalState?.output ?? "(no output)";
	if (gateBlocked) {
		finalOutput = `Gate blocked the workflow.${gateReason ? `\nReason: ${gateReason}` : ""}${gateOutput ? `\n\n${gateOutput}` : ""}`;
	} else if (budgetSkipped) {
		finalOutput = `Budget exceeded — run halted.${budgetReason ? `\nReason: ${budgetReason}` : ""}${finalState?.output ? `\n\n${finalState.output}` : ""}`;
	}

	const totalUsage = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
	return {
		state,
		finalOutput,
		ok: state.status === "completed",
		totalUsage,
	};
}
