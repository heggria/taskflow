/**
 * B06 red/green: on-demand mount (D1), mount authority (D2), UDS handle
 * cleanup (D3), and agent/gate fail-closed over UDS (D4).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { startDaemon } from "../src/daemon.ts";
import {
	startUdsServer,
	udsRpc,
	PROTOCOL_MAJOR,
	UDS_RPC_TIMEOUT_MS,
} from "../src/uds-server.ts";
import { sameProjectRoot } from "../src/mount.ts";
import { controlClientRpc } from "taskflow-control";

/**
 * On case-insensitive volumes, return an alternate spelling of `dir` that
 * resolves to the same device+inode. Returns null on case-sensitive FS.
 */
function sameInodeCaseVariant(dir: string): string | null {
	const base = path.basename(dir);
	const parent = path.dirname(dir);
	let flipped: string | null = null;
	for (let i = 0; i < base.length; i++) {
		const ch = base[i]!;
		const up = ch.toUpperCase();
		const lo = ch.toLowerCase();
		if (up !== lo) {
			flipped = base.slice(0, i) + (ch === up ? lo : up) + base.slice(i + 1);
			break;
		}
	}
	if (!flipped || flipped === base) return null;
	const candidate = path.join(parent, flipped);
	try {
		const a = fs.statSync(dir);
		const b = fs.statSync(candidate);
		if (a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino) {
			return candidate;
		}
	} catch {
		/* case-sensitive volume: alternate spelling does not exist */
	}
	return null;
}

function tempHome(): { home: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-home-"));
	return {
		home,
		env: { ...process.env, TASKFLOW_HOME: home },
		cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
	};
}

const SCRIPT = {
	name: "b06-script",
	phases: [{ id: "main", type: "script" as const, run: "echo b06-ok", final: true }],
};

test("D1: empty-mount daemon admits via absolute projectRoot and keeps one shared ledger", async () => {
	if (process.platform === "win32") return;
	const t = tempHome();
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-proj-"));
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [],
			// Containment allowlist: only this project may mount on demand.
			mountAllowRoots: [project],
			holderId: "b06-empty-mount",
			listenUds: true,
		});
		assert.equal(daemon.role, "writer");
		assert.equal(daemon.hosts.size, 0, "daemon must start with empty mounts");
		assert.ok(daemon.socketPath);

		const result = (await udsRpc(daemon.socketPath!, "admit", {
			projectRoot: project,
			commandId: "b06-ondemand-1",
			program: SCRIPT,
		})) as {
			ok?: boolean;
			run?: { runId: string; status: string };
			receipt?: { receiptId: string };
		};

		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.run?.status, "completed");
		assert.ok(result.run?.runId);
		assert.ok(result.receipt?.receiptId);
		assert.equal(daemon.hosts.size, 1, "exactly one host after on-demand mount");

		const host = [...daemon.hosts.values()][0]!;
		const snap = host.getSnapshot(result.run!.runId);
		assert.ok(snap, "mounted ControlHost must observe the admitted run");
		assert.equal(snap!.run.runId, result.run!.runId);
		assert.equal(snap!.receipt?.receiptId, result.receipt!.receiptId);

		// Second admit reuses the same host (no second writer / ledger).
		const again = (await controlClientRpc(
			"admit",
			{
				projectRoot: project,
				projectId: host.projectId,
				commandId: "b06-ondemand-2",
				program: {
					name: "b06-script-2",
					phases: [{ id: "main", type: "script", run: "echo again", final: true }],
				},
			},
			{ socketPath: daemon.socketPath!, env: t.env, principal: "test" },
		)) as { ok?: boolean; run?: { runId: string } };
		assert.equal(again.ok, true);
		assert.equal(daemon.hosts.size, 1);
		assert.ok(host.getSnapshot(again.run!.runId));
	} finally {
		await daemon?.stop();
		fs.rmSync(project, { recursive: true, force: true });
		t.cleanup();
	}
});

