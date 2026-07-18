/**
 * Detached runner — spawned as a child process for background (detached) runs.
 *
 * Reads a context JSON file (path passed as argv[2]), calls executeTaskflow,
 * and persists the terminal state.  Top-level try/catch writes status "failed"
 * on crash.  Approval phases auto-reject in detached mode (no interactive
 * approver available).
 *
 * This file is NOT imported by index.ts — it is spawned via `child_process.spawn`.
 */

import { existsSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type AgentConfig, type AgentScope, discoverAgents, readSubagentSettings } from "./agents.ts";
import { executeTaskflow } from "./runtime.ts";
import { cwdBridgeModeFromEnv } from "./cwd-bridge.ts";
import {
	bumpReuseInSidecar,
	getFlow,
	loadRun,
	runsDir,
	saveRun,
	traceFilePath,
	DEFAULT_KEPT_RUNS,
	DEFAULT_RUN_AGE_DAYS,
} from "./store.ts";
import {
	clearDetachedCancelRequest,
	clearDetachedProcessRegistry,
	DETACHED_CONTROL_CWD_ENV,
	DETACHED_CONTROL_INSTANCE_ENV,
	DETACHED_CONTROL_OWNER_PID_ENV,
	DETACHED_CONTROL_RUN_ID_ENV,
	DETACHED_CONTROL_SIGNAL_READY_ENV,
	heartbeatDetachedProcessRegistry,
	terminateDetachedProcessTrees,
	watchDetachedCancel,
} from "./detached-control.ts";
import { FileTraceSink } from "./trace.ts";
import type { RuntimeDeps } from "./runtime.ts";
import type { SubagentRunner } from "./host/runner-types.ts";

interface DetachContext {
	runId: string;
	defName: string;
	args: Record<string, unknown>;
	cwd: string;
	/** Resolved URL/path of the host adapter's runner module. The detached process can't import the host
	 *  adapter statically (core is host-neutral), so the host tells it where to
	 *  find a `runTask`. Resolved via dynamic import at run time. */
	runnerModule?: string;
	/** Named export on runnerModule exposing a `SubagentRunner.runTask`
	 *  (defaults to "piSubagentRunner"). */
	runnerExport?: string;
	/** Preferred host-only factory path. The opaque config is normalized by the
	 * host adapter; core never interprets or expands its authority. */
	runnerFactoryExport?: string;
	runnerConfig?: unknown;
	/** Wait for the parent to persist pid/launch metadata before execution. */
	waitForStart?: boolean;
	/** Match foreground taskflow_run incremental cache defaults. */
	incremental?: boolean;
	/** Saved flow selected through search; bump reuse only after success. */
	reusedSavedName?: string;
	/** Parent-resolved execution context. Freezing this at dispatch keeps mode
	 * background semantically identical to the foreground invocation. */
	agents?: AgentConfig[];
	globalThinking?: string;
	agentScope?: AgentScope;
	maxKeptRuns?: number;
	maxRunAgeDays?: number;
	detachedInstanceId?: string;
}

const START_GATE_TIMEOUT_MS = 5_000;

