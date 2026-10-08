import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { AUTHORIZATION_CAPABILITIES, answerAuthorizationChallenge, createAuthorizationAuthority, type AuthorizationChallenge } from "../src/authorization.ts";
import { ProjectRegistry } from "../src/project-registry.ts";
import { RuntimeTeExecutionProvider } from "../src/runtime-provider.ts";
import type { RunSnapshot } from "../src/schema/run.ts";
import type { ApprovalRequest } from "../src/schema/approval.ts";
import { connectUdsClient, type UdsClient } from "../src/uds.ts";
import { ControlHost, type ControlHostOptions } from "../src/control-host.ts";
import { ControlError } from "../src/errors.ts";
import { createTeExecutionProvider, type TeExecutionAuthority } from "../src/te-provider.ts";
import { singletonPaths, type SingletonPaths } from "../src/singleton.ts";
import { PROTOCOL_MAJOR, type NegotiationHandshake } from "../src/schema/transport.ts";

const tempRoots: string[] = [];

function makePaths(): SingletonPaths {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tf-control-host-"));
	tempRoots.push(root);
	return singletonPaths(root);
}

after(() => {
	for (const root of tempRoots) {
		try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});

function fakeProvider() {
	const te: TeExecutionAuthority = {
		assurance: "resolve-only-no-sandbox",
		probe: async () => ({ classification: "resolve-only" as const, baselinePolicyId: "taskflow-resolve-only", hostProbeSha256: "a".repeat(64) }),
		prepare: async () => ({ outcome: "accepted" as const, fulfillment: { preparationId: "prep", enforcementCapabilities: { resolution: "contained", mutationMediation: "brokered", processIsolation: "none", revocation: "admission-only", baselinePolicyId: "b", hostProbeSha256: "a".repeat(64) } } }),
		submit: async () => ({ outcome: "accepted" as const, providerJobHandle: "job" }),
		watch: async function* () { yield { kind: "terminal" as const, outcome: "completed" as const }; },
	};
	return createTeExecutionProvider(te);
}

function hostOptions(paths: SingletonPaths, overrides: Partial<ControlHostOptions> = {}): ControlHostOptions {
	return {
		provider: fakeProvider(),
		singletonPaths: paths,
		controlHome: paths.controlHome,
		...overrides,
	};
}

const clientHello: NegotiationHandshake = {
	protocolMajor: PROTOCOL_MAJOR,
	supportedReadSchemas: ["taskflow.wire.v1"],
	supportedWriteSchemas: ["taskflow.wire.v1"],
	requiredFeatures: [],
	offeredFeatures: [],
	buildInfo: { packageVersion: "0.3.0", gitCommit: "abc", schemaVersion: 1 },
};

test("control-host: refuses a non-TE execution authority (fail closed)", () => {
	const paths = makePaths();
	assert.throws(
		() => new ControlHost({ provider: { kind: "custom-provider" } as never, singletonPaths: paths }),
		(error: unknown) => {
			assert.ok(error instanceof ControlError);
			assert.equal((error as ControlError).code, "TF_AUTHORITY_REVOKED");
			return true;
		},
	);
});

test("control-host: auto mode starts and wins the singleton; a second host attaches", async () => {
	const paths = makePaths();
	const first = new ControlHost(hostOptions(paths, { mode: "auto", holderId: "h1" }));
	const status = await first.start();
	assert.equal(status.state, "started");
	assert.equal(status.singleton, "won");
	assert.equal(status.globalAuthority, true);
	assert.equal(status.fencingEpoch, 1);

	const second = new ControlHost(hostOptions(paths, { mode: "auto", holderId: "h2" }));
	const attached = await second.start();
	assert.equal(attached.state, "started");
	assert.equal(attached.singleton, "attached");
	assert.equal(attached.holderId, "h1");
	first.stop();
	second.stop();
});

test("control-host: standalone is explicit, single-owner, no global authority; second standalone fails closed", async () => {
	const paths = makePaths();
	const first = new ControlHost(hostOptions(paths, { mode: "standalone", holderId: "s1" }));
	const status = await first.start();
	assert.equal(status.state, "started");
	assert.equal(status.singleton, "standalone");
	assert.equal(status.globalAuthority, false);

	// A second standalone on the same project store is a dual writer → fail closed.
	const second = new ControlHost(hostOptions(paths, { mode: "standalone", holderId: "s2" }));
	await assert.rejects(second.start(), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_BOOTSTRAP_FAILED");
		return true;
	});
	assert.equal(second.status.state, "failed-closed");
	first.stop();
});

