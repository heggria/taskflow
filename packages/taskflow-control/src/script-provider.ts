/**
 * Real ExecutionProvider for script-shaped BoundPlans (zero LLM).
 * Production default for ControlHost when no provider is injected.
 *
 * Spawns the real OS process; exit code ≠ 0 → failed (including exit 37).
 * Cancel can signal an ordinary Unix process group, but raw child_process
 * cannot prove a whole process tree (a descendant may detach). It therefore
 * fails closed as ambiguous; reconcile re-checks group/pid liveness without
 * converting that observation into a cancellation terminal.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { newId } from "./hash.ts";
import { fsyncDirectory, writeFileAtomic } from "./paths.ts";
import type {
	ExecutionProvider,
	ProviderCancelOptions,
	ProviderIdempotencyLookupRequest,
	ProviderIdempotencyLookupResult,
	ProviderJobHandle,
	ProviderSubmissionFence,
	ProbeResult,
	SubmitResult,
} from "./provider.ts";

const IDEMPOTENCY_WAIT_SIGNAL = new Int32Array(
	new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

interface ScriptJob {
	runId: string;
	/** Stable scheduler retry identity; absent only on pre-0.3 persisted jobs. */
	idempotencyKey?: string;
	/** Hash of the request this handle is permanently bound to. */
	requestHash?: string;
	pid?: number;
	/** Unix process-group leader for a detached script; absent on legacy/Windows jobs. */
	processGroupId?: number;
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
	/**
	 * A reservation can outlive a crash before spawn acknowledgement. Such a
	 * record is deliberately ambiguous: retrying its idempotency key must never
	 * create a second external process.
	 */
	dispatchState?: "prepared" | "spawned";
	/** Durable proof that a cancellation signal may have been emitted. */
	cancelRequestedAt?: number;
	/**
	 * In-process only: resolves when close/error handler has persisted terminal status.
	 * Not serialized — after restart, dead pid with status=running is fail-closed.
	 */
	exitSettled?: Promise<void>;
}

interface IdempotencyRecord {
	schemaVersion: 1;
	idempotencyKey: string;
	requestHash: string;
	handle: string;
	createdAt: number;
}

type FencedScriptSubmission =
	| { kind: "result"; result: SubmitResult }
	| {
			kind: "spawned";
			handle: string;
			job: ScriptJob;
			child: ChildProcess;
			timeoutMs: number;
		};

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

function isProcessGroupAlive(processGroupId: number): boolean {
	if (!processGroupId || processGroupId <= 0 || process.platform === "win32") return false;
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch {
		return false;
	}
}

function isScriptJobLive(job: ScriptJob): boolean {
	if (job.processGroupId !== undefined && process.platform !== "win32") {
		return isProcessGroupAlive(job.processGroupId);
	}
	return job.pid ? isPidAlive(job.pid) : job.status === "running";
}

