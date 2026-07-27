/**
 * P13 exclusive-lock reclaim: safety (≤1 CS) + cooperative liveness (all enter).
 *
 * D1: reclaim must be identity-bound (dev/ino + owner token) and claim-serialized;
 *     never blind pathname rm after a dead-pid / age observation.
 * D2: under 16 concurrent contenders every contender must enter; peak holders = 1.
 * D3: leftover reclaim-claim ownership must be recoverable so a successor progresses.
 * D4: TOCTOU successor-restore must exercise the production reclaim path.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ControlStoreDurabilityError, withExclusiveLockFile } from "../src/paths.ts";
import { parentReleaseStart } from "./helpers/mp-barrier.mts";

const helpersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");
const commonJsFs = createRequire(import.meta.url)("node:fs") as typeof fs;

function patchBuiltinFsMethod(method: string, replacement: unknown): void {
	if (!Reflect.set(commonJsFs, method, replacement)) {
		throw new Error(`could not patch node:fs.${method} for this isolated test`);
	}
	syncBuiltinESMExports();
}

function waitForChild(
	child: ChildProcess,
	timeoutMs = 60_000,
): Promise<{ status: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			resolve({ status: 124, stdout, stderr: `${stderr}\ntimeout` });
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ status: code ?? 1, stdout, stderr });
		});
	});
}

/**
 * Plant a complete exclusive lock dir owned by a dead pid with aged mtime so
 * reclaim is immediately eligible under a short staleMs.
 */
function plantDeadExclusiveLock(lockPath: string, ownerToken = "dead-exclusive-token"): void {
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, "owner.json"),
		JSON.stringify({
			lockId: ownerToken,
			token: ownerToken,
			pid: 2_147_483_646,
			acquiredAt: Date.now() - 120_000,
			at: Date.now() - 120_000,
		}),
		"utf-8",
	);
	const past = new Date(Date.now() - 120_000);
	fs.utimesSync(lockPath, past, past);
	fs.utimesSync(path.join(lockPath, "owner.json"), past, past);
}

/** Plant an incomplete lock dir (mkdir without owner.json) with aged mtime. */
function plantIncompleteExclusiveLock(lockPath: string): void {
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	fs.mkdirSync(lockPath);
	const past = new Date(Date.now() - 120_000);
	fs.utimesSync(lockPath, past, past);
}

type ContenderResult = {
	status: number;
	stdout: string;
	stderr: string;
	parsed?: { entered: boolean; maxConcurrent: number; ok: boolean; error?: string };
};

