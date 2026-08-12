/**
 * Trusted Effects MVP — unit + vertical-slice fixture (no LLM).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	pathsOverlap,
	precheckDeclaredFsWriteOverlap,
	validateEffectIR,
	whyEffect,
	whyEffectFromFlow,
	formatWhyEffect,
	type EffectDecl,
	type EffectIR,
} from "../src/effects/index.ts";

// ---------------------------------------------------------------------------
// Schema accept / reject — PhaseSchema + FlowIRNode (effects optional)
// ---------------------------------------------------------------------------

test("PhaseSchema/validateTaskflow: accepts phase with effects[] (and without — backward compat)", async () => {
	const { validateTaskflow } = await import("../src/schema.ts");
	const withEffects = {
		name: "fx-schema-ok",
		phases: [
			{
				id: "w",
				type: "script" as const,
				run: "true",
				final: true,
				effects: [
					{
						id: "w1",
						kind: "fs.write",
						target: {
							kind: "path",
							path: {
								workspace: "project",
								subpath: { literalPath: "out/r.md" },
								intent: "create-file",
							},
						},
					},
				],
			},
		],
	};
	const without = {
		name: "fx-schema-legacy",
		phases: [{ id: "w", type: "script" as const, run: "true", final: true }],
	};
	const ok1 = validateTaskflow(withEffects);
	const ok2 = validateTaskflow(without);
	assert.equal(ok1.ok, true, JSON.stringify(ok1.errors));
	assert.equal(ok2.ok, true, JSON.stringify(ok2.errors));
});

test("TaskflowSchema: effects[] is phase-scoped and rejects a flow-level ghost declaration", async () => {
	const { validateTaskflow } = await import("../src/schema.ts");
	const result = validateTaskflow({
		name: "fx-flow-level-rejected",
		effects: [{
			id: "ghost",
			kind: "fs.write",
			target: { kind: "path", path: { workspace: "project", intent: "create-file" } },
		}],
		phases: [{ id: "w", type: "script", run: "true", final: true }],
	});
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((error) => /unknown field 'effects'/.test(error)), JSON.stringify(result.errors));
});

test("PhaseSchema/validateTaskflow: rejects non-array effects", async () => {
	const { validateTaskflow } = await import("../src/schema.ts");
	const bad = {
		name: "fx-schema-bad",
		phases: [
			{
				id: "w",
				type: "script" as const,
				run: "true",
				effects: { id: "w1", kind: "fs.write" },
			},
		],
	};
	const r = validateTaskflow(bad);
	assert.equal(r.ok, false);
	assert.ok(
		r.errors.some((e) => /effects/i.test(e) || /array/i.test(e)),
		JSON.stringify(r.errors),
	);
});

test("PhaseSchema/validateTaskflow: rejects open or unknown EffectIR declarations", async () => {
	const { validateTaskflow } = await import("../src/schema.ts");
	const phase = {
		id: "w",
		type: "script" as const,
		run: "true",
		effects: [{
			id: "x",
			kind: "root.shell",
			target: { kind: "path", path: { workspace: "project", intent: "create-file" } },
			ambientAuthority: true,
		}],
	};
	const result = validateTaskflow({ name: "fx-closed", phases: [phase] });
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((error) => /effects|kind|union/i.test(error)), JSON.stringify(result.errors));
});

test("FlowIRNodeSchema/isFlowIRNode: accepts optional effects[] and rejects non-array", async () => {
	const { Value } = await import("typebox/value");
	const { FlowIRNodeSchema, isFlowIRNode } = await import("../src/flowir/schema.ts");
	const base = {
		id: "w",
		kind: "script" as const,
		inject: [] as string[],
		emits: ["w"],
	};
	const withFx = {
		...base,
		effects: [
			{
				id: "w1",
				kind: "fs.write",
				target: {
					kind: "path",
					path: {
						workspace: "project",
						subpath: { literalPath: "out/r.md" },
						intent: "create-file",
					},
				},
			},
		],
	};
	assert.equal(isFlowIRNode(base), true);
	assert.equal(isFlowIRNode(withFx), true);
	assert.equal(Value.Check(FlowIRNodeSchema, base), true);
	assert.equal(Value.Check(FlowIRNodeSchema, withFx), true);

	assert.equal(isFlowIRNode({ ...base, effects: "nope" }), false);
	assert.equal(Value.Check(FlowIRNodeSchema, { ...base, effects: "nope" }), false);
	const unknown = {
		...base,
		effects: [{
			id: "x",
			kind: "root.shell",
			target: { kind: "path", path: { workspace: "project", intent: "create-file" } },
		}],
	};
	assert.equal(isFlowIRNode(unknown), false);
	assert.equal(Value.Check(FlowIRNodeSchema, unknown), false);
	const open = { ...withFx, effects: [{ ...withFx.effects[0], ambientAuthority: true }] };
	assert.equal(isFlowIRNode(open), false);
	assert.equal(Value.Check(FlowIRNodeSchema, open), false);
});

// ---------------------------------------------------------------------------
// validate + overlap
// ---------------------------------------------------------------------------

test("validateEffectIR: accepts well-formed fs.write", () => {
	const ir: EffectIR = {
		effects: [
			{
				id: "w1",
				kind: "fs.write",
				target: {
					kind: "path",
					path: {
						workspace: "project",
						subpath: { literalPath: "out/report.md" },
						intent: "create-file",
					},
				},
				confidentiality: "internal",
				integrity: "project",
			},
		],
	};
	const r = validateEffectIR(ir);
	assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test("validateEffectIR: rejects unknown kind", () => {
	const r = validateEffectIR({
		effects: [{ id: "x", kind: "net.open", target: { kind: "path", path: { workspace: "p", intent: "create-file" } } }],
	});
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.code === "unknown-effect-kind"));
});

test("validateEffectIR: rejects undeclared fields outside the closed schema", () => {
	const r = validateEffectIR({
		effects: [{
			id: "x",
			kind: "fs.write",
			target: { kind: "path", path: { workspace: "p", intent: "create-file" } },
			ambientAuthority: true,
		}],
	});
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((issue) => issue.code === "invalid-effect-shape"));
});

test("validateEffectIR: rejects secret material on SecretRef", () => {
	const r = validateEffectIR({
		effects: [
			{
				id: "s1",
				kind: "secret.read",
				target: { kind: "secret", secret: { secretId: "k", value: "leaked" } },
			},
		],
	});
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.code === "secret-material-forbidden"));
});

test("validateEffectIR: mutating path overlap is an error", () => {
	const r = validateEffectIR({
		effects: [
			{
				id: "a",
				kind: "fs.write",
				target: {
					kind: "path",
					path: { workspace: "project", subpath: { literalPath: "out/a.md" }, intent: "create-file" },
				},
			},
			{
				id: "b",
				kind: "fs.delete",
				target: {
					kind: "path",
					path: { workspace: "project", subpath: { literalPath: "out" }, intent: "existing-directory" },
				},
			},
		],
	});
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.code === "mutating-path-overlap"));
});

test("pathsOverlap: parent/child", () => {
	assert.equal(pathsOverlap("out", "out/a.md"), true);
	assert.equal(pathsOverlap("out/a.md", "out/b.md"), false);
});

test("validateEffectIR: secret source cannot flow to a public sink", () => {
	const r = validateEffectIR({
		effects: [
			{
				id: "secret-input",
				kind: "secret.read",
				target: { kind: "secret", secret: { secretId: "api-key" } },
			},
			{
				id: "public-output",
				kind: "fs.write",
				confidentiality: "public",
				target: {
					kind: "path",
					path: { workspace: "project", subpath: { literalPath: "leak.txt" }, intent: "create-file" },
				},
			},
		],
	});
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.code === "confidentiality-flow-violation"));
});

test("validateEffectIR: untrusted source cannot flow to a verified sink", () => {
	const r = validateEffectIR({
		effects: [
			{
				id: "untrusted-input",
				kind: "fs.read",
				integrity: "untrusted",
				target: { kind: "path", path: { workspace: "project", subpath: { literalPath: "in.txt" }, intent: "existing-file" } },
			},
			{
				id: "verified-output",
				kind: "fs.write",
				integrity: "verified",
				target: { kind: "path", path: { workspace: "project", subpath: { literalPath: "out.txt" }, intent: "create-file" } },
			},
		],
	});
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.code === "integrity-flow-violation"));
});

test("validateEffectIR: confidentiality and integrity-preserving source-to-sink flow is allowed", () => {
	const r = validateEffectIR({
		effects: [
			{
				id: "secret-input",
				kind: "secret.read",
				integrity: "verified",
				target: { kind: "secret", secret: { secretId: "api-key" } },
			},
			{
				id: "protected-output",
				kind: "fs.write",
				confidentiality: "secret",
				integrity: "project",
				target: { kind: "path", path: { workspace: "project", subpath: { literalPath: "protected.txt" }, intent: "create-file" } },
			},
		],
	});
	assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test("validateTaskflow: secret data cannot cross a dependency edge into a public sink", async () => {
	const { validateTaskflow } = await import("../src/schema.ts");
	const result = validateTaskflow({
		name: "fx-cross-phase-secret",
		phases: [
			{
				id: "read-secret",
				task: "read",
				effects: [{
					id: "secret-input",
					kind: "secret.read",
					target: { kind: "secret", secret: { secretId: "api-key" } },
				}],
			},
			{
				id: "publish",
				task: "publish",
				dependsOn: ["read-secret"],
				effects: [{
					id: "public-output",
					kind: "fs.write",
					confidentiality: "public",
					target: {
						kind: "path",
						path: { workspace: "project", subpath: { literalPath: "public.txt" }, intent: "create-file" },
					},
				}],
			},
		],
	});
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((error) => /read-secret\/secret-input.*publish\/public-output/.test(error)), JSON.stringify(result.errors));
});

test("validateTaskflow: labels propagate through effect-free intermediate phases", async () => {
	const { validateTaskflow } = await import("../src/schema.ts");
	const result = validateTaskflow({
		name: "fx-transitive-integrity",
		phases: [
			{
				id: "read-untrusted",
				task: "read",
				effects: [{
					id: "input",
					kind: "fs.read",
					integrity: "untrusted",
					target: {
						kind: "path",
						path: { workspace: "project", subpath: { literalPath: "input.txt" }, intent: "existing-file" },
					},
				}],
			},
			{ id: "transform", task: "transform", dependsOn: ["read-untrusted"] },
			{
				id: "publish-verified",
				task: "publish",
				dependsOn: ["transform"],
				effects: [{
					id: "verified-output",
					kind: "fs.write",
					integrity: "verified",
					target: {
						kind: "path",
						path: { workspace: "project", subpath: { literalPath: "verified.txt" }, intent: "create-file" },
					},
				}],
			},
		],
	});
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((error) => /read-untrusted\/input.*publish-verified\/verified-output/.test(error)), JSON.stringify(result.errors));
});

test("validateTaskflow: cross-phase confidentiality and integrity preserving flow is allowed", async () => {
	const { validateTaskflow } = await import("../src/schema.ts");
	const result = validateTaskflow({
		name: "fx-cross-phase-allowed",
		phases: [
			{
				id: "read-secret",
				task: "read",
				effects: [{
					id: "secret-input",
					kind: "secret.read",
					integrity: "verified",
					target: { kind: "secret", secret: { secretId: "api-key" } },
				}],
			},
			{
				id: "store-protected",
				task: "store",
				dependsOn: ["read-secret"],
				effects: [{
					id: "protected-output",
					kind: "fs.write",
					confidentiality: "secret",
					integrity: "project",
					target: {
						kind: "path",
						path: { workspace: "project", subpath: { literalPath: "protected.txt" }, intent: "create-file" },
					},
				}],
			},
		],
	});
	assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("precheckDeclaredFsWriteOverlap: parent/child paths are rejected before admission", () => {
	const result = precheckDeclaredFsWriteOverlap([
		{ effectId: "parent", relativePath: "out", content: "x" },
		{ effectId: "child", relativePath: "out/a.md", content: "y" },
	]);
	assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// why-*
// ---------------------------------------------------------------------------

test("verifyTaskflow: overlapping mutating effects are category=effects errors", async () => {
	const { verifyTaskflow } = await import("../src/verify.ts");
	const flow = {
		name: "fx-overlap",
		phases: [
			{
				id: "w",
				type: "script" as const,
				run: "true",
				effects: [
					{
						id: "a",
						kind: "fs.write",
						target: {
							kind: "path",
							path: { workspace: "project", subpath: { literalPath: "out/a.md" }, intent: "create-file" },
						},
					},
					{
						id: "b",
						kind: "fs.write",
						target: {
							kind: "path",
							path: { workspace: "project", subpath: { literalPath: "out/a.md" }, intent: "create-file" },
						},
					},
				],
			},
		],
	};
	const r = verifyTaskflow(flow as never);
	assert.equal(r.ok, false);
	const fx = r.issues.filter((i) => i.category === "effects");
	assert.ok(fx.length > 0, "expected effects issues");
	assert.ok(fx.some((i) => /overlap/i.test(i.message)));
	assert.equal(fx[0]!.source, "effects-lint");
	assert.equal(fx[0]!.phaseId, "w");
});

test("verifyTaskflow: unknown effect kind is a verify error", async () => {
	const { verifyTaskflow } = await import("../src/verify.ts");
	const flow = {
		name: "fx-unknown",
		phases: [
			{
				id: "w",
				type: "script" as const,
				run: "true",
				effects: [
					{
						id: "x",
						kind: "net.open",
						target: {
							kind: "path",
							path: { workspace: "project", subpath: { literalPath: "x" }, intent: "create-file" },
						},
					},
				],
			},
		],
	};
	const r = verifyTaskflow(flow as never);
	assert.equal(r.ok, false);
	assert.ok(
		r.issues.some(
			(i) => i.category === "effects" && i.severity === "error" && /unknown kind/i.test(i.message),
		),
	);
});

test("verifyTaskflow: well-formed effects do not fail verify", async () => {
	const { verifyTaskflow } = await import("../src/verify.ts");
	const flow = {
		name: "fx-ok",
		phases: [
			{
				id: "w",
				type: "script" as const,
				run: "true",
				final: true,
				effects: [
					{
						id: "w1",
						kind: "fs.write",
						target: {
							kind: "path",
							path: {
								workspace: "project",
								subpath: { literalPath: "out/report.md" },
								intent: "create-file",
							},
						},
						confidentiality: "internal",
						integrity: "project",
					},
				],
			},
		],
	};
	const r = verifyTaskflow(flow as never);
	assert.equal(r.ok, true, JSON.stringify(r.issues));
	assert.equal(r.issues.filter((i) => i.category === "effects").length, 0);
});

test("effectsLintVerifier plugin path: still flags overlap when registered", async () => {
	const { effectsLintVerifier } = await import("../src/verifiers/effects-lint.ts");
	const { verifyTaskflow } = await import("../src/verify.ts");
	const flow = {
		name: "fx-plugin",
		phases: [
			{
				id: "w",
				type: "script" as const,
				run: "true",
				effects: [
					{
						id: "a",
						kind: "fs.write",
						target: {
							kind: "path",
							path: { workspace: "project", subpath: { literalPath: "out/a.md" }, intent: "create-file" },
						},
					},
					{
						id: "b",
						kind: "fs.write",
						target: {
							kind: "path",
							path: { workspace: "project", subpath: { literalPath: "out/a.md" }, intent: "create-file" },
						},
					},
				],
			},
		],
	};
	// Built-in already flags; plugin adds a second source=effects-lint with category=plugin
	const r = verifyTaskflow(flow as never, { verifiers: [effectsLintVerifier] });
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.category === "effects" && /overlap/i.test(i.message)));
	assert.ok(r.issues.some((i) => i.category === "plugin" && i.source === "effects-lint" && /overlap/i.test(i.message)));
});

test("translateTaskflow: carries phase effects onto FlowIR nodes", async () => {
	const { translateTaskflow } = await import("../src/flowir/translate.ts");
	const def = {
		name: "fx-hash",
		phases: [
			{
				id: "w",
				type: "script" as const,
				run: "true",
				effects: [
					{
						id: "w1",
						kind: "fs.write",
						target: {
							kind: "path",
							path: { workspace: "project", subpath: { literalPath: "out/r.md" }, intent: "create-file" },
						},
					},
				],
			},
		],
	};
	const { ir } = translateTaskflow(def as never);
	assert.ok(ir.nodes[0]?.effects?.length === 1);
});

test("translateTaskflow: invalid effects are diagnosed and excluded from projected IR", async () => {
	const { translateTaskflow } = await import("../src/flowir/translate.ts");
	const result = translateTaskflow({
		name: "fx-translate-closed",
		phases: [{
			id: "w",
			type: "script",
			run: "true",
			effects: [{ id: "x", kind: "root.shell", target: { kind: "path", path: { workspace: "p", intent: "create-file" } } }],
		}],
	} as never);
	assert.ok(result.errors.some((error) => error.code.startsWith("effect-")));
	assert.equal(result.ir.nodes[0]?.effects, undefined);
});

test("compileTaskflowToFlowIR + hashFlowIR: effects are content-addressed", async () => {
	const { compileTaskflowToFlowIR, hashFlowIR } = await import("../src/flowir/index.ts");
	const basePhase = {
		id: "w",
		type: "script" as const,
		run: "true",
	};
	const effect = (path: string) => ({
		id: "w1",
		kind: "fs.write" as const,
		target: {
			kind: "path" as const,
			path: { workspace: "project", subpath: { literalPath: path }, intent: "create-file" as const },
		},
	});
	const def1 = {
		name: "fx-hash",
		phases: [{ ...basePhase, effects: [effect("out/r.md")] }],
	};
	const def2 = {
		name: "fx-hash",
		phases: [{ ...basePhase, effects: [effect("out/other.md")] }],
	};
	const defNone = {
		name: "fx-hash",
		phases: [{ ...basePhase }],
	};
	const c1 = compileTaskflowToFlowIR(def1 as never);
	const c2 = compileTaskflowToFlowIR(def2 as never);
	const c0 = compileTaskflowToFlowIR(defNone as never);
	assert.ok(c1.canonical.nodes[0]?.effects?.length === 1, "compile must carry effects");
	assert.ok(c2.canonical.nodes[0]?.effects?.length === 1);
	assert.equal(c0.canonical.nodes[0]?.effects, undefined);

	const h1 = hashFlowIR(c1.canonical);
	const h2 = hashFlowIR(c2.canonical);
	const h0 = hashFlowIR(c0.canonical);
	assert.notEqual(h1, h2, "effects must affect content hash");
	assert.notEqual(h1, h0, "presence of effects must affect content hash");
	// Stability
	assert.equal(h1, hashFlowIR(c1.canonical));
	assert.match(h1, /^ir:[0-9a-f]{64}$/);
});

test("compileTaskflowToIR: invalid EffectIR is diagnosed and never content-addressed", async () => {
	const { compileTaskflowToFlowIR, compileTaskflowToIR } = await import("../src/flowir/index.ts");
	const def = {
		name: "fx-compile-closed",
		phases: [{
			id: "w",
			type: "script" as const,
			run: "true",
			effects: [{
				id: "x",
				kind: "root.shell",
				target: { kind: "path", path: { workspace: "project", intent: "create-file" } },
			}],
		}],
	};
	const compiled = compileTaskflowToFlowIR(def as never);
	assert.equal(compiled.usedFallbackHash, true);
	assert.ok(compiled.errors.some((error) => /effect-/.test(error.code)));
	assert.equal(compiled.canonical.nodes[0]?.effects, undefined);
	const publicResult = await compileTaskflowToIR(def as never);
	assert.equal(publicResult.hash, undefined);
	assert.equal(publicResult.usedFallbackHash, true);
});

test("compileTaskflowToFlowIR: non-array effects fail closed instead of hashing as no effects", async () => {
	const { compileTaskflowToFlowIR, compileTaskflowToIR, translateTaskflow } = await import("../src/flowir/index.ts");
	const def = {
		name: "fx-effects-not-array",
		phases: [{
			id: "w",
			type: "script",
			run: "true",
			effects: { id: "erased-write" },
		}],
	};
	const compiled = compileTaskflowToFlowIR(def as never);
	assert.equal(compiled.usedFallbackHash, true);
	assert.ok(compiled.errors.some((error) => error.code === "effect-effects-not-array"), JSON.stringify(compiled.errors));
	assert.equal(compiled.canonical.nodes[0]?.effects, undefined);
	const translated = translateTaskflow(def as never);
	assert.ok(translated.errors.some((error) => error.code === "effect-effects-not-array"), JSON.stringify(translated.errors));
	const publicResult = await compileTaskflowToIR(def as never);
	assert.equal(publicResult.hash, undefined);
});

test("compileTaskflowToFlowIR: nested label-flow violations fail content addressing", async () => {
	const { compileTaskflowToFlowIR } = await import("../src/flowir/index.ts");
	const compiled = compileTaskflowToFlowIR({
		name: "fx-compile-composed-label",
		phases: [
			{
				id: "read-secret",
				task: "read",
				effects: [{
					id: "secret-input",
					kind: "secret.read",
					target: { kind: "secret", secret: { secretId: "api-key" } },
				}],
			},
			{
				id: "child",
				type: "flow",
				dependsOn: ["read-secret"],
				def: {
					name: "public-child",
					phases: [{
						id: "publish",
						type: "script",
						run: "true",
						effects: [{
							id: "public-output",
							kind: "fs.write",
							confidentiality: "public",
							target: { kind: "path", path: { workspace: "project", subpath: { literalPath: "public.txt" }, intent: "create-file" } },
						}],
						final: true,
					}],
				},
				final: true,
			},
		],
	} as never);
	assert.equal(compiled.usedFallbackHash, true);
	assert.ok(compiled.errors.some((error) => /read-secret\/secret-input.*child\/publish\/public-output/.test(error.message)), JSON.stringify(compiled.errors));
});

test("compileTaskflowToIR: cross-phase label violation is diagnosed and never content-addressed", async () => {
	const { compileTaskflowToFlowIR, compileTaskflowToIR, translateTaskflow } = await import("../src/flowir/index.ts");
	const def = {
		name: "fx-compile-label-flow",
		phases: [
			{
				id: "read-secret",
				task: "read",
				effects: [{
					id: "secret-input",
					kind: "secret.read",
					target: { kind: "secret", secret: { secretId: "api-key" } },
				}],
			},
			{
				id: "publish",
				type: "script" as const,
				run: "true",
				dependsOn: ["read-secret"],
				effects: [{
					id: "public-output",
					kind: "fs.write",
					confidentiality: "public",
					target: {
						kind: "path",
						path: { workspace: "project", subpath: { literalPath: "public.txt" }, intent: "create-file" },
					},
				}],
			},
		],
	};
	const compiled = compileTaskflowToFlowIR(def as never);
	assert.equal(compiled.usedFallbackHash, true);
	assert.ok(compiled.errors.some((error) => /confidentiality-flow-violation/.test(error.code)));
	assert.ok(compiled.errors.some((error) => /read-secret\/secret-input.*publish\/public-output/.test(error.message)));
	const publicResult = await compileTaskflowToIR(def as never);
	assert.equal(publicResult.hash, undefined);
	const translated = translateTaskflow(def as never);
	assert.ok(translated.errors.some((error) => /confidentiality-flow-violation/.test(error.code)));
});

test("whyEffect: structured explanation", () => {
	const effect: EffectDecl = {
		id: "w1",
		kind: "fs.write",
		purpose: "write report",
		confidentiality: "internal",
		integrity: "project",
		target: {
			kind: "path",
			path: { workspace: "project", subpath: { literalPath: "out/report.md" }, intent: "create-file" },
		},
	};
	const w = whyEffect({
		effect,
		runId: "run_1",
		phaseId: "write",
		allowed: true,
		allowReasons: ["declared on BoundPlan", "validateEffectIR ok"],
		intentId: "intent_1",
		journalStatus: "committed-content",
		status: "committed",
		workspaceRoot: "/tmp/proj",
	});
	assert.equal(w.effectId, "w1");
	assert.equal(w.authorized.allowed, true);
	assert.equal(w.context.confidentiality, "internal");
	assert.ok(w.targetSummary.includes("out/report.md"));
	assert.ok(w.reasons.some((r) => r.includes("intent=intent_1")));
});


test("whyEffectFromFlow: finds declared effect and authorizes when valid", () => {
	const flow = {
		phases: [
			{
				id: "write",
				effects: [
					{
						id: "w1",
						kind: "fs.write",
						purpose: "emit report",
						confidentiality: "internal",
						integrity: "project",
						target: {
							kind: "path",
							path: {
								workspace: "project",
								subpath: { literalPath: "out/report.md" },
								intent: "create-file",
							},
						},
					},
				],
			},
		],
	};
	const r = whyEffectFromFlow({
		flow,
		runId: "run_fx_1",
		effectId: "w1",
		workspaceRoot: "/tmp/proj",
	});
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.why.effectId, "w1");
	assert.equal(r.why.authorized.allowed, true);
	assert.equal(r.why.status, "declared");
	assert.equal(r.phaseId, "write");
	assert.ok(r.why.targetSummary.includes("out/report.md"));
	const text = formatWhyEffect(r.why);
	assert.ok(text.includes("authorized: yes"));
	assert.ok(text.includes("w1"));
});

test("whyEffectFromFlow: missing effect fails closed with known list", () => {
	const flow = {
		phases: [
			{
				id: "write",
				effects: [
					{
						id: "w1",
						kind: "fs.write",
						target: {
							kind: "path",
							path: {
								workspace: "project",
								subpath: { literalPath: "a.txt" },
								intent: "create-file",
							},
						},
					},
				],
			},
		],
	};
	const r = whyEffectFromFlow({ flow, runId: "run_x", effectId: "nope" });
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.ok(r.error.includes("not found"));
	assert.ok(r.error.includes("write/w1") || r.error.includes("w1"));
});

test("whyEffectFromFlow: invalid secret material deny (authorized=false)", () => {
	const flow = {
		phases: [
			{
				id: "s",
				effects: [
					{
						id: "bad-secret",
						kind: "secret.read",
						target: {
							kind: "secret",
							secret: { secretId: "x", value: "leaked" },
						},
					},
				],
			},
		],
	};
	const r = whyEffectFromFlow({ flow, runId: "run_s", effectId: "bad-secret" });
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.why.authorized.allowed, false);
	assert.ok(r.why.authorized.reasons.some((x) => /secret/i.test(x)));
});

test("whyEffectFromFlow: ambiguous id requires phaseId", () => {
	const effect = {
		id: "shared",
		kind: "fs.read",
		target: {
			kind: "path",
			path: {
				workspace: "project",
				subpath: { literalPath: "a.txt" },
				intent: "existing-file",
			},
		},
	};
	const flow = {
		phases: [
			{ id: "a", effects: [effect] },
			{ id: "b", effects: [{ ...effect }] },
		],
	};
	const amb = whyEffectFromFlow({ flow, runId: "r", effectId: "shared" });
	assert.equal(amb.ok, false);
	if (amb.ok) return;
	assert.ok(/ambiguous/i.test(amb.error));
	const ok = whyEffectFromFlow({ flow, runId: "r", effectId: "shared", phaseId: "b" });
	assert.equal(ok.ok, true);
	if (!ok.ok) return;
	assert.equal(ok.phaseId, "b");
	assert.equal(ok.why.authorized.allowed, true);
});

test("whyEffectFromFlow: independent phases do not invent an information-flow dependency", () => {
	const flow = {
		phases: [
			{
				id: "read-secret",
				effects: [{
					id: "secret-input",
					kind: "secret.read",
					target: { kind: "secret", secret: { secretId: "api-key" } },
				}],
			},
			{
				id: "publish",
				effects: [{
					id: "public-output",
					kind: "fs.write",
					target: { kind: "path", path: { workspace: "project", subpath: { literalPath: "public.txt" }, intent: "create-file" } },
					confidentiality: "public",
				}],
			},
		],
	};
	const result = whyEffectFromFlow({ flow, runId: "run-independent", phaseId: "publish", effectId: "public-output" });
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.why.authorized.allowed, true, result.why.authorized.reasons.join("; "));
});

test("whyEffectFromFlow: dependency-connected phases agree with DAG label validation", () => {
	const flow = {
		phases: [
			{
				id: "read-secret",
				effects: [{
					id: "secret-input",
					kind: "secret.read",
					target: { kind: "secret", secret: { secretId: "api-key" } },
				}],
			},
			{
				id: "publish",
				dependsOn: ["read-secret"],
				effects: [{
					id: "public-output",
					kind: "fs.write",
					target: { kind: "path", path: { workspace: "project", subpath: { literalPath: "public.txt" }, intent: "create-file" } },
					confidentiality: "public",
				}],
			},
		],
	};
	const result = whyEffectFromFlow({ flow, runId: "run-dependent", phaseId: "publish", effectId: "public-output" });
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.why.authorized.allowed, false);
		assert.ok(result.why.authorized.reasons.some((reason) => /read-secret\/secret-input.*publish\/public-output/.test(reason)));
	}
});
