/**
 * Shared start barrier for multi-process race tests.
 *
 * Child: durably write ready-${id}, wait until start exists, then return.
 * Parent: wait for N ready files, then atomically publish start.
 *
 * Uses Atomics.wait to yield the CPU (avoids pure busy-spin starving peer
 * processes on small core counts) and fsync/rename so ready/start are visible
 * across processes without relying on opportunistic readdir caching.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const YIELD_SLOT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** Yield the OS scheduler briefly without inventing a pass condition. */
function yieldBriefly(ms: number): void {
	Atomics.wait(YIELD_SLOT, 0, 0, Math.max(1, ms));
}

function writeFileDurable(filePath: string, body: string): void {
	const fd = fs.openSync(filePath, "w");
	try {
		fs.writeFileSync(fd, body);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.fsyncSync(fs.openSync(path.dirname(filePath), "r"));
	} catch {
		/* directory fsync is best-effort on some platforms */
	}
}

export function childAwaitStart(barrierDir: string, id: string, timeoutMs = 30_000): void {
	fs.mkdirSync(barrierDir, { recursive: true });
	const readyPath = path.join(barrierDir, `ready-${id}`);
	const startPath = path.join(barrierDir, "start");
	writeFileDurable(readyPath, String(process.pid));
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(startPath)) {
		if (Date.now() > deadline) {
			throw new Error(`barrier timeout waiting for start (id=${id}, dir=${barrierDir})`);
		}
		yieldBriefly(2);
	}
}

export function parentReleaseStart(barrierDir: string, expectedReady: number, timeoutMs = 30_000): void {
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
		yieldBriefly(2);
	}
	// Atomic publish of the start gate so children never observe a partial file.
	const startPath = path.join(barrierDir, "start");
	const tmp = path.join(barrierDir, `.start.${process.pid}.${Date.now()}.tmp`);
	writeFileDurable(tmp, String(Date.now()));
	fs.renameSync(tmp, startPath);
	try {
		const dirFd = fs.openSync(barrierDir, "r");
		try {
			fs.fsyncSync(dirFd);
		} finally {
			fs.closeSync(dirFd);
		}
	} catch {
		/* directory fsync best-effort */
	}
}

/** Wait until every child has recorded a post-start milestone. */
export function parentWaitForFiles(
	barrierDir: string,
	prefix: string,
	expected: number,
	timeoutMs = 30_000,
): void {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const count = fs.readdirSync(barrierDir).filter((f) => f.startsWith(prefix)).length;
		if (count >= expected) return;
		if (Date.now() > deadline) {
			throw new Error(
				`barrier timeout waiting for ${expected} ${prefix} files (got ${count})`,
			);
		}
		yieldBriefly(2);
	}
}
