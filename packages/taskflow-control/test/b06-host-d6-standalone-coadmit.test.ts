/**
 * B06 host D6: raw createControlHost standalone/skipSingleton must not
 * co-admit as a second mutator on a project store owned by a live multi-mount
 * writer (taskflowd). Factory-level guard — not a comment, not MCP-only.
 *
 * Does not claim single-ledger GA, P15 closure, or 0.3.0 GA.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	acquireOrAttachSingleton,
	createControlHost,
	createScriptExecutionProvider,
	isSingletonMutationAuthorityCurrent,
	multiMountPossessionSupportedOnPlatform,
	releaseSingleton,
	withSingletonMutationAuthority,
	type ControlHost,
	type SingletonResult,
} from "../src/index.ts";
import { startDaemon } from "../../taskflow-daemon/src/daemon.ts";

function temp(): {
	env: NodeJS.ProcessEnv;
	home: string;
	project: string;
	cleanup: () => void;
} {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d6-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d6-proj-"));
	return {
		env: { ...process.env, TASKFLOW_HOME: home },
		home,
		project,
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

function scriptProvider(project: string) {
	return createScriptExecutionProvider({
		stateDir: path.join(project, ".taskflow", "control", "provider-jobs"),
	});
}

const trivialProgram = {
	name: "d6-trivial",
	phases: [{ id: "main", type: "script", run: "true", final: true }],
};

/** In-process taskflowd-shaped mount: hold user singleton + embed project host. */
function openLiveDaemonStyleWriter(
	projectRoot: string,
	env: NodeJS.ProcessEnv,
	holderId: string,
): { singleton: Extract<SingletonResult, { role: "writer" }>; host: ControlHost } {
	const singleton = acquireOrAttachSingleton(holderId, env);
	assert.equal(singleton.role, "writer");
	const host = createControlHost({
		projectRoot,
		env,
		controlMode: "auto",
		skipSingleton: true,
		mutationCapability: singleton.mutationAuthority,
		mutationAuthority: () =>
			isSingletonMutationAuthorityCurrent(singleton.mutationAuthority, env),
		mutationFence: <T>(fn: () => T): T =>
			withSingletonMutationAuthority(singleton.mutationAuthority, fn, env),
		provider: scriptProvider(projectRoot),
	});
	return { singleton, host };
}

test("D6: raw standalone skipSingleton co-admit is refused while a live daemon writer owns the project", async () => {
	const t = temp();
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		// Real taskflowd path: acquire singleton, mount project host(s).
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [t.project],
			holderId: "d6-daemon-writer",
			listenUds: false,
		});
		assert.equal(daemon.role, "writer");
		assert.ok(daemon.hosts.size >= 1, "daemon must mount the project");

		// Live multi-mount writer holds the user singleton and the project store.
		// Raw factory co-admit must fail closed — not open a second mutator.
		assert.throws(
			() =>
				createControlHost({
					projectRoot: t.project,
					env: t.env,
					controlMode: "standalone",
					skipSingleton: true,
					provider: scriptProvider(t.project),
				}),
			(error: unknown) => {
				const err = error as { code?: string; message?: string };
				assert.equal(err.code, "TF_BOOTSTRAP_FAILED");
				assert.match(err.message ?? "", /co-admit|live multi-mount writer|skipSingleton/i);
				return true;
			},
		);

		// Unfenced auto+skipSingleton is the same dual-writer hole.
		assert.throws(
			() =>
				createControlHost({
					projectRoot: t.project,
					env: t.env,
					controlMode: "auto",
					skipSingleton: true,
					provider: scriptProvider(t.project),
				}),
			(error: unknown) => {
				const err = error as { code?: string; message?: string };
				assert.equal(err.code, "TF_BOOTSTRAP_FAILED");
				assert.match(err.message ?? "", /co-admit|live multi-mount writer/i);
				return true;
			},
		);

		// Daemon writer remains the sole mutator and can still admit.
		const mounted = daemon.hosts.values().next().value as ControlHost | undefined;
		assert.ok(mounted);
		assert.equal(mounted.canMutate, true);
		const admitted = await mounted.admitAndRun({
			program: trivialProgram,
			commandId: "d6-daemon-only-admit",
			callerPrincipal: "d6",
		});
		assert.equal(admitted.ok, true, JSON.stringify(admitted.error));
		assert.equal(admitted.run?.status, "completed");
		assert.ok(admitted.receipt?.receiptId);
	} finally {
		await daemon?.stop();
		t.cleanup();
	}
});

