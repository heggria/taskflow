/**
 * Process-level Unix UDS ControlHost tests (A2 / A2b).
 *
 * These spawn real OS processes: the winner fixture `listen`s on the user
 * singleton endpoint, the loser fixture `connect`s over the socket, does an
 * online hello, receives the winner's fencing epoch, and routes
 * `control.probe` over the wire. Also covers stale-socket recovery after the
 * winner is killed and the process-level `auto` → fail-closed (never silent
 * `standalone`) contract.
 *
 * Unix-only: these tests are deliberately NOT part of the 3-OS
 * process-supervisor matrix (Windows named pipe is non-GA). The file guards
 * itself with `skip: process.platform === "win32"`, and the supervisor job
 * only runs the two explicit taskflow-core test files, so this file never
 * executes on Windows.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { ControlHost } from "../src/control-host.ts";
import { createTeExecutionProvider, type TeExecutionAuthority } from "../src/te-provider.ts";
import { connectUdsClient } from "../src/uds.ts";
import { singletonPaths, type SingletonPaths } from "../src/singleton.ts";
import { PROTOCOL_MAJOR, type NegotiationHandshake } from "../src/schema/transport.ts";

const UNIX_ONLY = { skip: process.platform === "win32" } as const;

const tempRoots: string[] = [];
const children: ChildProcess[] = [];

after(() => {
	for (const child of children) {
		try {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		} catch {
			/* best effort */
		}
	}
	for (const root of tempRoots) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

function repoRoot(): string {
	return path.resolve(import.meta.dirname, "..", "..", "..");
}

function fixturePath(name: string): string {
	return path.join(import.meta.dirname, "fixtures", name);
}

function makeRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `tf-uds-${prefix}-`));
	tempRoots.push(root);
	return root;
}

function makePaths(root: string): SingletonPaths {
	return singletonPaths(root);
}

function spawnFixture(name: string, env: Record<string, string>): ChildProcess {
	const child = spawn(
		process.execPath,
		["--conditions=development", "--experimental-strip-types", fixturePath(name)],
		{
			cwd: repoRoot(),
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.push(child);
	return child;
}

function waitForLine(child: ChildProcess, prefix: string, timeoutMs = 15_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		let done = false;
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			child.stdout?.off("data", onData);
			reject(new Error(`timeout waiting for "${prefix}" from fixture; got: ${JSON.stringify(buffer.slice(-300))}`));
		}, timeoutMs);
		const onData = (chunk: Buffer): void => {
			if (done) return;
			buffer += chunk.toString("utf8");
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (!line) continue;
				if (line.startsWith(prefix)) {
					done = true;
					clearTimeout(timer);
					child.stdout?.off("data", onData);
					resolve(line);
					return;
				}
			}
		};
		child.stdout?.on("data", onData);
	});
}

function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* best effort */
			}
			reject(new Error(`timeout waiting for fixture exit; got: ${JSON.stringify(stdout.slice(-300))}`));
		}, timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output: stdout + stderr });
		});
	});
}

function parseJsonLine(line: string, prefix: string): Record<string, unknown> {
	const payload = line.slice(prefix.length).trim();
	const value: unknown = JSON.parse(payload);
	assert.ok(value !== null && typeof value === "object", `${prefix} payload must be a JSON object`);
	return value as Record<string, unknown>;
}

const CLIENT_HELLO: NegotiationHandshake = {
	protocolMajor: PROTOCOL_MAJOR,
	supportedReadSchemas: ["taskflow.wire.v1"],
	supportedWriteSchemas: ["taskflow.wire.v1"],
	requiredFeatures: [],
	offeredFeatures: [],
	buildInfo: { packageVersion: "0.3.0-beta.2", gitCommit: "test", schemaVersion: 1 },
};

test("uds: two OS processes compete — winner listens, loser attaches over the socket and gets the winner epoch (A2/A2b)", UNIX_ONLY, async () => {
	const root = makeRoot("attach");
	const paths = makePaths(root);

	// Winner: an independent OS process that wins the singleton and listens.
	const winner = spawnFixture("uds-winner.ts", {
		TF_TEST_CONTROL_HOME: root,
		TF_TEST_HOLDER_ID: "winner-proc",
	});
	const readyLine = await waitForLine(winner, "READY ");
	const winnerStatus = parseJsonLine(readyLine, "READY ");
	assert.equal(winnerStatus.singleton, "won");
	assert.equal(winnerStatus.fencingEpoch, 1);

	// The winner's endpoint is a real Unix socket, mode 0o600 (not umask luck).
	const socketStat = fs.statSync(paths.endpointPath);
	assert.equal(socketStat.isSocket(), true);
	assert.equal(socketStat.mode & 0o077, 0, "socket must be 0o600");

	// Loser: a second OS process competing for the same lock + endpoint.
	const loser = spawnFixture("uds-loser.ts", {
		TF_TEST_CONTROL_HOME: root,
		TF_TEST_HOLDER_ID: "loser-proc",
	});
	const attachedLine = await waitForLine(loser, "ATTACHED ");
	const attached = parseJsonLine(attachedLine, "ATTACHED ");
	assert.equal(attached.state, "started");
	assert.equal(attached.singleton, "attached");
	assert.equal(attached.holderId, "winner-proc");
	assert.equal(attached.fencingEpoch, winnerStatus.fencingEpoch, "loser must receive the winner's epoch over the socket");

	// A2b: the winner answers control.probe over UDS (proxied by the attached client).
	const probeLine = await waitForLine(loser, "PROBE ");
	const probe = parseJsonLine(probeLine, "PROBE ");
	assert.equal(probe.outcome, "accepted");
	assert.equal((probe.capabilities as Record<string, unknown>)?.processIsolation, "none");

	winner.kill("SIGTERM");
	loser.kill("SIGTERM");
});