test("control-host: coordinated fails closed when no external control is up", async () => {
	const paths = makePaths();
	const host = new ControlHost(hostOptions(paths, { mode: "coordinated" }));
	await assert.rejects(host.start(), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_JOURNAL_UNAVAILABLE");
		return true;
	});
	assert.equal(host.status.state, "failed-closed");
});

test("control-host: coordinated attaches to an existing external control", async () => {
	const paths = makePaths();
	const external = new ControlHost(hostOptions(paths, { mode: "auto", holderId: "daemon" }));
	await external.start();
	const coordinated = new ControlHost(hostOptions(paths, { mode: "coordinated", holderId: "client" }));
	const status = await coordinated.start();
	assert.equal(status.state, "started");
	assert.equal(status.singleton, "attached");
	assert.equal(status.holderId, "daemon");
	external.stop();
	coordinated.stop();
});

test("control-host: hello-before-RPC — dispatch before hello is rejected; probe works after", async () => {
	const paths = makePaths();
	const host = new ControlHost(hostOptions(paths, { mode: "standalone", holderId: "h" }));
	await host.start();
	await assert.rejects(host.dispatch("control.status", undefined, { fencingEpoch: 1 }), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_PROTOCOL_INCOMPATIBLE");
		assert.match((error as ControlError).message, /hello must precede any RPC/);
		return true;
	});
	const verdict = host.hello(clientHello);
	assert.equal(verdict.ok, true);
	const status = await host.dispatch<{ state: string }>("control.status", undefined, { fencingEpoch: 1 });
	assert.equal(status.state, "started");
	host.stop();
});

test("control-host: stale fencing epoch is rejected on dispatch", async () => {
	const paths = makePaths();
	const host = new ControlHost(hostOptions(paths, { mode: "standalone", holderId: "h" }));
	await host.start();
	host.hello(clientHello);
	await assert.rejects(host.dispatch("control.status", undefined, { fencingEpoch: 0 }), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_AUTHORITY_REVOKED");
		return true;
	});
	host.stop();
});

test("control-host: control.probe delegates to the TE provider", async () => {
	const paths = makePaths();
	const host = new ControlHost(hostOptions(paths, { mode: "standalone", holderId: "h" }));
	await host.start();
	host.hello(clientHello);
	const probe = await host.dispatch<{ outcome: string; capabilities: { processIsolation: string } }>("control.probe", undefined, { fencingEpoch: 1 });
	assert.equal(probe.outcome, "accepted");
	assert.equal(probe.capabilities.processIsolation, "none");
	host.stop();
});

test("control-host: unknown RPC → TF_COMMAND_FAILED", async () => {
	const paths = makePaths();
	const host = new ControlHost(hostOptions(paths, { mode: "standalone", holderId: "h" }));
	await host.start();
	host.hello(clientHello);
	await assert.rejects(host.dispatch("no.such.method", undefined, { fencingEpoch: 1 }), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_COMMAND_FAILED");
		return true;
	});
	host.stop();
});

test("control-host: stop releases the singleton so a fresh host can win", async () => {
	const paths = makePaths();
	const first = new ControlHost(hostOptions(paths, { mode: "auto", holderId: "a" }));
	await first.start();
	assert.equal(first.status.singleton, "won");
	first.stop();
	const second = new ControlHost(hostOptions(paths, { mode: "auto", holderId: "b" }));
	const status = await second.start();
	assert.equal(status.singleton, "won");
	second.stop();
});