test("D6: parent-authorized embedded mount (mutationCapability) still opens under the live writer", async () => {
	const t = temp();
	let writer: ReturnType<typeof openLiveDaemonStyleWriter> | undefined;
	try {
		writer = openLiveDaemonStyleWriter(t.project, t.env, "d6-parent-writer");
		const admitted = await writer.host.admitAndRun({
			program: trivialProgram,
			commandId: "d6-embedded-parent-auth",
		});
		assert.equal(admitted.ok, true, JSON.stringify(admitted.error));
		assert.equal(writer.host.canMutate, true);
	} finally {
		writer?.host.close();
		if (writer?.singleton.role === "writer") {
			releaseSingleton(writer.singleton.mutationAuthority, t.env);
		}
		t.cleanup();
	}
});

test("D6: standalone skipSingleton still works on an unowned project (no live writer)", async () => {
	const t = temp();
	let host: ControlHost | undefined;
	try {
		host = createControlHost({
			projectRoot: t.project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: scriptProvider(t.project),
		});
		assert.equal(host.role, "standalone-local");
		assert.equal(host.canMutate, true);
		const admitted = await host.admitAndRun({
			program: trivialProgram,
			commandId: "d6-unowned-admit",
		});
		assert.equal(admitted.ok, true, JSON.stringify(admitted.error));
		assert.equal(admitted.run?.status, "completed");
		assert.ok(admitted.receipt?.receiptId);
	} finally {
		host?.close();
		t.cleanup();
	}
});

test("D6: standalone skipSingleton still works on a project the live writer does not own", async () => {
	const t = temp();
	const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-d6-other-"));
	let writer: ReturnType<typeof openLiveDaemonStyleWriter> | undefined;
	let host: ControlHost | undefined;
	try {
		// Live writer owns t.project only (in-process taskflowd-shaped mount).
		writer = openLiveDaemonStyleWriter(t.project, t.env, "d6-daemon-other-project");

		// Unowned project under the same TASKFLOW_HOME must still admit.
		host = createControlHost({
			projectRoot: otherProject,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			provider: scriptProvider(otherProject),
		});
		assert.equal(host.role, "standalone-local");
		const admitted = await host.admitAndRun({
			program: trivialProgram,
			commandId: "d6-other-project-admit",
		});
		assert.equal(admitted.ok, true, JSON.stringify(admitted.error));
		assert.equal(admitted.run?.status, "completed");
	} finally {
		host?.close();
		writer?.host.close();
		if (writer?.singleton.role === "writer") {
			releaseSingleton(writer.singleton.mutationAuthority, t.env);
		}
		fs.rmSync(otherProject, { recursive: true, force: true });
		t.cleanup();
	}
});

