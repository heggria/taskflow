#!/usr/bin/env node
/**
 * taskflowd CLI entry.
 *
 * --project <root>           pre-mount a project at start
 * --allow-mount-root <root>  allow on-demand mounts under this absolute root
 *                            (also TASKFLOW_DAEMON_MOUNT_ALLOW_ROOTS; default deny)
 */
import { startDaemon } from "./daemon.ts";

const args = process.argv.slice(2);
const projectRoots: string[] = [];
const mountAllowRoots: string[] = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--project" && args[i + 1]) {
		projectRoots.push(args[++i]!);
	} else if (args[i] === "--allow-mount-root" && args[i + 1]) {
		mountAllowRoots.push(args[++i]!);
	}
}

const daemon = await startDaemon({ projectRoots, mountAllowRoots });
console.log(
	JSON.stringify({
		ok: true,
		role: daemon.role,
		holderId: daemon.holderId,
		socketPath: daemon.socketPath,
		fencingEpoch: daemon.fencingEpoch,
		mounted: [...daemon.hosts.keys()],
		mountAllowRoots: daemon.mountAllowRoots,
	}),
);

const shutdown = () => {
	void Promise.resolve(daemon.stop()).finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Keep alive when writer
if (daemon.role === "writer") {
	setInterval(() => {}, 1 << 30);
}