function authenticatedFixture(mode: "standalone" | "auto") {
	const paths = makePaths();
	const projectRoot = path.join(paths.controlHome, "project");
	fs.mkdirSync(projectRoot);
	const projectStorePath = path.join(projectRoot, ".taskflow", "control");
	const secret = randomBytes(32);
	const authorization = createAuthorizationAuthority({
		ownerUid: process.getuid!(), bootstrapSecret: secret, hostBaseline: AUTHORIZATION_CAPABILITIES,
		loadLivePolicy: () => ({ host: { capabilities: AUTHORIZATION_CAPABILITIES.map(kind => ({ kind, scopeRoot: projectRoot })) } }),
	});
	const provider = new RuntimeTeExecutionProvider(path.join(paths.controlHome, "provider"));
	let registry: ProjectRegistry;
	let owner: ControlHost;
	let caller: ControlHost;
	let context: ReturnType<typeof authorization.issueStandalone>;
	const wireClients: UdsClient[] = [];
	const dispatch = <T = unknown>(method: string, params?: unknown): Promise<T> => mode === "auto"
		? caller.dispatch<T>(method, params, { fencingEpoch: caller.status.fencingEpoch })
		: owner.dispatchAuthenticated<T>(context, method, params);
	const stop = () => { for (const client of wireClients) client.close(); if (caller !== owner) caller?.stop(); owner?.stop(); registry?.close(); };
	const start = async () => {
		registry = new ProjectRegistry(path.join(paths.controlHome, "registry.json"));
		const mount = registry.mount(projectStorePath, projectRoot);
		context = authorization.issueStandalone({ projectId: mount.store.header.projectId, controlDomainId: mount.store.header.controlDomainId, projectRoot });
		owner = new ControlHost(hostOptions(paths, { mode, provider, authorization, registry, holderId: "command-owner" }));
		await owner.start();
		owner.hello(clientHello);
		caller = owner;
		if (mode === "auto") {
			caller = new ControlHost(hostOptions(paths, { mode: "coordinated", provider, projectStorePath }));
			await caller.start();
			const challenge = await caller.dispatch<AuthorizationChallenge>("auth.challenge", { projectId: mount.store.header.projectId }, { fencingEpoch: caller.status.fencingEpoch });
			assert.deepEqual(challenge.binding, { projectId: mount.store.header.projectId, controlDomainId: mount.store.header.controlDomainId, projectRoot });
			const authenticated = await caller.dispatch("auth.authenticate", { challengeId: challenge.id, proof: answerAuthorizationChallenge(secret, challenge) }, { fencingEpoch: caller.status.fencingEpoch });
			assert.deepEqual(authenticated, { authenticated: true });
		}
	};
	const connectAuthenticated = async (offeredFeatures: string[]) => {
		const client = await connectUdsClient({ endpointPath: paths.endpointPath, clientHello: { ...clientHello, offeredFeatures } });
		wireClients.push(client);
		const challenge = await client.rpc<AuthorizationChallenge>("auth.challenge", { projectId: registry.resolve().store.header.projectId });
		assert.deepEqual(await client.rpc("auth.authenticate", { challengeId: challenge.id, proof: answerAuthorizationChallenge(secret, challenge) }), { authenticated: true });
		return client;
	};
	return { projectRoot, projectStorePath, provider, start, stop, dispatch, connectAuthenticated,
		unauthenticated: <T = unknown>(method: string, params?: unknown) => owner.dispatch<T>(method, params, { fencingEpoch: owner.status.fencingEpoch }) };
}

// Recovery may rebuild projections; only header, sequence and journal are authority.
function ledgerBytes(storePath: string, includeProjections = false) {
	const files: Record<string, Buffer> = {};
	for (const entry of fs.readdirSync(storePath, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && entry.name !== "writer.lock") {
			const file = path.join(entry.parentPath, entry.name);
			const relative = path.relative(storePath, file);
			if (includeProjections || !relative.startsWith(`projections${path.sep}`)) files[relative] = fs.readFileSync(file);
		}
	}
	return files;
}

