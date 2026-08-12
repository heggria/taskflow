import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireUserSingleton,
	assertFencing,
	readCoordinatorLease,
	recoverStaleEndpoint,
	releaseUserSingleton,
	singletonPaths,
	type SingletonAcquireResult,
	type SingletonPaths,
} from "../src/singleton.ts";
import { ControlError } from "../src/errors.ts";

const tempRoots: string[] = [];

function makePaths(): SingletonPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-control-singleton-"));
	tempRoots.push(root);
	return singletonPaths(root);
}

after(() => {
	for (const root of tempRoots) {
		try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});

const DEAD_PID = 2 ** 22 + 7; // guaranteed-unassigned pid range

function deadOwnerInspector() {
	return () => ({ alive: false } as const);
}

test("singleton: first acquirer wins, second attaches to the winner (D32 — no dual authority)", () => {
	const paths = makePaths();
	const first = acquireUserSingleton({ paths, holderId: "holder-a" });
	assert.equal(first.status, "won");
	assert.equal(first.fencingEpoch, 1);

	const second = acquireUserSingleton({ paths, holderId: "holder-b" });
	assert.equal(second.status, "attached");
	assert.equal(second.holderId, "holder-a");
	assert.equal(second.endpoint, paths.endpointPath);

	first.release();
	const third = acquireUserSingleton({ paths, holderId: "holder-c" });
	assert.equal(third.status, "won");
	third.release();
});

test("singleton: release is compare-and-delete — a foreign holder cannot release the winner's lock", () => {
	const paths = makePaths();
	const first = acquireUserSingleton({ paths, holderId: "holder-a" });
	assert.equal(first.status, "won");
	const stat = fs.statSync(paths.lockPath, { bigint: true });
	// A stale release with the wrong inode/token must not remove the live lock.
	releaseUserSingleton(paths, { holderId: "someone-else", dev: stat.dev + 1n, ino: stat.ino + 1n });
	const second = acquireUserSingleton({ paths, holderId: "holder-b" });
	assert.equal(second.status, "attached", "the live lock must survive a foreign release attempt");
	first.release();
});

test("singleton: malformed lock metadata fails closed (P13)", () => {
	const paths = makePaths();
	fs.mkdirSync(paths.controlHome, { recursive: true });
	fs.writeFileSync(paths.lockPath, JSON.stringify({ version: 99, junk: true }));
	assert.throws(() => acquireUserSingleton({ paths }), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_BOOTSTRAP_FAILED");
		assert.match((error as ControlError).message, /malformed singleton lock record/);
		return true;
	});
});

test("singleton: stale endpoint recovery removes a dead peer's socket", () => {
	const paths = makePaths();
	fs.mkdirSync(paths.controlHome, { recursive: true });
	fs.writeFileSync(paths.endpointPath, "stale");
	// No lock at all → orphaned socket is stale.
	assert.equal(recoverStaleEndpoint(paths), true);
	assert.equal(fs.existsSync(paths.endpointPath), false);

	// Dead owner + socket → removed.
	fs.writeFileSync(paths.endpointPath, "stale-2");
	fs.writeFileSync(
		paths.lockPath,
		JSON.stringify({
			version: 1,
			holderId: "dead-holder",
			pid: DEAD_PID,
			birthToken: "linux:dead-boot:0",
			birthTokenKind: "native",
			fencingEpoch: 1,
			endpoint: paths.endpointPath,
			acquiredAt: 1,
		}),
	);
	assert.equal(recoverStaleEndpoint(paths, { inspectProcess: deadOwnerInspector() }), true);
	assert.equal(fs.existsSync(paths.endpointPath), false);

	// Live owner + socket → untouched (belongs to the winner).
	const live = acquireUserSingleton({ paths, holderId: "live-holder" });
	assert.equal(live.status, "won");
	fs.writeFileSync(paths.endpointPath, "live-socket");
	assert.equal(recoverStaleEndpoint(paths), false);
	assert.equal(fs.existsSync(paths.endpointPath), true);
	live.release();
});

