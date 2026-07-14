/**
 * Hierarchical reduce execution.
 *
 * The runtime owns interpolation, cache policy, and runner wiring; this module
 * owns the tree algorithm and its hard admission cap so runtime.ts does not
 * grow another phase-sized control-flow block.
 */

import type { RunResult } from "../../host/runner-types.ts";
import { isFailed } from "../../runner-core.ts";
import {
	asArray,
	collectRefs,
	transitiveDependencies,
	TREE_REDUCE_HARD_MAX_CALLS,
	type Phase,
} from "../../schema.ts";
import { hashInput, type PhaseState, type RunState } from "../../store.ts";
import { aggregateUsage, emptyUsage, type UsageStats } from "../../usage.ts";

export interface TreeReduceItem {
	label: string;
	output: string;
}

export interface TreeReduceSource {
	id: string;
	output: string;
}

export interface TreeReduceTask {
	task: string;
	warning?: string;
}

export interface TreeReduceExecutionOptions {
	phase: Phase;
	inputs: TreeReduceSource[];
	batchSize: number;
	agentName: string;
	inputHash: string;
	isAborted: () => boolean;
	isOverBudget: () => boolean;
	resolveTask: (batchValue: string) => TreeReduceTask;
	runOne: (
		task: string,
		usageBefore: UsageStats | undefined,
		beforeAttempt: () => string | undefined,
		callId: string,
	) => Promise<RunResult>;
}

export interface TreeReduceExecutionResult {
	phaseState: PhaseState;
	refWarning?: string;
	cacheable: boolean;
}

export function collectTreeReduceInputs(state: RunState, phase: Phase): TreeReduceSource[] {
	const inputs: TreeReduceSource[] = [];
	for (const id of asArray<string>(phase.from)) {
		const phaseState = state.phases[id];
		if (phaseState?.status === "done" && phaseState.output !== undefined) {
			inputs.push({ id, output: phaseState.output });
		}
	}
	return inputs;
}

export function formatTreeReduceBatch(items: TreeReduceItem[]): string {
	return items.length === 1
		? items[0].output
		: items.map((item) => `### ${item.label}\n\n${item.output}`).join("\n\n---\n\n");
}

/** Stable, pre-execution cache material. It deliberately excludes intermediate
 * model outputs (unknowable before execution) and includes every authored
 * dependency plus invocation args so non-`from` refs cannot produce false hits. */
export function treeReduceCacheParts(
	state: RunState,
	phase: Phase,
	inputs: TreeReduceSource[],
	batchSize: number,
): string[] {
	const dependencyIds = Array.from(new Set([
		...transitiveDependencies(state.def.phases, phase.id),
		...collectRefs(phase).steps,
	])).sort();
	const inputSnapshot = inputs.map(({ id, output }) => ({ id, outputHash: hashInput(output) }));
	const dependencySnapshot = dependencyIds.map((id) => {
		const phaseState = state.phases[id];
		return {
			id,
			status: phaseState?.status,
			...(phaseState?.output !== undefined ? { outputHash: hashInput(phaseState.output) } : {}),
		};
	});
	const stateHash = hashInput(JSON.stringify({
		inputs: inputSnapshot,
		argsHash: hashInput(JSON.stringify(state.args)),
		dependencies: dependencySnapshot,
	}));
	return [
		phase.id,
		"tree-reduce",
		`batch:${batchSize}`,
		phase.task ?? "",
		`state:${stateHash}`,
	];
}

function capFailure(agentName: string, task: string): RunResult {
	const error = `Tree reduction exceeded hard cap of ${TREE_REDUCE_HARD_MAX_CALLS} actual subagent attempts`;
	return {
		agent: agentName,
		task,
		exitCode: 1,
		output: "",
		stderr: error,
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: error,
	};
}

