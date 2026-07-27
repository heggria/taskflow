/**
 * P16 D4 — normalRelease idempotency: same-owner retry is exact; different owner refused.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { openUserCoordinatorStore } from "../src/store/coordinator.ts";

function tempEnv(): { env: NodeJS.ProcessEnv; home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p16-release-"));
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

test("P16 D4: retried normalRelease is exactly idempotent for the same owner", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		const binding = {
			projectId: "proj-a",
			projectControlDomainId: "dom-a",
			runId: "run-a",
			projectAdmitCommitSeq: 5,
		};
		coordinator.commitReservation(reservation.reservationId, binding);

		const releaseCtx = {
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: true,
			runIsParkedAndFutureDispatchRequiresReadmission: false,
			ownership: binding,
		};

		const first = coordinator.normalRelease(reservation.reservationId, releaseCtx);
		assert.equal(first.state, "released");
		const firstUpdatedAt = first.updatedAt;
		assert.equal(coordinator.occupyingCount(), 0);

		const retry = coordinator.normalRelease(reservation.reservationId, releaseCtx);
		assert.equal(retry.state, "released");
		assert.equal(retry.reservationId, reservation.reservationId);
		assert.equal(retry.updatedAt, firstUpdatedAt, "idempotent retry must not churn updatedAt");
		assert.equal(retry.projectId, binding.projectId);
		assert.equal(retry.projectControlDomainId, binding.projectControlDomainId);
		assert.equal(retry.runId, binding.runId);
		assert.equal(retry.projectAdmitCommitSeq, binding.projectAdmitCommitSeq);
		assert.equal(coordinator.occupyingCount(), 0);

		const reloaded = openPublic(t.env).getReservation(reservation.reservationId);
		assert.equal(reloaded?.state, "released");
		assert.equal(reloaded?.updatedAt, firstUpdatedAt);
	} finally {
		t.cleanup();
	}
});

test("P16 D4: normalRelease refuses a different owner even after release", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		const binding = {
			projectId: "proj-a",
			projectControlDomainId: "dom-a",
			runId: "run-a",
			projectAdmitCommitSeq: 5,
		};
		coordinator.commitReservation(reservation.reservationId, binding);
		const first = coordinator.normalRelease(reservation.reservationId, {
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: true,
			runIsParkedAndFutureDispatchRequiresReadmission: false,
			ownership: binding,
		});
		assert.equal(first.state, "released");
		const firstUpdatedAt = first.updatedAt;

		assert.throws(
			() =>
				coordinator.normalRelease(reservation.reservationId, {
					noLiveOrAmbiguousSideEffects: true,
					runIsTerminal: true,
					runIsParkedAndFutureDispatchRequiresReadmission: false,
					ownership: {
						projectId: "proj-attacker",
						projectControlDomainId: "dom-a",
						runId: "run-a",
						projectAdmitCommitSeq: 5,
					},
				}),
			/ownership|D37 normalRelease denied|match/,
		);

		const after = coordinator.getReservation(reservation.reservationId);
		assert.equal(after?.state, "released");
		assert.equal(after?.updatedAt, firstUpdatedAt);
		assert.equal(after?.projectId, binding.projectId);
	} finally {
		t.cleanup();
	}
});

test("P16 D4: boolean-only same-owner retry remains idempotent without ownership field", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const reservation = coordinator.reserve();
		assert.ok(reservation);
		coordinator.commitReservation(reservation.reservationId, {
			projectId: "proj-b",
			projectControlDomainId: "dom-b",
			runId: "run-b",
			projectAdmitCommitSeq: 2,
		});
		const ctx = {
			noLiveOrAmbiguousSideEffects: true,
			runIsTerminal: true,
			runIsParkedAndFutureDispatchRequiresReadmission: false,
		};
		const first = coordinator.normalRelease(reservation.reservationId, ctx);
		assert.equal(first.state, "released");
		const retry = coordinator.normalRelease(reservation.reservationId, ctx);
		assert.equal(retry.state, "released");
		assert.equal(retry.updatedAt, first.updatedAt);
	} finally {
		t.cleanup();
	}
});
