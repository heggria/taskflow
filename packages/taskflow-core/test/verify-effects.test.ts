/**
 * Built-in effects verification — validateEffectIR wired into verifyTaskflow.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTaskflow, type VerifiableFlow } from "../src/verify.ts";
import type { Phase } from "../src/schema.ts";
import { detectEffectsIssues } from "../src/verifiers/effects-lint.ts";

function scriptPhase(id: string, effects: unknown[], overrides?: Partial<Phase>): Phase {
	return {
		id,
		type: "script",
		run: "true",
		effects: effects as Phase["effects"],
		...overrides,
	};
}

function vf(phases: Phase[], extra?: Partial<VerifiableFlow>): VerifiableFlow {
	return { name: "test", phases, ...extra };
}

const writeEffect = (id: string, literalPath: string) => ({
	id,
	kind: "fs.write",
	target: {
		kind: "path",
		path: { workspace: "project", subpath: { literalPath }, intent: "create-file" },
	},
});

test("verify: effects category — mutating path overlap is an error", () => {
	const flow = vf([
		scriptPhase("w", [writeEffect("a", "out/a.md"), writeEffect("b", "out/a.md")], { final: true }),
	]);
	const r = verifyTaskflow(flow);
	assert.equal(r.ok, false);
	const issues = r.issues.filter((i) => i.category === "effects");
	assert.ok(issues.some((i) => i.severity === "error" && /overlap/i.test(i.message)));
	assert.equal(issues[0]?.phaseId, "w");
	assert.equal(issues[0]?.source, "effects-lint");
});

test("verify: effects category — unknown kind is an error", () => {
	const flow = vf([
		scriptPhase(
			"w",
			[
				{
					id: "x",
					kind: "net.open",
					target: {
						kind: "path",
						path: { workspace: "project", subpath: { literalPath: "x" }, intent: "create-file" },
					},
				},
			],
			{ final: true },
		),
	]);
	const r = verifyTaskflow(flow);
	assert.equal(r.ok, false);
	assert.ok(
		r.issues.some(
			(i) => i.category === "effects" && i.severity === "error" && /unknown kind/i.test(i.message),
		),
	);
});

test("verify: effects category — valid effects leave verify ok", () => {
	const flow = vf([
		scriptPhase("w", [writeEffect("w1", "out/report.md")], {
			final: true,
		}),
	]);
	const r = verifyTaskflow(flow);
	assert.equal(r.ok, true, JSON.stringify(r.issues));
	assert.equal(r.issues.filter((i) => i.category === "effects").length, 0);
});

test("verify: no effects[] — effects detector is a no-op", () => {
	const flow = vf([{ id: "a", type: "script", run: "true", final: true }]);
	const r = verifyTaskflow(flow);
	assert.equal(r.ok, true);
	assert.equal(r.issues.filter((i) => i.category === "effects").length, 0);
});

test("verify: flow-level effects[] are validated", () => {
	const flow = vf([{ id: "a", type: "script", run: "true", final: true }], {
		// flow-level effects (optional extension surface)
		...({
			effects: [
				writeEffect("a", "out/x.md"),
				writeEffect("b", "out/x.md"),
			],
		} as Partial<VerifiableFlow>),
	});
	const r = verifyTaskflow(flow);
	assert.equal(r.ok, false);
	assert.ok(r.issues.some((i) => i.category === "effects" && /overlap/i.test(i.message)));
});

test("detectEffectsIssues: pure helper returns category effects", () => {
	const flow = vf([
		scriptPhase("p", [
			{
				id: "bad",
				kind: "not-a-kind",
				target: { kind: "path", path: { workspace: "p", intent: "create-file" } },
			},
		]),
	]);
	const issues = detectEffectsIssues(flow);
	assert.ok(issues.length > 0);
	assert.ok(issues.every((i) => i.category === "effects"));
	assert.ok(issues.some((i) => /unknown kind/i.test(i.message)));
});

test("verify: independent source and sink phases do not create a false information-flow edge", () => {
	const flow = vf([
		{
			id: "read-secret",
			task: "read",
			effects: [{
				id: "secret-input",
				kind: "secret.read",
				target: { kind: "secret", secret: { secretId: "api-key" } },
			}],
		},
		scriptPhase("public-output", [{
			...writeEffect("write", "public.txt"),
			confidentiality: "public",
		}], { final: true }),
	]);
	const result = verifyTaskflow(flow);
	assert.equal(result.issues.some((issue) => /flow to sink/.test(issue.message)), false, JSON.stringify(result.issues));
});

test("verify: dependency-connected source and sink enforce information-flow labels", () => {
	const flow = vf([
		{
			id: "read-secret",
			task: "read",
			effects: [{
				id: "secret-input",
				kind: "secret.read",
				target: { kind: "secret", secret: { secretId: "api-key" } },
			}],
		},
		scriptPhase("public-output", [{
			...writeEffect("write", "public.txt"),
			confidentiality: "public",
		}], { dependsOn: ["read-secret"], final: true }),
	]);
	const result = verifyTaskflow(flow);
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((issue) => /read-secret\/secret-input.*public-output\/write/.test(issue.message)), JSON.stringify(result.issues));
});
