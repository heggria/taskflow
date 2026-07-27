/**
 * P16 D1 — clock authority: TTL decisions use a store-owned wall clock only.
 * Public openUserCoordinatorStore / per-op opts.now must not forge expiry.
 * Injectable clocks must not appear on the public package barrel.
 *
 * Expiry is simulated either by elapsing reservedExpiresAt on disk and calling
 * the production reclaim/commit path with no caller timestamp — never by forging
 * reclaim(now).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as publicBarrel from "../src/index.ts";
import { openUserCoordinatorStore } from "../src/store/coordinator.ts";
import { coordinatorDir } from "../src/paths.ts";

function tempEnv(): { env: NodeJS.ProcessEnv; home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p16-clock-"));
	return {
		home,
		env: { ...process.env, TASKFLOW_HOME: home },
		cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
	};
}

function openPublic(env: NodeJS.ProcessEnv) {
	return openUserCoordinatorStore(env, {
		allowUnfencedMutationForExplicitNonGaMode: true,
	});
}

function elapseReservedOnDisk(env: NodeJS.ProcessEnv, reservationId: string): void {
	const statePath = path.join(coordinatorDir(env), "state.json");
	const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
		reservations: Array<{ reservationId: string; reservedExpiresAt?: number }>;
	};
	const row = state.reservations.find((r) => r.reservationId === reservationId);
	assert.ok(row, `reservation ${reservationId} must exist on disk to elapse`);
	row.reservedExpiresAt = Date.now() - 1;
	fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

test("P16 D1: public barrel cannot reach injectable clock / ForTests construction", () => {
	// Public package entry must not expose a forgeable clock construction path.
	const barrel = publicBarrel as Record<string, unknown>;
	assert.equal(
		"openUserCoordinatorStoreForTests" in barrel,
		false,
		"public barrel must not export openUserCoordinatorStoreForTests",
	);
	assert.equal(
		"CoordinatorClock" in barrel,
		false,
		"public barrel must not export CoordinatorClock",
	);
	assert.equal(
		"openCoordinatorStoreWithClock" in barrel,
		false,
		"public barrel must not export an injectable-clock open helper",
	);
	assert.equal(typeof publicBarrel.openUserCoordinatorStore, "function");

	const t = tempEnv();
	try {
		// Public entry refuses a clock option — cannot forge TTL via open().
		assert.throws(
			() =>
				publicBarrel.openUserCoordinatorStore(t.env, {
					allowUnfencedMutationForExplicitNonGaMode: true,
					// @ts-expect-error — clock must not be a public option
					clock: { now: () => Number.MAX_SAFE_INTEGER },
				}),
			/TF_INVALID_ARGUMENT|clock|not accepted/,
		);

		// Even with a still-valid reserved lease, a forged future reclaim timestamp
		// through the public store cannot free capacity (wall clock is authority).
		const coordinator = publicBarrel.openUserCoordinatorStore(t.env, {
			allowUnfencedMutationForExplicitNonGaMode: true,
		});
		const reservation = coordinator.reserve({ ttlMs: 60_000 });
		assert.ok(reservation);
		assert.equal(
			coordinator.reclaimExpiredReserved(reservation.reservedExpiresAt! + 1),
			0,
			"public reclaim with forged future timestamp must free zero still-valid slots",
		);
		assert.equal(coordinator.getReservation(reservation.reservationId)?.state, "reserved");
	} finally {
		t.cleanup();
	}
});

test("P16 D1: public openUserCoordinatorStore refuses injectable clock option", () => {
	const t = tempEnv();
	try {
		assert.throws(
			() =>
				openUserCoordinatorStore(t.env, {
					allowUnfencedMutationForExplicitNonGaMode: true,
					// @ts-expect-error — clock must not be a public option
					clock: { now: () => 0 },
				}),
			/TF_INVALID_ARGUMENT|clock|not accepted/,
		);
	} finally {
		t.cleanup();
	}
});

test("P16 D1: future caller clock cannot free a still-valid reserved slot via reclaim", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve({ ttlMs: 60_000 });
		assert.ok(reservation);
		assert.equal(reservation.state, "reserved");
		assert.ok(reservation.reservedExpiresAt! > Date.now());

		// Forgery attempt: pass a future timestamp equal to/after the lease expiry.
		// Caller timestamps are not authority — the call must not free the slot.
		const reclaimed = coordinator.reclaimExpiredReserved(reservation.reservedExpiresAt! + 1);
		assert.equal(reclaimed, 0, "forged future reclaim must free zero still-valid reserved slots");

		const after = coordinator.getReservation(reservation.reservationId);
		assert.equal(after?.state, "reserved", "still-valid reserved must survive forged future reclaim");
		assert.equal(coordinator.occupyingCount(), 1);
	} finally {
		t.cleanup();
	}
});

test("P16 D1: elapsed reserved on disk cannot be committed under wall clock", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve({ ttlMs: 60_000 });
		assert.ok(reservation);

		// Simulate real TTL expiry without any injectable clock: elapse on disk,
		// then use production commit path (no caller timestamp).
		elapseReservedOnDisk(t.env, reservation.reservationId);

		assert.throws(
			() =>
				openPublic(t.env).commitReservation(reservation.reservationId, {
					projectId: "proj-a",
					projectControlDomainId: "dom-a",
					runId: "run-a",
					projectAdmitCommitSeq: 1,
				}),
			/cannot commit expired reservation|TF_RESERVATION_EXPIRED|expired/,
		);

		const after = openPublic(t.env).getReservation(reservation.reservationId);
		assert.equal(after?.state, "expired");
		assert.equal(openPublic(t.env).occupyingCount(), 0);

		// Signature surface: only (reservationId, binding) — no opts.now.
		assert.ok(
			coordinator.commitReservation.length <= 2,
			`commitReservation must not expose a third opts.now parameter (arity=${coordinator.commitReservation.length})`,
		);
	} finally {
		t.cleanup();
	}
});

test("P16 D1: production reclaim after on-disk expiry (no caller timestamp)", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve({ ttlMs: 60_000 });
		assert.ok(reservation);

		// Without elapsing, no-arg reclaim must free nothing.
		assert.equal(coordinator.reclaimExpiredReserved(), 0);
		assert.equal(coordinator.getReservation(reservation.reservationId)?.state, "reserved");

		// Elapse reservedExpiresAt on disk, then production reclaim with no caller timestamp.
		elapseReservedOnDisk(t.env, reservation.reservationId);
		assert.equal(openPublic(t.env).reclaimExpiredReserved(), 1);
		assert.equal(openPublic(t.env).getReservation(reservation.reservationId)?.state, "expired");

		// Public open still cannot inject a clock to re-open with a forged timeline.
		assert.throws(
			() =>
				openUserCoordinatorStore(t.env, {
					allowUnfencedMutationForExplicitNonGaMode: true,
					// @ts-expect-error — not a public option
					clock: { now: () => 0 },
				}),
			/TF_INVALID_ARGUMENT|clock|not accepted/,
		);
	} finally {
		t.cleanup();
	}
});

test("P16 D1: public reclaim without args uses wall clock (no caller timestamp)", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve({ ttlMs: 60_000 });
		assert.ok(reservation);
		// No-arg reclaim must not free a still-valid lease.
		assert.equal(coordinator.reclaimExpiredReserved(), 0);
		assert.equal(coordinator.getReservation(reservation.reservationId)?.state, "reserved");

		// Elapse on disk, then no-arg reclaim under wall clock must free it.
		elapseReservedOnDisk(t.env, reservation.reservationId);
		assert.equal(openPublic(t.env).reclaimExpiredReserved(), 1);
		assert.equal(openPublic(t.env).getReservation(reservation.reservationId)?.state, "expired");
	} finally {
		t.cleanup();
	}
});
