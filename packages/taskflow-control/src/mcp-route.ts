/**
 * D21 bridge: optional MCP taskflow_run routing into ControlHost.
 * Host MCP servers (all adapters) can call tryControlPlaneRun when
 * TASKFLOW_CONTROL_PLANE=1 (or always for script-only programs when forceScript).
 *
 * Does not replace the 0.2 engine for agent-heavy flows until host LLM providers
 * are bound as ExecutionProviders — script-only flows are the production default path.
 */
import { createControlHost } from "./control-host.ts";
import { createScriptExecutionProvider } from "./script-provider.ts";
import { isScriptOnlyProgram } from "./script-provider.ts";

export type ControlPlaneRouteResult =
	| {
			handled: true;
			ok: boolean;
			text: string;
			runId?: string;
			receiptId?: string | null;
			status?: string;
	  }
	| { handled: false; reason: string };

function controlPlaneEnabled(): boolean {
	const v = process.env.TASKFLOW_CONTROL_PLANE;
	return v === "1" || v === "true" || v === "yes";
}

/**
 * Attempt to run a program on ControlHost (script provider).
 * Returns handled:false when control plane is off or program is not script-only.
 */
export async function tryControlPlaneRun(
	cwd: string,
	program: unknown,
	opts?: {
		commandId?: string;
		principal?: string;
		/** Force attempt even without TASKFLOW_CONTROL_PLANE env (tests). */
		force?: boolean;
		env?: NodeJS.ProcessEnv;
	},
): Promise<ControlPlaneRouteResult> {
	if (!opts?.force && !controlPlaneEnabled()) {
		return { handled: false, reason: "TASKFLOW_CONTROL_PLANE not enabled" };
	}
	if (!isScriptOnlyProgram(program)) {
		return {
			handled: false,
			reason: "program is not script-only; requires host LLM ExecutionProvider",
		};
	}

	const env = opts?.env ?? process.env;
	const host = createControlHost({
		projectRoot: cwd,
		env,
		controlMode: "standalone",
		skipSingleton: true,
		provider: createScriptExecutionProvider({
			stateDir: `${cwd}/.taskflow/control/provider-jobs`,
		}),
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

export { controlPlaneEnabled };
