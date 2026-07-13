import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	executeTaskflow,
	type AgentConfig,
	type RunResult,
	type RunState,
	type Taskflow,
} from "taskflow-core";
import { createPiSubagentRunner } from "../src/runner.ts";

test("Pi terminal reap: a leaky phase is completed and the next phase actually runs", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-pi-two-phase-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	const counter = path.join(dir, "count.txt");
	fs.writeFileSync(
		fakePi,
		`#!${process.execPath}\n` +
			`import fs from "node:fs";\n` +
			`const file=process.env.TASKFLOW_TEST_PI_COUNT;\n` +
			`const n=(fs.existsSync(file)?Number(fs.readFileSync(file,"utf8")):0)+1; fs.writeFileSync(file,String(n));\n` +
			`const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n");\n` +
			`emit({type:"agent_start"}); emit({type:"turn_start"});\n` +
			`emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"PHASE_"+n+"_DONE"}],stopReason:"stop"}});\n` +
			`emit({type:"agent_end"}); emit({type:"agent_settled"});\n` +
			`setInterval(()=>{},1000);\n`,
	);
	fs.chmodSync(fakePi, 0o755);
	const previousBin = process.env.PI_TASKFLOW_PI_BIN;
	const previousCounter = process.env.TASKFLOW_TEST_PI_COUNT;
	process.env.PI_TASKFLOW_PI_BIN = fakePi;
	process.env.TASKFLOW_TEST_PI_COUNT = counter;
	try {
		const def: Taskflow = {
			name: "terminal-reap-two-phase",
			phases: [
				{ id: "phase-one", type: "agent", agent: "executor", task: "one" },
				{ id: "phase-two", type: "agent", agent: "executor", task: "two", dependsOn: ["phase-one"], final: true },
			],
		};
		const state: RunState = {
			runId: "terminal-reap-two-phase-run",
			flowName: def.name,
			def,
			args: {},
			status: "running",
			phases: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: dir,
		};
		const agents: AgentConfig[] = [
			{ name: "executor", description: "test", systemPrompt: "", source: "user", filePath: "" },
		];
		const base = createPiSubagentRunner({
			resourceProfile: "isolated",
			extensions: [],
			terminalGraceMs: 25,
		});
		const calls: RunResult[] = [];
		const result = await executeTaskflow(state, {
			cwd: dir,
			agents,
			runTask: async (...args) => {
				const call = await base.runTask(...args);
				calls.push(call);
				return call;
			},
		});

		assert.equal(result.ok, true);
		assert.equal(fs.readFileSync(counter, "utf-8"), "2", "phase two must spawn after phase one is reaped");
		assert.match(result.finalOutput, /PHASE_2_DONE/);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].completionSource, "terminal-reap");
		assert.equal(calls[1].completionSource, "terminal-reap");
	} finally {
		if (previousBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = previousBin;
		if (previousCounter === undefined) delete process.env.TASKFLOW_TEST_PI_COUNT;
		else process.env.TASKFLOW_TEST_PI_COUNT = previousCounter;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
