#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const RESULT_SCHEMA = JSON.stringify({
	type: "object",
	additionalProperties: false,
	properties: {
		status: {
			type: "string",
			enum: ["completed", "partial", "blocked", "failed"],
		},
		summary: { type: "string" },
		changed_files: {
			type: "array",
			items: { type: "string" },
		},
		tests: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					command: { type: "string" },
					result: { type: "string" },
				},
				required: ["command", "result"],
			},
		},
		blockers: {
			type: "array",
			items: { type: "string" },
		},
		next_action: { type: "string" },
	},
	required: [
		"status",
		"summary",
		"changed_files",
		"tests",
		"blockers",
		"next_action",
	],
});

function usage() {
	console.error("Usage: node scripts/run-grok-batch.mjs <manifest.json> [--dry-run]");
	process.exit(2);
}

function fail(message) {
	console.error(`[grok-batch] ${message}`);
	process.exit(1);
}

function readManifest(pathname) {
	let value;
	try {
		value = JSON.parse(readFileSync(pathname, "utf8"));
	} catch (error) {
		fail(`cannot read manifest ${pathname}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("manifest must be a JSON object");
	}
	if (!Array.isArray(value.jobs) || value.jobs.length === 0) {
		fail("manifest.jobs must be a non-empty array");
	}
	return value;
}

function safeId(value) {
	return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function atomicJson(pathname, value) {
	const temporary = `${pathname}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
	renameSync(temporary, pathname);
}

function readGrokResult(pathname, job) {
	const envelope = JSON.parse(readFileSync(pathname, "utf8"));
	const result = envelope.structuredOutput;
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		throw new Error("Grok response is missing structuredOutput");
	}
	if (!["completed", "partial", "blocked", "failed"].includes(result.status)) {
		throw new Error(`Grok response has invalid result status: ${String(result.status)}`);
	}
	// Guard against the model emitting a progress placeholder as the FINAL verdict on
	// its first turn, which silently ends the run with no work done. Treat that as a
	// protocol failure so a readOnly job can be retried.
	const turns = envelope.num_turns ?? 0;
	if (job?.minTurns && turns < job.minTurns) {
		throw new Error(
			`Grok returned a verdict after only ${turns} turn(s); minTurns=${job.minTurns} (placeholder verdict)`,
		);
	}
	if (job?.requireTests && (!Array.isArray(result.tests) || result.tests.length === 0)) {
		throw new Error("Grok verdict reports no executed tests but this job requires observed test evidence");
	}
	if (typeof result.summary !== "string" || result.summary.trim().length < 40) {
		throw new Error(`Grok verdict summary is too short to be a real result: ${JSON.stringify(result.summary)}`);
	}
	return {
		resultStatus: result.status,
		summary: result.summary,
		changedFiles: result.changed_files,
		tests: result.tests,
		blockers: result.blockers,
		nextAction: result.next_action,
		stopReason: envelope.stopReason,
		sessionId: envelope.sessionId,
		requestId: envelope.requestId,
		turns: envelope.num_turns,
		costUSD: envelope.total_cost_usd,
	};
}

function validate(manifest, manifestPath) {
	const concurrency = manifest.concurrency ?? 4;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 48) {
		fail("manifest.concurrency must be an integer between 1 and 48");
	}
	// Wide fan-outs must not hit the provider with a thundering herd of identical
	// first requests, so spawns are staggered.
	const staggerMs = manifest.staggerMs ?? (concurrency > 8 ? 400 : 0);
	if (!Number.isInteger(staggerMs) || staggerMs < 0 || staggerMs > 10_000) {
		fail("manifest.staggerMs must be an integer between 0 and 10000");
	}
	const seenIds = new Set();
	const seenCwds = new Map();
	const jobs = manifest.jobs.map((job, index) => {
		if (!job || typeof job !== "object" || Array.isArray(job)) {
			fail(`jobs[${index}] must be an object`);
		}
		if (!safeId(job.id)) fail(`jobs[${index}].id is unsafe`);
		if (seenIds.has(job.id)) fail(`duplicate job id ${job.id}`);
		seenIds.add(job.id);
		if (typeof job.cwd !== "string" || !isAbsolute(job.cwd) || !existsSync(job.cwd)) {
			fail(`job ${job.id} cwd must be an existing absolute path`);
		}
		const cwd = resolve(job.cwd);
		// Two mutating jobs in one worktree would corrupt each other's diff, but any
		// number of readOnly jobs may share a worktree.
		if (seenCwds.has(cwd) && !(job.readOnly === true && seenCwds.get(cwd) === "readOnly")) {
			fail(`two jobs target the same cwd and at least one mutates it: ${cwd}`);
		}
		seenCwds.set(cwd, job.readOnly === true ? "readOnly" : "mutating");
		if (typeof job.prompt !== "string" || job.prompt.trim().length < 40) {
			fail(`job ${job.id} prompt is missing or too short`);
		}
		const maxTurns = job.maxTurns ?? manifest.maxTurns ?? 80;
		if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200) {
			fail(`job ${job.id} maxTurns must be between 1 and 200`);
		}
		const timeoutMinutes = job.timeoutMinutes ?? manifest.timeoutMinutes ?? 30;
		if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 240) {
			fail(`job ${job.id} timeoutMinutes must be between 1 and 240`);
		}
		// Retries are ONLY safe for jobs that do not mutate the worktree (reviews).
		// A mutating job that is retried could double-apply edits, so it must opt in
		// explicitly and default to zero.
		const retries = job.retries ?? (job.readOnly === true ? (manifest.retries ?? 2) : 0);
		if (!Number.isInteger(retries) || retries < 0 || retries > 3) {
			fail(`job ${job.id} retries must be between 0 and 3`);
		}
		if (retries > 0 && job.readOnly !== true) {
			fail(`job ${job.id} sets retries but is not readOnly; refusing to risk double-applied edits`);
		}
		const minTurns = job.minTurns ?? manifest.minTurns ?? 0;
		if (!Number.isInteger(minTurns) || minTurns < 0 || minTurns > 50) {
			fail(`job ${job.id} minTurns must be between 0 and 50`);
		}
		return { ...job, cwd, maxTurns, timeoutMinutes, retries, minTurns, model: job.model ?? manifest.model };
	});
	const logDir = resolve(
		manifest.logDir ?? join(resolve(manifestPath, ".."), `${manifest.name ?? "grok-batch"}-logs`),
	);
	return {
		name: manifest.name ?? "grok-batch",
		concurrency,
		staggerMs,
		grokBin: manifest.grokBin ?? process.env.PI_TASKFLOW_GROK_BIN ?? "grok",
		reasoningEffort: manifest.reasoningEffort ?? "high",
		permissionMode: manifest.permissionMode ?? "bypassPermissions",
		logDir,
		jobs,
	};
}