export async function executeTreeReduction(
	opts: TreeReduceExecutionOptions,
): Promise<TreeReduceExecutionResult> {
	let round: TreeReduceItem[] = opts.inputs.map((input) => ({
		label: input.id,
		output: input.output,
	}));
	let roundNumber = 1;
	let actualAttempts = 0;
	const usages: UsageStats[] = [];
	let failed: RunResult | undefined;
	let truncatedByBudget = false;
	let aborted = false;
	let refWarning: string | undefined;

	while (round.length > 1) {
		if (actualAttempts >= TREE_REDUCE_HARD_MAX_CALLS) {
			failed = capFailure(opts.agentName, opts.phase.task ?? "");
			break;
		}
		if (opts.isAborted()) {
			aborted = true;
			break;
		}
		if (opts.isOverBudget()) {
			truncatedByBudget = true;
			break;
		}

		const batches: TreeReduceItem[][] = [];
		for (let i = 0; i < round.length; i += opts.batchSize) {
			batches.push(round.slice(i, i + opts.batchSize));
		}
		const next: TreeReduceItem[] = [];
		let consumedInputs = 0;
		for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
			if (actualAttempts >= TREE_REDUCE_HARD_MAX_CALLS) {
				failed = capFailure(opts.agentName, opts.phase.task ?? "");
				break;
			}
			if (opts.isAborted()) {
				aborted = true;
				break;
			}
			if (opts.isOverBudget()) {
				truncatedByBudget = true;
				break;
			}

			const batch = batches[batchIndex];
			const resolved = opts.resolveTask(formatTreeReduceBatch(batch));
			if (!refWarning && resolved.warning) refWarning = resolved.warning;
			const usageBefore = usages.length ? aggregateUsage(usages) : undefined;
			const beforeAttempt = (): string | undefined => {
				if (actualAttempts >= TREE_REDUCE_HARD_MAX_CALLS) {
					return `Tree reduction exceeded hard cap of ${TREE_REDUCE_HARD_MAX_CALLS} actual subagent attempts`;
				}
				actualAttempts++;
				return undefined;
			};
			const callId = `round-${roundNumber}-batch-${batchIndex + 1}`;
			const result = await opts.runOne(resolved.task, usageBefore, beforeAttempt, callId);
			usages.push(result.usage ?? emptyUsage());
			if (isFailed(result)) {
				failed = result;
				break;
			}
			next.push({
				label: `round-${roundNumber}-batch-${batchIndex + 1}`,
				output: result.output ?? "",
			});
			consumedInputs += batch.length;
		}

		if (truncatedByBudget) {
			round = [...next, ...round.slice(consumedInputs)];
		}
		if (failed || aborted || truncatedByBudget) break;
		round = next;
		roundNumber++;
	}

	if (failed) {
		return {
			phaseState: {
				id: opts.phase.id,
				status: "failed",
				output: failed.output ?? "",
				error: failed.errorMessage ?? failed.stderr,
				usage: aggregateUsage(usages),
				attempts: actualAttempts,
				inputHash: opts.inputHash,
				endedAt: Date.now(),
				...(failed.phaseTimeout ? { timedOut: true as const } : {}),
			},
			refWarning,
			cacheable: false,
		};
	}

	if (aborted) {
		return {
			phaseState: {
				id: opts.phase.id,
				status: "failed",
				error: "Tree reduction aborted before all inputs were reduced",
				usage: aggregateUsage(usages),
				attempts: actualAttempts,
				inputHash: opts.inputHash,
				endedAt: Date.now(),
			},
			refWarning,
			cacheable: false,
		};
	}

	const output = round.length === 1 ? round[0].output : formatTreeReduceBatch(round);
	return {
		phaseState: {
			id: opts.phase.id,
			status: "done",
			output,
			usage: aggregateUsage(usages),
			attempts: actualAttempts,
			inputHash: opts.inputHash,
			endedAt: Date.now(),
			...(truncatedByBudget ? { budgetTruncated: true as const } : {}),
		},
		refWarning,
		cacheable: !truncatedByBudget,
	};
}
