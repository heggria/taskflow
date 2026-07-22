/**
 * Multi-process helper: open UserCoordinatorStore and try one reserve.
 * Optional barrier: TF_MP_BARRIER + TF_MP_ID → wait for start before reserve.
 */
import { openUserCoordinatorStore } from "../../src/store/coordinator.ts";
import { childAwaitStart } from "./mp-barrier.mts";

const home = process.argv[2];
if (!home) {
	console.error("usage: mp-reserve.mts <TASKFLOW_HOME>");
	process.exit(2);
}
const barrier = process.env.TF_MP_BARRIER;
const id = process.env.TF_MP_ID ?? String(process.pid);
if (barrier) {
	childAwaitStart(barrier, id);
}
const env = { ...process.env, TASKFLOW_HOME: home };
const coord = openUserCoordinatorStore(env);
const res = coord.reserve({ coordinatorEpoch: 1, ttlMs: 60_000 });
process.stdout.write(
	JSON.stringify({
		ok: res !== null,
		reservationId: res?.reservationId ?? null,
		occupying: coord.occupyingCount(),
		maxActiveRuns: coord.maxActiveRuns,
		pid: process.pid,
	}),
);