test("D2: on-demand mount default-denies and refuses outside allowlist / traversal / symlink escape", async () => {
	if (process.platform === "win32") return;
	const t = tempHome();
	const allowBase = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-allow-"));
	const allowedProject = fs.mkdtempSync(path.join(allowBase, "allowed-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-outside-"));
	const linkEscape = path.join(allowBase, "escape-link");
	fs.symlinkSync(outside, linkEscape);
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		// Empty allowlist: default deny even for a real absolute directory.
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [],
			mountAllowRoots: [],
			holderId: "b06-deny-default",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);
		await assert.rejects(
			() =>
				udsRpc(daemon!.socketPath!, "admit", {
					projectRoot: outside,
					commandId: "b06-deny-default",
					program: SCRIPT,
				}),
			(e: Error & { code?: string }) =>
				e.code === "TF_POLICY_DENIED" || /policy|allow|denied|mount/i.test(e.message),
		);
		assert.equal(daemon.hosts.size, 0);
		await daemon.stop();
		daemon = undefined;

		// Explicit allow base: outside still denied; symlink under allow that
		// resolves outside must not bypass; relative path must not bypass.
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [],
			mountAllowRoots: [allowBase],
			holderId: "b06-deny-escape",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);

		await assert.rejects(
			() =>
				udsRpc(daemon!.socketPath!, "admit", {
					projectRoot: outside,
					commandId: "b06-outside",
					program: SCRIPT,
				}),
			(e: Error & { code?: string }) => e.code === "TF_POLICY_DENIED",
		);

		await assert.rejects(
			() =>
				udsRpc(daemon!.socketPath!, "admit", {
					projectRoot: linkEscape,
					commandId: "b06-symlink-escape",
					program: SCRIPT,
				}),
			(e: Error & { code?: string }) => e.code === "TF_POLICY_DENIED",
		);

		await assert.rejects(
			() =>
				udsRpc(daemon!.socketPath!, "admit", {
					projectRoot: path.join(allowBase, "..", path.basename(outside)),
					commandId: "b06-rel-escape",
					program: SCRIPT,
				}),
			(e: Error & { code?: string }) =>
				e.code === "TF_POLICY_DENIED" ||
				e.code === "TF_INVALID_ARGUMENT" ||
				e.code === "TF_NOT_FOUND",
		);

		await assert.rejects(
			() =>
				udsRpc(daemon!.socketPath!, "admit", {
					projectRoot: "relative/not/absolute",
					commandId: "b06-relative",
					program: SCRIPT,
				}),
			(e: Error & { code?: string }) => e.code === "TF_INVALID_ARGUMENT",
		);

		// Positive control: allowed project under the allow base mounts.
		const ok = (await udsRpc(daemon.socketPath!, "admit", {
			projectRoot: allowedProject,
			commandId: "b06-allowed",
			program: SCRIPT,
		})) as { ok?: boolean };
		assert.equal(ok.ok, true);
		assert.equal(daemon.hosts.size, 1);
	} finally {
		await daemon?.stop();
		fs.rmSync(allowBase, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
		t.cleanup();
	}
});

test("D3: UDS client + server close every handle so stop resolves without force-exit", async () => {
	if (process.platform === "win32") return;
	const t = tempHome();
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-handles-"));
	const sockPath = path.join(t.home, "handles.sock");
	let server: Awaited<ReturnType<typeof startUdsServer>> | undefined;
	try {
		const { createControlHost, createScriptExecutionProvider } = await import("taskflow-control");
		const host = createControlHost({
			projectRoot: project,
			env: t.env,
			controlMode: "standalone",
			skipSingleton: true,
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		server = await startUdsServer({
			socketPath: sockPath,
			fencingEpoch: 1,
			role: "writer",
			isWriterAuthoritative: () => true,
			getHost: () => host,
		});

		for (let i = 0; i < 5; i++) {
			const r = (await udsRpc(server.socketPath, "admit", {
				commandId: `b06-handle-${i}`,
				program: {
					name: "h",
					phases: [{ id: "main", type: "script", run: "true", final: true }],
				},
			})) as { ok?: boolean };
			assert.equal(r.ok, true);
		}

		// Half-open peer must not pin the server after close.
		const idle = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.connect(sockPath);
			s.once("connect", () => resolve(s));
			s.once("error", reject);
		});
		void PROTOCOL_MAJOR;

		const closeStarted = Date.now();
		await server.close();
		server = undefined;
		const closeMs = Date.now() - closeStarted;
		assert.ok(closeMs < 2_000, `server.close must finish promptly (took ${closeMs}ms)`);
		assert.ok(!fs.existsSync(sockPath), "socket file unlinked on close");
		// Client handle must not keep the event loop alive either.
		if (!idle.destroyed) idle.destroy();

		// Client-side udsRpc must not leave a long-lived timer that forces --test-force-exit.
		// If a 10s timeout handle leaked, this suite would hang after assertions.
		host.close();
	} finally {
		if (server) await server.close();
		fs.rmSync(project, { recursive: true, force: true });
		t.cleanup();
	}
});

