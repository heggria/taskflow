/**
 * Acquire singleton after barrier; record acquisition and wait for the parent
 * release gate when it is the writer, then print the observed role.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireOrAttachSingleton, releaseSingleton } from "../../src/singleton.ts";
import { childAwaitStart } from "./mp-barrier.mts";

const home = process.argv[2];
const holderId = process.argv[3] ?? `h-${process.pid}`;
if (!home) {
	console.error("usage: mp-singleton-role.mts <TASKFLOW_HOME> [holderId]");
	process.exit(2);
}
const env = { ...process.env, TASKFLOW_HOME: home };
const barrier = process.env.TF_MP_BARRIER;
const id = process.env.TF_MP_ID ?? String(process.pid);
const releasePath = process.env.TF_MP_SINGLETON_RELEASE;
if (barrier) childAwaitStart(barrier, id);

const result = acquireOrAttachSingleton(holderId, env);
if (barrier) {
	fs.writeFileSync(path.join(barrier, `acquired-${id}`), String(process.pid));
}
if (result.role === "writer" && releasePath) {
	const deadline = Date.now() + 20_000;
	const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
	while (!fs.existsSync(releasePath)) {
		if (Date.now() > deadline) {
			throw new Error(`writer timed out waiting for singleton release: ${releasePath}`);
		}
		Atomics.wait(signal, 0, 0, 5);
	}
} else {
	// Back-compat for direct helper use without the parent-controlled release gate.
	const holdMs = result.role === "writer" ? 800 : 50;
	await new Promise((r) => setTimeout(r, holdMs));
}
process.stdout.write(
	JSON.stringify({
		role: result.role,
		holderId: result.lock.holderId,
		fencingEpoch: result.lock.fencingEpoch,
		pid: process.pid,
	}),
);
if (result.role === "writer") {
	releaseSingleton(result.mutationAuthority, env);
}
