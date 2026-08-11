/**
 * ADV High-fix regression: shared .pi discovery boundary + file-transaction hardenings.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	findProjectAgentsDir,
	findProjectDotPiDir,
	findProjectTaskflowsDir,
	findProjectVerifiersDir,
} from "../src/discovery-boundary.ts";
import { discoverVerifiers } from "../src/verifiers/discover.ts";
import { findProjectFlowsDir } from "../src/store.ts";
import { prepareResourceFileTransaction } from "../src/resources/file-transaction.ts";
import { WriteIntentJournal } from "../src/resources/journal.ts";
import { PersistentLeaseCoordinator } from "../src/resources/leases.ts";
import { resolvePathRef } from "../src/resources/resolve.ts";
import type { ScopedCapability } from "../src/resources/schema.ts";
import type { ExecutionOwner } from "../src/resources/types.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-adv-fix-"));
}

test("discovery: stops before home and does not load temp-root verifiers via walk", async () => {
	const homeProbe = tmp();
	const prevHome = process.env.HOME;
	process.env.HOME = homeProbe;
	try {
		// Poison home + temp convention trees
		const evilUser = path.join(homeProbe, ".pi", "taskflows", "verifiers");
		fs.mkdirSync(evilUser, { recursive: true });
		fs.writeFileSync(path.join(evilUser, "evil.js"), "export default { name: 'evil', verify() { return []; } };\n");

		const nested = path.join(os.tmpdir(), `tf-nest-${process.pid}`, "proj", "child");
		fs.mkdirSync(nested, { recursive: true });
		// No project .pi — walk would hit temp root then home without boundary
		assert.equal(findProjectVerifiersDir(nested), null);
		assert.equal(findProjectTaskflowsDir(nested), null);
		assert.equal(findProjectAgentsDir(nested), null);

		const discovered = await discoverVerifiers(nested);
		// user-scope still loads from HOME intentionally; project must not
		assert.ok(!discovered.dirs.some((d) => d.includes(`${path.sep}proj${path.sep}`) && d.includes("verifiers") && !d.startsWith(homeProbe)));
	} finally {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test("discovery: rejects .pi symlink into ~/.pi", () => {
	const root = tmp();
	const project = path.join(root, "project");
	const homePi = path.join(root, "home", ".pi");
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.mkdirSync(path.join(homePi, "taskflows"), { recursive: true });
	fs.writeFileSync(path.join(homePi, "taskflows", "leaked.json"), "{}");
	fs.symlinkSync(homePi, path.join(project, ".pi"), "dir");

	assert.equal(findProjectDotPiDir(path.join(project, "src")), null);
	assert.equal(findProjectFlowsDir(path.join(project, "src"), false), null);
	assert.equal(findProjectTaskflowsDir(path.join(project, "src")), null);
});

test("discovery: accepts real project .pi and verifiers subdir", async () => {
	const project = tmp();
	const vdir = path.join(project, ".pi", "taskflows", "verifiers");
	fs.mkdirSync(vdir, { recursive: true });
	fs.writeFileSync(
		path.join(vdir, "ok.js"),
		"export default { name: 'ok-v', verify() { return []; } };\n",
	);
	assert.equal(findProjectVerifiersDir(project), vdir);
	const r = await discoverVerifiers(project);
	assert.ok(r.verifiers.some((v) => v.name === "ok-v"));
});

// ---------------------------------------------------------------------------
// file-transaction
// ---------------------------------------------------------------------------

const OWNER: ExecutionOwner = {
	runId: "run",
	phaseId: "phase",
	attemptId: "attempt",
	unitId: "unit",
	ancestry: [],
};

function capability(root: string): ScopedCapability {
	return {
		bindingId: "binding",
		resourceDomainId: "domain",
		providerInstanceId: "root",
		logicalWorkspaceId: "project",
		logicalPrefix: "",
		physicalScopeRoot: root,
		access: "read-write",
		version: { identityMode: "path-bound", generation: 0, state: "clean" },
		lifetime: { scope: "phase", runId: OWNER.runId, phaseId: OWNER.phaseId, attemptId: OWNER.attemptId },
	};
}

function target(root: string, relative: string, effectId: string) {
	const ref = resolvePathRef(
		{
			workspace: "project",
			subpath: { literalPath: relative },
			access: "read-write",
			intent: "create-file",
			maxLifetime: { scope: "phase" },
		},
		{
			workspaces: new Map([["project", capability(root)]]),
			runId: OWNER.runId,
			phaseId: OWNER.phaseId,
			attemptId: OWNER.attemptId,
		},
		{ definitions: {}, values: {} },
	);
	if (!ref.ok) throw new Error(ref.error.redactedMessage);
	return { effectId, ref: ref.value };
}

async function prepareTx(workspace: string, relative: string, effectId = "w") {
	const control = tmp();
	const leases = new PersistentLeaseCoordinator({ directory: control, registryId: "registry" });
	const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
	const prepared = await prepareResourceFileTransaction({
		controlDirectory: control,
		resourceDomainId: "domain",
		owner: OWNER,
		targets: [target(workspace, relative, effectId)],
		leases,
		journal,
		leaseTimeoutMs: 5_000,
		permitTtlMs: 30_000,
		authorizationScopeRoot: workspace,
	});
	return { prepared, control, workspace };
}

test("file-transaction: rejects path-like effectId at prepare", async () => {
	const workspace = tmp();
	await assert.rejects(
		() => prepareTx(workspace, "out/a.txt", "../escape"),
		/TFWS_INVALID_EFFECT_ID|safe path segment/,
	);
});

test("file-transaction: concurrent commit is rejected (busy)", async () => {
	const workspace = tmp();
	const { prepared } = await prepareTx(workspace, "out/a.txt", "w1");
	const results = await Promise.allSettled([
		prepared.commit([{ effectId: "w1", content: "one" }]),
		prepared.commit([{ effectId: "w1", content: "two" }]),
	]);
	const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof prepared.commit>>> => r.status === "fulfilled");
	const rejected = results.filter((r) => r.status === "rejected");
	const oks = fulfilled.filter((r) => r.value.ok);
	assert.equal(oks.length, 1, `expected exactly one ok commit, got ${oks.length}, rejected=${rejected.length}`);
	const body = fs.readFileSync(path.join(workspace, "out/a.txt"), "utf8");
	assert.ok(body === "one" || body === "two", body);
	if (rejected.length) {
		assert.match(String((rejected[0] as PromiseRejectedResult).reason), /already in progress|already settled/);
	} else {
		// loser returned ok:false via restore path — file must still match single winner
		const failed = fulfilled.filter((r) => !r.value.ok);
		assert.ok(failed.length >= 1);
	}
});

test("file-transaction: intermediate symlink between prepare and commit is rejected", async () => {
	const workspace = tmp();
	const outside = tmp();
	fs.writeFileSync(path.join(outside, "pwned.txt"), "nope");
	// deep path admitted
	const { prepared } = await prepareTx(workspace, "deep/nested/x.txt", "w1");
	// plant intermediate symlink after prepare
	fs.mkdirSync(path.join(workspace, "deep"), { recursive: true });
	// If deep already created as dir by something, remove and replace
	try {
		fs.rmSync(path.join(workspace, "deep"), { recursive: true, force: true });
	} catch {
		/* */
	}
	fs.symlinkSync(outside, path.join(workspace, "deep"), "dir");

	const result = await prepared.commit([{ effectId: "w1", content: "escaped" }]);
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, "declared-path-bypass");
	// outside must not receive payload
	assert.equal(fs.readFileSync(path.join(outside, "pwned.txt"), "utf8"), "nope");
	assert.ok(!fs.existsSync(path.join(outside, "nested")));
});

test("file-transaction: deferred lease callback throw does not flip ok:true", async () => {
	const workspace = tmp();
	const control = tmp();
	const leases = new PersistentLeaseCoordinator({ directory: control, registryId: "registry" });
	const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
	const prepared = await prepareResourceFileTransaction({
		controlDirectory: control,
		resourceDomainId: "domain",
		owner: OWNER,
		targets: [target(workspace, "out/b.txt", "w2")],
		leases,
		journal,
		leaseTimeoutMs: 5_000,
		permitTtlMs: 30_000,
		authorizationScopeRoot: workspace,
		onDeferredLeaseRelease: () => {
			throw new Error("injected deferred release failure");
		},
	});

	// Success path: lease release usually succeeds so callback may not run; commit must still ok.
	const r = await prepared.commit([{ effectId: "w2", content: "ok" }]);
	assert.equal(r.ok, true);
	assert.equal(fs.readFileSync(path.join(workspace, "out/b.txt"), "utf8"), "ok");
});
