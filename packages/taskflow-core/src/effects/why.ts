/**
 * why-authorized / why-context / why-effect — pure explainers over effect + auth records.
 */

import type {
	ConfidentialityLabel,
	EffectDecl,
	EffectKind,
	IntegrityLabel,
	WhyAuthorized,
	WhyContext,
	WhyEffect,
} from "./types.ts";
import { EFFECT_KINDS } from "./types.ts";
import { pathRefRelativeKey, validateEffectFlow, validateEffectIR } from "./validate.ts";
import { defaultWorkspaceControlDirectory } from "../resources/execution.ts";
import { WriteIntentJournal, type WriteIntentRecord } from "../resources/journal.ts";

export interface WhyInput {
	effect: EffectDecl;
	runId: string;
	phaseId?: string;
	principalId?: string;
	/** Capability binding ids that covered this effect (if any). */
	capabilityBindingIds?: string[];
	/** Whether static/admit validation allowed the effect. */
	allowed: boolean;
	allowReasons: string[];
	denyReasons?: string[];
	intentId?: string;
	journalStatus?: string;
	status: WhyEffect["status"];
	workspaceRoot?: string;
	defaultConfidentiality?: ConfidentialityLabel;
	defaultIntegrity?: IntegrityLabel;
}

function targetSummary(effect: EffectDecl): string {
	const t = effect.target;
	if (t.kind === "path") {
		const key = pathRefRelativeKey(t.path);
		const ws = "workspace" in t.path ? t.path.workspace : "handle";
		return `path:${ws}:${key ?? "<dynamic>"}`;
	}
	if (t.kind === "secret") return `secret:${t.secret.secretId}`;
	return `service:${t.service.serviceId}${t.service.operation ? `:${t.service.operation}` : ""}`;
}

export function whyAuthorized(input: WhyInput): WhyAuthorized {
	const reasons = input.allowed
		? [...input.allowReasons]
		: [...(input.denyReasons ?? ["effect not authorized"])];
	if (input.allowed && reasons.length === 0) {
		reasons.push("effect declared on plan and passed validateEffectIR");
	}
	return {
		effectId: input.effect.id,
		allowed: input.allowed,
		principalId: input.principalId,
		capabilityBindingIds: input.capabilityBindingIds ?? [],
		reasons,
	};
}

export function whyContext(input: WhyInput): WhyContext {
	const confidentiality = input.effect.confidentiality ?? input.defaultConfidentiality ?? "internal";
	const integrity = input.effect.integrity ?? input.defaultIntegrity ?? "project";
	const reasons: string[] = [
		`run=${input.runId}`,
		`confidentiality=${confidentiality}`,
		`integrity=${integrity}`,
	];
	if (input.phaseId) reasons.push(`phase=${input.phaseId}`);
	if (input.workspaceRoot) reasons.push(`workspaceRoot=${input.workspaceRoot}`);
	return {
		effectId: input.effect.id,
		runId: input.runId,
		phaseId: input.phaseId,
		confidentiality,
		integrity,
		workspaceRoot: input.workspaceRoot,
		reasons,
	};
}

export function whyEffect(input: WhyInput): WhyEffect {
	const authorized = whyAuthorized(input);
	const context = whyContext(input);
	const reasons: string[] = [
		`kind=${input.effect.kind}`,
		`status=${input.status}`,
		...authorized.reasons,
	];
	if (input.effect.purpose) reasons.push(`purpose=${input.effect.purpose}`);
	if (input.intentId) reasons.push(`intent=${input.intentId}`);
	if (input.journalStatus) reasons.push(`journalStatus=${input.journalStatus}`);
	return {
		effectId: input.effect.id,
		kind: input.effect.kind,
		targetSummary: targetSummary(input.effect),
		purpose: input.effect.purpose,
		intentId: input.intentId,
		journalStatus: input.journalStatus,
		status: input.status,
		reasons,
		authorized,
		context,
	};
}

// ---------------------------------------------------------------------------
// Flow-scoped lookup: whyEffect(runId, effectId) surface for MCP / hosts
// ---------------------------------------------------------------------------

/** Minimal flow shape for effect lookup (Taskflow / FlowIR phases). */
export interface WhyEffectFlowLike {
	phases?: ReadonlyArray<{ id?: string; effects?: unknown; dependsOn?: unknown; from?: unknown } | null | undefined>;
}

