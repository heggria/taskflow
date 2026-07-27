/**
 * C2 crash fixture: park immediately after the durable ControlStore commit
 * that records cancelRequest.state=requested, before cancel() can issue its
 * separate signalling CAS or call the provider.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createControlHost, createScriptExecutionProvider } from "../../src/index.ts";

const [projectRoot, home, runId, expectedRunVersionText, commandId, barrierPath, stateDir] = process.argv.slice(2);
if (!projectRoot || !home || !runId || !expectedRunVersionText || !commandId || !barrierPath || !stateDir) {
	throw new Error(
		"usage: mp-cancel-after-request-before-signalling.mts <project-root> <taskflow-home> <run-id> <expected-run-version> <command-id> <barrier-path> <state-dir>",
	);
}

const expectedRunVersion = Number(expectedRunVersionText);
if (!Number.isSafeInteger(expectedRunVersion) || expectedRunVersion < 1) {
	throw new Error(`expected run version must be a positive safe integer, got ${expectedRunVersionText}`);
}

const host = createControlHost({
	projectRoot,
	env: { ...process.env, TASKFLOW_HOME: home },
	controlMode: "standalone",
	skipSingleton: true,
	scriptProvider: createScriptExecutionProvider({ stateDir }),
});

try {
	type MutableStore = {
		compareAndCommit: typeof host.store.compareAndCommit;
	};
	const store = host.store as unknown as MutableStore;
	const originalCompareAndCommit = store.compareAndCommit.bind(store);
	let parked = false;
	store.compareAndCommit = (input) => {
		const result = originalCompareAndCommit(input);
		if (
			!parked &&
			result.ok &&
			result.run.cancelRequest?.commandId === commandId &&
			result.run.cancelRequest.state === "requested"
		) {
			parked = true;
			fs.mkdirSync(path.dirname(barrierPath), { recursive: true });
			fs.writeFileSync(
				barrierPath,
				JSON.stringify({
					runId,
					commandId,
					cancelState: result.run.cancelRequest.state,
					runVersion: result.run.runVersion,
					boundary: "after-durable-request-before-signalling-cas",
					at: Date.now(),
				}),
			);
			const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
			for (;;) Atomics.wait(sleeper, 0, 0, 50);
		}
		return result;
	};

	const result = await host.cancel(runId, { commandId, expectedRunVersion });
	throw new Error(`C2 cancel unexpectedly returned ${JSON.stringify(result)}`);
} finally {
	host.close();
}
