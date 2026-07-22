/**
 * Minimal taskflowd: acquire singleton, mount registry projects, serve in-process.
 * Full UDS JSON protocol is optional for unit tests — bootstrap uses the same
 * singleton lock as embedded supervisors (D32).
 */
import {
	acquireOrAttachSingleton,
	bootstrapControl,
	newId,
	openControlRegistry,
	releaseSingleton,
	type ControlHost,
} from "taskflow-control";

export interface DaemonOptions {
	env?: NodeJS.ProcessEnv;
	/** Pre-mount these project roots. */
	projectRoots?: string[];
	holderId?: string;
}

export interface DaemonHandle {
	holderId: string;
	role: "writer" | "attach";
	hosts: Map<string, ControlHost>;
	stop(): void;
}

export function startDaemon(opts: DaemonOptions = {}): DaemonHandle {
	const env = opts.env ?? process.env;
	const holderId = opts.holderId ?? newId("daemon");
	const singleton = acquireOrAttachSingleton(holderId, env);

	const hosts = new Map<string, ControlHost>();
	const roots = opts.projectRoots ?? [];

	// Mount from registry + explicit roots
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
				// Already hold user singleton
				skipSingleton: true,
			});
			hosts.set(host.projectId, host);
		}
	}

	return {
		holderId,
		role: singleton.role,
		hosts,
		stop() {
			for (const h of hosts.values()) h.close();
			if (singleton.role === "writer") {
				releaseSingleton(holderId, env);
			}
		},
	};
}
