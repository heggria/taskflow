/**
 * P16 D3 — migration: pre-upgrade expired/released rows with residual
 * reservedExpiresAt must reopen; tampering must fail closed.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { openUserCoordinatorStore } from "../src/store/coordinator.ts";
import { coordinatorDir, ControlStoreDurabilityError } from "../src/paths.ts";

function tempEnv(): { env: NodeJS.ProcessEnv; home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p16-legacy-"));
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

function statePath(env: NodeJS.ProcessEnv): string {
	return path.join(coordinatorDir(env), "state.json");
}

function readState(env: NodeJS.ProcessEnv): {
	reservations: Array<Record<string, unknown>>;
	[key: string]: unknown;
} {
	return JSON.parse(fs.readFileSync(statePath(env), "utf-8")) as {
		reservations: Array<Record<string, unknown>>;
	};
}

function writeState(env: NodeJS.ProcessEnv, state: unknown): void {
	fs.writeFileSync(statePath(env), JSON.stringify(state, null, 2), "utf-8");
}

test("P16 D3: released rows with residual reservedExpiresAt reopen successfully", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		coordinator.releaseUnboundReservation(reservation.reservationId);

		const state = readState(t.env);
		const row = state.reservations.find((r) => r.reservationId === reservation.reservationId);
		assert.ok(row);
		// Pre-upgrade writers sometimes left the historical TTL field after release.
		row.reservedExpiresAt = Number(row.createdAt) + 60_000;
		writeState(t.env, state);

		const reopened = openPublic(t.env);
		const loaded = reopened.getReservation(reservation.reservationId);
		assert.equal(loaded?.state, "released");
		assert.equal(loaded?.reservedExpiresAt, Number(row.createdAt) + 60_000);
		assert.equal(reopened.occupyingCount(), 0);
	} finally {
		t.cleanup();
	}
});

test("P16 D3: expired rows with residual reservedExpiresAt reopen successfully", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve({ ttlMs: 60_000 });
		assert.ok(reservation);

		// Elapse on disk then reclaim under wall clock (no caller timestamp).
		const state = readState(t.env);
		const row = state.reservations.find((r) => r.reservationId === reservation.reservationId);
		assert.ok(row);
		row.reservedExpiresAt = Date.now() - 5;
		writeState(t.env, state);
		assert.equal(openPublic(t.env).reclaimExpiredReserved(), 1);

		const afterExpire = readState(t.env);
		const expiredRow = afterExpire.reservations.find(
			(r) => r.reservationId === reservation.reservationId,
		);
		assert.ok(expiredRow);
		assert.equal(expiredRow.state, "expired");
		// Residual TTL field may remain on pre-upgrade / current expire path.
		assert.notEqual(expiredRow.reservedExpiresAt, undefined);

		const reopened = openPublic(t.env);
		assert.equal(reopened.getReservation(reservation.reservationId)?.state, "expired");
		assert.equal(reopened.occupyingCount(), 0);
	} finally {
		t.cleanup();
	}
});

test("P16 D3: project-bound released residual reservedExpiresAt is legacy-compatible", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		const binding = {
			projectId: "proj-legacy",
			projectControlDomainId: "dom-legacy",
			runId: "run-legacy",
			projectAdmitCommitSeq: 3,
		};
		coordinator.commitReservation(reservation.reservationId, binding);
		coordinator.normalRelease(reservation.reservationId, {
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: true,
			runIsParkedAndFutureDispatchRequiresReadmission: false,
		});

		const state = readState(t.env);
		const row = state.reservations.find((r) => r.reservationId === reservation.reservationId);
		assert.ok(row);
		row.reservedExpiresAt = Number(row.updatedAt) - 1;
		writeState(t.env, state);

		const reopened = openPublic(t.env);
		const loaded = reopened.getReservation(reservation.reservationId);
		assert.equal(loaded?.state, "released");
		assert.equal(loaded?.projectId, binding.projectId);
		assert.equal(loaded?.reservedExpiresAt, Number(row.updatedAt) - 1);
	} finally {
		t.cleanup();
	}
});

test("P16 D3: tampering — committed capacity with residual reservedExpiresAt fails closed", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		coordinator.commitReservation(reservation.reservationId, {
			projectId: "proj-tamper",
			projectControlDomainId: "dom-tamper",
			runId: "run-tamper",
			projectAdmitCommitSeq: 1,
		});

		const state = readState(t.env);
		const row = state.reservations.find((r) => r.reservationId === reservation.reservationId);
		assert.ok(row);
		row.reservedExpiresAt = Date.now() + 60_000;
		const corrupt = JSON.stringify(state, null, 2);
		writeState(t.env, state);

		assert.throws(
			() => openPublic(t.env).occupyingCount(),
			(error: unknown) => {
				assert.ok(error instanceof ControlStoreDurabilityError);
				assert.match(error.message, /committed capacity|immutable project admission|reservedExpiresAt/);
				return true;
			},
		);
		assert.equal(fs.readFileSync(statePath(t.env), "utf-8"), corrupt);
	} finally {
		t.cleanup();
	}
});

test("P16 D3: tampering — expired with reservedExpiresAt after updatedAt fails closed", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve({ ttlMs: 60_000 });
		assert.ok(reservation);
		const state = readState(t.env);
		const row = state.reservations.find((r) => r.reservationId === reservation.reservationId);
		assert.ok(row);
		const now = Date.now();
		row.state = "expired";
		row.updatedAt = now;
		row.reservedExpiresAt = now + 999_999; // impossible: expired after update
		const corrupt = JSON.stringify(state, null, 2);
		writeState(t.env, state);

		assert.throws(
			() => openPublic(t.env).occupyingCount(),
			(error: unknown) => {
				assert.ok(error instanceof ControlStoreDurabilityError);
				assert.match(error.message, /expired capacity|expired unbound TTL/);
				return true;
			},
		);
		assert.equal(fs.readFileSync(statePath(t.env), "utf-8"), corrupt);
	} finally {
		t.cleanup();
	}
});
