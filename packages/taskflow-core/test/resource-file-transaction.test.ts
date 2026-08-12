import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
	finalizePreparedDeclaredFsWrites,
	preparePhaseDeclaredFsWrites,
} from "../src/effects/runtime-apply.ts";
import { whyEffectFromLedger } from "../src/effects/why.ts";
import {
	createResolveOnlyWorkspaceSession,
	type ResolveOnlyPhaseBinding,
} from "../src/resources/execution.ts";
import {
	prepareResourceFileTransaction,
	type ResolvedFileWriteTarget,
} from "../src/resources/file-transaction.ts";
import { WriteIntentJournal } from "../src/resources/journal.ts";
import {
	PersistentLeaseCoordinator,
	type LeaseAcquireOptions,
	type LeaseHandle,
	type LeaseRequest,
} from "../src/resources/leases.ts";
import type { MutationPermit } from "../src/resources/permits.ts";
import { resolvePathRef } from "../src/resources/resolve.ts";
import type { PathRef, ScopedCapability } from "../src/resources/schema.ts";
import type { ExecutionOwner } from "../src/resources/types.ts";

function fixture(): { root: string; control: string } {
	return {
		root: fs.mkdtempSync(path.join(os.tmpdir(), "tfws-file-tx-root-")),
		control: fs.mkdtempSync(path.join(os.tmpdir(), "tfws-file-tx-control-")),
	};
}

