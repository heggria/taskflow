import * as fs from "node:fs";

const MAX_ATTEMPTS = 51;
const RETRY_DELAY_MS = 10;
const RETRY_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface AtomicRenameOptions {
	platform?: NodeJS.Platform;
	maxAttempts?: number;
	renameSync?: typeof fs.renameSync;
	sleep?: (milliseconds: number) => void;
}

/**
 * Replace a file atomically, retrying only transient Windows sharing violations.
 * The hard attempt cap keeps the synchronous loop bounded even if wall time moves
 * backward or is frozen.
 */
export function renameAtomicWithRetry(
	tmp: string,
	filePath: string,
	options: AtomicRenameOptions = {},
): void {
	const platform = options.platform ?? process.platform;
	const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
		throw new RangeError(`maxAttempts must be an integer from 1 to ${MAX_ATTEMPTS}`);
	}
	const renameSync = options.renameSync ?? fs.renameSync;
	const sleep = options.sleep ?? ((milliseconds: number) => {
		Atomics.wait(RETRY_WAIT_BUFFER, 0, 0, milliseconds);
	});

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			renameSync(tmp, filePath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (
				platform !== "win32" || !code ||
				!WINDOWS_TRANSIENT_RENAME_CODES.has(code) || attempt === maxAttempts
			) throw error;
			sleep(RETRY_DELAY_MS);
		}
	}
}
