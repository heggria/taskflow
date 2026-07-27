/**
 * Real writer process for the first-dispatch owner gap.
 *
 * It persists RunStatusChanged(executing) after SlotCommitted, then parks
 * before schedulePhases can journal AttemptPrepared / DispatchIntentRecorded.
 * The parent kills this process and retries the same admission command from a
 * fresh, explicitly test-authorized actor.  This exposes whether a retry
 * falsely reports an in-progress run when there is no durable dispatch owner.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createControlHost, createScriptExecutionProvider } from "../../src/index.ts";

const [projectRoot, home, barrierDir, marker] = process.argv.slice(2);
if (!projectRoot || !home || !barrierDir || !marker) {
	throw new Error(
		"usage: mp-post-executing-before-intent.mts <project-root> <taskflow-home> <barrier-dir> <marker>",
	);
}

const host = createControlHost({
	projectRoot,
	env: { ...process.env, TASKFLOW_HOME: home },
	controlMode: "auto",
	scriptProvider: createScriptExecutionProvider({
		stateDir: path.join(projectRoot, ".taskflow", "control", "provider-jobs"),
	}),
});

const commit = host.store.commit.bind(host.store);
let armed = true;
host.store.commit = (batch) => {
	const result = commit(batch);
	if (
		armed &&
		batch.run?.stage === "executing" &&
		batch.events.some(
			(event) =>
				event.payload.type === "RunStatusChanged" &&
				event.payload.status === "running" &&
				event.payload.stage === "executing",
		)
	) {
		armed = false;
		fs.mkdirSync(barrierDir, { recursive: true });
		fs.writeFileSync(
			path.join(barrierDir, "executing-without-intent.json"),
			JSON.stringify({ runId: batch.run.runId, commandId: "post-executing-before-intent-command" }),
		);
		// The parent kills us here. Returning would allow the scheduler to record
		// the first durable dispatch intent and defeat this crash-window fixture.
		const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
		for (;;) Atomics.wait(signal, 0, 0, 50);
	}
	return result;
};

try {
	await host.admitAndRun({
		commandId: "post-executing-before-intent-command",
		callerPrincipal: "cross-process-test",
		program: {
			name: "post-executing-before-intent",
			phases: [
				{
					id: "write-marker",
					type: "script",
					run: [
						process.execPath,
						"-e",
						`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "once\\n")`,
					],
					final: true,
				},
			],
		},
	});
} finally {
	// Normally unreachable because the writer is intentionally parked above.
	host.close();
}
