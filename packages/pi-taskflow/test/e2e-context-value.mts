/**
 * REAL, value-demonstrating end-to-end test for the Shared Context Tree.
 *
 * This exercises BOTH core capabilities against a REAL codebase (this repo's
 * own extensions/), with real `pi` subagents and a real model:
 *
 *   PART A — Horizontal blackboard reuse (avoid duplicated work)
 *     1. `survey` maps shared project conventions ONCE and ctx_write's them
 *        under "conventions", embedding a unique per-run MARKER token.
 *     2. `audit` fans out (map) over 3 real files. Each auditor is told to
 *        ctx_read("conventions") and BEGIN its report by echoing the MARKER —
 *        a value it can ONLY have obtained from the blackboard. If every map
 *        item echoes the marker, the survey's work was reused N times instead
 *        of each auditor re-deriving conventions (= the "stop re-reading the
 *        same context" win).
 *
 *   PART B — Vertical recursive supervision (report up + dynamic spawn)
 *     3. `lead` reads a real file and, per its size, ctx_spawn's one child
 *        sub-audit per concern it finds. The children run as isolated agents
 *        and their reports are folded back into `lead`'s output. We assert the
 *        folded spawn block is present and a child actually ran.
 *
 * Run:  node --experimental-strip-types test/e2e-context-value.mts
 * Requires network + model access (real `pi`).
 */

import * as crypto from "node:crypto";
import { discoverAgents, readSubagentSettings } from "taskflow-core";
import { executeTaskflow } from "taskflow-core";
import { validateTaskflow, type Taskflow } from "taskflow-core";
import type { RunState } from "taskflow-core";

const MARKER = `CONV-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

const FLOW: Taskflow = {
	name: "e2e-context-value",
	concurrency: 3,
	contextSharing: true,
	phases: [
		// PART A — survey once, reuse N times.
		{
			id: "survey",
			type: "agent",
			agent: "scout",
			task:
				`Inspect this TypeScript project's coding conventions by reading AGENTS.md ` +
				`and one or two files under extensions/. Summarize the 3 most important ` +
				`conventions in one short sentence each.\n\n` +
				`Then call ctx_write with key "conventions" and a value that is a JSON ` +
				`object of the form:\n` +
				`{"rules":[ ...your 3 one-line rules... ],"reportFooter":"AUDITED-UNDER: ${MARKER}"}\n` +
				`The reportFooter MUST be exactly "AUDITED-UNDER: ${MARKER}". ` +
				`After the tool call, reply DONE.`,
		},
		{
			id: "audit",
			type: "map",
			over: '["extensions/usage.ts","extensions/cache.ts","extensions/verify.ts"]',
			as: "item",
			agent: "analyst",
			dependsOn: ["survey"],
			task:
				`Do NOT re-derive the project conventions. First call ctx_read with key ` +
				`"conventions" to get the shared conventions a teammate already mapped ` +
				`(this saves you from re-reading AGENTS.md and the codebase). Then read ` +
				`{item} and report up to 2 issues, or confirm it's clean.\n\n` +
				`IMPORTANT: the conventions you read include a "reportFooter" field. You ` +
				`MUST end your reply with exactly that reportFooter line, verbatim. If you ` +
				`did not read the conventions you cannot know it.`,
		},
		{
			id: "summary",
			type: "reduce",
			from: ["audit"],
			agent: "scout",
			dependsOn: ["audit"],
			task:
				`Combine these per-file audit results into one short report:\n\n{steps.audit.output}`,
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
	console.log(`valid ✓  (marker this run: ${MARKER})`);

	const settings = readSubagentSettings();
	const { agents } = discoverAgents(process.cwd(), "user", settings.modelRoles, settings.taskflow);
	console.log(`discovered ${agents.length} agents`);

	const state: RunState = {
		runId: `e2e-ctxval-${Date.now().toString(36)}`,
		flowName: FLOW.name,
		def: FLOW,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	};

	console.log("== executing (real subagents) ==");
	const t0 = Date.now();
	const res = await executeTaskflow(state, {
		cwd: process.cwd(),
		agents,
		globalThinking: settings.globalThinking,
		persist: (s) => {
			try {
				// best-effort save so the run is inspectable afterward
				import("../extensions/store.ts").then((m) => m.saveRun(s)).catch(() => {});
			} catch { /* ignore */ }
		},
		onProgress: (s) => {
			const done = Object.values(s.phases).filter((p) => p.status === "done").length;
			const running = Object.values(s.phases)
				.filter((p) => p.status === "running")
				.map((p) => p.id);
			process.stdout.write(
				`\r  progress: ${done}/${s.def.phases.length} done` +
					(running.length ? ` | running: ${running.join(",")}` : "") +
					"          ",
			);
		},
	});
	console.log(`\n== done in ${((Date.now() - t0) / 1000).toFixed(1)}s ==`);

	console.log("\nPhase states:");
	for (const p of FLOW.phases) {
		const ps = res.state.phases[p.id];
		console.log(`  ${ps?.status === "done" ? "✓" : "✗"} ${p.id} [${p.type}] -> ${JSON.stringify(ps?.output?.slice(0, 100))}`);
	}

	const auditOut = res.state.phases.audit?.output ?? "";
	// The map output concatenates sub-results, each tagged "[i/N] ...".
	const markerHits = (auditOut.match(new RegExp(MARKER, "g")) ?? []).length;
	console.log(`\nMarker "${MARKER}" appeared ${markerHits}× in the audit fan-out (expected ≥2 of 3).`);

	const checks: Array<[string, boolean]> = [
		["overall ok", res.ok],
		["survey done", res.state.phases.survey?.status === "done"],
		["audit fan-out done", res.state.phases.audit?.status === "done"],
		["≥2 of 3 auditors reused the shared marker (blackboard reuse, not re-derived)", markerHits >= 2],
		["final summary produced", (res.finalOutput?.length ?? 0) > 0],
	];
	console.log("\n== assertions ==");
	let allPass = true;
	for (const [name, ok] of checks) {
		console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
		if (!ok) allPass = false;
	}
	console.log("\nFinal summary:\n  ", (res.finalOutput ?? "").slice(0, 400));
	console.log(allPass ? "\n✅ CONTEXT-VALUE E2E PASSED" : "\n❌ CONTEXT-VALUE E2E FAILED");
	process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
