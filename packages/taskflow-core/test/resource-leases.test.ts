import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
	PersistentLeaseCoordinator,
	type ExecutionOwner,
	type LeaseRequest,
} from "../src/resources/leases.ts";

const OWNER: ExecutionOwner = {
	runId: "run",
	phaseId: "phase",
	attemptId: "attempt",
	unitId: "unit",
	ancestry: [],
};

function request(prefix: string, access: "read-only" | "read-write", owner = OWNER, domain = "repo"): LeaseRequest {
	return { key: { resourceDomainId: domain, canonicalPrefix: prefix }, access, owner };
}

function childScript(moduleUrl: string, directory: string, prefix: string, timeoutMs: number, release: boolean): string {
	return `
		import { PersistentLeaseCoordinator } from ${JSON.stringify(moduleUrl)};
		const coordinator = new PersistentLeaseCoordinator({ directory: ${JSON.stringify(directory)}, registryId: "registry", pollMs: 5 });
		const owner = { runId: "child", phaseId: "phase", attemptId: "attempt-child", unitId: "unit", ancestry: [] };
		try {
			const handle = await coordinator.acquire([{ key: { resourceDomainId: "repo", canonicalPrefix: ${JSON.stringify(prefix)} }, access: "read-write", owner }], { timeoutMs: ${timeoutMs} });
			process.stdout.write("ACQUIRED");
			${release ? "await handle.release();" : ""}
			process.exit(0);
		} catch (error) {
			process.stdout.write(String(error?.code ?? error?.name ?? error));
			process.exit(0);
		}
	`;
}