test("D4: agent phase over UDS stays fail-closed (no portable host LLM bridge)", async () => {
	if (process.platform === "win32") return;
	const t = tempHome();
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-agent-"));
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [project],
			holderId: "b06-agent-uds",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);
		const projectId = [...daemon.hosts.keys()][0];
		const result = (await udsRpc(daemon.socketPath!, "admit", {
			projectId,
			commandId: "b06-agent-no-llm",
			program: {
				name: "agent-only",
				phases: [
					{
						id: "main",
						type: "agent",
						agent: "executor",
						task: "must not invent a host LLM bridge",
						final: true,
					},
				],
			},
		})) as { ok?: boolean; run?: { status: string; error?: string }; receipt?: unknown };

		// Handled by ControlHost on the daemon (not transport error), but must not succeed.
		assert.equal(result.ok, false, JSON.stringify(result));
		assert.match(
			String(result.run?.error ?? JSON.stringify(result)),
			/LLM|llm|provider|fail/i,
		);
	} finally {
		await daemon?.stop();
		fs.rmSync(project, { recursive: true, force: true });
		t.cleanup();
	}
});

test("D5: pre-mounted projectRoot reuses host under empty allowlist; first-time unlisted still denied", async () => {
	if (process.platform === "win32") return;
	const t = tempHome();
	const preMounted = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-premount-"));
	const unlisted = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-unlisted-"));
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		// Operator explicitly pre-mounted this project; allowlist is empty (default deny
		// for *new* on-demand mounts only — reuse must not consult the allowlist).
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [preMounted],
			mountAllowRoots: [],
			holderId: "b06-premount-reuse",
			listenUds: true,
		});
		assert.equal(daemon.role, "writer");
		assert.equal(daemon.hosts.size, 1);
		assert.ok(daemon.socketPath);
		const writerHost = [...daemon.hosts.values()][0]!;
		const hostsBefore = daemon.hosts.size;

		// MCP/UDS admit with absolute projectRoot of the pre-mounted project must succeed.
		const ok = (await udsRpc(daemon.socketPath!, "admit", {
			projectRoot: preMounted,
			commandId: "b06-premount-admit",
			program: SCRIPT,
		})) as { ok?: boolean; run?: { runId: string; status: string }; receipt?: { receiptId: string } };
		assert.equal(ok.ok, true, JSON.stringify(ok));
		assert.equal(ok.run?.status, "completed");
		assert.ok(ok.run?.runId);
		assert.ok(ok.receipt?.receiptId);
		assert.equal(daemon.hosts.size, hostsBefore, "reuse must not open a second host");
		assert.ok(writerHost.getSnapshot(ok.run!.runId), "same pre-mounted host observes the run");

		// Direct mount API: already-mounted root under empty allowlist is reuse, not deny.
		const remount = daemon.mountProject(preMounted);
		assert.equal(remount.ok, true, JSON.stringify(remount));
		if (remount.ok) {
			assert.equal(remount.mounted, false, "must report reuse, not a new mount");
			assert.equal(remount.host.projectId, writerHost.projectId);
		}

		// First-time unlisted root is still default-denied (allowlist applies only on open).
		const denied = daemon.mountProject(unlisted);
		assert.equal(denied.ok, false);
		if (!denied.ok) {
			assert.equal(denied.code, "TF_POLICY_DENIED");
			assert.match(denied.message, /allowlist|denied|default deny/i);
		}
		await assert.rejects(
			() =>
				udsRpc(daemon!.socketPath!, "admit", {
					projectRoot: unlisted,
					commandId: "b06-unlisted-deny",
					program: SCRIPT,
				}),
			(e: Error & { code?: string }) => e.code === "TF_POLICY_DENIED",
		);
		assert.equal(daemon.hosts.size, hostsBefore);
	} finally {
		await daemon?.stop();
		fs.rmSync(preMounted, { recursive: true, force: true });
		fs.rmSync(unlisted, { recursive: true, force: true });
		t.cleanup();
	}
});

