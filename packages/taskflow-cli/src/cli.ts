/**
 * Thin taskflow CLI against ControlHost (admit / status / cancel / resume-ish).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	bootstrapControl,
	type ControlMode,
	DEFAULT_CONTROL_MODE,
} from "taskflow-control";

export interface CliResult {
	ok: boolean;
	exitCode: number;
	json: unknown;
}

export async function runCli(
	argv: string[],
	opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CliResult> {
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();
	const [cmd, ...rest] = argv;

	if (!cmd || cmd === "help" || cmd === "--help") {
		return {
			ok: true,
			exitCode: 0,
			json: {
				usage: "taskflow <run|status|wait|cancel|version> [options]",
				controlMode: DEFAULT_CONTROL_MODE,
			},
		};
	}

	if (cmd === "version") {
		return { ok: true, exitCode: 0, json: { version: "0.3.0", package: "taskflow-cli" } };
	}

	const flags = parseFlags(rest);
	const projectRoot = path.resolve(String(flags.cwd ?? cwd));
	const controlMode = (flags.controlMode as ControlMode | undefined) ?? DEFAULT_CONTROL_MODE;

	const { host } = bootstrapControl({
		projectRoot,
		controlMode,
		env,
	});

	try {
		if (cmd === "run") {
			const define = flags.define
				? JSON.parse(String(flags.define))
				: flags.file
					? JSON.parse(fs.readFileSync(String(flags.file), "utf-8"))
					: {
							name: "cli-run",
							phases: [{ id: "main", type: "script", run: "true", final: true }],
						};
			const result = await host.admitAndRun({
				program: define,
				commandId: flags.commandId ? String(flags.commandId) : undefined,
				callerPrincipal: String(flags.principal ?? "cli"),
			});
			return {
				ok: result.ok,
				exitCode: result.ok ? 0 : 1,
				json: {
					ok: result.ok,
					run: result.run,
					receipt: result.receipt,
					error: result.error,
					snapshot: result.snapshot,
					projectId: host.projectId,
					controlDomainId: host.controlDomainId,
				},
			};
		}

		if (cmd === "status" || cmd === "wait") {
			const runId = String(flags.runId ?? rest.find((a) => !a.startsWith("--")) ?? "");
			if (!runId) {
				return {
					ok: false,
					exitCode: 2,
					json: { error: { code: "TF_INVALID_ARGUMENT", message: "runId required" } },
				};
			}
			const snap = cmd === "wait" ? await host.wait(runId) : host.getSnapshot(runId);
			if (!snap) {
				return {
					ok: false,
					exitCode: 1,
					json: { error: { code: "TF_NOT_FOUND", message: "run not found" } },
				};
			}
			return {
				ok: true,
				exitCode: 0,
				json: {
					// Normal snapshot; TF_RECONCILE_REQUIRED is in controlError, not transport fail
					run: snap.run,
					receipt: snap.receipt,
					controlError: snap.controlError,
				},
			};
		}

		if (cmd === "cancel") {
			const runId = String(flags.runId ?? "");
			const result = await host.cancel(runId);
			return {
				ok: result.ok,
				exitCode: result.ok ? 0 : 1,
				json: result,
			};
		}

		return {
			ok: false,
			exitCode: 2,
			json: { error: { code: "TF_INVALID_ARGUMENT", message: `unknown command ${cmd}` } },
		};
	} finally {
		host.close();
	}
}

function parseFlags(args: string[]): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = args[i + 1];
			if (next && !next.startsWith("--")) {
				out[key] = next;
				i++;
			} else {
				out[key] = true;
			}
		}
	}
	return out;
}
