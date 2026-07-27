/**
 * Multi-process exclusive-lock contender (P13 reclaim race).
 *
 * After the start barrier, contend for lockPath with short stale/abandon
 * windows. Inside the critical section, register a holder marker and record
 * the observed concurrent holder count so the parent can prove peak === 1 and
 * that this contender entered.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { withExclusiveLockFile } from "../../src/paths.ts";
import { childAwaitStart } from "./mp-barrier.mts";

const lockPath = process.argv[2];
const workDir = process.argv[3];
if (!lockPath || !workDir) {
	console.error("usage: mp-p13-exclusive-lock.mts <lockPath> <workDir>");
	process.exit(2);
}

const barrier = process.env.TF_MP_BARRIER;
const id = process.env.TF_MP_ID ?? String(process.pid);
if (barrier) childAwaitStart(barrier, id);

const holdersDir = path.join(workDir, "holders");
const resultsPath = path.join(workDir, "results.jsonl");
fs.mkdirSync(holdersDir, { recursive: true });

const staleMs = Number(process.env.TF_EXCL_STALE_MS ?? "50");
const abandonIncompleteMs = Number(process.env.TF_EXCL_ABANDON_MS ?? "50");
const holdMs = Number(process.env.TF_EXCL_HOLD_MS ?? "120");
const maxAttempts = Number(process.env.TF_EXCL_MAX_ATTEMPTS ?? "800");
const timeoutMs = Number(process.env.TF_EXCL_TIMEOUT_MS ?? "45000");

let maxConcurrent = 0;
let entered = false;

try {
	withExclusiveLockFile(
		lockPath,
		() => {
			entered = true;
			const marker = path.join(holdersDir, `${process.pid}`);
			fs.writeFileSync(marker, String(Date.now()));
			// Sample concurrency while holding long enough for peers to collide.
			const deadline = Date.now() + holdMs;
			const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
			while (Date.now() < deadline) {
				const n = fs.readdirSync(holdersDir).length;
				if (n > maxConcurrent) maxConcurrent = n;
				Atomics.wait(signal, 0, 0, 2);
			}
			const n = fs.readdirSync(holdersDir).length;
			if (n > maxConcurrent) maxConcurrent = n;
			try {
				fs.unlinkSync(marker);
			} catch {
				/* ignore */
			}
		},
		{ maxAttempts, timeoutMs, staleMs, abandonIncompleteMs },
	);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	const line = { pid: process.pid, ok: false, entered, maxConcurrent, error: message };
	fs.appendFileSync(resultsPath, `${JSON.stringify(line)}\n`);
	process.stdout.write(JSON.stringify(line));
	process.exit(1);
}

const line = { pid: process.pid, ok: true, entered, maxConcurrent };
fs.appendFileSync(resultsPath, `${JSON.stringify(line)}\n`);
process.stdout.write(JSON.stringify(line));
