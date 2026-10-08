import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { LegacyWriterLifecycle } from "../src/legacy-writer-lifecycle.ts";
import { PersistentFileMutex } from "../src/persistent-mutex.ts";

function fixture(t: TestContext) {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-legacy-gate-"));
	t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
	const scope = path.join(parent, "managed");
	const gate = LegacyWriterLifecycle.create(scope);
	const queue = `${gate.lockPath}.queue`;
	fs.mkdirSync(queue);
	return { parent, scope, gate, queue };
}
async function writer(t: TestContext, gate: LegacyWriterLifecycle, code: string): Promise<ChildProcess> {
	const child = gate.spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const done = once(child, "exit");
			child.kill("SIGKILL");
			await done;
		}
	});
	await once(child, "message");
	return child;
}
async function stop(child: ChildProcess) {
	const done = once(child, "exit");
	child.send("stop");
	await done;
}

test("legacy migration refuses paused pre-ticket writer despite empty queue", async t => {
	const { gate, queue } = fixture(t);
	const child = await writer(t, gate, 'process.on("message", () => process.exit(0)); process.send("paused-before-ticket");');
	await assert.rejects(gate.drainAndMigrate({ timeoutMs: 20 }), /owned writers have not exited/);
	assert.deepEqual(fs.readdirSync(queue), []);
	assert.equal(fs.existsSync(`${queue}.identity`), false);
	assert.throws(() => gate.spawn(process.execPath, ["-e", "process.exit(0)"]), /admission is closed/);
	await stop(child);
	const result = await gate.drainAndMigrate({ timeoutMs: 500 });
	assert.deepEqual(fs.readdirSync(result.preservedQueue), []);
	(await new PersistentFileMutex(result.lockPath).acquire({ timeoutMs: 500 }))();
});

