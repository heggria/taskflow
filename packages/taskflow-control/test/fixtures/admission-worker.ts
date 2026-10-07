/** Process harness around production ControlStore/ProjectAdmissionService. */
import { openControlStore, type ControlStore } from "../../src/store/store.ts";
import { ProjectAdmissionService } from "../../src/admission-service.ts";
import { openCoordinatorStore, type CoordinatorStoreOptions } from "../../src/store/coordinator-store.ts";
import type { ConcurrencyReservation } from "../../src/schema/coordinator.ts";
import { ControlError } from "../../src/errors.ts";

export interface AdmissionWorkerConfig {
	projectPath: string; coordinatorPath: string; reservation: ConcurrencyReservation;
	mode: "admit" | "abandon" | "recover" | "dispatch";
	killAfterDecision?: boolean; waitForStart?: boolean;
}
export async function withProject<T>(directory: string, apply: (service: ProjectAdmissionService, store: ControlStore) => T): Promise<T> {
	const deadline = Date.now() + 10_000;
	let store: ControlStore;
	for (;;) {
		try { store = openControlStore(directory); break; }
		catch (error) {
			if (!(error instanceof ControlError) || !error.message.includes("live or unverified writer") || Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	try { return apply(new ProjectAdmissionService(store), store); }
	finally { store.close(); }
}
export function coordinatorOptions(config: AdmissionWorkerConfig): CoordinatorStoreOptions<object> {
	return { initialMaxActiveRuns: 1, epoch: 1, holderId: "admission-test-host", authority: {
		readLease: () => ({ holderId: "admission-test-host", fencingEpoch: 1, endpoint: "test://admission", expiresAt: Date.now() + 60_000 }),
		authorize: () => ({ principal: "test-user", ownerId: "test-owner", operator: false }),
		readAdmission: (reservation) => withProject(config.projectPath, (service) => service.readAdmission(reservation)),
		abandonAdmissionIfAbsent: async (reservation) => {
			const result = await withProject(config.projectPath, (service) => service.abandonAdmissionIfAbsent(reservation));
			if (config.killAfterDecision) process.kill(process.pid, "SIGKILL");
			return result;
		},
		readRelease: () => { throw new Error("release is outside admission arbitration"); },
	} };
}
async function main(config: AdmissionWorkerConfig) {
	if (config.waitForStart) {
		process.send?.({ ready: true });
		await new Promise<void>((resolve) => process.once("message", () => resolve()));
	}
	try {
		let result: unknown;
		if (config.mode === "admit" || config.mode === "abandon") {
			result = await withProject(config.projectPath, (service) => config.mode === "admit"
				? service.admit(config.reservation, 0) : service.abandonAdmissionIfAbsent(config.reservation));
			if (config.killAfterDecision) process.kill(process.pid, "SIGKILL");
		} else {
			const coordinator = await openCoordinatorStore(config.coordinatorPath, coordinatorOptions(config));
			try {
				if (config.mode === "recover") result = await coordinator.snapshot({});
				else {
					const row = await coordinator.readReservation(config.reservation.reservationId, {});
					if (!row) throw new Error("missing reservation");
					result = await withProject(config.projectPath, (service) => service.assertDispatch(row.reservation));
				}
			} finally { coordinator.close(); }
		}
		process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
	} catch (error) {
		process.stdout.write(JSON.stringify({ ok: false, code: error instanceof ControlError ? error.code : "unexpected", message: String(error) }) + "\n");
		process.exitCode = 2;
	} finally { process.disconnect?.(); }
}
if (process.argv[2]) await main(JSON.parse(process.argv[2]) as AdmissionWorkerConfig);
