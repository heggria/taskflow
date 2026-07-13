import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createHostInvocationAuthority } from "../src/resources/authority.ts";
import { isWorkspacePolicyError } from "../src/resources/errors.ts";
import {
	createHostRootGrant,
	createRootRegistry,
	isRootGrant,
	RootRegistryConfigurationError,
} from "../src/resources/registry.ts";
import {
	handleRefKey,
	isResolvedPathRef,
	resolvePathRef,
	resolveRelativePathExpr,
	type CapabilityEnvironment,
} from "../src/resources/resolve.ts";
import {
	validateBoundCapabilityLifetime,
	validateCapabilityLifetime,
	validatePathIntent,
	validatePathRef,
	validateRelativePathExpr,
	validateWorkspaceAccess,
	type BoundCapabilityLifetime,
	type ScopedCapability,
} from "../src/resources/schema.ts";

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-resource-"));
	fs.mkdirSync(path.join(root, "packages", "api", "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "packages", "api", "README.md"), "api");
	fs.writeFileSync(path.join(root, "tool.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return root;
}

function capability(
	root: string,
	overrides: Partial<ScopedCapability> = {},
): ScopedCapability {
	return {
		bindingId: "binding-1",
		resourceDomainId: "domain-1",
		providerInstanceId: "provider-1",
		logicalWorkspaceId: "target",
		logicalPrefix: "",
		physicalScopeRoot: root,
		access: "read-write",
		version: { identityMode: "path-bound", generation: 0, state: "clean" },
		lifetime: { scope: "external", bindingId: "binding-1", providerInstanceId: "provider-1" },
		...overrides,
	};
}

function env(root: string, lifetime?: BoundCapabilityLifetime): CapabilityEnvironment {
	return {
		workspaces: new Map([["target", capability(root, lifetime === undefined ? {} : { lifetime })]]),
		runId: "run-1",
		phaseId: "phase-1",
		attemptId: "attempt-1",
		now: () => 1_700_000_000_000,
		mintResolutionTokenId: () => "resolution-1",
	};
}

const noArgs = { definitions: {}, values: {} };

test("resource schema: PathRef, path expression, access, intent, and lifetime are strict", () => {
	const valid = validatePathRef({
		workspace: "target",
		subpath: { literalPath: "cafe\u0301/src" },
		intent: "existing-directory",
	});
	assert.equal(valid.ok, true);
	if (valid.ok) {
		assert.equal(valid.value.access, "read-only");
		assert.deepEqual(valid.value.subpath, { literalPath: "caf\u00e9/src" });
	}

	for (const bad of [
		{ workspace: "target", handle: { producerPhaseId: "p", exportName: "e" }, intent: "existing-directory" },
		{ workspace: "target", intent: "existing-directory", unexpected: true },
		{ workspace: "target", intent: "unknown" },
		{ workspace: "target", access: "write", intent: "existing-directory" },
		{ workspace: "target", maxLifetime: { scope: "run", runId: "caller-owned" }, intent: "existing-directory" },
		{ workspace: "target", subpath: { literalPath: "a", argPath: "b" }, intent: "existing-directory" },
		{ workspace: "target", subpath: { segments: [] }, intent: "existing-directory" },
	]) assert.equal(validatePathRef(bad).ok, false, JSON.stringify(bad));

	for (const bad of [
		{ literalPath: "" },
		{ literalPath: "/tmp" },
		{ literalPath: "a/../b" },
		{ literalPath: "a\\b" },
		{ segments: [{ segment: "a/b" }] },
		{ segments: [{ segment: ".." }] },
	]) assert.equal(validateRelativePathExpr(bad).ok, false, JSON.stringify(bad));

	assert.equal(validateWorkspaceAccess("read-write").ok, true);
	assert.equal(validateWorkspaceAccess("rw").ok, false);
	assert.equal(validatePathIntent("create-file").ok, true);
	assert.equal(validatePathIntent("create").ok, false);
	assert.equal(validateCapabilityLifetime({ scope: "run" }).ok, true);
	assert.equal(validateCapabilityLifetime({ scope: "run", runId: "forged" }).ok, false);
	assert.equal(validateBoundCapabilityLifetime({ scope: "phase", runId: "r", phaseId: "p", attemptId: "a" }).ok, true);
	assert.equal(validateBoundCapabilityLifetime({ scope: "phase", runId: "r", phaseId: "p" }).ok, false);
});

test("RootGrant: only the host factory creates a live brand and snapshots ACLs", () => {
	const root = tempRoot();
	try {
		const principals = new Set(["alice"]);
		const grant = createHostRootGrant({
			grantId: "repo",
			bindingId: "binding",
			resourceDomainId: "domain",
			physicalRoot: root,
			maxAccess: "read-write",
			allowedPrincipals: principals,
			enforcement: "native-single-root",
		});
		principals.add("mallory");
		assert.equal(isRootGrant(grant), true);
		assert.equal(grant.allowedPrincipals.has("mallory"), false);
		assert.equal(isRootGrant(structuredClone(grant)), false);
		assert.throws(
			() => createRootRegistry({ registryId: "registry", grants: [{ ...grant } as typeof grant] }),
			RootRegistryConfigurationError,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("RootRegistry: authorization requires both invocation and grant ACL approval", () => {
	const root = tempRoot();
	try {
		const grant = createHostRootGrant({
			grantId: "repo",
			bindingId: "binding",
			resourceDomainId: "domain",
			physicalRoot: root,
			maxAccess: "read-only",
			allowedPrincipals: ["alice"],
			enforcement: "native-single-root",
		});
		const registry = createRootRegistry({ registryId: "registry", grants: [grant] });
		const onlyInvocation = createHostInvocationAuthority({ principalId: "mallory", allowedGrantIds: ["repo"] });
		const onlyAcl = createHostInvocationAuthority({ principalId: "alice", allowedGrantIds: [] });
		assert.equal(isWorkspacePolicyError(registry.authorize("repo", onlyInvocation, "read-only")), true);
		assert.equal(isWorkspacePolicyError(registry.authorize("repo", onlyAcl, "read-only")), true);

		const both = createHostInvocationAuthority({ principalId: "alice", allowedGrantIds: ["repo"] });
		assert.equal(registry.authorize("repo", both, "read-only"), grant);
		const escalated = registry.authorize("repo", both, "read-write");
		assert.equal(isWorkspacePolicyError(escalated), true);
		if (isWorkspacePolicyError(escalated)) assert.equal(escalated.code, "TFWS_ACCESS_ESCALATION");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("RootRegistry: writable physical overlaps require one resource domain", () => {
	const root = tempRoot();
	const disjoint = tempRoot();
	try {
		const grant = (grantId: string, physicalRoot: string, maxAccess: "read-only" | "read-write", domain: string) =>
			createHostRootGrant({
				grantId,
				bindingId: `binding-${grantId}`,
				resourceDomainId: domain,
				physicalRoot,
				maxAccess,
				allowedPrincipals: ["alice"],
				enforcement: "native-single-root",
			});

		assert.throws(
			() => createRootRegistry({
				registryId: "bad",
				grants: [grant("parent", root, "read-only", "domain-a"), grant("child", path.join(root, "packages"), "read-write", "domain-b")],
			}),
			/require the same resourceDomainId/,
		);
		assert.doesNotThrow(() => createRootRegistry({
			registryId: "same-domain",
			grants: [grant("parent-2", root, "read-only", "domain-a"), grant("child-2", path.join(root, "packages"), "read-write", "domain-a")],
		}));
		assert.doesNotThrow(() => createRootRegistry({
			registryId: "read-only-aliases",
			grants: [grant("parent-3", root, "read-only", "domain-a"), grant("child-3", path.join(root, "packages"), "read-only", "domain-b")],
		}));
		assert.doesNotThrow(() => createRootRegistry({
			registryId: "disjoint",
			grants: [grant("root-a", root, "read-write", "domain-a"), grant("root-b", disjoint, "read-write", "domain-b")],
		}));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(disjoint, { recursive: true, force: true });
	}
});

test("resolver: argPath and argSegment consume only compatible typed args", () => {
	const legacy = resolveRelativePathExpr({ argPath: "package" }, {
		definitions: { package: { required: true } },
		values: { package: "packages/api" },
	});
	assert.equal(legacy.ok, false);
	const wrongType = resolveRelativePathExpr({ argPath: "package" }, {
		definitions: { package: { type: "string" } },
		values: { package: "packages/api" },
	});
	assert.equal(wrongType.ok, false);
	const typed = resolveRelativePathExpr({ argPath: "package" }, {
		definitions: { package: { type: "relative-path" } },
		values: { package: "packages/api" },
	});
	assert.deepEqual(typed, { ok: true, value: "packages/api" });

	const segment = resolveRelativePathExpr({ segments: [{ segment: "packages" }, { argSegment: "name" }] }, {
		definitions: { name: { type: "string" } },
		values: { name: "api" },
	});
	assert.deepEqual(segment, { ok: true, value: "packages/api" });
	assert.equal(resolveRelativePathExpr({ segments: [{ argSegment: "name" }] }, {
		definitions: { name: {} }, values: { name: "api" },
	}).ok, false);
	assert.equal(resolveRelativePathExpr({ segments: [{ argSegment: "name" }] }, {
		definitions: { name: { type: "string" } }, values: { name: "packages/api" },
	}).ok, false);
});

test("resolver: existing/create intents enforce type, containment, and brands", (t) => {
	if (process.platform === "win32") {
		t.skip("portable symlink setup requires platform-specific privileges");
		return;
	}
	const root = tempRoot();
	const outside = tempRoot();
	try {
		fs.symlinkSync(outside, path.join(root, "escape"), "dir");
		const existing = resolvePathRef({
			workspace: "target",
			subpath: { literalPath: "packages/api" },
			intent: "existing-directory",
		}, env(root), noArgs);
		assert.equal(existing.ok, true);
		if (existing.ok) {
			assert.equal(existing.value.physicalPath, fs.realpathSync(path.join(root, "packages/api")));
			assert.equal(existing.value.capability.access, "read-only");
			assert.equal(existing.value.capability.lifetime.scope, "phase");
			assert.equal(isResolvedPathRef(existing.value), true);
			assert.equal(isResolvedPathRef({ ...existing.value }), false);
		}

		const wrongType = resolvePathRef({ workspace: "target", subpath: { literalPath: "packages/api" }, intent: "existing-file" }, env(root), noArgs);
		assert.equal(wrongType.ok, false);
		const escape = resolvePathRef({ workspace: "target", subpath: { literalPath: "escape" }, intent: "existing-directory" }, env(root), noArgs);
		assert.equal(escape.ok, false);
		if (!escape.ok) assert.equal(escape.error.code, "TFWS_PATH_ESCAPE");

		const create = resolvePathRef({ workspace: "target", subpath: { literalPath: "packages/api/generated/deep/file.ts" }, intent: "create-file", access: "read-write" }, env(root), noArgs);
		assert.equal(create.ok, true);
		if (create.ok) assert.equal(create.value.physicalPath, path.join(fs.realpathSync(root), "packages/api/generated/deep/file.ts"));
		assert.equal(resolvePathRef({ workspace: "target", subpath: { literalPath: "packages/api/README.md" }, intent: "create-file" }, env(root), noArgs).ok, false);

		const createEscape = resolvePathRef({ workspace: "target", subpath: { literalPath: "escape/new.txt" }, intent: "create-file" }, env(root), noArgs);
		assert.equal(createEscape.ok, false);
		if (!createEscape.ok) assert.equal(createEscape.error.code, "TFWS_PATH_ESCAPE");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("resolver: access, owner lifetime, and runtime handle lifetime can only attenuate", () => {
	const root = tempRoot();
	try {
		const roEnv = env(root);
		roEnv.workspaces = new Map([["target", capability(root, { access: "read-only" })]]);
		const access = resolvePathRef({ workspace: "target", intent: "existing-directory", access: "read-write" }, roEnv, noArgs);
		assert.equal(access.ok, false);
		if (!access.ok) assert.equal(access.error.code, "TFWS_ACCESS_ESCALATION");

		const stalePhase = env(root, { scope: "phase", runId: "run-1", phaseId: "phase-1", attemptId: "old-attempt" });
		assert.equal(resolvePathRef({ workspace: "target", intent: "existing-directory" }, stalePhase, noArgs).ok, false);

		const handleCapability = capability(root, { lifetime: { scope: "external", bindingId: "binding-1" } });
		const handleEnv = env(root);
		handleEnv.handles = new Map([[handleRefKey({ producerPhaseId: "discover", exportName: "selected" }), handleCapability]]);
		const external = resolvePathRef({
			handle: { producerPhaseId: "discover", exportName: "selected" },
			intent: "existing-directory",
			maxLifetime: { scope: "external" },
		}, handleEnv, noArgs);
		assert.equal(external.ok, false);
		if (!external.ok) assert.equal(external.error.code, "TFWS_ACCESS_ESCALATION");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
