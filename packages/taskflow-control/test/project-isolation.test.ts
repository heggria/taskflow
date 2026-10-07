import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { ControlHost } from "../src/control-host.ts";
import { ControlError } from "../src/errors.ts";
import { RuntimeTeExecutionProvider } from "../src/runtime-provider.ts";
import { ProjectRegistry } from "../src/project-registry.ts";
import { AUTHORIZATION_CAPABILITIES, answerAuthorizationChallenge, createAuthorizationAuthority, type AuthorizationChallenge } from "../src/authorization.ts";
import { openControlStore } from "../src/store/index.ts";
import { singletonPaths } from "../src/singleton.ts";
import type { RunSnapshot } from "../src/schema/run.ts";

const tempRoots: string[] = [];
after(() => {
	for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tf-isolation-"));
	tempRoots.push(root);
	const projectRoot = path.join(root, "project-a");
	fs.mkdirSync(projectRoot);
	const storePath = path.join(projectRoot, ".taskflow", "control");
	const paths = singletonPaths(path.join(root, "home"));
	const secret = randomBytes(32);
	const authorization = createAuthorizationAuthority({
		ownerUid: process.getuid!(), bootstrapSecret: secret, hostBaseline: AUTHORIZATION_CAPABILITIES,
		loadLivePolicy: (_principal, binding) => ({ host: { capabilities: AUTHORIZATION_CAPABILITIES.map(kind => ({ kind, scopeRoot: binding.projectRoot })) } }),
	});
	const provider = new RuntimeTeExecutionProvider(path.join(root, "provider"));
	let registry: ProjectRegistry;
	let owner: ControlHost;
	const clients: ControlHost[] = [];
	const start = async () => {
		registry = new ProjectRegistry(path.join(root, "registry.json"));
		const mount = registry.mount(storePath, projectRoot);
		owner = new ControlHost({ mode: "auto", provider, authorization, registry, singletonPaths: paths });
		await owner.start();
		return mount;
	};
	const attach = async (projectStorePath?: string) => {
		const client = new ControlHost({ mode: "coordinated", provider, singletonPaths: paths, projectStorePath });
		clients.push(client);
		await client.start();
		assert.equal(client.status.singleton, "attached");
		return client;
	};
	const authenticate = async (client: ControlHost, projectId: string) => {
		const challenge = await rpc<AuthorizationChallenge>(client, "auth.challenge", { projectId });
		assert.equal(challenge.binding.projectId, projectId);
		assert.deepEqual(await rpc(client, "auth.authenticate", { challengeId: challenge.id, proof: answerAuthorizationChallenge(secret, challenge) }), { authenticated: true });
		return challenge.binding;
	};
	const stop = () => { for (const client of clients) client.stop(); owner?.stop(); registry?.close(); };
	return { root, projectRoot, storePath, provider, start, attach, authenticate, stop,
		mount: (store: string, project: string) => registry.mount(store, project) };
}

function rpc<T = unknown>(client: ControlHost, method: string, params?: unknown): Promise<T> {
	return client.dispatch<T>(method, params, { fencingEpoch: client.status.fencingEpoch });
}
function denied(error: unknown) {
	assert.ok(error instanceof ControlError);
	assert.ok(["TF_POLICY_DENIED", "TF_AUTHORITY_REVOKED"].includes(error.code));
	assert.equal(error.sideEffects, "none");
	return true;
}
function durableBytes(directory: string): Record<string, Buffer> {
	const files: Record<string, Buffer> = {};
	for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) {
			const file = path.join(entry.parentPath, entry.name);
			files[path.relative(directory, file)] = fs.readFileSync(file);
		}
	}
	return files;
}

for (const existing of [false, true]) {
	test(`project isolation: another ${existing ? "existing" : "new"} project attaches transport but cannot access or mutate a ledger`, async (t) => {
		const f = fixture();
		t.after(f.stop);
		const b = path.join(f.root, "project-b", ".taskflow", "control");
		let otherProjectId: string = randomUUID();
		if (existing) {
			const store = openControlStore(b);
			otherProjectId = store.header.projectId;
			store.close();
		}
		const bBefore = existing ? durableBytes(b) : undefined;
		const mount = await f.start();
		const before = durableBytes(f.storePath);
		const other = await f.attach(b);
		for (const method of ["control.store.header", "control.store.status", "commands.submit", "runs.list"]) {
			await assert.rejects(rpc(other, method, { projectId: otherProjectId }), denied);
		}
		await assert.rejects(rpc(other, "auth.challenge", { projectId: otherProjectId }), denied);
		// A valid session for A still cannot use an explicit B routing identity.
		await f.authenticate(other, mount.store.header.projectId);
		for (const method of ["control.store.header", "control.store.status", "commands.submit", "runs.list"]) {
			await assert.rejects(rpc(other, method, { projectId: otherProjectId }), denied);
			await assert.rejects(rpc(other, method, { controlDomainId: randomUUID() }), denied);
		}
		assert.deepEqual(durableBytes(f.storePath), before);
		assert.equal(mount.store.snapshot().commitSeq, 0);
		assert.equal(fs.existsSync(b), existing);
		if (existing) assert.deepEqual(durableBytes(b), bBefore);
	});
}