test("D6: live daemon blocks production co-admit dual-writer (MCP + auto attach)", async () => {
	if (process.platform === "win32") return;
	const t = tempHome();
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-dual-"));
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [project],
			mountAllowRoots: [],
			holderId: "b06-dual-writer-guard",
			listenUds: true,
		});
		assert.equal(daemon.role, "writer");
		assert.equal(daemon.hosts.size, 1);
		const writerHost = [...daemon.hosts.values()][0]!;

		// Seed one run on the sole writer ledger so dual-mutation is observable.
		const seed = (await udsRpc(daemon.socketPath!, "admit", {
			projectRoot: project,
			commandId: "b06-dual-seed",
			program: SCRIPT,
		})) as { ok?: boolean; run?: { runId: string } };
		assert.equal(seed.ok, true, JSON.stringify(seed));
		assert.ok(writerHost.getSnapshot(seed.run!.runId));

		const {
			createControlHost,
			createScriptExecutionProvider,
			tryControlPlaneRun,
		} = await import("taskflow-control");

		// Production MCP ingress previously used controlMode:standalone + skipSingleton.
		// With a live taskflowd writer it must attach over UDS (shared ledger), never
		// open a second local mutator.
		const routed = await tryControlPlaneRun(
			project,
			{
				name: "b06-dual-mcp",
				phases: [{ id: "main", type: "script", run: "echo dual-mcp-ok", final: true }],
			},
			{
				env: t.env,
				commandId: "b06-dual-mcp-1",
				principal: "mcp:dual",
			},
		);
		assert.equal(routed.handled, true, JSON.stringify(routed));
		if (!routed.handled) throw new Error("unreachable");
		assert.equal(routed.ok, true, routed.text);
		assert.equal(
			(routed as { via?: string }).via,
			"uds-client",
			"MCP must not skipSingleton-standalone co-admit while daemon is live",
		);
		assert.ok(writerHost.getSnapshot(routed.runId!), "sole daemon ledger owns the MCP run");
		assert.equal(daemon.hosts.size, 1);

		// GA auto path without skipSingleton attaches read-only — cannot co-mutate.
		const attachHost = createControlHost({
			projectRoot: project,
			env: t.env,
			controlMode: "auto",
			scriptProvider: createScriptExecutionProvider({
				stateDir: path.join(project, ".taskflow", "control", "provider-jobs"),
			}),
		});
		try {
			assert.equal(attachHost.role, "attach");
			assert.equal(attachHost.canMutate, false);
			const attachAdmit = await attachHost.admitAndRun({
				commandId: "b06-dual-attach-mutate",
				callerPrincipal: "test",
				program: {
					name: "must-not-mutate",
					phases: [{ id: "main", type: "script", run: "echo leak", final: true }],
				},
			});
			assert.equal(attachAdmit.ok, false, "attach co-admit must fail closed");
			// No new successful run on the daemon ledger from the attach attempt.
			assert.equal(daemon.hosts.size, 1);
			assert.ok(writerHost.getSnapshot(seed.run!.runId));
			assert.ok(writerHost.getSnapshot(routed.runId!));
		} finally {
			attachHost.close();
		}

		// Fail-closed when a live writer owns the singleton but UDS is unreachable:
		// production route must not fall through to skipSingleton standalone authority.
		// Simulate by pointing env at a different TASKFLOW_HOME that has no daemon,
		// then separately: same home with UDS path removed after stop is covered above.
		// Here we force attach-without-UDS by using coordinated-style auto after
		// proving the writer lock is held (second startDaemon is attach).
		const attachDaemon = await startDaemon({
			env: t.env,
			projectRoots: [project],
			holderId: "b06-dual-attach-daemon",
			listenUds: false,
		});
		try {
			assert.equal(attachDaemon.role, "attach");
			// attach daemon has no UDS listen; MCP probe may still hit the writer UDS.
			// Direct createControlHost auto must remain attach / non-mutating.
			const peer = createControlHost({
				projectRoot: project,
				env: t.env,
				controlMode: "auto",
				scriptProvider: createScriptExecutionProvider({
					stateDir: path.join(project, ".taskflow", "control", "provider-jobs-peer"),
				}),
			});
			try {
				assert.equal(peer.role, "attach");
				assert.equal(peer.canMutate, false);
			} finally {
				peer.close();
			}
		} finally {
			await attachDaemon.stop();
		}

		// Daemon remains sole successful mutator for further admits.
		const after = (await udsRpc(daemon.socketPath!, "admit", {
			projectRoot: project,
			commandId: "b06-dual-after",
			program: {
				name: "after",
				phases: [{ id: "main", type: "script", run: "echo after-ok", final: true }],
			},
		})) as { ok?: boolean; run?: { runId: string } };
		assert.equal(after.ok, true);
		assert.ok(writerHost.getSnapshot(after.run!.runId));
		assert.equal(daemon.hosts.size, 1);
	} finally {
		await daemon?.stop();
		fs.rmSync(project, { recursive: true, force: true });
		t.cleanup();
	}
});

