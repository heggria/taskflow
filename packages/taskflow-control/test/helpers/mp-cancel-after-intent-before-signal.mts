/**
 * C3 crash fixture: enter the real ScriptExecutionProvider cancellation path,
 * let it durably write cancelRequestedAt, then park immediately before the
 * actual process-group SIGKILL. The parent test SIGKILLs this host process and
 * verifies that a fresh actor cannot re-signal the same command.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createControlHost, createScriptExecutionProvider } from "../../src/index.ts";

const [projectRoot, home, runId, expectedRunVersionText, commandId, barrierPath] = process.argv.slice(2);
if (!projectRoot || !home || !runId || !expectedRunVersionText || !commandId || !barrierPath) {
	throw new Error(
		"usage: mp-cancel-after-intent-before-signal.mts <project-root> <taskflow-home> <run-id> <expected-run-version> <command-id> <barrier-path>",
	);
}

const expectedRunVersion = Number(expectedRunVersionText);
if (!Number.isSafeInteger(expectedRunVersion) || expectedRunVersion < 1) {
	throw new Error(`expected run version must be a positive safe integer, got ${expectedRunVersionText}`);
}

type MutableProcess = {
	kill(pid: number, signal?: NodeJS.Signals | number): boolean;
};
const mutableProcess = process as unknown as MutableProcess;
const realKill = mutableProcess.kill.bind(mutableProcess);
let intercepted = false;
mutableProcess.kill = (pid, signal) => {
	if (!intercepted && signal === "SIGKILL" && pid < 0) {
		intercepted = true;
		fs.mkdirSync(path.dirname(barrierPath), { recursive: true });
		fs.writeFileSync(
			barrierPath,
			JSON.stringify({ pid, signal, at: Date.now(), boundary: "after-durable-cancel-intent-before-os-signal" }),
		);
		const parked = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
		for (;;) Atomics.wait(parked, 0, 0, 50);
	}
	return realKill(pid, signal);
};

const host = createControlHost({
	projectRoot,
	env: { ...process.env, TASKFLOW_HOME: home },
	controlMode: "standalone",
	skipSingleton: true,
	scriptProvider: createScriptExecutionProvider({
		stateDir: path.join(projectRoot, ".taskflow", "control", "provider-jobs"),
	}),
});

try {
	const result = await host.cancel(runId, { commandId, expectedRunVersion });
	// Reaching this point means the expected OS signal interception did not fire.
	throw new Error(`cancel unexpectedly returned ${JSON.stringify(result)}`);
} finally {
	host.close();
}