test("D6 BLOCKER: dead-singleton-PID rewrite must not co-admit while writer host still holds the project", async () => {
	const t = temp();
	let writer: ReturnType<typeof openLiveDaemonStyleWriter> | undefined;
	try {
		writer = openLiveDaemonStyleWriter(t.project, t.env, "d6-dead-pid-writer");
		assert.equal(writer.host.canMutate, true);
		// Prove the live holder owns the project before the counterexample.
		const before = await writer.host.admitAndRun({
			program: trivialProgram,
			commandId: "d6-dead-pid-before-rewrite",
		});
		assert.equal(before.ok, true, JSON.stringify(before.error));

		// Counterexample: rewrite singleton.lock pid to a dead PID while the
		// writer host remains open. Liveness of the recorded PID is not absence
		// of a live holder — co-admit must still refuse.
		const lockPath = path.join(t.home, ".taskflow", "control", "singleton.lock");
		assert.ok(fs.existsSync(lockPath), "singleton.lock must exist under live writer");
		const rec = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
		rec.pid = 2_147_483_646; // not a live process
		fs.writeFileSync(lockPath, JSON.stringify(rec, null, 2));

		// Host object remains open (still holds the project store + registry claim).
		// Fencing correctly drops canMutate after the durable lock PID no longer
		// matches — that is not license for a second unfenced writer.
		assert.ok(writer.host.store, "live holder still holds the open project store");

		assert.throws(
			() =>
				createControlHost({
					projectRoot: t.project,
					env: t.env,
					controlMode: "standalone",
					skipSingleton: true,
					provider: scriptProvider(t.project),
				}),
			(error: unknown) => {
				const err = error as { code?: string; message?: string };
				assert.equal(err.code, "TF_BOOTSTRAP_FAILED");
				assert.match(err.message ?? "", /co-admit|owner-record|multi-mount/i);
				return true;
			},
		);
	} finally {
		writer?.host.close();
		// Singleton release may fail after PID rewrite; best-effort cleanup.
		try {
			if (writer?.singleton.role === "writer") {
				releaseSingleton(writer.singleton.mutationAuthority, t.env);
			}
		} catch {
			/* lock may be unlinked or mismatched after the counterexample */
		}
		t.cleanup();
	}
});

test("D6 MAJOR: forged empty mutationCapability must not authorize co-admit under a live writer", async () => {
	const t = temp();
	let writer: ReturnType<typeof openLiveDaemonStyleWriter> | undefined;
	try {
		writer = openLiveDaemonStyleWriter(t.project, t.env, "d6-forged-cap-writer");

		// A capability must be unforgeable: any truthy object is not authority.
		const forged = {} as import("../src/index.ts").SingletonMutationAuthority;
		assert.equal(
			isSingletonMutationAuthorityCurrent(forged, t.env),
			false,
			"forged empty object is not a process-held capability",
		);

		assert.throws(
			() =>
				createControlHost({
					projectRoot: t.project,
					env: t.env,
					controlMode: "auto",
					skipSingleton: true,
					mutationCapability: forged,
					provider: scriptProvider(t.project),
				}),
			(error: unknown) => {
				const err = error as { code?: string; message?: string };
				assert.equal(err.code, "TF_BOOTSTRAP_FAILED");
				assert.match(err.message ?? "", /co-admit|multi-mount/i);
				return true;
			},
		);
	} finally {
		writer?.host.close();
		if (writer?.singleton.role === "writer") {
			releaseSingleton(writer.singleton.mutationAuthority, t.env);
		}
		t.cleanup();
	}
});

/**
 * Possession must not be a plain rewritable JSON file. Wiping the hold path,
 * setting multiMount:false, or rewriting hold.pid to a dead PID — together with
 * a dead/absent singleton.lock — must still refuse unfenced co-admit while the
 * original multi-mount host remains open in this process (process-local claim)
 * and across processes (open FD + advisory lock / UDS bind).
 */
