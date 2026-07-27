/**
 * D18/D21 bridge: MCP taskflow_run routing into the singleton ControlHost writer.
 *
 * **Default (GA path):** ControlHost is the admit surface when control plane is
 * enabled. When a live taskflowd writer is reachable over UDS, mutations go
 * through ControlClient (same ControlStore lifecycle as CLI attach). Otherwise
 * this process admits as the local auto-mode writer.
 *
 * Admit over UDS carries absolute `projectRoot` so an empty-mount taskflowd can
 * mount the project on demand under its allowlist (still one writer; no second
 * ledger). On-demand mount policy lives in taskflowd (default deny).
 *
 * **Dual-writer guard (production ingress):** this route never uses
 * `controlMode: "standalone"` + `skipSingleton: true`. When a taskflowd writer
 * is reachable over UDS, admit goes through ControlClient only. When the user
 * singleton is held but UDS is unavailable, local `controlMode: "auto"` attaches
 * read-only and fail-closes (no second mutator). Closing the raw
 * `createControlHost({ standalone, skipSingleton })` API hole requires a
 * control-host change outside this file.
 *
 * **Open blocker — agent/gate over UDS host LLM bridge:** attach peers pass only
 * the program wire to the daemon writer. A local `llmProvider` (host
 * SubagentRunner) is **not** portable over UDS and is intentionally never sent.
 * Daemon-side agent and gate phases therefore fail closed until a host-LLM
 * bridge exists. Script phases are the supported single-ingress path over UDS
 * today. Do not fake a bridge or claim one-ledger agent parity for attach MCP.
 *
 * Opt-out: TASKFLOW_CONTROL_PLANE=0|false|off|no forces fall-through to the 0.2
 * engine (tests / emergency only). Production must not rely on silent fallback
 * or invent a second ledger under `.pi`.
 */
import * as path from "node:path";
import { createControlHost, type AdmitResult } from "./control-host.ts";
import { controlClientRpc, probeControlEndpoint } from "./control-client.ts";
import { createScriptExecutionProvider } from "./script-provider.ts";
import type { ExecutionProvider } from "./provider.ts";

export type ControlPlaneRouteResult =
	| {
			handled: true;
			ok: boolean;
			text: string;
			runId?: string;
			receiptId?: string | null;
			status?: string;
			/** True when ControlHost / ControlClient handled the admit (not 0.2 engine). */
			viaControlHost: true;
			/** How the singleton writer was reached. */
			via: "local-host" | "uds-client";
	  }
	| { handled: false; reason: string };

/**
 * Control plane is ON by default.
 * Explicit disable: TASKFLOW_CONTROL_PLANE=0|false|off|no
 */
export function controlPlaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.TASKFLOW_CONTROL_PLANE ?? "").toLowerCase();
	if (v === "0" || v === "false" || v === "off" || v === "no") return false;
	// Default ON (empty / unset / 1 / true / yes)
	return true;
}

function formatAdmitResult(
	result: AdmitResult,
	via: "local-host" | "uds-client",
): Extract<ControlPlaneRouteResult, { handled: true }> {
	if (result.ok && result.receipt) {
		return {
			handled: true,
			viaControlHost: true,
			via,
			ok: true,
			text: [
				"✓ control-plane run completed",
				`run ${result.run?.runId ?? "?"}`,
				`receipt ${result.receipt.receiptId}`,
				`assurance.providerOutcome=${result.receipt.assurance.providerOutcome}`,
				`assurance.artifactIntegrity=${result.receipt.assurance.artifactIntegrity}`,
				`via ${via}`,
				"",
				result.run?.finalOutput ?? "",
			].join("\n"),
			runId: result.run?.runId,
			receiptId: result.receipt.receiptId,
			status: result.run?.status,
		};
	}
	return {
		handled: true,
		viaControlHost: true,
		via,
		ok: false,
		text: [
			"✗ control-plane run failed",
			`run ${result.run?.runId ?? "?"}`,
			`status ${result.run?.status ?? "?"} stage ${result.run?.stage ?? "?"}`,
			result.run?.error ?? result.error?.message ?? "unknown error",
			result.receipt ? `receipt ${result.receipt.receiptId}` : "no receipt",
			`via ${via}`,
		].join("\n"),
		runId: result.run?.runId,
		receiptId: result.receipt?.receiptId ?? null,
		status: result.run?.status,
	};
}

