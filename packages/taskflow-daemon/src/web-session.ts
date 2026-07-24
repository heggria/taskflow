/**
 * Ephemeral P17 browser-session authority.
 *
 * Launch/session/CSRF capabilities never touch ControlStore or disk. The
 * single-use launch token is retained only as a keyed digest.
 */
import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DEFAULT_LAUNCH_TTL_MS = 60_000;
const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_ABSOLUTE_TTL_MS = 8 * 60 * 60_000;
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_PENDING_LAUNCH_CAPABILITIES = 8;
const DEFAULT_MAX_REQUESTS = 16;
const DEFAULT_MAX_ANALYSIS = 2;
const DEFAULT_MAX_STREAMS = 4;

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function base32(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let output = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	}
	return output;
}

function equalText(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, "utf8");
	const rightBytes = Buffer.from(right, "utf8");
	return (
		leftBytes.length === rightBytes.length &&
		timingSafeEqual(leftBytes, rightBytes)
	);
}

export type WebSessionRecord = {
	readonly sessionId: string;
	readonly principalId: string;
	readonly principalDisplayName: string;
	readonly csrfToken: string;
	readonly createdAt: number;
	idleExpiresAt: number;
	readonly absoluteExpiresAt: number;
	activeRequests: number;
	activeAnalysisRequests: number;
	activeStreams: number;
	revoked: boolean;
};

export type WebSessionExchange = {
	readonly sessionToken: string;
	readonly session: WebSessionRecord;
	readonly view: {
		csrfToken: string;
		idleExpiresAt: number;
		absoluteExpiresAt: number;
		hostNonce: string;
	};
};

export type WebLaunchCapability = {
	readonly launchToken: string;
	readonly launchExpiresAt: number;
};

export type WebSessionAuthorityOptions = {
	readonly listenerId: string;
	readonly now?: () => number;
	readonly random?: (size: number) => Uint8Array;
	readonly launchTtlMs?: number;
	readonly idleTtlMs?: number;
	readonly absoluteTtlMs?: number;
	readonly maxSessions?: number;
	readonly maxPendingLaunchCapabilities?: number;
	readonly maxRequestsPerSession?: number;
	readonly maxAnalysisPerSession?: number;
	readonly maxStreamsPerSession?: number;
	readonly principalId?: string;
	readonly principalDisplayName?: string;
};

export type WebSessionAuthority = {
	readonly listenerId: string;
	readonly hostNonce: string;
	readonly cookieName: string;
	readonly launchToken: string;
	readonly launchExpiresAt: number;
	mintLaunchCapability(): WebLaunchCapability | null;
	exchange(launchToken: string): WebSessionExchange | null;
	authenticate(sessionToken: string, touch?: boolean): WebSessionRecord | null;
	verifyCsrf(session: WebSessionRecord, csrfToken: string): boolean;
	revoke(sessionToken: string): boolean;
	revokeAll(): number;
	acquireRequest(
		session: WebSessionRecord,
		analysis: boolean,
	): (() => void) | null;
	acquireStream(session: WebSessionRecord): (() => void) | null;
	prune(): number;
	activeSessionCount(): number;
	hasLiveCapabilityOrSession(): boolean;
};

