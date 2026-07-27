/**
 * P14 filesystem hardening and lower-bound counterexamples for atomic writes.
 *
 * The passing lower-bound case intentionally records a remaining unsafe
 * post-open pathname race. It is NOT a GA safety proof; replace that assertion
 * only with a directory-FD / fd-to-publish protocol that removes the race.
 */
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	ControlStoreDurabilityError,
	fsyncDirectory,
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

function temporaryEntries(root: string): string[] {
	return fs.readdirSync(root).filter((entry) => entry.endsWith(".tmp"));
}

function isAtomicTemporaryPath(candidate: unknown, root: string): candidate is string {
	return (
		typeof candidate === "string" &&
		path.dirname(candidate) === root &&
		path.basename(candidate).startsWith(".durable.json.") &&
		candidate.endsWith(".tmp")
	);
}

function isDurabilityFailureFor(
	error: unknown,
	filePath: string,
	cause: unknown,
): error is ControlStoreDurabilityError {
	if (!(error instanceof ControlStoreDurabilityError)) return false;
	assert.equal(error.filePath, filePath);
	assert.equal(error.cause, cause);
	return true;
}

test(
	"P14 atomic write: a pre-created legacy temp symlink cannot redirect bytes",
	{ skip: process.platform === "win32", concurrency: false },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-temp-symlink-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-temp-symlink-outside-"));
		const target = path.join(root, "durable.json");
		const external = path.join(outside, "external-sentinel");
		const fixedNow = 1_725_000_000_000;
		const legacyTemp = `${target}.${process.pid}.${fixedNow}.tmp`;
		const originalNow = Date.now;
		try {
			fs.writeFileSync(external, "must-not-change", "utf-8");
			fs.symlinkSync(external, legacyTemp, "file");

			// The pre-hardening writer chose this exact name and opened it with "w",
			// which followed the symlink. Keep the time fixed so the counterexample is
			// deterministic rather than dependent on a millisecond race.
			Date.now = () => fixedNow;
			writeFileAtomic(target, "durable-bytes");

			assert.equal(fs.readFileSync(external, "utf-8"), "must-not-change");
			assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
			assert.equal(fs.readFileSync(target, "utf-8"), "durable-bytes");
			assert.equal(fs.lstatSync(legacyTemp).isSymbolicLink(), true);
		} finally {
			Date.now = originalNow;
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	},
);

test(
	"P14 atomic write: wx rejects a symlink planted at its generated temp pathname",
	{ skip: process.platform === "win32", concurrency: false },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-wx-symlink-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-wx-symlink-outside-"));
		const target = path.join(root, "durable.json");
		const external = path.join(outside, "external-sentinel");
		const originalOpenSync = commonJsFs.openSync;
		let plantedTemp: string | undefined;
		const patchedOpenSync = ((...args: Parameters<typeof fs.openSync>): number => {
			const [candidate] = args;
			if (
				plantedTemp === undefined &&
				isAtomicTemporaryPath(candidate, root)
			) {
				plantedTemp = candidate;
				fs.symlinkSync(external, candidate, "file");
			}
			return originalOpenSync(...args);
		}) as typeof fs.openSync;
		try {
			fs.writeFileSync(external, "must-not-change", "utf-8");
			patchBuiltinFsMethod("openSync", patchedOpenSync);
			writeFileAtomic(target, "durable-bytes");

			assert.ok(plantedTemp, "the first generated temp pathname must be planted");
			assert.equal(fs.readFileSync(external, "utf-8"), "must-not-change");
			assert.equal(fs.lstatSync(plantedTemp).isSymbolicLink(), true);
			assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
			assert.equal(fs.readFileSync(target, "utf-8"), "durable-bytes");
		} finally {
			patchBuiltinFsMethod("openSync", originalOpenSync);
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	},
);

