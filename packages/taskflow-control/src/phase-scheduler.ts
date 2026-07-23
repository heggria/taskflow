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
	type: string;
	status: "completed" | "failed" | "skipped" | "still-running";
	output?: string;
	error?: string;
	providerName?: string;
	handle?: string;
	attemptId: string;
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
		type === "expand" ||
		type === "approval"
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

	const phaseOutputs: Record<string, string> = {};
	const attempts: PhaseAttempt[] = [];
	const phaseDeadlineMs = opts.phaseDeadlineMs ?? 60_000;
	let previous = "";
	let lastFailed: string | undefined;

	for (const phase of ordered) {
		const type = phase.type ?? "agent";
		const attemptId = newId("att");

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
			continue;
		}

		// Build phase micro-program for providers
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
					type,
					status: "failed",
					error: err,
					attemptId,
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
				type,
				status: "failed",
				error: err,
				attemptId,
			});
			lastFailed = err;
			continue;
		}

		const submit = await provider.submit({
			runId: `${opts.runId}:${phase.id}`,
			idempotencyKey: `${opts.runId}:${phase.id}:${attemptId}`,
			program: micro,
			cwd: opts.cwd,
		});

		if (submit.kind === "rejected") {
			attempts.push({
				phaseId: phase.id,
				type,
				status: "failed",
				error: submit.reason,
				providerName: provider.name,
				attemptId,
			});
			lastFailed = submit.reason;
			continue;
		}

		const handle = submit.handle;
		if (!handle) {
			const err = "provider accepted without handle";
			attempts.push({
				phaseId: phase.id,
				type,
				status: "failed",
				error: err,
				providerName: provider.name,
				attemptId,
			});
			lastFailed = err;
			continue;
		}

		const collected = await waitTerminal(provider, handle, phaseDeadlineMs);
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
				attemptId,
			});
		} else if (collected.kind === "failed") {
			const err = collected.error ?? "phase failed";
			attempts.push({
				phaseId: phase.id,
				type,
				status: "failed",
				error: err,
				providerName: provider.name,
				handle,
				attemptId,
			});
			lastFailed = err;
		} else if (collected.kind === "cancelled") {
			attempts.push({
				phaseId: phase.id,
				type,
				status: "failed",
				error: "phase cancelled",
				providerName: provider.name,
				handle,
				attemptId,
			});
			lastFailed = "phase cancelled";
		} else {
			// still-running after budget → hand off to ControlHost reconcile (do not fail-terminal)
			attempts.push({
				phaseId: phase.id,
				type,
				status: "still-running",
				error: "phase still-running after deadline",
				providerName: provider.name,
				handle,
				attemptId,
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
