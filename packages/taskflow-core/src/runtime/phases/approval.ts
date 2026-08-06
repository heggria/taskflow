/**
 * Approval phase — human-in-the-loop pause (approve / reject / edit).
 */

import type { PhaseState } from "../../store.ts";
import { emptyUsage } from "../../usage.ts";

export interface ApprovalDecision {
	decision: "approve" | "reject" | "edit";
	note?: string;
}

export interface ApprovalRequest {
	phaseId: string;
	message: string;
	upstream?: string;
}

/**
 * Build PhaseState for an approval outcome (interactive or auto-reject).
 */
export function approvalDecisionToPhaseState(
	phaseId: string,
	decision: ApprovalDecision,
	opts: {
		inputHash: string;
		reads?: PhaseState["reads"];
		/** When true, mark approval as automatic (timeout / headless / abort). */
		auto?: boolean;
	},
): PhaseState {
	const note = decision.note?.trim();
	// Headless default path: no note and reject → keep historical auto-reject wording.
	if (
		opts.auto &&
		decision.decision === "reject" &&
		(!note || note === "(auto-rejected: no interactive approver available)")
	) {
		const reason = note || "(auto-rejected: no interactive approver available)";
		return {
			id: phaseId,
			status: "done",
			output: reason,
			approval: { decision: "reject", auto: true, note },
			gate: { verdict: "block", reason },
			usage: emptyUsage(),
			inputHash: opts.inputHash,
			reads: opts.reads,
			endedAt: Date.now(),
		};
	}

	const ps: PhaseState = {
		id: phaseId,
		status: "done",
		output: note || `(${decision.decision})`,
		approval: { decision: decision.decision, note, ...(opts.auto ? { auto: true } : {}) },
		usage: emptyUsage(),
		inputHash: opts.inputHash,
		reads: opts.reads,
		endedAt: Date.now(),
	};
	if (decision.decision === "reject") {
		ps.gate = { verdict: "block", reason: note || "Rejected by user" };
	}
	return ps;
}