export interface WhyEffectFromFlowInput {
	/** Flow definition that declares effects (typically RunState.def). */
	flow: WhyEffectFlowLike;
	runId: string;
	/** Effect id as declared, or `phaseId/effectId` composite. */
	effectId: string;
	/** Disambiguate when the same effect id appears on multiple phases. */
	phaseId?: string;
	workspaceRoot?: string;
	/** Runtime lifecycle status; MCP defaults to `declared` (read-only explain). */
	status?: WhyEffect["status"];
	intentId?: string;
	principalId?: string;
	capabilityBindingIds?: string[];
}

export type WhyEffectFromFlowResult =
	| { ok: true; why: WhyEffect; phaseId?: string }
	| { ok: false; error: string };

interface LocatedEffect {
	effect: EffectDecl;
	phaseId?: string;
	/** Id used for bag validation (phase-prefixed when from a phase). */
	bagId: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asEffectDecl(raw: unknown): EffectDecl | undefined {
	if (!isObject(raw)) return undefined;
	const id = raw.id;
	const kind = raw.kind;
	const target = raw.target;
	if (typeof id !== "string" || !id.trim()) return undefined;
	if (typeof kind !== "string" || !(EFFECT_KINDS as readonly string[]).includes(kind)) return undefined;
	if (!isObject(target) || typeof target.kind !== "string") return undefined;
	return raw as unknown as EffectDecl;
}

/** Collect declared effects from each phase (original ids preserved). */
export function collectDeclaredEffects(flow: WhyEffectFlowLike): LocatedEffect[] {
	const out: LocatedEffect[] = [];
	const phases = Array.isArray(flow.phases) ? flow.phases : [];
	for (const p of phases) {
		if (!p || typeof p !== "object") continue;
		const phaseId = typeof p.id === "string" ? p.id : undefined;
		const pe = p.effects;
		if (!Array.isArray(pe)) continue;
		for (const raw of pe) {
			const e = asEffectDecl(raw);
			if (e) {
				out.push({
					effect: e,
					phaseId,
					bagId: phaseId ? `${phaseId}/${e.id}` : e.id,
				});
			} else if (isObject(raw) && typeof raw.id === "string") {
				out.push({
					effect: raw as unknown as EffectDecl,
					phaseId,
					bagId: phaseId ? `${phaseId}/${raw.id}` : raw.id,
				});
			}
		}
	}
	return out;
}

function matchesEffectId(loc: LocatedEffect, effectId: string, phaseId?: string): boolean {
	if (phaseId !== undefined) {
		if (loc.phaseId !== phaseId) return false;
		return loc.effect.id === effectId || loc.bagId === effectId;
	}
	// Bare id, composite bag id, or phaseId/effectId string.
	if (loc.effect.id === effectId) return true;
	if (loc.bagId === effectId) return true;
	if (loc.phaseId && effectId === `${loc.phaseId}/${loc.effect.id}`) return true;
	return false;
}

/**
 * Pure: resolve a declared effect from a flow and explain authorization + context.
 *
 * Fail-closed: if static validation reports any error for this effect (or the
 * bag cannot be validated), `authorized.allowed` is false with deny reasons.
 * Missing effect → `{ ok: false }` (MCP returns isError).
 *
 * Zero tokens / no I/O. Runtime commit status is optional (`status` defaults
 * to `"declared"`). Use `whyEffectFromLedger` for authorization claims.
 */
export function whyEffectFromFlow(input: WhyEffectFromFlowInput): WhyEffectFromFlowResult {
	const effectId = input.effectId.trim();
	if (!effectId) return { ok: false, error: "effectId is required" };
	if (!input.runId.trim()) return { ok: false, error: "runId is required" };

	const located = collectDeclaredEffects(input.flow);
	if (located.length === 0) {
		return { ok: false, error: `No declared effects on run "${input.runId}" (flow has empty effects[]).` };
	}

	const matches = located.filter((l) => matchesEffectId(l, effectId, input.phaseId));
	if (matches.length === 0) {
		const known = located
			.map((l) => (l.phaseId ? `${l.phaseId}/${l.effect.id}` : l.effect.id))
			.slice(0, 12);
		const more = located.length > 12 ? ` (+${located.length - 12} more)` : "";
		const scope = input.phaseId ? ` in phase "${input.phaseId}"` : "";
		return {
			ok: false,
			error:
				`Effect "${effectId}" not found${scope} on run "${input.runId}". ` +
				`Known: ${known.join(", ") || "—"}${more}`,
		};
	}
	if (matches.length > 1) {
		const candidates = matches.map((m) =>
			m.phaseId ? `${m.phaseId}/${m.effect.id}` : m.effect.id,
		);
		return {
			ok: false,
			error:
				`Effect id "${effectId}" is ambiguous (matches ${matches.length} declarations: ` +
				`${candidates.join(", ")}). Pass phaseId to disambiguate.`,
		};
	}

	const hit = matches[0]!;
	const hitPhase = input.flow.phases?.find((phase) => phase?.id === hit.phaseId);
	const localValidation = validateEffectIR({ effects: hitPhase?.effects });
	const flowValidation = validateEffectFlow(
		(input.flow.phases ?? []).filter((phase): phase is NonNullable<typeof phase> => phase !== null && phase !== undefined),
	);
	const effectIssues = [...localValidation.issues, ...flowValidation.issues].filter(
		(i) =>
			i.effectId === hit.bagId ||
			i.effectId === hit.effect.id ||
			(hit.phaseId && i.effectId === `${hit.phaseId}/${hit.effect.id}`),
	);
	// Fail closed: any error on this effect, or unknown kind / malformed target, denies.
	const denyFromIssues = effectIssues
		.filter((i) => i.severity === "error")
		.map((i) => i.message);
	const kindOk = (EFFECT_KINDS as readonly string[]).includes(hit.effect.kind as EffectKind);
	if (!kindOk) {
		denyFromIssues.push(`unknown effect kind: ${String(hit.effect.kind)}`);
	}
	// Also deny if effect cannot form a coherent EffectDecl (asEffectDecl failed shape).
	const shapeOk = asEffectDecl(hit.effect) !== undefined;
	if (!shapeOk) {
		denyFromIssues.push("effect declaration is not a well-formed EffectDecl");
	}

	const allowed = denyFromIssues.length === 0;
	const status = input.status ?? "declared";
	const why = whyEffect({
		effect: hit.effect,
		runId: input.runId,
		phaseId: hit.phaseId,
		principalId: input.principalId,
		capabilityBindingIds: input.capabilityBindingIds,
		allowed,
		allowReasons: allowed
			? ["declared on flow plan", "validateEffectIR ok for this effect"]
			: [],
		denyReasons: allowed ? undefined : denyFromIssues,
		intentId: input.intentId,
		status,
		workspaceRoot: input.workspaceRoot,
	});
	return { ok: true, why, phaseId: hit.phaseId };
}

export interface WhyEffectFromLedgerInput extends Omit<WhyEffectFromFlowInput, "status" | "intentId" | "principalId" | "capabilityBindingIds"> {
	intents: readonly WriteIntentRecord[];
	ledgerError?: string;
}

function lifecycleStatus(status: WriteIntentRecord["status"]): WhyEffect["status"] {
	if (status === "pending") return "staged";
	if (status === "committed-content" || status === "committed-generation") return "committed";
	if (status === "dirty-unknown") return "unknown";
	return "rejected";
}

/**
 * Explain authority from the durable resource ledger, not from declaration
 * alone. A statically valid effect without a matching write intent remains
 * unauthorized because no mutation permit was durably admitted for it.
 */
export function whyEffectFromLedger(input: WhyEffectFromLedgerInput): WhyEffectFromFlowResult {
	const declared = whyEffectFromFlow({
		flow: input.flow,
		runId: input.runId,
		effectId: input.effectId,
		phaseId: input.phaseId,
		workspaceRoot: input.workspaceRoot,
		status: "declared",
	});
	if (!declared.ok) return declared;
	const phaseId = declared.phaseId;
	const matches = input.intents
		.filter((intent) =>
			intent.owner.runId === input.runId &&
			(phaseId === undefined || intent.owner.phaseId === phaseId) &&
			intent.scopes.some((scope) => scope.effectId === declared.why.effectId))
		.sort((left, right) => right.intentSequence - left.intentSequence);
	const intent = matches[0];
	const staticAllowed = declared.why.authorized.allowed;
	if (!intent) {
		const reason = input.ledgerError
			? `durable resource ledger unavailable: ${input.ledgerError}`
			: "no durable resource intent admitted this effect for the requested run/phase";
		return {
			ok: true,
			phaseId,
			why: {
				...declared.why,
				status: "declared",
				reasons: [`kind=${declared.why.kind}`, "status=declared", reason],
				authorized: {
					...declared.why.authorized,
					allowed: false,
					principalId: undefined,
					capabilityBindingIds: [],
					reasons: staticAllowed
						? [reason]
						: [...declared.why.authorized.reasons, reason],
				},
			},
		};
	}
	const effectScopes = intent.scopes.filter((scope) => scope.effectId === declared.why.effectId);
	const capabilityBindingIds = [...new Set(effectScopes
		.map((scope) => scope.capabilityBindingId)
		.filter((value): value is string => typeof value === "string" && value.length > 0))];
	const allowed = staticAllowed && capabilityBindingIds.length > 0 && intent.authorizationPrincipalId !== undefined;
	const ledgerReasons = [
		`durable resource intent ${intent.intentId}`,
		`journal status ${intent.status}`,
		`scope evidence ${effectScopes.length}`,
		...(intent.commitGeneration === undefined ? [] : [`commit generation ${intent.commitGeneration}`]),
	];
	if (capabilityBindingIds.length === 0) ledgerReasons.push("missing capability binding evidence");
	if (!intent.authorizationPrincipalId) ledgerReasons.push("missing authenticated principal evidence");
	return {
		ok: true,
		phaseId,
		why: {
			...declared.why,
			intentId: intent.intentId,
			journalStatus: intent.status,
			status: lifecycleStatus(intent.status),
			reasons: [
				`kind=${declared.why.kind}`,
				`status=${lifecycleStatus(intent.status)}`,
				...ledgerReasons,
			],
			authorized: {
				effectId: declared.why.effectId,
				allowed,
				principalId: intent.authorizationPrincipalId,
				capabilityBindingIds,
				reasons: staticAllowed ? ledgerReasons : [...declared.why.authorized.reasons, ...ledgerReasons],
			},
		},
	};
}

export async function whyEffectFromDurableJournal(
	input: Omit<WhyEffectFromLedgerInput, "intents" | "ledgerError"> & { controlDirectory?: string },
): Promise<WhyEffectFromFlowResult> {
	try {
		const directory = input.controlDirectory ?? defaultWorkspaceControlDirectory(input.workspaceRoot ?? process.cwd());
		const intents = await new WriteIntentJournal({ directory, journalEpoch: 1 }).listIntents();
		return whyEffectFromLedger({ ...input, intents });
	} catch (error) {
		return whyEffectFromLedger({
			...input,
			intents: [],
			ledgerError: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Plain-text render for MCP / CLI (no markdown fences). */
export function formatWhyEffect(why: WhyEffect): string {
	const lines: string[] = [
		`why-effect ${why.effectId}`,
		`  kind: ${why.kind}`,
		`  target: ${why.targetSummary}`,
		`  status: ${why.status}`,
		`  authorized: ${why.authorized.allowed ? "yes" : "NO (fail-closed)"}`,
	];
	if (why.purpose) lines.push(`  purpose: ${why.purpose}`);
	if (why.intentId) lines.push(`  intent: ${why.intentId}`);
	if (why.journalStatus) lines.push(`  journalStatus: ${why.journalStatus}`);
	if (why.context.phaseId) lines.push(`  phase: ${why.context.phaseId}`);
	lines.push(`  confidentiality: ${why.context.confidentiality}`);
	lines.push(`  integrity: ${why.context.integrity}`);
	if (why.context.workspaceRoot) lines.push(`  workspaceRoot: ${why.context.workspaceRoot}`);
	lines.push("  reasons:");
	for (const r of why.reasons) lines.push(`    • ${r}`);
	if (why.authorized.reasons.length > 0) {
		lines.push("  authorization:");
		for (const r of why.authorized.reasons) lines.push(`    • ${r}`);
	}
	return lines.join("\n");
}
