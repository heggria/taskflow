/**
 * taskflowd: acquire singleton, mount registry projects, serve UDS JSON-line RPC.
 * Same singleton lock as embedded supervisors (D32).
 *
 * Starts with zero or more pre-mounted projectRoots. A live writer may also
 * mount a new project on demand when an admit RPC carries an explicit absolute
 * projectRoot that passes the mount allowlist (default deny) — still one writer,
 * one ledger per project. Agent/gate over UDS stay fail-closed (no host LLM).
 */
import {
	acquireOrAttachSingleton,
	bootstrapControl,
	isSingletonMutationAuthorityCurrent,
	newId,
	openControlRegistry,
	releaseSingleton,
	udsPath,
	withSingletonMutationAuthority,
	type ControlHost,
} from "taskflow-control";
import {
	mountProject,
	resolveMountAllowRoots,
	type MountResult,
} from "./mount.ts";
import { startUdsServer, type UdsServerHandle } from "./uds-server.ts";

export interface DaemonOptions {
	env?: NodeJS.ProcessEnv;
	/** Pre-mount these project roots at start. */
	projectRoots?: string[];
	/**
	 * Absolute roots under which on-demand mounts are permitted.
	 * Merged with TASKFLOW_DAEMON_MOUNT_ALLOW_ROOTS. Empty = default deny
	 * for on-demand (pre-mounted roots still work).
	 */
	mountAllowRoots?: string[];
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
	/** Resolved on-demand mount allowlist (empty = default deny). */
	mountAllowRoots: readonly string[];
	/**
	 * Writer-only: open/reuse a ControlHost for an absolute projectRoot.
	 * Used by UDS admit when the project was not pre-mounted.
	 */
	mountProject(projectRoot: string, expectedProjectId?: string): MountResult;
	stop(): Promise<void> | void;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
	const env = opts.env ?? process.env;
	const holderId = opts.holderId ?? newId("daemon");
	const singleton = acquireOrAttachSingleton(holderId, env);
	const allowRoots = resolveMountAllowRoots(opts.mountAllowRoots, env);

	const hosts = new Map<string, ControlHost>();
	const roots = opts.projectRoots ?? [];

	const registry = openControlRegistry(env);
	const mountRoots = new Set(roots);
	for (const e of registry.list()) {
		mountRoots.add(e.projectRoot);
	}

	const writerFence =
		singleton.role === "writer"
			? {
					mutationAuthority: () =>
						isSingletonMutationAuthorityCurrent(singleton.mutationAuthority, env),
					mutationFence: <T>(fn: () => T): T =>
						withSingletonMutationAuthority(singleton.mutationAuthority, fn, env),
					mutationCapability: singleton.mutationAuthority,
				}
			: {};

	if (singleton.role === "writer") {
		for (const root of mountRoots) {
			const { host } = bootstrapControl({
				projectRoot: root,
				controlMode: "auto",
				env,
				holderId: `${holderId}:${root}`,
				skipSingleton: true,
				...writerFence,
			});
			hosts.set(host.projectId, host);
		}
	}

	const doMount = (projectRoot: string, expectedProjectId?: string): MountResult => {
		if (singleton.role !== "writer") {
			return {
				ok: false,
				code: "TF_AUTHORITY_REVOKED",
				message: "attach cannot mount projects",
			};
		}
		return mountProject({
			hosts,
			env,
			holderId,
			projectRoot,
			expectedProjectId,
			allowRoots,
			...writerFence,
		});
	};

	let uds: UdsServerHandle | undefined;
	const wantListen =
		opts.listenUds !== false && process.platform !== "win32" && singleton.role === "writer";
	if (wantListen) {
		const socketPath = singleton.lock.endpoint || udsPath(env);
		uds = await startUdsServer({
			socketPath,
			fencingEpoch: singleton.lock.fencingEpoch,
			role: singleton.role,
			isWriterAuthoritative: () =>
				isSingletonMutationAuthorityCurrent(singleton.mutationAuthority, env),
			getHost: (projectId) => {
				// Exact projectId only when provided — no silent wrong-project fallback.
				if (projectId) return hosts.get(projectId) ?? null;
				// Default only when exactly one host is mounted (enforced invariant).
				if (hosts.size === 1) {
					return hosts.values().next().value ?? null;
				}
				return null;
			},
			mountedHostCount: () => hosts.size,
			mountProject: doMount,
		});
	}

	return {
		holderId,
		role: singleton.role,
		hosts,
		socketPath: uds?.socketPath,
		fencingEpoch: singleton.lock.fencingEpoch,
		mountAllowRoots: allowRoots,
		mountProject: doMount,
		async stop() {
			if (uds) await uds.close();
			for (const h of hosts.values()) h.close();
			if (singleton.role === "writer") {
				releaseSingleton(singleton.mutationAuthority, env);
			}
		},
	};
}

/** Sync helper for tests that do not need UDS. */
export function startDaemonSync(opts: DaemonOptions = {}): DaemonHandle {
	// Fire-and-forget pattern for lock-only: block on promise in tests via await startDaemon
	void opts;
	throw new Error("use await startDaemon({ listenUds: false }) instead of startDaemonSync");
}
