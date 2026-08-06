/**
 * Approval wait with optional timeoutMs / onExpire.
 * Shared by imperative runtime and event-kernel step-kinds.
 */

import type { Phase } from "../../schema.ts";
import type { ApprovalDecision } from "./approval.ts";

export type ApprovalExpireAction = "reject" | "fail" | "approve";

export type ResolvedApproval =
	| { kind: "decision"; decision: ApprovalDecision; auto?: boolean }
	| { kind: "fail"; error: string };

export interface ApprovalWaitDeps {
	phase: Phase;
	message: string;
	upstream?: string;
	requestApproval?: (req: {
		phaseId: string;
		message: string;
		upstream?: string;
	}) => Promise<ApprovalDecision>;
	signal?: AbortSignal;
}

function onExpireOf(phase: Phase): ApprovalExpireAction {
	const o = (phase as { onExpire?: string }).onExpire;
	if (o === "approve" || o === "fail" || o === "reject") return o;
	return "reject";
}

function timeoutMsOf(phase: Phase): number | undefined {
	const t = (phase as { timeoutMs?: unknown }).timeoutMs;
	if (typeof t === "number" && Number.isFinite(t) && t >= 1000) return t;
	return undefined;
}

/**
 * Resolve an approval decision, racing human input against timeoutMs when set.
 * Non-interactive (no requestApproval): auto-reject unless we only had timeout path —
 * still auto-reject for safety (detached/CI never bypasses).
 */
export async function resolveApprovalDecision(deps: ApprovalWaitDeps): Promise<ResolvedApproval> {
	const { phase, message, upstream, requestApproval, signal } = deps;
	const timeoutMs = timeoutMsOf(phase);
	const onExpire = onExpireOf(phase);

	// Headless: never auto-approve; timeout path still applies only when a human
	// wait was possible. Without requestApproval, preserve fail-closed reject.
	if (!requestApproval) {
		return {
			kind: "decision",
			decision: { decision: "reject", note: "(auto-rejected: no interactive approver available)" },
			auto: true,
		};
	}

	const human = requestApproval({ phaseId: phase.id, message, upstream });

	if (timeoutMs === undefined) {
		if (signal?.aborted) {
			return { kind: "decision", decision: { decision: "reject", note: "aborted" }, auto: true };
		}
		const decision = await human;
		return { kind: "decision", decision };
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<ResolvedApproval>((resolve) => {
		timer = setTimeout(() => {
			if (onExpire === "fail") {
				resolve({ kind: "fail", error: "approval-expired" });
			} else if (onExpire === "approve") {
				resolve({
					kind: "decision",
					decision: { decision: "approve", note: "approval-expired (auto-approve)" },
					auto: true,
				});
			} else {
				resolve({
					kind: "decision",
					decision: { decision: "reject", note: "approval-expired" },
					auto: true,
				});
			}
		}, timeoutMs);
	});

	let onAbort: (() => void) | undefined;
	const abortPromise = signal
		? new Promise<ResolvedApproval>((resolve) => {
				if (signal.aborted) {
					resolve({ kind: "decision", decision: { decision: "reject", note: "aborted" }, auto: true });
					return;
				}
				onAbort = () =>
					resolve({ kind: "decision", decision: { decision: "reject", note: "aborted" }, auto: true });
				signal.addEventListener("abort", onAbort, { once: true });
			})
		: undefined;

	const humanResolved = human.then(
		(decision): ResolvedApproval => ({ kind: "decision", decision }),
		(err): ResolvedApproval => ({
			kind: "fail",
			error: err instanceof Error ? err.message : String(err),
		}),
	);
	// Swallow unhandled rejection if the human promise never settles (timeout wins).
	humanResolved.catch(() => {});

	const racers: Promise<ResolvedApproval>[] = [humanResolved, expired];
	if (abortPromise) racers.push(abortPromise);
	try {
		return await Promise.race(racers);
	} finally {
		if (timer) clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}
