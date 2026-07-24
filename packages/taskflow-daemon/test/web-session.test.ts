import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebSessionAuthority } from "../src/web-session.ts";

function deterministicRandom() {
	let seed = 0;
	return (size: number) => {
		const bytes = Buffer.alloc(size);
		for (let index = 0; index < size; index += 1) {
			bytes[index] = (seed + index * 17) & 0xff;
		}
		seed += 1;
		return bytes;
	};
}

test("P17 session: launch capability is exact, single-use, and guesses do not consume it", () => {
	let now = 1_800_000_000_000;
	const authority = createWebSessionAuthority({
		listenerId: "listener-web-session",
		now: () => now,
		random: deterministicRandom(),
	});
	assert.match(authority.hostNonce, /^[a-z2-7]{26}$/u);
	assert.match(authority.launchToken, /^[A-Za-z0-9_-]{43}$/u);
	assert.match(authority.cookieName, /^tf_web_[a-f0-9]{8}$/u);
	assert.equal(authority.exchange("x".repeat(43)), null);
	const exchanged = authority.exchange(authority.launchToken);
	assert.ok(exchanged);
	assert.match(exchanged.sessionToken, /^[A-Za-z0-9_-]{43}$/u);
	assert.match(exchanged.view.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
	assert.equal(exchanged.view.hostNonce, authority.hostNonce);
	assert.equal(authority.exchange(authority.launchToken), null);
	assert.equal(authority.activeSessionCount(), 1);
	now += 1;
	assert.equal(
		authority.authenticate(exchanged.sessionToken)?.sessionId,
		exchanged.session.sessionId,
	);
});

test("P17 session: idle extension never crosses absolute expiry", () => {
	let now = 10_000;
	const authority = createWebSessionAuthority({
		listenerId: "listener-expiry",
		now: () => now,
		random: deterministicRandom(),
		launchTtlMs: 100,
		idleTtlMs: 20,
		absoluteTtlMs: 50,
	});
	const exchanged = authority.exchange(authority.launchToken);
	assert.ok(exchanged);
	now = 10_015;
	const touched = authority.authenticate(exchanged.sessionToken);
	assert.equal(touched?.idleExpiresAt, 10_035);
	now = 10_034;
	assert.equal(
		authority.authenticate(exchanged.sessionToken)?.idleExpiresAt,
		10_050,
	);
	now = 10_050;
	assert.equal(authority.authenticate(exchanged.sessionToken), null);
	assert.equal(authority.activeSessionCount(), 0);
});

test("P17 session: CSRF, request limits, and revocation fail closed", () => {
	const authority = createWebSessionAuthority({
		listenerId: "listener-limits",
		random: deterministicRandom(),
		maxRequestsPerSession: 2,
		maxAnalysisPerSession: 1,
	});
	const exchanged = authority.exchange(authority.launchToken);
	assert.ok(exchanged);
	const session = exchanged.session;
	assert.equal(
		authority.verifyCsrf(session, exchanged.view.csrfToken),
		true,
	);
	assert.equal(authority.verifyCsrf(session, "x".repeat(43)), false);
	const releaseAnalysis = authority.acquireRequest(session, true);
	assert.ok(releaseAnalysis);
	assert.equal(authority.acquireRequest(session, true), null);
	const releaseOrdinary = authority.acquireRequest(session, false);
	assert.ok(releaseOrdinary);
	assert.equal(authority.acquireRequest(session, false), null);
	releaseAnalysis();
	releaseAnalysis();
	assert.ok(authority.acquireRequest(session, true));
	releaseOrdinary();
	assert.equal(authority.revoke(exchanged.sessionToken), true);
	assert.equal(authority.authenticate(exchanged.sessionToken), null);
	assert.equal(authority.revoke(exchanged.sessionToken), false);
});

test("P17 session: matching launch token is consumed even when capacity blocks creation", () => {
	const authority = createWebSessionAuthority({
		listenerId: "listener-zero-capacity",
		random: deterministicRandom(),
		maxSessions: 0,
	});
	assert.equal(authority.exchange(authority.launchToken), null);
	assert.equal(authority.exchange(authority.launchToken), null);
	assert.equal(authority.hasLiveCapabilityOrSession(), false);
});

test("P17 session: concurrent launches receive independent one-time capabilities", () => {
	let now = 42_000;
	const authority = createWebSessionAuthority({
		listenerId: "listener-concurrent-launches",
		now: () => now,
		random: deterministicRandom(),
		launchTtlMs: 100,
		maxPendingLaunchCapabilities: 3,
	});
	const second = authority.mintLaunchCapability();
	const third = authority.mintLaunchCapability();
	assert.ok(second);
	assert.ok(third);
	assert.notEqual(second.launchToken, authority.launchToken);
	assert.notEqual(third.launchToken, second.launchToken);
	assert.equal(authority.mintLaunchCapability(), null);

	assert.equal(authority.exchange("x".repeat(43)), null);
	assert.ok(authority.exchange(second.launchToken));
	assert.equal(authority.exchange(second.launchToken), null);
	assert.ok(authority.exchange(authority.launchToken));
	assert.ok(authority.exchange(third.launchToken));
	assert.equal(authority.activeSessionCount(), 3);

	const expiring = authority.mintLaunchCapability();
	assert.ok(expiring);
	now = expiring.launchExpiresAt;
	assert.equal(authority.exchange(expiring.launchToken), null);
	assert.equal(authority.hasLiveCapabilityOrSession(), true);
	authority.revokeAll();
	assert.equal(authority.hasLiveCapabilityOrSession(), false);
});
