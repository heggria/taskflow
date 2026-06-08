/**
 * Cross-run memoization: fingerprint resolver + persistent phase-result cache.
 *
 * See docs/rfc-cross-run-memoization.md. The cache lets a phase reuse the result
 * of an identical-input phase from ANY prior run (scope: "cross-run"), for $0.00.
 * Freshness is guarded by:
 *   - the existing content-addressed inputHash (declared inputs)
 *   - optional `fingerprint` entries folded into the key (git/glob/file/env)
 *   - optional TTL
 *   - default `run-only` scope (this module is only consulted for cross-run)
 *
 * Zero runtime dependencies: Node built-ins only (fs.globSync requires Node >=22,
 * which the project already targets).
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { cacheDir, hashInput, withLock, writeFileAtomic } from "./store.ts";

// ---------------------------------------------------------------------------
// Fingerprint resolution
// ---------------------------------------------------------------------------

/** Per-file byte cap when content-hashing (mirrors store/context limits). */
const FINGERPRINT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
/** Cap on glob match count folded into a single fingerprint (defensive). */
const FINGERPRINT_MAX_GLOB_MATCHES = 5000;

/**
 * Resolve a single fingerprint entry to a deterministic string. Never throws:
 * missing files / non-git repos / unreadable paths resolve to a stable sentinel
 * so the key stays deterministic (and a later appearance of the resource simply
 * changes the key → cache miss, which is the safe direction).
 */