function commandFor(config, job) {
	const args = [
		"-p",
		job.prompt,
		"--cwd",
		job.cwd,
		"--output-format",
		"json",
		"--json-schema",
		RESULT_SCHEMA,
		"--max-turns",
		String(job.maxTurns),
		"--reasoning-effort",
		job.reasoningEffort ?? config.reasoningEffort,
		"--permission-mode",
		job.permissionMode ?? config.permissionMode,
		"--no-memory",
		"--no-subagents",
		"--disable-web-search",
	];
	if (job.model) args.push("--model", job.model);
	return [config.grokBin, args];
}

// Evidence provenance: the grok CLI rotates across a model roster (grok-4.5-build,
// claude-opus-5, kimi-k3 have all been observed), and those models differ in whether
// they emit a placeholder verdict on turn 1 and whether the envelope carries a cost
// field. An unpinned batch therefore produces non-reproducible evidence, so every
// manifest should set `model`.

function killChildTree(child, signal) {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

async function runJob(config, job, state, activeChildren, attempt = 1) {
	const [command, args] = commandFor(config, job);
	const suffix = attempt === 1 ? "" : `.attempt${attempt}`;
	const stdoutPath = join(config.logDir, `${job.id}${suffix}.stdout.log`);
	const stderrPath = join(config.logDir, `${job.id}${suffix}.stderr.log`);
	const stdoutFd = openSync(stdoutPath, "a");
	const stderrFd = openSync(stderrPath, "a");
	const startedAt = new Date().toISOString();
	state.jobs[job.id] = {
		...(state.jobs[job.id] ?? {}),
		status: "running",
		cwd: job.cwd,
		startedAt,
		stdoutPath,
		stderrPath,
		attempt,
		maxAttempts: job.retries + 1,
	};
	atomicJson(join(config.logDir, "state.json"), state);
	console.log(`[grok-batch] START ${job.id} cwd=${job.cwd}`);

	return await new Promise((resolveJob) => {
		const child = spawn(command, args, {
			cwd: job.cwd,
			env: process.env,
			stdio: ["ignore", stdoutFd, stderrFd],
			detached: process.platform !== "win32",
		});
		let settled = false;
		let timedOut = false;
		let forceKillTimer;
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			console.error(
				`[grok-batch] TIMEOUT ${job.id} after ${job.timeoutMinutes} minute(s); terminating process tree`,
			);
			killChildTree(child, "SIGTERM");
			forceKillTimer = setTimeout(() => killChildTree(child, "SIGKILL"), 5_000);
			forceKillTimer.unref();
		}, job.timeoutMinutes * 60_000);
		timeoutTimer.unref();
		const settle = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			activeChildren.delete(child);
			closeSync(stdoutFd);
			closeSync(stderrFd);
			resolveJob(value);
		};
		activeChildren.add(child);
		state.jobs[job.id].pid = child.pid;
		atomicJson(join(config.logDir, "state.json"), state);

		child.on("error", (error) => {
			const endedAt = new Date().toISOString();
			state.jobs[job.id] = {
				...state.jobs[job.id],
				status: "spawn-failed",
				endedAt,
				error: error.message,
			};
			atomicJson(join(config.logDir, "state.json"), state);
			console.log(`[grok-batch] SPAWN-FAILED ${job.id}: ${error.message}`);
			settle({ id: job.id, ok: false, exitCode: null, error: error.message });
		});

		child.on("exit", (code, signal) => {
			if (settled) return;
			const endedAt = new Date().toISOString();
			let grokResult;
			let protocolError;
			if (code === 0) {
				try {
					grokResult = readGrokResult(stdoutPath, job);
				} catch (error) {
					protocolError = error instanceof Error ? error.message : String(error);
				}
			}
			const ok = code === 0 && grokResult !== undefined;
			state.jobs[job.id] = {
				...state.jobs[job.id],
				status: ok ? grokResult.resultStatus : "failed",
				transportStatus: timedOut
					? "timed-out"
					: code === 0
						? protocolError
							? "protocol-failed"
							: "completed"
						: "failed",
				endedAt,
				exitCode: code,
				signal,
				timedOut,
				...(grokResult ?? {}),
				...(protocolError ? { protocolError } : {}),
			};
			atomicJson(join(config.logDir, "state.json"), state);
			console.log(
				`[grok-batch] ${ok ? grokResult.resultStatus.toUpperCase() : "FAILED"} ${job.id} exit=${code ?? "null"} signal=${signal ?? "none"}`,
			);
			settle({
				id: job.id,
				ok,
				exitCode: code,
				signal,
				...(grokResult
					? {
							resultStatus: grokResult.resultStatus,
							costUSD: grokResult.costUSD,
							turns: grokResult.turns,
						}
					: {}),
				...(protocolError ? { error: protocolError, protocolFailed: true } : {}),
			});
		});
	});
}

