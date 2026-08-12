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
