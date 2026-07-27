/**
 * Real writer process for the durable SlotCommitted / no-first-intent window.
 *
 * The parent kills this writer after the project journal and coordinator have
 * both committed admission, but before the scheduler can record its first
 * provider intent.  A restart can prove neither a live owner nor a completed
 * side effect from these records alone.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createControlHost, createScriptExecutionProvider } from "../../src/index.ts";

const [projectRoot, home, barrierDir, marker] = process.argv.slice(2);
if (!projectRoot || !home || !barrierDir || !marker) {
	throw new Error(
		"usage: mp-post-slot-committed-before-intent.mts <project-root> <taskflow-home> <barrier-dir> <marker>",
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

const finalizeAdmission = host.store.finalizeAdmission.bind(host.store);
let armed = true;
host.store.finalizeAdmission = (input) => {
	const result = finalizeAdmission(input);
	if (armed && result.kind === "committed") {
		armed = false;
		fs.mkdirSync(barrierDir, { recursive: true });
		fs.writeFileSync(
			path.join(barrierDir, "slot-committed-without-intent.json"),
			JSON.stringify({
				runId: result.run.runId,
				reservationId: input.reservationId,
				commandId: "post-slot-committed-before-intent-command",
			}),
		);
		// The parent kills us here. Returning would permit the executing-state
		// journal write and the first durable dispatch intent.
		const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
		for (;;) Atomics.wait(signal, 0, 0, 50);
	}
	return result;
};

try {
	await host.admitAndRun({
		commandId: "post-slot-committed-before-intent-command",
		callerPrincipal: "cross-process-test",
		program: {
			name: "post-slot-committed-before-intent",
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
