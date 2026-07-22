/**
 * P11: compaction cursor + minAvailableCommitSeq.
 * commitSeq is never renumbered. Cursors below minAvailable → TF_CURSOR_EXPIRED.
 * Missing blobs after retention → artifactIntegrity unknown (caller policy).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	projectControlRoot,
	projectJournalDir,
	readJsonFile,
	writeFileAtomic,
	ensureDir,
} from "./paths.ts";
import type { ControlError } from "./types.ts";

export interface CompactionState {
	/** Lowest commitSeq still available in journal (inclusive). Never renumbered. */
	minAvailableCommitSeq: number;
	/** Highest commitSeq observed. */
	maxCommitSeq: number;
	/** Optional retention watermark (ms epoch) — segments older may be eligible. */
	retainedBeforeMs?: number;
	updatedAt: number;
}

export type CursorCheck =
	| { ok: true; cursor: number; minAvailableCommitSeq: number }
	| { ok: false; error: ControlError };

function statePath(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "compaction.json");
}

export function loadCompactionState(projectRoot: string): CompactionState {
	const existing = readJsonFile<CompactionState>(statePath(projectRoot));
	if (existing && typeof existing.minAvailableCommitSeq === "number") {
		return existing;
	}
	return {
		minAvailableCommitSeq: 1,
		maxCommitSeq: 0,
		updatedAt: Date.now(),
	};
}

export function saveCompactionState(projectRoot: string, state: CompactionState): void {
	ensureDir(projectControlRoot(projectRoot));
	writeFileAtomic(
		statePath(projectRoot),
		JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2),
	);
}

/**
 * Advance maxCommitSeq after a successful commit (monotonic only).
 * Never renumbers or decreases minAvailableCommitSeq here.
 */
export function noteCommitSeq(projectRoot: string, commitSeqEnd: number): CompactionState {
	const s = loadCompactionState(projectRoot);
	if (commitSeqEnd > s.maxCommitSeq) {
		s.maxCommitSeq = commitSeqEnd;
		saveCompactionState(projectRoot, s);
	}
	return s;
}

/**
 * Raise minAvailableCommitSeq after safe compaction of [1, throughSeq].
 * Must not exceed maxCommitSeq; must never decrease.
 */
export function advanceMinAvailable(
	projectRoot: string,
	throughSeq: number,
): CompactionState | { error: string } {
	const s = loadCompactionState(projectRoot);
	if (throughSeq < s.minAvailableCommitSeq - 1) {
		return { error: "throughSeq below already-compacted range" };
	}
	if (throughSeq > s.maxCommitSeq) {
		return { error: "cannot compact past maxCommitSeq" };
	}
	const nextMin = throughSeq + 1;
	if (nextMin < s.minAvailableCommitSeq) {
		return { error: "minAvailableCommitSeq cannot decrease (commitSeq never renumbered)" };
	}
	s.minAvailableCommitSeq = nextMin;
	saveCompactionState(projectRoot, s);
	return s;
}

/** Cursor validity: client cursor must be >= minAvailableCommitSeq. */
export function checkCursor(projectRoot: string, cursor: number): CursorCheck {
	const s = loadCompactionState(projectRoot);
	if (!Number.isFinite(cursor) || cursor < 1) {
		return {
			ok: false,
			error: {
				code: "TF_INVALID_ARGUMENT",
				message: `invalid cursor ${cursor}`,
				recoveryAction: "refresh",
				sideEffects: "none",
			},
		};
	}
	if (cursor < s.minAvailableCommitSeq) {
		return {
			ok: false,
			error: {
				code: "TF_CURSOR_EXPIRED",
				message: `cursor ${cursor} < minAvailableCommitSeq ${s.minAvailableCommitSeq}; resync from checkpoint`,
				recoveryAction: "refresh",
				sideEffects: "none",
			},
		};
	}
	return { ok: true, cursor, minAvailableCommitSeq: s.minAvailableCommitSeq };
}

/**
 * Best-effort remove journal segments fully below minAvailable (after advance).
 * Does not renumber commitSeq inside remaining segments.
 */
export function deleteCompactedJournalFiles(projectRoot: string): { removed: number } {
	const s = loadCompactionState(projectRoot);
	const dir = projectJournalDir(projectRoot);
	let removed = 0;
	if (!fs.existsSync(dir)) return { removed };
	for (const f of fs.readdirSync(dir)) {
		// filenames: 000000000001-000000000003.json
		const m = /^(\d+)-(\d+)\.json$/.exec(f);
		if (!m) continue;
		const end = Number(m[2]);
		if (end < s.minAvailableCommitSeq) {
			try {
				fs.unlinkSync(path.join(dir, f));
				removed += 1;
			} catch {
				/* ignore */
			}
		}
	}
	return { removed };
}

// ---------------------------------------------------------------------------
// P10 rollback tiers (pure policy)
// ---------------------------------------------------------------------------

export type RollbackTier = "full" | "read-only-export" | "lossy-export" | "forbidden";

/**
 * Before any 0.3 ControlStore write → full rollback possible.
 * After 0.3 writes → export only (no execute promise). DomainTransfer never a rollback.
 */
export function rollbackTier(opts: {
	/** True if this project already has any 0.3 journal commit. */
	hasControlStoreWrites: boolean;
	/** Explicit operator request for DomainTransfer-as-rollback — always forbidden. */
	domainTransferAsRollback?: boolean;
}): { tier: RollbackTier; reason: string } {
	if (opts.domainTransferAsRollback) {
		return {
			tier: "forbidden",
			reason: "DomainTransfer is not a rollback mechanism (P10/D20)",
		};
	}
	if (!opts.hasControlStoreWrites) {
		return {
			tier: "full",
			reason: "no 0.3 ControlStore writes yet; full rollback possible",
		};
	}
	return {
		tier: "read-only-export",
		reason: "0.3 journal exists; only read-only/lossy export without execute promise",
	};
}

export function hasControlStoreWrites(projectRoot: string): boolean {
	const dir = projectJournalDir(projectRoot);
	if (!fs.existsSync(dir)) return false;
	return fs.readdirSync(dir).some((f) => f.endsWith(".json"));
}