export function createWebSessionAuthority(
	options: WebSessionAuthorityOptions,
): WebSessionAuthority {
	const now = options.now ?? Date.now;
	const random = options.random ?? randomBytes;
	const launchTtlMs = options.launchTtlMs ?? DEFAULT_LAUNCH_TTL_MS;
	const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
	const absoluteTtlMs =
		options.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS;
	const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
	const maxPendingLaunchCapabilities =
		options.maxPendingLaunchCapabilities ??
		DEFAULT_MAX_PENDING_LAUNCH_CAPABILITIES;
	const maxRequests =
		options.maxRequestsPerSession ?? DEFAULT_MAX_REQUESTS;
	const maxAnalysis =
		options.maxAnalysisPerSession ?? DEFAULT_MAX_ANALYSIS;
	const maxStreams =
		options.maxStreamsPerSession ?? DEFAULT_MAX_STREAMS;
	const principalId = options.principalId ?? "local-user";
	const principalDisplayName =
		options.principalDisplayName ?? "Local user";
	const serverKey = Buffer.from(random(32));
	const hostNonce = base32(random(16));
	if (!/^[a-z2-7]{26}$/u.test(hostNonce)) {
		throw new Error("P17 host nonce generator produced an invalid value");
	}
	const cookieSuffix = createHash("sha256")
		.update(options.listenerId)
		.digest("hex")
		.slice(0, 8);
	const cookieName = `tf_web_${cookieSuffix}`;
	const sessions = new Map<string, WebSessionRecord>();
	const launchCapabilities = new Map<
		string,
		{ digest: Buffer; expiresAt: number }
	>();

	function tokenDigest(token: string): string {
		return createHmac("sha256", serverKey)
			.update(token)
			.digest("hex");
	}

	function mintLaunchCapability(): WebLaunchCapability | null {
		prune();
		if (
			maxPendingLaunchCapabilities <= 0 ||
			launchCapabilities.size >= maxPendingLaunchCapabilities
		) {
			return null;
		}
		const launchToken = base64Url(random(32));
		if (!/^[A-Za-z0-9_-]{43}$/u.test(launchToken)) {
			throw new Error(
				"P17 launch-token generator produced an invalid value",
			);
		}
		const launchExpiresAt = now() + launchTtlMs;
		const digest = createHmac("sha256", serverKey)
			.update(launchToken)
			.digest();
		launchCapabilities.set(digest.toString("hex"), {
			digest,
			expiresAt: launchExpiresAt,
		});
		return { launchToken, launchExpiresAt };
	}

	function prune(): number {
		const observedAt = now();
		let removed = 0;
		for (const [key, capability] of launchCapabilities) {
			if (observedAt >= capability.expiresAt) {
				launchCapabilities.delete(key);
				removed += 1;
			}
		}
		for (const [digest, session] of sessions) {
			if (
				session.revoked ||
				observedAt >= session.idleExpiresAt ||
				observedAt >= session.absoluteExpiresAt
			) {
				sessions.delete(digest);
				removed += 1;
			}
		}
		return removed;
	}

	function authenticate(
		sessionToken: string,
		touch = true,
	): WebSessionRecord | null {
		prune();
		if (!/^[A-Za-z0-9_-]{43}$/u.test(sessionToken)) return null;
		const session = sessions.get(tokenDigest(sessionToken));
		if (!session || session.revoked) return null;
		const observedAt = now();
		if (
			observedAt >= session.idleExpiresAt ||
			observedAt >= session.absoluteExpiresAt
		) {
			sessions.delete(tokenDigest(sessionToken));
			return null;
		}
		if (touch) {
			session.idleExpiresAt = Math.min(
				observedAt + idleTtlMs,
				session.absoluteExpiresAt,
			);
		}
		return session;
	}

	const initialLaunch = mintLaunchCapability();
	if (!initialLaunch) {
		throw new Error(
			"P17 session authority requires at least one pending launch capability",
		);
	}

	return {
		listenerId: options.listenerId,
		hostNonce,
		cookieName,
		launchToken: initialLaunch.launchToken,
		launchExpiresAt: initialLaunch.launchExpiresAt,
		mintLaunchCapability,

		exchange(candidate) {
			prune();
			if (
				!/^[A-Za-z0-9_-]{43}$/u.test(candidate)
			) {
				return null;
			}
			const candidateDigest = createHmac("sha256", serverKey)
				.update(candidate)
				.digest();
			let matchedKey: string | undefined;
			for (const [key, capability] of launchCapabilities) {
				if (
					candidateDigest.length ===
						capability.digest.length &&
					timingSafeEqual(
						candidateDigest,
						capability.digest,
					)
				) {
					matchedKey = key;
					break;
				}
			}
			if (matchedKey === undefined) {
				return null;
			}
			// Matching presentation consumes the capability before any later
			// allocation can fail.
			launchCapabilities.delete(matchedKey);
			if (sessions.size >= maxSessions) return null;
			const observedAt = now();
			const absoluteExpiresAt = observedAt + absoluteTtlMs;
			const sessionToken = base64Url(random(32));
			const csrfToken = base64Url(random(32));
			if (
				!/^[A-Za-z0-9_-]{43}$/u.test(sessionToken) ||
				!/^[A-Za-z0-9_-]{43}$/u.test(csrfToken)
			) {
				return null;
			}
			const session: WebSessionRecord = {
				sessionId: `session-${base64Url(random(18))}`,
				principalId,
				principalDisplayName,
				csrfToken,
				createdAt: observedAt,
				idleExpiresAt: Math.min(
					observedAt + idleTtlMs,
					absoluteExpiresAt,
				),
				absoluteExpiresAt,
				activeRequests: 0,
				activeAnalysisRequests: 0,
				activeStreams: 0,
				revoked: false,
			};
			sessions.set(tokenDigest(sessionToken), session);
			return {
				sessionToken,
				session,
				view: {
					csrfToken,
					idleExpiresAt: session.idleExpiresAt,
					absoluteExpiresAt,
					hostNonce,
				},
			};
		},

		authenticate,

		verifyCsrf(session, csrfToken) {
			return (
				!session.revoked &&
				typeof csrfToken === "string" &&
				equalText(session.csrfToken, csrfToken)
			);
		},

		revoke(sessionToken) {
			const digest = tokenDigest(sessionToken);
			const session = sessions.get(digest);
			if (!session) return false;
			session.revoked = true;
			sessions.delete(digest);
			return true;
		},

		revokeAll() {
			const count = sessions.size;
			for (const session of sessions.values()) {
				session.revoked = true;
			}
			sessions.clear();
			return count;
		},

		acquireRequest(session, analysis) {
			if (
				session.revoked ||
				session.activeRequests >= maxRequests ||
				(analysis &&
					session.activeAnalysisRequests >= maxAnalysis)
			) {
				return null;
			}
			session.activeRequests += 1;
			if (analysis) session.activeAnalysisRequests += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				session.activeRequests = Math.max(
					0,
					session.activeRequests - 1,
				);
				if (analysis) {
					session.activeAnalysisRequests = Math.max(
						0,
						session.activeAnalysisRequests - 1,
					);
				}
			};
		},

		acquireStream(session) {
			if (
				session.revoked ||
				session.activeStreams >= maxStreams
			) {
				return null;
			}
			session.activeStreams += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				session.activeStreams = Math.max(
					0,
					session.activeStreams - 1,
				);
			};
		},

		prune,

		activeSessionCount() {
			prune();
			return sessions.size;
		},

		hasLiveCapabilityOrSession() {
			prune();
			return launchCapabilities.size > 0 || sessions.size > 0;
		},
	};
}
