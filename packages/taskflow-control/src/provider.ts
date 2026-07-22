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
	submit(req: {
		runId: string;
		idempotencyKey: string;
		program: unknown;
		cwd: string;
	}): Promise<SubmitResult>;
	/** Alias for poll — collect terminal or still-running. */
	collect?(handle: string): Promise<CollectResult>;
	poll(handle: string): Promise<CollectResult>;
	/** Best-effort progress stream (optional). */
	watch?(handle: string): AsyncIterable<{ type: string; data?: unknown }>;
	cancel(handle: string): Promise<{ kind: "cancelled" | "already-terminal" | "ambiguous" }>;
	reconcile(handle: string): Promise<ReconcileResult>;
	/** Whether the job still has live/ambiguous side effects. */
	isLive?(handle: string): boolean;
	/** Load durable handle after process restart. */
	loadHandle?(handle: string): ProviderJobHandle | null;
	/** Mark all jobs quiescent (tests only). */
	quiesceAll?(): void;
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
				runId: "mock",
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
