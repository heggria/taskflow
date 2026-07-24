/**
 * Thin taskflow CLI against ControlHost (admit / status / cancel / resume-ish).
 * When another writer owns the singleton, mutations go through ControlClient UDS
 * (mandate 4) — not a local attach-only host that would fail closed mutely.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	bootstrapControl,
	controlClientRpc,
	probeControlEndpoint,
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
				usage: "taskflow <ui|run|status|wait|cancel|version> [options]",
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
	const principal = String(flags.principal ?? "cli");

	const boot = bootstrapControl({
		projectRoot,
		controlMode,
		env,
	});
	const { host, role } = boot;

	// Attach role: prefer UDS ControlClient for mutations (daemon is writer).
	const useUdsClient =
		role === "attach" &&
		controlMode !== "standalone" &&
		process.platform !== "win32";

	try {
		if (useUdsClient) {
			const hello = await probeControlEndpoint({ env, principal, timeoutMs: 3_000 });
			if (!hello) {
				return {
					ok: false,
					exitCode: 1,
					json: {
						error: {
							code: "TF_BOOTSTRAP_FAILED",
							message:
								"attach role: taskflowd UDS unavailable; start taskflowd or use --controlMode standalone",
						},
						role,
						via: "uds-client-unavailable",
					},
				};
			}
			return await runViaUds(cmd, flags, rest, {
				env,
				principal,
				projectId: host.projectId,
			});
		}

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
				callerPrincipal: principal,
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
					via: "local-host",
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
					via: "local-host",
				},
			};
		}

		if (cmd === "cancel") {
			const runId = String(flags.runId ?? "");
			const result = await host.cancel(runId);
			return {
				ok: result.ok,
				exitCode: result.ok ? 0 : 1,
				json: { ...result, via: "local-host" },
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

async function runViaUds(
	cmd: string,
	flags: Record<string, string | boolean>,
	rest: string[],
	ctx: { env: NodeJS.ProcessEnv; principal: string; projectId: string },
): Promise<CliResult> {
	const clientOpts = { env: ctx.env, principal: ctx.principal };
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
			const result = (await controlClientRpc(
				"admit",
				{
					program: define,
					commandId: flags.commandId ? String(flags.commandId) : undefined,
					principal: ctx.principal,
					projectId: ctx.projectId,
				},
				clientOpts,
			)) as { ok?: boolean; run?: unknown; receipt?: unknown; error?: unknown };
			return {
				ok: result.ok === true,
				exitCode: result.ok ? 0 : 1,
				json: { ...result, via: "uds-client", projectId: ctx.projectId },
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
			const snap = await controlClientRpc(
				cmd,
				{ runId, projectId: ctx.projectId, principal: ctx.principal },
				clientOpts,
			);
			return {
				ok: true,
				exitCode: 0,
				json: { ...(snap as object), via: "uds-client" },
			};
		}
		if (cmd === "cancel") {
			const runId = String(flags.runId ?? "");
			const result = await controlClientRpc(
				"cancel",
				{ runId, projectId: ctx.projectId, principal: ctx.principal },
				clientOpts,
			);
			const ok = (result as { ok?: boolean }).ok === true;
			return {
				ok,
				exitCode: ok ? 0 : 1,
				json: { ...(result as object), via: "uds-client" },
			};
		}
		return {
			ok: false,
			exitCode: 2,
			json: { error: { code: "TF_INVALID_ARGUMENT", message: `unknown command ${cmd}` } },
		};
	} catch (e) {
		const err = e as Error & { code?: string };
		return {
			ok: false,
			exitCode: 1,
			json: {
				error: {
					code: err.code ?? "TF_COMMAND_FAILED",
					message: err.message,
				},
				via: "uds-client",
			},
		};
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