test("D6 BLOCKER: mutator-hold content wipe/rewrite must not co-admit while live multi-mount holder remains", async () => {
	const t = temp();
	let writer: ReturnType<typeof openLiveDaemonStyleWriter> | undefined;
	try {
		writer = openLiveDaemonStyleWriter(t.project, t.env, "d6-hold-wipe-writer");
		assert.equal(writer.host.canMutate, true);
		const before = await writer.host.admitAndRun({
			program: trivialProgram,
			commandId: "d6-hold-wipe-before",
		});
		assert.equal(before.ok, true, JSON.stringify(before.error));

		const controlRoot = path.join(t.project, ".taskflow", "control");
		const jsonHold = path.join(controlRoot, "mutator-hold.json");
		const lockPath = path.join(t.home, ".taskflow", "control", "singleton.lock");

		// Counterexample 1: wipe any rewritable JSON hold + absent singleton.
		if (fs.existsSync(jsonHold)) fs.unlinkSync(jsonHold);
		if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);

		assert.throws(
			() =>
				createControlHost({
					projectRoot: t.project,
					env: t.env,
					controlMode: "standalone",
					skipSingleton: true,
					provider: scriptProvider(t.project),
				}),
			(error: unknown) => {
				const err = error as { code?: string; message?: string };
				assert.equal(err.code, "TF_BOOTSTRAP_FAILED");
				assert.match(err.message ?? "", /co-admit|multi-mount|possession|mutator/i);
				return true;
			},
			"wiping mutator-hold.json + absent singleton must not co-admit under a live holder",
		);

		// Counterexample 2: rewrite multiMount:false + dead pid metadata.
		fs.mkdirSync(controlRoot, { recursive: true });
		fs.writeFileSync(
			jsonHold,
			JSON.stringify(
				{ pid: 2_147_483_646, holderId: "spoof", openedAt: Date.now(), multiMount: false },
				null,
				2,
			),
		);
		assert.throws(
			() =>
				createControlHost({
					projectRoot: t.project,
					env: t.env,
					controlMode: "standalone",
					skipSingleton: true,
					provider: scriptProvider(t.project),
				}),
			(error: unknown) => {
				const err = error as { code?: string; message?: string };
				assert.equal(err.code, "TF_BOOTSTRAP_FAILED");
				assert.match(err.message ?? "", /co-admit|multi-mount|possession|mutator/i);
				return true;
			},
			"rewriting multiMount:false / dead pid must not co-admit under a live holder",
		);

		// Live holder still holds the open project store (even if durable singleton
		// fencing was vandalized — that is not license for a second mutator).
		assert.ok(writer.host.store, "live holder must still hold the open project store");
	} finally {
		writer?.host.close();
		try {
			if (writer?.singleton.role === "writer") {
				releaseSingleton(writer.singleton.mutationAuthority, t.env);
			}
		} catch {
			/* best-effort after counterexample mutation */
		}
		t.cleanup();
	}
});

