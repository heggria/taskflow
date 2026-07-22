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
} from "taskflow-control";
import { startUdsServer, type UdsServerHandle } from "./uds-server.ts";

export interface DaemonOptions {
	env?: NodeJS.ProcessEnv;
	/** Pre-mount these project roots. */
	projectRoots?: string[];
	holderId?: string;
	/** When false, skip UDS listen (lock-only tests). Default true on non-win32. */
	listenUds?: boolean;
}

export interface DaemonHandle {
	holderId: string;
	role: "writer" | "attach";
	hosts: Map<string, ControlHost>;
	socketPath?: string;
	fencingEpoch: number;
	stop(): Promise<void> | void;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
	const env = opts.env ?? process.env;
	const holderId = opts.holderId ?? newId("daemon");
	const singleton = acquireOrAttachSingleton(holderId, env);

	const hosts = new Map<string, ControlHost>();
	const roots = opts.projectRoots ?? [];

	const registry = openControlRegistry(env);
	const mountRoots = new Set(roots);
	for (const e of registry.list()) {
		mountRoots.add(e.projectRoot);
	}

	if (singleton.role === "writer") {
		for (const root of mountRoots) {
			const { host } = bootstrapControl({
				projectRoot: root,
				controlMode: "auto",
				env,
				holderId: `${holderId}:${root}`,
				skipSingleton: true,
			});
			hosts.set(host.projectId, host);
		}
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
				if (projectId && hosts.has(projectId)) return hosts.get(projectId)!;
				const first = hosts.values().next().value;
				return first ?? null;
			},
		});
	}

	return {
		holderId,
		role: singleton.role,
		hosts,
		socketPath: uds?.socketPath,
		fencingEpoch: singleton.lock.fencingEpoch,
		async stop() {
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
