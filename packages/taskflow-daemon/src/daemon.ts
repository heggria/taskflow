/**
 * taskflowd: acquire singleton, mount registry projects, serve UDS JSON-line RPC.
 * Same singleton lock as embedded supervisors (D32).
 */
import {
	acquireOrAttachSingleton,
	bootstrapControl,
	newId,
	openControlRegistry,
	releaseSingleton,
	udsPath,
	type ControlHost,
	type RegistryEntry,
} from "taskflow-control";
import { startUdsServer, type UdsServerHandle } from "./uds-server.ts";
import {
	startWebGateway,
	type WebGatewayHandle,
} from "./web-gateway.ts";
import * as path from "node:path";

export interface DaemonOptions {
	env?: NodeJS.ProcessEnv;
	/** Pre-mount these project roots. */
	projectRoots?: string[];
	holderId?: string;
	/** When false, skip UDS listen (lock-only tests). Default true on non-win32. */
	listenUds?: boolean;
}

export type DaemonWebUiStartRequest = {
	readonly projectRoot: string;
	readonly port: number;
	readonly packageVersion: string;
	readonly staticAssetsRoot: string;
	readonly contentKeysetDigests: {
		readonly projected: string;
		readonly static: string;
		readonly combined: string;
	};
};

export type DaemonWebUiLaunch = {
	readonly ok: true;
	readonly launchUrl: string;
	readonly origin: string;
	readonly listenerId: string;
	readonly port: number;
	readonly reused: boolean;
	readonly projectId: string;
	readonly controlDomainId: string;
	readonly packageVersion: string;
};

export type DaemonWebUiStatus = {
	readonly active: boolean;
	readonly origin?: string;
	readonly listenerId?: string;
	readonly port?: number;
	readonly sessions?: number;
	readonly pendingCapabilityOrSession?: boolean;
};

export interface DaemonHandle {
	holderId: string;
	role: "writer" | "attach";
	hosts: Map<string, ControlHost>;
	socketPath?: string;
	fencingEpoch: number;
	startWebUi(
		request: DaemonWebUiStartRequest,
	): Promise<DaemonWebUiLaunch>;
	stopWebUi(): Promise<{ readonly stopped: boolean }>;
	webUiStatus(): DaemonWebUiStatus;
	waitForWebUiStop(): Promise<void>;
	stop(): Promise<void> | void;
}

const WEB_UI_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function validateWebUiRequest(
	request: DaemonWebUiStartRequest,
): DaemonWebUiStartRequest {
	if (
		typeof request.projectRoot !== "string" ||
		request.projectRoot.length === 0
	) {
		throw Object.assign(
			new TypeError("TF_INVALID_ARGUMENT: ui projectRoot is required"),
			{ code: "TF_INVALID_ARGUMENT" },
		);
	}
	if (
		!Number.isSafeInteger(request.port) ||
		request.port < 0 ||
		request.port > 65_535
	) {
		throw Object.assign(
			new TypeError(
				"TF_INVALID_ARGUMENT: ui port must be an integer from 0 to 65535",
			),
			{ code: "TF_INVALID_ARGUMENT" },
		);
	}
	if (
		typeof request.packageVersion !== "string" ||
		request.packageVersion.length === 0 ||
		request.packageVersion.length > 128
	) {
		throw Object.assign(
			new TypeError(
				"TF_INVALID_ARGUMENT: ui packageVersion is invalid",
			),
			{ code: "TF_INVALID_ARGUMENT" },
		);
	}
	if (
		typeof request.staticAssetsRoot !== "string" ||
		!path.isAbsolute(request.staticAssetsRoot)
	) {
		throw Object.assign(
			new TypeError(
				"TF_INVALID_ARGUMENT: ui staticAssetsRoot must be absolute",
			),
			{ code: "TF_INVALID_ARGUMENT" },
		);
	}
	if (
		!WEB_UI_DIGEST_RE.test(
			request.contentKeysetDigests.projected,
		) ||
		!WEB_UI_DIGEST_RE.test(
			request.contentKeysetDigests.static,
		) ||
		!WEB_UI_DIGEST_RE.test(
			request.contentKeysetDigests.combined,
		)
	) {
		throw Object.assign(
			new TypeError(
				"TF_INVALID_ARGUMENT: ui content keyset digest is invalid",
			),
			{ code: "TF_INVALID_ARGUMENT" },
		);
	}
	return {
		...request,
		projectRoot: path.resolve(request.projectRoot),
		staticAssetsRoot: path.resolve(request.staticAssetsRoot),
	};
}

