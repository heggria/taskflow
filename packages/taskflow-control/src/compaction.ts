/**
 * P11: journal-bound cursor horizon + minAvailableCommitSeq.
 * commitSeq is never renumbered. Cursors below minAvailable → TF_CURSOR_EXPIRED.
 * A checkpoint is authoritative only when it is a validated journal event;
 * physical segment deletion remains separately disabled until the P14 handoff
 * protocol exists. Missing blobs after retention → artifactIntegrity unknown.
 */
import * as fs from "node:fs";
import {
	ControlStoreDurabilityError,
	projectControlRoot,
	projectControlRootAnchorPath,
	projectJournalDir,
} from "./paths.ts";
import { openProjectControlStore } from "./store/project-store.ts";
import type { ControlCompactionState, ControlError } from "./types.ts";

/** Back-compat name for the journal-derived cursor state. */
export type CompactionState = ControlCompactionState;

export type CursorCheck =
	| { ok: true; cursor: number; minAvailableCommitSeq: number }
	| { ok: false; error: ControlError };

export function loadCompactionState(projectRoot: string): CompactionState {
	// A never-opened project has no durable cursor state yet. Once the control
	// root exists, however, reader mode must validate the complete journal and
	// derived state rather than treating a damaged store as an empty one.
	const controlRoot = projectControlRoot(projectRoot);
	if (!fs.existsSync(controlRoot)) {
		if (fs.existsSync(projectControlRootAnchorPath(projectRoot))) {
			throw new ControlStoreDurabilityError(
				"project-root identity anchor exists but the ControlStore subtree is missing",
				controlRoot,
			);
		}
		return {
			minAvailableCommitSeq: 1,
			maxCommitSeq: 0,
			updatedAt: 0,
		};
	}
	return openProjectControlStore(projectRoot, { readOnly: true }).getCompactionState();
}

/**
 * Legacy API retained as a safe compatibility guard. The old implementation
 * wrote a loose `compaction.json`; that file could be deleted to resurrect an
 * expired cursor. A caller can now only persist a monotonic checkpoint through
 * the journal, and the journal tail is never caller-supplied.
 */
export function saveCompactionState(projectRoot: string, state: CompactionState): void {
	const current = loadCompactionState(projectRoot);
	if (state.maxCommitSeq !== current.maxCommitSeq) {
		throw new ControlStoreDurabilityError(
			"compaction maxCommitSeq is journal-derived and cannot be caller-written",
			projectControlRoot(projectRoot),
		);
	}
	const throughSeq = state.minAvailableCommitSeq - 1;
	const currentThroughSeq = current.minAvailableCommitSeq - 1;
	if (throughSeq < currentThroughSeq) {
		throw new ControlStoreDurabilityError(
			"compaction minAvailableCommitSeq cannot decrease",
			projectControlRoot(projectRoot),
		);
	}
	if (throughSeq === currentThroughSeq) return;
	const advanced = advanceMinAvailable(projectRoot, throughSeq);
	if ("error" in advanced) {
		throw new ControlStoreDurabilityError(advanced.error, projectControlRoot(projectRoot));
	}
}

/**
 * Advance maxCommitSeq after a successful commit (monotonic only).
 * Never renumbers or decreases minAvailableCommitSeq here.
 */
export function noteCommitSeq(projectRoot: string, commitSeqEnd: number): CompactionState {
	const state = loadCompactionState(projectRoot);
	if (!Number.isSafeInteger(commitSeqEnd) || commitSeqEnd < 0 || commitSeqEnd !== state.maxCommitSeq) {
		throw new ControlStoreDurabilityError(
			`commitSeq ${commitSeqEnd} does not match the journal-derived tail ${state.maxCommitSeq}`,
			projectControlRoot(projectRoot),
		);
	}
	return state;
}

/**
 * Raise minAvailableCommitSeq after safe compaction of [1, throughSeq].
 * Must not exceed maxCommitSeq; must never decrease.
 */
export function advanceMinAvailable(
	projectRoot: string,
	throughSeq: number,
): CompactionState | { error: string } {
	return openProjectControlStore(projectRoot).advanceCompactionCursor(throughSeq);
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
 * Physical journal deletion is disabled until a durable, journal-bound
 * compaction checkpoint can prove the retained prefix and hash-chain handoff.
 * Advancing a cursor is not by itself proof that pathname deletion is safe.
 *
 * Keeping old segments is conservative (and may retain more disk than policy
 * wants), but it avoids silently invalidating the P14 journal anchor.
 */
export function deleteCompactedJournalFiles(projectRoot: string): { removed: number; deferred: number } {
	const s = loadCompactionState(projectRoot);
	const dir = projectJournalDir(projectRoot);
	let deferred = 0;
	if (!fs.existsSync(dir)) return { removed: 0, deferred };
	for (const f of fs.readdirSync(dir)) {
		// filenames: 000000000001-000000000003.json
		const m = /^(\d+)-(\d+)\.json$/.exec(f);
		if (!m) continue;
		const end = Number(m[2]);
		if (end < s.minAvailableCommitSeq) {
			deferred += 1;
		}
	}
	return { removed: 0, deferred };
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