test("P14 atomic write: write failure wins over close failure and cleans up temp", { concurrency: false }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-write-close-failure-"));
	const target = path.join(root, "durable.json");
	const originalOpenSync = commonJsFs.openSync;
	const originalWriteFileSync = commonJsFs.writeFileSync;
	const originalCloseSync = commonJsFs.closeSync;
	const writeFailure = new Error("injected write failure");
	const closeFailure = new Error("injected close failure");
	let temporaryFd: number | undefined;
	const patchedOpenSync = ((...args: Parameters<typeof fs.openSync>): number => {
		const fd = originalOpenSync(...args);
		if (isAtomicTemporaryPath(args[0], root)) temporaryFd = fd;
		return fd;
	}) as typeof fs.openSync;
	const patchedWriteFileSync = ((...args: Parameters<typeof fs.writeFileSync>): void => {
		if (args[0] === temporaryFd) throw writeFailure;
		return originalWriteFileSync(...args);
	}) as typeof fs.writeFileSync;
	const patchedCloseSync = ((fd: number): void => {
		if (fd !== temporaryFd) return originalCloseSync(fd);
		originalCloseSync(fd);
		throw closeFailure;
	}) as typeof fs.closeSync;
	try {
		patchBuiltinFsMethod("openSync", patchedOpenSync);
		patchBuiltinFsMethod("writeFileSync", patchedWriteFileSync);
		patchBuiltinFsMethod("closeSync", patchedCloseSync);
		assert.throws(() => writeFileAtomic(target, "durable-bytes"), (error) =>
			isDurabilityFailureFor(error, target, writeFailure),
		);
		assert.notEqual(temporaryFd, undefined, "the close fault must target the created temporary fd");
		assert.equal(fs.existsSync(target), false);
		assert.deepEqual(temporaryEntries(root), []);
	} finally {
		patchBuiltinFsMethod("closeSync", originalCloseSync);
		patchBuiltinFsMethod("writeFileSync", originalWriteFileSync);
		patchBuiltinFsMethod("openSync", originalOpenSync);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("P14 atomic write: fsync failure wins over close failure and cleans up temp", { concurrency: false }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-fsync-close-failure-"));
	const target = path.join(root, "durable.json");
	const originalOpenSync = commonJsFs.openSync;
	const originalFsyncSync = commonJsFs.fsyncSync;
	const originalCloseSync = commonJsFs.closeSync;
	const fsyncFailure = new Error("injected fsync failure");
	const closeFailure = new Error("injected close failure");
	let temporaryFd: number | undefined;
	const patchedOpenSync = ((...args: Parameters<typeof fs.openSync>): number => {
		const fd = originalOpenSync(...args);
		if (isAtomicTemporaryPath(args[0], root)) temporaryFd = fd;
		return fd;
	}) as typeof fs.openSync;
	const patchedFsyncSync = ((fd: number): void => {
		if (fd === temporaryFd) throw fsyncFailure;
		return originalFsyncSync(fd);
	}) as typeof fs.fsyncSync;
	const patchedCloseSync = ((fd: number): void => {
		if (fd !== temporaryFd) return originalCloseSync(fd);
		originalCloseSync(fd);
		throw closeFailure;
	}) as typeof fs.closeSync;
	try {
		patchBuiltinFsMethod("openSync", patchedOpenSync);
		patchBuiltinFsMethod("fsyncSync", patchedFsyncSync);
		patchBuiltinFsMethod("closeSync", patchedCloseSync);
		assert.throws(() => writeFileAtomic(target, "durable-bytes"), (error) =>
			isDurabilityFailureFor(error, target, fsyncFailure),
		);
		assert.notEqual(temporaryFd, undefined, "the fsync fault must target the created temporary fd");
		assert.equal(fs.existsSync(target), false);
		assert.deepEqual(temporaryEntries(root), []);
	} finally {
		patchBuiltinFsMethod("closeSync", originalCloseSync);
		patchBuiltinFsMethod("fsyncSync", originalFsyncSync);
		patchBuiltinFsMethod("openSync", originalOpenSync);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("P14 atomic write: close-only failure cleans up the temp and does not publish", { concurrency: false }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-close-failure-"));
	const target = path.join(root, "durable.json");
	const originalOpenSync = commonJsFs.openSync;
	const originalCloseSync = commonJsFs.closeSync;
	const closeFailure = new Error("injected close failure");
	let temporaryFd: number | undefined;
	const patchedOpenSync = ((...args: Parameters<typeof fs.openSync>): number => {
		const fd = originalOpenSync(...args);
		if (isAtomicTemporaryPath(args[0], root)) temporaryFd = fd;
		return fd;
	}) as typeof fs.openSync;
	const patchedCloseSync = ((fd: number): void => {
		if (fd !== temporaryFd) return originalCloseSync(fd);
		originalCloseSync(fd);
		throw closeFailure;
	}) as typeof fs.closeSync;
	try {
		patchBuiltinFsMethod("openSync", patchedOpenSync);
		patchBuiltinFsMethod("closeSync", patchedCloseSync);
		assert.throws(() => writeFileAtomic(target, "durable-bytes"), (error) =>
			isDurabilityFailureFor(error, target, closeFailure),
		);
		assert.notEqual(temporaryFd, undefined, "the close fault must target the created temporary fd");
		assert.equal(fs.existsSync(target), false);
		assert.deepEqual(temporaryEntries(root), []);
	} finally {
		patchBuiltinFsMethod("closeSync", originalCloseSync);
		patchBuiltinFsMethod("openSync", originalOpenSync);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("P14 atomic write: rename failure cleans up the temp and does not publish", { concurrency: false }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-rename-failure-"));
	const target = path.join(root, "durable.json");
	const originalRenameSync = commonJsFs.renameSync;
	const renameFailure = new Error("injected rename failure");
	let attemptedRename = false;
	const patchedRenameSync = ((...args: Parameters<typeof fs.renameSync>): void => {
		const [from, to] = args;
		if (to === target && isAtomicTemporaryPath(from, root)) {
			attemptedRename = true;
			throw renameFailure;
		}
		return originalRenameSync(...args);
	}) as typeof fs.renameSync;
	try {
		patchBuiltinFsMethod("renameSync", patchedRenameSync);
		assert.throws(() => writeFileAtomic(target, "durable-bytes"), (error) =>
			isDurabilityFailureFor(error, target, renameFailure),
		);
		assert.equal(attemptedRename, true);
		assert.equal(fs.existsSync(target), false);
		assert.deepEqual(temporaryEntries(root), []);
	} finally {
		patchBuiltinFsMethod("renameSync", originalRenameSync);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("P14 directory fsync: a real I/O failure is fail-closed", { concurrency: false }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-directory-fsync-failure-"));
	const originalOpenSync = commonJsFs.openSync;
	const originalFsyncSync = commonJsFs.fsyncSync;
	const directoryFailure = Object.assign(new Error("injected directory fsync failure"), {
		code: "EIO",
	});
	let directoryFd: number | undefined;
	const patchedOpenSync = ((...args: Parameters<typeof fs.openSync>): number => {
		const fd = originalOpenSync(...args);
		if (args[0] === root && args[1] === "r") directoryFd = fd;
		return fd;
	}) as typeof fs.openSync;
	const patchedFsyncSync = ((fd: number): void => {
		if (fd === directoryFd) throw directoryFailure;
		return originalFsyncSync(fd);
	}) as typeof fs.fsyncSync;
	try {
		patchBuiltinFsMethod("openSync", patchedOpenSync);
		patchBuiltinFsMethod("fsyncSync", patchedFsyncSync);
		assert.throws(
			() => fsyncDirectory(root),
			(error) =>
				error instanceof ControlStoreDurabilityError &&
				error.filePath === root &&
				error.cause === directoryFailure &&
				error.message.includes("directory fsync failure"),
		);
		assert.notEqual(directoryFd, undefined, "the injected fault must target a directory fd");
	} finally {
		patchBuiltinFsMethod("fsyncSync", originalFsyncSync);
		patchBuiltinFsMethod("openSync", originalOpenSync);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("P14 directory fsync: a directory close failure is fail-closed", { concurrency: false }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-directory-close-failure-"));
	const originalOpenSync = commonJsFs.openSync;
	const originalCloseSync = commonJsFs.closeSync;
	const directoryCloseFailure = Object.assign(new Error("injected directory close failure"), {
		code: "EIO",
	});
	let directoryFd: number | undefined;
	const patchedOpenSync = ((...args: Parameters<typeof fs.openSync>): number => {
		const fd = originalOpenSync(...args);
		if (args[0] === root && args[1] === "r") directoryFd = fd;
		return fd;
	}) as typeof fs.openSync;
	const patchedCloseSync = ((fd: number): void => {
		if (fd !== directoryFd) return originalCloseSync(fd);
		originalCloseSync(fd);
		throw directoryCloseFailure;
	}) as typeof fs.closeSync;
	try {
		patchBuiltinFsMethod("openSync", patchedOpenSync);
		patchBuiltinFsMethod("closeSync", patchedCloseSync);
		assert.throws(
			() => fsyncDirectory(root),
			(error) =>
				error instanceof ControlStoreDurabilityError &&
				error.filePath === root &&
				error.cause === directoryCloseFailure &&
				error.message.includes("directory close failure"),
		);
		assert.notEqual(directoryFd, undefined, "the injected fault must target a directory fd");
	} finally {
		patchBuiltinFsMethod("closeSync", originalCloseSync);
		patchBuiltinFsMethod("openSync", originalOpenSync);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test(
	"P14 atomic write: a post-rename directory fsync failure is surfaced",
	{ concurrency: false },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-directory-fsync-failure-"));
		const target = path.join(root, "durable.json");
		const originalOpenSync = commonJsFs.openSync;
		const originalFsyncSync = commonJsFs.fsyncSync;
		const directoryFailure = Object.assign(new Error("injected directory fsync failure"), {
			code: "EIO",
		});
		let directoryFd: number | undefined;
		const patchedOpenSync = ((...args: Parameters<typeof fs.openSync>): number => {
			const fd = originalOpenSync(...args);
			if (args[0] === root && args[1] === "r") directoryFd = fd;
			return fd;
		}) as typeof fs.openSync;
		const patchedFsyncSync = ((fd: number): void => {
			if (fd === directoryFd) throw directoryFailure;
			return originalFsyncSync(fd);
		}) as typeof fs.fsyncSync;
		try {
			patchBuiltinFsMethod("openSync", patchedOpenSync);
			patchBuiltinFsMethod("fsyncSync", patchedFsyncSync);
			assert.throws(
				() => writeFileAtomic(target, "durable-bytes"),
				(error) =>
					error instanceof ControlStoreDurabilityError &&
					error.filePath === root &&
					error.cause === directoryFailure &&
					error.message.includes("directory fsync failure"),
			);
			assert.notEqual(directoryFd, undefined, "the injected fault must target a directory fd");
			assert.equal(fs.readFileSync(target, "utf-8"), "durable-bytes");
		} finally {
			patchBuiltinFsMethod("fsyncSync", originalFsyncSync);
			patchBuiltinFsMethod("openSync", originalOpenSync);
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);

test(
	"P14 exclusive lock: a release directory fsync failure is surfaced",
	{ concurrency: false },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-lock-release-directory-fsync-"));
		const lockPath = path.join(root, "critical.lock");
		const originalOpenSync = commonJsFs.openSync;
		const originalFsyncSync = commonJsFs.fsyncSync;
		const directoryFailure = Object.assign(new Error("injected release directory fsync failure"), {
			code: "EIO",
		});
		let directoryFd: number | undefined;
		const patchedOpenSync = ((...args: Parameters<typeof fs.openSync>): number => {
			const fd = originalOpenSync(...args);
			if (args[0] === root && args[1] === "r") directoryFd = fd;
			return fd;
		}) as typeof fs.openSync;
		const patchedFsyncSync = ((fd: number): void => {
			if (fd === directoryFd) throw directoryFailure;
			return originalFsyncSync(fd);
		}) as typeof fs.fsyncSync;
		try {
			patchBuiltinFsMethod("openSync", patchedOpenSync);
			patchBuiltinFsMethod("fsyncSync", patchedFsyncSync);
			assert.throws(
				() => withExclusiveLockFile(lockPath, () => undefined),
				(error) =>
					error instanceof ControlStoreDurabilityError &&
					error.filePath === root &&
					error.cause === directoryFailure &&
					error.message.includes("release directory fsync failure"),
			);
			assert.notEqual(directoryFd, undefined, "the injected fault must target the parent directory fd");
			assert.equal(fs.existsSync(lockPath), false, "the lock entry was removed before durability became uncertain");
		} finally {
			patchBuiltinFsMethod("fsyncSync", originalFsyncSync);
			patchBuiltinFsMethod("openSync", originalOpenSync);
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);

test(
	"P13 exclusive lock: a contended-path inspection I/O fault is fail-closed immediately",
	{ concurrency: false },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-lock-inspection-failure-"));
		const lockPath = path.join(root, "critical.lock");
		const originalLstatSync = commonJsFs.lstatSync;
		const inspectionFailure = Object.assign(new Error("injected lock lstat failure"), {
			code: "EIO",
		});
		const patchedLstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
			const [candidate] = args;
			if (candidate === lockPath) throw inspectionFailure;
			return originalLstatSync(...args);
		}) as typeof fs.lstatSync;
		let entered = false;
		try {
			fs.mkdirSync(lockPath);
			patchBuiltinFsMethod("lstatSync", patchedLstatSync);
			assert.throws(
				() =>
					withExclusiveLockFile(
						lockPath,
						() => {
							entered = true;
						},
						{ maxAttempts: 1, timeoutMs: 50 },
					),
				(error) =>
					error instanceof ControlStoreDurabilityError &&
					error.filePath === lockPath &&
					error.message.includes("cannot inspect contended exclusive lock"),
			);
			assert.equal(entered, false);
		} finally {
			patchBuiltinFsMethod("lstatSync", originalLstatSync);
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);

/**
 * P13 identity-bound release: a successor published at the lock path while
 * the old holder still thinks it owns the critical section must survive the
 * old holder's finally. Release renames only the acquire-time generation
 * (dev/ino + owner token) and restores on mismatch — never pathname-rm of a
 * replacement. Same-UID non-cooperative adversaries remain an open lower bound.
 */
test(
	"P13 exclusive lock: release leaves a mid-flight successor generation intact",
	{ skip: process.platform === "win32", concurrency: false },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-lock-release-replacement-race-"));
		const lockPath = path.join(root, "critical.lock");
		const originalRenameSync = commonJsFs.renameSync;
		let swapped = false;
		let successorToken = "";
		let successorIno = 0;
		const patchedRenameSync = ((...args: Parameters<typeof fs.renameSync>): void => {
			const [from, to] = args;
			if (
				!swapped &&
				typeof from === "string" &&
				typeof to === "string" &&
				from === lockPath &&
				to.includes(".release.")
			) {
				// Between identity observation and rename: replace with a successor.
				try {
					fs.rmSync(lockPath, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
				fs.mkdirSync(lockPath);
				successorToken = "replacement-owner";
				fs.writeFileSync(
					path.join(lockPath, "owner.json"),
					JSON.stringify({
						lockId: successorToken,
						token: successorToken,
						pid: process.pid,
						acquiredAt: Date.now(),
					}),
					"utf-8",
				);
				successorIno = fs.lstatSync(lockPath).ino;
				swapped = true;
			}
			return originalRenameSync(...args);
		}) as typeof fs.renameSync;
		try {
			patchBuiltinFsMethod("renameSync", patchedRenameSync);
			withExclusiveLockFile(lockPath, () => undefined);

			assert.equal(swapped, true, "the test must replace the lock before release rename");
			assert.equal(fs.existsSync(lockPath), true, "successor exclusive lock must survive release");
			assert.equal(fs.lstatSync(lockPath).ino, successorIno);
			const owner = JSON.parse(
				fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8"),
			) as { lockId?: string; token?: string };
			assert.equal(owner.token ?? owner.lockId, successorToken);
		} finally {
			patchBuiltinFsMethod("renameSync", originalRenameSync);
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);

/**
 * P14 lower-bound counterexample, deliberately asserted as current unsafe
 * behavior. After exclusive open succeeds, an attacker who can mutate the
 * directory can replace the temporary source entry before pathname rename.
 * `renameSync()` then publishes the replacement symlink and the helper returns
 * success. A post-open `lstat` would only move the same TOCTOU interval; this
 * assertion must change only with an OS-backed fd-to-publish protocol.
 */
test(
	"P14 counterexample: post-open temp replacement can publish a symlink",
	{ skip: process.platform === "win32", concurrency: false },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-post-open-race-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tf-atomic-post-open-race-outside-"));
		const target = path.join(root, "durable.json");
		const external = path.join(outside, "external-sentinel");
		const originalRenameSync = commonJsFs.renameSync;
		let swapped = false;
		const patchedRenameSync = ((...args: Parameters<typeof fs.renameSync>): void => {
			const [from, to] = args;
			if (
				!swapped &&
				typeof from === "string" &&
				typeof to === "string" &&
				to === target &&
				isAtomicTemporaryPath(from, root)
			) {
				fs.unlinkSync(from);
				fs.symlinkSync(external, from, "file");
				swapped = true;
			}
			return originalRenameSync(...args);
		}) as typeof fs.renameSync;
		try {
			fs.writeFileSync(external, "must-not-change", "utf-8");
			patchBuiltinFsMethod("renameSync", patchedRenameSync);
			writeFileAtomic(target, "durable-bytes");

			assert.equal(swapped, true, "the test must replace the source entry after exclusive open");
			assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
			assert.equal(fs.readlinkSync(target), external);
			assert.equal(fs.readFileSync(external, "utf-8"), "must-not-change");
		} finally {
			patchBuiltinFsMethod("renameSync", originalRenameSync);
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	},
);
