/**
 * Strict path/id validation — reject traversal and unsafe characters (P14 security).
 */
export const SAFE_ID_MAX_LENGTH = 128 as const;
export const SAFE_ID_PATTERN = "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" as const;
const SAFE_ID = new RegExp(SAFE_ID_PATTERN);

/** runId, commandId, receiptId, handle-like ids. */
export function isSafeId(id: string): boolean {
	if (typeof id !== "string" || id.length === 0 || id.length > SAFE_ID_MAX_LENGTH) return false;
	if (id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
	return SAFE_ID.test(id);
}

export function assertSafeId(id: string, label: string): void {
	if (!isSafeId(id)) {
		throw new Error(`TF_INVALID_ARGUMENT: unsafe ${label}: ${JSON.stringify(id)}`);
	}
}