test("D7: same-inode case-variant paths are the same project (realpath strings may differ)", () => {
	if (process.platform === "win32") return;
	// Create a directory whose basename has letters we can case-flip.
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-case-"));
	const project = path.join(parent, "MyProject");
	fs.mkdirSync(project);
	try {
		const variant = sameInodeCaseVariant(project);
		if (!variant) {
			// Case-sensitive volume: identity counterexample does not apply.
			return;
		}
		const realA = fs.realpathSync(project);
		const realB = fs.realpathSync(variant);
		const sa = fs.statSync(project);
		const sb = fs.statSync(variant);
		assert.equal(sa.dev, sb.dev);
		assert.equal(sa.ino, sb.ino);
		// Live counterexample: realpath string compare is not enough on APFS/HFS+.
		// (On some volumes they coincide — still require inode identity to match.)
		if (realA !== realB) {
			assert.notEqual(realA, realB, "precondition: realpath case-fold differs");
		}
		assert.equal(
			sameProjectRoot(project, variant),
			true,
			`same inode must be same project (realpath ${realA} vs ${realB})`,
		);
		assert.equal(sameProjectRoot(variant, project), true);
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("D8: pre-mounted empty-allowlist reuses host for same-inode case-variant projectRoot", async () => {
	if (process.platform === "win32") return;
	const t = tempHome();
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-case-pre-"));
	const project = path.join(parent, "CaseRoot");
	fs.mkdirSync(project);
	const variant = sameInodeCaseVariant(project);
	if (!variant) {
		fs.rmSync(parent, { recursive: true, force: true });
		t.cleanup();
		return;
	}
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [project],
			mountAllowRoots: [],
			holderId: "b06-case-fold-reuse",
			listenUds: true,
		});
		assert.equal(daemon.hosts.size, 1);
		const writerHost = [...daemon.hosts.values()][0]!;
		const hostsBefore = daemon.hosts.size;

		// Direct mount API: case-variant of pre-mounted root must reuse, not POLICY_DENIED.
		const remount = daemon.mountProject(variant);
		assert.equal(remount.ok, true, JSON.stringify(remount));
		if (remount.ok) {
			assert.equal(remount.mounted, false, "must reuse, not open a second ledger");
			assert.equal(remount.host.projectId, writerHost.projectId);
		}
		assert.equal(daemon.hosts.size, hostsBefore);

		// UDS admit with case-variant projectRoot under empty allowlist must succeed.
		const ok = (await udsRpc(daemon.socketPath!, "admit", {
			projectRoot: variant,
			commandId: "b06-case-fold-admit",
			program: SCRIPT,
		})) as { ok?: boolean; run?: { runId: string; status: string } };
		assert.equal(ok.ok, true, JSON.stringify(ok));
		assert.equal(ok.run?.status, "completed");
		assert.ok(writerHost.getSnapshot(ok.run!.runId), "same pre-mounted host observes the run");
		assert.equal(daemon.hosts.size, hostsBefore);
	} finally {
		await daemon?.stop();
		fs.rmSync(parent, { recursive: true, force: true });
		t.cleanup();
	}
});

