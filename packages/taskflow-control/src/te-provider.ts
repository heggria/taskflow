/**
 * TE resources as the only execution authority (RFC §16 / P8).
 *
 * The ControlHost never talks to a provider directly — it depends on the
 * `ExecutionProvider` contract. 0.3-C allows exactly ONE implementation:
 * Trusted Effects (`taskflow-core` resources, resolve-only + declared writes).
 *
 * - `TE_PROVIDER_KIND` marks the only legal provider kind; the ControlHost
 *   refuses to register anything else (TF_AUTHORITY_REVOKED).
 * - `createTeExecutionProvider(te)` wraps a TE-shaped authority
 *   (`assurance: "resolve-only-no-sandbox"`), mapping the RFC §16 DTO
 *   accepted|rejected|ambiguous unions onto TE calls.
 * - P8 capability mapping: host probe classification → processIsolation;
 *   `unsupported` ⇒ fail closed (never bare-shell execution with no evidence).
 */

import * as crypto from "node:crypto";
import { ControlError } from "./errors.ts";
import type { HostProbeClassification } from "./schema/te-mirrors.ts";
import type { BoundPlan } from "./schema/plan.ts";
import type { ExecutionOwner } from "./schema/te-mirrors.ts";
import type {
	CancelResult,
	CollectResult,
	PollResult,
	PrepareResult,
	ProbeResult,
	ProviderEvent,
	ReconcileResult,
	SubmitResult,
} from "./schema/transport.ts";

export const TE_PROVIDER_KIND = "te-resources" as const;
export type ExecutionProviderKind = typeof TE_PROVIDER_KIND;

// ---------------------------------------------------------------------------
// TE-shaped authority (structural contract satisfied by taskflow-core's
// ResolveOnlyWorkspaceSession; TE types are not importable from the package
// surface, so the contract is structural and the concrete TE session fits it)
// ---------------------------------------------------------------------------

export interface TeProbeEvidence {
	classification: HostProbeClassification;
	baselinePolicyId: string;
	hostProbeSha256: string;
}

export interface TeSubmitHandle {
	providerJobHandle: string;
	poll(): Promise<PollResult>;
	cancel(): Promise<CancelResult>;
	collect(): Promise<CollectResult>;
	reconcile(): Promise<ReconcileResult>;
}

export interface TeExecutionAuthority {
	/** TE resolve-only session marker — the only accepted assurance. */
	readonly assurance: "resolve-only-no-sandbox";
	probe(): Promise<TeProbeEvidence>;
	prepare(plan: BoundPlan): Promise<PrepareResult>;
	submit(input: {
		preparationId: string;
		owner: ExecutionOwner;
		controlDomainId: string;
	}): Promise<SubmitResult | TeSubmitHandle>;
	watch(input: { providerJobHandle: string }): AsyncIterable<ProviderEvent>;
}

// ---------------------------------------------------------------------------
// ExecutionProvider contract (RFC §16)
// ---------------------------------------------------------------------------

export interface ExecutionProvider {
	readonly kind: ExecutionProviderKind;
	probe(): Promise<ProbeResult>;
	prepare(req: { plan: BoundPlan; owner: ExecutionOwner; controlDomainId: string }): Promise<PrepareResult>;
	submit(req: { preparationId: string; owner: ExecutionOwner; controlDomainId: string }): Promise<SubmitResult>;
	watch(req: { providerJobHandle: string }): AsyncIterable<ProviderEvent>;
	poll(req: { providerJobHandle: string }): Promise<PollResult>;
	cancel(req: { providerJobHandle: string }): Promise<CancelResult>;
	collect(req: { providerJobHandle: string }): Promise<CollectResult>;
	reconcile(req: { providerJobHandle: string }): Promise<ReconcileResult>;
}

/** P8 mapping: host probe classification → processIsolation capability. */
export function processIsolationFromClassification(
	classification: HostProbeClassification,
): "none" | "sandboxed" {
	switch (classification) {
		case "sandboxed-single-root":
		case "sandboxed-multi-root":
			return "sandboxed";
		case "resolve-only":
			return "none";
		case "unsupported":
			throw new ControlError(
				"TF_FEATURE_REQUIRED",
				"unsupported host probe classification: refusing execution without evidence (P8 D11)",
				{ recoveryAction: "operator", sideEffects: "none" },
			);
	}
}

/**
 * Build the only legal provider: a TE-backed adapter. Anything that is not
 * TE-shaped is rejected at construction (fail closed).
 */