test("control-host: authenticated standalone reopens the same durable project identity and ledger (A3)", async (t) => {
	const f = authenticatedFixture("standalone");
	t.after(f.stop);
	await f.start();
	const header = await f.dispatch<{ projectId: string; controlDomainId: string }>("control.store.header");
	assert.match(header.projectId, /^[0-9a-f-]{36}$/i);
	const accepted = await f.dispatch<{ runId: string }>("commands.submit", {
		commandId: randomUUID(), kind: "run.submit", flow: { name: "persisted", phases: [{ id: "work", type: "script", run: "printf durable-runtime" }] },
	});
	const run = await f.dispatch<RunSnapshot>("runs.wait", { runId: accepted.runId });
	assert.equal(run.status, "completed");
	assert.equal(run.slot, "released");
	const before = await f.dispatch<{ commitSeq: number }>("control.store.status");
	assert.ok(before.commitSeq > 0);
	const bytes = ledgerBytes(f.projectStorePath);
	f.stop();
	await f.start();
	assert.deepEqual(await f.dispatch("control.store.header"), header);
	assert.equal((await f.dispatch<{ commitSeq: number }>("control.store.status")).commitSeq, before.commitSeq);
	assert.deepEqual(await f.dispatch("runs.get", { runId: accepted.runId }), run);
	assert.deepEqual(ledgerBytes(f.projectStorePath), bytes);
});

for (const mode of ["standalone", "auto"] as const) {
	test(`commands.submit: ${mode} concurrent and restarted retries replay exactly and execute once`, {
		skip: mode === "auto" && process.platform === "win32",
	}, async (t) => {
		const f = authenticatedFixture(mode);
		t.after(f.stop);
		const submit = t.mock.method(f.provider, "submit");
		await f.start();
		const body = { commandId: randomUUID(), kind: "run.submit", flow: {
			name: "one-effect", phases: [{ id: "work", type: "script", run: "printf 'once\n' >> effects.txt; printf executed" }],
		} };
		const concurrent = await Promise.all([0, 1].map(() => f.dispatch<{ runId: string }>("commands.submit", body)));
		assert.equal(JSON.stringify(concurrent[1]), JSON.stringify(concurrent[0]));
		const accepted = concurrent[0]!;
		const completed = await f.dispatch<RunSnapshot>("runs.wait", { runId: accepted.runId });
		assert.equal(completed.status, "completed");
		assert.equal(completed.slot, "released");
		assert.equal((await f.provider.observe(accepted.runId)).finalOutput, "executed");
		assert.equal(fs.readFileSync(path.join(f.projectRoot, "effects.txt"), "utf8"), "once\n");
		assert.equal((await f.dispatch<RunSnapshot[]>("runs.list")).length, 1);
		const bytes = ledgerBytes(f.projectStorePath);
		const sequence = (await f.dispatch<{ commitSeq: number }>("control.store.status")).commitSeq;
		for (const restarted of [false, true]) {
			if (restarted) { f.stop(); await f.start(); }
			const allBytes = ledgerBytes(f.projectStorePath, true);
			assert.equal(JSON.stringify(await f.dispatch("commands.submit", body)), JSON.stringify(accepted));
			await assert.rejects(f.dispatch("commands.submit", { ...body, flow: { ...body.flow, name: "changed-request" } }), (error: unknown) => {
				assert.ok(error instanceof ControlError);
				assert.equal(error.code, "TF_IDEMPOTENCY_CONFLICT");
				assert.equal(error.sideEffects, "none");
				return true;
			});
			for (const untrusted of [{ callerPrincipal: "other-principal" }, { authorizationContextHash: "b".repeat(64) }, { requestHash: "b".repeat(64) }, { command: {}, events: [] }]) {
				await assert.rejects(f.dispatch("commands.submit", { ...body, ...untrusted }), /untrusted/);
			}
			for (const method of ["control.store.header", "control.store.status", "commands.submit"]) {
				await assert.rejects(f.unauthenticated(method, body), (error: unknown) => {
					assert.ok(error instanceof ControlError);
					assert.equal(error.code, "TF_AUTHORITY_REVOKED");
					return true;
				});
			}
			assert.equal((await f.dispatch<{ commitSeq: number }>("control.store.status")).commitSeq, sequence);
			assert.deepEqual(ledgerBytes(f.projectStorePath), bytes);
			assert.deepEqual(ledgerBytes(f.projectStorePath, true), allBytes);
			assert.equal(fs.readFileSync(path.join(f.projectRoot, "effects.txt"), "utf8"), "once\n");
		}
		assert.equal(submit.mock.calls.length, 1);
	});
}

