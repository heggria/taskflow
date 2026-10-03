import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ControlHost, type ControlHostOptions } from "../src/control-host.ts";
import { ControlError } from "../src/errors.ts";
import { createTeExecutionProvider, type TeExecutionAuthority } from "../src/te-provider.ts";
import { singletonPaths, type SingletonPaths } from "../src/singleton.ts";
import { PROTOCOL_MAJOR, type NegotiationHandshake } from "../src/schema/transport.ts";

const tempRoots: string[] = [];

function makePaths(): SingletonPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-control-host-"));
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

test("control-host: standalone opens projectStorePath and a later host sees the same ledger (A3)", async () => {
	const paths = makePaths();
	const storePath = path.join(paths.controlHome, "project-store");
	const first = new ControlHost(hostOptions(paths, { mode: "standalone", holderId: "s1", projectStorePath: storePath }));
	await first.start();
	first.hello(clientHello);
	const header = await first.dispatch<{ projectId: string }>("control.store.header", undefined, { fencingEpoch: 1 });
	assert.match(header.projectId, /^[0-9a-f-]{36}$/i);
	const submitted = await first.dispatch<{ commitSeq: number }>("commands.submit", {
		command: {
			commandId: "00000000-0000-0000-0000-0000000000bb",
			kind: "run.submit",
			requestHash: "a".repeat(64),
			callerPrincipal: "cli",
			authorizationContextHash: "a".repeat(64),
			projectId: header.projectId,
			controlDomainId: header.projectId,
			status: "accepted",
			firstCommitSeq: 1,
			lastCommitSeq: 1,
			recordedAt: 1,
		},
		events: [{
			eventId: "00000000-0000-0000-0000-0000000000cc",
			schemaVersion: 1,
			controlDomainId: header.projectId,
			streamId: "command:00000000-0000-0000-0000-0000000000bb",
			streamSeq: 1,
			commitSeq: 1,
			commandId: "00000000-0000-0000-0000-0000000000bb",
			commandEventIndex: 0,
			causationId: "00000000-0000-0000-0000-0000000000bb",
			correlationId: "00000000-0000-0000-0000-0000000000bb",
			projectId: header.projectId,
			recordedAt: 1,
			payload: { kind: "command.recorded", commandId: "00000000-0000-0000-0000-0000000000bb" },
		}],
	}, { fencingEpoch: 1 });
	assert.equal(submitted.commitSeq, 1);
	first.stop();

	const second = new ControlHost(hostOptions(paths, { mode: "standalone", holderId: "s2", projectStorePath: storePath }));
	await second.start();
	second.hello(clientHello);
	const status = await second.dispatch<{ header: { projectId: string }; commitSeq: number }>("control.store.status", undefined, { fencingEpoch: 1 });
	assert.equal(status.header.projectId, header.projectId);
	assert.equal(status.commitSeq, 1);
	second.stop();
});

for (const mode of ["standalone", "auto"] as const) {
	test(`commands.submit: ${mode} duplicate and concurrent retries fail closed before writes or TE execution`, {
		skip: mode === "auto" && process.platform === "win32",
	}, async (t) => {
		const paths = makePaths();
		const projectStorePath = path.join(paths.controlHome, "project-store");
		const provider = fakeProvider();
		const prepare = t.mock.method(provider, "prepare", async () => assert.fail("journal submission must not prepare TE work"));
		const submit = t.mock.method(provider, "submit", async () => assert.fail("journal submission must not execute TE work"));
		const options = hostOptions(paths, { mode, provider, holderId: "command-owner", projectStorePath });
		let owner = new ControlHost(options);
		let caller = owner;
		t.after(() => { if (caller !== owner) caller.stop(); owner.stop(); });
		const start = async () => {
			await owner.start();
			owner.hello(clientHello);
			if (mode === "auto") {
				// Exercise the real commands.submit wire path, not just appendBatch.
				caller = new ControlHost(hostOptions(paths, { mode: "coordinated", provider, projectStorePath }));
				await caller.start();
			} else caller = owner;
		};
		await start();
		const header = await caller.dispatch<{ projectId: string; controlDomainId: string }>("control.store.header", undefined, { fencingEpoch: 1 });
		const identity = { projectId: header.projectId, controlDomainId: header.controlDomainId };
		const commandId = "00000000-0000-0000-0000-0000000000dd";
		const body = {
			command: {
				commandId, kind: "run.submit", requestHash: "a".repeat(64), callerPrincipal: "cli",
				authorizationContextHash: "a".repeat(64), ...identity, status: "accepted",
				firstCommitSeq: 1, lastCommitSeq: 1, recordedAt: 1,
			},
			events: [{
				eventId: "00000000-0000-0000-0000-0000000000ee", schemaVersion: 1,
				...identity, streamId: `command:${commandId}`, streamSeq: 1, commitSeq: 1,
				commandId, commandEventIndex: 0, causationId: commandId, correlationId: commandId,
				recordedAt: 1, payload: { kind: "command.recorded", commandId },
			}],
		};
		// Two requests can be pending on the same connection, but only one batch
		// may commit. The synchronous single-writer append never re-executes it.
		const concurrent = await Promise.allSettled([0, 1].map(() => caller.dispatch("commands.submit", body, { fencingEpoch: 1 })));
		assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
		const rejected = concurrent.find((result) => result.status === "rejected");
		assert.ok(rejected && rejected.status === "rejected");
		assert.ok(rejected.reason instanceof ControlError);
		assert.equal(rejected.reason.code, "TF_IDEMPOTENCY_CONFLICT");
		const journalPath = path.join(projectStorePath, "journal", "000001.jsonl");
		const journal = fs.readFileSync(journalPath);
		const sequence = fs.readFileSync(path.join(projectStorePath, "commit-seq.json"));
		const projection = fs.readFileSync(path.join(projectStorePath, "projections", "commands.json"));
		assert.equal(journal.toString("utf8").trim().split("\n").length, 1);
		for (const restarted of [false, true]) {
			if (restarted) {
				if (caller !== owner) caller.stop();
				owner.stop();
				owner = new ControlHost(options);
				await start();
			}
			for (const overrides of [{}, { requestHash: "b".repeat(64) }, { callerPrincipal: "other-principal" }, { authorizationContextHash: "b".repeat(64) }]) {
				await assert.rejects(caller.dispatch("commands.submit", { ...body, command: { ...body.command, ...overrides } }, { fencingEpoch: 1 }), (error: unknown) => {
					assert.ok(error instanceof ControlError);
					assert.equal(error.code, "TF_IDEMPOTENCY_CONFLICT");
					assert.equal(error.sideEffects, "none");
					assert.match(error.message, /authorized command-result replay is not implemented/);
					return true;
				});
				const status = await caller.dispatch<{ commitSeq: number }>("control.store.status", undefined, { fencingEpoch: 1 });
				assert.equal(status.commitSeq, 1);
				assert.deepEqual(fs.readFileSync(journalPath), journal);
				assert.deepEqual(fs.readFileSync(path.join(projectStorePath, "commit-seq.json")), sequence);
				assert.deepEqual(fs.readFileSync(path.join(projectStorePath, "projections", "commands.json")), projection);
			}
		}
		assert.equal(prepare.mock.calls.length, 0);
		assert.equal(submit.mock.calls.length, 0);
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
		await assert.rejects(failed.start(), /could not open project ControlStore/);
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
