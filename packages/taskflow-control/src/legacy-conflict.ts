/**
 * P9 / D20: detect concurrent 0.2-style writers vs 0.3 ControlStore.
 *
 * When 0.2 flow-run storage is actively written while 0.3 control is open,
 * 0.3 stops new Attempts (legacy-conflict). Cannot kill foreign 0.2 writers.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ControlError } from "./types.ts";

/** 0.2 engine run index / store markers under project or agent dir. */
const LEGACY_MARKERS = [
	// Project-local 0.2-ish run dirs (best-effort)
	".taskflow/runs",
	".pi/taskflows/runs",
] as const;

export type LegacyProbe =
	| { conflict: false }
	| {
			conflict: true;
			reason: string;
			marker: string;
			/** mtime of the legacy activity evidence */
			mtimeMs: number;
	  };

/**
 * Probe for recent 0.2-style activity that should block new 0.3 admits.
 * @param recentMs — only treat as conflict if marker touched within this window (default 5 min)
 */
export function probeLegacyConflict(
	projectRoot: string,
	opts?: { recentMs?: number; now?: number },
): LegacyProbe {
	const recentMs = opts?.recentMs ?? 5 * 60_000;
	const now = opts?.now ?? Date.now();
	const root = path.resolve(projectRoot);

	for (const rel of LEGACY_MARKERS) {
		const p = path.join(root, rel);
		try {
			if (!fs.existsSync(p)) continue;
			const st = fs.statSync(p);
			// Directory with any nested write activity
			let mtimeMs = st.mtimeMs;
			if (st.isDirectory()) {
				try {
					const kids = fs.readdirSync(p);
					for (const k of kids.slice(0, 50)) {
						try {
							const ks = fs.statSync(path.join(p, k));
							if (ks.mtimeMs > mtimeMs) mtimeMs = ks.mtimeMs;
						} catch {
							/* ignore */
						}
					}
				} catch {
					/* ignore */
				}
			}
			if (now - mtimeMs <= recentMs) {
				return {
					conflict: true,
					reason: `legacy 0.2-style store activity at ${rel} (mtime within ${recentMs}ms)`,
					marker: rel,
					mtimeMs,
				};
			}
		} catch {
			/* missing / permission — not a conflict */
		}
	}
	return { conflict: false };
}

export function legacyConflictError(probe: Extract<LegacyProbe, { conflict: true }>): ControlError {
	return {
		code: "TF_LEGACY_CONFLICT",
		message: `TF_LEGACY_CONFLICT: ${probe.reason}. 0.3 ControlHost refuses new Attempts while 0.2 writers may be active (P9/D20).`,
		recoveryAction: "operator",
		sideEffects: "possible",
	};
}
