/**
 * Singleton stale-owner safety (P13 / §23).
 *
 * A dead-looking PID is not a compare-and-delete capability: PID reuse and
 * pathname replacement can occur after observation. Until an OS-backed
 * holder-identity/atomic-replacement protocol exists, automatic stale steal
 * must fail closed rather than unlinking a pathname it no longer proves owns.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	acquireOrAttachSingleton,
	ControlStoreDurabilityError,
	createControlHost,
	createMockExecutionProvider,
	isWriterStillAuthoritative,
	openUserCoordinatorStore,
	releaseSingleton,
	singletonLockPath,
	withExclusiveLockFile,
	writeFileAtomic,
} from "../src/index.ts";

const commonJsFs = createRequire(import.meta.url)("node:fs") as typeof fs;

function patchBuiltinFsMethod(method: string, replacement: unknown): void {
	if (!Reflect.set(commonJsFs, method, replacement)) {
		throw new Error(`could not patch node:fs.${method} for this isolated test`);
	}
	syncBuiltinESMExports();
}

function assertDurabilityFailure(error: unknown): boolean {
	assert.equal((error as { code?: string }).code, "TF_DURABILITY_FAILED", String(error));
	return true;
}

function assertAuthorityRevoked(error: unknown): boolean {
	assert.equal((error as { code?: string }).code, "TF_AUTHORITY_REVOKED", String(error));
	return true;
}

test("exclusive lock: a stale-looking directory is never auto-reclaimed", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-safe-lock-"));
	const lockPath = path.join(root, "critical.lock");
	const ownerPath = path.join(lockPath, "owner.json");
	try {
		fs.mkdirSync(lockPath);
		fs.writeFileSync(
			ownerPath,
			JSON.stringify({ pid: 2_147_483_646, at: Date.now() - 60_000 }),
			"utf-8",
		);
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lockPath, old, old);
		const before = fs.readFileSync(ownerPath, "utf-8");
		let entered = false;

		assert.throws(
			() =>
				withExclusiveLockFile(
					lockPath,
					() => {
						entered = true;
					},
					{ maxAttempts: 2, staleMs: 0 },
				),
			assertDurabilityFailure,
		);
		assert.equal(entered, false);
		assert.equal(fs.readFileSync(ownerPath, "utf-8"), before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("exclusive lock: an EEXIST thrown by the critical section is not mistaken for contention", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-lock-eexist-"));
	const lockPath = path.join(root, "critical.lock");
	try {
		const expected = Object.assign(new Error("application EEXIST"), { code: "EEXIST" });
		assert.throws(
			() =>
				withExclusiveLockFile(lockPath, () => {
					throw expected;
				}),
			(error: unknown) => error === expected,
		);
		assert.equal(fs.existsSync(lockPath), false, "owner release must still remove its lock");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("stale singleton lock (dead pid) fails closed without replacing its pathname", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-stale-home-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		// Plant a lock owned by a non-existent PID
		const lockPath = singletonLockPath(env);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileAtomic(
			lockPath,
			JSON.stringify({
				holderId: "dead-holder",
				pid: 2_147_483_646, // almost certainly not a live process
				fencingEpoch: 1,
				endpoint: path.join(path.dirname(lockPath), "taskflowd.sock"),
				acquiredAt: Date.now() - 60_000,
			}),
		);

		const before = fs.readFileSync(lockPath, "utf-8");
		assert.throws(() => acquireOrAttachSingleton("rescuer", env), assertDurabilityFailure);
		assert.equal(
			fs.readFileSync(lockPath, "utf-8"),
			before,
			"automatic recovery must not unlink or overwrite a dead-looking owner pathname",
		);
		assert.equal(
			fs.existsSync(`${lockPath}.epoch.json`),
			false,
			"failed stale recovery must not burn/publish a replacement epoch",
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("singleton: corrupt owner record fails closed instead of being treated as a dead owner", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-corrupt-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const lockPath = singletonLockPath(env);
	try {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, "{ incomplete owner", "utf-8");

		assert.throws(() => acquireOrAttachSingleton("rescuer", env), assertDurabilityFailure);
		assert.equal(fs.readFileSync(lockPath, "utf-8"), "{ incomplete owner");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("singleton: a live PID cannot redirect an attach client to a foreign UDS endpoint", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-endpoint-home-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const lockPath = singletonLockPath(env);
	try {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileAtomic(
			lockPath,
			JSON.stringify({
				holderId: "live-but-foreign-endpoint",
				pid: process.pid,
				fencingEpoch: 7,
				endpoint: path.join(os.tmpdir(), "untrusted-taskflowd.sock"),
				acquiredAt: Date.now(),
			}),
		);

		assert.throws(() => acquireOrAttachSingleton("would-attach", env), assertDurabilityFailure);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test(
	"singleton: a symlinked user control root fails closed without publishing external authority state",
	{ skip: process.platform === "win32" },
	() => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-symlink-home-"));
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-symlink-target-"));
		const env = { ...process.env, TASKFLOW_HOME: home };
		const sentinelPath = path.join(external, "must-not-change");
		try {
			fs.writeFileSync(sentinelPath, "outside singleton target", "utf-8");
			fs.symlinkSync(external, path.join(home, ".taskflow"), "dir");

			assert.throws(() => acquireOrAttachSingleton("blocked-by-symlink", env), assertDurabilityFailure);
			assert.deepEqual(fs.readdirSync(external).sort(), ["must-not-change"]);
			assert.equal(fs.readFileSync(sentinelPath, "utf-8"), "outside singleton target");
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(external, { recursive: true, force: true });
		}
	},
);

test("singleton fencing: clean release never reuses an epoch for the same holder and PID", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-epoch-home-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const first = acquireOrAttachSingleton("same-holder", env);
		assert.equal(first.role, "writer");
		if (first.role !== "writer") throw new Error("expected writer");
		releaseSingleton(first.mutationAuthority, env);

		const second = acquireOrAttachSingleton("same-holder", env);
		assert.equal(second.role, "writer");
		assert.ok(second.lock.fencingEpoch > first.lock.fencingEpoch);
		assert.equal(isWriterStillAuthoritative(first.lock, env), false);
		if (second.role !== "writer") throw new Error("expected writer");
		releaseSingleton(second.mutationAuthority, env);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("singleton authority: copied durable owner bytes cannot release the live writer", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-copy-release-home-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const writer = acquireOrAttachSingleton("capability-writer", env);
		assert.equal(writer.role, "writer");
		if (writer.role !== "writer") throw new Error("expected writer");
		const copiedRecord = JSON.parse(fs.readFileSync(singletonLockPath(env), "utf-8")) as unknown;

		assert.throws(
			() => releaseSingleton(copiedRecord as never, env),
			assertAuthorityRevoked,
			"a readable serialized owner record must not be a release capability",
		);
		assert.equal(
			isWriterStillAuthoritative(writer.lock, env),
			true,
			"the copied record must leave the live writer authoritative",
		);

		releaseSingleton(writer.mutationAuthority, env);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("singleton authority: a raw global coordinator cannot initialize or reserve epoch zero", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-coordinator-raw-global-home-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const coordinatorRoot = path.join(home, ".taskflow", "control", "coordinator");
	const statePath = path.join(coordinatorRoot, "state.json");
	const anchorPath = path.join(path.dirname(coordinatorRoot), "coordinator.anchor.json");
	try {
		assert.throws(
			() => openUserCoordinatorStore(env).reserve(),
			assertAuthorityRevoked,
		);
		assert.equal(fs.existsSync(statePath), false, "denial must precede coordinator state initialization");
		assert.equal(fs.existsSync(anchorPath), false, "denial must precede coordinator anchor publication");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("singleton authority: the live capability derives reservation epoch and baseDir cannot alias global state", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-coordinator-capability-home-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const globalCoordinatorDir = path.join(home, ".taskflow", "control", "coordinator");
	try {
		const writer = acquireOrAttachSingleton("coordinator-capability-writer", env);
		assert.equal(writer.role, "writer");
		if (writer.role !== "writer") throw new Error("expected writer");

		assert.throws(
			() =>
				openUserCoordinatorStore(env, {
					baseDir: globalCoordinatorDir,
				}).reserve(),
			assertAuthorityRevoked,
			"the explicit project-local route must not alias the user-global ledger",
		);
		assert.throws(
			() =>
				openUserCoordinatorStore(env, {
					mutationAuthority: Object.freeze({}) as never,
				}).reserve(),
			assertAuthorityRevoked,
			"a caller-created object must not be accepted as a process-held capability",
		);

		const coordinator = openUserCoordinatorStore(env, {
			mutationAuthority: writer.mutationAuthority,
		});
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		assert.equal(
			reservation.coordinatorEpoch,
			writer.lock.fencingEpoch,
			"the durable reservation epoch must be derived from the live capability",
		);
		releaseSingleton(writer.mutationAuthority, env);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("singleton: candidate close failure is typed and leaves no unpublished candidate", { concurrency: false }, () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-candidate-close-home-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	const lockPath = singletonLockPath(env);
	const originalOpenSync = commonJsFs.openSync;
	const originalCloseSync = commonJsFs.closeSync;
	const closeFailure = new Error("injected singleton candidate close failure");
	let candidateFd: number | undefined;
	let candidatePath: string | undefined;
	const patchedOpenSync = ((...args: Parameters<typeof fs.openSync>): number => {
		const fd = originalOpenSync(...args);
		if (typeof args[0] === "string" && args[0].endsWith(".candidate")) {
			candidateFd = fd;
			candidatePath = args[0];
		}
		return fd;
	}) as typeof fs.openSync;
	const patchedCloseSync = ((fd: number): void => {
		if (fd !== candidateFd) return originalCloseSync(fd);
		originalCloseSync(fd);
		throw closeFailure;
	}) as typeof fs.closeSync;
	try {
		patchBuiltinFsMethod("openSync", patchedOpenSync);
		patchBuiltinFsMethod("closeSync", patchedCloseSync);
		assert.throws(
			() => acquireOrAttachSingleton("candidate-close", env),
			(error) =>
				error instanceof ControlStoreDurabilityError &&
				error.cause === closeFailure &&
				candidatePath !== undefined &&
				error.filePath === candidatePath,
		);
		assert.notEqual(candidateFd, undefined, "the injected fault must target the candidate descriptor");
		assert.ok(candidatePath, "the singleton acquisition must create an unpublished candidate");
		assert.equal(fs.existsSync(candidatePath), false, "failed candidate publication must clean up the temp file");
		assert.equal(fs.existsSync(lockPath), false, "failed candidate publication must not create an authority owner");
	} finally {
		patchBuiltinFsMethod("closeSync", originalCloseSync);
		patchBuiltinFsMethod("openSync", originalOpenSync);
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("singleton fencing: a host that loses its epoch cannot admit or release the replacement owner", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-fence-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-fence-project-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		host = createControlHost({
			projectRoot: project,
			env,
			controlMode: "auto",
			provider: createMockExecutionProvider({ outcome: "completed" }),
		});
		assert.equal(host.role, "writer");
		assert.ok(host.singleton);
		const oldLock = host.singleton!.lock;
		const replacement = {
			...oldLock,
			holderId: "replacement-owner",
			fencingEpoch: oldLock.fencingEpoch + 1,
			acquiredAt: Date.now(),
		};
		writeFileAtomic(singletonLockPath(env), JSON.stringify(replacement, null, 2));

		assert.equal(host.canMutate, false, "old epoch must be fenced before any new mutation");
		const result = await host.admitAndRun({
			program: {
				name: "fenced",
				phases: [{ id: "main", type: "script", run: "true", final: true }],
			},
		});
		assert.equal(result.ok, false);
		assert.equal(result.error?.code, "TF_AUTHORITY_REVOKED");

		host.close();
		host = undefined;
		const durable = JSON.parse(fs.readFileSync(singletonLockPath(env), "utf-8")) as {
			holderId: string;
			fencingEpoch: number;
		};
		assert.equal(durable.holderId, replacement.holderId);
		assert.equal(durable.fencingEpoch, replacement.fencingEpoch);
	} finally {
		host?.close();
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});

test("singleton fencing: direct ControlStore and Coordinator mutations are fenced under takeover", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-mutation-fence-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-singleton-mutation-fence-project-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	let host: ReturnType<typeof createControlHost> | undefined;
	try {
		host = createControlHost({
			projectRoot: project,
			env,
			controlMode: "auto",
			provider: createMockExecutionProvider({ outcome: "completed" }),
		});
		assert.ok(host.singleton);
		const oldLock = host.singleton!.lock;
		writeFileAtomic(
			singletonLockPath(env),
			JSON.stringify(
				{
					...oldLock,
					holderId: "replacement-owner",
					fencingEpoch: oldLock.fencingEpoch + 1,
					acquiredAt: Date.now(),
				},
				null,
				2,
			),
		);

		assert.throws(
			() =>
				host!.store.claimCommand({
					commandId: "fenced-command",
					requestHash: "request-hash",
					callerPrincipal: "local",
					kind: "admitAndRun",
					runId: "fenced-run",
				}),
			assertAuthorityRevoked,
		);
		assert.equal(host.store.getCommand("fenced-command"), null);
		assert.throws(
			() => host!.coordinator.reserve(),
			assertAuthorityRevoked,
		);
		assert.equal(host.coordinator.occupyingCount(), 0);
	} finally {
		host?.close();
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});
