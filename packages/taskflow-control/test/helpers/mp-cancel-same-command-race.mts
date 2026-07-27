/**
 * C1 race fixture. Both children read the same missing cancel command before
 * either may commit it. The owner then reaches the real Script SIGKILL boundary
 * before the stale reader is released to attempt its old CAS.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createControlHost, createScriptExecutionProvider } from "../../src/index.ts";

const [projectRoot, home, runId, expectedRunVersionText, commandId, role, barrierDir, stateDir, signalLog] =
	process.argv.slice(2);
if (
	!projectRoot ||
	!home ||
	!runId ||
	!expectedRunVersionText ||
	!commandId ||
	(role !== "owner" && role !== "loser") ||
	!barrierDir ||
	!stateDir ||
	!signalLog
) {
	throw new Error(
		"usage: mp-cancel-same-command-race.mts <project-root> <taskflow-home> <run-id> <expected-run-version> <command-id> <owner|loser> <barrier-dir> <state-dir> <signal-log>",
	);
}

const expectedRunVersion = Number(expectedRunVersionText);
if (!Number.isSafeInteger(expectedRunVersion) || expectedRunVersion < 1) {
	throw new Error(`expected run version must be a positive safe integer, got ${expectedRunVersionText}`);
}

function waitForFile(filePath: string, timeoutMs = 15_000): void {
	const deadline = Date.now() + timeoutMs;
	const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
	while (!fs.existsSync(filePath)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${filePath}`);
		Atomics.wait(sleeper, 0, 0, 10);
	}
}

type MutableProcess = {
	kill(pid: number, signal?: NodeJS.Signals | number): boolean;
};
const mutableProcess = process as unknown as MutableProcess;
const realKill = mutableProcess.kill.bind(mutableProcess);
let sawGroupSignal = false;
mutableProcess.kill = (pid, signal) => {
	if (!sawGroupSignal && signal === "SIGKILL" && pid < 0) {
		sawGroupSignal = true;
		fs.mkdirSync(path.dirname(signalLog), { recursive: true });
		fs.appendFileSync(signalLog, `${role}:${pid}\n`);
		if (role === "owner") {
			fs.writeFileSync(
				path.join(barrierDir, "owner-at-signal"),
				JSON.stringify({ pid, signal, at: Date.now() }),
			);
			waitForFile(path.join(barrierDir, "release-owner-signal"));
		}
	}
	return realKill(pid, signal);
};

const host = createControlHost({
	projectRoot,
	env: { ...process.env, TASKFLOW_HOME: home },
	controlMode: "standalone",
	skipSingleton: true,
	scriptProvider: createScriptExecutionProvider({ stateDir }),
});

try {
	type MutableStore = {
		getCommand(commandId: string): ReturnType<typeof host.store.getCommand>;
	};
	const store = host.store as unknown as MutableStore;
	const originalGetCommand = store.getCommand.bind(store);
	let heldInitialRead = false;
	store.getCommand = (candidateCommandId) => {
		const existing = originalGetCommand(candidateCommandId);
		if (!heldInitialRead && candidateCommandId === commandId) {
			heldInitialRead = true;
			if (existing !== null) {
				throw new Error("C1 fixture expected both contenders to read the command before it was committed");
			}
			fs.mkdirSync(barrierDir, { recursive: true });
			fs.writeFileSync(path.join(barrierDir, `read-${role}`), String(process.pid));
			waitForFile(path.join(barrierDir, `release-${role}`));
		}
		return existing;
	};

	const result = await host.cancel(runId, {
		commandId,
		principal: "c1-principal",
		expectedRunVersion,
	});
	process.stdout.write(
		JSON.stringify({
			role,
			ok: result.ok,
			code: result.error?.code ?? null,
			sideEffects: result.error?.sideEffects ?? null,
			recoveryAction: result.error?.recoveryAction ?? null,
			status: result.run?.status ?? null,
			stage: result.run?.stage ?? null,
			cancelState: result.run?.cancelRequest?.state ?? null,
		}),
	);
} finally {
	host.close();
}
