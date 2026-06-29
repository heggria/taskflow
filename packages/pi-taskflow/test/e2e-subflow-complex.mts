/**
 * REAL, meaningful complex-subflow e2e for ctx_spawn(subflow).
 *
 * A single `lead` (planner) receives an OPEN-ENDED task — "assess the test
 * health of this repo" — and decides at runtime to delegate it as a multi-stage
 * SUBFLOW DAG (not a flat task, not pre-declared phases). The spawned subflow is
 * a genuine pipeline:
 *
 *     inventory (scout, output JSON list of test groups)
 *        └─> analyze (MAP fan-out over inventory's groups, one analyst per group)
 *               └─> synthesize (reduce/doc-writer → a prioritized test-health report)
 *
 * This exercises everything round-1 added, on real work:
 *   • ctx_spawn with a `subflow` (a DAG), emitted by a real model
 *   • the subflow runs as a nested validated flow (map + dependsOn + reduce)
 *   • map fan-out inside a spawned subflow over a list the subflow DISCOVERS
 *     at runtime (inventory's JSON) — the whole point of "dynamic subgraph"
 *   • the subflow's final report folds back into the lead's output
 *
 * We verify against on-disk ground truth (tree.json + the run state) that the
 * nested DAG actually executed end-to-end and produced a real report.
 *
 * Run:  node --experimental-strip-types test/e2e-subflow-complex.mts   (real pi)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents, readSubagentSettings } from "taskflow-core";
import { executeTaskflow } from "taskflow-core";
import { validateTaskflow, type Taskflow } from "taskflow-core";
import { runsDir, saveRun, type RunState } from "taskflow-core";

const FLOW: Taskflow = {
	name: "e2e-subflow-complex",
	contextSharing: true,
	budget: { maxUSD: 3.0 },
	phases: [
		{
			id: "lead",
			type: "agent",
			agent: "planner",
			task:
				`You are an engineering lead. Goal: produce a prioritized TEST-HEALTH report ` +
				`for this TypeScript repo (test files live in test/*.test.ts). This needs ` +
				`several coordinated steps, so DELEGATE it as a SUBFLOW (a DAG) via a single ` +
				`ctx_spawn call whose assignment uses "subflow" (NOT "task").\n\n` +
				`The subflow MUST be {"phases":[...]} with these three phases (use these exact ids):\n\n` +
				`1. id "inventory", type "agent", agent "scout", output "json": task = ` +
				`"Group the files under test/ into 3 coarse categories by concern (e.g. ` +
				`runtime, schema/validation, storage). Output ONLY a JSON array of 3 objects ` +
				`[{\\"group\\":\\"...\\",\\"files\\":\\"comma-separated\\"}]."\n\n` +
				`2. id "analyze", type "map", over "{steps.inventory.json}", as "item", ` +
				`agent "analyst", dependsOn ["inventory"]: task = "For the test group ` +
				`{item.group} (files: {item.files}), name the single most likely UNTESTED ` +
				`edge case or coverage gap, in one sentence."\n\n` +
				`3. id "synthesize", type "reduce", from ["analyze"], agent "doc-writer", ` +
				`dependsOn ["analyze"], final true: task = "Write a short prioritized ` +
				`test-health report (P0/P1/P2) from these per-group gaps:\\n{steps.analyze.output}".\n\n` +
				`Set "defaultAgent" to "scout". After the ctx_spawn call, reply exactly DONE.`,
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
	const runId = `e2e-subcx-${Date.now().toString(36)}`;
	const state: RunState = {
		runId, flowName: FLOW.name, def: FLOW, args: {}, status: "running",
		phases: {}, createdAt: Date.now(), updatedAt: Date.now(), cwd: process.cwd(),
	};

	console.log("== executing (real subagents: planner → [scout → map(analyst) → doc-writer]) ==");
	const t0 = Date.now();
	const res = await executeTaskflow(state, {
		cwd: process.cwd(), agents, globalThinking: settings.globalThinking,
		persist: (s) => { saveRun(s); },
		onProgress: (s) => {
			const done = Object.values(s.phases).filter((p) => p.status === "done").length;
			const lead = s.phases.lead;
			const sub = lead?.subProgress ? ` | subflow: ${lead.subProgress.done}/${lead.subProgress.total}` : "";
			process.stdout.write(`\r  ${done}/${s.def.phases.length} done${sub}                    `);
		},
	});
	console.log(`\n== done in ${((Date.now() - t0) / 1000).toFixed(1)}s ==`);

	const ctxDir = path.join(runsDir(process.cwd()), "ctx", runId);
	let tree: { nodes?: Array<{ nodeId: string; phaseId: string; parentNodeId?: string }> } = {};
	try { tree = JSON.parse(fs.readFileSync(path.join(ctxDir, "tree.json"), "utf-8")); } catch { /* none */ }
	const spawnedChildren = (tree.nodes ?? []).filter((n) => n.parentNodeId === "lead");
	const out = res.finalOutput ?? "";

	console.log("\ntree nodes:", (tree.nodes ?? []).map((n) => `${n.nodeId}<-${n.parentNodeId ?? "-"}`).join(", "));
	console.log("\n── folded report (tail 900) ──\n" + out.slice(-900));

	// Evidence the nested DAG actually ran all three stages: the synthesized
	// report should mention prioritization (P0/P1/P2) produced by the reduce,
	// which only exists if inventory→map→reduce all completed.
	const hasPrioritized = /P0|P1|P2/.test(out);
	const noShapeError = !/failed validation|failed verification|not a Taskflow|zero phases|no-op/.test(out);

	const checks: Array<[string, boolean]> = [
		["overall ok", res.ok],
		["lead spawned a subflow child", spawnedChildren.length >= 1],
		["spawn fold marker present", /ctx_spawn: \d+ child report/.test(out)],
		["subflow validated & ran (no shape/validation error)", noShapeError],
		["nested DAG completed end-to-end (prioritized report produced)", hasPrioritized],
		["report is substantial (>300 chars)", out.length > 300],
		["stayed within budget", res.state.status !== "blocked"],
	];
	console.log("\n== assertions ==");
	let allPass = true;
	for (const [n, okk] of checks) { console.log(`  ${okk ? "PASS" : "FAIL"}  ${n}`); if (!okk) allPass = false; }
	console.log(allPass ? "\n✅ COMPLEX-SUBFLOW E2E PASSED" : "\n❌ COMPLEX-SUBFLOW E2E FAILED");
	process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