async function runExclusiveLockContenders(opts: {
	lockPath: string;
	workDir: string;
	count: number;
	staleMs: number;
	abandonIncompleteMs: number;
	holdMs?: number;
	maxAttempts?: number;
	timeoutMs?: number;
}): Promise<ContenderResult[]> {
	const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-excl-barrier-"));
	const script = path.join(helpersDir, "mp-p13-exclusive-lock.mts");
	const children: Array<Promise<{ status: number; stdout: string; stderr: string }>> = [];
	try {
		for (let i = 0; i < opts.count; i++) {
			const child = spawn(
				process.execPath,
				[
					"--conditions=development",
					"--experimental-strip-types",
					script,
					opts.lockPath,
					opts.workDir,
				],
				{
					env: {
						...process.env,
						TF_MP_BARRIER: barrierDir,
						TF_MP_ID: String(i),
						TF_EXCL_STALE_MS: String(opts.staleMs),
						TF_EXCL_ABANDON_MS: String(opts.abandonIncompleteMs),
						TF_EXCL_HOLD_MS: String(opts.holdMs ?? 120),
						TF_EXCL_MAX_ATTEMPTS: String(opts.maxAttempts ?? 1000),
						TF_EXCL_TIMEOUT_MS: String(opts.timeoutMs ?? 45_000),
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			children.push(waitForChild(child));
		}
		parentReleaseStart(barrierDir, opts.count, 30_000);
		const results = await Promise.all(children);
		return results.map((result) => {
			let parsed: ContenderResult["parsed"];
			try {
				parsed = JSON.parse(result.stdout) as ContenderResult["parsed"];
			} catch {
				/* leave undefined */
			}
			return { ...result, parsed };
		});
	} finally {
		fs.rmSync(barrierDir, { recursive: true, force: true });
	}
}

function assertAllEnteredExclusive(
	results: ContenderResult[],
	count: number,
	label: string,
): void {
	const entered = results.filter((r) => r.parsed?.entered === true);
	const diagnostics = results
		.map(
			(r, i) =>
				`#${i} status=${r.status} stdout=${r.stdout || "<empty>"} stderr=${r.stderr || "<empty>"}`,
		)
		.join("\n");
	assert.equal(
		entered.length,
		count,
		`${label}: expected ${count}/${count} contenders to enter CS; got ${entered.length}/${count}\n${diagnostics}`,
	);
	const peak = Math.max(0, ...entered.map((r) => r.parsed!.maxConcurrent));
	assert.equal(peak, 1, `${label}: dual critical section: peak concurrent holders=${peak}`);
	for (const result of results) {
		assert.equal(result.status, 0, result.stderr + result.stdout);
		assert.equal(result.parsed?.ok, true, result.stdout);
		assert.equal(result.parsed?.maxConcurrent, 1, result.stdout);
	}
}

test(
	"P13 D1+D2: 16-contender stale steal — every contender enters, peak holders = 1",
	{ skip: process.platform === "win32", concurrency: false },
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-stale-race-"));
		const lockPath = path.join(dir, "commit.lock");
		const workDir = path.join(dir, "work");
		fs.mkdirSync(workDir, { recursive: true });
		try {
			plantDeadExclusiveLock(lockPath);
			const count = 16;
			const results = await runExclusiveLockContenders({
				lockPath,
				workDir,
				count,
				staleMs: 20,
				abandonIncompleteMs: 60_000,
				holdMs: 150,
				maxAttempts: 1000,
				timeoutMs: 45_000,
			});
			assertAllEnteredExclusive(results, count, "stale-steal");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);

test(
	"P13 D1+D2: 16-contender incomplete abandon — every contender enters, peak holders = 1",
	{ skip: process.platform === "win32", concurrency: false },
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-incomplete-race-"));
		const lockPath = path.join(dir, "commit.lock");
		const workDir = path.join(dir, "work");
		fs.mkdirSync(workDir, { recursive: true });
		try {
			plantIncompleteExclusiveLock(lockPath);
			const count = 16;
			const results = await runExclusiveLockContenders({
				lockPath,
				workDir,
				count,
				staleMs: 60_000,
				abandonIncompleteMs: 20,
				holdMs: 150,
				maxAttempts: 1000,
				timeoutMs: 45_000,
			});
			assertAllEnteredExclusive(results, count, "incomplete-abandon");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);

test(
	"P13 D2: maxAttempts is a real acquire-pass budget (not maxAttempts×K spins)",
	{ concurrency: false },
	() => {
		// If maxAttempts is inflated (e.g. max(maxAttempts*32, 256)), a reclaim
		// that always fails fast will spin far past the declared budget and this
		// test fails open. Progress waits must not be required for the bound —
		// each failed reclaim attempt must consume exactly one attempt.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-max-attempts-bind-"));
		const lockPath = path.join(dir, "commit.lock");
		const claimPath = `${lockPath}.reclaim-claim`;
		const originalOpenSync = commonJsFs.openSync;
		const originalRenameSync = commonJsFs.renameSync;
		let claimCreates = 0;
		const budget = 5;
		const patchedOpenSync = ((...args: Parameters<typeof fs.openSync>): number => {
			const [candidate, flags] = args;
			if (
				candidate === claimPath &&
				(flags === "wx" || flags === "wx+" || flags === (fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY))
			) {
				claimCreates += 1;
			}
			return originalOpenSync(...args);
		}) as typeof fs.openSync;
		const patchedRenameSync = ((...args: Parameters<typeof fs.renameSync>): void => {
			const [from, to] = args;
			if (
				typeof from === "string" &&
				typeof to === "string" &&
				from === lockPath &&
				to.includes(".reclaim-discard.")
			) {
				// Force every reclaim to fail after claim create, quickly.
				throw Object.assign(new Error("injected reclaim rename failure"), { code: "EBUSY" });
			}
			return originalRenameSync(...args);
		}) as typeof fs.renameSync;
		try {
			plantDeadExclusiveLock(lockPath, "bind-budget-token");
			patchBuiltinFsMethod("openSync", patchedOpenSync);
			patchBuiltinFsMethod("renameSync", patchedRenameSync);

			const started = Date.now();
			assert.throws(
				() =>
					withExclusiveLockFile(lockPath, () => "must-not-enter", {
						maxAttempts: budget,
						// Generous wall budget so only maxAttempts can stop the loop.
						timeoutMs: 30_000,
						staleMs: 1,
						abandonIncompleteMs: 1,
					}),
				(error: unknown) =>
					error instanceof ControlStoreDurabilityError &&
					/could not acquire exclusive lock/i.test(error.message),
			);
			const elapsed = Date.now() - started;

			// Binding budget: one claim create per acquire pass, and we must stop
			// at the declared maxAttempts (allow +1 for a trailing cleanup pass).
			assert.ok(
				claimCreates <= budget + 1,
				`maxAttempts=${budget} must bind reclaim attempts; claimCreates=${claimCreates} (elapsed=${elapsed}ms)`,
			);
			assert.ok(
				claimCreates >= budget,
				`expected to consume the full attempt budget; claimCreates=${claimCreates}`,
			);
			// Inflated spin budgets (×32 / floor 256) would still finish under 30s;
			// the claimCreates cap is the regression detector.
			assert.ok(elapsed < 10_000, `budget should fail closed promptly; elapsed=${elapsed}ms`);
		} finally {
			patchBuiltinFsMethod("openSync", originalOpenSync);
			patchBuiltinFsMethod("renameSync", originalRenameSync);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);

test(
	"P13 D2: 16 contenders progress under tight attempt budget (safety + liveness together)",
	{ skip: process.platform === "win32", concurrency: false },
	async () => {
		// maxAttempts is a hard acquire-pass budget (not ×32 spins). Progress-wait
		// on claim/generation must not burn that budget, so 16 serial critical
		// sections still complete; pure micro-spin starvation would exhaust
		// maxAttempts before every contender enters.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-liveness-"));
		const lockPath = path.join(dir, "commit.lock");
		const workDir = path.join(dir, "work");
		fs.mkdirSync(workDir, { recursive: true });
		try {
			plantDeadExclusiveLock(lockPath);
			const count = 16;
			const results = await runExclusiveLockContenders({
				lockPath,
				workDir,
				count,
				staleMs: 20,
				abandonIncompleteMs: 60_000,
				holdMs: 200,
				// Tight but real: each contender needs a handful of acquire passes
				// while peers hold 200ms; without progress-wait this starves.
				maxAttempts: 48,
				// Wall budget still must span all serial critical sections.
				timeoutMs: 45_000,
			});
			assertAllEnteredExclusive(results, count, "tight-budget-liveness");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);

test(
	"P13 D3: orphaned reclaim-claim with live claimant PID is recoverable (successor progresses)",
	{ concurrency: false },
	() => {
		// A leftover claim whose observed generation no longer exists is an orphan
		// even when the claimant PID is still alive. Cleaning only the claim (never
		// a live lock generation) must let a successor enter — otherwise a hung
		// reclaim after successful unpublish fences the control plane unboundedly.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-claim-orphan-"));
		const lockPath = path.join(dir, "commit.lock");
		const claimPath = `${lockPath}.reclaim-claim`;
		try {
			// No lock dir: claim references a generation that is already gone.
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				claimPath,
				JSON.stringify({
					pid: process.pid, // live claimant
					device: 0,
					inode: 999_999_999,
					hasOwner: true,
					token: "orphaned-gone-generation",
					at: Date.now() - 60_000,
				}),
				"utf-8",
			);
			assert.equal(fs.existsSync(claimPath), true);

			const result = withExclusiveLockFile(
				lockPath,
				() => {
					assert.equal(
						fs.existsSync(claimPath),
						false,
						"orphaned live-PID claim must be cleared before CS entry",
					);
					return "progressed";
				},
				{ maxAttempts: 40, timeoutMs: 5_000, staleMs: 1, abandonIncompleteMs: 1 },
			);
			assert.equal(result, "progressed");
			assert.equal(fs.existsSync(claimPath), false);
			assert.equal(fs.existsSync(lockPath), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);

test(
	"P13 D3: reclaim-claim cleanup surfaces unlink failures (does not swallow)",
	{ concurrency: false },
	() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-claim-unlink-err-"));
		const lockPath = path.join(dir, "commit.lock");
		const claimPath = `${lockPath}.reclaim-claim`;
		const originalUnlinkSync = commonJsFs.unlinkSync;
		const unlinkFailure = Object.assign(new Error("injected claim unlink failure"), {
			code: "EIO",
		});
		const patchedUnlinkSync = ((candidate: fs.PathLike, ...rest: unknown[]): void => {
			if (candidate === claimPath) throw unlinkFailure;
			return (originalUnlinkSync as (...args: unknown[]) => void)(candidate, ...rest);
		}) as typeof fs.unlinkSync;
		try {
			plantDeadExclusiveLock(lockPath, "behind-dead-claim");
			const observed = fs.lstatSync(lockPath);
			fs.writeFileSync(
				claimPath,
				JSON.stringify({
					pid: 2_147_483_646, // dead claimant → cleanup path
					device: observed.dev,
					inode: observed.ino,
					hasOwner: true,
					token: "behind-dead-claim",
					at: Date.now() - 60_000,
				}),
				"utf-8",
			);
			patchBuiltinFsMethod("unlinkSync", patchedUnlinkSync);
			assert.throws(
				() =>
					withExclusiveLockFile(lockPath, () => "must-not-mask", {
						maxAttempts: 8,
						timeoutMs: 2_000,
						staleMs: 1,
						abandonIncompleteMs: 1,
					}),
				(error: unknown) =>
					error instanceof ControlStoreDurabilityError &&
					(error.message.includes("reclaim-claim") ||
						error.message.includes("claim") ||
						error.cause === unlinkFailure),
			);
		} finally {
			patchBuiltinFsMethod("unlinkSync", originalUnlinkSync);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);

test(
	"P13 D3: post-publish claim unlink failure must not strand a live-PID owner lock",
	{ concurrency: false },
	() => {
		// After reclaim publishes mkdir+owner under the claim fence, claim cleanup
		// can still fail. That failure must never leave a live-PID owner standing
		// without enterWithHeld/releaseHeldLock — successors would be fenced for
		// the process lifetime. Valid outcomes: hold-and-release via CS, or
		// publish not left standing at all.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-post-publish-unlink-"));
		const lockPath = path.join(dir, "commit.lock");
		const claimPath = `${lockPath}.reclaim-claim`;
		const ownerPath = path.join(lockPath, "owner.json");
		const originalUnlinkSync = commonJsFs.unlinkSync;
		const unlinkFailure = Object.assign(new Error("injected post-publish claim unlink"), {
			code: "EIO",
		});
		const patchedUnlinkSync = ((candidate: fs.PathLike, ...rest: unknown[]): void => {
			if (candidate === claimPath) {
				// Fail only after a live-PID successor has been published.
				try {
					const raw = fs.readFileSync(ownerPath, "utf-8");
					const owner = JSON.parse(raw) as { pid?: number };
					if (owner.pid === process.pid) throw unlinkFailure;
				} catch (error) {
					if (error === unlinkFailure) throw error;
					/* pre-publish claim drops may race owner absence — allow */
				}
			}
			return (originalUnlinkSync as (...args: unknown[]) => void)(candidate, ...rest);
		}) as typeof fs.unlinkSync;
		try {
			plantDeadExclusiveLock(lockPath, "pre-publish-dead");
			patchBuiltinFsMethod("unlinkSync", patchedUnlinkSync);

			let entered = false;
			assert.throws(
				() =>
					withExclusiveLockFile(
						lockPath,
						() => {
							entered = true;
							return "must-not-enter-without-claim-clear-or-hold";
						},
						{ maxAttempts: 8, timeoutMs: 3_000, staleMs: 1, abandonIncompleteMs: 1 },
					),
				(error: unknown) =>
					error instanceof ControlStoreDurabilityError &&
					(error.message.includes("reclaim-claim") ||
						error.message.includes("claim") ||
						error.cause === unlinkFailure),
			);
			assert.equal(entered, false, "CS must not run when post-publish cleanup fails closed");

			// BLOCKER: live-PID owner left standing fences all successors.
			if (fs.existsSync(lockPath)) {
				let ownerPid: number | undefined;
				try {
					const raw = fs.readFileSync(ownerPath, "utf-8");
					ownerPid = (JSON.parse(raw) as { pid?: number }).pid;
				} catch {
					ownerPid = undefined;
				}
				assert.notEqual(
					ownerPid,
					process.pid,
					"post-publish claim unlink failure must not strand a live-PID owner lock",
				);
			}

			// Successor must be able to progress once the inject is removed.
			patchBuiltinFsMethod("unlinkSync", originalUnlinkSync);
			const progressed = withExclusiveLockFile(
				lockPath,
				() => "successor-progressed",
				{ maxAttempts: 40, timeoutMs: 8_000, staleMs: 1, abandonIncompleteMs: 1 },
			);
			assert.equal(progressed, "successor-progressed");
			assert.equal(fs.existsSync(lockPath), false);
		} finally {
			patchBuiltinFsMethod("unlinkSync", originalUnlinkSync);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);

test(
	"P13 D3: abandoned reclaim-claim (dead claimant) is cleaned so acquire progresses",
	{ concurrency: false },
	() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-claim-dead-"));
		const lockPath = path.join(dir, "commit.lock");
		const claimPath = `${lockPath}.reclaim-claim`;
		try {
			plantDeadExclusiveLock(lockPath, "dead-under-abandoned-claim");
			const observed = fs.lstatSync(lockPath);
			fs.writeFileSync(
				claimPath,
				JSON.stringify({
					pid: 2_147_483_646,
					device: observed.dev,
					inode: observed.ino,
					hasOwner: true,
					token: "dead-under-abandoned-claim",
					at: Date.now() - 60_000,
				}),
				"utf-8",
			);

			const result = withExclusiveLockFile(
				lockPath,
				() => {
					assert.equal(fs.existsSync(claimPath), false, "dead claim must be cleared before CS");
					return "progressed";
				},
				{ maxAttempts: 40, timeoutMs: 5_000, staleMs: 1, abandonIncompleteMs: 60_000 },
			);
			assert.equal(result, "progressed");
			assert.equal(fs.existsSync(claimPath), false);
			assert.equal(fs.existsSync(lockPath), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);

test(
	"P13 D4: production reclaim restores successor published between observation and unpublish",
	{ skip: process.platform === "win32", concurrency: false },
	() => {
		// End-to-end production path: withExclusiveLockFile → reclaimObservedGeneration.
		// Inject a live successor at lockPath exactly when the reclaimer renames the
		// path to its private discard. Identity mismatch must restore the successor
		// rather than destroyTree it. A test-local reimplementation is forbidden.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-toctou-restore-"));
		const lockPath = path.join(dir, "commit.lock");
		const originalRenameSync = commonJsFs.renameSync;
		const originalRmSync = commonJsFs.rmSync;
		let injected = false;
		let successorToken = "";
		let successorIno = 0;
		const patchedRenameSync = ((...args: Parameters<typeof fs.renameSync>): void => {
			const [from, to] = args;
			if (
				!injected &&
				typeof from === "string" &&
				typeof to === "string" &&
				from === lockPath &&
				to.includes(".reclaim-discard.")
			) {
				// TOCTOU window: after observation + claim, before unpublish rename,
				// replace the dead generation with a live successor generation.
				try {
					originalRmSync(lockPath, { recursive: true, force: true });
				} catch {
					/* path may already be mid-transition */
				}
				fs.mkdirSync(lockPath);
				successorToken = "live-successor-token";
				fs.writeFileSync(
					path.join(lockPath, "owner.json"),
					JSON.stringify({
						lockId: successorToken,
						token: successorToken,
						pid: process.pid,
						acquiredAt: Date.now(),
						at: Date.now(),
					}),
					"utf-8",
				);
				successorIno = fs.lstatSync(lockPath).ino;
				injected = true;
			}
			return originalRenameSync(...args);
		}) as typeof fs.renameSync;
		try {
			plantDeadExclusiveLock(lockPath, "observed-dead-token");
			const observedIno = fs.lstatSync(lockPath).ino;
			patchBuiltinFsMethod("renameSync", patchedRenameSync);

			// Production reclaim must not destroy the injected successor. Live pid
			// at the path means acquire eventually fails closed / waits out budget
			// without entering, leaving the successor generation intact.
			assert.throws(
				() =>
					withExclusiveLockFile(lockPath, () => "must-not-enter-live-successor", {
						maxAttempts: 40,
						timeoutMs: 1_500,
						staleMs: 1,
						abandonIncompleteMs: 1,
					}),
				(error: unknown) =>
					error instanceof ControlStoreDurabilityError ||
					(error instanceof Error && /could not acquire exclusive lock/i.test(error.message)),
			);

			assert.equal(injected, true, "production reclaim must reach rename-to-discard");
			assert.equal(fs.existsSync(lockPath), true, "successor lock must survive reclaim TOCTOU");
			assert.notEqual(successorIno, observedIno);
			assert.equal(fs.lstatSync(lockPath).ino, successorIno);
			const durable = JSON.parse(
				fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8"),
			) as { token?: string; lockId?: string };
			assert.equal(durable.token ?? durable.lockId, successorToken);
			// Claim must not permanently fence after a failed/restored reclaim.
			assert.equal(fs.existsSync(`${lockPath}.reclaim-claim`), false);
		} finally {
			patchBuiltinFsMethod("renameSync", originalRenameSync);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);

test(
	"P13 exclusive lock: release of an old generation never removes a successor lock dir",
	{ concurrency: false },
	() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p13-excl-l1-"));
		const lockPath = path.join(dir, "commit.lock");
		try {
			let successorToken = "";
			withExclusiveLockFile(lockPath, () => {
				const displaced = `${lockPath}.displaced`;
				fs.renameSync(lockPath, displaced);
				fs.mkdirSync(lockPath);
				successorToken = "successor-exclusive-token";
				fs.writeFileSync(
					path.join(lockPath, "owner.json"),
					JSON.stringify({
						lockId: successorToken,
						token: successorToken,
						pid: process.pid,
						acquiredAt: Date.now(),
						at: Date.now(),
					}),
					"utf-8",
				);
			});

			assert.equal(fs.existsSync(lockPath), true, "successor exclusive lock must survive finally");
			const owner = JSON.parse(
				fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8"),
			) as { token?: string; lockId?: string };
			assert.equal(owner.token ?? owner.lockId, successorToken);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);
