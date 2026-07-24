import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import {
	bootstrapControl,
	controlClientRpc,
	DEFAULT_CONTROL_MODE,
	probeControlEndpoint,
	projectWebUiSocketPath,
	singletonLockPath,
	type ControlHost,
	type ControlMode,
	WebAssetManifestSchema,
	type WebAssetManifest,
} from "taskflow-control";
import {
	startDaemon,
	startUdsServer,
	startWebGateway,
	type DaemonHandle,
	type DaemonWebUiLaunch,
	type DaemonWebUiStartRequest,
	type WebGatewayHandle,
} from "taskflow-daemon";

export type UiCommandOptions = {
	readonly env?: NodeJS.ProcessEnv;
	readonly cwd?: string;
	readonly openBrowser?: (url: string) => void;
};

export type UiCommandHandle = {
	readonly gateway?: WebGatewayHandle;
	readonly host?: ControlHost;
	readonly daemon?: DaemonHandle;
	readonly keepAlive: boolean;
	readonly result:
		| {
		readonly ok: true;
		readonly action: "launch";
		readonly launchUrl: string;
		readonly origin: string;
		readonly role: "writer" | "attach" | "standalone-local";
		readonly controlMode: ControlMode;
		readonly packageVersion: string;
		readonly browserOpened: boolean;
		readonly reused: boolean;
		readonly via:
			| "local-singleton"
			| "existing-singleton"
			| "standalone";
	}
		| {
				readonly ok: true;
				readonly action: "stop";
				readonly stopped: boolean;
				readonly controlMode: ControlMode;
				readonly via:
					| "existing-singleton"
					| "no-listener"
					| "standalone";
		  };
	readonly stopped: Promise<void>;
	stop(): Promise<void>;
};

function parseFlags(args: readonly string[]): Record<string, string | boolean> {
	const flags: Record<string, string | boolean> = {};
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index]!;
		if (!value.startsWith("--")) continue;
		const name = value.slice(2);
		const next = args[index + 1];
		if (next && !next.startsWith("--")) {
			flags[name] = next;
			index += 1;
		} else {
			flags[name] = true;
		}
	}
	return flags;
}

function packagedWebRoot(env: NodeJS.ProcessEnv): string {
	if (env.TASKFLOW_WEB_ASSETS_ROOT) {
		const explicit = path.resolve(env.TASKFLOW_WEB_ASSETS_ROOT);
		if (!path.isAbsolute(explicit)) {
			throw new TypeError("TASKFLOW_WEB_ASSETS_ROOT must resolve absolutely");
		}
		return explicit;
	}
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const packaged = path.join(moduleDir, "web");
	if (fs.existsSync(path.join(packaged, "taskflow-web-assets.json"))) {
		return packaged;
	}
	const development = path.resolve(
		moduleDir,
		"../../taskflow-web/dist/app",
	);
	if (fs.existsSync(path.join(development, "taskflow-web-assets.json"))) {
		return development;
	}
	throw new TypeError(
		"Taskflow Web assets are missing. Reinstall or rebuild taskflow-cli.",
	);
}

function readManifest(root: string): WebAssetManifest {
	const value = JSON.parse(
		fs.readFileSync(path.join(root, "taskflow-web-assets.json"), "utf8"),
	) as unknown;
	if (!Value.Check(WebAssetManifestSchema, value)) {
		throw new TypeError(
			"Taskflow Web asset manifest is incompatible. Reinstall taskflow-cli.",
		);
	}
	return value as WebAssetManifest;
}

