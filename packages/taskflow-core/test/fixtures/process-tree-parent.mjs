import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const grandchild = new URL("./process-tree-grandchild.mjs", import.meta.url);
const child = spawn(process.execPath, [fileURLToPath(grandchild)], { stdio: "inherit" });
child.unref();
process.stdout.write(`${JSON.stringify({ done: true })}\n`);