test("project isolation: attached clients without a project or authentication cannot read the winner ledger", async (t) => {
	const f = fixture();
	t.after(f.stop);
	await f.start();
	const before = durableBytes(f.storePath);
	const other = await f.attach();
	for (const method of ["control.store.header", "control.store.status", "commands.submit"]) {
		await assert.rejects(rpc(other, method, {}), /projectStorePath/);
	}
	for (const method of ["runs.list", "projects.list"]) await assert.rejects(rpc(other, method, {}), denied);
	assert.equal((await rpc<{ state: string }>(other, "control.status")).state, "started");
	assert.deepEqual(durableBytes(f.storePath), before);
});

test("project isolation: authenticated project A cannot read or mutate mounted project B", async (t) => {
	const f = fixture();
	t.after(f.stop);
	const a = await f.start();
	const rootB = path.join(f.root, "project-b");
	fs.mkdirSync(rootB);
	const b = f.mount(path.join(rootB, ".taskflow", "control"), rootB);
	const other = await f.attach(f.storePath);
	await f.authenticate(other, a.store.header.projectId);
	const beforeA = durableBytes(f.storePath), beforeB = durableBytes(b.store.storePath);
	for (const method of ["control.store.header", "control.store.status", "commands.submit", "runs.list"]) {
		await assert.rejects(rpc(other, method, {
			projectId: b.store.header.projectId, controlDomainId: b.store.header.controlDomainId,
			commandId: randomUUID(), kind: "run.submit", flow: { name: "forbidden", phases: [{ id: "work", type: "script", run: "printf forbidden > effects.txt" }] },
		}), denied);
	}
	assert.deepEqual(durableBytes(f.storePath), beforeA);
	assert.deepEqual(durableBytes(b.store.storePath), beforeB);
	assert.equal(fs.existsSync(path.join(rootB, "effects.txt")), false);
});

test("project isolation: same canonical project authenticates through an alias and recovers after winner restart", async (t) => {
	const f = fixture();
	t.after(f.stop);
	const a = await f.start();
	const alias = path.join(f.root, "alias");
	fs.symlinkSync(f.storePath, alias);
	const other = await f.attach(alias);
	const binding = await f.authenticate(other, a.store.header.projectId);
	assert.equal(binding.projectRoot, f.projectRoot);
	const header = await rpc(other, "control.store.header");
	const body = { commandId: randomUUID(), kind: "run.submit", flow: { name: "isolated", phases: [{ id: "work", type: "script", run: "printf 'once\n' >> effects.txt; printf isolated-runtime" }] } };
	const accepted = await rpc<{ runId: string }>(other, "commands.submit", body);
	const completed = await rpc<RunSnapshot>(other, "runs.wait", { runId: accepted.runId });
	assert.equal(completed.status, "completed");
	assert.equal(completed.slot, "released");
	const status = await rpc<{ commitSeq: number }>(other, "control.store.status");
	assert.ok(status.commitSeq > 0);
	const before = durableBytes(f.storePath);
	f.stop();
	await f.start();
	const reattached = await f.attach(alias);
	assert.deepEqual(await f.authenticate(reattached, a.store.header.projectId), binding);
	assert.deepEqual(await rpc(reattached, "control.store.header"), header);
	assert.equal((await rpc<{ commitSeq: number }>(reattached, "control.store.status")).commitSeq, status.commitSeq);
	const restartedBytes = durableBytes(f.storePath);
	assert.equal(JSON.stringify(await rpc(reattached, "commands.submit", body)), JSON.stringify(accepted));
	assert.deepEqual(await rpc(reattached, "runs.get", { runId: accepted.runId }), completed);
	assert.deepEqual(durableBytes(f.storePath), restartedBytes);
	// Startup renews the writer lock and rebuilds disposable command projections.
	// Authoritative header, sequence and journal bytes remain fixed across restart.
	for (const file of ["header", "commit-seq.json", "journal/000001.jsonl"]) {
		assert.deepEqual(restartedBytes[file], before[file]);
	}
	assert.equal(fs.readFileSync(path.join(f.projectRoot, "effects.txt"), "utf8"), "once\n");
});