test("persistent leases: overlap uses resource domain and RO/RO remains concurrent", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-leases-"));
	const root = path.join(dir, "repo");
	fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
	try {
		const coordinator = new PersistentLeaseCoordinator({ directory: path.join(dir, "control"), registryId: "registry", pollMs: 5 });
		const roParent = await coordinator.acquire([request(root, "read-only")]);
		const roChild = await coordinator.acquire([request(path.join(root, "pkg"), "read-only", { ...OWNER, attemptId: "reader-2" })]);
		await assert.rejects(
			coordinator.acquire([request(path.join(root, "pkg"), "read-write", { ...OWNER, attemptId: "writer" })], { timeoutMs: 35 }),
			(error: unknown) => (error as { code?: string }).code === "TFWS_LEASE_TIMEOUT",
		);
		// Identical physical prefixes in independent domains do not alias.
		const otherDomain = await coordinator.acquire([request(root, "read-write", { ...OWNER, attemptId: "other" }, "isolated-domain")]);
		await otherDomain.release();
		await roChild.release();
		await roParent.release();
		const writer = await coordinator.acquire([request(path.join(root, "pkg"), "read-write")]);
		await writer.release();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("persistent leases: multi-key acquisition is sorted and never leaves a partial hold", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-leases-atomic-"));
	const a = path.join(dir, "a");
	const b = path.join(dir, "b");
	fs.mkdirSync(a);
	fs.mkdirSync(b);
	try {
		const coordinator = new PersistentLeaseCoordinator({ directory: path.join(dir, "control"), registryId: "registry", pollMs: 5 });
		const blocker = await coordinator.acquire([request(b, "read-write", { ...OWNER, attemptId: "blocker" })]);
		await assert.rejects(
			coordinator.acquire([
				request(b, "read-write", { ...OWNER, attemptId: "multi" }),
				request(a, "read-write", { ...OWNER, attemptId: "multi" }),
			], { timeoutMs: 35 }),
			(error: unknown) => (error as { code?: string }).code === "TFWS_LEASE_TIMEOUT",
		);
		// If the failed multi-acquire had partially reserved A this would time out.
		const free = await coordinator.acquire([request(a, "read-write", { ...OWNER, attemptId: "free" })], { timeoutMs: 35 });
		await free.release();
		await blocker.release();
		const multi = await coordinator.acquire([
			request(b, "read-write", { ...OWNER, attemptId: "multi-2" }),
			request(a, "read-write", { ...OWNER, attemptId: "multi-2" }),
		]);
		assert.deepEqual(multi.requests.map((item) => item.key.canonicalPrefix), [a, b]);
		await multi.release();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("persistent leases: abort cancels waiters but never revokes a granted writer", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-leases-abort-"));
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	try {
		const coordinator = new PersistentLeaseCoordinator({ directory: path.join(dir, "control"), registryId: "registry", pollMs: 5 });
		const controller = new AbortController();
		const held = await coordinator.acquire([request(root, "read-only")], { signal: controller.signal });
		controller.abort();
		assert.equal((await coordinator.list()).length, 1);
		await assert.rejects(
			coordinator.acquire([request(root, "read-write", { ...OWNER, attemptId: "must-wait" })], { timeoutMs: 35 }),
			(error: unknown) => (error as { code?: string }).code === "TFWS_LEASE_TIMEOUT",
		);
		await held.release();
		assert.equal((await coordinator.list()).length, 0);

		const blocker = await coordinator.acquire([request(root, "read-write", { ...OWNER, attemptId: "blocker" })]);
		const waitingAbort = new AbortController();
		const pending = coordinator.acquire([request(root, "read-write", { ...OWNER, attemptId: "waiter" })], {
			timeoutMs: 1_000,
			signal: waitingAbort.signal,
		});
		setTimeout(() => waitingAbort.abort(), 20);
		await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === "ABORT_ERR");
		await blocker.release();
		assert.equal((await coordinator.list()).length, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("persistent leases: durable release marker survives coordinator-local cleanup loss", async (t) => {
	if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
		return t.skip("permission fault injection requires a non-root POSIX process");
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-leases-release-fault-"));
	const control = path.join(dir, "control");
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	t.mock.method(console, "warn", () => undefined);
	try {
		const first = new PersistentLeaseCoordinator({ directory: control, registryId: "registry", pollMs: 1 });
		const held = await first.acquire([request(root, "read-write")]);
		fs.chmodSync(control, 0o500);
		await held.release();
		fs.chmodSync(control, 0o700);

		const nextSession = new PersistentLeaseCoordinator({ directory: control, registryId: "registry", pollMs: 1 });
		const next = await nextSession.acquire([
			request(root, "read-write", { ...OWNER, attemptId: "after-terminal-marker" }),
		], { timeoutMs: 500 });
		await next.release();
		assert.equal((await nextSession.list()).length, 0);
		assert.equal(
			fs.readdirSync(control).some((name) => name.startsWith("lease-release-")),
			false,
			"terminal release markers are cleaned only after the state no longer references them",
		);
	} finally {
		try { fs.chmodSync(control, 0o700); } catch { /* best effort */ }
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("persistent leases: corrupt live marker blocks only its overlapping scope", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-leases-corrupt-live-"));
	const control = path.join(dir, "control");
	const heldRoot = path.join(dir, "held");
	const otherRoot = path.join(dir, "other");
	fs.mkdirSync(heldRoot);
	fs.mkdirSync(otherRoot);
	try {
		const coordinator = new PersistentLeaseCoordinator({ directory: control, registryId: "registry", pollMs: 1 });
		const held = await coordinator.acquire([request(heldRoot, "read-write")]);
		const markerName = fs.readdirSync(control).find((name) => name.startsWith("lease-release-"));
		assert.ok(markerName);
		fs.writeFileSync(path.join(control, markerName), "{corrupt-live-marker");

		const unrelated = await coordinator.acquire([
			request(otherRoot, "read-write", { ...OWNER, attemptId: "unrelated" }),
		], { timeoutMs: 100 });
		await unrelated.release();
		await assert.rejects(
			coordinator.acquire([
				request(heldRoot, "read-write", { ...OWNER, attemptId: "overlap" }),
			], { timeoutMs: 30 }),
			(error: unknown) => (error as { code?: string }).code === "TFWS_LEASE_TIMEOUT",
		);
		await held.release();
		assert.equal((await coordinator.list()).length, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("persistent leases: cross-process contention and dead-owner stale recovery", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-leases-process-"));
	const control = path.join(dir, "control");
	const root = path.join(dir, "repo");
	fs.mkdirSync(root);
	const moduleUrl = pathToFileURL(path.resolve("packages/taskflow-core/src/resources/leases.ts")).href;
	try {
		const coordinator = new PersistentLeaseCoordinator({ directory: control, registryId: "registry", pollMs: 5 });
		const parent = await coordinator.acquire([request(root, "read-write")]);
		const blocked = spawnSync(process.execPath, [
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			childScript(moduleUrl, control, root, 80, true),
		], { encoding: "utf8" });
		assert.equal(blocked.status, 0, blocked.stderr);
		assert.equal(blocked.stdout, "TFWS_LEASE_TIMEOUT");
		await parent.release();

		// The child exits without release. Its PID/start-time record remains on disk.
		const abandoned = spawnSync(process.execPath, [
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			childScript(moduleUrl, control, root, 500, false),
		], { encoding: "utf8" });
		assert.equal(abandoned.status, 0, abandoned.stderr);
		assert.equal(abandoned.stdout, "ACQUIRED");
		const markerPath = path.join(
			control,
			fs.readdirSync(control).find((name) => name.startsWith("lease-release-"))!,
		);
		fs.writeFileSync(markerPath, "{corrupt-terminal-marker");
		const recovered = await coordinator.acquire([request(root, "read-write", { ...OWNER, attemptId: "recovery" })], { timeoutMs: 500 });
		await recovered.release();
		assert.equal((await coordinator.list()).length, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