test("uds: protocolMajor mismatch is rejected on the wire, not only in-process (P13 §5.5)", UNIX_ONLY, async () => {
	const root = makeRoot("proto");
	const paths = makePaths(root);

	const winner = spawnFixture("uds-winner.ts", {
		TF_TEST_CONTROL_HOME: root,
		TF_TEST_HOLDER_ID: "winner-proto",
	});
	await waitForLine(winner, "READY ");

	const badHello = { ...CLIENT_HELLO, protocolMajor: PROTOCOL_MAJOR + 1 } as unknown as NegotiationHandshake;
	await assert.rejects(
		connectUdsClient({ endpointPath: paths.endpointPath, clientHello: badHello }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal((error as { code?: unknown }).code, "TF_PROTOCOL_INCOMPATIBLE");
			return true;
		},
	);

	// The winner is still serving after rejecting a bad client.
	const goodClient = await connectUdsClient({ endpointPath: paths.endpointPath, clientHello: CLIENT_HELLO });
	assert.equal(goodClient.fencingEpoch, 1);
	goodClient.close();

	winner.kill("SIGTERM");
});

test("uds: killing the winner leaves a stale socket that the next process unlinks and re-listens (A2)", UNIX_ONLY, async () => {
	const root = makeRoot("stale");
	const paths = makePaths(root);

	const winner = spawnFixture("uds-winner.ts", {
		TF_TEST_CONTROL_HOME: root,
		TF_TEST_HOLDER_ID: "winner-stale",
	});
	const readyLine = await waitForLine(winner, "READY ");
	const winnerStatus = parseJsonLine(readyLine, "READY ");
	assert.equal(winnerStatus.fencingEpoch, 1);

	const staleIno = fs.statSync(paths.endpointPath, { bigint: true }).ino;

	// SIGKILL: no cleanup handler runs — the socket file must survive as stale.
	winner.kill("SIGKILL");
	const exited = await waitForExit(winner);
	assert.ok(exited.code === null || exited.code !== 0, "winner must die from SIGKILL");
	assert.equal(fs.existsSync(paths.endpointPath), true, "stale socket file must remain after SIGKILL");

	// A fresh OS process (the test runner) reclaims the dead owner: stale socket
	// is unlinked, then it listens again with a bumped fencing epoch.
	const te: TeExecutionAuthority = {
		assurance: "resolve-only-no-sandbox",
		probe: async () => ({
			classification: "resolve-only" as const,
			baselinePolicyId: "taskflow-resolve-only",
			hostProbeSha256: "a".repeat(64),
		}),
		prepare: async () => ({
			outcome: "accepted" as const,
			fulfillment: {
				preparationId: "prep",
				enforcementCapabilities: {
					resolution: "contained",
					mutationMediation: "brokered",
					processIsolation: "none",
					revocation: "admission-only",
					baselinePolicyId: "b",
					hostProbeSha256: "a".repeat(64),
				},
			},
		}),
		submit: async () => ({ outcome: "accepted" as const, providerJobHandle: "job" }),
		watch: async function* () {
			yield { kind: "terminal" as const, outcome: "completed" as const };
		},
	};
	const fresh = new ControlHost({
		mode: "auto",
		controlHome: root,
		provider: createTeExecutionProvider(te),
		holderId: "winner-reborn",
	});
	const status = await fresh.start();
	assert.equal(status.singleton, "won");
	assert.equal(status.fencingEpoch, 2, "reclaim must bump the fencing epoch");
	assert.equal(fs.existsSync(paths.endpointPath), true);
	const freshIno = fs.statSync(paths.endpointPath, { bigint: true }).ino;
	assert.notEqual(freshIno, staleIno, "the stale socket must be unlinked and a fresh one created");
	assert.equal(fs.statSync(paths.endpointPath).mode & 0o077, 0, "fresh socket must be 0o600");
	fresh.stop();
});

test("uds: auto never silently becomes standalone at the process level (fail closed)", UNIX_ONLY, async () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tf-uds-auto-"));
	tempRoots.push(parent);
	// The control home is a regular FILE — the singleton bootstrap cannot run.
	const controlHomeFile = path.join(parent, "control-file");
	fs.writeFileSync(controlHomeFile, "not a directory");

	const child = spawnFixture("uds-fail-closed.ts", {
		TF_TEST_CONTROL_HOME: controlHomeFile,
	});
	const exited = await waitForExit(child);
	assert.notEqual(exited.code, 0, "auto mode with an un-runnable control must fail closed");
	assert.match(exited.output, /FAILED-CLOSED/);
	assert.match(exited.output, /TF_BOOTSTRAP_FAILED/);
	assert.match(exited.output, /STATE failed-closed none/);
	assert.doesNotMatch(exited.output, /STARTED/);
});