function resolveOne(entry: string, cwd: string): string {
	try {
		if (entry === "git:HEAD" || entry.startsWith("git:")) {
			const ref = entry.slice("git:".length) || "HEAD";
			try {
				const sha = execFileSync("git", ["rev-parse", ref], {
					cwd,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				return `git:${ref}=${sha}`;
			} catch {
				return `git:${ref}=<no-git>`;
			}
		}

		if (entry.startsWith("glob:") || entry.startsWith("glob!:")) {
			const contentMode = entry.startsWith("glob!:");
			const pattern = entry.slice(contentMode ? "glob!:".length : "glob:".length);
			let matches: string[];
			try {
				// fs.globSync (Node >=22) — cwd-relative, returns posix-ish paths.
				matches = (fs.globSync(pattern, { cwd }) as string[]).slice().sort();
			} catch {
				return `${entry}=<glob-error>`;
			}
			if (matches.length > FINGERPRINT_MAX_GLOB_MATCHES) {
				matches = matches.slice(0, FINGERPRINT_MAX_GLOB_MATCHES);
			}
			const parts: string[] = [];
			for (const rel of matches) {
				const abs = path.resolve(cwd, rel);
				try {
					if (contentMode) {
						const st = fs.statSync(abs);
						if (st.isFile() && st.size <= FINGERPRINT_MAX_FILE_BYTES) {
							const buf = fs.readFileSync(abs);
							parts.push(`${rel}:${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)}`);
						} else {
							parts.push(`${rel}:<skip>`);
						}
					} else {
						const st = fs.statSync(abs);
						parts.push(`${rel}:${st.size}:${Math.floor(st.mtimeMs)}`);
					}
				} catch {
					parts.push(`${rel}:<stat-error>`);
				}
			}
			const digest = crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
			return `${entry}=${digest}`;
		}

		if (entry.startsWith("file:")) {
			const rel = entry.slice("file:".length);
			const abs = path.resolve(cwd, rel);
			try {
				const st = fs.statSync(abs);
				if (!st.isFile() || st.size > FINGERPRINT_MAX_FILE_BYTES) return `file:${rel}=<skip>`;
				const buf = fs.readFileSync(abs);
				return `file:${rel}=${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)}`;
			} catch {
				return `file:${rel}=<missing>`;
			}
		}

		if (entry.startsWith("env:")) {
			const name = entry.slice("env:".length);
			return `env:${name}=${process.env[name] ?? ""}`;
		}
	} catch {
		// Fall through to sentinel below.
	}
	// Unknown prefixes are rejected at validation time; defensively encode.
	return `${entry}=<unknown>`;
}

/**
 * Resolve a phase's `fingerprint` list into a single deterministic string to be
 * folded into the cache key. Returns "" when there are no entries (so the key is
 * unchanged for phases that declare no fingerprint).
 */
export function resolveFingerprint(entries: string[] | undefined, cwd: string): string {
	if (!entries || entries.length === 0) return "";
	// Preserve author order (it's part of the declared key) but resolve each.
	const resolved = entries.map((e) => resolveOne(e, cwd));
	return crypto.createHash("sha256").update(resolved.join("\u0000")).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Cross-run cache store
// ---------------------------------------------------------------------------

export interface CacheEntry {
	/** The full cache key (== phase inputHash incl. fingerprint). */
	key: string;
	createdAt: number;
	/** Trimmed phase result surface that downstream phases consume. */
	output?: string;
	json?: unknown;
	model?: string;
	/** Provenance for audit / cleanup. */
	flowName?: string;
	phaseId?: string;
	runId?: string;
}

/** Keep at most this many cache entries; LRU-ish eviction by createdAt. */
const DEFAULT_MAX_ENTRIES = 1000;
/** Drop entries older than this regardless of TTL (hard backstop). */
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** A cache key is a 16-hex inputHash; constrain to that to prevent traversal. */
function isValidKey(key: string): boolean {
	return /^[0-9a-f]{8,64}$/.test(key);
}

function entryPath(dir: string, key: string): string {
	return path.join(dir, `${key}.json`);
}

/**
 * The cross-run cache, scoped to a working directory. Cheap to construct; all IO
 * is lazy and failure-tolerant (a broken cache must never break a run).
 */
export class CacheStore {
	private dir: string;

	constructor(cwd: string) {
		this.dir = cacheDir(cwd);
	}

	/** Look up a fresh entry. Returns null on miss, malformed key, or TTL expiry. */
	get(key: string, ttlMs?: number): CacheEntry | null {
		if (!isValidKey(key)) return null;
		let entry: CacheEntry;
		try {
			const raw = fs.readFileSync(entryPath(this.dir, key), "utf-8");
			entry = JSON.parse(raw) as CacheEntry;
		} catch {
			return null;
		}
		if (typeof entry?.createdAt !== "number") return null;
		const age = Date.now() - entry.createdAt;
		if (age > DEFAULT_MAX_AGE_MS) return null;
		if (ttlMs !== undefined && age > ttlMs) return null;
		return entry;
	}

	/** Store an entry (best-effort; never throws into the run). */
	put(entry: CacheEntry): void {
		if (!isValidKey(entry.key)) return;
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			const lock = path.join(this.dir, `${entry.key}.json.lock`);
			withLock(lock, () => {
				writeFileAtomic(entryPath(this.dir, entry.key), JSON.stringify(entry, null, 2));
			});
			this.cleanup();
		} catch {
			/* cache write failures are non-fatal */
		}
	}

	/** Remove all cache entries. Returns the number removed. */
	clear(): number {
		let n = 0;
		try {
			for (const f of fs.readdirSync(this.dir)) {
				if (f.endsWith(".json")) {
					try {
						fs.unlinkSync(path.join(this.dir, f));
						n++;
					} catch {
						/* ignore */
					}
				}
			}
		} catch {
			/* no dir → nothing to clear */
		}
		return n;
	}

	/** Opportunistic eviction: drop expired/oversized entries. Best-effort. */
	private cleanup(): void {
		let files: string[];
		try {
			files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
		} catch {
			return;
		}
		const now = Date.now();
		const live: Array<{ file: string; createdAt: number }> = [];
		for (const f of files) {
			const abs = path.join(this.dir, f);
			try {
				const e = JSON.parse(fs.readFileSync(abs, "utf-8")) as CacheEntry;
				if (typeof e?.createdAt !== "number" || now - e.createdAt > DEFAULT_MAX_AGE_MS) {
					fs.unlinkSync(abs);
					continue;
				}
				live.push({ file: abs, createdAt: e.createdAt });
			} catch {
				try {
					fs.unlinkSync(abs);
				} catch {
					/* ignore */
				}
			}
		}
		if (live.length > DEFAULT_MAX_ENTRIES) {
			live.sort((a, b) => a.createdAt - b.createdAt); // oldest first
			for (const victim of live.slice(0, live.length - DEFAULT_MAX_ENTRIES)) {
				try {
					fs.unlinkSync(victim.file);
				} catch {
					/* ignore */
				}
			}
		}
	}
}

/** Convenience: compute a cross-run cache key from base parts + fingerprint. */
export function cacheKeyWithFingerprint(baseParts: string[], fingerprint: string): string {
	return fingerprint ? hashInput(...baseParts, fingerprint) : hashInput(...baseParts);
}
