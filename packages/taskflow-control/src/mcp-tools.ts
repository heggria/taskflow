/**
 * Thin MCP bind helpers for 0.3 ControlHost (stable tool names preserved).
 * Host delivery packages may route taskflow_run through ControlHost when
 * controlMode is enabled — free of host SDKs.
 */
import type { AdmitResult, ControlHost, RunSnapshot } from "./control-host.ts";

export interface ControlToolHandlers {
	run: (args: {
		define?: unknown;
		commandId?: string;
		principal?: string;
	}) => Promise<AdmitResult>;
	status: (runId: string) => RunSnapshot | null;
	wait: (runId: string) => Promise<RunSnapshot>;
	cancel: (runId: string) => Promise<AdmitResult>;
}

/** Bind stable MCP-facing handlers to a ControlHost instance. */
export function bindControlHostTools(host: ControlHost): ControlToolHandlers {
	return {
		async run(args) {
			return host.admitAndRun({
				program: args.define ?? {
					name: "mcp-run",
					phases: [{ id: "main", type: "script", run: "true", final: true }],
				},
				commandId: args.commandId,
				callerPrincipal: args.principal ?? "mcp",
			});
		},
		status(runId) {
			return host.getSnapshot(runId);
		},
		wait(runId) {
			return host.wait(runId);
		},
		cancel(runId) {
			return host.cancel(runId);
		},
	};
}
