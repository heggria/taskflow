import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const grandchild = fileURLToPath(new URL("./process-tree-abort-grandchild.mjs", import.meta.url));
const child = spawn(process.execPath, [grandchild], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", () => process.stdout.write(`${JSON.stringify({ spawned: true })}\n`));
setInterval(() => {}, 1000);
