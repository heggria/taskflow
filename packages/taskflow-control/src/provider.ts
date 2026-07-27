/**
 * ExecutionProvider contract (D9 / §16) + mock for tests only.
 * Production defaults to ScriptExecutionProvider (script-provider.ts).
 */
import { newId } from "./hash.ts";

export type SubmitResult =
	| { kind: "accepted"; handle: string; leaseEpoch?: number }
	| { kind: "rejected"; reason: string }
	| { kind: "ambiguous"; handle?: string; reason: string };

export type ReconcileResult =
	| { kind: "running" }
	| { kind: "completed"; output: string }
	| { kind: "failed"; error: string }
	| { kind: "cancelled" }
	| { kind: "ambiguous"; reason: string };

export type CollectResult =
	| { kind: "completed"; output: string }
	| { kind: "failed"; error: string }
	| { kind: "cancelled" }
	| { kind: "still-running" };

export type ProbeResult = {
	ok: boolean;
	providerName: string;
	capabilities: string[];
	/** false if provider cannot run this program shape */
	supportsProgram?: boolean;
	detail?: string;
};

export type PrepareResult =
	| { kind: "ready"; planId: string }
	| { kind: "rejected"; reason: string };

/**
 * A host-held, synchronous authority critical section supplied to providers
 * that can bind their own durable reservation and external side effect (for
 * example ScriptExecutionProvider's reserve → spawn → durable acknowledgement
 * sequence). It is intentionally not a generic remote-provider credential:
 * providers that cannot honor it remain a P13 non-GA boundary.
 */
export interface ProviderSubmissionFence {
	execute<T>(operation: () => T): T;
}

/**
 * Optional synchronous authority boundary for a provider-side cancellation
 * effect. A provider that cannot honor it remains an explicit P13 non-GA
 * boundary; it must not be treated as safely fenced merely because the host
 * checked authority before awaiting `cancel`.
 */
export interface ProviderCancelOptions {
	cancellationFence?: ProviderSubmissionFence;
}

export interface ProviderSubmitRequest {
	runId: string;
	idempotencyKey: string;
	program: unknown;
	cwd: string;
	/** Optional because remote/generic providers do not yet implement this contract. */
	submissionFence?: ProviderSubmissionFence;
}

/**
 * Exact stable identity of a previously journaled dispatch attempt. A provider
 * that implements restart recovery must verify the whole request shape, not
 * merely trust an unscoped idempotency key supplied by a new host epoch.
 */
export interface ProviderIdempotencyLookupRequest {
	runId: string;
	idempotencyKey: string;
	program: unknown;
	cwd: string;
}

/**
 * Provider answer for a restart recovery lookup.
 *
 * `not-found` is a strong assertion: the provider must have durably proved
 * that the exact request has neither a reservation nor an external handle.
 * Implementations that cannot make that assertion must return `ambiguous`.
 * A provider without this method is deliberately unrecoverable by automatic
 * ControlHost recovery and must remain fail-closed/operator-owned.
 */
export type ProviderIdempotencyLookupResult =
	| { kind: "found"; handle: string; leaseEpoch?: number }
	| { kind: "not-found" }
	| { kind: "rejected"; reason: string }
	| { kind: "ambiguous"; reason: string };

/** Durable handle record for restart reconcile (P16/D9). */
export interface ProviderJobHandle {
	handle: string;
	runId: string;
	providerName: string;
	pid?: number;
	leaseEpoch: number;
	cwd: string;
	startedAt: number;
	status: "running" | "completed" | "failed" | "cancelled";
	exitCode?: number | null;
	stdout?: string;
	stderr?: string;
	error?: string;
}

export interface ExecutionProvider {
	readonly name: string;
	/** Capability probe before admit (optional but required for full contract). */
	probe?(ctx: { cwd: string; program: unknown }): Promise<ProbeResult>;
	/** Prepare fulfillment plan (optional). */
	prepare?(req: { runId: string; program: unknown; cwd: string }): Promise<PrepareResult>;
	submit(req: ProviderSubmitRequest): Promise<SubmitResult>;
	/**
	 * Resolve a durable handle for a pre-existing dispatch intent after writer
	 * crash/takeover. Absence means automatic recovery is not permitted.
	 */
	lookupByIdempotency?(
		req: ProviderIdempotencyLookupRequest,
	): Promise<ProviderIdempotencyLookupResult>;
	/** Alias for poll — collect terminal or still-running. */
	collect?(handle: string): Promise<CollectResult>;
	poll(handle: string): Promise<CollectResult>;
	/** Best-effort progress stream (optional). */
	watch?(handle: string): AsyncIterable<{ type: string; data?: unknown }>;
	cancel(
		handle: string,
		opts?: ProviderCancelOptions,
	): Promise<{ kind: "cancelled" | "already-terminal" | "ambiguous" }>;
	reconcile(handle: string): Promise<ReconcileResult>;
	/** Whether the job still has live/ambiguous side effects. */
	isLive?(handle: string): boolean;
	/** Load durable handle after process restart. */
	loadHandle?(handle: string): ProviderJobHandle | null;
	/** Mark all jobs quiescent (tests only). */
	quiesceAll?(): void;
}

