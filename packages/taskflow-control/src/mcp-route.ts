/**
 * D21 bridge: MCP taskflow_run routing into ControlHost.
 *
 * **Default (GA path):** ControlHost is the admit surface for all programs when
 * control plane is enabled. Script phases use ScriptExecutionProvider; agent
 * phases use an optional host LLM ExecutionProvider (injected by MCP host).
 *
 * Opt-out: TASKFLOW_CONTROL_PLANE=0|false|off|no forces fall-through to the 0.2
 * engine (tests / emergency only). Production must not rely on silent fallback.
 */
import { createControlHost } from "./control-host.ts";
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
			/** True when ControlHost handled the admit (not 0.2 engine). */
			viaControlHost: true;
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

/**
 * Attempt to run a program on ControlHost (per-phase schedule).
 * Returns handled:false only when control plane is explicitly disabled.
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
		/** Host LLM provider for agent phases (from SubagentRunner). */
		llmProvider?: ExecutionProvider;
	},
): Promise<ControlPlaneRouteResult> {
	const env = opts?.env ?? process.env;
	if (!opts?.force && !controlPlaneEnabled(env)) {
		return { handled: false, reason: "TASKFLOW_CONTROL_PLANE disabled" };
	}

	const host = createControlHost({
		projectRoot: cwd,
		env,
		controlMode: "standalone",
		skipSingleton: true,
		scriptProvider: createScriptExecutionProvider({
			stateDir: `${cwd}/.taskflow/control/provider-jobs`,
		}),
		llmProvider: opts?.llmProvider,
	});
	try {
		const result = await host.admitAndRun({
			program,
			commandId: opts?.commandId,
			callerPrincipal: opts?.principal ?? "mcp",
		});
		if (result.ok && result.receipt) {
			return {
				handled: true,
				viaControlHost: true,
				ok: true,
				text: [
					"✓ control-plane run completed",
					`run ${result.run?.runId ?? "?"}`,
					`receipt ${result.receipt.receiptId}`,
					`assurance.providerOutcome=${result.receipt.assurance.providerOutcome}`,
					`assurance.artifactIntegrity=${result.receipt.assurance.artifactIntegrity}`,
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
			ok: false,
			text: [
				"✗ control-plane run failed",
				`run ${result.run?.runId ?? "?"}`,
				`status ${result.run?.status ?? "?"} stage ${result.run?.stage ?? "?"}`,
				result.run?.error ?? result.error?.message ?? "unknown error",
				result.receipt ? `receipt ${result.receipt.receiptId}` : "no receipt",
			].join("\n"),
			runId: result.run?.runId,
			receiptId: result.receipt?.receiptId ?? null,
			status: result.run?.status,
		};
	} finally {
		host.close();
	}
}
