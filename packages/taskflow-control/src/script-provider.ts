/**
 * Real ExecutionProvider for script-shaped BoundPlans (zero LLM).
 * Production default for ControlHost when no provider is injected.
 *
 * Spawns the real OS process; exit code ≠ 0 → failed (including exit 37).
 * Cancel kills the process tree; reconcile re-checks pid liveness.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { newId } from "./hash.ts";
import type { ExecutionProvider } from "./provider.ts";

interface ScriptJob {
	runId: string;
	pid?: number;
	cwd: string;
	/** Shell command or argv. */
	cmd: string | string[];
	exitCode?: number | null;
	stdout: string;
	stderr: string;
	status: "running" | "completed" | "failed" | "cancelled";
	error?: string;
	/** Durable handle metadata for restart reconcile. */
	startedAt: number;
}

function extractScriptCommand(program: unknown): { cmd: string | string[]; timeoutMs: number } | null {
	if (!program || typeof program !== "object") return null;
	const phases = (program as { phases?: unknown[] }).phases;
	if (!Array.isArray(phases) || phases.length === 0) return null;
	// Prefer final script phase; else first script phase.
	const scriptPhases = phases.filter(
		(p): p is Record<string, unknown> =>
			!!p && typeof p === "object" && (p as { type?: string }).type === "script",
	);
	if (scriptPhases.length === 0) return null;
	const final = scriptPhases.find((p) => p.final === true) ?? scriptPhases[scriptPhases.length - 1]!;
	const run = final.run;
	if (typeof run !== "string" && !Array.isArray(run)) return null;
	const timeoutMs =
		typeof final.timeout === "number" && final.timeout >= 1000 ? final.timeout : 60_000;
	return { cmd: run as string | string[], timeoutMs };
}

function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Production ExecutionProvider: runs script phases via real child_process.
 * Non-script programs are rejected (must inject a host LLM provider).
 */
export function createScriptExecutionProvider(opts?: {
	/** Persist job records under this dir for restart reconcile (optional). */
	stateDir?: string;
}): ExecutionProvider {
	const jobs = new Map<string, ScriptJob>();
	const stateDir = opts?.stateDir;

	function persist(handle: string, job: ScriptJob): void {
		if (!stateDir) return;
		try {
			fs.mkdirSync(stateDir, { recursive: true });
			const tmp = path.join(stateDir, `${handle}.tmp`);
			const dest = path.join(stateDir, `${handle}.json`);
			fs.writeFileSync(tmp, JSON.stringify(job));
			fs.renameSync(tmp, dest);
		} catch {
			/* best-effort */
		}
	}

	function loadPersisted(handle: string): ScriptJob | null {
		if (!stateDir) return null;
		try {
			const raw = fs.readFileSync(path.join(stateDir, `${handle}.json`), "utf-8");
			return JSON.parse(raw) as ScriptJob;
		} catch {
			return null;
		}
	}

	return {
		name: "script",

		async submit(req) {
			const extracted = extractScriptCommand(req.program);
			if (!extracted) {
				return {
					kind: "rejected",
					reason:
						"script provider requires a BoundPlan with at least one script phase (run: string|string[])",
				};
			}
			const handle = newId("job");
			const job: ScriptJob = {
				runId: req.runId,
				cwd: req.cwd,
				cmd: extracted.cmd,
				stdout: "",
				stderr: "",
				status: "running",
				startedAt: Date.now(),
			};
			jobs.set(handle, job);
			persist(handle, job);

			const arrayForm = Array.isArray(extracted.cmd);
			const child = arrayForm
				? spawn((extracted.cmd as string[])[0]!, (extracted.cmd as string[]).slice(1), {
						cwd: req.cwd,
						shell: false,
						env: { ...process.env },
					})
				: spawn(extracted.cmd as string, {
						cwd: req.cwd,
						shell: true,
						env: { ...process.env },
					});

			job.pid = child.pid;
			persist(handle, job);

			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				if (child.pid) {
					try {
						process.kill(child.pid, "SIGTERM");
					} catch {
						/* ignore */
					}
				}
			}, extracted.timeoutMs);

			child.stdout?.on("data", (d: Buffer) => {
				if (job.stdout.length < 1_048_576) job.stdout += d.toString("utf8");
			});
			child.stderr?.on("data", (d: Buffer) => {
				if (job.stderr.length < 4096) job.stderr += d.toString("utf8");
			});

			child.on("error", (err) => {
				clearTimeout(timer);
				job.status = "failed";
				job.error = err.message;
				job.exitCode = null;
				persist(handle, job);
			});

			child.on("close", (code) => {
				clearTimeout(timer);
				job.exitCode = code;
				if (job.status === "cancelled") {
					persist(handle, job);
					return;
				}
				if (timedOut) {
					job.status = "failed";
					job.error = `script timed out after ${extracted.timeoutMs}ms`;
				} else if (code === 0) {
					job.status = "completed";
				} else {
					job.status = "failed";
					job.error = `script exited with code ${code}${job.stderr ? `: ${job.stderr.trim()}` : ""}`;
				}
				persist(handle, job);
			});

			return { kind: "accepted", handle };
		},

		async poll(handle) {
			const job = jobs.get(handle) ?? loadPersisted(handle);
			if (!job) return { kind: "failed", error: "unknown handle" };
			if (job.status === "running") {
				if (job.pid && !isPidAlive(job.pid)) {
					// Process died without close event — treat as failed unknown
					return { kind: "still-running" };
				}
				return { kind: "still-running" };
			}
			if (job.status === "completed") return { kind: "completed", output: job.stdout || "ok" };
			if (job.status === "cancelled") return { kind: "cancelled" };
			return { kind: "failed", error: job.error ?? `exit ${job.exitCode}` };
		},

		async cancel(handle) {
			const job = jobs.get(handle) ?? loadPersisted(handle);
			if (!job) return { kind: "already-terminal" };
			if (job.status !== "running") return { kind: "already-terminal" };
			job.status = "cancelled";
			if (job.pid) {
				try {
					process.kill(job.pid, "SIGKILL");
				} catch {
					/* ignore */
				}
			}
			persist(handle, job);
			return { kind: "cancelled" };
		},

		async reconcile(handle) {
			const job = jobs.get(handle) ?? loadPersisted(handle);
			if (!job) return { kind: "failed", error: "unknown handle" };
			if (job.status === "completed") return { kind: "completed", output: job.stdout || "ok" };
			if (job.status === "failed") return { kind: "failed", error: job.error ?? "failed" };
			if (job.status === "cancelled") return { kind: "cancelled" };
			// running: do NOT treat unknown as quiescent — if pid missing, ambiguous
			if (job.pid && isPidAlive(job.pid)) return { kind: "running" };
			if (job.pid && !isPidAlive(job.pid)) {
				// Dead without terminal record — ambiguous (may have completed off-record)
				return { kind: "ambiguous", reason: "pid dead without recorded terminal status" };
			}
			return { kind: "ambiguous", reason: "no pid; cannot prove quiescent" };
		},

		isLive(handle) {
			const job = jobs.get(handle) ?? loadPersisted(handle);
			if (!job || job.status !== "running") return false;
			if (job.pid) return isPidAlive(job.pid);
			return true; // unknown live
		},
	};
}

/** True when program is executable by the script provider alone. */
export function isScriptOnlyProgram(program: unknown): boolean {
	return extractScriptCommand(program) !== null;
}
