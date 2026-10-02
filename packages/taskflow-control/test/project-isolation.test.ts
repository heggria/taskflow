import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ControlHost, type ControlHostOptions } from "../src/control-host.ts";
import { createTeExecutionProvider, type TeExecutionAuthority } from "../src/te-provider.ts";
import { openControlStore } from "../src/store/index.ts";
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

for (const existing of [false, true]) {
test(`project isolation: a different ${existing ? "existing" : "new"} project fails closed before any ledger mutation`, async (t) => {
 const paths = makePaths();
 const a = path.join(paths.controlHome, "a");
 const b = path.join(paths.controlHome, "b");
 const winner = new ControlHost(hostOptions(paths, { projectStorePath: a }));
 if (existing) openControlStore(b).close();
 const bBefore = existing ? fs.readFileSync(path.join(b, "header")) : undefined;
 const other = new ControlHost(hostOptions(paths, { projectStorePath: b }));
 t.after(() => { other.stop(); winner.stop(); });
 await winner.start();
 winner.hello(clientHello);
 const before = fs.readFileSync(path.join(a, "header"));
 await assert.rejects(other.start(), /project store|projectStorePath/);
 assert.equal(other.state, "failed-closed");
 assert.deepEqual(fs.readFileSync(path.join(a, "header")), before);
 assert.equal(fs.existsSync(b), existing);
 if (existing) assert.deepEqual(fs.readFileSync(path.join(b, "header")), bBefore);
 assert.equal((await winner.dispatch<{ commitSeq: number }>("control.store.status", undefined, { fencingEpoch: 1 })).commitSeq, 0);
});

}

test("project isolation: attached clients without a project cannot access the winner ledger", async (t) => {
 const paths = makePaths();
 const winner = new ControlHost(hostOptions(paths, { projectStorePath: path.join(paths.controlHome, "a") }));
 const other = new ControlHost(hostOptions(paths));
 t.after(() => { other.stop(); winner.stop(); });
 await winner.start();
 await other.start();
 for (const method of ["control.store.header", "control.store.status", "commands.submit"]) {
  await assert.rejects(other.dispatch(method, {}, { fencingEpoch: other.status.fencingEpoch }), /project store|projectStorePath/);
 }
 assert.equal((await other.dispatch<{ state: string }>("control.status", undefined, { fencingEpoch: other.status.fencingEpoch })).state, "started");
});

test("project isolation: same canonical project attaches and recovers after winner restart", async (t) => {
 const paths = makePaths();
 const a = path.join(paths.controlHome, "a");
 const alias = path.join(paths.controlHome, "alias");
 const winner = new ControlHost(hostOptions(paths, { projectStorePath: a }));
 const other = new ControlHost(hostOptions(paths, { projectStorePath: alias }));
 const restarted = new ControlHost(hostOptions(paths, { projectStorePath: a }));
 t.after(() => { other.stop(); winner.stop(); restarted.stop(); });
 await winner.start();
 fs.symlinkSync(a, alias);
 await other.start();
 const header = await other.dispatch<{ projectId: string }>("control.store.header", undefined, { fencingEpoch: other.status.fencingEpoch });
 assert.equal(other.status.singleton, "attached");
 const submitted = await other.dispatch<{ commitSeq: number }>("commands.submit", {
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
	}, { fencingEpoch: other.status.fencingEpoch });
 assert.equal(submitted.commitSeq, 1);
 other.stop();
 winner.stop();
 await restarted.start();
 restarted.hello(clientHello);
 assert.equal((await restarted.dispatch<{ projectId: string }>("control.store.header", undefined, { fencingEpoch: restarted.status.fencingEpoch })).projectId, header.projectId);
 assert.equal((await restarted.dispatch<{ commitSeq: number }>("control.store.status", undefined, { fencingEpoch: restarted.status.fencingEpoch })).commitSeq, 1);
});
