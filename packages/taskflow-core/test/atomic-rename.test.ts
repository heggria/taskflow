import assert from "node:assert/strict";
import { test } from "node:test";
import { renameAtomicWithRetry } from "../src/atomic-rename.ts";

function transientError(code: string): NodeJS.ErrnoException {
	const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

test("renameAtomicWithRetry: retries eligible Windows contention until success", () => {
	let attempts = 0;
	let sleeps = 0;
	renameAtomicWithRetry("tmp", "target", {
		platform: "win32",
		maxAttempts: 5,
		renameSync: () => {
			attempts++;
			if (attempts < 3) throw transientError("EPERM");
		},
		sleep: () => { sleeps++; },
	});
	assert.equal(attempts, 3);
	assert.equal(sleeps, 2);
});

test("renameAtomicWithRetry: persistent contention exhausts a hard attempt bound", () => {
	let attempts = 0;
	let sleeps = 0;
	assert.throws(
		() => renameAtomicWithRetry("tmp", "target", {
			platform: "win32",
			maxAttempts: 3,
			renameSync: () => {
				attempts++;
				throw transientError("EBUSY");
			},
			sleep: () => { sleeps++; },
		}),
		(error: NodeJS.ErrnoException) => error.code === "EBUSY",
	);
	assert.equal(attempts, 3);
	assert.equal(sleeps, 2);
});

test("renameAtomicWithRetry: non-Windows and ineligible errors fail immediately", () => {
	for (const [platform, code] of [["linux", "EPERM"], ["win32", "EIO"]] as const) {
		let attempts = 0;
		assert.throws(
			() => renameAtomicWithRetry("tmp", "target", {
				platform,
				maxAttempts: 5,
				renameSync: () => {
					attempts++;
					throw transientError(code);
				},
				sleep: () => { throw new Error("must not sleep"); },
			}),
			(error: NodeJS.ErrnoException) => error.code === code,
		);
		assert.equal(attempts, 1);
	}
});

test("renameAtomicWithRetry: rejects non-finite or excessive attempt bounds", () => {
	for (const maxAttempts of [Number.NaN, Number.POSITIVE_INFINITY, 0, 52]) {
		let attempts = 0;
		assert.throws(
			() => renameAtomicWithRetry("tmp", "target", {
				platform: "win32",
				maxAttempts,
				renameSync: () => { attempts++; },
			}),
			RangeError,
		);
		assert.equal(attempts, 0);
	}
});