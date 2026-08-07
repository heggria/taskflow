/**
 * Named observations for each of the 8 Trusted Effects MVP deliverables.
 * Each test title maps to a scoreboard row.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	CONFIDENTIALITY_LABELS,
	EFFECT_KINDS,
	INTEGRITY_LABELS,
	finalizePreparedDeclaredFsWrites,
	isSecretRef,
	isServiceRef,
	preparePhaseDeclaredFsWrites,
	validateEffectIR,
	whyAuthorized,
	whyContext,
	whyEffect,
} from "../src/effects/index.ts";
import { createResolveOnlyWorkspaceSession } from "../src/resources/execution.ts";
import * as os from "node:os";

// test/ → package → packages → repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// 1 EffectIR
test("deliverable:EffectIR closed kinds + validate rejects unknown", () => {
	assert.ok(EFFECT_KINDS.includes("fs.write"));
	const bad = validateEffectIR({
		effects: [{ id: "x", kind: "net.open", target: { kind: "path", path: { workspace: "p", intent: "create-file" } } }],
	});
	assert.equal(bad.ok, false);
	const good = validateEffectIR({
		effects: [
			{
				id: "w",
				kind: "fs.write",
				target: {
					kind: "path",
					path: { workspace: "p", subpath: { literalPath: "a.md" }, intent: "create-file" },
				},
			},
		],
	});
	assert.equal(good.ok, true);
});

// 2 PathRef / SecretRef / ServiceRef
test("deliverable:Refs PathRef + SecretRef/ServiceRef fail-closed", () => {
	assert.equal(isSecretRef({ secretId: "k" }), true);
	assert.equal(isSecretRef({ secretId: "k", value: "nope" }), false);
	assert.equal(isServiceRef({ serviceId: "s" }), true);
	const mat = validateEffectIR({
		effects: [
			{
				id: "s",
				kind: "secret.read",
				target: { kind: "secret", secret: { secretId: "k", material: "x" } },
			},
		],
	});
	assert.equal(mat.ok, false);
	assert.ok(mat.issues.some((i) => i.code === "secret-material-forbidden"));
});

// 3 labels
test("deliverable:Labels confidentiality+integrity lattice enforcement", () => {
	assert.ok(CONFIDENTIALITY_LABELS.includes("secret"));
	assert.ok(INTEGRITY_LABELS.includes("project"));
	const r = validateEffectIR({
		effects: [
			{
				id: "secret-input",
				kind: "secret.read",
				target: { kind: "secret", secret: { secretId: "k" } },
			},
			{
				id: "public-output",
				kind: "fs.write",
				confidentiality: "public",
				target: {
					kind: "path",
					path: { workspace: "p", subpath: { literalPath: "x" }, intent: "create-file" },
				},
			},
		],
	});
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.code === "confidentiality-flow-violation"));
});

// 4 resource transaction + 5 durable authority (combined observation)
test("deliverable:ResourceTransaction PathRef-lease-intent-permit-commit", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-del-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-del-control-"));
	try {
		const session = await createResolveOnlyWorkspaceSession({ invocationRoot: root, controlDirectory: control });
		const binding = await session.bindPhase({
			invocationRoot: root,
			runId: "d",
			phaseId: "write",
			argDefinitions: {},
			argValues: {},
		});
		const admitted = await preparePhaseDeclaredFsWrites(binding, {
			effects: [
				{
					id: "w",
					kind: "fs.write",
					target: {
						kind: "path",
						path: { workspace: "p", subpath: { literalPath: "f.txt" }, intent: "create-file" },
					},
				},
			],
		});
		assert.equal(admitted.ok, true);
		if (!admitted.ok) return;
		const finalized = await finalizePreparedDeclaredFsWrites(admitted.prepared, "via-resource-control\n");
		assert.equal(finalized.ok, true);
		assert.equal(fs.readFileSync(path.join(root, "f.txt"), "utf8"), "via-resource-control\n");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

// 6 overlap
test("deliverable:Overlap mutating paths denied", () => {
	const r = validateEffectIR({
		effects: [
			{
				id: "a",
				kind: "fs.write",
				target: {
					kind: "path",
					path: { workspace: "p", subpath: { literalPath: "out/x" }, intent: "create-file" },
				},
			},
			{
				id: "b",
				kind: "fs.delete",
				target: {
					kind: "path",
					path: { workspace: "p", subpath: { literalPath: "out" }, intent: "existing-directory" },
				},
			},
		],
	});
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.code === "mutating-path-overlap"));
});

// 7 host matrix honesty
test("deliverable:HostMatrix FileBroker unsupported", () => {
	const p = path.join(repoRoot, "conformance/workspace/host-support-baseline.json");
	const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
		cells: Array<{ capability: string; status: string; guarantee: string }>;
	};
	const fb = j.cells.find((c) => c.capability === "file-broker");
	assert.ok(fb, "file-broker cell required");
	assert.equal(fb.status, "unsupported");
	assert.equal(fb.guarantee, "none");
	const te = j.cells.find((c) => c.capability === "trusted-effects-resource-transaction");
	assert.ok(te);
	assert.equal(te.status, "supported");
});

// 8 why-*
test("deliverable:Why authorized/context/effect", () => {
	const effect = {
		id: "w1",
		kind: "fs.write" as const,
		purpose: "demo",
		confidentiality: "internal" as const,
		integrity: "project" as const,
		target: {
			kind: "path" as const,
			path: {
				workspace: "project",
				subpath: { literalPath: "out/r.md" },
				intent: "create-file" as const,
			},
		},
	};
	const input = {
		effect,
		runId: "run",
		phaseId: "p",
		allowed: true,
		allowReasons: ["declared"],
		status: "committed" as const,
		intentId: "intent",
		workspaceRoot: "/tmp/x",
	};
	const a = whyAuthorized(input);
	const c = whyContext(input);
	const e = whyEffect(input);
	assert.equal(a.allowed, true);
	assert.equal(c.confidentiality, "internal");
	assert.equal(e.effectId, "w1");
	assert.ok(e.targetSummary.includes("out/r.md"));
});
