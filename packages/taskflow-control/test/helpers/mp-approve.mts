/**
 * Multi-process helper: open standalone ControlHost and approve with expectedRunVersion.
 * Barrier: TF_MP_BARRIER + TF_MP_ID.
 */
import { createControlHost, createMockExecutionProvider } from "../../src/index.ts";
import { childAwaitStart } from "./mp-barrier.mts";

const projectRoot = process.argv[2];
const home = process.argv[3];
const runId = process.argv[4];
const expectedRunVersion = Number(process.argv[5]);
if (!projectRoot || !home || !runId || !Number.isFinite(expectedRunVersion)) {
	console.error("usage: mp-approve.mts <projectRoot> <TASKFLOW_HOME> <runId> <expectedRunVersion>");
	process.exit(2);
}

const barrier = process.env.TF_MP_BARRIER;
const id = process.env.TF_MP_ID ?? String(process.pid);
if (barrier) {
	childAwaitStart(barrier, id);
}

const env = { ...process.env, TASKFLOW_HOME: home };
const host = createControlHost({
	projectRoot,
	env,
	skipSingleton: true,
	controlMode: "standalone",
	// Provider unused for approve path of already-parked run
	provider: createMockExecutionProvider({ outcome: "completed" }),
});

const result = await host.approve(runId, { expectedRunVersion });
process.stdout.write(
	JSON.stringify({
		ok: result.ok,
		code: result.error?.code ?? null,
		runId: result.run?.runId ?? null,
		status: result.run?.status ?? null,
		stage: result.run?.stage ?? null,
		runVersion: result.run?.runVersion ?? null,
		receiptId: result.receipt?.receiptId ?? null,
		pid: process.pid,
	}),
);
host.close();