test("singleton: stale endpoint recovery happens before a fresh acquire", () => {
	const paths = makePaths();
	// Simulate a crashed previous holder: dead pid lock + orphaned socket.
	fs.mkdirSync(paths.controlHome, { recursive: true });
	fs.writeFileSync(paths.endpointPath, "orphan");
	fs.writeFileSync(
		paths.lockPath,
		JSON.stringify({
			version: 1,
			holderId: "crashed",
			pid: DEAD_PID,
			birthToken: "linux:dead-boot:0",
			birthTokenKind: "native",
			fencingEpoch: 3,
			endpoint: paths.endpointPath,
			acquiredAt: 2,
		}),
	);
	// ControlHost.start() performs recovery before competing for the lock
	// (fresh-install contract §5.2(4)) — same sequence the host runs.
	const recovered = recoverStaleEndpoint(paths, { inspectProcess: deadOwnerInspector() });
	assert.equal(recovered, true);
	assert.equal(fs.existsSync(paths.endpointPath), false);
	const result = acquireUserSingleton({ paths, holderId: "fresh", inspectProcess: deadOwnerInspector() });
	assert.equal(result.status, "won");
	// Fencing epoch bumps on reclaim (3 → 4).
	assert.equal((result as Extract<SingletonAcquireResult, { status: "won" }>).fencingEpoch, 4);
	result.release();
});

test("singleton: attach-only (coordinated) fails closed when no live control exists", () => {
	const paths = makePaths();
	assert.throws(
		() => acquireUserSingleton({ paths, attachOnly: true }),
		(error: unknown) => {
			assert.ok(error instanceof ControlError);
			assert.equal((error as ControlError).code, "TF_JOURNAL_UNAVAILABLE");
			return true;
		},
	);
});

test("singleton: attach-only attaches when a live winner exists", () => {
	const paths = makePaths();
	const winner = acquireUserSingleton({ paths, holderId: "winner" });
	assert.equal(winner.status, "won");
	const attached = acquireUserSingleton({ paths, holderId: "client", attachOnly: true });
	assert.equal(attached.status, "attached");
	assert.equal(attached.holderId, "winner");
	winner.release();
});

test("singleton: attach-only fails closed on a dead winner (does not start a new control)", () => {
	const paths = makePaths();
	fs.mkdirSync(paths.controlHome, { recursive: true });
	fs.writeFileSync(
		paths.lockPath,
		JSON.stringify({
			version: 1,
			holderId: "dead-winner",
			pid: DEAD_PID,
			birthToken: "linux:dead-boot:0",
			birthTokenKind: "native",
			fencingEpoch: 1,
			endpoint: paths.endpointPath,
			acquiredAt: 1,
		}),
	);
	assert.throws(
		() => acquireUserSingleton({ paths, attachOnly: true, inspectProcess: deadOwnerInspector() }),
		(error: unknown) => {
			assert.ok(error instanceof ControlError);
			assert.equal((error as ControlError).code, "TF_JOURNAL_UNAVAILABLE");
			return true;
		},
	);
});

test("singleton: fencing — a stale epoch is rejected (TF_AUTHORITY_REVOKED)", () => {
	const paths = makePaths();
	const first = acquireUserSingleton({ paths, holderId: "holder-a" });
	assert.equal(first.status, "won");
	const lease = readCoordinatorLease(paths);
	assert.ok(lease !== null);
	assert.equal(lease.fencingEpoch, 1);
	// A missing lease is unverifiable → fail closed.
	assert.throws(() => assertFencing(null, 1), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_AUTHORITY_REVOKED");
		return true;
	});
	// Claiming epoch 0 against a lease at epoch 1 is stale.
	assert.throws(() => assertFencing(lease, 0), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_AUTHORITY_REVOKED");
		return true;
	});
	// Epoch 1 (or newer) is accepted.
	assertFencing(lease, 1);
	first.release();
});

test("singleton: reclaim bumps the fencing epoch so the old holder is fenced out", () => {
	const paths = makePaths();
	const first = acquireUserSingleton({ paths, holderId: "holder-a" });
	assert.equal(first.status, "won");
	assert.equal(first.fencingEpoch, 1);
	// Simulate holder-a crash: its lock record now references a dead pid.
	first.release();
	fs.writeFileSync(
		paths.lockPath,
		JSON.stringify({
			version: 1,
			holderId: "holder-a",
			pid: DEAD_PID,
			birthToken: "linux:dead-boot:0",
			birthTokenKind: "native",
			fencingEpoch: 1,
			endpoint: paths.endpointPath,
			acquiredAt: 1,
		}),
	);
	const second = acquireUserSingleton({ paths, holderId: "holder-b", inspectProcess: deadOwnerInspector() });
	assert.equal(second.status, "won");
	assert.equal(second.fencingEpoch, 2);
	// Old holder's RPC with epoch 1 must now be rejected by the lease gate.
	assert.throws(() => assertFencing({ holderId: "holder-b", fencingEpoch: 2, endpoint: paths.endpointPath, expiresAt: 0 }, 1), ControlError);
	second.release();
});