async function runPool(config) {
	mkdirSync(config.logDir, { recursive: true });
	const state = {
		name: config.name,
		startedAt: new Date().toISOString(),
		concurrency: config.concurrency,
		jobs: {},
	};
	atomicJson(join(config.logDir, "state.json"), state);
	const activeChildren = new Set();
	const stop = (signal) => {
		console.error(`[grok-batch] received ${signal}; terminating ${activeChildren.size} child process(es)`);
		for (const child of activeChildren) killChildTree(child, "SIGTERM");
	};
	process.once("SIGINT", () => stop("SIGINT"));
	process.once("SIGTERM", () => stop("SIGTERM"));

	const queue = [...config.jobs];
	const results = [];
	const worker = async () => {
		for (;;) {
			const job = queue.shift();
			if (!job) return;
			let result;
			for (let attempt = 1; attempt <= job.retries + 1; attempt += 1) {
				result = await runJob(config, job, state, activeChildren, attempt);
				// Only a transport/protocol slip is retryable: grok exited cleanly but
				// produced no structured verdict, so no verdict was ever recorded and
				// re-running cannot overwrite a real result.
				if (result.ok || !result.protocolFailed) break;
				if (attempt < job.retries + 1) {
					console.error(
						`[grok-batch] RETRY ${job.id} attempt ${attempt + 1}/${job.retries + 1} after protocol failure: ${result.error}`,
					);
				}
			}
			results.push(result);
		}
	};
	const stagger = async (index) => {
		if (config.staggerMs > 0 && index > 0) {
			await new Promise((r) => setTimeout(r, config.staggerMs * index));
		}
		return await worker();
	};
	await Promise.all(
		Array.from({ length: Math.min(config.concurrency, config.jobs.length) }, (_, i) => stagger(i)),
	);
	state.endedAt = new Date().toISOString();
	const transportPassed = results.every((result) => result.ok);
	const allCompleted = results.every((result) => result.resultStatus === "completed");
	state.status = !transportPassed ? "failed" : allCompleted ? "completed" : "needs-attention";
	state.totalCostUSD = results.reduce((sum, result) => sum + (result.costUSD ?? 0), 0);
	state.totalTurns = results.reduce((sum, result) => sum + (result.turns ?? 0), 0);
	state.results = results;
	atomicJson(join(config.logDir, "state.json"), state);
	console.log(`[grok-batch] FINISH status=${state.status} logs=${config.logDir}`);
	process.exitCode = state.status === "failed" ? 1 : 0;
}

const manifestArg = process.argv[2];
if (!manifestArg || manifestArg.startsWith("-")) usage();
const manifestPath = resolve(manifestArg);
const manifest = readManifest(manifestPath);
const config = validate(manifest, manifestPath);
if (process.argv.includes("--dry-run")) {
	console.log(
		JSON.stringify(
			{
				name: config.name,
				concurrency: config.concurrency,
				logDir: config.logDir,
				jobs: config.jobs.map((job) => ({
						id: job.id,
						cwd: job.cwd,
						maxTurns: job.maxTurns,
						timeoutMinutes: job.timeoutMinutes,
					command: commandFor(config, job)[0],
				})),
			},
			null,
			2,
		),
	);
} else {
	await runPool(config);
}
