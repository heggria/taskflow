/**
 * Real writer process for the post-spawn / pre-DispatchAcknowledged crash window.
 *
 * It deliberately parks after ScriptExecutionProvider has durably accepted a
 * handle, but before ControlHost can journal that acknowledgement. The parent
 * kills this process, then a new singleton epoch must recover the same handle
 * without submitting the script a second time.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createControlHost,
	createScriptExecutionProvider,
	type ExecutionProvider,
	type ProviderSubmitRequest,
} from "../../src/index.ts";

const [projectRoot, home, barrierDir, marker] = process.argv.slice(2);
if (!projectRoot || !home || !barrierDir || !marker) {
	throw new Error(
		"usage: mp-post-spawn-lost-ack.mts <project-root> <taskflow-home> <barrier-dir> <marker>",
	);
}

const real = createScriptExecutionProvider({
	stateDir: path.join(projectRoot, ".taskflow", "control", "provider-jobs"),
});
const provider: ExecutionProvider = {
	name: real.name,
	probe: real.probe?.bind(real),
	prepare: real.prepare?.bind(real),
	collect: real.collect?.bind(real),
	watch: real.watch?.bind(real),
	poll: real.poll.bind(real),
	cancel: real.cancel.bind(real),
	reconcile: real.reconcile.bind(real),
	isLive: real.isLive?.bind(real),
	loadHandle: real.loadHandle?.bind(real),
	quiesceAll: real.quiesceAll?.bind(real),
	async submit(req: ProviderSubmitRequest) {
		const result = await real.submit(req);
		fs.mkdirSync(barrierDir, { recursive: true });
		fs.writeFileSync(
			path.join(barrierDir, "provider-accepted.json"),
			JSON.stringify({
				kind: result.kind,
				handle: "handle" in result ? result.handle ?? null : null,
				providerRunId: req.runId,
			}),
		);
		// The parent kills us here. Returning would permit ControlHost to persist
		// DispatchAcknowledged, defeating the deliberate crash-window fixture.
		const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
		for (;;) Atomics.wait(signal, 0, 0, 50);
	},
};

const host = createControlHost({
	projectRoot,
	env: { ...process.env, TASKFLOW_HOME: home },
	controlMode: "auto",
	scriptProvider: provider,
});

try {
	await host.admitAndRun({
		commandId: "post-spawn-lost-ack-command",
		callerPrincipal: "cross-process-test",
		program: {
			name: "post-spawn-lost-ack",
			phases: [
				{
					id: "write-marker",
					type: "script",
					run: [
						process.execPath,
						"-e",
						`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "once\\n"); setTimeout(() => process.exit(0), 750)`,
					],
					final: true,
				},
			],
		},
	});
} finally {
	// Normally unreachable because the provider wrapper is intentionally parked.
	host.close();
}
