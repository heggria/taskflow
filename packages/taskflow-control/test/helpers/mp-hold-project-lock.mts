import * as fs from "node:fs";
import * as path from "node:path";
import { projectControlRoot, withExclusiveLockFile } from "../../src/index.ts";

const [projectRoot, readyPath, holdMsRaw] = process.argv.slice(2);
if (!projectRoot || !readyPath) {
	throw new Error("usage: mp-hold-project-lock.mts <projectRoot> <readyPath> [holdMs]");
}
const holdMs = Number(holdMsRaw ?? "500");
const lockPath = path.join(projectControlRoot(projectRoot), "commit.lock");

withExclusiveLockFile(lockPath, () => {
	fs.writeFileSync(readyPath, "ready", "utf-8");
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
});