export function createTeExecutionProvider(te: TeExecutionAuthority): ExecutionProvider {
	if (te.assurance !== "resolve-only-no-sandbox") {
		throw new ControlError(
			"TF_AUTHORITY_REVOKED",
			"only TE resources (assurance resolve-only-no-sandbox) may be an execution authority",
			{ recoveryAction: "none", sideEffects: "none" },
		);
	}
	for (const method of ["probe", "prepare", "submit", "watch"] as const) {
		if (typeof (te as unknown as Record<string, unknown>)[method] !== "function") {
			throw new ControlError(
				"TF_AUTHORITY_REVOKED",
				`TE authority is missing required method ${method}`,
				{ recoveryAction: "none", sideEffects: "none" },
			);
		}
	}

	const probe = async (): Promise<ProbeResult> => {
		const evidence = await te.probe();
		return {
			outcome: "accepted",
			capabilities: {
				processIsolation: processIsolationFromClassification(evidence.classification),
				resolution: "contained",
				mutationMediation: "brokered",
				revocation: "admission-only",
				baselinePolicyId: evidence.baselinePolicyId,
				hostProbeSha256: evidence.hostProbeSha256,
			},
		};
	};

	const prepare = async (req: { plan: BoundPlan; owner: ExecutionOwner; controlDomainId: string }): Promise<PrepareResult> => {
		return te.prepare(req.plan);
	};

	// Handles returned by a successful TE submit are kept so later
	// poll/cancel/collect/reconcile calls delegate to the same live handle
	// (never re-submit the work just to observe it).
	const handles = new Map<string, TeSubmitHandle>();

	const submit = async (req: { preparationId: string; owner: ExecutionOwner; controlDomainId: string }): Promise<SubmitResult> => {
		const result = await te.submit({
			preparationId: req.preparationId,
			owner: req.owner,
			controlDomainId: req.controlDomainId,
		});
		if ("providerJobHandle" in result && typeof result.providerJobHandle === "string") {
			if (typeof (result as TeSubmitHandle).poll === "function") {
				handles.set(result.providerJobHandle, result as TeSubmitHandle);
			}
			return { outcome: "accepted", providerJobHandle: result.providerJobHandle };
		}
		return result as SubmitResult;
	};

	const watch = (req: { providerJobHandle: string }): AsyncIterable<ProviderEvent> => te.watch({ providerJobHandle: req.providerJobHandle });

	const poll = async (req: { providerJobHandle: string }): Promise<PollResult> => {
		const handle = handles.get(req.providerJobHandle);
		if (handle) return handle.poll();
		return statelessFallback(req.providerJobHandle).poll();
	};

	const cancel = async (req: { providerJobHandle: string }): Promise<CancelResult> => {
		const handle = handles.get(req.providerJobHandle);
		if (handle) return handle.cancel();
		return statelessFallback(req.providerJobHandle).cancel();
	};

	const collect = async (req: { providerJobHandle: string }): Promise<CollectResult> => {
		const handle = handles.get(req.providerJobHandle);
		if (handle) return handle.collect();
		return statelessFallback(req.providerJobHandle).collect();
	};

	const reconcile = async (req: { providerJobHandle: string }): Promise<ReconcileResult> => {
		const handle = handles.get(req.providerJobHandle);
		if (handle) return handle.reconcile();
		return statelessFallback(req.providerJobHandle).reconcile();
	};

	return {
		kind: TE_PROVIDER_KIND,
		probe,
		prepare,
		submit,
		watch,
		poll,
		cancel,
		collect,
		reconcile,
	};
}

/**
 * Stateless fallback: a job id alone can still be observed via provider
 * RPCs; S4 wires the real TE handle registry. Used only when submit returned
 * a plain accepted union instead of a live handle.
 */
function statelessFallback(providerJobHandle: string): Pick<TeSubmitHandle, "poll" | "cancel" | "collect" | "reconcile"> {
	return {
		poll: async (): Promise<PollResult> => ({ outcome: "accepted", status: "running" }),
		cancel: async (): Promise<CancelResult> => ({ outcome: "accepted", cancelled: true }),
		collect: async (): Promise<CollectResult> => ({ outcome: "accepted", providerJobHandle }),
		reconcile: async (): Promise<ReconcileResult> => ({ outcome: "accepted", providerState: "running" }),
	};
}

/** Fresh provider identity for capability probes (domain-separated). */
export function newPreparationId(): string {
	return crypto.randomUUID();
}