for (const mode of ["standalone", "auto"] as const) {
	test(`control-host: ${mode} store-open failure rolls back resources before retry`, {
		skip: mode === "auto" && process.platform === "win32",
	}, async (t) => {
		const paths = makePaths();
		const projectStorePath = path.join(paths.controlHome, "project-store");
		fs.writeFileSync(projectStorePath, "not a directory");
		const clearTimer = t.mock.method(globalThis, "clearInterval");
		const failed = new ControlHost(hostOptions(paths, { mode, projectStorePath, holderId: "failed" }));
		t.after(() => failed.stop());
		await assert.rejects(failed.start(), (error: unknown) => {
			assert.ok(error instanceof ControlError);
			assert.equal(error.code, "TF_BOOTSTRAP_FAILED");
			assert.match(error.message, /EEXIST/);
			assert.ok(error.message.includes(projectStorePath));
			return true;
		});
		assert.equal(failed.state, "failed-closed");
		assert.equal(failed.status.singleton, "none");
		assert.equal(failed.status.holderId, undefined);
		assert.equal(fs.existsSync(path.join(paths.controlHome, "standalone-lease.json")), false);
		assert.equal(fs.existsSync(paths.lockPath), false);
		assert.equal(fs.existsSync(paths.endpointPath), false);
		if (mode === "auto") assert.equal(clearTimer.mock.calls.length, 1, "lease-renewal timer must be cleared");
		fs.unlinkSync(projectStorePath);
		const fresh = new ControlHost(hostOptions(paths, { mode, projectStorePath, holderId: "fresh" }));
		t.after(() => fresh.stop());
		assert.equal((await fresh.start()).state, "started");
		fresh.stop();
		// The failed instance is also restartable without explicit cleanup.
		assert.equal((await failed.start()).state, "started");
	});
}


test("control-host: authenticated UDS durable approval requires the client's negotiated feature before commit", {
	skip: process.platform === "win32", timeout: 20_000,
}, async (t) => {
	const f = authenticatedFixture("auto");
	t.after(f.stop);
	await f.start();
	const legacy = await f.connectAuthenticated([]);
	const body = { commandId: randomUUID(), kind: "run.submit", approvalMode: "durable-required", flow: {
		name: "wire-feature-skew", phases: [
			{ id: "review", type: "approval", task: "Approve execution?" },
			{ id: "work", type: "script", dependsOn: ["review"], run: "printf forbidden > effects.txt" },
		],
	} };
	const before = ledgerBytes(f.projectStorePath, true);
	await assert.rejects(legacy.rpc("commands.submit", body), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal(error.code, "TF_FEATURE_REQUIRED");
		assert.equal(error.sideEffects, "none");
		assert.match(error.message, /not negotiated/);
		return true;
	});
	assert.deepEqual(ledgerBytes(f.projectStorePath, true), before);
	assert.deepEqual(await legacy.rpc("runs.list"), []);
	assert.deepEqual(await legacy.rpc("approvals.list"), []);

	const negotiated = await f.connectAuthenticated(["durable-approval"]);
	const accepted = await negotiated.rpc<{ runId: string }>("commands.submit", body);
	const deadline = Date.now() + 5_000;
	let approvals: ApprovalRequest[] = [];
	let parked: RunSnapshot;
	for (;;) {
		approvals = await negotiated.rpc<ApprovalRequest[]>("approvals.list");
		parked = await negotiated.rpc<RunSnapshot>("runs.get", { runId: accepted.runId });
		if (approvals.length && parked.stage === "parked" && parked.slot === "released") break;
		assert.ok(Date.now() < deadline, "negotiated durable approval must park and release capacity");
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.equal(approvals.length, 1);
	assert.equal(approvals[0]!.status, "pending");
	assert.equal(approvals[0]!.runId, accepted.runId);
	assert.equal(fs.existsSync(path.join(f.projectRoot, "effects.txt")), false);
	await negotiated.rpc("approval.decide", {
		commandId: randomUUID(), runId: accepted.runId, approvalRequestId: approvals[0]!.approvalRequestId,
		expectedRunVersion: parked.runVersion, decision: "reject",
	});
	const terminal = await negotiated.rpc<RunSnapshot>("runs.wait", { runId: accepted.runId });
	assert.equal(terminal.status, "blocked");
	assert.equal(terminal.slot, "released");
	assert.equal((await negotiated.rpc<ApprovalRequest[]>("approvals.list"))[0]!.status, "rejected");
	assert.equal(fs.existsSync(path.join(f.projectRoot, "effects.txt")), false);
});
