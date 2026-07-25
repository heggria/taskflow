/**
 * Host LLM ExecutionProvider — wraps a host SubagentRunner.runTask as a
 * phase-level provider for agent/gate/reduce/… kinds (mandate 2 / D21).
 *
 * Production MCP/Pi inject this so agent phases never bypass ControlHost.
 */
import { newId } from "./hash.ts";
import type {
	CollectResult,
	ExecutionProvider,
	PrepareResult,
	ProbeResult,
	ProviderJobHandle,
	ReconcileResult,
	SubmitResult,
} from "./provider.ts";

/** Minimal RunTask signature (host-neutral; avoids importing taskflow-core types). */
export type HostRunTask = (req: {
	cwd: string;
	agent: string;
	task: string;
	runId: string;
	signal?: AbortSignal;
}) => Promise<{ ok: boolean; output?: string; error?: string; exitCode?: number }>;

interface LlmJob {
	runId: string;
	agent: string;
	task: string;
	cwd: string;
	status: "running" | "completed" | "failed" | "cancelled";
	output?: string;
	error?: string;
	startedAt: number;
	controller: AbortController;
	promise?: Promise<void>;
}

function extractAgentPhase(program: unknown): { agent: string; task: string } | null {
	if (!program || typeof program !== "object") return null;
	const phases = (program as { phases?: unknown[] }).phases;
	if (!Array.isArray(phases) || phases.length === 0) return null;
	const p = phases[0] as { type?: string; agent?: string; task?: string };
	if (!p || typeof p !== "object") return null;
	// Single-phase micro-program from scheduler
	const agent = typeof p.agent === "string" && p.agent ? p.agent : "default";
	const task = typeof p.task === "string" ? p.task : "";
	if (!task && p.type === "script") return null;
	return { agent, task: task || `(phase type ${p.type ?? "agent"})` };
}

/**
 * Create an ExecutionProvider that delegates agent-shaped micro-programs to host runTask.
 */
export function createHostLlmExecutionProvider(opts: {
	runTask: HostRunTask;
	/** Default agent when phase omits agent. */
	defaultAgent?: string;
	/** Caller/request cancellation composed with ControlHost cancel. */
	signal?: AbortSignal;
}): ExecutionProvider {
	const jobs = new Map<string, LlmJob>();
	const defaultAgent = opts.defaultAgent ?? "default";

	return {
		name: "host-llm",

		async probe(ctx): Promise<ProbeResult> {
			const extracted = extractAgentPhase(ctx.program);
			// Supports any non-script single phase or any program with agent phases
			const phases = (ctx.program as { phases?: Array<{ type?: string }> })?.phases;
			const hasAgentish =
				Array.isArray(phases) &&
				phases.some((p) => p && p.type !== "script");
			return {
				ok: true,
				providerName: "host-llm",
				capabilities: ["probe", "prepare", "submit", "poll", "cancel", "reconcile"],
				supportsProgram: hasAgentish || extracted !== null,
			};
		},

		async prepare(req): Promise<PrepareResult> {
			return { kind: "ready", planId: `llm-plan-${req.runId}` };
		},

		async submit(req): Promise<SubmitResult> {
			const extracted = extractAgentPhase(req.program);
			if (!extracted) {
				return {
					kind: "rejected",
					reason: "host-llm provider requires agent-shaped phase (agent + task)",
				};
			}
			const handle = newId("llmjob");
			const controller = new AbortController();
			const signal = opts.signal
				? AbortSignal.any([
						opts.signal,
						controller.signal,
					])
				: controller.signal;
			const job: LlmJob = {
				runId: req.runId,
				agent: extracted.agent || defaultAgent,
				task: extracted.task,
				cwd: req.cwd,
				status: "running",
				startedAt: Date.now(),
				controller,
			};
			jobs.set(handle, job);

			job.promise = (async () => {
				try {
					const res = await opts.runTask({
						cwd: req.cwd,
						agent: job.agent,
						task: job.task,
						runId: req.runId,
						signal,
					});
					if (signal.aborted) {
						job.status = "cancelled";
						return;
					}
					if (res.ok !== false && (res.exitCode === undefined || res.exitCode === 0)) {
						job.status = "completed";
						job.output = res.output ?? "ok";
					} else {
						job.status = "failed";
						job.error = res.error ?? `llm exit ${res.exitCode ?? "nonzero"}`;
					}
				} catch (e) {
					if (signal.aborted) {
						job.status = "cancelled";
						return;
					}
					job.status = "failed";
					job.error = e instanceof Error ? e.message : String(e);
				}
			})();

			return { kind: "accepted", handle, leaseEpoch: job.startedAt };
		},

		async poll(handle): Promise<CollectResult> {
			const job = jobs.get(handle);
			if (!job) return { kind: "failed", error: "unknown handle" };
			if (job.promise && job.status === "running") {
				await Promise.race([
					job.promise,
					new Promise<void>((r) => setTimeout(r, 5)),
				]);
			}
			if (job.status === "running") return { kind: "still-running" };
			if (job.status === "completed") return { kind: "completed", output: job.output ?? "ok" };
			if (job.status === "cancelled") return { kind: "cancelled" };
			return { kind: "failed", error: job.error ?? "llm failed" };
		},

		async collect(handle) {
			return this.poll(handle);
		},

		async cancel(handle) {
			const job = jobs.get(handle);
			if (!job) return { kind: "already-terminal" };
			if (job.status !== "running") return { kind: "already-terminal" };
			job.controller.abort();
			if (job.promise) {
				await Promise.race([
					job.promise,
					new Promise<void>((resolve) =>
						setTimeout(resolve, 1_000),
					),
				]);
			}
			return jobs.get(handle)?.status === "cancelled"
				? { kind: "cancelled" }
				: { kind: "ambiguous" };
		},

		async reconcile(handle): Promise<ReconcileResult> {
			const c = await this.poll(handle);
			if (c.kind === "still-running") return { kind: "running" };
			if (c.kind === "completed") return { kind: "completed", output: c.output };
			if (c.kind === "cancelled") return { kind: "cancelled" };
			return { kind: "failed", error: c.kind === "failed" ? c.error : "failed" };
		},

		isLive(handle) {
			return jobs.get(handle)?.status === "running";
		},

		loadHandle(handle): ProviderJobHandle | null {
			const job = jobs.get(handle);
			if (!job) return null;
			return {
				handle,
				runId: job.runId,
				providerName: "host-llm",
				leaseEpoch: job.startedAt,
				cwd: job.cwd,
				startedAt: job.startedAt,
				status: job.status,
				stdout: job.output,
				error: job.error,
			};
		},

		quiesceAll() {
			for (const j of jobs.values()) {
				if (j.status === "running") {
					j.controller.abort();
				}
			}
		},
	};
}
