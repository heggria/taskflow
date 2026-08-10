import { runSubagentProcess } from "../../src/runner-core.ts";
import { runScriptCommand } from "../../src/runtime/phases/script.ts";

const [mode, marker, ready] = process.argv.slice(2);
if ((mode !== "agent" && mode !== "script") || !marker || !ready) process.exit(2);

const descendant = `
	setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 500);
	setInterval(() => {}, 1000);
`;
const child = `
	const { spawn } = require("node:child_process");
	spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" });
	require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready");
	${mode === "agent" ? "process.stdout.write(JSON.stringify({ready:true})+'\\n');" : "process.stdout.write('ready');"}
	setInterval(() => {}, 1000);
`;

if (mode === "agent") {
	void runSubagentProcess({
		agent: "fixture",
		task: "external-signal",
		bin: process.execPath,
		args: ["-e", child],
		cwd: process.cwd(),
		idleTimeoutMs: 60_000,
		acc: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, finalText: "", lastActivity: "" },
		foldLine(acc, line) {
			JSON.parse(line);
			acc.finalText = line;
			return null;
		},
	});
} else {
	void runScriptCommand({
		interpRunText: [process.execPath, "-e", child],
		arrayForm: true,
		cwd: process.cwd(),
		timeoutMs: 60_000,
	});
}

// Keep the Host alive independently of the operation Promise so the parent
// test can deliver TERM/INT/HUP only after the descendant has started.
setInterval(() => {}, 1000);
