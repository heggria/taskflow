/**
 * Script phase — zero-token shell command execution.
 * Isolated from runtime.ts so S5 strangler can flip kinds without growing the monolith.
 */

import type { Phase } from "../../schema.ts";
import type { PhaseState } from "../../store.ts";
import { emptyUsage } from "../../usage.ts";
import { killProcessTree } from "../../runner-core.ts";

const MAX_STDOUT = 1_048_576; // 1 MB cap
const SIGKILL_GRACE_MS = 5_000;

export interface ScriptRunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	stdoutOversize: boolean;
	timedOut: boolean;
}

/**
 * Spawn the script command and capture stdout/stderr with timeout + size caps.
 */
export async function runScriptCommand(opts: {
	/** Interpolated argv (array form) or single shell string as [cmd]. */
	interpRunText: string[];
	/** Original `run` shape: array → no shell; string → shell true. */
	arrayForm: boolean;
	cwd: string;
	signal?: AbortSignal;
	stdinInput?: string;
	timeoutMs: number;
}): Promise<ScriptRunResult> {
	const { spawn } = await import("node:child_process");
	const { interpRunText, arrayForm, cwd, signal, stdinInput, timeoutMs } = opts;

	return new Promise((resolve, reject) => {
		const spawnOptions = {
			cwd,
			env: process.env,
			detached: process.platform !== "win32",
		};
		const child = arrayForm
			? spawn(interpRunText[0], interpRunText.slice(1), {
					...spawnOptions,
					shell: false,
				})
			: spawn(interpRunText[0], [], {
					...spawnOptions,
					shell: true,
				});

		let stdout = "";
		let stderr = "";
		let stdoutOversize = false;
		let timedOut = false;
		child.stdout?.on("data", (d: Buffer) => {
			if (stdout.length < MAX_STDOUT) {
				const need = MAX_STDOUT - stdout.length;
				stdout += d.toString().slice(0, need);
				if (stdout.length >= MAX_STDOUT) stdoutOversize = true;
			}
		});
		child.stderr?.on("data", (d: Buffer) => {
			if (stderr.length < 500) {
				stderr += d.toString().slice(0, 500 - stderr.length);
			}
		});

		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid) killProcessTree(child.pid, "SIGTERM", child);
			sigkillTimer = setTimeout(() => {
				if (child.pid) killProcessTree(child.pid, "SIGKILL", child);
			}, SIGKILL_GRACE_MS);
		}, timeoutMs);
		const onAbort = () => {
			if (child.pid) killProcessTree(child.pid, "SIGKILL", child);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		child.on("error", (err) => {
			clearTimeout(timer);
			clearTimeout(sigkillTimer);
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.once("exit", () => {
			if (child.pid) killProcessTree(child.pid, "SIGKILL", child);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(sigkillTimer);
			signal?.removeEventListener("abort", onAbort);
			if (child.pid) killProcessTree(child.pid, "SIGKILL", child);
			resolve({ stdout, stderr, code, stdoutOversize, timedOut });
		});

		if (child.stdin) {
			child.stdin.on("error", () => {}); // swallow EPIPE when child closes stdin early
			if (stdinInput !== undefined) child.stdin.write(stdinInput);
			// A spawned process always receives a pipe for stdin. Close it even when
			// the phase omitted `input`, otherwise commands that wait for EOF (for
			// example `cat`) hang until the script timeout fires.
			child.stdin.end();
		}
	});
}

/** Map a successful/failed script process result to PhaseState. */
export function scriptResultToPhaseState(
	phase: Phase,
	result: ScriptRunResult,
	opts: {
		inputHash: string;
		timeoutMs: number;
		reads?: PhaseState["reads"];
	},
): PhaseState {
	if (result.code !== 0 || result.timedOut) {
		const ps: PhaseState = {
			id: phase.id,
			status: "failed",
			output: result.stdout,
			error: result.timedOut
				? `Script timed out after ${opts.timeoutMs}ms`
				: `Script exited with code ${result.code}${result.stderr ? ": " + result.stderr.slice(0, 500) : ""}${result.stdoutOversize ? " [stdout truncated at 1 MB]" : ""}`,
			timedOut: result.timedOut || undefined,
			usage: emptyUsage(),
			inputHash: opts.inputHash,
			endedAt: Date.now(),
		};
		if (opts.reads) ps.reads = opts.reads;
		return ps;
	}

	const ps: PhaseState = {
		id: phase.id,
		status: "done",
		output: result.stdout.trimEnd() + (result.stdoutOversize ? "\n[stdout truncated at 1 MB]" : ""),
		usage: emptyUsage(),
		inputHash: opts.inputHash,
		endedAt: Date.now(),
	};
	if (opts.reads) ps.reads = opts.reads;
	return ps;
}

/** Spawn error → failed phase (not cacheable — transient). */
export function scriptSpawnErrorToPhaseState(
	phaseId: string,
	err: unknown,
	opts: { inputHash: string; reads?: PhaseState["reads"] },
): PhaseState {
	const msg = err instanceof Error ? err.message : String(err);
	const ps: PhaseState = {
		id: phaseId,
		status: "failed",
		error: `Script error: ${msg}`,
		usage: emptyUsage(),
		inputHash: opts.inputHash,
		endedAt: Date.now(),
	};
	if (opts.reads) ps.reads = opts.reads;
	return ps;
}
