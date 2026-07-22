/**
 * Multi-process helper: open UserCoordinatorStore and try one reserve.
 * Prints { ok, reservationId?, occupying } for capacity races.
 */
import { openUserCoordinatorStore } from "../../src/store/coordinator.ts";

const home = process.argv[2];
if (!home) {
	console.error("usage: mp-reserve.mts <TASKFLOW_HOME>");
	process.exit(2);
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