test("D9: multi-mount admit without projectId/projectRoot fails closed (no silent first host)", async () => {
	if (process.platform === "win32") return;
	const t = tempHome();
	const projA = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-multi-a-"));
	const projB = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-multi-b-"));
	const sockPath = path.join(t.home, "multi.sock");
	let server: Awaited<ReturnType<typeof startUdsServer>> | undefined;
	const { createControlHost, createScriptExecutionProvider } = await import("taskflow-control");
	const hostA = createControlHost({
		projectRoot: projA,
		env: t.env,
		controlMode: "standalone",
		skipSingleton: true,
		scriptProvider: createScriptExecutionProvider({
			stateDir: path.join(projA, ".taskflow", "control", "provider-jobs"),
		}),
	});
	const hostB = createControlHost({
		projectRoot: projB,
		env: t.env,
		controlMode: "standalone",
		skipSingleton: true,
		scriptProvider: createScriptExecutionProvider({
			stateDir: path.join(projB, ".taskflow", "control", "provider-jobs"),
		}),
	});
	const hosts = new Map<string, typeof hostA>([
		[hostA.projectId, hostA],
		[hostB.projectId, hostB],
	]);
	assert.ok(hosts.size >= 2);
	try {
		server = await startUdsServer({
			socketPath: sockPath,
			fencingEpoch: 1,
			role: "writer",
			isWriterAuthoritative: () => true,
			// Deliberately buggy-looking first-host fallback: production must not use it
			// when mountedHostCount > 1 without an explicit selector.
			getHost: (projectId) => {
				if (projectId) return hosts.get(projectId) ?? null;
				return hosts.values().next().value ?? null;
			},
			mountedHostCount: () => hosts.size,
		});

		// No projectId, no projectRoot: must NOT silently mutate hostA (first map entry).
		await assert.rejects(
			() =>
				udsRpc(server!.socketPath, "admit", {
					commandId: "b06-multi-silent",
					program: SCRIPT,
				}),
			(e: Error & { code?: string }) =>
				e.code === "TF_INVALID_ARGUMENT" ||
				e.code === "TF_NOT_FOUND" ||
				/projectId|projectRoot|multiple|ambiguous|more than one/i.test(e.message),
		);
		// Neither ledger may gain a run from the unscoped admit.
		assert.equal(hostA.store.listRuns().length, 0, "hostA must not receive silent admit");
		assert.equal(hostB.store.listRuns().length, 0, "hostB must not receive silent admit");

		// Explicit projectId still routes correctly.
		const toA = (await udsRpc(server.socketPath, "admit", {
			projectId: hostA.projectId,
			commandId: "b06-multi-a",
			program: SCRIPT,
		})) as { ok?: boolean; run?: { runId: string } };
		assert.equal(toA.ok, true, JSON.stringify(toA));
		assert.ok(hostA.getSnapshot(toA.run!.runId));
		assert.equal(hostB.getSnapshot(toA.run!.runId), null);

		// status without selector under multi-mount also fails closed.
		await assert.rejects(
			() =>
				udsRpc(server!.socketPath, "status", {
					runId: toA.run!.runId,
				}),
			(e: Error & { code?: string }) =>
				e.code === "TF_INVALID_ARGUMENT" ||
				e.code === "TF_NOT_FOUND" ||
				/projectId|projectRoot|multiple|ambiguous|more than one/i.test(e.message),
		);
	} finally {
		if (server) await server.close();
		hostA.close();
		hostB.close();
		fs.rmSync(projA, { recursive: true, force: true });
		fs.rmSync(projB, { recursive: true, force: true });
		t.cleanup();
	}
});

