/** Child role for the native durable-approval CAS integration test. */
import {
	createControlHost,
	createScriptExecutionProvider,
} from "../../src/index.ts";
import { childAwaitStart } from "./mp-barrier.mts";

const [projectRoot, home, runId, expectedVersion, sharedCommandId, sharedPrincipal] = process.argv.slice(2);
if (!projectRoot || !home || !runId || !expectedVersion) {
	throw new Error("usage: mp-native-approve.mts <project> <home> <runId> <expectedVersion>");
}

const id = process.env.TF_MP_ID ?? "unknown";
const barrier = process.env.TF_MP_BARRIER;
if (!barrier) throw new Error("TF_MP_BARRIER is required");
childAwaitStart(barrier, id);
const host = createControlHost({
	projectRoot,
	env: { ...process.env, TASKFLOW_HOME: home },
	skipSingleton: true,
	controlMode: "standalone",
	scriptProvider: createScriptExecutionProvider({
		stateDir: `${projectRoot}/.taskflow/control/provider-jobs`,
	}),
});
try {
	const result = await host.approve(runId, {
		commandId: sharedCommandId ?? `native-approve-${id}`,
		principal: sharedPrincipal ?? `reviewer-${id}`,
		expectedRunVersion: Number(expectedVersion),
	});
	process.stdout.write(
		JSON.stringify({
			ok: result.ok,
			code: result.error?.code ?? null,
			message: result.error?.message ?? null,
			recoveryAction: result.error?.recoveryAction ?? null,
			sideEffects: result.error?.sideEffects ?? null,
			status: result.run?.status ?? null,
			receiptId: result.receipt?.receiptId ?? null,
		}),
	);
} finally {
	host.close();
}
