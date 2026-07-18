import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
	PersistentFileMutex,
	defaultProcessIdentity,
	defaultProcessInspector,
	isPersistedOwnerStale,
} from "../src/resources/persistence.ts";

test("persistent mutex serializes concurrent contenders without losing updates", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-mutex-stress-"));
	const lockPath = path.join(directory, "counter.lock");
	const counterPath = path.join(directory, "counter");
	fs.writeFileSync(counterPath, "0");
	try {
		const mutexes = Array.from({ length: 8 }, () => new PersistentFileMutex(lockPath, { pollMs: 1 }));
		await Promise.all(Array.from({ length: 40 }, async (_unused, index) => {
			await mutexes[index % mutexes.length].runExclusive(async () => {
				const value = Number(fs.readFileSync(counterPath, "utf8"));
				await new Promise<void>((resolve) => setImmediate(resolve));
				fs.writeFileSync(counterPath, String(value + 1));
			}, { timeoutMs: 30_000 });
		}));
		assert.equal(fs.readFileSync(counterPath, "utf8"), "40");
		assert.deepEqual(fs.readdirSync(`${lockPath}.queue`), []);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("persistent mutex removes only the exact stale immutable queue ticket", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-mutex-stale-"));
	const lockPath = path.join(directory, "state.lock");
	const queueDirectory = `${lockPath}.queue`;
	fs.mkdirSync(queueDirectory, { recursive: true });
	const token = crypto.randomUUID();
	const stalePath = path.join(queueDirectory, `ticket-${token}.json`);
	fs.writeFileSync(stalePath, JSON.stringify({
		kind: "ticket",
		pid: 424242,
		birthToken: "stale-owner",
		birthTokenKind: "native",
		token,
		ticket: 1,
		createdAt: 1,
		state: "held",
	}));
	try {
		const mutex = new PersistentFileMutex(lockPath, {
			pollMs: 1,
			processIdentity: { pid: 7, birthToken: "current-owner", birthTokenKind: "native" },
			inspectProcess: () => ({ alive: false }),
		});
		const release = await mutex.acquire();
		assert.equal(fs.existsSync(stalePath), false);
		release();
		assert.deepEqual(fs.readdirSync(queueDirectory), []);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("process identity reclaims only mismatched comparable native birth tokens", () => {
	assert.equal(isPersistedOwnerStale(
		{ pid: 42, birthToken: "old", birthTokenKind: "native" },
		{ pid: 7, birthToken: "self", birthTokenKind: "native" },
		() => ({ alive: true, birthToken: "new", birthTokenKind: "native" }),
	), true);
	assert.equal(isPersistedOwnerStale(
		{ pid: 42, birthToken: "old", birthTokenKind: "native" },
		{ pid: 7, birthToken: "self", birthTokenKind: "native" },
		() => ({ alive: true, birthToken: "old", birthTokenKind: "native" }),
	), false);
	assert.equal(isPersistedOwnerStale(
		{ pid: 42, birthToken: "old", birthTokenKind: "native" },
		{ pid: 7, birthToken: "self", birthTokenKind: "native" },
		() => ({ alive: true }),
	), false, "alive owners with no comparable native token fail closed");
	assert.equal(isPersistedOwnerStale(
		{ pid: 7, birthToken: "prior-process", birthTokenKind: "native" },
		{ pid: 7, birthToken: "current-process", birthTokenKind: "native" },
		() => ({ alive: true }),
	), true, "same-PID native tokens remain exactly comparable");
	assert.equal(isPersistedOwnerStale(
		{ pid: 7, birthToken: "opaque:first-isolate", birthTokenKind: "opaque" },
		{ pid: 7, birthToken: "opaque:second-isolate", birthTokenKind: "opaque" },
		() => ({ alive: true }),
	), false, "same-PID opaque tokens from separate worker isolates fail closed");

	const own = defaultProcessIdentity();
	assert.deepEqual(defaultProcessInspector(process.pid), {
		alive: true,
		birthToken: own.birthToken,
		birthTokenKind: own.birthTokenKind,
	});
});

test("persistent mutex: a new instance drains deferred ticket cleanup without reversing the result", async (t) => {
	if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
		return t.skip("permission fault injection requires a non-root POSIX process");
	}
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-mutex-release-fault-"));
	const lockPath = path.join(directory, "state.lock");
	const queueDirectory = `${lockPath}.queue`;
	t.mock.method(console, "warn", () => undefined);
	let committed = false;
	try {
		const firstMutex = new PersistentFileMutex(lockPath, { pollMs: 1 });
		const result = await firstMutex.runExclusive(() => {
			committed = true;
			fs.chmodSync(queueDirectory, 0o500);
			return 42;
		});
		assert.equal(result, 42);
		assert.equal(committed, true);
		fs.chmodSync(queueDirectory, 0o700);
		const nextSessionMutex = new PersistentFileMutex(lockPath, { pollMs: 1 });
		assert.equal(
			await nextSessionMutex.runExclusive(() => 43),
			43,
			"a new mutex instance drains the process-global deferred exact ticket",
		);
		assert.deepEqual(fs.readdirSync(queueDirectory), []);
	} finally {
		try { fs.chmodSync(queueDirectory, 0o700); } catch { /* best effort */ }
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("persistent mutex: timed-out waiter durably terminates when queue unlink is unavailable", async (t) => {
	if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
		return t.skip("permission fault injection requires a non-root POSIX process");
	}
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-mutex-timeout-fault-"));
	const lockPath = path.join(directory, "state.lock");
	const queueDirectory = `${lockPath}.queue`;
	let releaseFirst: (() => void) | undefined;
	try {
		releaseFirst = await new PersistentFileMutex(lockPath, { pollMs: 1 }).acquire();
		const waiting = new PersistentFileMutex(lockPath, { pollMs: 1 }).acquire({ timeoutMs: 300 });
		const deadline = Date.now() + 150;
		while (Date.now() < deadline &&
			fs.readdirSync(queueDirectory).filter((name) => name.startsWith("ticket-")).length < 2) {
			await new Promise<void>((resolve) => setTimeout(resolve, 2));
		}
		assert.ok(fs.readdirSync(queueDirectory).filter((name) => name.startsWith("ticket-")).length >= 2);
		fs.chmodSync(queueDirectory, 0o500);
		await assert.rejects(
			waiting,
			(error: unknown) => (error as { code?: string }).code === "TFWS_LEASE_TIMEOUT",
		);
		assert.equal(
			fs.readdirSync(queueDirectory).some((name) => name.startsWith("ticket-")),
			true,
			"permission failure leaves an immutable terminal record for later cleanup",
		);
		fs.chmodSync(queueDirectory, 0o700);
		releaseFirst();
		releaseFirst = undefined;
		const releaseNext = await new PersistentFileMutex(lockPath, { pollMs: 1 }).acquire({ timeoutMs: 500 });
		releaseNext();
		assert.deepEqual(fs.readdirSync(queueDirectory), []);
	} finally {
		try { fs.chmodSync(queueDirectory, 0o700); } catch { /* best effort */ }
		releaseFirst?.();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

interface WorkerMutexMessage {
	acquired?: boolean;
	released?: boolean;
	error?: string;
	identity?: { pid: number; birthToken: string; birthTokenKind: "native" | "opaque" };
}

function nextWorkerMessage(worker: Worker): Promise<WorkerMutexMessage> {
	return new Promise((resolve, reject) => {
		worker.once("message", (message: WorkerMutexMessage) => resolve(message));
		worker.once("error", reject);
	});
}

const WORKER_MUTEX_SOURCE = `
	const { parentPort, workerData } = require("node:worker_threads");
	(async () => {
		const persistence = await import(workerData.moduleUrl);
		const mutex = new persistence.PersistentFileMutex(workerData.lockPath, { pollMs: 1 });
		try {
			const release = await mutex.acquire({ timeoutMs: workerData.timeoutMs });
			parentPort.postMessage({ acquired: true, identity: persistence.defaultProcessIdentity() });
			parentPort.once("message", () => {
				release();
				parentPort.postMessage({ released: true });
			});
		} catch (error) {
			parentPort.postMessage({
				acquired: false,
				error: error && typeof error === "object" && "code" in error ? String(error.code) : String(error),
				identity: persistence.defaultProcessIdentity(),
			});
		}
	})();
`;

test("persistent mutex: worker threads with one PID never reclaim each other's live ticket", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-mutex-workers-"));
	const lockPath = path.join(directory, "state.lock");
	const moduleUrl = new URL("../src/resources/persistence.ts", import.meta.url).href;
	let first: Worker | undefined;
	let second: Worker | undefined;
	try {
		first = new Worker(WORKER_MUTEX_SOURCE, {
			eval: true,
			workerData: { moduleUrl, lockPath, timeoutMs: 1_000 },
		});
		const firstResult = await nextWorkerMessage(first);
		assert.equal(firstResult.acquired, true);

		second = new Worker(WORKER_MUTEX_SOURCE, {
			eval: true,
			workerData: { moduleUrl, lockPath, timeoutMs: 120 },
		});
		const secondResult = await nextWorkerMessage(second);
		assert.equal(firstResult.identity?.pid, secondResult.identity?.pid, "worker_threads share one OS PID");
		assert.equal(secondResult.acquired, false);
		assert.equal(secondResult.error, "TFWS_LEASE_TIMEOUT");

		first.postMessage("release");
		assert.equal((await nextWorkerMessage(first)).released, true);
	} finally {
		await Promise.all([first?.terminate(), second?.terminate()]);
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("persistent mutex: durable terminal ticket survives worker-local cleanup loss", async (t) => {
	if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
		return t.skip("permission fault injection requires a non-root POSIX process");
	}
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-mutex-worker-release-"));
	const lockPath = path.join(directory, "state.lock");
	const queueDirectory = `${lockPath}.queue`;
	const moduleUrl = new URL("../src/resources/persistence.ts", import.meta.url).href;
	let first: Worker | undefined;
	let second: Worker | undefined;
	try {
		first = new Worker(WORKER_MUTEX_SOURCE, {
			eval: true,
			workerData: { moduleUrl, lockPath, timeoutMs: 1_000 },
		});
		assert.equal((await nextWorkerMessage(first)).acquired, true);
		fs.chmodSync(queueDirectory, 0o500);
		first.postMessage("release");
		assert.equal((await nextWorkerMessage(first)).released, true);
		await first.terminate();
		first = undefined;
		assert.equal(fs.readdirSync(queueDirectory).some((name) => name.startsWith("ticket-")), true);
		fs.chmodSync(queueDirectory, 0o700);

		second = new Worker(WORKER_MUTEX_SOURCE, {
			eval: true,
			workerData: { moduleUrl, lockPath, timeoutMs: 1_000 },
		});
		assert.equal(
			(await nextWorkerMessage(second)).acquired,
			true,
			"another worker recognizes and removes the durable done ticket",
		);
		second.postMessage("release");
		assert.equal((await nextWorkerMessage(second)).released, true);
		assert.deepEqual(fs.readdirSync(queueDirectory), []);
	} finally {
		try { fs.chmodSync(queueDirectory, 0o700); } catch { /* best effort */ }
		await Promise.all([first?.terminate(), second?.terminate()]);
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
