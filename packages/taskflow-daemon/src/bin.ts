#!/usr/bin/env node
/**
 * taskflowd CLI entry.
 */
import { startDaemon } from "./daemon.ts";

const args = process.argv.slice(2);
const projectRoots: string[] = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--project" && args[i + 1]) {
		projectRoots.push(args[++i]!);
	}
}

const daemon = await startDaemon({ projectRoots });
console.log(
	JSON.stringify({
		ok: true,
		role: daemon.role,
		holderId: daemon.holderId,
		socketPath: daemon.socketPath,
		fencingEpoch: daemon.fencingEpoch,
		mounted: [...daemon.hosts.keys()],
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