test("D6 BLOCKER: cross-process wipe of rewritable hold metadata must not co-admit under live multi-mount holder", async () => {
	const t = temp();
	let writer: ReturnType<typeof openLiveDaemonStyleWriter> | undefined;
	try {
		writer = openLiveDaemonStyleWriter(t.project, t.env, "d6-xproc-wipe-writer");
		const controlRoot = path.join(t.project, ".taskflow", "control");
		const jsonHold = path.join(controlRoot, "mutator-hold.json");
		const lockPath = path.join(t.home, ".taskflow", "control", "singleton.lock");
		// Hostile same-UID content edit: wipe JSON metadata + singleton owner record.
		if (fs.existsSync(jsonHold)) fs.unlinkSync(jsonHold);
		if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);

		const helper = path.join(
			path.dirname(new URL(import.meta.url).pathname),
			"helpers",
			"mp-b06-try-coadmit.mts",
		);
		const child = spawnSync(
			process.execPath,
			["--conditions=development", "--experimental-strip-types", helper, t.project],
			{
				env: { ...t.env, TASKFLOW_HOME: t.home },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		// Child must refuse (exit 2) — not open a second mutator (exit 0).
		assert.equal(
			child.status,
			2,
			`cross-process co-admit must refuse under live holder; got status=${child.status}\nstdout=${child.stdout}\nstderr=${child.stderr}`,
		);
		assert.match(child.stdout + child.stderr, /co-admit|multi-mount|possession|TF_BOOTSTRAP_FAILED/i);
	} finally {
		writer?.host.close();
		try {
			if (writer?.singleton.role === "writer") {
				releaseSingleton(writer.singleton.mutationAuthority, t.env);
			}
		} catch {
			/* best-effort */
		}
		t.cleanup();
	}
});

/**
 * Residual same-UID non-cooperative bound (P15): the vandalism set that
 * **co-admits** is precisely:
 *   (lease path absent — unlink/rename of mutator-hold.lease) AND
 *   (user singleton absent OR dead PID)
 * while the original multi-mount holder still has its open FD + O_EXLOCK on the
 * orphaned inode. That set produces RESIDUAL_COADMIT — never claim fail-closed.
 *
 * Lease-only unlink/rename under a LIVE singleton is NOT this residual path
 * (secondary singleton+registry guard still refuses). Content-edit attacks
 * under a live holder still refuse (tests above).
 */
test("D6 residual bound: lease absent AND singleton absent co-admits (RESIDUAL_COADMIT — not fail-closed)", async () => {
	const t = temp();
	let writer: ReturnType<typeof openLiveDaemonStyleWriter> | undefined;
	try {
		writer = openLiveDaemonStyleWriter(t.project, t.env, "d6-residual-unlink-writer");
		assert.ok(
			multiMountPossessionSupportedOnPlatform(),
			"residual co-admit counterexample requires a platform that installed multi-mount possession",
		);
		const controlRoot = path.join(t.project, ".taskflow", "control");
		// Residual vandalism set (both required for co-admit):
		// 1) remove kernel possession pathname (holder keeps orphaned inode FD)
		// 2) remove user singleton owner record (dead/absent — not live)
		for (const name of ["mutator-hold.lease", "mutator-hold.sock", "mutator-hold.json"]) {
			const p = path.join(controlRoot, name);
			try {
				fs.unlinkSync(p);
			} catch {
				/* may be absent depending on implementation */
			}
		}
		const lockPath = path.join(t.home, ".taskflow", "control", "singleton.lock");
		assert.ok(fs.existsSync(lockPath), "fixture requires a live singleton before residual vandalism");
		fs.unlinkSync(lockPath);

		const helper = path.join(
			path.dirname(new URL(import.meta.url).pathname),
			"helpers",
			"mp-b06-try-coadmit.mts",
		);
		const child = spawnSync(
			process.execPath,
			["--conditions=development", "--experimental-strip-types", helper, t.project],
			{
				env: { ...t.env, TASKFLOW_HOME: t.home, TF_D6_EXPECT_RESIDUAL: "1" },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		const out = `${child.stdout}\n${child.stderr}`;
		// Observed behaviour: this vandalism set co-admits. Assert that — do not
		// accept refuse as "also fine" and do not label co-admit fail-closed.
		assert.equal(
			child.status,
			0,
			`residual set (lease absent + singleton absent) must co-admit with RESIDUAL_COADMIT; got status=${child.status}\n${out}`,
		);
		assert.match(
			out,
			/RESIDUAL_COADMIT/,
			"co-admit under residual vandalism must be explicitly labelled RESIDUAL_COADMIT",
		);
		assert.match(out, /same-UID|non-cooperative/i);
	} finally {
		writer?.host.close();
		try {
			if (writer?.singleton.role === "writer") {
				releaseSingleton(writer.singleton.mutationAuthority, t.env);
			}
		} catch {
			/* best-effort after residual vandalism */
		}
		t.cleanup();
	}
});

test("D6 residual bound: lease absent AND singleton dead PID co-admits (RESIDUAL_COADMIT)", async () => {
	const t = temp();
	let writer: ReturnType<typeof openLiveDaemonStyleWriter> | undefined;
	try {
		writer = openLiveDaemonStyleWriter(t.project, t.env, "d6-residual-dead-singleton");
		const controlRoot = path.join(t.project, ".taskflow", "control");
		for (const name of ["mutator-hold.lease", "mutator-hold.sock", "mutator-hold.json"]) {
			const p = path.join(controlRoot, name);
			try {
				fs.unlinkSync(p);
			} catch {
				/* ignore */
			}
		}
		const lockPath = path.join(t.home, ".taskflow", "control", "singleton.lock");
		assert.ok(fs.existsSync(lockPath));
		const rec = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
		rec.pid = 2_147_483_646; // not a live process
		fs.writeFileSync(lockPath, JSON.stringify(rec, null, 2));

		const helper = path.join(
			path.dirname(new URL(import.meta.url).pathname),
			"helpers",
			"mp-b06-try-coadmit.mts",
		);
		const child = spawnSync(
			process.execPath,
			["--conditions=development", "--experimental-strip-types", helper, t.project],
			{
				env: { ...t.env, TASKFLOW_HOME: t.home, TF_D6_EXPECT_RESIDUAL: "1" },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		const out = `${child.stdout}\n${child.stderr}`;
		assert.equal(
			child.status,
			0,
			`residual set (lease absent + singleton dead) must co-admit; got status=${child.status}\n${out}`,
		);
		assert.match(out, /RESIDUAL_COADMIT/);
	} finally {
		writer?.host.close();
		try {
			if (writer?.singleton.role === "writer") {
				releaseSingleton(writer.singleton.mutationAuthority, t.env);
			}
		} catch {
			/* best-effort */
		}
		t.cleanup();
	}
});

test("D6 MAJOR: lease-only unlink under LIVE singleton is NOT residual — still refuses co-admit", async () => {
	const t = temp();
	let writer: ReturnType<typeof openLiveDaemonStyleWriter> | undefined;
	try {
		writer = openLiveDaemonStyleWriter(t.project, t.env, "d6-lease-only-live-singleton");
		const controlRoot = path.join(t.project, ".taskflow", "control");
		// Lease-only vandalism: remove possession pathname, leave singleton LIVE.
		for (const name of ["mutator-hold.lease", "mutator-hold.sock", "mutator-hold.json"]) {
			const p = path.join(controlRoot, name);
			try {
				fs.unlinkSync(p);
			} catch {
				/* ignore */
			}
		}
		const lockPath = path.join(t.home, ".taskflow", "control", "singleton.lock");
		assert.ok(fs.existsSync(lockPath), "singleton must remain present for this counterexample");
		const rec = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
		assert.ok(typeof rec.pid === "number" && rec.pid > 0, "singleton pid must be live writer");

		const helper = path.join(
			path.dirname(new URL(import.meta.url).pathname),
			"helpers",
			"mp-b06-try-coadmit.mts",
		);
		const child = spawnSync(
			process.execPath,
			["--conditions=development", "--experimental-strip-types", helper, t.project],
			{
				env: { ...t.env, TASKFLOW_HOME: t.home },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		const out = `${child.stdout}\n${child.stderr}`;
		assert.equal(
			child.status,
			2,
			`lease-only under live singleton must refuse (not residual co-admit); got status=${child.status}\n${out}`,
		);
		assert.match(out, /co-admit|multi-mount|REFUSED|TF_BOOTSTRAP_FAILED/i);
		assert.doesNotMatch(out, /RESIDUAL_COADMIT/);
	} finally {
		writer?.host.close();
		try {
			if (writer?.singleton.role === "writer") {
				releaseSingleton(writer.singleton.mutationAuthority, t.env);
			}
		} catch {
			/* best-effort */
		}
		t.cleanup();
	}
});

test("D6 MAJOR: 0.3 multi-mount possession is only claimed where O_EXLOCK binds synchronously (Resolution B)", () => {
	// Platform matrix is pure policy — no Linux syscall pretence on Darwin.
	assert.equal(multiMountPossessionSupportedOnPlatform("darwin"), true);
	assert.equal(multiMountPossessionSupportedOnPlatform("freebsd"), true);
	assert.equal(multiMountPossessionSupportedOnPlatform("openbsd"), true);
	assert.equal(
		multiMountPossessionSupportedOnPlatform("linux"),
		false,
		"Linux multi-mount is not supported in 0.3 (async flock helper removed)",
	);
	assert.equal(multiMountPossessionSupportedOnPlatform("win32"), false);
	// Current host must match the matrix (this machine is Darwin in CI for B06).
	assert.equal(
		multiMountPossessionSupportedOnPlatform(),
		multiMountPossessionSupportedOnPlatform(process.platform),
	);
	if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
		assert.equal(multiMountPossessionSupportedOnPlatform(), true);
	} else {
		assert.equal(
			multiMountPossessionSupportedOnPlatform(),
			false,
			"non-O_EXLOCK platforms must not claim multi-mount possession",
		);
	}
});