test("D10: multi-mount via startDaemon requires explicit project selector for admit", async () => {
	if (process.platform === "win32") return;
	const t = tempHome();
	const projA = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-dm-a-"));
	const projB = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-dm-b-"));
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env: t.env,
			projectRoots: [projA, projB],
			mountAllowRoots: [],
			holderId: "b06-daemon-multi",
			listenUds: true,
		});
		assert.equal(daemon.role, "writer");
		assert.ok(daemon.hosts.size >= 2, `expected multi-mount, got ${daemon.hosts.size}`);
		assert.ok(daemon.socketPath);

		await assert.rejects(
			() =>
				udsRpc(daemon!.socketPath!, "admit", {
					commandId: "b06-daemon-multi-silent",
					program: SCRIPT,
				}),
			(e: Error & { code?: string }) =>
				e.code === "TF_INVALID_ARGUMENT" ||
				/projectId|projectRoot|multiple|ambiguous|more than one/i.test(e.message),
		);

		// No run landed on any host.
		for (const h of daemon.hosts.values()) {
			assert.equal(h.store.listRuns().length, 0, `host ${h.projectId} must stay empty`);
		}

		const firstId = [...daemon.hosts.keys()][0]!;
		const firstHost = daemon.hosts.get(firstId)!;
		const ok = (await udsRpc(daemon.socketPath!, "admit", {
			projectId: firstId,
			commandId: "b06-daemon-multi-explicit",
			program: SCRIPT,
		})) as { ok?: boolean; run?: { runId: string } };
		assert.equal(ok.ok, true, JSON.stringify(ok));
		assert.ok(firstHost.getSnapshot(ok.run!.runId));
	} finally {
		await daemon?.stop();
		fs.rmSync(projA, { recursive: true, force: true });
		fs.rmSync(projB, { recursive: true, force: true });
		t.cleanup();
	}
});

test("D11: udsRpc hang budget is load-tolerant (not a 10s load-brittle ceiling)", () => {
	// Correctness suites under concurrent load (suite×2) must not time out because
	// the client helper used a quiet-machine 10s budget. Bound is a hang detector,
	// not a performance SLO.
	assert.ok(
		UDS_RPC_TIMEOUT_MS >= 60_000,
		`UDS_RPC_TIMEOUT_MS=${UDS_RPC_TIMEOUT_MS} must be >= 60s under suite contention`,
	);
});

test("D12: udsRpc honors timeoutMs and cleans up without force-exit", async () => {
	if (process.platform === "win32") return;
	const t = tempHome();
	const sockPath = path.join(t.home, "timeout.sock");
	let server: net.Server | undefined;
	try {
		// Minimal peer: hello-ok, then never answer the RPC (hang detector path).
		server = net.createServer((socket) => {
			let acc = "";
			socket.on("data", (chunk) => {
				acc += chunk.toString("utf8");
				let idx: number;
				while ((idx = acc.indexOf("\n")) >= 0) {
					const line = acc.slice(0, idx);
					acc = acc.slice(idx + 1);
					let msg: Record<string, unknown>;
					try {
						msg = JSON.parse(line) as Record<string, unknown>;
					} catch {
						continue;
					}
					if (msg.type === "hello") {
						socket.write(
							JSON.stringify({
								type: "hello-ok",
								protocolMajor: PROTOCOL_MAJOR,
								fencingEpoch: 1,
								role: "writer",
								capabilities: [],
							}) + "\n",
						);
					}
					// Intentionally ignore rpc — client must time out.
				}
			});
			socket.on("error", () => {});
		});
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(sockPath, () => resolve());
		});

		const started = Date.now();
		await assert.rejects(
			() => udsRpc(sockPath, "status", { runId: "x" }, { timeoutMs: 200 }),
			(e: Error) => /timeout/i.test(e.message),
		);
		const elapsed = Date.now() - started;
		assert.ok(elapsed >= 150, `timeout should wait ~200ms (elapsed ${elapsed}ms)`);
		assert.ok(elapsed < 5_000, `timeout must not hang the suite (elapsed ${elapsed}ms)`);
	} finally {
		await new Promise<void>((resolve) => {
			if (!server) {
				resolve();
				return;
			}
			// Destroy lingering peers so the suite exits cleanly.
			const closeAll = (
				server as net.Server & { closeAllConnections?: () => void }
			).closeAllConnections?.bind(server);
			try {
				closeAll?.();
			} catch {
				/* ignore */
			}
			server.close(() => resolve());
		});
		try {
			fs.unlinkSync(sockPath);
		} catch {
			/* ignore */
		}
		t.cleanup();
	}
});
