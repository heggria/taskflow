import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";

const UNIX_ONLY = { skip: process.platform === "win32" } as const;

function setup(t: TestContext): { root: string; start: (role: string, hook?: string) => ChildProcess } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-store-lock-race-"));
	const children: ChildProcess[] = [];
	t.after(async () => {
		await Promise.all(children.map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exit = once(child, "exit");
			child.kill("SIGKILL");
			await exit;
		}));
		fs.rmSync(root, { recursive: true, force: true });
	});
	return { root, start: (role, hook = "none") => {
		const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types",
			path.join(import.meta.dirname, "fixtures/store-lock-race.ts"), root, role, hook], { stdio: ["ignore", "ignore", "pipe"] });
		children.push(child);
		return child;
	} };
}

async function waitFor(root: string, role: string, outcomes: string[]): Promise<string> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		for (const outcome of outcomes) if (fs.existsSync(path.join(root, `${role}-${outcome}`))) return outcome;
		await delay(10);
	}
	throw new Error(`timed out waiting for ${role}: ${outcomes.join(", ")}`);
}

function resume(root: string, role: string): void { fs.writeFileSync(path.join(root, `${role}-resume`), ""); }

test("store lock: preparing an owner file cannot expose an empty claim", UNIX_ONLY, async (t) => {
	const { root, start } = setup(t);
	start("first", "candidate");
	await waitFor(root, "first", ["paused"]);
	assert.equal(fs.existsSync(path.join(root, "store/writer.lock")), false);
	start("second");
	assert.equal(await waitFor(root, "second", ["acquired", "rejected"]), "acquired");
	resume(root, "first");
	assert.equal(await waitFor(root, "first", ["acquired", "rejected"]), "rejected");
});

test("store lock: a published owner is complete before acquisition returns", UNIX_ONLY, async (t) => {
	const { root, start } = setup(t);
	const first = start("first", "published");
	await waitFor(root, "first", ["paused"]);
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "store/writer.lock"), "utf8")).pid, first.pid);
	start("second");
	assert.equal(await waitFor(root, "second", ["acquired", "rejected"]), "rejected");
	resume(root, "first");
	assert.equal(await waitFor(root, "first", ["acquired", "rejected"]), "acquired");
});

test("store lock: stale observers cannot remove a replacement writer", UNIX_ONLY, async (t) => {
	const { root, start } = setup(t);
	const dead = start("dead");
	assert.equal(await waitFor(root, "dead", ["acquired", "rejected"]), "acquired");
	const exited = once(dead, "exit");
	dead.kill("SIGKILL");
	await exited;
	start("slow", "stale-observed");
	await waitFor(root, "slow", ["paused"]);
	const winner = start("winner");
	assert.equal(await waitFor(root, "winner", ["acquired", "rejected"]), "acquired");
	resume(root, "slow");
	assert.equal(await waitFor(root, "slow", ["acquired", "rejected"]), "rejected");
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "store/writer.lock"), "utf8")).pid, winner.pid);
	assert.equal(winner.exitCode, null);
});

test("store lock: simultaneous stale-lock reclaimers produce one live writer", UNIX_ONLY, async (t) => {
	const { root, start } = setup(t);
	const dead = start("dead");
	await waitFor(root, "dead", ["acquired"]);
	const exited = once(dead, "exit");
	dead.kill("SIGKILL");
	await exited;
	const roles = ["a", "b", "c", "d"];
	for (const role of roles) start(role, "stale-observed");
	await Promise.all(roles.map((role) => waitFor(root, role, ["paused"])));
	for (const role of roles) resume(root, role);
	const results = await Promise.all(roles.map((role) => waitFor(root, role, ["acquired", "rejected"])));
	assert.equal(results.filter((outcome) => outcome === "acquired").length, 1);
});

test("store lock: interrupted reclamation keeps ambiguous ownership fail-closed", UNIX_ONLY, async (t) => {
	const { root, start } = setup(t);
	const dead = start("dead");
	await waitFor(root, "dead", ["acquired"]);
	const exited = once(dead, "exit");
	dead.kill("SIGKILL");
	await exited;
	const reclaimer = start("reclaimer", "reclaim-claimed");
	await waitFor(root, "reclaimer", ["paused"]);
	const stopped = once(reclaimer, "exit");
	reclaimer.kill("SIGKILL");
	await stopped;
	start("contender");
	assert.equal(await waitFor(root, "contender", ["acquired", "rejected"]), "rejected");
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "store/writer.lock"), "utf8")).pid, dead.pid);
});
