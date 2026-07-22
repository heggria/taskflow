/**
 * Barriered admit with shared commandId (script provider).
 */
import { createControlHost, createScriptExecutionProvider } from "../../src/index.ts";
import { childAwaitStart } from "./mp-barrier.mts";

const projectRoot = process.argv[2];
const home = process.argv[3];
const commandId = process.argv[4];
if (!projectRoot || !home || !commandId) {
	console.error("usage: mp-admit-cmd.mts <project> <TASKFLOW_HOME> <commandId>");
	process.exit(2);
}
const env = { ...process.env, TASKFLOW_HOME: home };
const barrier = process.env.TF_MP_BARRIER;
const id = process.env.TF_MP_ID ?? String(process.pid);
if (barrier) childAwaitStart(barrier, id);

const host = createControlHost({
	projectRoot,
	env,
	skipSingleton: true,
	controlMode: "standalone",
	provider: createScriptExecutionProvider(),
});
const result = await host.admitAndRun({
	commandId,
	program: {
		name: "shared",
		phases: [{ id: "main", type: "script", run: "echo shared-ok", final: true }],
	},
	callerPrincipal: "mp",
});
process.stdout.write(
	JSON.stringify({
		ok: result.ok,
		code: result.error?.code ?? null,
		runId: result.run?.runId ?? null,
		receiptId: result.receipt?.receiptId ?? null,
		status: result.run?.status ?? null,
		pid: process.pid,
	}),
);
host.close();
