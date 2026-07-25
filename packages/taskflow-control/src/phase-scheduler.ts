/**
 * Per-phase ControlHost scheduler (mandate 1 / D21).
 *
 * Each phase is a NodeInstance/Attempt: topo order, dependsOn, when-guard
 * (fail-open on parse error), phase-level ExecutionProvider (script vs llm).
 * Whole-flow single-submit shortcuts are not used here.
 */
import type { ExecutionProvider, CollectResult } from "./provider.ts";
import { newId } from "./hash.ts";

export type PhaseRecord = {
	id: string;
	type?: string;
	run?: string | string[];
	task?: string;
	agent?: string;
	dependsOn?: string[];
	from?: string[];
	when?: string;
	final?: boolean;
	timeout?: number;
	[key: string]: unknown;
};

export type PhaseAttempt = {
	phaseId: string;
	/** Stable runtime identity; differs from phaseId for BoundFragment nodes. */
	nodeInstanceId?: string;
	type: string;
	status: "completed" | "failed" | "skipped" | "still-running";
	output?: string;
	error?: string;
	providerName?: string;
	handle?: string;
	leaseEpoch?: number;
	attemptId: string;
	startedAt?: number;
	endedAt?: number;
};

export type ScheduleResult = {
	ok: boolean;
	finalOutput?: string;
	error?: string;
	attempts: PhaseAttempt[];
	/** Concatenated transcript of phase outputs for Receipt finalOutput */
	phaseOutputs: Record<string, string>;
	/**
	 * When a phase remains still-running after its deadline, the scheduler
	 * stops without fail-terminal so ControlHost can enter reconcile (capacity
	 * held, no success Receipt).
	 */
	stillRunning?: {
		phaseId: string;
		handle: string;
		providerName: string;
		provider: ExecutionProvider;
	};
	/**
	 * Durable approval boundary. No provider is submitted for the approval
	 * node; ControlHost must checkpoint the returned attempts/outputs before
	 * parking and releasing capacity.
	 */
	approvalRequired?: {
		phaseId: string;
		message: string;
		upstream?: string;
	};
};

export type PhaseScheduleResume = {
	/**
	 * Only already-settled attempts from the exact durable checkpoint.
	 * Failed/still-running work is never eligible for continuation.
	 */
	attempts: readonly PhaseAttempt[];
	/** Interpolation inputs produced by the settled attempts. */
	phaseOutputs: Readonly<Record<string, string>>;
	/** The one parked approval decision being consumed by this dispatch. */
	approvedApproval: {
		phaseId: string;
		note?: string;
	};
};

export type ResolvedDynamicFragment = {
	originPhaseId: string;
	parentNodeInstanceId: string;
	linkKind: "nested-flow" | "graft-promote";
	fragment: {
		name: string;
		phases: Array<Record<string, unknown>>;
		[key: string]: unknown;
	};
};

export type ResolvedDynamicFragmentBinding = {
	readonly nodeInstanceIds: Readonly<Record<string, string>>;
};

export interface PhaseSchedulerProviders {
	/** Executes script phases (phase-level, not whole-flow). */
	script: ExecutionProvider;
	/** Executes agent/gate/reduce/… via host SubagentRunner. Optional. */
	llm?: ExecutionProvider;
}

function asPhases(program: unknown): PhaseRecord[] {
	if (!program || typeof program !== "object") return [];
	const phases = (program as { phases?: unknown }).phases;
	if (!Array.isArray(phases)) return [];
	return phases.filter(
		(p): p is PhaseRecord =>
			!!p && typeof p === "object" && typeof (p as PhaseRecord).id === "string",
	);
}

function depsOf(p: PhaseRecord): string[] {
	const d = [...(p.dependsOn ?? []), ...(p.from ?? [])];
	return d.filter((x) => typeof x === "string");
}

