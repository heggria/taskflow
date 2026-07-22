/**
 * Acquire singleton after barrier; print role. Hold briefly so peers can attach.
 */
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
if (barrier) childAwaitStart(barrier, id);

const result = acquireOrAttachSingleton(holderId, env);
// Hold lock for a short window so other children observe attach
const holdMs = result.role === "writer" ? 800 : 50;
await new Promise((r) => setTimeout(r, holdMs));
process.stdout.write(
	JSON.stringify({
		role: result.role,
		holderId: result.lock.holderId,
		fencingEpoch: result.lock.fencingEpoch,
		pid: process.pid,
	}),
);
if (result.role === "writer") {
	releaseSingleton(holderId, env);
}
