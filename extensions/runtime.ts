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

import type { AgentConfig } from "./agents.ts";
import { coerceArray, interpolate, type InterpolationContext, safeParse } from "./interpolate.ts";
import { aggregateUsage, emptyUsage, isFailed, mapWithConcurrencyLimit, runAgentTask, type RunResult, type UsageStats } from "./runner.ts";
import { dependenciesOf, finalPhase, type Phase, type Taskflow, topoLayers } from "./schema.ts";
import { hashInput, type PhaseState, type RunState } from "./store.ts";

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
	return {
		id,
		status: failed ? "failed" : "done",
		output: r.output,
		json: parseJson && !failed ? safeParse(r.output) : undefined,
		usage: r.usage,
		model: r.model,
		error: failed ? r.errorMessage || r.stderr || r.output : undefined,
		inputHash,
		endedAt: Date.now(),
	};
}

/** Merge several sub-results into a single PhaseState (for map/parallel). */
function mergePhaseState(
	id: string,
	results: RunResult[],
	inputHash: string,
	parseJson: boolean,
): PhaseState {
	const anyFailed = results.some(isFailed);
	const usage = aggregateUsage(results.map((r) => r.usage));
	// Combine outputs as a labelled list; also expose a JSON array of outputs.
	const combinedText = results
		.map((r, i) => `### [${i + 1}/${results.length}] ${r.agent}${isFailed(r) ? " (failed)" : ""}\n\n${r.output}`)
		.join("\n\n---\n\n");
	const jsonArray = parseJson ? results.map((r) => safeParse(r.output) ?? r.output) : undefined;
	return {
		id,
		status: anyFailed ? "failed" : "done",
		output: combinedText,
		json: jsonArray,
		usage,
		error: anyFailed ? results.filter(isFailed).map((r) => `${r.agent}: ${r.errorMessage ?? r.stderr}`).join("; ") : undefined,
		inputHash,
		endedAt: Date.now(),
	};
}

async function executePhase(
	phase: Phase,
	state: RunState,
	deps: RuntimeDeps,
	prior: PhaseState | undefined,
): Promise<PhaseState> {
	const type = phase.type ?? "agent";
	const concurrency = phase.concurrency ?? state.def.concurrency ?? 8;
	const previousOutput = lastCompletedOutput(state, phase);
	const run = deps.runTask ?? runAgentTask;

	const runOne = (agentName: string, task: string, _locals?: Record<string, unknown>) =>
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
			},
			deps.globalThinking,
		);

	const parseJson = phase.output === "json";

	if (type === "agent" || type === "gate") {
		const ctx = buildInterpolationContext(state, previousOutput);
		const { text } = interpolate(phase.task ?? "", ctx);
		const inputHash = hashInput(phase.id, phase.agent ?? "", text);
		const cached = cachedPhase(prior, inputHash);
		if (cached) return cached;

		const r = await runOne(phase.agent ?? defaultAgent(deps), text);
		return resultToPhaseState(phase.id, r, inputHash, parseJson);
	}

	if (type === "parallel") {
		const ctx = buildInterpolationContext(state, previousOutput);
		const branches = (phase.branches ?? []).map((b) => ({
			agent: b.agent ?? phase.agent ?? defaultAgent(deps),
			task: interpolate(b.task, ctx).text,
		}));
		const inputHash = hashInput(phase.id, JSON.stringify(branches));
		const cached = cachedPhase(prior, inputHash);
		if (cached) return cached;

		const results = await mapWithConcurrencyLimit(branches, concurrency, (b) => runOne(b.agent, b.task));
		return mergePhaseState(phase.id, results, inputHash, parseJson);
	}

	if (type === "map") {
		const ctx = buildInterpolationContext(state, previousOutput);
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
				agent: phase.agent ?? defaultAgent(deps),
				task: interpolate(phase.task ?? "", localCtx).text,
			};
		});
		const inputHash = hashInput(phase.id, JSON.stringify(tasks));
		const cached = cachedPhase(prior, inputHash);
		if (cached) return cached;

		const results = await mapWithConcurrencyLimit(tasks, concurrency, (t) => runOne(t.agent, t.task));
		return mergePhaseState(phase.id, results, inputHash, parseJson);
	}

	if (type === "reduce") {
		const ctx = buildInterpolationContext(state, previousOutput);
		// Inputs for reduce come from `from` phases; interpolation already exposes them.
		const { text } = interpolate(phase.task ?? "", ctx);
		const inputHash = hashInput(phase.id, text);
		const cached = cachedPhase(prior, inputHash);
		if (cached) return cached;

		const r = await runOne(phase.agent ?? defaultAgent(deps), text);
		return resultToPhaseState(phase.id, r, inputHash, parseJson);
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
	const m = over.match(/^\{steps\.([a-zA-Z0-9_]+)\.(output|json)\}$/);
	if (!m) return undefined;
	const step = state.phases[m[1]];
	if (!step || step.status !== "done") return undefined;
	if (m[2] === "json") return step.json ?? safeParse(step.output ?? "");
	return safeParse(step.output ?? "");
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

function defaultAgent(deps: RuntimeDeps): string {
	return deps.agents[0]?.name ?? "default";
}

/**
 * Execute a full taskflow. Mutates and persists `state` as it progresses.
 */
export async function executeTaskflow(state: RunState, deps: RuntimeDeps): Promise<RuntimeResult> {
	const def: Taskflow = state.def;
	const layers = topoLayers(def.phases);

	state.status = "running";
	deps.persist?.(state);
	deps.onProgress?.(state);

	let aborted = false;

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
			// Skip if a dependency failed (unless this phase is optional).
			const failedDep = dependenciesOf(phase).some((d) => state.phases[d]?.status === "failed");
			if (failedDep) {
				state.phases[phase.id] = {
					id: phase.id,
					status: "skipped",
					error: "Upstream dependency failed",
					endedAt: Date.now(),
					usage: emptyUsage(),
				};
				deps.persist?.(state);
				deps.onProgress?.(state);
				return;
			}

			state.phases[phase.id] = {
				...(state.phases[phase.id] ?? { id: phase.id }),
				id: phase.id,
				status: "running",
				startedAt: Date.now(),
			};
			deps.onProgress?.(state);

			const ps = await executePhase(phase, state, deps, prior);
			state.phases[phase.id] = ps;
			deps.persist?.(state);
			deps.onProgress?.(state);
		});
	}

	const fp = finalPhase(def.phases);
	const finalState = state.phases[fp.id];
	const anyFailed = Object.values(state.phases).some((p) => p.status === "failed");

	state.status = aborted ? "paused" : anyFailed ? "failed" : "completed";
	deps.persist?.(state);
	deps.onProgress?.(state);

	const totalUsage = aggregateUsage(Object.values(state.phases).map((p) => p.usage ?? emptyUsage()));
	return {
		state,
		finalOutput: finalState?.output ?? "(no output)",
		ok: state.status === "completed",
		totalUsage,
	};
}
