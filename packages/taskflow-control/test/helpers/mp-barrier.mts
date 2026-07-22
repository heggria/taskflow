/**
 * Shared start barrier for multi-process race tests.
 *
 * Child: write ready-${id}, spin until start exists, then return.
 * Parent: wait for N ready files, then write start.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function childAwaitStart(barrierDir: string, id: string, timeoutMs = 15_000): void {
	fs.mkdirSync(barrierDir, { recursive: true });
	const readyPath = path.join(barrierDir, `ready-${id}`);
	const startPath = path.join(barrierDir, "start");
	fs.writeFileSync(readyPath, String(process.pid));
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(startPath)) {
		if (Date.now() > deadline) {
			throw new Error(`barrier timeout waiting for start (id=${id}, dir=${barrierDir})`);
		}
		// tight spin so children stay synchronized once start drops
		const until = Date.now() + 1;
		while (Date.now() < until) {
			/* spin */
		}
	}
}

export function parentReleaseStart(barrierDir: string, expectedReady: number, timeoutMs = 15_000): void {
	fs.mkdirSync(barrierDir, { recursive: true });
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const ready = fs.readdirSync(barrierDir).filter((f) => f.startsWith("ready-"));
		if (ready.length >= expectedReady) break;
		if (Date.now() > deadline) {
			throw new Error(
				`barrier timeout waiting for ${expectedReady} ready files (got ${ready.length})`,
			);
		}
		const until = Date.now() + 2;
		while (Date.now() < until) {
			/* spin */
		}
	}
	// Drop the start gate — all children should be parked on ready and will collide.
	fs.writeFileSync(path.join(barrierDir, "start"), String(Date.now()));
}
