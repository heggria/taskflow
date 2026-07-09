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
		/** When true, mark auto-reject (no interactive approver). */
		auto?: boolean;
	},
): PhaseState {
	if (opts.auto) {
		return {
			id: phaseId,
			status: "done",
			output: "(auto-rejected: no interactive approver available)",
			approval: { decision: "reject", auto: true },
			gate: { verdict: "block", reason: "(auto-rejected: no interactive approver available)" },
			usage: emptyUsage(),
			inputHash: opts.inputHash,
			reads: opts.reads,
			endedAt: Date.now(),
		};
	}

	const note = decision.note?.trim();
	const ps: PhaseState = {
		id: phaseId,
		status: "done",
		output: note || `(${decision.decision})`,
		approval: { decision: decision.decision, note },
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
