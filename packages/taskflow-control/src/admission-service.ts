/** Project-side admission arbitration. ADMIT and ABANDON are decisions in the
 * actual ControlStore journal, serialized by its writer fence. No side files or
 * observer callbacks carry admission authority. */
import { ControlError } from "./errors.ts";
import type { ConcurrencyReservation } from "./schema/coordinator.ts";
import type { ControlStore, AdmissionBinding, AdmissionDecision } from "./store/store.ts";
import type { CoordinatorAdmissionDecision, CoordinatorAdmissionObservation, CoordinatorAdmissionProof } from "./store/coordinator-store.ts";

export class ProjectAdmissionService {
	readonly #store: ControlStore;
	constructor(store: ControlStore) { this.#store = store; }

	readAdmission(reservation: ConcurrencyReservation): CoordinatorAdmissionObservation {
		this.#binding(reservation);
		const decision = this.#store.readAdmission(binding(reservation));
		return decision ? proof(decision) : null;
	}

	abandonAdmissionIfAbsent(reservation: ConcurrencyReservation): CoordinatorAdmissionDecision {
		this.#binding(reservation);
		return proof(this.#store.abandonAdmissionIfAbsent(binding(reservation)));
	}

	admit(reservation: ConcurrencyReservation, expectedRunVersion: number): CoordinatorAdmissionProof {
		this.#binding(reservation);
		if (reservation.state !== "reserved") conflict("admission requires a reserved coordinator binding");
		const decision = this.#store.admitRun(binding(reservation), expectedRunVersion);
		if (decision.status !== "admitted") conflict("reservation was durably abandoned; a fresh reservation is required");
		return proof(decision) as CoordinatorAdmissionProof;
	}

	/** Called by the host at its dispatch boundary after live authorization and
	 * a current coordinator read. This is a binding check, not a replacement for
	 * the host's epoch/provider dispatch fence. No await occurs in this check. */
	assertDispatch(reservation: ConcurrencyReservation): CoordinatorAdmissionProof {
		this.#binding(reservation);
		if (reservation.state !== "committed") conflict("dispatch requires a committed coordinator reservation");
		const decision = this.#store.readAdmission(binding(reservation));
		if (!decision || decision.status !== "admitted" || decision.decisionCommitSeq !== reservation.projectAdmitCommitSeq) {
			conflict("dispatch requires the exact durable project admission");
		}
		const run = this.#store.readRun(reservation.runId);
		if (!run || run.status !== "running" || !["admitted", "executing"].includes(run.stage)
			|| run.requiresReadmission || run.reservationId !== reservation.reservationId
			|| run.projectAdmitCommitSeq !== decision.decisionCommitSeq) conflict("run no longer authorizes this dispatch");
		return proof(decision) as CoordinatorAdmissionProof;
	}

	#binding(reservation: ConcurrencyReservation): void {
		const header = this.#store.header;
		if (reservation.projectId !== header.projectId || reservation.projectControlDomainId !== header.controlDomainId) {
			conflict("admission reservation belongs to another project or control domain");
		}
	}
}
function proof(decision: AdmissionDecision): CoordinatorAdmissionDecision {
	const binding = { reservationId: decision.reservationId, projectId: decision.projectId,
		projectControlDomainId: decision.projectControlDomainId, runId: decision.runId, runVersion: decision.runVersion };
	return decision.status === "admitted" ? { ...binding, projectAdmitCommitSeq: decision.decisionCommitSeq }
		: { ...binding, status: "abandoned", abandonmentCommitSeq: decision.decisionCommitSeq };
}
function conflict(message: string): never {
	throw new ControlError("TF_ADMISSION_BINDING_CONFLICT", message, { recoveryAction: "operator", sideEffects: "none" });
}

function binding(reservation: ConcurrencyReservation): AdmissionBinding {
	return { reservationId: reservation.reservationId, projectId: reservation.projectId,
		projectControlDomainId: reservation.projectControlDomainId, runId: reservation.runId };
}