function failClosed(
	message: string,
	via: "local-host" | "uds-client" = "local-host",
): Extract<ControlPlaneRouteResult, { handled: true }> {
	return {
		handled: true,
		viaControlHost: true,
		via,
		ok: false,
		text: [
			"✗ control-plane unavailable (no legacy fallthrough)",
			message,
			"Set TASKFLOW_CONTROL_PLANE=0|false|off|no only for emergency 0.2 fallthrough.",
		].join("\n"),
	};
}

/**
 * Attempt to run a program on the singleton ControlHost writer.
 * Returns handled:false only when control plane is explicitly disabled.
 *
 * When taskflowd UDS is up, admit is always routed there with absolute
 * projectRoot (on-demand mount). Local `llmProvider` is never sent over UDS.
 */
export async function tryControlPlaneRun(
	cwd: string,
	program: unknown,
	opts?: {
		commandId?: string;
		principal?: string;
		/** Force attempt even if TASKFLOW_CONTROL_PLANE=0 (tests). */
		force?: boolean;
		env?: NodeJS.ProcessEnv;
		/**
		 * Host LLM provider for agent phases (from SubagentRunner).
		 * **Local writer only** — never serialized over UDS (agent/gate stay
		 * fail-closed on the daemon until a portable host-LLM bridge exists).
		 */
		llmProvider?: ExecutionProvider;
	},
): Promise<ControlPlaneRouteResult> {
	const env = opts?.env ?? process.env;
	if (!opts?.force && !controlPlaneEnabled(env)) {
		return { handled: false, reason: "TASKFLOW_CONTROL_PLANE disabled" };
	}

	const principal = opts?.principal ?? "mcp";
	const absoluteRoot = path.resolve(cwd);
	const scriptProvider = createScriptExecutionProvider({
		stateDir: `${absoluteRoot}/.taskflow/control/provider-jobs`,
	});

	// Prefer a live taskflowd writer when reachable — single-ingress ledger.
	// Do not open a local ControlStore first: attach is read-only and cannot
	// mint a new project header for empty-mount on-demand.
	if (process.platform !== "win32") {
		const hello = await probeControlEndpoint({
			env,
			principal,
			timeoutMs: 1_500,
		});
		if (hello && hello.role === "writer") {
			try {
				// Absolute projectRoot enables empty-mount daemon on-demand bootstrap.
				// llmProvider is intentionally NOT sent — agent/gate-over-UDS remain fail-closed.
				const raw = (await controlClientRpc(
					"admit",
					{
						program,
						commandId: opts?.commandId,
						principal,
						projectRoot: absoluteRoot,
					},
					{ env, principal },
				)) as AdmitResult;
				return formatAdmitResult(raw, "uds-client");
			} catch (e) {
				const err = e as Error & { code?: string };
				return failClosed(
					`error: ${err.code ? `${err.code}: ` : ""}${err.message}`,
					"uds-client",
				);
			}
		}
	}

	// No reachable writer UDS: admit as local auto-mode writer (or fail closed
	// if we only attached and transport is missing).
	let host: ReturnType<typeof createControlHost>;
	try {
		host = createControlHost({
			projectRoot: absoluteRoot,
			controlMode: "auto",
			env,
			scriptProvider,
			// Local writer may use injected llmProvider; attach UDS cannot (see file header).
			llmProvider: opts?.llmProvider,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return failClosed(`error: ${msg}`);
	}

	try {
		if (host.singleton?.role === "attach") {
			return failClosed(
				"error: TF_BOOTSTRAP_FAILED: singleton attach but taskflowd UDS unavailable; start taskflowd (no standalone skipSingleton authority)",
				"uds-client",
			);
		}
		const result = await host.admitAndRun({
			program,
			commandId: opts?.commandId,
			callerPrincipal: principal,
		});
		return formatAdmitResult(result, "local-host");
	} finally {
		// close() releases the local writer singleton when held so a long-lived
		// MCP process does not strand a non-UDS writer.
		host.close();
	}
}
