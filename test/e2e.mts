/**
 * REAL end-to-end test: runs an actual taskflow through the real runtime,
 * spawning real `pi` subagent processes. Requires network + model access.
 *
 * Run:  node --experimental-strip-types test/e2e.mts
 */

import { discoverAgents, readSubagentSettings } from "../extensions/agents.ts";
import { executeTaskflow } from "../extensions/runtime.ts";
import { validateTaskflow, type Taskflow } from "../extensions/schema.ts";
import type { RunState } from "../extensions/store.ts";

const FLOW: Taskflow = {
	name: "e2e-smoke",
	concurrency: 3,
	phases: [
		{
			id: "list",
			type: "agent",
			agent: "scout",
			task: 'Output ONLY this exact JSON array and nothing else: [{"n":"alpha"},{"n":"beta"},{"n":"gamma"}]',
			output: "json",
		},
		{
			id: "shout",
			type: "map",
			over: "{steps.list.json}",
			as: "item",
			agent: "scout",
			task: "Reply with ONLY the uppercase of this word, nothing else: {item.n}",
			dependsOn: ["list"],
		},
		{
			id: "join",
			type: "reduce",
			from: ["shout"],
			agent: "scout",
			task: "These are some words:\n{steps.shout.output}\n\nReply with ONLY a comma-separated list of the uppercase words you see.",
			dependsOn: ["shout"],
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
	console.log("valid ✓");

	const settings = readSubagentSettings();
	const { agents } = discoverAgents(process.cwd(), "user", settings.agentOverrides);
	console.log(`discovered ${agents.length} agents; has scout: ${agents.some((a) => a.name === "scout")}`);

	const state: RunState = {
		runId: "e2e-test",
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
		onProgress: (s) => {
			const done = Object.values(s.phases).filter((p) => p.status === "done").length;
			const running = Object.values(s.phases)
				.filter((p) => p.status === "running")
				.map((p) => p.id);
			process.stdout.write(`\r  progress: ${done}/${s.def.phases.length} done` + (running.length ? ` | running: ${running.join(",")}` : "") + "        ");
		},
	});
	console.log(`\n== done in ${((Date.now() - t0) / 1000).toFixed(1)}s ==`);

	console.log("\nPhase states:");
	for (const p of FLOW.phases) {
		const ps = res.state.phases[p.id];
		console.log(`  ${ps?.status === "done" ? "✓" : "✗"} ${p.id} [${p.type}] -> ${JSON.stringify(ps?.output?.slice(0, 80))}`);
	}

	console.log("\nFinal output:\n  ", res.finalOutput);

	// Assertions
	const checks: Array<[string, boolean]> = [
		["overall ok", res.ok],
		["list phase done", res.state.phases.list?.status === "done"],
		["map produced 3 sub-results", (res.state.phases.shout?.output?.match(/\[\d+\/3\]/g) ?? []).length === 3],
		["final mentions ALPHA", /ALPHA/i.test(res.finalOutput)],
		["final mentions BETA", /BETA/i.test(res.finalOutput)],
		["final mentions GAMMA", /GAMMA/i.test(res.finalOutput)],
	];
	console.log("\n== assertions ==");
	let allPass = true;
	for (const [name, ok] of checks) {
		console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
		if (!ok) allPass = false;
	}
	console.log(allPass ? "\n✅ E2E PASSED" : "\n❌ E2E FAILED");
	process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
