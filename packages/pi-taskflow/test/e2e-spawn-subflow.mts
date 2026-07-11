/**
 * REAL e2e for ctx_spawn-of-a-subflow (round 1, gap A).
 *
 * A lead phase is told to ctx_spawn a SUBFLOW (a small DAG: investigate → fix-plan,
 * with a dependsOn edge) rather than a flat task. We then verify against on-disk
 * ground truth that the spawned subflow actually executed as a nested DAG:
 * tree.json shows the parent's spawned child, and the folded output carries the
 * subflow's final-phase result.
 *
 * Run:  node --experimental-strip-types test/e2e-spawn-subflow.mts   (needs real pi)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents, readSubagentSettings } from "taskflow-core";
import { executeTaskflow } from "taskflow-core";
import { validateTaskflow, type Taskflow } from "taskflow-core";
import { runsDir, type RunState } from "taskflow-core";
import { installNoExtPiWrapper } from "./e2e-helpers.mts";
import { piSubagentRunner } from "../src/runner.ts";

const FLOW: Taskflow = {
	name: "e2e-spawn-subflow",
	contextSharing: true,
	phases: [
		{
			id: "lead",
			type: "agent",
			agent: "planner",
			task:
				`You are a tech lead. The work below needs MULTIPLE coordinated steps, so ` +
				`delegate it as a SUBFLOW (a DAG), not a single task.\n\n` +
				`Call ctx_spawn with ONE assignment that uses "subflow" (not "task"). The ` +
				`subflow must be {"phases":[ ... ]} with exactly two phases:\n` +
				`  1. id "investigate" (type agent, agent "scout") — task: "List the exported ` +
				`functions of packages/taskflow-core/src/usage.ts".\n` +
				`  2. id "summary" (type agent, agent "analyst", dependsOn ["investigate"], ` +
				`final true) — task: "In one sentence, summarize: {steps.investigate.output}".\n` +
				`Set "defaultAgent" to "scout". After the ctx_spawn call, reply DONE.`,
			final: true,
		},
	],
};

async function main() {
	const v = validateTaskflow(FLOW);
	if (!v.ok) { console.error("INVALID:", v.errors); process.exit(1); }
	console.log("valid ✓");

	const settings = readSubagentSettings();
	const { agents } = discoverAgents(process.cwd(), "user", settings.modelRoles, settings.taskflow);
	const runId = `e2e-spawnsub-${Date.now().toString(36)}`;
	const state: RunState = {
		runId, flowName: FLOW.name, def: FLOW, args: {}, status: "running",
		phases: {}, createdAt: Date.now(), updatedAt: Date.now(), cwd: process.cwd(),
	};

	const restorePiBin = installNoExtPiWrapper("pi-taskflow-e2e-spawn");
	try {
		console.log("== executing (real subagents) ==");
		const t0 = Date.now();
		const res = await executeTaskflow(state, {
			cwd: process.cwd(),
			agents,
			globalThinking: settings.globalThinking,
			runTask: piSubagentRunner.runTask,
			onProgress: (s) => {
				const done = Object.values(s.phases).filter((p) => p.status === "done").length;
				process.stdout.write(`\r  ${done}/${s.def.phases.length} done            `);
			},
		});
		console.log(`\n== done in ${((Date.now() - t0) / 1000).toFixed(1)}s ==`);

		const ctxDir = path.join(runsDir(process.cwd()), "ctx", runId);
		let tree: { nodes?: Array<{ nodeId: string; phaseId: string; parentNodeId?: string }> } = {};
		try { tree = JSON.parse(fs.readFileSync(path.join(ctxDir, "tree.json"), "utf-8")); } catch { /* none */ }
		const spawnedChildren = (tree.nodes ?? []).filter((n) => n.parentNodeId === "lead");
		const out = res.finalOutput ?? "";

		console.log("\ntree nodes:", (tree.nodes ?? []).map((n) => `${n.nodeId}<-${n.parentNodeId ?? "-"}`).join(", "));
		console.log("folded output (tail):\n", out.slice(-500));

		const checks: Array<[string, boolean]> = [
			["overall ok", res.ok],
			["lead spawned a child (subflow node registered)", spawnedChildren.length >= 1],
			["spawn fold marker present", /ctx_spawn: \d+ child report/.test(out)],
			["subflow did NOT fail validation/shape", !/failed validation|failed verification|not a Taskflow/.test(out)],
			["subflow produced a summary (final inner phase ran)", out.length > 0 && !/zero phases|no-op/.test(out)],
		];
		console.log("\n== assertions ==");
		let allPass = true;
		for (const [n, okk] of checks) { console.log(`  ${okk ? "PASS" : "FAIL"}  ${n}`); if (!okk) allPass = false; }
		console.log(allPass ? "\n✅ SPAWN-SUBFLOW E2E PASSED" : "\n❌ SPAWN-SUBFLOW E2E FAILED");
		process.exit(allPass ? 0 : 1);
	} finally {
		restorePiBin();
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
