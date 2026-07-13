/**
 * REAL "team" end-to-end test for the Shared Context Tree.
 *
 * A multi-role engineering team collaborates on ONE real deliverable: a
 * prioritized improvement plan for this repo's IPC subsystem
 * (`packages/taskflow-core/src/context-store.ts` +
 * `packages/pi-taskflow/src/runner.ts`). It exercises the whole
 * collaboration surface against real `pi` subagents + a real model:
 *
 *   1. scout  — surveys the subsystem ONCE, ctx_write's a shared "map"
 *               (files, key funcs, an INVARIANTS list with a per-run marker).
 *   2. 3 experts in PARALLEL — analyst (correctness/concurrency),
 *      reviewer (architecture/quality), risk-reviewer (failure/security).
 *      Each ctx_read's the scout's map FIRST (no re-deriving), audits its
 *      angle, and ctx_write's its findings back under its own key.
 *   3. lead (planner) — ctx_read's ALL expert findings, then DYNAMICALLY
 *      ctx_spawn's a deep-dive child for the single highest-risk item
 *      (vertical recursive supervision — the child's report folds back in).
 *   4. gate (critic) — quality gate: every recommendation must cite concrete
 *      evidence (file/function). VERDICT: PASS/BLOCK.
 *   5. editor (doc-writer) — synthesizes the final prioritized plan.
 *
 * Asserts the COLLABORATION actually happened (shared map reused by the experts
 * via a marker that can only come from the blackboard), the supervisor spawned
 * a deep-dive, the gate ran, and a real plan came out — verified against both
 * the run result AND the on-disk blackboard ground truth.
 *
 * Run:  node --experimental-strip-types test/e2e-team.mts   (needs real `pi`)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents, readSubagentSettings } from "taskflow-core";
import { executeTaskflow } from "taskflow-core";
import { validateTaskflow, type Taskflow } from "taskflow-core";
import { runsDir, saveRun } from "taskflow-core";
import type { RunState } from "taskflow-core";
import { installNoExtPiWrapper } from "./e2e-helpers.mts";
import { piSubagentRunner } from "../src/runner.ts";

const MARKER = `INV-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
const TARGET = "packages/taskflow-core/src/context-store.ts + packages/pi-taskflow/src/runner.ts";

const FLOW: Taskflow = {
	name: "e2e-team",
	concurrency: 3,
	contextSharing: true,
	phases: [
		// ── 1. Recon: map the subsystem ONCE for the whole team. ──
		// Use `analyst` (capable, high-thinking) as the producer: a fast/thinking-off
		// agent (scout) proved unreliable at the 'survey AND ctx_write' two-step.
		// The ctx_write IS the deliverable here, stated first and unmissable.
		{
			id: "scout",
			type: "agent",
			agent: "analyst",
			task:
				`You are the team's recon lead. Your PRIMARY deliverable is a ctx_write ` +
				`tool call — do it before anything else fades.\n\n` +
				`Step 1: read both files in ${TARGET} and identify the key exported ` +
				`functions and how they relate (who writes the blackboard, who reads it, ` +
				`locking, env injection).\n` +
				`Step 2: CALL ctx_write with key "map" and this exact JSON shape:\n` +
				`{"files":[...],"keyFunctions":[...],"invariantsTag":"${MARKER}"}\n` +
				`invariantsTag MUST be exactly ${MARKER}.\n` +
				`Step 3: reply DONE. If you did not call ctx_write you failed the task.`,
		},

		// ── 2. Three experts, in parallel, each reusing the shared map. ──
		{
			id: "expert-correctness",
			type: "agent",
			agent: "analyst",
			dependsOn: ["scout"],
			task:
				`You are the correctness & concurrency expert. FIRST call ctx_read with ` +
				`key "map" to reuse the scout's survey (do NOT re-map the subsystem). ` +
				`Then audit ${TARGET} for correctness, race conditions, and resume safety. ` +
				`Report up to 3 concrete findings, each citing a file + function.\n\n` +
				`Call ctx_write with key "find.correctness" and your findings as a JSON ` +
				`array. End your reply with the invariantsTag from the map you read.`,
		},
		{
			id: "expert-architecture",
			type: "agent",
			agent: "reviewer",
			dependsOn: ["scout"],
			task:
				`You are the architecture & code-quality expert. FIRST call ctx_read with ` +
				`key "map" to reuse the scout's survey. Then review ${TARGET} for design, ` +
				`cohesion, naming, and maintainability. Report up to 3 concrete findings ` +
				`(file + function each).\n\n` +
				`Call ctx_write with key "find.architecture" and your findings as a JSON ` +
				`array. End your reply with the invariantsTag from the map you read.`,
		},
		{
			id: "expert-risk",
			type: "agent",
			agent: "risk-reviewer",
			dependsOn: ["scout"],
			task:
				`You are the failure-mode & security expert. FIRST call ctx_read with key ` +
				`"map" to reuse the scout's survey. Then audit ${TARGET} for path traversal, ` +
				`unbounded growth, crash/partial-write hazards, and DoS. Report up to 3 ` +
				`concrete findings (file + function each), with a severity each.\n\n` +
				`Call ctx_write with key "find.risk" and your findings as a JSON array. ` +
				`End your reply with the invariantsTag from the map you read.`,
		},

		// ── 3. Lead supervisor: read all findings, dynamically deep-dive. ──
		{
			id: "lead",
			type: "agent",
			agent: "planner",
			dependsOn: ["expert-correctness", "expert-architecture", "expert-risk"],
			task:
				`You are the team lead. Call ctx_read (no key) to see ALL the team's shared ` +
				`findings (find.correctness, find.architecture, find.risk). Identify the ` +
				`SINGLE highest-impact issue across all three.\n\n` +
				`Then use ctx_spawn to delegate ONE deep-dive: an assignment whose task is ` +
				`"Deep-dive the highest-risk issue: <name it>. Read the relevant code in ` +
				`${TARGET} and propose a concrete fix with rough effort." Use agent ` +
				`"analyst" for it. After spawning, write a 3-sentence triage of what the ` +
				`team found and why you picked that deep-dive.`,
		},

		// ── 4. Quality gate: evidence or it didn't happen. ──
		{
			id: "gate",
			type: "gate",
			agent: "critic",
			dependsOn: ["lead"],
			task:
				`Review the team's triage + deep-dive below. Every claimed issue must cite ` +
				`a concrete file AND function/concept — not vague hand-waving. If the body ` +
				`is evidence-backed, end with "VERDICT: PASS". Only "VERDICT: BLOCK" if it ` +
				`is mostly vague assertions.\n\n{steps.lead.output}`,
		},

		// ── 5. Editor: synthesize the deliverable. ──
		{
			id: "plan",
			type: "reduce",
			from: ["expert-correctness", "expert-architecture", "expert-risk", "lead"],
			agent: "doc-writer",
			dependsOn: ["gate"],
			task:
				`Synthesize a PRIORITIZED improvement plan for ${TARGET} from the team's ` +
				`work below. Output sections: ## P0 (must fix), ## P1 (should fix), ` +
				`## P2 (nice to have). Each item: one line + the file/function + ~effort. ` +
				`Keep it tight and actionable.\n\n` +
				`Correctness:\n{steps.expert-correctness.output}\n\n` +
				`Architecture:\n{steps.expert-architecture.output}\n\n` +
				`Risk:\n{steps.expert-risk.output}\n\n` +
				`Lead triage + deep-dive:\n{steps.lead.output}`,
			final: true,
		},
	],
};

async function main() {
	console.log("== validating ==");
	const v = validateTaskflow(FLOW);
	if (!v.ok) {
		console.error("INVALID:", v.errors);
		process.exit(1);
	}
	console.log(`valid ✓  (invariants marker: ${MARKER})`);

	const settings = readSubagentSettings();
	const { agents } = discoverAgents(process.cwd(), "user", settings.modelRoles, settings.taskflow);
	const need = ["scout", "analyst", "reviewer", "risk-reviewer", "planner", "critic", "doc-writer"];
	const missing = need.filter((n) => !agents.some((a) => a.name === n));
	console.log(`discovered ${agents.length} agents; missing: ${missing.length ? missing.join(",") : "none"}`);

	const runId = `e2e-team-${Date.now().toString(36)}`;
	const state: RunState = {
		runId,
		flowName: FLOW.name,
		def: FLOW,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	};

	const restorePiBin = installNoExtPiWrapper("pi-taskflow-e2e-team");
	try {
		console.log("== executing (real team of subagents) ==");
		const t0 = Date.now();
		const res = await executeTaskflow(state, {
			cwd: process.cwd(),
			agents,
			globalThinking: settings.globalThinking,
			runTask: piSubagentRunner.runTask,
			persist: (s) => {
				try { saveRun(s); } catch { /* best-effort; the E2E result is authoritative */ }
			},
			onProgress: (s) => {
				const done = Object.values(s.phases).filter((p) => p.status === "done").length;
				const running = Object.values(s.phases)
					.filter((p) => p.status === "running")
					.map((p) => p.id);
				process.stdout.write(
					`\r  ${done}/${s.def.phases.length} done` +
						(running.length ? ` | running: ${running.join(",")}` : "") +
						"                    ",
				);
			},
		});
		console.log(`\n== done in ${((Date.now() - t0) / 1000).toFixed(1)}s ==`);

		console.log("\nPhase states:");
		for (const p of FLOW.phases) {
			const ps = res.state.phases[p.id];
			console.log(`  ${ps?.status === "done" ? "✓" : "✗"} ${p.id} [${p.type}]`);
		}

		// ── Ground-truth inspection of the blackboard ──
		const ctxDir = path.join(runsDir(process.cwd()), "ctx", runId);
		const findingsDir = path.join(ctxDir, "findings");
		let findingFiles: string[] = [];
		try {
			findingFiles = fs.readdirSync(findingsDir).filter((f) => f.endsWith(".json") && !f.includes(".lock"));
		} catch { /* none */ }
		const blackboardKeys = new Set<string>();
		let mapHasMarker = false;
		for (const f of findingFiles) {
			try {
				const obj = JSON.parse(fs.readFileSync(path.join(findingsDir, f), "utf-8"));
				for (const k of Object.keys(obj)) blackboardKeys.add(k);
				if (typeof obj.map === "string" && obj.map.includes(MARKER)) mapHasMarker = true;
			} catch { /* skip */ }
		}
		let tree: { nodes?: Array<{ nodeId: string; phaseId: string; parentNodeId?: string }> } = {};
		try { tree = JSON.parse(fs.readFileSync(path.join(ctxDir, "tree.json"), "utf-8")); } catch { /* none */ }
		const spawnedChildren = (tree.nodes ?? []).filter((n) => n.parentNodeId === "lead");

		console.log("\nBlackboard ground truth:");
		console.log(`  keys written: ${[...blackboardKeys].join(", ") || "(none)"}`);
		console.log(`  scout map carries marker ${MARKER}: ${mapHasMarker}`);
		console.log(`  lead spawned children: ${spawnedChildren.length}`);

		// Marker reuse by the experts (only obtainable from the shared map).
		const expertOut = [
			res.state.phases["expert-correctness"]?.output ?? "",
			res.state.phases["expert-architecture"]?.output ?? "",
			res.state.phases["expert-risk"]?.output ?? "",
		];
		const expertsReusedMap = expertOut.filter((o) => o.includes(MARKER)).length;
		console.log(`  experts that echoed the shared marker: ${expertsReusedMap}/3`);

		const leadOut = res.state.phases.lead?.output ?? "";
		const plan = res.finalOutput ?? "";

		const checks: Array<[string, boolean]> = [
			["overall ok", res.ok],
			["scout published the shared map (marker on blackboard)", mapHasMarker],
			["≥2 experts reused the shared map (collaboration, not re-deriving)", expertsReusedMap >= 2],
			["≥2 of 3 experts wrote findings back to the blackboard", ["find.correctness", "find.architecture", "find.risk"].filter((k) => blackboardKeys.has(k)).length >= 2],
			["lead dynamically spawned a deep-dive (recursive supervision)", spawnedChildren.length >= 1 || /spawned child/i.test(leadOut)],
			["gate ran", res.state.phases.gate?.status === "done"],
			["final plan has prioritized sections", /P0/.test(plan) && /P1/.test(plan)],
			["plan is substantial (>400 chars)", plan.length > 400],
		];
		console.log("\n== assertions ==");
		let allPass = true;
		for (const [name, ok] of checks) {
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
			if (!ok) allPass = false;
		}
		console.log("\n── Final prioritized plan ──\n" + plan.slice(0, 1200));
		console.log(allPass ? "\n✅ TEAM E2E PASSED" : "\n❌ TEAM E2E FAILED");
		process.exit(allPass ? 0 : 1);
	} finally {
		restorePiBin();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
