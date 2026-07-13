import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const [mode, marker, ready] = process.argv.slice(2);
if ((mode !== "agent" && mode !== "script" && mode !== "terminal") || !marker) process.exit(2);
if (mode !== "terminal" && !ready) process.exit(2);

const descendant = fileURLToPath(new URL("./process-supervisor-descendant.mjs", import.meta.url));
spawn(process.execPath, [descendant, marker], { stdio: "inherit" });
if (ready) fs.writeFileSync(ready, "ready");

if (mode === "agent") process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
else if (mode === "script") process.stdout.write("ready");
else {
	process.stdout.write(`${JSON.stringify({ type: "final", text: "DONE" })}\n`);
	process.stdout.write(`${JSON.stringify({ type: "terminal" })}\n`);
}

setInterval(() => {}, 1000);
