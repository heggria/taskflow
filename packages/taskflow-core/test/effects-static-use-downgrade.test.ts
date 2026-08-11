/**
 * S-H2 (ADV-R1 F1): static flow{use} composition over-taint vs runtime loadFlow.
 *
 * Static gates (validateTaskflow / verifyTaskflow / FlowIR translate+compile)
 * run without a flow store, so a `flow{use: <saved>}` child degrades to the
 * unknown-boundary summary. Before the fix every such composition hard-failed
 * with confidentiality/integrity-flow-violation — even when the saved child
 * declares NO effects — while the runtime, which resolves the name through
 * `loadFlow`, executed it successfully. Now:
 *
 *  - unresolved `flow{use}` boundaries at static gates are advisory warnings;
 *  - a resolver can be injected into the static gates to check real child
 *    effects (resolved real violations still hard-fail);
 *  - the runtime with a loader remains the authoritative fail-closed gate;
 *  - dynamic inline `flow{def}` boundaries stay hard-tainted (not downgraded).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { compileTaskflowToFlowIR } from "../src/flowir/compile.ts";
import { translateTaskflow } from "../src/flowir/translate.ts";
import type { RunResult } from "../src/host/runner-types.ts";
import { executeTaskflow } from "../src/runtime.ts";
import { validateTaskflow, type Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";
import { verifyTaskflow } from "../src/verify.ts";

const AGENTS: AgentConfig[] = [
	{ name: "executor", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, cwd: string): RunState {
	return {
		runId: "sh2-test-run",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

function okResult(agentName: string, task: string, output: string): RunResult {
	return {
		agent: agentName,
		task,
		exitCode: 0,
		output,
		stderr: "",
		usage: { ...emptyUsage(), output: 5, turns: 1 },
		stopReason: "end",
	};
}

function writeEffect(confidentiality: "public" | "internal" = "internal", literalPath = "out/report.md") {
	return {
		id: "report",
		kind: "fs.write" as const,
		target: {
			kind: "path" as const,
			path: { workspace: "project", subpath: { literalPath }, intent: "create-file" as const },
		},
		confidentiality,
		integrity: "project" as const,
	};
}

const secretEffect = {
	id: "secret-input",
	kind: "secret.read" as const,
	target: { kind: "secret" as const, secret: { secretId: "api-key" } },
};

// ---------------------------------------------------------------------------

test("S-H2: benign saved flow{use} + downstream declared write passes static gates and runtime", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-sh2-benign-use-"));
	try {
		// Saved child declares NO effects at all — the legal composition the
		// review flagged: static gates rejected it while the runtime accepted it.
		const child: Taskflow = {
			name: "benign-child",
			phases: [{ id: "work", type: "agent", agent: "executor", task: "benign", final: true }],
		};
		const def: Taskflow = {
			name: "saved-parent-write",
			phases: [
				{ id: "child", type: "flow", use: child.name },
				{
					id: "write", type: "agent", agent: "executor", task: "write", dependsOn: ["child"],
					effects: [writeEffect("internal")], final: true,
				},
			],
		};

		// Static gates accept with advisory warnings instead of hard taint errors.
		const sv = validateTaskflow(def);
		assert.equal(sv.ok, true, sv.errors.join(" | "));
		assert.ok(sv.warnings.some((w) => /unresolved-flow-use|unresolved flow\{use\}/.test(w)), JSON.stringify(sv.warnings));

		const vv = verifyTaskflow(def);
		assert.equal(vv.ok, true, vv.issues.map((i) => i.message).join(" | "));
		assert.ok(
			vv.issues.some((i) => i.severity === "warning" && i.category === "effects" && /unresolved flow\{use\}/.test(i.message)),
			JSON.stringify(vv.issues),
		);

		const tr = translateTaskflow(def);
		assert.equal(tr.errors.length, 0, tr.errors.map((e) => e.message).join(" | "));
		assert.ok(tr.warnings.some((w) => /unresolved flow\{use\}/.test(w.message)), JSON.stringify(tr.warnings));

		const cr = compileTaskflowToFlowIR(def);
		assert.equal(cr.errors.length, 0, cr.errors.map((e) => e.message).join(" | "));
		assert.ok(cr.warnings.some((w) => /unresolved flow\{use\}/.test(w.message)), JSON.stringify(cr.warnings));

		// Runtime with a loader resolves the child and executes the composition.
		const res = await executeTaskflow(mkState(def, root), {
			cwd: root,
			agents: AGENTS,
			loadFlow: (name: string) => (name === child.name ? child : undefined),
			runTask: async (_c: string, _a: unknown, agentName: string, task: string) => okResult(agentName, task, "CONTENT\n"),
		});
		assert.equal(res.ok, true, res.finalOutput);
		assert.equal(fs.readFileSync(path.join(root, "out/report.md"), "utf8"), "CONTENT\n", "declared write must commit");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("S-H2: real violation is advisory without a loader, hard-fails with a resolver and at runtime", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-sh2-real-violation-"));
	let calls = 0;
	try {
		// Saved child declares a public sink: secret source flowing into it is a
		// REAL confidentiality violation — the runtime must keep rejecting it.
		const child: Taskflow = {
			name: "public-child",
			phases: [{
				id: "publish", type: "agent", agent: "executor", task: "publish",
				effects: [writeEffect("public", "leak.txt")], final: true,
			}],
		};
		const def: Taskflow = {
			name: "saved-parent-label",
			phases: [
				{ id: "read-secret", type: "agent", agent: "executor", task: "read", effects: [secretEffect] },
				{ id: "child", type: "flow", use: child.name, dependsOn: ["read-secret"], final: true },
			],
		};

		// Static gate without a loader cannot see the child → advisory only.
		const sv = validateTaskflow(def);
		assert.equal(sv.ok, true, "static-without-loader must downgrade to warnings");
		assert.ok(sv.warnings.some((w) => /advisory/i.test(w)), JSON.stringify(sv.warnings));

		// With a loader the child is checked with its REAL effects → hard error.
		const loader = (name: string) => (name === child.name ? child : undefined);
		const svResolved = validateTaskflow(def, { resolveFlow: loader });
		assert.equal(svResolved.ok, false, "static-with-resolver must catch the real violation");
		assert.ok(svResolved.errors.some((e) => /confidentiality-flow-violation|secret-input.*publish/.test(e)), JSON.stringify(svResolved.errors));

		const vvResolved = verifyTaskflow(def, { resolveFlow: loader });
		assert.equal(vvResolved.ok, false, "verify-with-resolver must catch the real violation");
		assert.ok(vvResolved.issues.some((i) => i.severity === "error" && /secret-input.*publish/.test(i.message)), JSON.stringify(vvResolved.issues));

		// Runtime admission stays the authoritative fail-closed gate.
		const res = await executeTaskflow(mkState(def, root), {
			cwd: root,
			agents: AGENTS,
			loadFlow: loader,
			runTask: async (_c: string, _a: unknown, agentName: string, task: string) => {
				calls++;
				return okResult(agentName, task, "nope\n");
			},
		});
		assert.equal(res.ok, false);
		assert.equal(calls, 0, "real violation must fail before any subagent runs");
		assert.equal(fs.existsSync(path.join(root, "leak.txt")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("S-H2: dynamic inline flow{def} boundary stays hard-tainted (never downgraded)", () => {
	// A dynamic inline def string is LLM-authored at runtime — it is not a
	// resolver-resolvable saved name, so its unknown boundary stays an error.
	const def = {
		name: "dynamic-parent",
		phases: [
			{ id: "read-secret", type: "agent", agent: "executor", task: "read", effects: [secretEffect] },
			{ id: "dynamic", type: "flow", def: "{steps.plan.json}", dependsOn: ["read-secret"], final: true },
		],
	} as unknown as Taskflow;

	const sv = validateTaskflow(def);
	assert.equal(sv.ok, false, "dynamic inline def must stay hard-tainted");
	assert.ok(sv.errors.some((e) => /dynamic\/<dynamic-sink>/.test(e)), JSON.stringify(sv.errors));

	const vv = verifyTaskflow(def);
	assert.equal(vv.ok, false, "verify must keep dynamic def taint as error");
	assert.ok(vv.issues.some((i) => i.severity === "error" && /dynamic\/<dynamic-sink>/.test(i.message)), JSON.stringify(vv.issues));

	const cr = compileTaskflowToFlowIR(def);
	assert.ok(cr.errors.some((e) => /dynamic\/<dynamic-sink>/.test(e.message)), JSON.stringify(cr.errors));
});

test("S-H2: unresolved use with a store loader that misses the name is advisory, runtime fails closed", async () => {
	// Static gate with a loader that cannot find the name (e.g. saved between
	// validate and run) degrades to advisory; the runtime loader is the
	// authoritative gate and fails before any subagent runs.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-sh2-missing-name-"));
	let calls = 0;
	try {
		const def: Taskflow = {
			name: "missing-use-parent",
			phases: [
				{ id: "child", type: "flow", use: "not-saved-yet" },
				{
					id: "write", type: "agent", agent: "executor", task: "write", dependsOn: ["child"],
					effects: [writeEffect("internal")], final: true,
				},
			],
		};
		const sv = validateTaskflow(def, { resolveFlow: () => undefined });
		assert.equal(sv.ok, true, "a loader miss at static time must stay advisory");
		assert.ok(sv.warnings.some((w) => /unresolved-flow-use|advisory/i.test(w)), JSON.stringify(sv.warnings));

		const res = await executeTaskflow(mkState(def, root), {
			cwd: root,
			agents: AGENTS,
			loadFlow: () => undefined,
			runTask: async (_c: string, _a: unknown, agentName: string, task: string) => {
				calls++;
				return okResult(agentName, task, "nope\n");
			},
		});
		assert.equal(res.ok, false, "runtime loader miss must fail closed");
		assert.equal(calls, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
