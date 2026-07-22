/**
 * ExecutionProvider contract (D9 / §16) + mock for tests.
 */
import { newId } from "./hash.ts";

export type SubmitResult =
	| { kind: "accepted"; handle: string }
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

export interface ExecutionProvider {
	readonly name: string;
	submit(req: {
		runId: string;
		idempotencyKey: string;
		program: unknown;
		cwd: string;
	}): Promise<SubmitResult>;
	poll(handle: string): Promise<CollectResult>;
	cancel(handle: string): Promise<{ kind: "cancelled" | "already-terminal" | "ambiguous" }>;
	reconcile(handle: string): Promise<ReconcileResult>;
	/** Whether the job still has live/ambiguous side effects. */
	isLive?(handle: string): boolean;
	/** Mark all jobs quiescent (tests / operator after proven dead). */
	quiesceAll?(): void;
}

export interface MockProviderOptions {
	/** Immediate outcome for submit→collect. Default completes with "ok". */
	outcome?: "completed" | "failed" | "ambiguous" | "hang";
	output?: string;
	error?: string;
	/** After this many reconcile calls, still ambiguous (for exhaustion tests). */
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

/** In-process mock provider for control-plane unit/integration tests. */
export function createMockExecutionProvider(opts: MockProviderOptions = {}): ExecutionProvider {
	const jobs = new Map<string, MockJob>();
	const defaultOutcome = opts.outcome ?? "completed";

	return {
		name: "mock",

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
			return { kind: "accepted", handle };
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

		quiesceAll() {
			for (const job of jobs.values()) {
				job.live = false;
			}
		},
	};
}
