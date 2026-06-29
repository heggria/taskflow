/**
 * LARGEST real e2e: a full engineering-org audit that iterates to convergence.
 *
 * I (the flow author) hand-write the reliable top-level DAG — large fan-out,
 * an iterative refine loop, a quality gate, a reduce deliverable. The MODEL only
 * makes the judgment calls that genuinely need a model: whether to ctx_spawn a
 * grandchild deep-dive, and whether the report has converged. (Lesson applied:
 * never make a model author a complex map-subflow in prose — the map's `over`
 * lives here in code, fixed and valid.)
 *
 *   ① recon        (scout, shareContext)  — survey the repo, ctx_write a shared
 *                   "map" with a per-run MARKER for the domain auditors to reuse
 *   ② domain-audit (MAP × 5 domains, shareContext) — runtime / schema / storage /
 *                   cache / security; each ctx_read's the shared map (HORIZONTAL
 *                   reuse, echoes MARKER) AND ctx_spawn's a grandchild subflow
 *                   (triage → fixplan) — recursive org tree, ×5 in parallel
 *   ③ synth        (reduce, doc-writer) — merge 5 domains into a draft report
 *   ④ refine       (loop, critic) — iterate: critique the draft, converge on
 *                   {"done":true} or sharpen it (iterative replanning)
 *   ⑤ risk-gate    (gate, risk-reviewer) — evidence-or-block quality gate
 *   ⑥ governance   (reduce, doc-writer, final) — the deliverable
 *
 * Stresses: large 5-way fan-out, horizontal blackboard reuse at scale, 5
 * concurrent grandchild spawns (recursive org tree), an iterative loop, a gate,
 * and budget accounting across all of it — verified vs on-disk ground truth.
 *
 * Run:  node --experimental-strip-types test/e2e-org-audit-iterate.mts  (real pi; slow)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents, readSubagentSettings } from "taskflow-core";
import { executeTaskflow } from "taskflow-core";
import { validateTaskflow, type Taskflow } from "taskflow-core";
import { runsDir, saveRun, type RunState } from "taskflow-core";

const MARKER = `REPO-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
const DOMAINS = JSON.stringify([
	{ domain: "runtime", file: "extensions/runtime.ts" },
	{ domain: "schema", file: "extensions/schema.ts" },
	{ domain: "storage", file: "extensions/store.ts" },
	{ domain: "cache", file: "extensions/cache.ts" },
	{ domain: "context-tree", file: "extensions/context-store.ts" },
]);

const FLOW: Taskflow = {
	name: "e2e-org-audit-iterate",
	contextSharing: true,
	concurrency: 5,
	budget: { maxUSD: 12.0 },
	phases: [
		{
			id: "recon",
			type: "agent",
			agent: "scout",
			shareContext: true,
			task:
				`You are the recon lead for a repo-wide audit. Skim AGENTS.md and the file ` +
				`extensions/context-store.ts. Your PRIMARY deliverable is a ctx_write call: ` +
				`ctx_write key 'map' with JSON {"marker":"${MARKER}","conventions":"2 one-line ` +
				`rules every auditor should know"}. The marker MUST be exactly ${MARKER}. ` +
				`If you did not call ctx_write you failed. Reply DONE.`,
		},
		{
			id: "domain-audit",
			type: "map",
			over: DOMAINS,
			as: "item",
			agent: "analyst",
			shareContext: true,
			dependsOn: ["recon"],
			concurrency: 5,
			task:
				`You audit the {item.domain} domain (file: {item.file}). FIRST call ctx_read ` +
				`key 'map' to reuse the shared recon survey (do NOT re-derive conventions). ` +
				`Read {item.file} and identify ONE concrete issue, citing a function.\n\n` +
				`Then you MUST (required) call ctx_spawn with ONE assignment that uses ` +
				`'subflow' (NOT 'task'), where subflow is ` +
				`{"phases":[` +
				`{"id":"triage","agent":"analyst","task":"Name the single riskiest function in ${"{item.file}"} and why, in 2 lines."},` +
				`{"id":"fixplan","agent":"analyst","dependsOn":["triage"],"final":true,"task":"Propose a concrete one-paragraph fix for {steps.triage.output}"}` +
				`]} and set "defaultAgent" to "analyst".\n\n` +
				`END your reply with the marker from the map you read.`,
		},
		{
			id: "synth",
			type: "reduce",
			from: ["domain-audit"],
			agent: "doc-writer",
			dependsOn: ["domain-audit"],
			task:
				`Merge these 5 domain audits (each includes a deep-dive fix) into a single ` +
				`draft "governance report" with a findings table (domain | issue | fix):\n\n` +
				`{steps.domain-audit.output}`,
		},
		{
			id: "refine",
			type: "loop",
			agent: "critic",
			maxIterations: 3,
			convergence: true,
			until: "{steps.refine.json.done} == true",
			output: "json",
			dependsOn: ["synth"],
			task:
				`Critique this governance report draft for vagueness or missing evidence. ` +
				`If every finding cites a concrete function/file and the fixes are concrete, ` +
				`output JSON {"done":true,"report":"<the report, unchanged or tightened>"}. ` +
				`Otherwise output {"done":false,"report":"<a sharpened version>"}.\n\n` +
				`Draft:\n{steps.synth.output}`,
		},
		{
			id: "risk-gate",
			type: "gate",
			agent: "risk-reviewer",
			dependsOn: ["refine"],
			task:
				`Quality gate. The governance report below must have every finding backed by ` +
				`a concrete file/function and an actionable fix. If it is evidence-backed, end ` +
				`with "VERDICT: PASS"; only "VERDICT: BLOCK" if it is mostly vague.\n\n` +
				`{steps.refine.json.report}`,
		},
		{
			id: "governance",
			type: "reduce",
			from: ["refine", "domain-audit"],
			agent: "doc-writer",
			dependsOn: ["risk-gate"],
			final: true,
			task:
				`Produce the FINAL prioritized governance report (P0/P1/P2). Use the refined ` +
				`report and the per-domain deep-dives. Keep every file/function citation.\n\n` +
				`Refined report:\n{steps.refine.json.report}\n\n` +
				`Per-domain deep-dives:\n{steps.domain-audit.output}`,
		},
	],
};

async function main() {
	const v = validateTaskflow(FLOW);
	if (!v.ok) { console.error("INVALID:", v.errors); process.exit(1); }
	console.log(`valid ✓  (marker ${MARKER}, 6 top phases, 5-way fan-out + grandchildren)`);

	const settings = readSubagentSettings();
	const { agents } = discoverAgents(process.cwd(), "user", settings.modelRoles, settings.taskflow);
	const runId = `e2e-orgaud-${Date.now().toString(36)}`;
	const state: RunState = {
		runId, flowName: FLOW.name, def: FLOW, args: {}, status: "running",
		phases: {}, createdAt: Date.now(), updatedAt: Date.now(), cwd: process.cwd(),
	};

	console.log("== executing (large org: recon → map×5(+grandchild) → synth → loop → gate → final) ==");
	const t0 = Date.now();
	const res = await executeTaskflow(state, {
		cwd: process.cwd(), agents, globalThinking: settings.globalThinking,
		persist: (s) => { saveRun(s); },
		onProgress: (s) => {
			const done = Object.values(s.phases).filter((p) => p.status === "done").length;
			const running = Object.values(s.phases).filter((p) => p.status === "running").map((p) => p.id);
			const da = s.phases["domain-audit"]?.subProgress;
			const fan = da ? ` | fan-out ${da.done}/${da.total}` : "";
			process.stdout.write(`\r  ${done}/${s.def.phases.length} done${fan}${running.length ? " | " + running.join(",") : ""}              `);
		},
	});
	console.log(`\n== done in ${((Date.now() - t0) / 1000).toFixed(1)}s ==`);

	const out = res.finalOutput ?? "";
	const auditOut = res.state.phases["domain-audit"]?.output ?? "";
	const markerHits = (auditOut.match(new RegExp(MARKER, "g")) ?? []).length;

	// Grandchildren register as `<mapItem>--cN` nodes parented to a domain-audit
	// item in THIS run's ctx tree (a spawned subflow may also create its own
	// `-inline-` ctx dir, but the supervision node is what proves it ran).
	const ctxDir = path.join(runsDir(process.cwd()), "ctx", runId);
	let treeNodes: Array<{ nodeId: string; parentNodeId?: string }> = [];
	try { treeNodes = (JSON.parse(fs.readFileSync(path.join(ctxDir, "tree.json"), "utf-8")).nodes ?? []); } catch { /* none */ }
	const grandchildren = treeNodes.filter((n) => /^domain-audit-\d+--c\d+$/.test(n.nodeId));

	console.log("\nPhase states:");
	for (const p of FLOW.phases) console.log(`  ${res.state.phases[p.id]?.status === "done" ? "✓" : "✗"} ${p.id} [${p.type}]`);
	console.log(`\nmarker "${MARKER}" echoed ${markerHits}× across the 5-way fan-out (shared-map reuse)`);
	console.log(`spawned grandchild deep-dives this run: ${grandchildren.length} (${grandchildren.map((g) => g.nodeId).join(", ")})`);
	console.log("\n── governance report (tail 900) ──\n" + out.slice(-900));

	const totalCost = Object.values(res.state.phases).reduce((s, p) => s + (p.usage?.cost ?? 0), 0);
	console.log(`\ntotal accounted cost across all phases (incl. spawned): $${totalCost.toFixed(4)}`);

	const checks: Array<[string, boolean]> = [
		["overall ok", res.ok],
		["recon published shared map (marker)", markerHits >= 1],
		["all 5 domains audited (fan-out done)", res.state.phases["domain-audit"]?.status === "done"],
		["≥3 of 5 auditors reused the shared map (horizontal reuse at scale)", markerHits >= 3],
		["≥3 grandchild deep-dives spawned by map items (recursive org tree ×N)", grandchildren.length >= 3],
		["iterative refine loop ran", res.state.phases.refine?.status === "done"],
		["risk gate ran (not blocked)", res.state.phases["risk-gate"]?.status === "done"],
		["final prioritized governance report produced", /P0|P1|P2/.test(out) && out.length > 500],
		["budget accounted & not exceeded", res.state.status !== "blocked" && totalCost > 0],
	];
	console.log("\n== assertions ==");
	let allPass = true;
	for (const [n, okk] of checks) { console.log(`  ${okk ? "PASS" : "FAIL"}  ${n}`); if (!okk) allPass = false; }
	console.log(allPass ? "\n✅ ORG-AUDIT-ITERATE E2E PASSED" : "\n❌ ORG-AUDIT-ITERATE E2E FAILED");
	process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
