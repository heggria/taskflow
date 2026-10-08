/** Deterministic barriers around OS lock syscalls; never changes production code. */
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const [root, role, hook = "none"] = process.argv.slice(2);
const pause = (): void => {
	fs.writeFileSync(path.join(root, `${role}-paused`), "");
	const deadline = Date.now() + 15_000;
	while (!fs.existsSync(path.join(root, `${role}-resume`))) {
		if (Date.now() > deadline) throw new Error(`barrier timed out for ${role}`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	}
};
let paused = false;
const pauseOnce = (): void => { if (!paused) { paused = true; pause(); } };
if (hook === "candidate") {
	const open = fs.openSync;
	fs.openSync = function (...args: Parameters<typeof open>) {
		const fd = open(...args);
		if (String(args[0]).includes(".writer.lock-") && args[1] === "wx") pauseOnce();
		return fd;
	};
} else if (hook === "published") {
	const link = fs.linkSync;
	fs.linkSync = function (...args: Parameters<typeof link>) {
		link(...args);
		if (String(args[1]).endsWith("writer.lock")) pauseOnce();
	};
} else if (hook === "reclaim-claimed") {
	const mkdir = fs.mkdirSync;
	fs.mkdirSync = ((...args: Parameters<typeof mkdir>) => {
		const result = mkdir(...args);
		if (String(args[0]).includes("writer.lock.reclaim-")) pauseOnce();
		return result;
	}) as typeof mkdir;
} else if (hook === "stale-observed") {
	const kill = process.kill;
	process.kill = function (...args: Parameters<typeof kill>) {
		try { return kill(...args); } catch (error) {
			if (args[1] === 0 && (error as NodeJS.ErrnoException).code === "ESRCH") pauseOnce();
			throw error;
		}
	};
}
syncBuiltinESMExports();
const { openControlStore } = await import("../../src/store/store.ts");
try {
	const store = openControlStore(path.join(root, "store"));
	fs.writeFileSync(path.join(root, `${role}-acquired`), String(process.pid));
	process.on("SIGTERM", () => { store.close(); process.exit(0); });
	setInterval(() => {}, 1_000);
} catch (error) {
	fs.writeFileSync(path.join(root, `${role}-rejected`), error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
