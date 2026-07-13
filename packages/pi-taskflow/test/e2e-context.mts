/**
 * REAL end-to-end test for the Shared Context Tree.
 *
 * Spawns real `pi` subagent processes and proves the horizontal blackboard +
 * the auto-injected guidance actually make a model USE the ctx_* tools:
 *
 *   - Phase A (writer): given a hard-to-guess token, must ctx_write it under a
 *     known key. The token is random per run, so the reader cannot guess it.
 *   - Phase B (reader): is explicitly forbidden from inventing the token and is
 *     told to ctx_read('handshake') to retrieve it. If B's output contains the
 *     token, the blackboard round-tripped THROUGH A REAL MODEL'S TOOL CALL.
 *
 * Run:  node --experimental-strip-types test/e2e-context.mts
 * Requires network + model access (real `pi`).
 */

import * as crypto from "node:crypto";
import { discoverAgents, readSubagentSettings } from "taskflow-core";
import { executeTaskflow } from "taskflow-core";
import { validateTaskflow, type Taskflow } from "taskflow-core";
import type { RunState } from "taskflow-core";
import { installNoExtPiWrapper } from "./e2e-helpers.mts";
import { piSubagentRunner } from "../src/runner.ts";

// A random token the reader phase cannot possibly guess — it can only obtain it
// from the blackboard via ctx_read.
const CODE = `${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

const FLOW: Taskflow = {
	name: "e2e-context-share",
	concurrency: 1,
	contextSharing: true,
	phases: [
		{
			id: "writer",
			type: "agent",
			agent: "scout",
			task:
				`Use the ctx_write tool to store a value on the shared blackboard so a ` +
				`later step can reuse it. Call ctx_write with key "build-id" and value ` +
				`"${CODE}". After the tool call succeeds, reply with ONLY the word DONE.`,
		},
		{
			id: "reader",
			type: "agent",
			agent: "scout",
			dependsOn: ["writer"],
			task:
				`A previous step stored a value on the shared blackboard under the key ` +
				`"build-id". Use the ctx_read tool with key "build-id" to retrieve it, ` +
				`then reply with ONLY the value you read (nothing else). Do not make up a ` +
				`value — read it from the blackboard.`,
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
	console.log(`valid ✓  (build-id this run: ${CODE})`);

	const settings = readSubagentSettings();
	const { agents } = discoverAgents(process.cwd(), "user", settings.modelRoles, settings.taskflow);
	console.log(`discovered ${agents.length} agents; has scout: ${agents.some((a) => a.name === "scout")}`);

	const state: RunState = {
		runId: `e2e-ctx-${Date.now().toString(36)}`,
		flowName: FLOW.name,
		def: FLOW,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	};

	const restorePiBin = installNoExtPiWrapper("pi-taskflow-e2e-context");
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
				const running = Object.values(s.phases)
					.filter((p) => p.status === "running")
					.map((p) => p.id);
				process.stdout.write(
					`\r  progress: ${done}/${s.def.phases.length} done` +
						(running.length ? ` | running: ${running.join(",")}` : "") +
						"        ",
				);
			},
		});
		console.log(`\n== done in ${((Date.now() - t0) / 1000).toFixed(1)}s ==`);

		console.log("\nPhase states:");
		for (const p of FLOW.phases) {
			const ps = res.state.phases[p.id];
			console.log(`  ${ps?.status === "done" ? "✓" : "✗"} ${p.id} -> ${JSON.stringify(ps?.output?.slice(0, 120))}`);
		}
		console.log("\nFinal output (reader):\n  ", JSON.stringify(res.finalOutput));

		const readerOut = res.state.phases.reader?.output ?? "";
		const checks: Array<[string, boolean]> = [
			["overall ok", res.ok],
			["writer phase done", res.state.phases.writer?.status === "done"],
			["reader phase done", res.state.phases.reader?.status === "done"],
			["reader output contains the value it could only get from the blackboard", readerOut.includes(CODE)],
		];
		console.log("\n== assertions ==");
		let allPass = true;
		for (const [name, ok] of checks) {
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
			if (!ok) allPass = false;
		}
		console.log(allPass ? "\n✅ CONTEXT-SHARE E2E PASSED" : "\n❌ CONTEXT-SHARE E2E FAILED");
		process.exit(allPass ? 0 : 1);
	} finally {
		restorePiBin();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
