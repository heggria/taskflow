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

import { readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type AgentScope, discoverAgents, readSubagentSettings } from "./agents.ts";
import { executeTaskflow } from "./runtime.ts";
import { cwdBridgeModeFromEnv } from "./cwd-bridge.ts";
import { getFlow, loadRun, saveRun, DEFAULT_KEPT_RUNS, DEFAULT_RUN_AGE_DAYS } from "./store.ts";

interface DetachContext {
	runId: string;
	defName: string;
	args: Record<string, unknown>;
	cwd: string;
	/** Bare specifier of the host adapter's runner module, e.g.
	 *  "pi-taskflow/dist/runner.js". The detached process can't import the host
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
	const parent = dirname(contextPath);
	// Remove only an empty Taskflow temp directory. Recursive deletion here would
	// make this public spawn entry capable of deleting unrelated argv-selected
	// files merely because their parent happened to share the expected prefix.
	if (basename(parent).startsWith("taskflow-detach-")) {
		try { rmdirSync(parent); } catch { /* not empty / already gone */ }
	}
}
if (!ctx) process.exit(1);

const cleanupConfig = { maxKeep: DEFAULT_KEPT_RUNS, maxAgeDays: DEFAULT_RUN_AGE_DAYS };

try {
	const state = loadRun(ctx.cwd, ctx.runId);
	if (!state) {
		console.error(`[detached-runner] Run not found: ${ctx.runId}`);
		process.exit(1);
	}

	// Re-discover agents using the same settings as the host session.
	const settings = readSubagentSettings();
	cleanupConfig.maxKeep = settings.taskflow.maxKeptRuns;
	cleanupConfig.maxAgeDays = settings.taskflow.maxRunAgeDays;
	const scope: AgentScope = state.def.agentScope ?? "user";
	const { agents } = discoverAgents(ctx.cwd, scope, settings.modelRoles, settings.taskflow);

	// The host adapter injects its subagent runner. Core is host-neutral and
	// CANNOT spawn pi/codex itself, so without this every phase would fail with
	// "No subagent runner injected". Resolve the runner via a dynamic import of
	// the module path the host serialized into the context file.
	let runTask: import("./host/runner-types.ts").SubagentRunner["runTask"] | undefined;
	if (ctx.runnerModule) {
		try {
			const runnerMod = await import(ctx.runnerModule);
			const exportName = ctx.runnerFactoryExport ?? ctx.runnerExport ?? "piSubagentRunner";
			const exported = runnerMod[exportName];
			const runner = ctx.runnerFactoryExport && typeof exported === "function"
				? exported(ctx.runnerConfig)
				: exported;
			if (runner && typeof runner.runTask === "function") {
				runTask = runner.runTask;
			} else {
				console.error(`[detached-runner] '${exportName}' on '${ctx.runnerModule}' is not a SubagentRunner (missing runTask)`);
			}
		} catch (e) {
			console.error(`[detached-runner] Failed to load runner module '${ctx.runnerModule}': ${e instanceof Error ? e.message : String(e)}`);
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
	if (ctx.runnerModule && !runTask) {
		state.status = "failed";
		state.phases["__detach__"] = {
			id: "__detach__",
			status: "failed",
			endedAt: Date.now(),
			error: `Runner module failed to load: '${ctx.runnerModule}' (export '${ctx.runnerFactoryExport ?? ctx.runnerExport ?? "piSubagentRunner"}'). See detached-runner stderr for the import error.`,
		};
		saveRun(state, cleanupConfig);
		process.exit(1);
	}

	const result = await executeTaskflow(state, {
		cwd: ctx.cwd,
		cwdBridgeMode: cwdBridgeModeFromEnv(),
		agents,
		globalThinking: settings.globalThinking,
		persist: (s) => saveRun(s, cleanupConfig),
		runTask,
		// No requestApproval — approval phases auto-reject in detached/CI mode
		// (safety: approval gates are never bypassed; the run records the rejection).
		loadFlow: (name: string) => getFlow(ctx.cwd, name)?.def,
	});

	saveRun(result.state, cleanupConfig);
} catch (e) {
	// Top-level catch: persist failure so the host can poll the terminal state.
	const message = e instanceof Error ? e.message : String(e);
	console.error(`[detached-runner] Fatal: ${message}`);
	try {
		const state = loadRun(ctx.cwd, ctx.runId);
		if (state && state.status === "running") {
			state.status = "failed";
			saveRun(state, cleanupConfig);
		}
	} catch {
		// Best-effort — if we can't even load the state, there's nothing to persist.
	}
	process.exit(1);
}