/** Kahn topo order; cycles → null. */
export function topoOrderPhases(phases: PhaseRecord[]): PhaseRecord[] | null {
	const byId = new Map(phases.map((p) => [p.id, p]));
	const indeg = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const p of phases) {
		indeg.set(p.id, 0);
		adj.set(p.id, []);
	}
	for (const p of phases) {
		for (const d of depsOf(p)) {
			if (!byId.has(d)) continue;
			adj.get(d)!.push(p.id);
			indeg.set(p.id, (indeg.get(p.id) ?? 0) + 1);
		}
	}
	const q: string[] = [];
	for (const [id, deg] of indeg) {
		if (deg === 0) q.push(id);
	}
	const out: PhaseRecord[] = [];
	while (q.length) {
		const id = q.shift()!;
		const p = byId.get(id);
		if (p) out.push(p);
		for (const n of adj.get(id) ?? []) {
			const nd = (indeg.get(n) ?? 1) - 1;
			indeg.set(n, nd);
			if (nd === 0) q.push(n);
		}
	}
	if (out.length !== phases.length) return null;
	return out;
}

/** Minimal placeholder interpolate: {steps.ID.output}, {previous.output}, {item}. */
export function interpolatePhaseText(
	template: string,
	ctx: { steps: Record<string, string>; previous?: string },
): string {
	return template.replace(/\{steps\.([a-zA-Z0-9_-]+)\.output\}/g, (_, id: string) => {
		return ctx.steps[id] ?? "";
	}).replace(/\{previous\.output\}/g, () => ctx.previous ?? "");
}

function evalWhen(whenExpr: string | undefined, steps: Record<string, string>): boolean {
	if (!whenExpr || !whenExpr.trim()) return true;
	// Fail-open: unparseable when → run (critical invariant).
	try {
		const m = whenExpr.match(/\{steps\.([a-zA-Z0-9_-]+)\.output\}\s*(==|!=)\s*"([^"]*)"/);
		if (m) {
			const actual = steps[m[1]!] ?? "";
			const op = m[2]!;
			const expected = m[3]!;
			return op === "==" ? actual === expected : actual !== expected;
		}
		// truthy string output
		const m2 = whenExpr.match(/\{steps\.([a-zA-Z0-9_-]+)\.output\}/);
		if (m2) {
			const v = (steps[m2[1]!] ?? "").trim();
			return v.length > 0 && v !== "0" && v.toLowerCase() !== "false";
		}
		return true;
	} catch {
		return true;
	}
}

function resolveDynamicFragment(
	phase: PhaseRecord,
	steps: Record<string, string>,
	parentNodeInstanceId: string,
): ResolvedDynamicFragment | { error: string } {
	let value = phase.def;
	if (typeof value === "string") {
		const interpolated = value.replace(
			/\{steps\.([a-zA-Z0-9_-]+)\.(?:json|output)\}/gu,
			(_, id: string) => steps[id] ?? "",
		);
		try {
			value = JSON.parse(interpolated) as unknown;
		} catch {
			return {
				error: `expand phase '${phase.id}' def did not resolve to valid JSON`,
			};
		}
	}
	let candidate: Record<string, unknown>;
	if (Array.isArray(value)) {
		candidate = {
			name: `${phase.id}-fragment`,
			phases: value,
		};
	} else if (value && typeof value === "object") {
		candidate = { ...(value as Record<string, unknown>) };
	} else {
		return {
			error: `expand phase '${phase.id}' requires a fragment def`,
		};
	}
	if (!Array.isArray(candidate.phases)) {
		return {
			error: `expand phase '${phase.id}' fragment requires phases`,
		};
	}
	const maxNodes =
		typeof phase.maxNodes === "number" &&
		Number.isSafeInteger(phase.maxNodes)
			? Math.min(100, Math.max(1, phase.maxNodes))
			: 50;
	if (candidate.phases.length > maxNodes) {
		return {
			error: `expand phase '${phase.id}' fragment has ${candidate.phases.length} nodes (max ${maxNodes})`,
		};
	}
	const fragment = {
		...candidate,
		name:
			typeof candidate.name === "string" &&
			candidate.name.trim()
				? candidate.name
				: `${phase.id}-fragment`,
		phases: candidate.phases.filter(
			(item): item is Record<string, unknown> =>
				!!item && typeof item === "object",
		),
	};
	if (fragment.phases.length !== candidate.phases.length) {
		return {
			error: `expand phase '${phase.id}' fragment contains a non-object phase`,
		};
	}
	return {
		originPhaseId: phase.id,
		parentNodeInstanceId,
		linkKind:
			phase.expandMode === "graft"
				? "graft-promote"
				: "nested-flow",
		fragment,
	};
}