function defaultOpenBrowser(url: string): void {
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "cmd"
				: "xdg-open";
	const args =
		process.platform === "win32"
			? ["/c", "start", "", url]
			: [url];
	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

function webUiStartRequest(
	projectRoot: string,
	port: number,
	webRoot: string,
	manifest: WebAssetManifest,
): DaemonWebUiStartRequest {
	return {
		projectRoot,
		port,
		packageVersion: manifest.packageVersion,
		staticAssetsRoot: webRoot,
		contentKeysetDigests: {
			projected:
				manifest.contentCatalogs
					.projectedKeysetSha256,
			static:
				manifest.contentCatalogs.staticKeysetSha256,
			combined:
				manifest.contentCatalogs.keysetSha256,
		},
	};
}

async function requestExistingSingleton(
	method: "ui-start" | "ui-stop",
	params: Record<string, unknown>,
	env: NodeJS.ProcessEnv,
	socketPath?: string,
): Promise<unknown> {
	return controlClientRpc(method, params, {
		env,
		...(socketPath ? { socketPath } : {}),
		principal: "taskflow-ui",
		timeoutMs: 30_000,
	});
}

function openRequestedBrowser(
	url: string,
	noOpen: boolean,
	options: UiCommandOptions,
): boolean {
	if (noOpen) return false;
	(options.openBrowser ?? defaultOpenBrowser)(url);
	return true;
}

export async function startUiCommand(
	args: readonly string[],
	options: UiCommandOptions = {},
): Promise<UiCommandHandle> {
	const flags = parseFlags(args);
	const env = options.env ?? process.env;
	const cwd = path.resolve(
		String(
			flags.project ??
				flags.cwd ??
				options.cwd ??
				process.cwd(),
		),
	);
	const explicitControlMode =
		flags.controlMode as ControlMode | undefined;
	if (
		flags.standalone === true &&
		explicitControlMode !== undefined &&
		explicitControlMode !== "standalone"
	) {
		throw new TypeError(
			"--standalone conflicts with a non-standalone --controlMode",
		);
	}
	const controlMode =
		flags.standalone === true
			? "standalone"
			: explicitControlMode ?? DEFAULT_CONTROL_MODE;
	if (!["auto", "coordinated", "standalone"].includes(controlMode)) {
		throw new TypeError(`unsupported control mode: ${controlMode}`);
	}
	const parsedPort =
		flags.port === undefined ? 0 : Number.parseInt(String(flags.port), 10);
	if (
		!Number.isSafeInteger(parsedPort) ||
		parsedPort < 0 ||
		parsedPort > 65_535
	) {
		throw new TypeError("ui --port must be an integer from 0 to 65535");
	}
	const stopRequested = flags.stop === true;
	const standaloneSocketPath =
		controlMode === "standalone"
			? projectWebUiSocketPath(cwd, env)
			: undefined;
	if (standaloneSocketPath) {
		const hello = await probeControlEndpoint({
			socketPath: standaloneSocketPath,
			env,
			principal: "taskflow-ui",
			timeoutMs: 3_000,
		});
		if (stopRequested) {
			if (!hello) {
				return {
					keepAlive: false,
					result: {
						ok: true,
						action: "stop",
						stopped: false,
						controlMode,
						via: "no-listener",
					},
					stopped: Promise.resolve(),
					async stop() {},
				};
			}
			const result = (await requestExistingSingleton(
				"ui-stop",
				{},
				env,
				standaloneSocketPath,
			)) as { stopped?: boolean };
			return {
				keepAlive: false,
				result: {
					ok: true,
					action: "stop",
					stopped: result.stopped === true,
					controlMode,
					via: "standalone",
				},
				stopped: Promise.resolve(),
				async stop() {},
			};
		}
		if (hello) {
			const webRoot = packagedWebRoot(env);
			const manifest = readManifest(webRoot);
			const startRequest = webUiStartRequest(
				cwd,
				parsedPort,
				webRoot,
				manifest,
			);
			const launch = (await requestExistingSingleton(
				"ui-start",
				startRequest as unknown as Record<string, unknown>,
				env,
				standaloneSocketPath,
			)) as DaemonWebUiLaunch;
			const noOpen = flags["no-open"] === true;
			const browserOpened = openRequestedBrowser(
				launch.launchUrl,
				noOpen,
				options,
			);
			return {
				keepAlive: false,
				result: {
					ok: true,
					action: "launch",
					launchUrl: launch.launchUrl,
					origin: launch.origin,
					role: "standalone-local",
					controlMode,
					packageVersion: launch.packageVersion,
					browserOpened,
					reused: true,
					via: "standalone",
				},
				stopped: Promise.resolve(),
				stop: async () => {
					await requestExistingSingleton(
						"ui-stop",
						{},
						env,
						standaloneSocketPath,
					);
				},
			};
		}
	}

	if (controlMode !== "standalone") {
		const hello = await probeControlEndpoint({
			env,
			principal: "taskflow-ui",
			timeoutMs: 3_000,
		});
		if (stopRequested) {
			if (!hello) {
				if (fs.existsSync(singletonLockPath(env))) {
					throw Object.assign(
						new Error(
							"TF_BOOTSTRAP_FAILED: singleton exists but its authenticated control endpoint is unavailable; listener shutdown cannot be proven",
						),
						{ code: "TF_BOOTSTRAP_FAILED" },
					);
				}
				return {
					keepAlive: false,
					result: {
						ok: true,
						action: "stop",
						stopped: false,
						controlMode,
						via: "no-listener",
					},
					stopped: Promise.resolve(),
					async stop() {},
				};
			}
			const result = (await requestExistingSingleton(
				"ui-stop",
				{},
				env,
			)) as { stopped?: boolean };
			return {
				keepAlive: false,
				result: {
					ok: true,
					action: "stop",
					stopped: result.stopped === true,
					controlMode,
					via: "existing-singleton",
				},
				stopped: Promise.resolve(),
				async stop() {},
			};
		}

		const webRoot = packagedWebRoot(env);
		const manifest = readManifest(webRoot);
		const startRequest = webUiStartRequest(
			cwd,
			parsedPort,
			webRoot,
			manifest,
		);
		const noOpen = flags["no-open"] === true;
		if (hello) {
			const launch = (await requestExistingSingleton(
				"ui-start",
				startRequest as unknown as Record<string, unknown>,
				env,
			)) as DaemonWebUiLaunch;
			const browserOpened = openRequestedBrowser(
				launch.launchUrl,
				noOpen,
				options,
			);
			return {
				keepAlive: false,
				result: {
					ok: true,
					action: "launch",
					launchUrl: launch.launchUrl,
					origin: launch.origin,
					role: "attach",
					controlMode,
					packageVersion: launch.packageVersion,
					browserOpened,
					reused: launch.reused,
					via: "existing-singleton",
				},
				stopped: Promise.resolve(),
				stop: async () => {
					await requestExistingSingleton(
						"ui-stop",
						{},
						env,
					);
				},
			};
		}
		if (controlMode === "coordinated") {
			throw Object.assign(
				new Error(
					"TF_BOOTSTRAP_FAILED: coordinated mode requires an existing taskflowd singleton",
				),
				{ code: "TF_BOOTSTRAP_FAILED" },
			);
		}

		const daemon = await startDaemon({
			env,
			projectRoots: [cwd],
		});
		if (daemon.role !== "writer") {
			await daemon.stop();
			const racedHello = await probeControlEndpoint({
				env,
				principal: "taskflow-ui",
				timeoutMs: 3_000,
			});
			if (!racedHello) {
				throw Object.assign(
					new Error(
						"TF_BOOTSTRAP_FAILED: singleton writer won the launch race but did not expose its authenticated control endpoint",
					),
					{ code: "TF_BOOTSTRAP_FAILED" },
				);
			}
			const launch = (await requestExistingSingleton(
				"ui-start",
				startRequest as unknown as Record<string, unknown>,
				env,
			)) as DaemonWebUiLaunch;
			const browserOpened = openRequestedBrowser(
				launch.launchUrl,
				noOpen,
				options,
			);
			return {
				keepAlive: false,
				result: {
					ok: true,
					action: "launch",
					launchUrl: launch.launchUrl,
					origin: launch.origin,
					role: "attach",
					controlMode,
					packageVersion: launch.packageVersion,
					browserOpened,
					reused: launch.reused,
					via: "existing-singleton",
				},
				stopped: Promise.resolve(),
				stop: async () => {
					await requestExistingSingleton(
						"ui-stop",
						{},
						env,
					);
				},
			};
		}
		const launch = await daemon.startWebUi(startRequest);
		const browserOpened = openRequestedBrowser(
			launch.launchUrl,
			noOpen,
			options,
		);
		const stopped = daemon
			.waitForWebUiStop()
			.then(() => daemon.stop());
		return {
			daemon,
			keepAlive: true,
			result: {
				ok: true,
				action: "launch",
				launchUrl: launch.launchUrl,
				origin: launch.origin,
				role: "writer",
				controlMode,
				packageVersion: launch.packageVersion,
				browserOpened,
				reused: false,
				via: "local-singleton",
			},
			stopped,
			stop: async () => {
				await daemon.stopWebUi();
				await stopped;
			},
		};
	}

	const webRoot = packagedWebRoot(env);
	const manifest = readManifest(webRoot);
	const boot = bootstrapControl({
		projectRoot: cwd,
		controlMode,
		env,
	});
	let gateway: WebGatewayHandle;
	try {
		gateway = await startWebGateway({
			host: boot.host,
			port: parsedPort,
			packageVersion: manifest.packageVersion,
			contentKeysetDigests: {
				projected: manifest.contentCatalogs.projectedKeysetSha256,
				static: manifest.contentCatalogs.staticKeysetSha256,
				combined: manifest.contentCatalogs.keysetSha256,
			},
			staticAssets: { root: webRoot },
		});
	} catch (error) {
		boot.host.close();
		throw error;
	}
	let uds:
		| Awaited<ReturnType<typeof startUdsServer>>
		| undefined;
	let stoppedResolve: (() => void) | undefined;
	const stopped = new Promise<void>((resolve) => {
		stoppedResolve = resolve;
	});
	let stopping: Promise<void> | undefined;
	let monitor: NodeJS.Timeout | undefined;

	async function stop(): Promise<void> {
		if (stopping) return stopping;
		stopping = (async () => {
			if (monitor) clearInterval(monitor);
			try {
				await gateway.stop();
			} finally {
				try {
					if (uds) await uds.close();
				} finally {
					boot.host.close();
					stoppedResolve?.();
				}
			}
		})();
		return stopping;
	}

	try {
		uds = await startUdsServer({
			socketPath: standaloneSocketPath!,
			fencingEpoch: Date.now(),
			role: "writer",
			webUiOnly: true,
			getHost: (projectId) =>
				projectId === undefined ||
				projectId === boot.host.projectId
					? boot.host
					: null,
			webUi: {
				async start(params) {
					const request =
						params as unknown as DaemonWebUiStartRequest;
					if (
						typeof request.projectRoot !==
							"string" ||
						path.resolve(request.projectRoot) !==
							cwd ||
						request.packageVersion !==
							manifest.packageVersion ||
						request.contentKeysetDigests
							?.projected !==
							manifest.contentCatalogs
								.projectedKeysetSha256 ||
						request.contentKeysetDigests?.static !==
							manifest.contentCatalogs
								.staticKeysetSha256 ||
						request.contentKeysetDigests?.combined !==
							manifest.contentCatalogs
								.keysetSha256 ||
						(request.port !== 0 &&
							request.port !== gateway.port)
					) {
						throw Object.assign(
							new Error(
								"TF_PROTOCOL_INCOMPATIBLE: standalone WebGateway launch does not match the active project, port, or UI/content build",
							),
							{
								code: "TF_PROTOCOL_INCOMPATIBLE",
							},
						);
					}
					const launch = gateway.mintLaunchUrl();
					return {
						ok: true as const,
						launchUrl: launch.launchUrl,
						origin: gateway.origin,
						listenerId: gateway.listenerId,
						port: gateway.port,
						reused: true,
						projectId: boot.host.projectId,
						controlDomainId:
							boot.host.controlDomainId,
						packageVersion:
							manifest.packageVersion,
					} satisfies DaemonWebUiLaunch;
				},
				stop() {
					setImmediate(() => {
						void stop();
					});
					return Promise.resolve({ stopped: true });
				},
				status() {
					return {
						active: gateway.server.listening,
						origin: gateway.origin,
						listenerId: gateway.listenerId,
						port: gateway.port,
						sessions:
							gateway.sessions.activeSessionCount(),
						pendingCapabilityOrSession:
							gateway.sessions.hasLiveCapabilityOrSession(),
					};
				},
			},
		});
	} catch (error) {
		await gateway.stop();
		boot.host.close();
		throw error;
	}

	const noOpen = flags["no-open"] === true;
	const browserOpened = openRequestedBrowser(
		gateway.launchUrl,
		noOpen,
		options,
	);
	monitor = setInterval(() => {
		if (!gateway.sessions.hasLiveCapabilityOrSession()) {
			void stop();
		}
	}, 15_000);
	monitor.unref();

	return {
		gateway,
		host: boot.host,
		keepAlive: true,
		result: {
			ok: true,
			action: "launch",
			launchUrl: gateway.launchUrl,
			origin: gateway.origin,
			role: boot.role,
			controlMode,
			packageVersion: manifest.packageVersion,
			browserOpened,
			reused: false,
			via: "standalone",
		},
		stopped,
		stop,
	};
}
