/**
 * Per-phase ControlHost scheduler (mandate 1 / D21).
 *
 * Each phase is a NodeInstance/Attempt: topo order, dependsOn, when-guard
 * (fail-open on parse error), phase-level ExecutionProvider (script vs llm).
 * Whole-flow single-submit shortcuts are not used here. Native approval phases
 * return a durable cursor rather than being sent to an LLM.
 */
import type {
	CollectResult,
	ExecutionProvider,
	ProviderSubmissionFence,
	SubmitResult,
} from "./provider.ts";
import { providerHandleOwnershipFailure } from "./provider.ts";
import { newId } from "./hash.ts";
import type {
	DurableDispatchAttempt,
	DurablePhaseAttempt,
	RunContinuation,
} from "./types.ts";

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

export type PhaseAttempt = DurablePhaseAttempt;

/** Scheduler-owned portion of a journaled RunContinuation. */
export interface SchedulerCheckpoint {
	phaseAttempts: PhaseAttempt[];
	phaseOutputs: Record<string, string>;
	activeAttempt?: DurableDispatchAttempt;
	nextPhaseId?: string;
}

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
		/** A terminal observation fault is never a failed terminal result. */
		observationError?: string;
	};
	/**
	 * A durable intent was recorded, but the host lost authority before the
	 * external provider was asked to act. The active intent remains available
	 * for the authoritative writer to reconcile; this scheduler must not turn it
	 * into a failed terminal result or release its reservation.
	 */
	dispatchDenied?: {
		phaseId: string;
		code: ProviderSubmitDenialCode;
		message: string;
	};
	/**
	 * The provider has accepted a handle, but the host lost authority before it
	 * could journal DispatchAcknowledged. The durable checkpoint deliberately
	 * remains intent-recorded; callers must treat the side effect as possible and
	 * let an authoritative recovery owner reconcile it.
	 */
	dispatchAcknowledgementLost?: {
		phaseId: string;
		providerName: string;
		handle: string;
		message: string;
	};
	/**
	 * A provider accepted an opaque handle, but its durable record cannot prove
	 * that the handle belongs to this Run/phase. Do not journal the handle or
	 * call poll/collect/reconcile on it; ControlHost must retain the intent and
	 * enter an operator-owned reconciliation state.
	 */
	dispatchHandleInvalid?: {
		phaseId: string;
		providerName: string;
		handle: string;
		stage: "acknowledgement" | "terminal-observation";
		reason: string;
	};
	/** Native `approval` phase reached with all upstream work durably checkpointed. */
	parked?: { phaseId: string; message: string };
	/** Exact cursor to persist before returning control to ControlHost. */
	checkpoint: SchedulerCheckpoint;
};

export interface PhaseSchedulerProviders {
	/** Executes script phases (phase-level, not whole-flow). */
	script: ExecutionProvider;
	/** Executes agent/gate/reduce/… via host SubagentRunner. Optional. */
	llm?: ExecutionProvider;
}

type MaybePromise<T> = T | Promise<T>;

/** Decision made immediately before an external ExecutionProvider.submit call. */
export type ProviderSubmitDenialCode = "TF_AUTHORITY_REVOKED" | "TF_RECONCILE_REQUIRED";

export type ProviderSubmitAuthorization =
	| { allowed: true; submissionFence?: ProviderSubmissionFence }
	| { allowed: false; code: ProviderSubmitDenialCode; message: string };

/**
 * Read-only result used by a new ControlHost epoch to resolve one journaled
 * dispatch intent. This helper never calls `submit`: a crash recovery owner
 * must not turn an unacknowledged side effect into an implicit replay.
 */
export type DurableDispatchRecoveryLookup =
	| {
			kind: "found";
			provider: ExecutionProvider;
			providerName: string;
			handle: string;
			leaseEpoch?: number;
	  }
	| { kind: "not-found"; provider: ExecutionProvider; providerName: string }
	| { kind: "rejected"; provider: ExecutionProvider; providerName: string; reason: string }
	| { kind: "ambiguous"; provider: ExecutionProvider; providerName: string; reason: string }
	| { kind: "unsupported"; providerName: string; reason: string }
	| { kind: "invalid"; reason: string };