function isScriptType(type: string): boolean {
	return type === "script";
}

function isAgentishType(type: string): boolean {
	return (
		type === "agent" ||
		type === "gate" ||
		type === "reduce" ||
		type === "map" ||
		type === "parallel" ||
		type === "loop" ||
		type === "tournament" ||
		type === "flow" ||
		type === "race" ||
		type === "expand"
	);
}

async function waitTerminal(
	provider: ExecutionProvider,
	handle: string,
	deadlineMs: number,
): Promise<CollectResult> {
	const deadline = Date.now() + deadlineMs;
	let c = await provider.poll(handle);
	while (c.kind === "still-running" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 15));
		c = await provider.poll(handle);
	}
	return c;
}

/**
 * Schedule every phase under ControlHost providers.
 * Upstream failure stops the DAG; no success when any required phase fails.
 */
export async function schedulePhases(
	program: unknown,
	providers: PhaseSchedulerProviders,
	opts: {
		runId: string;
		cwd: string;
		/** Per-phase poll budget ms (default 60s). */
		phaseDeadlineMs?: number;
		/**
		 * Durable checkpoint boundary after provider acceptance and before
		 * polling. A failure returns the live handle through `stillRunning`
		 * so callers cannot lose track of possible side effects.
		 */
		onAttemptStarted?: (
			attempt: PhaseAttempt,
			settledAttempts: readonly PhaseAttempt[],
		) => void | Promise<void>;
		/**
		 * Durable link boundary for an expand phase. Called after deterministic
		 * resolution and before provider submission, so a fragment can never
		 * execute without its immutable body and causation being journaled.
		 */
		onFragmentResolved?: (
			fragment: ResolvedDynamicFragment,
			settledAttempts: readonly PhaseAttempt[],
		) =>
			| ResolvedDynamicFragmentBinding
			| void
			| Promise<ResolvedDynamicFragmentBinding | void>;
		/**
		 * Internal/runtime binding supplied after a BoundFragment link commit.
		 * Root programs omit it and use phaseId as nodeInstanceId.
		 */
		nodeInstanceIds?: Readonly<Record<string, string>>;
		/** Exact durable continuation loaded by ControlHost after approval. */
		resume?: PhaseScheduleResume;
	},
): Promise<ScheduleResult> {
	const phases = asPhases(program);
	if (phases.length === 0) {
		return { ok: false, error: "program has no phases", attempts: [], phaseOutputs: {} };
	}
	const ordered = topoOrderPhases(phases);
	if (!ordered) {
		return { ok: false, error: "phase dependency cycle", attempts: [], phaseOutputs: {} };
	}

	const phaseIds = new Set(phases.map((phase) => phase.id));
	const resumedAttempts = opts.resume?.attempts ?? [];
	if (
		resumedAttempts.some(
			(attempt) =>
				(attempt.status !== "completed" &&
					attempt.status !== "skipped") ||
				((attempt.nodeInstanceId === undefined ||
					attempt.nodeInstanceId ===
						attempt.phaseId) &&
					!phaseIds.has(attempt.phaseId)),
		)
	) {
		return {
			ok: false,
			error:
				"approval continuation contains an unknown or unsettled Attempt",
			attempts: [],
			phaseOutputs: {},
		};
	}
	const resumedPhaseIds = new Set<string>();
	for (const attempt of resumedAttempts) {
		const nodeInstanceId =
			attempt.nodeInstanceId ?? attempt.phaseId;
		if (
			nodeInstanceId !== attempt.phaseId
		) {
			continue;
		}
		if (resumedPhaseIds.has(attempt.phaseId)) {
			return {
				ok: false,
				error:
					"approval continuation contains duplicate settled Attempts",
				attempts: [],
				phaseOutputs: {},
			};
		}
		resumedPhaseIds.add(attempt.phaseId);
	}
	if (
		Object.keys(opts.resume?.phaseOutputs ?? {}).some(
			(phaseId) => !resumedPhaseIds.has(phaseId),
		)
	) {
		return {
			ok: false,
			error:
				"approval continuation output does not belong to a settled Attempt",
			attempts: [],
			phaseOutputs: {},
		};
	}
	const phaseOutputs: Record<string, string> = {
		...(opts.resume?.phaseOutputs ?? {}),
	};
	const attempts: PhaseAttempt[] = resumedAttempts.map(
		(attempt) => ({ ...attempt }),
	);
	const phaseDeadlineMs = opts.phaseDeadlineMs ?? 60_000;
	let previous = "";
	let lastFailed: string | undefined;
	let approvedApprovalConsumed = false;

	for (const phase of ordered) {
		const type = phase.type ?? "agent";
		const nodeInstanceId =
			opts.nodeInstanceIds?.[phase.id] ?? phase.id;
		const resumed = attempts.find(
			(attempt) =>
				(attempt.nodeInstanceId ??
					attempt.phaseId) ===
				nodeInstanceId,
		);
		if (resumed) {
			if (resumed.status === "completed") {
				previous =
					phaseOutputs[phase.id] ??
					resumed.output ??
					previous;
			}
			continue;
		}
		const attemptId = newId("att");
		const attemptObservedAt = Date.now();

		// Upstream deps failed → skip remaining (fail closed for success)
		const depFailed = depsOf(phase).some((d) => {
			const dependencyNodeInstanceId =
				opts.nodeInstanceIds?.[d] ?? d;
			const a = attempts.find(
				(x) =>
					(x.nodeInstanceId ??
						x.phaseId) ===
					dependencyNodeInstanceId,
			);
			return a?.status === "failed";
		});
		if (depFailed) {
			attempts.push({
				phaseId: phase.id,
				nodeInstanceId,
				type,
				status: "skipped",
				error: "upstream dependency failed",
				attemptId,
				endedAt: attemptObservedAt,
			});
			continue;
		}

		if (!evalWhen(phase.when, phaseOutputs)) {
			attempts.push({
				phaseId: phase.id,
				nodeInstanceId,
				type,
				status: "skipped",
				error: "when guard false",
				attemptId,
				endedAt: attemptObservedAt,
			});
			continue;
		}

		if (type === "approval") {
			const message = interpolatePhaseText(
				typeof phase.task === "string"
					? phase.task
					: "Approve to continue?",
				{
					steps: phaseOutputs,
					previous,
				},
			);
			if (
				opts.resume?.approvedApproval.phaseId ===
				phase.id
			) {
				const note =
					opts.resume.approvedApproval.note?.trim();
				const output = note || "(approve)";
				phaseOutputs[phase.id] = output;
				previous = output;
				attempts.push({
					phaseId: phase.id,
					nodeInstanceId,
					type,
					status: "completed",
					output,
					attemptId,
					startedAt: attemptObservedAt,
					endedAt: attemptObservedAt,
				});
				approvedApprovalConsumed = true;
				continue;
			}
			return {
				ok: false,
				attempts,
				phaseOutputs,
				approvalRequired: {
					phaseId: phase.id,
					message,
					...(previous ? { upstream: previous } : {}),
				},
			};
		}

		// Build phase micro-program for providers
		const phaseClone: PhaseRecord = { ...phase, final: true };
		if (type === "expand") {
			const resolved = resolveDynamicFragment(
				phaseClone,
				phaseOutputs,
				nodeInstanceId,
			);
			if ("error" in resolved) {
				attempts.push({
					phaseId: phase.id,
					nodeInstanceId,
					type,
					status: "failed",
					error: resolved.error,
					attemptId,
					endedAt: attemptObservedAt,
				});
				lastFailed = resolved.error;
				continue;
			}
			phaseClone.def = resolved.fragment;
			try {
				const binding =
					await opts.onFragmentResolved?.(
						resolved,
						attempts,
					);
				const childNodeInstanceIds =
					binding?.nodeInstanceIds ??
					Object.fromEntries(
						resolved.fragment.phases.flatMap(
							(child) =>
								typeof child.id ===
									"string"
									? [
											[
												child.id,
												`${nodeInstanceId}.${child.id}`,
											],
										]
									: [],
						),
					);
				const childScheduled =
					await schedulePhases(
						resolved.fragment,
						providers,
						{
							runId: `${opts.runId}-${phase.id}`,
							cwd: opts.cwd,
							phaseDeadlineMs,
							nodeInstanceIds:
								childNodeInstanceIds,
							onAttemptStarted:
								opts.onAttemptStarted
									? (
											started,
											settled,
										) =>
											opts.onAttemptStarted!(
												started,
												[
													...attempts,
													...settled,
												],
											)
									: undefined,
							onFragmentResolved:
								opts.onFragmentResolved,
						},
					);
				attempts.push(
					...childScheduled.attempts,
				);
				if (
					childScheduled.approvalRequired
				) {
					const error =
						"approval inside a dynamic fragment is not resumable by this scheduler";
					attempts.push({
						phaseId: phase.id,
						nodeInstanceId,
						type,
						status: "failed",
						error,
						attemptId,
						endedAt: Date.now(),
					});
					return {
						ok: false,
						error,
						attempts,
						phaseOutputs,
					};
				}
				if (childScheduled.stillRunning) {
					return {
						ok: false,
						error:
							childScheduled.error,
						attempts,
						phaseOutputs,
						stillRunning:
							childScheduled.stillRunning,
					};
				}
				if (!childScheduled.ok) {
					const error =
						childScheduled.error ??
						"dynamic fragment failed";
					attempts.push({
						phaseId: phase.id,
						nodeInstanceId,
						type,
						status: "failed",
						error,
						attemptId,
						endedAt: Date.now(),
					});
					lastFailed = error;
					continue;
				}
				const output =
					childScheduled.finalOutput ?? "";
				phaseOutputs[phase.id] = output;
				previous = output;
				attempts.push({
					phaseId: phase.id,
					nodeInstanceId,
					type,
					status: "completed",
					output,
					attemptId,
					startedAt:
						attemptObservedAt,
					endedAt: Date.now(),
				});
				continue;
			} catch (cause) {
				const error =
					cause instanceof Error
						? `fragment checkpoint failed: ${cause.message}`
						: "fragment checkpoint failed";
				attempts.push({
					phaseId: phase.id,
					nodeInstanceId,
					type,
					status: "failed",
					error,
					attemptId,
					endedAt: Date.now(),
				});
				return {
					ok: false,
					error,
					attempts,
					phaseOutputs,
				};
			}
		}
		if (typeof phaseClone.task === "string") {
			phaseClone.task = interpolatePhaseText(phaseClone.task, {
				steps: phaseOutputs,
				previous,
			});
		}
		if (typeof phaseClone.run === "string") {
			phaseClone.run = interpolatePhaseText(phaseClone.run, {
				steps: phaseOutputs,
				previous,
			});
		}
		const micro = {
			name: `phase-${phase.id}`,
			phases: [phaseClone],
		};

		let provider: ExecutionProvider | undefined;
		if (isScriptType(type)) {
			provider = providers.script;
		} else if (isAgentishType(type)) {
			provider = providers.llm;
			if (!provider) {
				const err = `no LLM ExecutionProvider for phase type '${type}' (phase ${phase.id})`;
				attempts.push({
					phaseId: phase.id,
					nodeInstanceId,
					type,
					status: "failed",
					error: err,
					attemptId,
					endedAt: attemptObservedAt,
				});
				lastFailed = err;
				// fail remaining
				continue;
			}
		} else {
			// unknown type — fail closed
			const err = `unsupported phase type '${type}' on ControlHost scheduler`;
			attempts.push({
				phaseId: phase.id,
				nodeInstanceId,
				type,
				status: "failed",
				error: err,
				attemptId,
				endedAt: attemptObservedAt,
			});
			lastFailed = err;
			continue;
		}

		const startedAt = Date.now();
		const submit = await provider.submit({
			runId: `${opts.runId}:${phase.id}`,
			idempotencyKey: `${opts.runId}:${phase.id}:${attemptId}`,
			program: micro,
			cwd: opts.cwd,
		});

		if (submit.kind === "rejected") {
			attempts.push({
				phaseId: phase.id,
				nodeInstanceId,
				type,
				status: "failed",
				error: submit.reason,
				providerName: provider.name,
				attemptId,
				startedAt,
				endedAt: Date.now(),
			});
			lastFailed = submit.reason;
			continue;
		}

		const handle = submit.handle;
		if (!handle) {
			const err = "provider accepted without handle";
			attempts.push({
				phaseId: phase.id,
				nodeInstanceId,
				type,
				status: "failed",
				error: err,
				providerName: provider.name,
				attemptId,
				startedAt,
				endedAt: Date.now(),
			});
			lastFailed = err;
			continue;
		}
		const leaseEpoch =
			submit.kind === "accepted"
				? submit.leaseEpoch
				: undefined;

		const startedAttempt: PhaseAttempt = {
			phaseId: phase.id,
			nodeInstanceId,
			type,
			status: "still-running",
			providerName: provider.name,
			handle,
			leaseEpoch,
			attemptId,
			startedAt,
		};
		try {
			await opts.onAttemptStarted?.(
				startedAttempt,
				attempts,
			);
		} catch (cause) {
			return {
				ok: false,
				error:
					cause instanceof Error
						? `attempt checkpoint failed: ${cause.message}`
						: "attempt checkpoint failed",
				attempts: [...attempts, startedAttempt],
				phaseOutputs,
				stillRunning: {
					phaseId: phase.id,
					handle,
					providerName: provider.name,
					provider,
				},
			};
		}

		const collected = await waitTerminal(provider, handle, phaseDeadlineMs);
		if (collected.kind === "completed") {
			const out = collected.output ?? "";
			phaseOutputs[phase.id] = out;
			previous = out;
			attempts.push({
				phaseId: phase.id,
				nodeInstanceId,
				type,
				status: "completed",
				output: out,
				providerName: provider.name,
				handle,
				leaseEpoch,
				attemptId,
				startedAt,
				endedAt: Date.now(),
			});
		} else if (collected.kind === "failed") {
			const err = collected.error ?? "phase failed";
			attempts.push({
				phaseId: phase.id,
				nodeInstanceId,
				type,
				status: "failed",
				error: err,
				providerName: provider.name,
				handle,
				leaseEpoch,
				attemptId,
				startedAt,
				endedAt: Date.now(),
			});
			lastFailed = err;
		} else if (collected.kind === "cancelled") {
			attempts.push({
				phaseId: phase.id,
				nodeInstanceId,
				type,
				status: "failed",
				error: "phase cancelled",
				providerName: provider.name,
				handle,
				leaseEpoch,
				attemptId,
				startedAt,
				endedAt: Date.now(),
			});
			lastFailed = "phase cancelled";
		} else {
			// still-running after budget → hand off to ControlHost reconcile (do not fail-terminal)
			attempts.push({
				phaseId: phase.id,
				nodeInstanceId,
				type,
				status: "still-running",
				error: "phase still-running after deadline",
				providerName: provider.name,
				handle,
				leaseEpoch,
				attemptId,
				startedAt,
			});
			return {
				ok: false,
				error: "phase still-running after deadline",
				attempts,
				phaseOutputs,
				stillRunning: {
					phaseId: phase.id,
					handle,
					providerName: provider.name,
					provider,
				},
			};
		}
	}

	if (
		opts.resume?.approvedApproval &&
		!approvedApprovalConsumed
	) {
		return {
			ok: false,
			error:
				"approval continuation did not consume its approved phase",
			attempts,
			phaseOutputs,
		};
	}

	const anyFailed = attempts.some((a) => a.status === "failed");
	if (anyFailed) {
		return {
			ok: false,
			error: lastFailed ?? "one or more phases failed",
			attempts,
			phaseOutputs,
		};
	}

	// Final output: last final:true phase, else last completed
	const finals = ordered.filter((p) => p.final === true);
	let finalOutput = "";
	if (finals.length > 0) {
		const lastFinal = finals[finals.length - 1]!;
		finalOutput = phaseOutputs[lastFinal.id] ?? "";
	} else {
		const completed = attempts.filter((a) => a.status === "completed");
		finalOutput = completed[completed.length - 1]?.output ?? "";
	}

	return { ok: true, finalOutput, attempts, phaseOutputs };
}