function webUiCompatibilityKey(
	request: DaemonWebUiStartRequest,
): string {
	return JSON.stringify({
		packageVersion: request.packageVersion,
		contentKeysetDigests: request.contentKeysetDigests,
	});
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
	const env = opts.env ?? process.env;
	const holderId = opts.holderId ?? newId("daemon");
	const singleton = acquireOrAttachSingleton(holderId, env);

	const hosts = new Map<string, ControlHost>();
	const hostReadiness = new Map<string, Promise<void>>();
	const roots = opts.projectRoots ?? [];

	const registry = openControlRegistry(env);
	const mountRoots = new Set(roots);
	const registeredByRoot = new Map<string, RegistryEntry>();
	for (const e of registry.list()) {
		if (e.mountState !== "mounted") continue;
		mountRoots.add(e.projectRoot);
		registeredByRoot.set(path.resolve(e.projectRoot), e);
	}

	function mountProject(
		root: string,
		registeredRegistryEntry = registeredByRoot.get(
			path.resolve(root),
		),
	): ControlHost {
		if (singleton.role !== "writer") {
			throw Object.assign(
				new Error(
					"TF_AUTHORITY_REVOKED: attach daemon cannot mount a project",
				),
				{ code: "TF_AUTHORITY_REVOKED" },
			);
		}
		const resolvedRoot = path.resolve(root);
		const mounted = [...hosts.values()].find(
			(host) =>
				path.resolve(host.store.projectRoot) ===
				resolvedRoot,
		);
		if (mounted) return mounted;
		const { host } = bootstrapControl({
			projectRoot: resolvedRoot,
			controlMode: "auto",
			env,
			holderId: `${holderId}:${resolvedRoot}`,
			skipSingleton: true,
			...(registeredRegistryEntry
				? { registeredRegistryEntry }
				: {}),
		});
		hosts.set(host.projectId, host);
		hostReadiness.set(
			host.projectId,
			host
				.recoverApprovedContinuations()
				.then(() => undefined),
		);
		return host;
	}

	if (singleton.role === "writer") {
		for (const root of mountRoots) {
			mountProject(root);
		}
		/*
		 * A durable approve command may have crashed after its queued handoff
		 * commit. Do not expose UDS or WebGateway until every mounted writer
		 * has either resumed that exact checkpoint or failed it closed.
		 */
		await Promise.all(hostReadiness.values());
	}

	let gateway: WebGatewayHandle | undefined;
	let gatewayCompatibilityKey: string | undefined;
	let gatewayMonitor: NodeJS.Timeout | undefined;
	let gatewayStoppedResolve: (() => void) | undefined;
	let gatewayStopped = Promise.resolve();
	let uiQueue = Promise.resolve();

	async function serializedUi<T>(operation: () => Promise<T>): Promise<T> {
		const previous = uiQueue;
		let release: (() => void) | undefined;
		uiQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release?.();
		}
	}

	function beginGatewayLifetime(): void {
		gatewayStopped = new Promise<void>((resolve) => {
			gatewayStoppedResolve = resolve;
		});
		if (gatewayMonitor) clearInterval(gatewayMonitor);
		gatewayMonitor = setInterval(() => {
			if (
				gateway &&
				!gateway.sessions.hasLiveCapabilityOrSession()
			) {
				void stopWebUi();
			}
		}, 15_000);
		gatewayMonitor.unref();
	}

	async function startWebUi(
		input: DaemonWebUiStartRequest,
	): Promise<DaemonWebUiLaunch> {
		return serializedUi(async () => {
			if (singleton.role !== "writer") {
				throw Object.assign(
					new Error(
						"TF_AUTHORITY_REVOKED: only the active singleton writer can expose WebGateway",
					),
					{ code: "TF_AUTHORITY_REVOKED" },
				);
			}
			const request = validateWebUiRequest(input);
			const host = mountProject(request.projectRoot);
			await (
				hostReadiness.get(host.projectId) ??
				Promise.resolve()
			);
			const compatibilityKey =
				webUiCompatibilityKey(request);
			if (gateway) {
				if (
					gatewayCompatibilityKey !== compatibilityKey
				) {
					throw Object.assign(
						new Error(
							"TF_PROTOCOL_INCOMPATIBLE: active WebGateway uses a different UI/content build",
						),
						{ code: "TF_PROTOCOL_INCOMPATIBLE" },
					);
				}
				if (
					request.port !== 0 &&
					request.port !== gateway.port
				) {
					throw Object.assign(
						new Error(
							`TF_INVALID_ARGUMENT: active WebGateway already uses port ${gateway.port}`,
						),
						{ code: "TF_INVALID_ARGUMENT" },
					);
				}
				const launch = gateway.mintLaunchUrl();
				return {
					ok: true,
					launchUrl: launch.launchUrl,
					origin: gateway.origin,
					listenerId: gateway.listenerId,
					port: gateway.port,
					reused: true,
					projectId: host.projectId,
					controlDomainId: host.controlDomainId,
					packageVersion: request.packageVersion,
				};
			}
			const nextGateway = await startWebGateway({
				host,
				resolveHost: (projectId, controlDomainId) => {
					const candidate = hosts.get(projectId);
					return candidate?.controlDomainId ===
						controlDomainId
						? candidate
						: null;
				},
				listHosts: () => [...hosts.values()],
				port: request.port,
				packageVersion: request.packageVersion,
				contentKeysetDigests:
					request.contentKeysetDigests,
				staticAssets: {
					root: request.staticAssetsRoot,
				},
			});
			gateway = nextGateway;
			gatewayCompatibilityKey = compatibilityKey;
			beginGatewayLifetime();
			return {
				ok: true,
				launchUrl: nextGateway.launchUrl,
				origin: nextGateway.origin,
				listenerId: nextGateway.listenerId,
				port: nextGateway.port,
				reused: false,
				projectId: host.projectId,
				controlDomainId: host.controlDomainId,
				packageVersion: request.packageVersion,
			};
		});
	}

	async function stopWebUi(): Promise<{
		readonly stopped: boolean;
	}> {
		return serializedUi(async () => {
			const current = gateway;
			if (!current) return { stopped: false };
			gateway = undefined;
			gatewayCompatibilityKey = undefined;
			if (gatewayMonitor) {
				clearInterval(gatewayMonitor);
				gatewayMonitor = undefined;
			}
			try {
				await current.stop();
			} finally {
				gatewayStoppedResolve?.();
				gatewayStoppedResolve = undefined;
			}
			return { stopped: true };
		});
	}

	function webUiStatus(): DaemonWebUiStatus {
		const current = gateway;
		if (!current) return { active: false };
		return {
			active: true,
			origin: current.origin,
			listenerId: current.listenerId,
			port: current.port,
			sessions: current.sessions.activeSessionCount(),
			pendingCapabilityOrSession:
				current.sessions.hasLiveCapabilityOrSession(),
		};
	}

	let uds: UdsServerHandle | undefined;
	const wantListen =
		opts.listenUds !== false && process.platform !== "win32" && singleton.role === "writer";
	if (wantListen) {
		const socketPath = singleton.lock.endpoint || udsPath(env);
		uds = await startUdsServer({
			socketPath,
			fencingEpoch: singleton.lock.fencingEpoch,
			role: singleton.role,
			getHost: (projectId) => {
				// Exact projectId only when provided — no silent wrong-project fallback.
				if (projectId) return hosts.get(projectId) ?? null;
				const first = hosts.values().next().value;
				return first ?? null;
			},
			webUi: {
				start: (params) =>
					startWebUi(
						params as unknown as DaemonWebUiStartRequest,
					),
				stop: () => stopWebUi(),
				status: () => webUiStatus(),
			},
		});
	}

	return {
		holderId,
		role: singleton.role,
		hosts,
		socketPath: uds?.socketPath,
		fencingEpoch: singleton.lock.fencingEpoch,
		startWebUi,
		stopWebUi,
		webUiStatus,
		waitForWebUiStop: () => gatewayStopped,
		async stop() {
			await stopWebUi();
			if (uds) await uds.close();
			for (const h of hosts.values()) h.close();
			if (singleton.role === "writer") {
				releaseSingleton(holderId, env);
			}
		},
	};
}

/** Sync helper for tests that do not need UDS. */
export function startDaemonSync(opts: DaemonOptions = {}): DaemonHandle {
	// Fire-and-forget pattern for lock-only: block on promise in tests via await startDaemon
	throw new Error("use await startDaemon({ listenUds: false }) instead of startDaemonSync");
}
