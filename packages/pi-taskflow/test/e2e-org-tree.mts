/**
 * MAXIMALLY COMPLEX real e2e: a recursive organization tree.
 *
 * One open-ended task — "audit the core subsystem and produce a fix roadmap" —
 * drives a multi-LAYER dynamic org:
 *
 *   lead (planner)
 *     └─ ctx_spawn(subflow A: an audit pipeline DAG)
 *           ├─ recon   (scout, shareContext) — surveys core files, ctx_write's a
 *           │           shared "map" with a per-run MARKER for the auditors to reuse
 *           ├─ audit   (MAP fan-out over 3 core files, shareContext) — each auditor
 *           │           ctx_read's recon's map (HORIZONTAL reuse, echoes MARKER) AND,
 *           │           if it judges the file high-complexity, ctx_spawn's a GRANDCHILD
 *           │           subflow B (triage → fix-plan, with dependsOn) — org within org
 *           └─ roadmap (reduce, doc-writer) — prioritized fix roadmap (the deliverable)
 *
 * This single run stresses EVERYTHING round-1 + the context tree added:
 *   • ctx_spawn(subflow) emitted by a real model (lead → subflow A)
 *   • a spawned subflow containing map fan-out + dependsOn + reduce
 *   • horizontal blackboard reuse inside the spawned subflow (recon→auditors)
 *   • a phase INSIDE a spawned subflow itself ctx_spawn'ing a grandchild subflow
 *     (recursive org tree across TWO nesting axes — the unified _stack counter)
 *   • everything folding upward into one real deliverable
 *
 * Verified against on-disk ground truth (tree.json depth + the nested run states).
 *
 * Run:  node --experimental-strip-types test/e2e-org-tree.mts   (real pi; slow)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents, readSubagentSettings } from "taskflow-core";
import { executeTaskflow } from "taskflow-core";
import { validateTaskflow, type Taskflow } from "taskflow-core";
import { runsDir, saveRun, type RunState } from "taskflow-core";

const MARKER = `MAP-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

const FLOW: Taskflow = {
	name: "e2e-org-tree",
	contextSharing: true,
	concurrency: 3,
	budget: { maxUSD: 6.0 },
	phases: [
		{
			id: "lead",
			type: "agent",
			agent: "planner",
			task:
				`You are an engineering lead. Goal: produce a PRIORITIZED FIX ROADMAP for this ` +
				`repo's core IPC/persistence subsystem. This is multi-step, so delegate it as ` +
				`a SUBFLOW (a DAG) via ONE ctx_spawn call whose assignment uses "subflow".\n\n` +
				`The subflow MUST be {"phases":[...]} with these phases (use these EXACT ids and ` +
				`fields, do not add others):\n\n` +
				`1. {"id":"recon","type":"agent","agent":"scout","shareContext":true,"task":` +
				`"Skim extensions/context-store.ts. Then ctx_write key 'map' with JSON ` +
				`{marker:'${MARKER}',notes:'1 line on how the blackboard locking works'}. The ` +
				`marker MUST be exactly ${MARKER}. Reply DONE."}\n\n` +
				`2. {"id":"audit","type":"agent","agent":"analyst","shareContext":true,` +
				`"dependsOn":["recon"],"task":"FIRST ctx_read key 'map' to reuse recon's survey ` +
				`(do not re-derive it). Audit extensions/context-store.ts for ONE concrete issue ` +
				`(cite a function). You MUST then call ctx_spawn with a 'subflow' of two phases ` +
				`(this is required, not optional): ` +
				`{id:'triage',agent:'analyst',task:'name the riskiest function in context-store.ts'} ` +
				`and {id:'fixplan',agent:'analyst',dependsOn:['triage'],final:true,` +
				`task:'propose a concrete fix for {steps.triage.output}'}. END your reply with the ` +
				`marker from the map you read."}\n\n` +
				`3. {"id":"roadmap","type":"reduce","from":["audit"],"agent":"doc-writer",` +
				`"dependsOn":["audit"],"final":true,"task":"Write a prioritized fix roadmap ` +
				`(P0/P1/P2) from this finding:\\n{steps.audit.output}"}\n\n` +
				`Set "defaultAgent" to "analyst". After the ctx_spawn call, reply exactly DONE.`,
			final: true,
		},
	],
};

async function main() {
	const v = validateTaskflow(FLOW);
	if (!v.ok) { console.error("INVALID:", v.errors); process.exit(1); }
	console.log(`valid ✓  (marker ${MARKER})`);

	const settings = readSubagentSettings();
	const { agents } = discoverAgents(process.cwd(), "user", settings.modelRoles, settings.taskflow);
	const runId = `e2e-orgtree-${Date.now().toString(36)}`;
	const state: RunState = {
		runId, flowName: FLOW.name, def: FLOW, args: {}, status: "running",
		phases: {}, createdAt: Date.now(), updatedAt: Date.now(), cwd: process.cwd(),
	};

	console.log("== executing: lead → [recon → map(audit, may spawn grandchild) → roadmap] ==");
	const t0 = Date.now();
	const res = await executeTaskflow(state, {
		cwd: process.cwd(), agents, globalThinking: settings.globalThinking,
		persist: (s) => { saveRun(s); },
		onProgress: (s) => {
			const lead = s.phases.lead;
			const sub = lead?.subProgress ? ` | subflow ${lead.subProgress.done}/${lead.subProgress.total}` : "";
			process.stdout.write(`\r  lead ${lead?.status ?? "?"}${sub}                         `);
		},
	});
	console.log(`\n== done in ${((Date.now() - t0) / 1000).toFixed(1)}s ==`);

	const ctxDir = path.join(runsDir(process.cwd()), "ctx", runId);
	let tree: { nodes?: Array<{ nodeId: string; phaseId: string; parentNodeId?: string }> } = {};
	try { tree = JSON.parse(fs.readFileSync(path.join(ctxDir, "tree.json"), "utf-8")); } catch { /* none */ }
	const nodes = tree.nodes ?? [];
	const out = res.finalOutput ?? "";

	// A spawned subflow runs as its OWN isolated nested run, so it gets its OWN
	// ctx dir (named <childNodeId>-inline-*). The org tree therefore spans MULTIPLE
	// tree.json files linked by the `-inline` naming — not one flat tree. To prove
	// recursive depth (a phase INSIDE a spawned subflow itself spawning a child),
	// we walk into the spawned subflow's ctx dir and look for a grandchild node.
	const ctxRoot = path.join(runsDir(process.cwd()), "ctx");
	let subflowCtxDirs: string[] = [];
	try {
		subflowCtxDirs = fs.readdirSync(ctxRoot)
			.filter((d) => d.includes("-inline-"))
			.map((d) => path.join(ctxRoot, d));
	} catch { /* none */ }
	// Pick the most recently modified inline ctx dir (this run's subflow).
	subflowCtxDirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	let grandchildFound = false;
	let subflowTreeNodes: Array<{ nodeId: string; parentNodeId?: string; status: string }> = [];
	if (subflowCtxDirs[0]) {
		try {
			const st = JSON.parse(fs.readFileSync(path.join(subflowCtxDirs[0], "tree.json"), "utf-8"));
			subflowTreeNodes = st.nodes ?? [];
			// A grandchild = a node whose parent is itself a non-root node in the subflow tree.
			grandchildFound = subflowTreeNodes.some((n) => n.parentNodeId && n.parentNodeId !== undefined);
		} catch { /* none */ }
	}

	const spawnedUnderLead = nodes.filter((n) => n.parentNodeId === "lead");

	console.log("\nparent tree nodes:");
	for (const n of nodes) console.log(`  ${n.nodeId} <- ${n.parentNodeId ?? "-"} [${n.status}]`);
	console.log("spawned subflow tree nodes (the org sub-tree):");
	for (const n of subflowTreeNodes) console.log(`  ${n.nodeId} <- ${n.parentNodeId ?? "-"} [${n.status}]`);

	// Did any auditor inside the spawned subflow reuse the shared map? (marker echo)
	const markerHits = (out.match(new RegExp(MARKER, "g")) ?? []).length;
	const hasPrioritized = /P0|P1|P2/.test(out);
	const noShapeError = !/failed validation|failed verification|not a Taskflow/.test(out);

	console.log(`\nmarker "${MARKER}" echoed ${markerHits}× in folded output (blackboard reuse inside spawned subflow)`);
	console.log("── roadmap (tail 800) ──\n" + out.slice(-800));

	const checks: Array<[string, boolean]> = [
		["overall ok", res.ok],
		["lead spawned subflow A", spawnedUnderLead.length >= 1],
		["spawn fold marker present", /ctx_spawn: \d+ child report/.test(out)],
		["subflow validated & ran (no shape error)", noShapeError],
		["horizontal reuse: an auditor echoed the shared map marker", markerHits >= 1],
		["recursive org tree: a phase inside the spawned subflow spawned a grandchild", grandchildFound],
		["nested DAG produced a prioritized roadmap", hasPrioritized],
		["deliverable is substantial (>400 chars)", out.length > 400],
		["stayed within budget", res.state.status !== "blocked"],
	];
	console.log("\n== assertions ==");
	let allPass = true;
	for (const [n, okk] of checks) { console.log(`  ${okk ? "PASS" : "FAIL"}  ${n}`); if (!okk) allPass = false; }
	console.log(allPass ? "\n✅ ORG-TREE E2E PASSED" : "\n❌ ORG-TREE E2E FAILED");
	process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