/**
 * A provider may return an opaque handle from submit, but that value is not
 * sufficient authority to acknowledge, observe, cancel, or reconcile work.
 * The provider's own durable record must bind the exact handle to the expected
 * provider-scoped Run identity. Lease/incarnation fencing is deliberately not
 * claimed here; it remains a higher C7 capability requirement.
 */
export function providerHandleOwnershipFailure(
	provider: Pick<ExecutionProvider, "loadHandle">,
	expected: Pick<ProviderJobHandle, "handle" | "runId" | "providerName">,
): string | undefined {
	if (typeof provider.loadHandle !== "function") {
		return `provider ${expected.providerName} cannot verify durable handle ownership`;
	}
	try {
		const record = provider.loadHandle(expected.handle);
		if (!record) {
			return `provider ${expected.providerName} has no durable record for the routed handle`;
		}
		if (
			record.handle !== expected.handle ||
			record.runId !== expected.runId ||
			record.providerName !== expected.providerName
		) {
			return "provider durable handle record does not match the routed Run/phase identity";
		}
		return undefined;
	} catch (error) {
		return `provider durable handle record could not be read: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export interface MockProviderOptions {
	outcome?: "completed" | "failed" | "ambiguous" | "hang";
	output?: string;
	error?: string;
	ambiguousForever?: boolean;
}

interface MockJob {
	runId: string;
	outcome: MockProviderOptions["outcome"];
	output: string;
	error: string;
	live: boolean;
	reconcileCount: number;
}

/** In-process mock provider for control-plane unit/integration tests ONLY. */
export function createMockExecutionProvider(opts: MockProviderOptions = {}): ExecutionProvider {
	const jobs = new Map<string, MockJob>();
	const defaultOutcome = opts.outcome ?? "completed";

	return {
		name: "mock",

		async probe() {
			return {
				ok: true,
				providerName: "mock",
				capabilities: ["submit", "poll", "cancel", "reconcile"],
				supportsProgram: true,
			};
		},

		async prepare(req) {
			return { kind: "ready", planId: `plan-${req.runId}` };
		},

		async submit(req) {
			const handle = newId("job");
			const outcome = defaultOutcome;
			jobs.set(handle, {
				runId: req.runId,
				outcome,
				output: opts.output ?? "mock-ok",
				error: opts.error ?? "mock-failed",
				live: outcome === "hang" || outcome === "ambiguous",
				reconcileCount: 0,
			});
			if (outcome === "ambiguous") {
				return { kind: "ambiguous", handle, reason: "mock ambiguous submit" };
			}
			return { kind: "accepted", handle, leaseEpoch: Date.now() };
		},

		async poll(handle) {
			const job = jobs.get(handle);
			if (!job) return { kind: "failed", error: "unknown handle" };
			if (job.outcome === "hang" || job.outcome === "ambiguous") {
				return { kind: "still-running" };
			}
			if (job.outcome === "failed") return { kind: "failed", error: job.error };
			return { kind: "completed", output: job.output };
		},

		async collect(handle) {
			return this.poll(handle);
		},

		async *watch(handle) {
			yield { type: "poll", data: await this.poll(handle) };
		},

		async cancel(handle) {
			const job = jobs.get(handle);
			if (!job) return { kind: "already-terminal" };
			job.live = false;
			job.outcome = "completed";
			job.output = "cancelled";
			return { kind: "cancelled" };
		},

		async reconcile(handle) {
			const job = jobs.get(handle);
			if (!job) return { kind: "failed", error: "unknown handle" };
			job.reconcileCount += 1;
			if (opts.ambiguousForever || job.outcome === "ambiguous" || job.outcome === "hang") {
				return { kind: "ambiguous", reason: "still ambiguous" };
			}
			if (job.outcome === "failed") return { kind: "failed", error: job.error };
			job.live = false;
			return { kind: "completed", output: job.output };
		},

		isLive(handle) {
			return jobs.get(handle)?.live ?? false;
		},

		loadHandle(handle) {
			const job = jobs.get(handle);
			if (!job) return null;
			return {
				handle,
				// Preserve the provider-scoped run identity supplied at dispatch.
				// ControlHost verifies this against the durable phase route before it
				// may use a local liveness answer to release/park a non-terminal run.
				runId: job.runId,
				providerName: "mock",
				leaseEpoch: Date.now(),
				cwd: ".",
				startedAt: Date.now(),
				status: job.live
					? "running"
					: job.outcome === "failed"
						? "failed"
						: job.outcome === "hang" || job.outcome === "ambiguous"
							? "running"
							: "completed",
				stdout: job.output,
				error: job.error,
			};
		},

		quiesceAll() {
			for (const job of jobs.values()) {
				job.live = false;
			}
		},
	};
}
