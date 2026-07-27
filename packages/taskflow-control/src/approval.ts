/**
 * Durable ApprovalRequest protocol (P15 / D34 / D38).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic, readJsonFile, ensureDir, projectControlRoot } from "./paths.ts";
import { isSafeId } from "./validate-ids.ts";
import { newId } from "./hash.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	ApprovalRequestStatus,
} from "./types.ts";

export type { ApprovalDecision, ApprovalRequest, ApprovalRequestStatus } from "./types.ts";

function approvalsDir(projectRoot: string): string {
	return path.join(projectControlRoot(projectRoot), "approvals");
}

export function createApprovalRequest(
	projectRoot: string,
	input: Omit<ApprovalRequest, "approvalRequestId" | "status" | "createdAt" | "allowedDecisions"> & {
		allowedDecisions?: ApprovalDecision[];
	},
): ApprovalRequest {
	if (!isSafeId(input.runId)) throw new Error("unsafe runId");
	const dir = approvalsDir(projectRoot);
	ensureDir(dir);
	const req = newApprovalRequest(input);
	writeFileAtomic(path.join(dir, `${req.approvalRequestId}.json`), JSON.stringify(req, null, 2));
	writeFileAtomic(
		path.join(dir, `by-run-${req.runId}.json`),
		JSON.stringify({ approvalRequestId: req.approvalRequestId }, null, 2),
	);
	return req;
}

/**
 * Construct a pending request without performing I/O. Native continuation
 * callers include this record in the same Project ControlStore journal batch
 * as the parked Run and checkpoint.
 */
export function newApprovalRequest(
	input: Omit<ApprovalRequest, "approvalRequestId" | "status" | "createdAt" | "allowedDecisions"> & {
		allowedDecisions?: ApprovalDecision[];
	},
): ApprovalRequest {
	if (!isSafeId(input.runId)) throw new Error("unsafe runId");
	return {
		approvalRequestId: newId("apr"),
		runId: input.runId,
		projectId: input.projectId,
		controlDomainId: input.controlDomainId,
		status: "pending",
		allowedDecisions: input.allowedDecisions ?? ["approve", "reject", "edit"],
		createdAt: Date.now(),
		deadline: input.deadline,
		expectedRunVersion: input.expectedRunVersion,
		...(input.continuationId === undefined ? {} : { continuationId: input.continuationId }),
		...(input.phaseId === undefined ? {} : { phaseId: input.phaseId }),
		...(input.message === undefined ? {} : { message: input.message }),
	};
}

/** Pure pending → decision transition for journaled native approval batches. */
export function transitionApproval(
	req: ApprovalRequest,
	input: {
		decision: ApprovalDecision;
		principal: string;
		commandId: string;
		note?: string;
		now?: number;
	},
): DecideResult {
	const now = input.now ?? Date.now();
	if (req.status !== "pending") {
		if (
			(req.status === "approved" && input.decision === "approve") ||
			(req.status === "rejected" && input.decision === "reject") ||
			(req.status === "edited" && input.decision === "edit")
		) {
			return { ok: true, request: req };
		}
		return {
			ok: false,
			code: "TF_INVALID_ARGUMENT",
			message: `illegal transition: status=${req.status} decision=${input.decision}`,
		};
	}
	if (req.deadline !== undefined && now > req.deadline) {
		return { ok: false, code: "TF_INVALID_ARGUMENT", message: "approval request expired" };
	}
	if (!req.allowedDecisions.includes(input.decision)) {
		return {
			ok: false,
			code: "TF_INVALID_ARGUMENT",
			message: `decision ${input.decision} not allowed`,
		};
	}
	if (!input.principal?.trim()) {
		return { ok: false, code: "TF_INVALID_ARGUMENT", message: "principal required" };
	}
	const status: ApprovalRequestStatus =
		input.decision === "approve"
			? "approved"
			: input.decision === "reject"
				? "rejected"
				: "edited";
	return {
		ok: true,
		request: {
			...req,
			status,
			decision: input.decision,
			decidedAt: now,
			decisionCommandId: input.commandId,
			deciderPrincipal: input.principal,
			...(input.note === undefined ? {} : { note: input.note }),
		},
	};
}

export function loadApprovalRequest(
	projectRoot: string,
	approvalRequestId: string,
): ApprovalRequest | null {
	if (!isSafeId(approvalRequestId)) return null;
	return readJsonFile<ApprovalRequest>(
		path.join(approvalsDir(projectRoot), `${approvalRequestId}.json`),
	);
}

export function loadApprovalForRun(projectRoot: string, runId: string): ApprovalRequest | null {
	if (!isSafeId(runId)) return null;
	const idx = readJsonFile<{ approvalRequestId: string }>(
		path.join(approvalsDir(projectRoot), `by-run-${runId}.json`),
	);
	if (!idx) return null;
	return loadApprovalRequest(projectRoot, idx.approvalRequestId);
}

export type DecideResult =
	| { ok: true; request: ApprovalRequest }
	| { ok: false; code: "TF_NOT_FOUND" | "TF_INVALID_ARGUMENT" | "TF_STALE_VERSION"; message: string };

/**
 * Transition pending → decided. Rejects illegal transitions and expired deadline.
 */
export function decideApproval(
	projectRoot: string,
	approvalRequestId: string,
	input: {
		decision: ApprovalDecision;
		principal: string;
		commandId: string;
		/** Optional note / edit payload */
		note?: string;
		now?: number;
	},
): DecideResult {
	const req = loadApprovalRequest(projectRoot, approvalRequestId);
	if (!req) {
		return { ok: false, code: "TF_NOT_FOUND", message: "approval request not found" };
	}
	const decided = transitionApproval(req, input);
	if (!decided.ok && decided.message === "approval request expired") {
		const now = input.now ?? Date.now();
		const expired: ApprovalRequest = {
			...req,
			status: "expired",
			decidedAt: now,
		};
		writeFileAtomic(
			path.join(approvalsDir(projectRoot), `${req.approvalRequestId}.json`),
			JSON.stringify(expired, null, 2),
		);
		return {
			ok: false,
			code: "TF_INVALID_ARGUMENT",
			message: "approval request expired",
		};
	}
	if (!decided.ok) return decided;
	const next = decided.request;
	writeFileAtomic(
		path.join(approvalsDir(projectRoot), `${req.approvalRequestId}.json`),
		JSON.stringify(next, null, 2),
	);
	return { ok: true, request: next };
}

/** Expire pending request past deadline → status expired (Run should go blocked). */
export function expireApprovalIfDue(
	projectRoot: string,
	approvalRequestId: string,
	now = Date.now(),
): ApprovalRequest | null {
	const req = loadApprovalRequest(projectRoot, approvalRequestId);
	if (!req || req.status !== "pending") return req;
	if (req.deadline === undefined || now <= req.deadline) return req;
	const expired: ApprovalRequest = { ...req, status: "expired", decidedAt: now };
	writeFileAtomic(
		path.join(approvalsDir(projectRoot), `${req.approvalRequestId}.json`),
		JSON.stringify(expired, null, 2),
	);
	return expired;
}

// silence unused import if any
void fs;