test("legacy live holder must exit; preserved ticket bytes are never cleaned or overwritten", async t => {
	const { gate, queue } = fixture(t);
	const ticket = path.join(queue, "old-holder.json");
	const child = await writer(t, gate, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ticket)}, 'historical-holder'); process.on('message', () => process.exit(0)); process.send('holding');`);
	await assert.rejects(gate.drainAndMigrate({ timeoutMs: 10 }), /not exited/);
	assert.equal(fs.readFileSync(ticket, "utf8"), "historical-holder");
	await stop(child);
	const result = await gate.drainAndMigrate({ timeoutMs: 500 });
	assert.equal(fs.readFileSync(path.join(result.preservedQueue, "old-holder.json"), "utf8"), "historical-holder");
	assert.deepEqual(fs.readdirSync(queue), []);
});

test("closing admission is synchronous while existing writers drain", async t => {
	const { gate } = fixture(t);
	const child = await writer(t, gate, 'process.on("message", () => process.exit(0)); process.send("ready");');
	const draining = gate.drainAndMigrate({ timeoutMs: 1000 });
	assert.throws(() => gate.spawn(process.execPath), /admission is closed/);
	await assert.rejects(gate.drainAndMigrate({ timeoutMs: 1 }), /already running/);
	await stop(child);
	await draining;
});

test("a restarted gate cannot reconstruct unknown liveness from disk or an empty queue", t => {
	const { scope, queue } = fixture(t);
	assert.throws(() => LegacyWriterLifecycle.create(scope), /new managed namespace required/);
	assert.deepEqual(fs.readdirSync(queue), []);
});

test("preexisting unmanaged scope is never adopted", t => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-unmanaged-"));
	t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
	const queue = path.join(parent, "writer.lock.queue");
	fs.mkdirSync(queue);
	fs.writeFileSync(path.join(queue, "old-ticket"), "keep");
	assert.throws(() => LegacyWriterLifecycle.create(parent), /new managed namespace required/);
	assert.equal(fs.readFileSync(path.join(queue, "old-ticket"), "utf8"), "keep");
});

for (const changed of ["deleted", "replaced", "corrupted"] as const) {
	test(`missing or ${changed} lifecycle evidence cannot authorize migration`, async t => {
		const { gate, scope, queue } = fixture(t);
		const marker = path.join(scope, "lifecycle.json");
		if (changed === "corrupted") fs.writeFileSync(marker, "{}");
		else {
			const bytes = fs.readFileSync(marker);
			fs.renameSync(marker, `${marker}.saved`);
			if (changed === "replaced") fs.writeFileSync(marker, bytes);
		}
		await assert.rejects(gate.drainAndMigrate({ timeoutMs: 0 }), /lifecycle evidence/);
		assert.equal(fs.existsSync(queue), true);
		assert.equal(fs.existsSync(`${queue}.identity`), false);
	});
}

test("root replacement rejects stale gate", async t => {
	const { gate, scope } = fixture(t);
	fs.renameSync(scope, `${scope}.saved`);
	fs.mkdirSync(scope);
	await assert.rejects(gate.drainAndMigrate({ timeoutMs: 0 }), /namespace replaced/);
	assert.deepEqual(fs.readdirSync(scope), []);
});

test("partial new-protocol evidence must not be erased as a legacy migration", async t => {
	const { gate, queue } = fixture(t);
	fs.writeFileSync(`${queue}.initialized`, "corrupt");
	await assert.rejects(gate.drainAndMigrate({ timeoutMs: 0 }), /partial initialization/);
	assert.equal(fs.readFileSync(`${queue}.initialized`, "utf8"), "corrupt");
	assert.equal(fs.existsSync(queue), true);
});

test("daemonizing options cannot enter direct-child lifecycle", t => {
	const { gate } = fixture(t);
	assert.throws(() => gate.spawn(process.execPath, [], { detached: true }), /external service exclusion/);
	assert.throws(() => gate.spawn(process.execPath, [], { shell: true }), /external service exclusion/);
});

test("missing old queue never becomes implicit successful migration", async t => {
	const { gate, queue } = fixture(t);
	fs.rmdirSync(queue);
	await assert.rejects(gate.drainAndMigrate({ timeoutMs: 0 }), /ENOENT/);
	assert.equal(fs.existsSync(`${queue}.identity`), false);
});

test("deleted closed-admission evidence after timeout cannot authorize retry", async t => {
	const { gate, scope, queue } = fixture(t);
	const child = await writer(t, gate, 'process.on("message", () => process.exit(0)); process.send("ready");');
	await assert.rejects(gate.drainAndMigrate({ timeoutMs: 0 }), /not exited/);
	await stop(child);
	fs.unlinkSync(path.join(scope, "admission.closed.json"));
	await assert.rejects(gate.drainAndMigrate({ timeoutMs: 0 }), /lifecycle evidence unavailable/);
	assert.equal(fs.existsSync(queue), true);
	assert.equal(fs.existsSync(`${queue}.identity`), false);
});


test("fresh process cannot reopen lifecycle after supervisor exit", async t => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-legacy-restart-"));
	t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
	const scope = path.join(parent, "managed");
	const source = new URL("../src/legacy-writer-lifecycle.ts", import.meta.url).href;
	const creator = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
		`import fs from 'node:fs'; import { LegacyWriterLifecycle } from ${JSON.stringify(source)}; const gate = LegacyWriterLifecycle.create(${JSON.stringify(scope)}); fs.mkdirSync(gate.lockPath + '.queue');`], { stdio: "pipe" });
	const [code] = await once(creator, "exit");
	assert.equal(code, 0);
	assert.throws(() => LegacyWriterLifecycle.create(scope), /new managed namespace required/);
	assert.equal(fs.existsSync(path.join(scope, "writer.lock.queue.identity")), false);
});


test("completed migration cannot replay success after initialization evidence deletion", async t => {
	const { gate, queue } = fixture(t);
	const result = await gate.drainAndMigrate({ timeoutMs: 0 });
	assert.deepEqual(await gate.drainAndMigrate({ timeoutMs: 0 }), result);
	fs.unlinkSync(`${queue}.initialized`);
	await assert.rejects(gate.drainAndMigrate({ timeoutMs: 0 }), /completed migration evidence unavailable/);
});