function transactionArtifacts(control: string): string[] {
	const directory = path.join(control, "file-transactions");
	return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

async function rootBinding(root: string, control: string, leaseTimeoutMs = 500): Promise<ResolveOnlyPhaseBinding> {
	const session = await createResolveOnlyWorkspaceSession({
		invocationRoot: root,
		controlDirectory: control,
		leaseTimeoutMs,
	});
	return session.bindPhase({
		invocationRoot: root,
		runId: "run",
		phaseId: "phase",
		argDefinitions: {},
		argValues: {},
	});
}

function writePath(relativePath: string): PathRef {
	return {
		workspace: "project",
		subpath: { literalPath: relativePath },
		access: "read-write",
		intent: "create-file",
		maxLifetime: { scope: "phase" },
	};
}

test("resource file transaction: commits content with durable authority evidence", async () => {
	const { root, control } = fixture();
	try {
		const bound = await rootBinding(root, control);
		const tx = await bound.beginFileWriteTransaction([
			{ effectId: "a", path: writePath("out/a.txt") },
			{ effectId: "b", path: writePath("out/b.txt") },
		]);
		const result = await tx.commit([
			{ effectId: "a", content: "A" },
			{ effectId: "b", content: "B" },
		]);
		assert.equal(result.ok, true);
		assert.equal(fs.readFileSync(path.join(root, "out/a.txt"), "utf8"), "A");
		assert.equal(fs.readFileSync(path.join(root, "out/b.txt"), "utf8"), "B");
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const [intent] = await journal.listIntents();
		assert.equal(intent?.status, "committed-content");
		assert.equal(intent?.commitGeneration, 1);
		assert.equal(intent?.restorableSnapshotArtifactIds?.length, 2);
		assert.equal(intent?.authorizationPrincipalId, "local-host-invocation");
		assert.deepEqual(intent?.scopes.map((scope) => scope.effectId).sort(), ["a", "b"]);
		assert.ok(intent?.scopes.every((scope) => scope.capabilityBindingId?.startsWith("binding-")));
		const why = whyEffectFromLedger({
			flow: {
				phases: [{
					id: "phase",
					effects: [{
						id: "a",
						kind: "fs.write",
						target: { kind: "path", path: writePath("out/a.txt") },
					}],
				}],
			},
			runId: "run",
			phaseId: "phase",
			effectId: "a",
			intents: [intent!],
		});
		assert.equal(why.ok, true);
		if (why.ok) {
			assert.equal(why.why.authorized.allowed, true);
			assert.equal(why.why.status, "committed");
			assert.equal(why.why.intentId, intent?.intentId);
			assert.equal(why.why.authorized.principalId, "local-host-invocation");
		}
		const declarationOnly = whyEffectFromLedger({
			flow: { phases: [{ id: "phase", effects: [{
				id: "a",
				kind: "fs.write",
				target: { kind: "path", path: writePath("out/a.txt") },
			}] }] },
			runId: "run",
			phaseId: "phase",
			effectId: "a",
			intents: [],
		});
		assert.equal(declarationOnly.ok, true);
		if (declarationOnly.ok) assert.equal(declarationOnly.why.authorized.allowed, false);
		assert.deepEqual(transactionArtifacts(control), [], "terminal commit garbage-collects before-images");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("resource file transaction: direct final-path bypass is restored with a known-clean terminal record", async () => {
	const { root, control } = fixture();
	try {
		const bound = await rootBinding(root, control);
		const tx = await bound.beginFileWriteTransaction([
			{ effectId: "report", path: writePath("out/report.md") },
		]);
		fs.mkdirSync(path.join(root, "out"));
		fs.writeFileSync(path.join(root, "out/report.md"), "BYPASS");
		const result = await tx.commit([{ effectId: "report", content: "DECLARED" }]);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "declared-path-bypass");
		assert.equal(result.restored, true);
		assert.equal(fs.existsSync(path.join(root, "out/report.md")), false);
		assert.equal(fs.existsSync(path.join(root, "out")), false, "new empty parents are part of rollback");
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const [intent] = await journal.listIntents();
		assert.equal(intent?.status, "aborted-restored");
		assert.match(intent?.terminalReason ?? "", /changed outside the resource transaction/);
		assert.equal(await journal.getDomainGeneration(intent!.resourceDomainId), 0);
		assert.deepEqual(transactionArtifacts(control), [], "terminal abort garbage-collects before-images");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("effects bridge: declaration is admitted before body and committed by resource authority", async () => {
	const { root, control } = fixture();
	try {
		const bound = await rootBinding(root, control);
		const effects = [{
			id: "report",
			kind: "fs.write" as const,
			target: { kind: "path" as const, path: writePath("report.md") },
			confidentiality: "internal" as const,
			integrity: "project" as const,
		}];
		const admitted = await preparePhaseDeclaredFsWrites(bound, { effects });
		assert.equal(admitted.ok, true);
		if (!admitted.ok) return;
		const finalized = await finalizePreparedDeclaredFsWrites(admitted.prepared, "REPORT");
		assert.equal(finalized.ok, true);
		assert.equal(fs.readFileSync(path.join(root, "report.md"), "utf8"), "REPORT");
		const [intent] = await new WriteIntentJournal({ directory: control, journalEpoch: 1 }).listIntents();
		assert.equal(intent?.status, "committed-content");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("resource file transaction: PathRef resolver rejects a parent symlink escape before intent creation", async (t) => {
	if (process.platform === "win32") return t.skip("symlink privileges are platform-specific");
	const { root, control } = fixture();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-file-tx-outside-"));
	try {
		fs.symlinkSync(outside, path.join(root, "linked"), "dir");
		const bound = await rootBinding(root, control);
		await assert.rejects(
			bound.beginFileWriteTransaction([{ effectId: "escape", path: writePath("linked/escape.txt") }]),
			/TFWS_PATH_ESCAPE/,
		);
		assert.equal(fs.existsSync(path.join(outside, "escape.txt")), false);
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		assert.deepEqual(await journal.listIntents(), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("resource file transaction: overlapping cross-session writer is rejected before a second intent", async () => {
	const { root, control } = fixture();
	try {
		const first = await rootBinding(root, control, 500);
		const second = await rootBinding(root, control, 30);
		const open = await first.beginFileWriteTransaction([{ effectId: "a", path: writePath("same.txt") }]);
		await assert.rejects(
			second.beginFileWriteTransaction([{ effectId: "b", path: writePath("same.txt") }]),
			/Lease timeout/,
		);
		await open.reject("test cleanup");
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const intents = await journal.listIntents();
		assert.equal(intents.length, 1);
		assert.equal(intents[0]?.status, "aborted-restored");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

class FailSecondPermitAssertionJournal extends WriteIntentJournal {
	#calls = 0;

	override async assertActive(permit: MutationPermit, owner: ExecutionOwner): Promise<void> {
		await super.assertActive(permit, owner);
		this.#calls++;
		if (this.#calls === 2) throw new Error("injected second promotion failure");
	}
}

class ReleaseFailsAfterDurableUnlockCoordinator extends PersistentLeaseCoordinator {
	override async acquire(
		requests: readonly LeaseRequest[],
		options: LeaseAcquireOptions = {},
	): Promise<LeaseHandle> {
		const lease = await super.acquire(requests, options);
		return {
			...lease,
			release: async () => {
				await lease.release();
				throw new Error("injected post-release cleanup failure");
			},
		};
	}
}

class ActivationAndInspectionFailJournal extends WriteIntentJournal {
	override async activate(): Promise<void> {
		throw new Error("injected activation failure");
	}

	override async getIntent(): Promise<never> {
		throw new Error("injected journal inspection failure");
	}
}

function resolvedTargets(root: string, owner: ExecutionOwner): ResolvedFileWriteTarget[] {
	const capability: ScopedCapability = {
		bindingId: "binding",
		resourceDomainId: "domain",
		providerInstanceId: "root",
		logicalWorkspaceId: "project",
		logicalPrefix: "",
		physicalScopeRoot: root,
		access: "read-write",
		version: { identityMode: "path-bound", generation: 0, state: "clean" },
		lifetime: { scope: "phase", runId: owner.runId, phaseId: owner.phaseId, attemptId: owner.attemptId },
	};
	return ["a.txt", "b.txt"].map((relativePath, index) => {
		const ref = resolvePathRef(
			writePath(relativePath),
			{
				workspaces: new Map([["project", capability]]),
				runId: owner.runId,
				phaseId: owner.phaseId,
				attemptId: owner.attemptId,
			},
			{ definitions: {}, values: {} },
		);
		if (!ref.ok) throw new Error(ref.error.redactedMessage);
		return { effectId: index === 0 ? "a" : "b", ref: ref.value };
	});
}

test("resource file transaction: later promotion failure rolls back every earlier file", async () => {
	const { root, control } = fixture();
	const owner: ExecutionOwner = {
		runId: "run",
		phaseId: "phase",
		attemptId: "attempt",
		unitId: "unit",
		ancestry: [],
	};
	try {
		const journal = new FailSecondPermitAssertionJournal({ directory: control, journalEpoch: 1 });
		const tx = await prepareResourceFileTransaction({
			controlDirectory: control,
			resourceDomainId: "domain",
			owner,
			targets: resolvedTargets(root, owner),
			leases: new PersistentLeaseCoordinator({ directory: control, registryId: "registry" }),
			journal,
			leaseTimeoutMs: 500,
			permitTtlMs: 5_000,
			authorizationScopeRoot: root,
		});
		const result = await tx.commit([
			{ effectId: "a", content: "A" },
			{ effectId: "b", content: "B" },
		]);
		assert.equal(result.ok, false);
		assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
		assert.equal(fs.existsSync(path.join(root, "b.txt")), false);
		assert.equal((await journal.listIntents())[0]?.status, "aborted-restored");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("resource file transaction: post-terminal lease cleanup failure never makes commit retryable", async () => {
	const { root, control } = fixture();
	const owner: ExecutionOwner = {
		runId: "run",
		phaseId: "phase",
		attemptId: "attempt",
		unitId: "unit",
		ancestry: [],
	};
	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
	try {
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const tx = await prepareResourceFileTransaction({
			controlDirectory: control,
			resourceDomainId: "domain",
			owner,
			targets: resolvedTargets(root, owner).slice(0, 1),
			leases: new ReleaseFailsAfterDurableUnlockCoordinator({ directory: control, registryId: "registry" }),
			journal,
			leaseTimeoutMs: 500,
			permitTtlMs: 5_000,
			authorizationScopeRoot: root,
		});
		const result = await tx.commit([{ effectId: "a", content: "A" }]);
		assert.equal(result.ok, true);
		assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "A");
		assert.equal((await journal.listIntents())[0]?.status, "committed-content");
		assert.ok(warnings.some((warning) => /lease cleanup deferred/.test(warning)));
	} finally {
		console.warn = originalWarn;
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("resource file transaction: post-commit staged cleanup failure remains durable success", async () => {
	const { root, control } = fixture();
	const owner: ExecutionOwner = {
		runId: "run",
		phaseId: "phase",
		attemptId: "attempt",
		unitId: "unit",
		ancestry: [],
	};
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
	let cleanupCalls = 0;
	try {
		const leases = new PersistentLeaseCoordinator({ directory: control, registryId: "registry" });
		const journal = new WriteIntentJournal({ directory: control, journalEpoch: 1 });
		const options = {
			controlDirectory: control,
			resourceDomainId: "domain",
			owner,
			targets: resolvedTargets(root, owner).slice(0, 1),
			leases,
			journal,
			leaseTimeoutMs: 500,
			permitTtlMs: 5_000,
			authorizationScopeRoot: root,
			cleanupStaging: () => {
				cleanupCalls++;
				throw new Error("injected staged cleanup failure");
			},
		} as Parameters<typeof prepareResourceFileTransaction>[0] & { cleanupStaging: () => void };
		const tx = await prepareResourceFileTransaction(options);
		const result = await tx.commit([{ effectId: "a", content: "A" }]);
		assert.equal(result.ok, true);
		assert.equal(cleanupCalls, 1);
		assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "A");
		assert.equal((await journal.listIntents())[0]?.status, "committed-content");
		assert.equal((await leases.list()).length, 0, "cleanup failure must not leak the lease");
		assert.ok(warnings.some((warning) => /staging cleanup deferred/.test(warning)));
	} finally {
		console.warn = originalWarn;
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("resource file transaction: activation plus journal-inspection double fault still releases lease", async () => {
	const { root, control } = fixture();
	const owner: ExecutionOwner = {
		runId: "run",
		phaseId: "phase",
		attemptId: "attempt",
		unitId: "unit",
		ancestry: [],
	};
	try {
		const leases = new PersistentLeaseCoordinator({ directory: control, registryId: "registry" });
		await assert.rejects(
			prepareResourceFileTransaction({
				controlDirectory: control,
				resourceDomainId: "domain",
				owner,
				targets: resolvedTargets(root, owner).slice(0, 1),
				leases,
				journal: new ActivationAndInspectionFailJournal({ directory: control, journalEpoch: 1 }),
				leaseTimeoutMs: 500,
				permitTtlMs: 5_000,
				authorizationScopeRoot: root,
			}),
			/injected journal inspection failure/,
		);
		assert.equal((await leases.list()).length, 0, "all preparation failures must release the lease");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("resource file transaction: startup recovery restores a process-crashed partial multi-file mutation", async () => {
	const { root, control } = fixture();
	try {
		const executionModule = pathToFileURL(path.resolve(
			path.dirname(new URL(import.meta.url).pathname),
			"../src/resources/execution.ts",
		)).href;
		const child = spawnSync(process.execPath, [
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			`
				import * as fs from "node:fs";
				import * as path from "node:path";
				import { createResolveOnlyWorkspaceSession } from ${JSON.stringify(executionModule)};
				const root = ${JSON.stringify(root)};
				const session = await createResolveOnlyWorkspaceSession({ invocationRoot: root, controlDirectory: ${JSON.stringify(control)} });
				const bound = await session.bindPhase({ invocationRoot: root, runId: "crashed-run", phaseId: "write", argDefinitions: {}, argValues: {} });
				await bound.beginFileWriteTransaction([
					{ effectId: "a", path: { workspace: "project", subpath: { literalPath: "out/a.txt" }, intent: "create-file" } },
					{ effectId: "b", path: { workspace: "project", subpath: { literalPath: "out/b.txt" }, intent: "create-file" } },
				]);
				fs.mkdirSync(path.join(root, "out"), { recursive: true });
				fs.writeFileSync(path.join(root, "out/a.txt"), "PARTIAL_CRASH");
				process.exit(0);
			`,
		], { encoding: "utf8", timeout: 10_000 });
		assert.equal(child.status, 0, child.stderr);
		assert.equal(fs.readFileSync(path.join(root, "out/a.txt"), "utf8"), "PARTIAL_CRASH");

		await createResolveOnlyWorkspaceSession({ invocationRoot: root, controlDirectory: control });
		assert.equal(fs.existsSync(path.join(root, "out/a.txt")), false);
		assert.equal(fs.existsSync(path.join(root, "out/b.txt")), false);
		assert.equal(fs.existsSync(path.join(root, "out")), false);
		const [intent] = await new WriteIntentJournal({ directory: control, journalEpoch: 1 }).listIntents();
		assert.equal(intent?.status, "aborted-restored");
		assert.match(intent?.terminalReason ?? "", /startup recovery restored/);
		assert.equal(intent?.commitGeneration, undefined);
		assert.deepEqual(transactionArtifacts(control), [], "startup recovery garbage-collects restored before-images");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("resource file transaction: startup garbage-collects orphan snapshot directories", async () => {
	const { root, control } = fixture();
	try {
		const orphan = path.join(control, "file-transactions", "orphan-before-intent");
		fs.mkdirSync(orphan, { recursive: true });
		fs.writeFileSync(path.join(orphan, "before.blob"), "SECRET-BEFORE-IMAGE");
		const stale = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(orphan, stale, stale);
		await createResolveOnlyWorkspaceSession({ invocationRoot: root, controlDirectory: control });
		assert.deepEqual(transactionArtifacts(control), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("resource file transaction: startup GC preserves a fresh pre-intent transaction window", async () => {
	const { root, control } = fixture();
	try {
		const fresh = path.join(control, "file-transactions", "fresh-before-intent");
		fs.mkdirSync(fresh, { recursive: true });
		fs.writeFileSync(path.join(fresh, "before.blob"), "IN-FLIGHT-BEFORE-IMAGE");
		await createResolveOnlyWorkspaceSession({ invocationRoot: root, controlDirectory: control });
		assert.deepEqual(transactionArtifacts(control), ["fresh-before-intent"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});
