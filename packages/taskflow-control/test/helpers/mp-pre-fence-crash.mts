/**
 * Real writer process for a crash after ControlHost's pre-submit authority
 * check, but before ScriptExecutionProvider enters its durable submit fence.
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
		"usage: mp-pre-fence-crash.mts <project-root> <taskflow-home> <barrier-dir> <marker>",
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
		fs.mkdirSync(barrierDir, { recursive: true });
		fs.writeFileSync(
			path.join(barrierDir, "provider-submit-entered.json"),
			JSON.stringify({ providerRunId: req.runId, idempotencyKey: req.idempotencyKey }),
		);
		// The parent SIGKILLs us before this wrapper delegates to the real Script
		// provider. Therefore no reservation, spawn, marker, or job handle exists.
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
		commandId: "pre-fence-crash-command",
		callerPrincipal: "cross-process-test",
		program: {
			name: "pre-fence-crash",
			phases: [
				{
					id: "write-marker",
					type: "script",
					run: [
						process.execPath,
						"-e",
						`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "must-not-run\\n")`,
					],
					final: true,
				},
			],
		},
	});
} finally {
	host.close();
}