async function waitForStartGate(contextDir: string): Promise<boolean> {
	const startPath = join(contextDir, "start");
	const deadline = Date.now() + START_GATE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (existsSync(startPath)) {
			try { unlinkSync(startPath); } catch { /* consumed concurrently */ }
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

function cleanupContextDir(contextPath: string): void {
	const parent = dirname(contextPath);
	if (basename(parent).startsWith("taskflow-detach-")) {
		try { rmdirSync(parent); } catch { /* not empty / already gone */ }
	}
}

const contextPath = process.argv[2];
if (!contextPath) {
	console.error("[detached-runner] Missing context file path argument");
	process.exit(1);
}

let ctx: DetachContext | undefined;
try {
	ctx = JSON.parse(readFileSync(contextPath, "utf-8")) as DetachContext;
} catch (e) {
	console.error(`[detached-runner] Failed to read context: ${e instanceof Error ? e.message : String(e)}`);
} finally {
	// Context can contain host-authorized extension paths. Consume it once even
	// when reading/parsing fails, so a corrupt detached launch cannot leave a
	// private authorization snapshot behind indefinitely.
	try { unlinkSync(contextPath); } catch { /* best-effort one-shot file cleanup */ }
}
if (!ctx) {
	cleanupContextDir(contextPath);
	process.exit(1);
}

const cleanupConfig = { maxKeep: DEFAULT_KEPT_RUNS, maxAgeDays: DEFAULT_RUN_AGE_DAYS };

if (ctx.waitForStart && !(await waitForStartGate(dirname(contextPath)))) {
	try {
		const state = loadRun(ctx.cwd, ctx.runId);
		if (state?.status === "running") {
			state.status = "failed";
			state.phases["__detach__"] = {
				id: "__detach__",
				status: "failed",
				endedAt: Date.now(),
				error: `Detached launch gate was not released within ${START_GATE_TIMEOUT_MS}ms.`,
			};
			saveRun(state, cleanupConfig);
		}
	} catch { /* best-effort terminalization */ }
	cleanupContextDir(contextPath);
	process.exit(1);
}
cleanupContextDir(contextPath);

try {
	const state = loadRun(ctx.cwd, ctx.runId);
	if (!state) {
		console.error(`[detached-runner] Run not found: ${ctx.runId}`);
		process.exit(1);
	}

	process.env.TASKFLOW_DETACHED_RUNNER = "1";
	let heartbeatTimer: NodeJS.Timeout | undefined;
	if (ctx.detachedInstanceId) {
		process.env[DETACHED_CONTROL_CWD_ENV] = ctx.cwd;
		process.env[DETACHED_CONTROL_RUN_ID_ENV] = ctx.runId;
		process.env[DETACHED_CONTROL_INSTANCE_ENV] = ctx.detachedInstanceId;
		process.env[DETACHED_CONTROL_OWNER_PID_ENV] = String(process.pid);
		heartbeatDetachedProcessRegistry(ctx.cwd, ctx.runId, ctx.detachedInstanceId);
		heartbeatTimer = setInterval(() => {
			try { heartbeatDetachedProcessRegistry(ctx.cwd, ctx.runId, ctx.detachedInstanceId!); } catch { /* best-effort lease */ }
		}, 1_000);
		heartbeatTimer.unref();
	}

	// Prefer the execution context frozen by the parent. Legacy callers without
	// a snapshot retain the old discovery fallback.
	const settings = readSubagentSettings();
	cleanupConfig.maxKeep = ctx.maxKeptRuns ?? state.detachedRetention?.maxKeep ?? settings.taskflow.maxKeptRuns;
	cleanupConfig.maxAgeDays = ctx.maxRunAgeDays ?? state.detachedRetention?.maxAgeDays ?? settings.taskflow.maxRunAgeDays;
	const legacyDefaultScope: AgentScope = ctx.runnerFactoryExport ? "user" : "both";
	const scope: AgentScope = ctx.agentScope ?? state.def.agentScope ?? legacyDefaultScope;
	const agents = ctx.agents ?? discoverAgents(ctx.cwd, scope, settings.modelRoles, settings.taskflow).agents;

	// The host adapter injects its subagent runner. Core is host-neutral and
	// CANNOT spawn pi/codex itself, so without this every phase would fail with
	// "No subagent runner injected". Resolve the runner via a dynamic import of
	// the module path the host serialized into the context file.
	let injectedRunner: SubagentRunner | undefined;
	let runnerLoadError: string | undefined;
	if (ctx.runnerModule) {
		try {
			const runnerMod = await import(ctx.runnerModule);
			const exportName = ctx.runnerFactoryExport ?? ctx.runnerExport ?? "piSubagentRunner";
			const exported = runnerMod[exportName];
			const runner = ctx.runnerFactoryExport && typeof exported === "function"
				? exported(ctx.runnerConfig)
				: exported;
			if (runner && typeof runner.runTask === "function") {
				injectedRunner = runner as SubagentRunner;
			} else {
				console.error(`[detached-runner] '${exportName}' on '${ctx.runnerModule}' is not a SubagentRunner (missing runTask)`);
			}
		} catch (e) {
			runnerLoadError = e instanceof Error ? e.message : String(e);
			console.error(`[detached-runner] Failed to load runner module '${ctx.runnerModule}': ${runnerLoadError}`);
		}
	} else {
		console.error("[detached-runner] No runnerModule in context — phases will fail with 'No subagent runner injected'");
	}

	// FAIL FAST when a runner was promised but could not be loaded. Limping on
	// would fail EVERY phase with the generic "No subagent runner injected"
	// stub — burying the real cause (a bad module path, a compile-time specifier
	// bug, a missing export). Exiting non-zero here routes the real stderr
	// message into the host's early-exit crash guard, which persists it on the
	// run's synthetic __detach__ phase where it is pollable and debuggable.
	if (ctx.runnerModule && !injectedRunner) {
		state.status = "failed";
		state.phases["__detach__"] = {
			id: "__detach__",
			status: "failed",
			endedAt: Date.now(),
			error: `Runner module failed to load: '${ctx.runnerModule}' (export '${ctx.runnerFactoryExport ?? ctx.runnerExport ?? "piSubagentRunner"}'): ${runnerLoadError ?? "export is not a SubagentRunner"}`,
		};
		saveRun(state, cleanupConfig);
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (ctx.detachedInstanceId) clearDetachedProcessRegistry(ctx.cwd, ctx.runId, ctx.detachedInstanceId);
		process.exit(1);
	}

	const abortController = new AbortController();
	const stopCancelWatch = watchDetachedCancel(ctx.cwd, ctx.runId, abortController, undefined, (request) => {
		state.detachedCancel = request;
	});
	const abortForSignal = () => abortController.abort({ reason: "detached-process-signal" });
	process.once("SIGTERM", abortForSignal);
	process.once("SIGINT", abortForSignal);
	process.once("SIGHUP", abortForSignal);
	process.env[DETACHED_CONTROL_SIGNAL_READY_ENV] = "1";
	const deps: RuntimeDeps = {
		cwd: ctx.cwd,
		cwdBridgeMode: cwdBridgeModeFromEnv(),
		agents,
		globalThinking: ctx.globalThinking ?? settings.globalThinking,
		persist: (s) => saveRun(s, cleanupConfig),
		runTask: injectedRunner?.runTask,
		usageAccounting: injectedRunner?.usageAccounting,
		signal: abortController.signal,
		trace: new FileTraceSink(traceFilePath(runsDir(ctx.cwd), state.flowName, state.runId)),
		// No requestApproval — approval phases auto-reject in detached/CI mode
		// (safety: approval gates are never bypassed; the run records the rejection).
		loadFlow: (name: string) => getFlow(ctx.cwd, name)?.def,
	};
	if (ctx.incremental === true) deps.cacheScopeDefault = "cross-run";
	try {
		const result = await executeTaskflow(state, deps);
		result.state.finalOutput = result.finalOutput;
		result.state.outputSourcePhaseId = result.outputSourcePhaseId;
		saveRun(result.state, cleanupConfig);
		if (result.ok && ctx.reusedSavedName) {
			try { bumpReuseInSidecar(ctx.cwd, ctx.reusedSavedName); } catch { /* best-effort */ }
		}
	} finally {
		stopCancelWatch();
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		clearDetachedCancelRequest(ctx.cwd, ctx.runId);
		if (ctx.detachedInstanceId) clearDetachedProcessRegistry(ctx.cwd, ctx.runId, ctx.detachedInstanceId);
		delete process.env[DETACHED_CONTROL_SIGNAL_READY_ENV];
		process.removeListener("SIGTERM", abortForSignal);
		process.removeListener("SIGINT", abortForSignal);
		process.removeListener("SIGHUP", abortForSignal);
	}
} catch (e) {
	// Top-level catch: persist failure so the host can poll the terminal state.
	const message = e instanceof Error ? e.message : String(e);
	console.error(`[detached-runner] Fatal: ${message}`);
	try {
		const state = loadRun(ctx.cwd, ctx.runId);
		if (state && state.status === "running") {
			state.status = "failed";
			state.phases["__detach__"] = {
				id: "__detach__",
				status: "failed",
				endedAt: Date.now(),
				error: message.slice(0, 2_000),
			};
			saveRun(state, cleanupConfig);
		}
	} catch {
		// Best-effort — if we can't even load the state, there's nothing to persist.
	}
	if (ctx.detachedInstanceId) terminateDetachedProcessTrees(ctx.cwd, ctx.runId, ctx.detachedInstanceId);
	clearDetachedCancelRequest(ctx.cwd, ctx.runId);
	if (ctx.detachedInstanceId) clearDetachedProcessRegistry(ctx.cwd, ctx.runId, ctx.detachedInstanceId);
	process.exit(1);
}