type SchedulerCallbacks = {
	/** Called before the first provider submit for a stable attempt identity. */
	onDispatchIntent?: (attempt: DurableDispatchAttempt) => MaybePromise<void>;
	/**
	 * Last host-side authority check before provider submission. This is a
	 * narrow pre-submit fence, not a substitute for provider-side fencing or
	 * idempotent recovery after a process crash.
	 */
	beforeProviderSubmit?: (
		attempt: DurableDispatchAttempt,
	) => MaybePromise<ProviderSubmitAuthorization>;
	/** Called after a provider accepts a stable attempt and exposes a handle. */
	onDispatchAcknowledged?: (attempt: DurableDispatchAttempt) => MaybePromise<void>;
	/** Called after a phase output/skip advances the durable cursor. */
	onCheckpoint?: (checkpoint: SchedulerCheckpoint) => MaybePromise<void>;
};

function providerSubmissionDenial(
	error: unknown,
): { code: ProviderSubmitDenialCode; message: string } | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	if (code !== "TF_AUTHORITY_REVOKED" && code !== "TF_RECONCILE_REQUIRED") return undefined;
	return {
		code,
		message:
			error instanceof Error
				? error.message
				: "provider submission fence rejected a stale durable submission lease",
	};
}

function authorityRevocationMessage(error: unknown): string | undefined {
	const denial = providerSubmissionDenial(error);
	return denial?.code === "TF_AUTHORITY_REVOKED" ? denial.message : undefined;
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

function buildPhaseMicroProgram(
	phase: PhaseRecord,
	phaseOutputs: Record<string, string>,
	previous: string,
): unknown {
	const phaseClone: PhaseRecord = { ...phase, final: true };
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
	return { name: `phase-${phase.id}`, phases: [phaseClone] };
}

/**
 * Resolve the provider handle for exactly one durable active attempt after a
 * restart/takeover. Unlike the ordinary scheduler path, this performs no
 * external submission. A provider must offer authoritative lookup semantics
 * or recovery remains fail-closed.
 */
export async function lookupDurableDispatchForRecovery(
	program: unknown,
	providers: PhaseSchedulerProviders,
	opts: {
		runId: string;
		cwd: string;
		continuation: Pick<RunContinuation, "phaseOutputs" | "activeAttempt" | "nextPhaseId">;
	},
): Promise<DurableDispatchRecoveryLookup> {
	const active = opts.continuation.activeAttempt;
	if (!active) return { kind: "invalid", reason: "run has no durable active dispatch attempt" };
	if (opts.continuation.nextPhaseId && opts.continuation.nextPhaseId !== active.phaseId) {
		return {
			kind: "invalid",
			reason: "durable active dispatch does not match the continuation cursor",
		};
	}
	if (active.state === "prepared") {
		return {
			kind: "invalid",
			reason: "dispatch was prepared but durable intent was never recorded",
		};
	}

	const phases = asPhases(program);
	const ordered = topoOrderPhases(phases);
	if (!ordered) return { kind: "invalid", reason: "program has no valid topological phase order" };
	const phaseIndex = ordered.findIndex((phase) => phase.id === active.phaseId);
	if (phaseIndex < 0) {
		return {
			kind: "invalid",
			reason: `durable active phase ${active.phaseId} is absent from BoundPlan`,
		};
	}
	const phase = ordered[phaseIndex]!;
	const type = phase.type ?? "agent";
	if (type !== active.type) {
		return {
			kind: "invalid",
			reason: `durable active type ${active.type} does not match BoundPlan type ${type}`,
		};
	}
	let provider: ExecutionProvider | undefined;
	if (isScriptType(type)) provider = providers.script;
	else if (isAgentishType(type)) provider = providers.llm;
	if (!provider) {
		return {
			kind: "invalid",
			reason: `no ExecutionProvider for durable phase type ${type}`,
		};
	}
	if (provider.name !== active.providerName) {
		return {
			kind: "invalid",
			reason:
				`durable provider ${active.providerName} does not match current provider ` +
				`${provider.name} for phase ${active.phaseId}`,
		};
	}
	if (active.providerHandle) {
		return {
			kind: "found",
			provider,
			providerName: provider.name,
			handle: active.providerHandle,
		};
	}
	if (!provider.lookupByIdempotency) {
		return {
			kind: "unsupported",
			providerName: provider.name,
			reason: `provider ${provider.name} has no authoritative idempotency lookup`,
		};
	}

	let previous = "";
	for (const prior of ordered.slice(0, phaseIndex)) {
		const output = opts.continuation.phaseOutputs[prior.id];
		if (output !== undefined) previous = output;
	}
	const response = await provider.lookupByIdempotency({
		runId: `${opts.runId}:${phase.id}`,
		idempotencyKey: active.idempotencyKey,
		program: buildPhaseMicroProgram(phase, opts.continuation.phaseOutputs, previous),
		cwd: opts.cwd,
	});
	if (response.kind === "found") {
		if (!response.handle) {
			return {
				kind: "ambiguous",
				provider,
				providerName: provider.name,
				reason: `provider ${provider.name} returned an empty recovery handle`,
			};
		}
		return {
			kind: "found",
			provider,
			providerName: provider.name,
			handle: response.handle,
			leaseEpoch: response.leaseEpoch,
		};
	}
	if (response.kind === "not-found") {
		return { kind: "not-found", provider, providerName: provider.name };
	}
	return {
		kind: response.kind,
		provider,
		providerName: provider.name,
		reason: response.reason,
	};
}

type TerminalObservation =
	| { kind: "result"; result: CollectResult }
	| { kind: "error"; reason: string };

async function waitTerminal(
	provider: ExecutionProvider,
	handle: string,
	deadlineMs: number,
): Promise<TerminalObservation> {
	const deadline = Date.now() + deadlineMs;
	// `collect` is the provider's terminal-observation alias. Prefer it when the
	// adapter implements it so a remote provider cannot hide a terminal result in
	// a second, unexamined observation path.
	const observe = provider.collect?.bind(provider) ?? provider.poll.bind(provider);
	try {
		let c = await observe(handle);
		while (c.kind === "still-running" && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 15));
			c = await observe(handle);
		}
		return { kind: "result", result: c };
	} catch (error) {
		return {
			kind: "error",
			reason: `provider terminal observation failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function copyAttempt(attempt: PhaseAttempt): PhaseAttempt {
	return { ...attempt };
}

function makeCheckpoint(
	attempts: readonly PhaseAttempt[],
	phaseOutputs: Readonly<Record<string, string>>,
	activeAttempt: DurableDispatchAttempt | undefined,
	nextPhaseId: string | undefined,
): SchedulerCheckpoint {
	return {
		phaseAttempts: attempts.map(copyAttempt),
		phaseOutputs: { ...phaseOutputs },
		...(activeAttempt === undefined ? {} : { activeAttempt: { ...activeAttempt } }),
		...(nextPhaseId === undefined ? {} : { nextPhaseId }),
	};
}

function checkpointResult(
	ok: boolean,
	attempts: PhaseAttempt[],
	phaseOutputs: Record<string, string>,
	activeAttempt?: DurableDispatchAttempt,
	nextPhaseId?: string,
): Pick<ScheduleResult, "ok" | "attempts" | "phaseOutputs" | "checkpoint"> {
	return {
		ok,
		attempts,
		phaseOutputs,
		checkpoint: makeCheckpoint(attempts, phaseOutputs, activeAttempt, nextPhaseId),
	};
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
		/**
		 * Stable admission identity when the run was created through the durable
		 * admission saga. Provider retries must share this scope across host
		 * restart; legacy runs retain their run-id scope.
		 */
		admissionId?: string;
		cwd: string;
		/** Per-phase poll budget ms (default 60s). */
		phaseDeadlineMs?: number;
		/** A durable cursor from the project journal; settled phases must not rerun. */
		continuation?: Pick<
			RunContinuation,
			"phaseAttempts" | "phaseOutputs" | "activeAttempt" | "nextPhaseId"
		>;
	} & SchedulerCallbacks,
): Promise<ScheduleResult> {
	const phases = asPhases(program);
	if (phases.length === 0) {
		return { ...checkpointResult(false, [], {}), error: "program has no phases" };
	}
	const ordered = topoOrderPhases(phases);
	if (!ordered) {
		return { ...checkpointResult(false, [], {}), error: "phase dependency cycle" };
	}

	const phaseOutputs: Record<string, string> = { ...(opts.continuation?.phaseOutputs ?? {}) };
	const attempts: PhaseAttempt[] = (opts.continuation?.phaseAttempts ?? []).map(copyAttempt);
	const phaseDeadlineMs = opts.phaseDeadlineMs ?? 60_000;
	let previous = "";
	let lastFailed: string | undefined;
	let activeAttempt = opts.continuation?.activeAttempt
		? { ...opts.continuation.activeAttempt }
		: undefined;

	async function persistCheckpoint(nextPhaseId: string | undefined): Promise<void> {
		await opts.onCheckpoint?.(makeCheckpoint(attempts, phaseOutputs, activeAttempt, nextPhaseId));
	}

	for (const [phaseIndex, phase] of ordered.entries()) {
		const type = phase.type ?? "agent";
		const settled = attempts.find(
			(attempt) =>
				attempt.phaseId === phase.id &&
				(attempt.status === "completed" || attempt.status === "skipped"),
		);
		if (settled) {
			if (settled.status === "completed") {
				const output = phaseOutputs[phase.id] ?? settled.output;
				if (output !== undefined) {
					phaseOutputs[phase.id] = output;
					previous = output;
				}
			}
			continue;
		}

		const attemptId = newId("att");
		const nextPhaseId = ordered[phaseIndex + 1]?.id;

		// Upstream deps failed → skip remaining (fail closed for success)
		const depFailed = depsOf(phase).some((d) => {
			const a = attempts.find((x) => x.phaseId === d);
			return a?.status === "failed";
		});
		if (depFailed) {
			attempts.push({
				phaseId: phase.id,
				type,
				status: "skipped",
				error: "upstream dependency failed",
				attemptId,
			});
			await persistCheckpoint(nextPhaseId);
			continue;
		}

		if (!evalWhen(phase.when, phaseOutputs)) {
			attempts.push({
				phaseId: phase.id,
				type,
				status: "skipped",
				error: "when guard false",
				attemptId,
			});
			await persistCheckpoint(nextPhaseId);
			continue;
		}

		// Build phase micro-program for providers.
		const micro = buildPhaseMicroProgram(phase, phaseOutputs, previous);

		// Approval is a scheduler-native pause. It never invokes an LLM/provider;
		// ControlHost records the pending request and exact checkpoint atomically.
		if (type === "approval") {
			return {
				...checkpointResult(true, attempts, phaseOutputs, activeAttempt, phase.id),
				parked: {
					phaseId: phase.id,
					message:
						typeof phase.task === "string"
							? interpolatePhaseText(phase.task, { steps: phaseOutputs, previous })
							: "Approve to continue?",
				},
			};
		}

		let provider: ExecutionProvider | undefined;
		if (isScriptType(type)) {
			provider = providers.script;
		} else if (isAgentishType(type)) {
			provider = providers.llm;
			if (!provider) {
				const err = `no LLM ExecutionProvider for phase type '${type}' (phase ${phase.id})`;
				attempts.push({ phaseId: phase.id, type, status: "failed", error: err, attemptId });
				lastFailed = err;
				await persistCheckpoint(nextPhaseId);
				continue;
			}
		} else {
			// Unknown type — fail closed.
			const err = `unsupported phase type '${type}' on ControlHost scheduler`;
			attempts.push({ phaseId: phase.id, type, status: "failed", error: err, attemptId });
			lastFailed = err;
			await persistCheckpoint(nextPhaseId);
			continue;
		}

		if (activeAttempt && activeAttempt.phaseId !== phase.id) {
			const err =
				`durable dispatch attempt for phase ${activeAttempt.phaseId} blocks phase ${phase.id}; ` +
				"reconcile the recorded attempt before advancing the cursor";
			return {
				...checkpointResult(false, attempts, phaseOutputs, activeAttempt, phase.id),
				error: err,
			};
		}

		let dispatch = activeAttempt;
		if (dispatch && dispatch.providerName !== provider.name) {
			return {
				...checkpointResult(false, attempts, phaseOutputs, dispatch, phase.id),
				error:
					`durable dispatch provider ${dispatch.providerName} does not match ` +
					`current provider ${provider.name} for phase ${phase.id}`,
			};
		}
		if (!dispatch) {
			const now = Date.now();
			dispatch = {
				attemptId,
				phaseId: phase.id,
				type,
				idempotencyKey: `${opts.admissionId ?? opts.runId}:${phase.id}:${attemptId}`,
				providerName: provider.name,
				state: "prepared",
				createdAt: now,
				updatedAt: now,
			};
		}
		if (dispatch.state === "prepared") {
			dispatch = { ...dispatch, state: "intent-recorded", updatedAt: Date.now() };
			activeAttempt = dispatch;
			await opts.onDispatchIntent?.(dispatch);
		}

		let handle =
			dispatch.state === "acknowledged" || dispatch.state === "ambiguous"
				? dispatch.providerHandle
				: undefined;
		if (!handle) {
			const authorization = await opts.beforeProviderSubmit?.(dispatch);
			if (authorization?.allowed === false) {
				return {
					...checkpointResult(false, attempts, phaseOutputs, activeAttempt, phase.id),
					error: authorization.message,
					dispatchDenied: {
						phaseId: phase.id,
						code: authorization.code,
						message: authorization.message,
					},
				};
			}
			let submit: SubmitResult;
			try {
				submit = await provider.submit({
					runId: `${opts.runId}:${phase.id}`,
					idempotencyKey: dispatch.idempotencyKey,
					program: micro,
					cwd: opts.cwd,
					submissionFence: authorization?.submissionFence,
				});
			} catch (error) {
				const denial = providerSubmissionDenial(error);
				if (!denial) throw error;
				return {
					...checkpointResult(false, attempts, phaseOutputs, activeAttempt, phase.id),
					error: denial.message,
					dispatchDenied: {
						phaseId: phase.id,
						code: denial.code,
						message: denial.message,
					},
				};
			}
			if (submit.kind === "rejected") {
				activeAttempt = undefined;
				attempts.push({
					phaseId: phase.id,
					type,
					status: "failed",
					error: submit.reason,
					providerName: provider.name,
					attemptId: dispatch.attemptId,
				});
				lastFailed = submit.reason;
				await persistCheckpoint(nextPhaseId);
				continue;
			}

			handle = submit.handle;
			if (!handle) {
				const err = "provider accepted without handle";
				activeAttempt = undefined;
				attempts.push({
					phaseId: phase.id,
					type,
					status: "failed",
					error: err,
					providerName: provider.name,
					attemptId: dispatch.attemptId,
				});
				lastFailed = err;
				await persistCheckpoint(nextPhaseId);
				continue;
			}
			const acknowledgementOwnershipFailure = providerHandleOwnershipFailure(provider, {
				handle,
				runId: `${opts.runId}:${phase.id}`,
				providerName: provider.name,
			});
			if (acknowledgementOwnershipFailure) {
				return {
					...checkpointResult(false, attempts, phaseOutputs, activeAttempt, phase.id),
					error: acknowledgementOwnershipFailure,
					dispatchHandleInvalid: {
						phaseId: phase.id,
						providerName: provider.name,
						handle,
						stage: "acknowledgement",
						reason: acknowledgementOwnershipFailure,
					},
				};
			}
			dispatch = {
				...dispatch,
				state: submit.kind === "ambiguous" ? "ambiguous" : "acknowledged",
				providerHandle: handle,
				updatedAt: Date.now(),
			};
			activeAttempt = dispatch;
			try {
				await opts.onDispatchAcknowledged?.(dispatch);
			} catch (error) {
				const message = authorityRevocationMessage(error);
				if (!message) throw error;
				const { providerHandle: _providerHandle, ...intentWithoutHandle } = dispatch;
				const durableIntent: DurableDispatchAttempt = {
					...intentWithoutHandle,
					state: "intent-recorded",
				};
				return {
					...checkpointResult(false, attempts, phaseOutputs, durableIntent, phase.id),
					error: message,
					dispatchAcknowledgementLost: {
						phaseId: phase.id,
						providerName: provider.name,
						handle,
						message,
					},
				};
			}
		}

		const observationOwnershipFailure = providerHandleOwnershipFailure(provider, {
			handle,
			runId: `${opts.runId}:${phase.id}`,
			providerName: provider.name,
		});
		if (observationOwnershipFailure) {
			return {
				...checkpointResult(false, attempts, phaseOutputs, activeAttempt, phase.id),
				error: observationOwnershipFailure,
				dispatchHandleInvalid: {
					phaseId: phase.id,
					providerName: provider.name,
					handle,
					stage: "terminal-observation",
					reason: observationOwnershipFailure,
				},
			};
		}

		const observed = await waitTerminal(provider, handle, phaseDeadlineMs);
		if (observed.kind === "error") {
			attempts.push({
				phaseId: phase.id,
				type,
				status: "still-running",
				error: observed.reason,
				providerName: provider.name,
				handle,
				attemptId: dispatch.attemptId,
			});
			return {
				...checkpointResult(false, attempts, phaseOutputs, activeAttempt, phase.id),
				error: observed.reason,
				stillRunning: {
					phaseId: phase.id,
					handle,
					providerName: provider.name,
					provider,
					observationError: observed.reason,
				},
			};
		}
		const collected = observed.result;
		if (collected.kind === "completed") {
			const out = collected.output ?? "";
			phaseOutputs[phase.id] = out;
			previous = out;
			attempts.push({
				phaseId: phase.id,
				type,
				status: "completed",
				output: out,
				providerName: provider.name,
				handle,
				attemptId: dispatch.attemptId,
			});
			activeAttempt = undefined;
			await persistCheckpoint(nextPhaseId);
		} else if (collected.kind === "failed") {
			const err = collected.error ?? "phase failed";
			attempts.push({
				phaseId: phase.id,
				type,
				status: "failed",
				error: err,
				providerName: provider.name,
				handle,
				attemptId: dispatch.attemptId,
			});
			lastFailed = err;
			activeAttempt = undefined;
			await persistCheckpoint(nextPhaseId);
		} else if (collected.kind === "cancelled") {
			// A bare provider-local `cancelled` enum proves neither command-bound
			// cancellation nor containment of remote/detached side effects. Do not
			// convert it to a failed terminal phase: retain the active attempt and
			// hand it to ControlHost's fail-closed reconciliation path instead.
			attempts.push({
				phaseId: phase.id,
				type,
				status: "still-running",
				error: "provider reported cancelled without a durable containment proof",
				providerName: provider.name,
				handle,
				attemptId: dispatch.attemptId,
			});
			return {
				...checkpointResult(false, attempts, phaseOutputs, activeAttempt, phase.id),
				error: "provider reported cancelled without a durable containment proof",
				stillRunning: {
					phaseId: phase.id,
					handle,
					providerName: provider.name,
					provider,
				},
			};
		} else {
			// Still-running after budget → hand off to ControlHost reconcile (do not fail-terminal).
			attempts.push({
				phaseId: phase.id,
				type,
				status: "still-running",
				error: "phase still-running after deadline",
				providerName: provider.name,
				handle,
				attemptId: dispatch.attemptId,
			});
			return {
				...checkpointResult(false, attempts, phaseOutputs, activeAttempt, phase.id),
				error: "phase still-running after deadline",
				stillRunning: {
					phaseId: phase.id,
					handle,
					providerName: provider.name,
					provider,
				},
			};
		}
	}

	const anyFailed = attempts.some((a) => a.status === "failed");
	if (anyFailed) {
		return {
			...checkpointResult(false, attempts, phaseOutputs, activeAttempt),
			error: lastFailed ?? "one or more phases failed",
		};
	}

	// Final output: last final:true phase, else last completed.
	const finals = ordered.filter((p) => p.final === true);
	let finalOutput = "";
	if (finals.length > 0) {
		const lastFinal = finals[finals.length - 1]!;
		finalOutput = phaseOutputs[lastFinal.id] ?? "";
	} else {
		const completed = attempts.filter((a) => a.status === "completed");
		finalOutput = completed[completed.length - 1]?.output ?? "";
	}

	return {
		...checkpointResult(true, attempts, phaseOutputs, activeAttempt),
		finalOutput,
	};
}