/** Signal the detached Unix process group when one was durably recorded. */
function signalScriptJob(job: ScriptJob, signal: NodeJS.Signals): boolean {
	try {
		if (job.processGroupId !== undefined && process.platform !== "win32") {
			process.kill(-job.processGroupId, signal);
		} else if (job.pid) {
			process.kill(job.pid, signal);
		} else {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

function hashRequestShape(input: {
	runId: string;
	cwd: string;
	cmd: string | string[];
	timeoutMs: number;
}): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function hashIdempotencyKey(key: string): string {
	return createHash("sha256").update(key).digest("hex");
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
	const idempotencyRecords = new Map<string, IdempotencyRecord>();

	function persist(handle: string, job: ScriptJob): boolean {
		if (!stateDir) return true;
		try {
			writeFileAtomic(path.join(stateDir, `${handle}.json`), JSON.stringify(job));
			return true;
		} catch {
			return false;
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

	/**
	 * A provider instance may cache a running job while another process owns the
	 * child and later persists its terminal result. Terminal durable state wins
	 * over a stale local running snapshot; otherwise retain the owner process's
	 * in-memory stdout/exit promise until it is durably published.
	 */
	function loadCurrentJob(handle: string): ScriptJob | null {
		const memory = jobs.get(handle);
		const durable = loadPersisted(handle);
		if (!durable) return memory ?? null;
		if (!memory) return durable;
		if (durable.status !== "running") return durable;
		if (memory.status !== "running") return memory;
		return memory;
	}

	function waitForPersistedJob(handle: string, timeoutMs = 200): ScriptJob | null {
		const deadline = Date.now() + timeoutMs;
		let job = loadPersisted(handle);
		while (!job && Date.now() < deadline) {
			Atomics.wait(IDEMPOTENCY_WAIT_SIGNAL, 0, 0, 2);
			job = loadPersisted(handle);
		}
		return job;
	}

	function idempotencyDir(): string | null {
		return stateDir ? path.join(stateDir, "idempotency") : null;
	}

	function idempotencyPath(key: string): string | null {
		const dir = idempotencyDir();
		return dir ? path.join(dir, `${hashIdempotencyKey(key)}.json`) : null;
	}

	function readIdempotencyRecord(filePath: string): IdempotencyRecord | null | "invalid" {
		try {
			const raw = fs.readFileSync(filePath, "utf8");
			const value = JSON.parse(raw) as Partial<IdempotencyRecord>;
			if (
				value.schemaVersion !== 1 ||
				typeof value.idempotencyKey !== "string" ||
				typeof value.requestHash !== "string" ||
				typeof value.handle !== "string" ||
				!Number.isSafeInteger(value.createdAt)
			) {
				return "invalid";
			}
			return value as IdempotencyRecord;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "invalid";
		}
	}

	/**
	 * Atomically binds an idempotency key to one immutable request shape. The
	 * hard-link publication avoids a reader observing a partially written record
	 * while still preserving first-writer-wins across provider processes.
	 */
	function reserveIdempotency(record: IdempotencyRecord):
		| { kind: "claimed" }
		| { kind: "existing"; record: IdempotencyRecord }
		| { kind: "rejected"; reason: string }
		| { kind: "ambiguous"; reason: string } {
		const cached = idempotencyRecords.get(record.idempotencyKey);
		if (cached) {
			if (cached.requestHash !== record.requestHash) {
				return {
					kind: "rejected",
					reason: "idempotencyKey is already bound to a different script request",
				};
			}
			return { kind: "existing", record: cached };
		}
		const dir = idempotencyDir();
		const dest = idempotencyPath(record.idempotencyKey);
		if (!dir || !dest) {
			idempotencyRecords.set(record.idempotencyKey, record);
			return { kind: "claimed" };
		}

		let tmp: string | undefined;
		try {
			fs.mkdirSync(dir, { recursive: true });
			tmp = path.join(dir, `.${record.handle}.tmp`);
			const fd = fs.openSync(tmp, "wx", 0o600);
			try {
				fs.writeFileSync(fd, JSON.stringify(record), "utf8");
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.linkSync(tmp, dest);
			fs.unlinkSync(tmp);
			fsyncDirectory(dir);
			idempotencyRecords.set(record.idempotencyKey, record);
			return { kind: "claimed" };
		} catch (error) {
			try {
				if (tmp) fs.unlinkSync(tmp);
			} catch {
				/* a crash-safe temporary file is harmless; never remove the published destination */
			}
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				return { kind: "ambiguous", reason: "cannot durably reserve idempotencyKey" };
			}
			const existing = readIdempotencyRecord(dest);
			if (existing === "invalid" || existing === null) {
				return {
					kind: "ambiguous",
					reason: "idempotencyKey reservation exists but is not durably readable",
				};
			}
			idempotencyRecords.set(existing.idempotencyKey, existing);
			if (existing.idempotencyKey !== record.idempotencyKey) {
				return { kind: "ambiguous", reason: "idempotencyKey hash collision or tampered reservation" };
			}
			if (existing.requestHash !== record.requestHash) {
				return {
					kind: "rejected",
					reason: "idempotencyKey is already bound to a different script request",
				};
			}
			return { kind: "existing", record: existing };
		}
	}

	function unknownReservedJob(req: {
		runId: string;
		idempotencyKey: string;
		requestHash: string;
		cmd: string | string[];
		cwd: string;
	}): ScriptJob {
		return {
			runId: req.runId,
			idempotencyKey: req.idempotencyKey,
			requestHash: req.requestHash,
			cwd: req.cwd,
			cmd: req.cmd,
			stdout: "",
			stderr: "",
			status: "running",
			startedAt: Date.now(),
			dispatchState: "prepared",
		};
	}

	/**
	 * Resolve only an immutable, durably acknowledged Script dispatch. This is
	 * intentionally stricter than `submit`'s duplicate-key path: a restart
	 * owner needs proof that the exact request owns a spawned handle, not a
	 * best-effort in-memory cache or a reservation which might predate spawn.
	 */
	function lookupIdempotency(
		req: ProviderIdempotencyLookupRequest,
	): ProviderIdempotencyLookupResult {
		if (typeof req.idempotencyKey !== "string" || req.idempotencyKey.length === 0) {
			return { kind: "rejected", reason: "script provider requires a non-empty idempotencyKey" };
		}
		const extracted = extractScriptCommand(req.program);
		if (!extracted) {
			return { kind: "rejected", reason: "no script phase in recovery request" };
		}
		const requestHash = hashRequestShape({
			runId: req.runId,
			cwd: req.cwd,
			cmd: extracted.cmd,
			timeoutMs: extracted.timeoutMs,
		});

		let record = idempotencyRecords.get(req.idempotencyKey);
		if (!record) {
			const recordPath = idempotencyPath(req.idempotencyKey);
			if (!recordPath) {
				return {
					kind: "ambiguous",
					reason: "script provider has no durable idempotency state for restart lookup",
				};
			}
			const loaded = readIdempotencyRecord(recordPath);
			if (loaded === null) return { kind: "not-found" };
			if (loaded === "invalid") {
				return {
					kind: "ambiguous",
					reason: "idempotency reservation is not durably readable",
				};
			}
			if (loaded.idempotencyKey !== req.idempotencyKey) {
				return {
					kind: "ambiguous",
					reason: "idempotencyKey hash collision or tampered reservation",
				};
			}
			record = loaded;
			idempotencyRecords.set(record.idempotencyKey, record);
		}
		if (record.requestHash !== requestHash) {
			return {
				kind: "rejected",
				reason: "idempotencyKey is bound to a different script recovery request",
			};
		}

		// Restart recovery cannot rely on an in-memory completion snapshot: a
		// durable acknowledgement may have been removed/corrupted after this
		// provider instance observed it. When stateDir is configured, only the
		// current durable job record proves a recoverable handle.
		const job = stateDir ? loadPersisted(record.handle) : jobs.get(record.handle) ?? null;
		if (!job) {
			return {
				kind: "ambiguous",
				reason: "idempotency reservation has no durable job acknowledgement",
			};
		}
		if (
			job.idempotencyKey !== req.idempotencyKey ||
			job.requestHash !== requestHash ||
			job.runId !== req.runId ||
			job.cwd !== req.cwd
		) {
			return {
				kind: "ambiguous",
				reason: "durable script job does not match its idempotency reservation",
			};
		}
		if (job.dispatchState !== "spawned") {
			return {
				kind: "ambiguous",
				reason: "durable script job does not prove that spawn was acknowledged",
			};
		}
		return { kind: "found", handle: record.handle, leaseEpoch: job.startedAt };
	}

	function runSubmissionFence<T>(
		fence: ProviderSubmissionFence | undefined,
		operation: () => T,
	): T {
		return fence ? fence.execute(operation) : operation();
	}

	return {
		name: "script",

		async probe(ctx): Promise<ProbeResult> {
			const extracted = extractScriptCommand(ctx.program);
			return {
				ok: true,
				providerName: "script",
				capabilities: ["probe", "prepare", "submit", "poll", "collect", "cancel", "reconcile", "watch"],
				supportsProgram: extracted !== null,
				detail: extracted ? undefined : "no script phase in program",
			};
		},

		async prepare(req) {
			const extracted = extractScriptCommand(req.program);
			if (!extracted) {
				return { kind: "rejected", reason: "no script phase" };
			}
			return { kind: "ready", planId: `script-plan-${req.runId}` };
		},

		async submit(req) {
			const extracted = extractScriptCommand(req.program);
			if (!extracted) {
				return {
					kind: "rejected",
					reason:
						"script provider requires a BoundPlan with at least one script phase (run: string|string[])",
				};
			}
			if (typeof req.idempotencyKey !== "string" || req.idempotencyKey.length === 0) {
				return { kind: "rejected", reason: "script provider requires a non-empty idempotencyKey" };
			}
			const requestHash = hashRequestShape({
				runId: req.runId,
				cwd: req.cwd,
				cmd: extracted.cmd,
				timeoutMs: extracted.timeoutMs,
			});
			const submission: FencedScriptSubmission = runSubmissionFence(
				req.submissionFence,
				(): FencedScriptSubmission => {
					const handle = newId("job");
					const reservation = reserveIdempotency({
						schemaVersion: 1,
						idempotencyKey: req.idempotencyKey,
						requestHash,
						handle,
						createdAt: Date.now(),
					});
					if (reservation.kind === "rejected") {
						return { kind: "result", result: { kind: "rejected", reason: reservation.reason } };
					}
					if (reservation.kind === "ambiguous") {
						return { kind: "result", result: { kind: "ambiguous", reason: reservation.reason } };
					}
					if (reservation.kind === "existing") {
						const prior =
							jobs.get(reservation.record.handle) ?? waitForPersistedJob(reservation.record.handle);
						if (!prior) {
							// We know a prior caller owns the key but cannot prove whether it
							// reached spawn. Retrying would be a duplicate-side-effect bug.
							jobs.set(
								reservation.record.handle,
								unknownReservedJob({
									runId: req.runId,
									idempotencyKey: req.idempotencyKey,
									requestHash,
									cmd: extracted.cmd,
									cwd: req.cwd,
								}),
							);
							return {
								kind: "result",
								result: {
									kind: "ambiguous",
									handle: reservation.record.handle,
									reason: "idempotency reservation has no durable job acknowledgement",
								},
							};
						}
						jobs.set(reservation.record.handle, prior);
						return {
							kind: "result",
							result: {
								kind: "accepted",
								handle: reservation.record.handle,
								leaseEpoch: prior.startedAt,
							},
						};
					}

					const job: ScriptJob = {
						runId: req.runId,
						idempotencyKey: req.idempotencyKey,
						requestHash,
						cwd: req.cwd,
						cmd: extracted.cmd,
						stdout: "",
						stderr: "",
						status: "running",
						startedAt: Date.now(),
						dispatchState: "prepared",
					};
					jobs.set(handle, job);
					if (!persist(handle, job)) {
						return {
							kind: "result",
							result: {
								kind: "ambiguous",
								handle,
								reason: "idempotency reservation recorded but job preparation was not durable",
							},
						};
					}

					const arrayForm = Array.isArray(extracted.cmd);
					// A detached Unix child becomes its own process-group leader. That lets
					// cancellation target the ordinary shell/child group rather than only
					// the shell wrapper PID. Windows remains an explicit non-GA boundary.
					const detached = process.platform !== "win32";
					const child = arrayForm
						? spawn((extracted.cmd as string[])[0]!, (extracted.cmd as string[]).slice(1), {
								cwd: req.cwd,
								shell: false,
								detached,
								env: { ...process.env },
							})
						: spawn(extracted.cmd as string, {
								cwd: req.cwd,
								shell: true,
								detached,
								env: { ...process.env },
							});

					job.pid = child.pid;
					job.processGroupId = detached ? child.pid : undefined;
					job.dispatchState = "spawned";
					if (!persist(handle, job)) {
						return {
							kind: "result",
							result: {
								kind: "ambiguous",
								handle,
								reason: "script process may be running but dispatch acknowledgement was not durable",
							},
						};
					}
					return { kind: "spawned", handle, job, child, timeoutMs: extracted.timeoutMs };
				},
			);
			if (submission.kind === "result") return submission.result;
			const { handle, job, child, timeoutMs } = submission;

			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
					signalScriptJob(job, "SIGTERM");
			}, timeoutMs);

			child.stdout?.on("data", (d: Buffer) => {
				if (job.stdout.length < 1_048_576) job.stdout += d.toString("utf8");
			});
			child.stderr?.on("data", (d: Buffer) => {
				if (job.stderr.length < 4096) job.stderr += d.toString("utf8");
			});

			// Settle exit before poll can race pid-dead fail-closed over a successful close.
			let settleExit!: () => void;
			job.exitSettled = new Promise<void>((resolve) => {
				settleExit = resolve;
			});

			child.on("error", (err) => {
				clearTimeout(timer);
				job.status = "failed";
				job.error = err.message;
				job.exitCode = null;
				persist(handle, job);
				settleExit();
			});

			child.on("close", (code) => {
				clearTimeout(timer);
				job.exitCode = code;
					if (job.cancelRequestedAt !== undefined || job.status === "cancelled") {
						job.status = "cancelled";
					persist(handle, job);
					settleExit();
					return;
				}
				if (timedOut) {
					job.status = "failed";
					job.error = `script timed out after ${timeoutMs}ms`;
				} else if (code === 0) {
					job.status = "completed";
				} else {
					job.status = "failed";
					job.error = `script exited with code ${code}${job.stderr ? `: ${job.stderr.trim()}` : ""}`;
				}
				persist(handle, job);
				settleExit();
			});

			return { kind: "accepted", handle, leaseEpoch: job.startedAt };
		},

		async lookupByIdempotency(req) {
			return lookupIdempotency(req);
		},

		async collect(handle) {
			return this.poll(handle);
		},

		async *watch(handle) {
			for (let i = 0; i < 100; i++) {
				const c = await this.poll(handle);
				yield { type: "poll", data: c };
				if (c.kind !== "still-running") return;
				await new Promise((r) => setTimeout(r, 20));
			}
		},

		async poll(handle) {
			let job = loadCurrentJob(handle);
			if (!job) return { kind: "failed", error: "unknown handle" };
			if (job.status === "cancelled" && isScriptJobLive(job)) {
				// The direct child reported close, but the durable Unix process group
				// still has a member. Do not make a host release capacity or sign a
				// terminal cancel from a merely local PID observation.
				return { kind: "still-running" };
			}
			if (job.status === "running") {
				if (job.pid && !isScriptJobLive(job)) {
					// In-process: wait briefly for close handler so we do not race a clean exit
					// into fail-closed. After restart, exitSettled is absent → fail-closed.
					const mem = jobs.get(handle);
					if (mem?.exitSettled) {
						await Promise.race([
							mem.exitSettled,
							new Promise<void>((r) => setTimeout(r, 100)),
						]);
						job = loadCurrentJob(handle) ?? job;
						if (job.status !== "running") {
							// fall through to terminal mapping below
						} else {
							// close never settled — fail-closed
							job.status = "failed";
							job.error =
								job.error ??
								`pid ${job.pid} dead without recorded terminal status (fail-closed)`;
							job.exitCode = job.exitCode ?? null;
							persist(handle, job);
							return { kind: "failed", error: job.error };
						}
					} else {
						// Restart path: durable status=running + dead pid → fail-closed
						job.status = "failed";
						job.error =
							job.error ??
							`pid ${job.pid} dead without recorded terminal status (fail-closed)`;
						job.exitCode = job.exitCode ?? null;
						persist(handle, job);
						return { kind: "failed", error: job.error };
					}
				} else {
					return { kind: "still-running" };
				}
			}
			if (job.status === "completed") return { kind: "completed", output: job.stdout || "ok" };
			if (job.status === "cancelled") return { kind: "cancelled" };
			if (job.status === "failed") {
				return { kind: "failed", error: job.error ?? `exit ${job.exitCode}` };
			}
			return { kind: "still-running" };
		},

		async cancel(handle, opts?: ProviderCancelOptions) {
			const job = loadCurrentJob(handle);
			if (!job) return { kind: "already-terminal" };
			if (job.status === "cancelled" && !isScriptJobLive(job)) {
				return { kind: "already-terminal" };
			}
			if (job.status !== "running") return { kind: "already-terminal" };

			const started = runSubmissionFence(opts?.cancellationFence, () => {
				// A prior durable cancellation request may already have emitted a signal
				// before this process crashed. Never duplicate that external action.
				if (job.cancelRequestedAt !== undefined) return "already-requested" as const;
				job.cancelRequestedAt = Date.now();
				if (!persist(handle, job)) return "undurable" as const;
				return signalScriptJob(job, "SIGKILL") ? ("signalled" as const) : ("unsent" as const);
			});
			if (started !== "signalled") {
				return {
					kind: "ambiguous",
					reason:
						started === "already-requested"
							? "durable Script cancellation may already have signalled; reconcile instead of re-signalling"
							: "Script cancellation could not durably prove a process-group signal",
				};
			}

			const settled = jobs.get(handle)?.exitSettled;
			if (settled) {
				await Promise.race([
					settled,
					new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
				]);
			} else {
				const deadline = Date.now() + 5_000;
				while (Date.now() < deadline && isScriptJobLive(job)) {
					await new Promise<void>((resolve) => setTimeout(resolve, 20));
				}
			}
			const latest = loadCurrentJob(handle) ?? job;
			if (latest.status === "cancelled" && !isScriptJobLive(latest)) {
				// A dead Unix process group proves only that its members exited. A
				// descendant may have called setsid()/spawned detached work before the
				// signal, so raw child_process ownership cannot prove whole-tree
				// quiescence. Do not manufacture a terminal cancellation from this
				// narrower observation; a future provider needs a cgroup/job-object or
				// equivalent containment contract before it may return `cancelled`.
				return {
					kind: "ambiguous",
					reason:
						"Script process group exited, but raw child_process cannot prove that no detached descendant remains",
				};
			}
			return {
				kind: "ambiguous",
				reason: "Script cancellation signal was sent but process-group quiescence was not proven",
			};
		},

		async reconcile(handle) {
			const job = loadCurrentJob(handle);
			if (!job) return { kind: "failed", error: "unknown handle" };
			if (job.status === "completed") return { kind: "completed", output: job.stdout || "ok" };
			if (job.status === "failed") return { kind: "failed", error: job.error ?? "failed" };
			if (job.status === "cancelled") {
				return {
					kind: "ambiguous",
					reason: isScriptJobLive(job)
						? "cancelled script still has a live process group"
						: "script process group exited, but raw child_process cannot prove that no detached descendant remains",
				};
			}
			// running: do NOT treat unknown as quiescent — if pid missing, ambiguous
			if (job.pid && isScriptJobLive(job)) return { kind: "running" };
			if (job.pid && !isScriptJobLive(job)) {
				// Dead without terminal record — ambiguous (may have completed off-record)
				return { kind: "ambiguous", reason: "pid dead without recorded terminal status" };
			}
			return { kind: "ambiguous", reason: "no pid; cannot prove quiescent" };
		},

		isLive(handle) {
			const job = loadCurrentJob(handle);
			if (!job) return false;
			if (job.status === "running" || job.status === "cancelled") return isScriptJobLive(job);
			return false;
		},

		loadHandle(handle): ProviderJobHandle | null {
			const job = loadCurrentJob(handle);
			if (!job) return null;
			return {
				handle,
				runId: job.runId,
				providerName: "script",
				pid: job.pid,
				leaseEpoch: job.startedAt,
				cwd: job.cwd,
				startedAt: job.startedAt,
				status: job.status,
				exitCode: job.exitCode,
				stdout: job.stdout,
				stderr: job.stderr,
				error: job.error,
			};
		},
	};
}

/** True when program is executable by the script provider alone. */
export function isScriptOnlyProgram(program: unknown): boolean {
	return extractScriptCommand(program) !== null;
}
