import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { PersistentFileMutex } from "../src/resources/persistence.ts";
const worker = new URL("./fixtures/mutex-bootstrap-worker.mts", import.meta.url);
function fixture(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-bootstrap-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return { dir, lock: path.join(dir, "mutex"), marker: path.join(dir, "marker") };
}
function child(t: TestContext, args: string[]): ChildProcess {
	const process = fork(worker, args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); });
	return process;
}
async function paused(process: ChildProcess, marker: string): Promise<void> {
	const until = Date.now() + 5000;
	while (!fs.existsSync(marker)) {
		assert.equal(process.exitCode, null, "fixture must remain alive until fault boundary");
		assert.ok(Date.now() < until, "fixture should reach fault boundary");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
async function killOwned(process: ChildProcess) {
	const exit = once(process, "exit");
	process.kill("SIGKILL");
	await exit;
}
for (const phase of ["intent", "renamed", "anchor"] as const) {
	test(`mutex bootstrap recovers SIGKILL after ${phase}, with four simultaneous recoverers`, async t => {
		const { lock, marker, dir } = fixture(t);
		const initializer = child(t, [phase, lock, marker]);
		await paused(initializer, marker);
		const intent = fs.readFileSync(`${lock}.queue.initializing`);
		await assert.rejects(new PersistentFileMutex(lock, { pollMs: 1 }).acquire({ timeoutMs: 30 }), /TFWS_MUTEX_IDENTITY/);
		assert.deepEqual(fs.readFileSync(`${lock}.queue.initializing`), intent, "live initializer evidence is preserved");
		await killOwned(initializer);
		const counter = path.join(dir, "counter");
		fs.writeFileSync(counter, "0");
		const contenders = Array.from({ length: 4 }, () => child(t, ["recover-counter", lock, counter]));
		await Promise.all(contenders.map(async process => {
			let errors = "";
			process.stderr!.on("data", chunk => { errors += String(chunk); });
			const [code] = await once(process, "exit");
			assert.equal(code, 0, errors);
		}));
		assert.equal(fs.readFileSync(counter, "utf8"), "20");
		assert.equal(fs.existsSync(`${lock}.queue.initializing`), true);
		assert.equal(fs.existsSync(`${lock}.queue.initialized`), true);
		assert.deepEqual(fs.readdirSync(`${lock}.queue`), []);
	});
}

test("mutex bootstrap preserves dead intent with replaced canonical inode", async t => {
	const { lock, marker } = fixture(t);
	const initializer = child(t, ["renamed", lock, marker]);
	await paused(initializer, marker);
	await killOwned(initializer);
	fs.renameSync(`${lock}.queue`, `${lock}.preserved`);
	fs.mkdirSync(`${lock}.queue`);
	const before = fs.readFileSync(`${lock}.queue.initializing`);
	await assert.rejects(new PersistentFileMutex(lock).acquire({ timeoutMs: 30 }), /TFWS_MUTEX_IDENTITY/);
	assert.deepEqual(fs.readFileSync(`${lock}.queue.initializing`), before);
	assert.equal(fs.existsSync(`${lock}.queue.identity`), false);
});

test("mutex bootstrap cannot infer legacy quiescence from an empty queue", async t => {
	const { lock } = fixture(t);
	fs.mkdirSync(`${lock}.queue`);
	await assert.rejects(new PersistentFileMutex(lock, { pollMs: 1 }).acquire({ timeoutMs: 25 }), /TFWS_MUTEX_IDENTITY/);
	assert.deepEqual(fs.readdirSync(`${lock}.queue`), []);
	assert.equal(fs.existsSync(`${lock}.queue.identity`), false);
	assert.equal(fs.existsSync(`${lock}.queue.initializing`), false);
});

test("mutex bootstrap completion is usable after crash before initializer returns", async t => {
	const { lock, marker } = fixture(t);
	const initializer = child(t, ["complete", lock, marker]);
	await paused(initializer, marker);
	const committed = fs.readFileSync(`${lock}.queue.initialized`);
	// A complete namespace no longer depends on its initializer's liveness.
	(await new PersistentFileMutex(lock).acquire({ timeoutMs: 100 }))();
	await killOwned(initializer);
	(await new PersistentFileMutex(lock).acquire({ timeoutMs: 100 }))();
	assert.deepEqual(fs.readFileSync(`${lock}.queue.initialized`), committed);
});

test("mutex bootstrap late creator cannot publish a second generation after first completes", async t => {
	const { lock, marker } = fixture(t);
	const late = child(t, ["late", lock, marker]);
	await paused(late, marker);
	const release = await new PersistentFileMutex(lock).acquire();
	const genesis = fs.readFileSync(`${lock}.queue.initializing`);
	const completion = fs.readFileSync(`${lock}.queue.initialized`);
	const exited = once(late, "exit");
	fs.writeFileSync(`${marker}.continue`, "continue");
	await paused(late, `${marker}.published`);
	assert.equal(late.exitCode, null, "late contender cannot acquire while first holder is live");
	assert.deepEqual(fs.readFileSync(`${lock}.queue.initializing`), genesis);
	release();
	const [code] = await exited;
	assert.equal(code, 0);
	assert.deepEqual(fs.readFileSync(`${lock}.queue.initializing`), genesis);
	assert.deepEqual(fs.readFileSync(`${lock}.queue.initialized`), completion);
});

for (const missing of ["initializing", "identity"] as const) {
	test(`completed mutex namespace rejects missing ${missing} without rewriting evidence`, async t => {
		const { lock } = fixture(t);
		(await new PersistentFileMutex(lock).acquire())();
		const completion = fs.readFileSync(`${lock}.queue.initialized`);
		fs.unlinkSync(`${lock}.queue.${missing}`);
		await assert.rejects(new PersistentFileMutex(lock, { pollMs: 1 }).acquire({ timeoutMs: 25 }), /TFWS_MUTEX_IDENTITY/);
		assert.equal(fs.existsSync(`${lock}.queue.${missing}`), false);
		assert.deepEqual(fs.readFileSync(`${lock}.queue.initialized`), completion);
	});
}

test("mutex bootstrap ignores an unpublished staging directory after initializer SIGKILL", async t => {
	const { dir, lock, marker } = fixture(t);
	const initializer = child(t, ["late", lock, marker]);
	await paused(initializer, marker);
	const staged = fs.readdirSync(dir).find(name => name.startsWith("mutex.queue.staging-"));
	assert.ok(staged);
	const original = fs.statSync(path.join(dir, staged));
	await killOwned(initializer);
	assert.equal(fs.existsSync(`${lock}.queue.initializing`), false);
	(await new PersistentFileMutex(lock).acquire())();
	assert.equal(fs.statSync(path.join(dir, staged)).ino, original.ino, "unpublished evidence is preserved");
	assert.notEqual(fs.statSync(`${lock}.queue`).ino, original.ino, "fresh namespace does not adopt orphan staging");
});
