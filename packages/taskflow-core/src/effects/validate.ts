/**
 * Static EffectIR validation: kinds, refs, labels, mutating-path overlap.
 * Pure — no I/O.
 */

import { normalizePortableRelativePath, type PathRef } from "../resources/schema.ts";
import { Value } from "typebox/value";
import { EffectDeclSchema } from "./schema.ts";
import {
	CONFIDENTIALITY_LABELS,
	CONFIDENTIALITY_RANK,
	EFFECT_KINDS,
	INTEGRITY_LABELS,
	INTEGRITY_RANK,
	type ConfidentialityLabel,
	type EffectDecl,
	type EffectIR,
	type EffectKind,
	type IntegrityLabel,
	type SecretRef,
	type ServiceRef,
} from "./types.ts";

export interface EffectValidationIssue {
	severity: "error" | "warning";
	code: string;
	message: string;
	effectId?: string;
	pathA?: string;
	pathB?: string;
}

export interface EffectValidationResult {
	ok: boolean;
	issues: EffectValidationIssue[];
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isConf(v: unknown): v is ConfidentialityLabel {
	return typeof v === "string" && (CONFIDENTIALITY_LABELS as readonly string[]).includes(v);
}

function isInteg(v: unknown): v is IntegrityLabel {
	return typeof v === "string" && (INTEGRITY_LABELS as readonly string[]).includes(v);
}

function isEffectKind(v: unknown): v is EffectKind {
	return typeof v === "string" && (EFFECT_KINDS as readonly string[]).includes(v);
}

type ValidEffectRecord = Record<string, unknown> & { id: string; kind: EffectKind };

const SOURCE_KINDS: ReadonlySet<EffectKind> = new Set(["fs.read", "secret.read"]);
const SINK_KINDS: ReadonlySet<EffectKind> = new Set(["fs.write", "service.call"]);

function confidentialityOf(item: ValidEffectRecord): ConfidentialityLabel {
	return isConf(item.confidentiality) ? item.confidentiality : item.kind === "secret.read" ? "secret" : "internal";
}

function integrityOf(item: ValidEffectRecord): IntegrityLabel {
	return isInteg(item.integrity) ? item.integrity : "project";
}

function labelFlowIssues(
	source: ValidEffectRecord,
	sink: ValidEffectRecord,
	sourceLabel = source.id,
	sinkLabel = sink.id,
): EffectValidationIssue[] {
	const issues: EffectValidationIssue[] = [];
	// Two unresolved composition boundaries carry taint but do not create a
	// concrete source→sink edge by themselves. Keep the taint flowing until it
	// meets a declared effect; otherwise ordinary dynamic composition would
	// reject solely because two unknown summaries are sequenced.
	if (source.__unknownBoundary === true && sink.__unknownBoundary === true) return issues;
	const sourceConf = confidentialityOf(source);
	const sinkConf = confidentialityOf(sink);
	const sourceIntegrity = integrityOf(source);
	const sinkIntegrity = integrityOf(sink);
	if (CONFIDENTIALITY_RANK[sourceConf] > CONFIDENTIALITY_RANK[sinkConf]) {
		issues.push({
			severity: "error",
			code: "confidentiality-flow-violation",
			message: `source effect '${sourceLabel}' (${sourceConf}) cannot flow to sink '${sinkLabel}' (${sinkConf})`,
			effectId: sinkLabel,
		});
	}
	if (INTEGRITY_RANK[sourceIntegrity] < INTEGRITY_RANK[sinkIntegrity]) {
		issues.push({
			severity: "error",
			code: "integrity-flow-violation",
			message: `source effect '${sourceLabel}' (${sourceIntegrity}) cannot satisfy sink '${sinkLabel}' integrity (${sinkIntegrity})`,
			effectId: sinkLabel,
		});
	}
	return issues;
}

/** Extract portable relative path string from a PathRef for overlap checks. */
export function pathRefRelativeKey(pathRef: PathRef): string | undefined {
	const sub = pathRef.subpath;
	if (!sub) return "";
	if ("literalPath" in sub && typeof sub.literalPath === "string") {
		const n = normalizePortableRelativePath(sub.literalPath);
		return n.ok ? n.value : undefined;
	}
	// Dynamic arg/segments paths cannot be fully resolved statically.
	return undefined;
}

/**
 * True if path A is the same as, a parent of, or a child of path B
 * (portable `/` paths, no `..`).
 */
export function pathsOverlap(a: string, b: string): boolean {
	if (a === b) return true;
	if (a === "" || b === "") return true; // whole workspace
	const ap = a.endsWith("/") ? a.slice(0, -1) : a;
	const bp = b.endsWith("/") ? b.slice(0, -1) : b;
	return ap.startsWith(bp + "/") || bp.startsWith(ap + "/");
}

function validateSecretRef(s: unknown, effectId: string, issues: EffectValidationIssue[]): void {
	if (!isObject(s) || typeof s.secretId !== "string" || !s.secretId.trim()) {
		issues.push({
			severity: "error",
			code: "invalid-secret-ref",
			message: `effect '${effectId}': secret target requires non-empty secretId`,
			effectId,
		});
		return;
	}
	if ("value" in s || "material" in s || "token" in s) {
		issues.push({
			severity: "error",
			code: "secret-material-forbidden",
			message: `effect '${effectId}': SecretRef must not carry secret material fields`,
			effectId,
		});
	}
}

function validateServiceRef(s: unknown, effectId: string, issues: EffectValidationIssue[]): void {
	if (!isObject(s) || typeof s.serviceId !== "string" || !s.serviceId.trim()) {
		issues.push({
			severity: "error",
			code: "invalid-service-ref",
			message: `effect '${effectId}': service target requires non-empty serviceId`,
			effectId,
		});
	}
}

function validatePathTarget(pathRef: unknown, effectId: string, issues: EffectValidationIssue[]): PathRef | undefined {
	if (!isObject(pathRef)) {
		issues.push({
			severity: "error",
			code: "invalid-path-ref",
			message: `effect '${effectId}': path target must be a PathRef object`,
			effectId,
		});
		return undefined;
	}
	const hasWorkspace = typeof pathRef.workspace === "string" && pathRef.workspace.length > 0;
	const hasHandle = isObject(pathRef.handle);
	if (hasWorkspace === hasHandle) {
		issues.push({
			severity: "error",
			code: "invalid-path-ref",
			message: `effect '${effectId}': PathRef needs exactly one of workspace or handle`,
			effectId,
		});
		return undefined;
	}
	if (!pathRef.intent || typeof pathRef.intent !== "string") {
		issues.push({
			severity: "error",
			code: "invalid-path-ref",
			message: `effect '${effectId}': PathRef.intent is required`,
			effectId,
		});
		return undefined;
	}
	return pathRef as unknown as PathRef;
}

const MUTATING_KINDS: ReadonlySet<EffectKind> = new Set(["fs.write", "fs.delete"]);

/**
 * Validate an EffectIR bag: shape, labels, target/kind consistency, overlap.
 */
export function validateEffectIR(ir: EffectIR | { effects?: unknown }): EffectValidationResult {
	const issues: EffectValidationIssue[] = [];
	const raw = ir?.effects;
	if (raw === undefined) return { ok: true, issues: [] };
	if (!Array.isArray(raw)) {
		return {
			ok: false,
			issues: [{ severity: "error", code: "effects-not-array", message: "effects must be an array" }],
		};
	}

	const seenIds = new Set<string>();
	const mutating: Array<{ effectId: string; pathKey: string }> = [];

	for (const item of raw) {
		if (!isObject(item)) {
			issues.push({ severity: "error", code: "effect-not-object", message: "each effect must be an object" });
			continue;
		}
		if (!Value.Check(EffectDeclSchema, item)) {
			issues.push({
				severity: "error",
				code: "invalid-effect-shape",
				message: `effect '${typeof item.id === "string" ? item.id : "<unknown>"}': declaration is outside the closed EffectIR schema`,
				effectId: typeof item.id === "string" ? item.id : undefined,
			});
		}
		const id = item.id;
		if (typeof id !== "string" || !id.trim()) {
			issues.push({ severity: "error", code: "effect-id-required", message: "effect.id is required" });
			continue;
		}
		if (seenIds.has(id)) {
			issues.push({
				severity: "error",
				code: "duplicate-effect-id",
				message: `duplicate effect id '${id}'`,
				effectId: id,
			});
		}
		seenIds.add(id);

		if (!isEffectKind(item.kind)) {
			issues.push({
				severity: "error",
				code: "unknown-effect-kind",
				message: `effect '${id}': unknown kind ${String(item.kind)}`,
				effectId: id,
			});
			continue;
		}
		const kind = item.kind;

		if (item.confidentiality !== undefined && !isConf(item.confidentiality)) {
			issues.push({
				severity: "error",
				code: "invalid-confidentiality",
				message: `effect '${id}': invalid confidentiality label`,
				effectId: id,
			});
		}
		if (item.integrity !== undefined && !isInteg(item.integrity)) {
			issues.push({
				severity: "error",
				code: "invalid-integrity",
				message: `effect '${id}': invalid integrity label`,
				effectId: id,
			});
		}

		const target = item.target;
		if (!isObject(target) || typeof target.kind !== "string") {
			issues.push({
				severity: "error",
				code: "invalid-target",
				message: `effect '${id}': target.kind is required`,
				effectId: id,
			});
			continue;
		}

		if (kind.startsWith("fs.")) {
			if (target.kind !== "path") {
				issues.push({
					severity: "error",
					code: "target-kind-mismatch",
					message: `effect '${id}': fs.* requires target.kind === "path"`,
					effectId: id,
				});
			} else {
				const pref = validatePathTarget(target.path, id, issues);
				if (pref && MUTATING_KINDS.has(kind)) {
					const key = pathRefRelativeKey(pref);
					if (key === undefined) {
						issues.push({
							severity: "warning",
							code: "dynamic-path-overlap-unknown",
							message: `effect '${id}': mutating path is dynamic; overlap cannot be proven statically`,
							effectId: id,
						});
					} else {
						mutating.push({ effectId: id, pathKey: key });
					}
				}
			}
		} else if (kind === "secret.read") {
			if (target.kind !== "secret") {
				issues.push({
					severity: "error",
					code: "target-kind-mismatch",
					message: `effect '${id}': secret.read requires target.kind === "secret"`,
					effectId: id,
				});
			} else {
				validateSecretRef(target.secret, id, issues);
			}
		} else if (kind === "service.call") {
			if (target.kind !== "service") {
				issues.push({
					severity: "error",
					code: "target-kind-mismatch",
					message: `effect '${id}': service.call requires target.kind === "service"`,
					effectId: id,
				});
			} else {
				validateServiceRef(target.service, id, issues);
			}
		}
	}

	// Mutating path overlap (static)
	for (let i = 0; i < mutating.length; i++) {
		for (let j = i + 1; j < mutating.length; j++) {
			const a = mutating[i]!;
			const b = mutating[j]!;
			if (pathsOverlap(a.pathKey, b.pathKey)) {
				issues.push({
					severity: "error",
					code: "mutating-path-overlap",
					message:
						`mutating effects '${a.effectId}' and '${b.effectId}' overlap on path ` +
						`('${a.pathKey || "<workspace>"}' vs '${b.pathKey || "<workspace>"}')`,
					effectId: a.effectId,
					pathA: a.pathKey,
					pathB: b.pathKey,
				});
			}
		}
	}

	// Conservative information-flow check. Read declarations are sources;
	// writes/calls are sinks. Without an explicit data-flow subgraph, every
	// declared source may influence every declared sink in the same phase.
	// Confidentiality may only flow upward (sink clearance >= source label),
	// while integrity may only flow downward (source trust >= sink requirement).
	const valid = raw.filter((item): item is ValidEffectRecord =>
		isObject(item) && typeof item.id === "string" && isEffectKind(item.kind));
	const sources = valid.filter((item) => SOURCE_KINDS.has(item.kind));
	const sinks = valid.filter((item) => SINK_KINDS.has(item.kind));
	for (const source of sources) {
		for (const sink of sinks) {
			issues.push(...labelFlowIssues(source, sink));
		}
	}

	const ok = !issues.some((i) => i.severity === "error");
	return { ok, issues };
}

export interface EffectFlowPhaseLike {
	id?: unknown;
	effects?: unknown;
	dependsOn?: unknown;
	from?: unknown;
	type?: unknown;
	def?: unknown;
	use?: unknown;
	final?: unknown;
}

export interface ComposedEffectFlowLike {
	name?: unknown;
	phases?: readonly EffectFlowPhaseLike[];
}

interface LabeledEffect {
	label: string;
	effect: ValidEffectRecord;
}

interface PhaseEffectSummary {
	sources: LabeledEffect[];
	sinks: LabeledEffect[];
}

export interface ComposedEffectFlowOptions {
	resolveFlow?: (name: string) => ComposedEffectFlowLike | undefined;
}

function directPhaseSummary(phase: EffectFlowPhaseLike, phaseLabel: string): PhaseEffectSummary {
	const sources: LabeledEffect[] = [];
	const sinks: LabeledEffect[] = [];
	for (const raw of Array.isArray(phase.effects) ? phase.effects : []) {
		if (!isObject(raw) || typeof raw.id !== "string" || !isEffectKind(raw.kind)) continue;
		const effect = raw as ValidEffectRecord;
		const labeled = { label: `${phaseLabel}/${effect.id}`, effect };
		if (SOURCE_KINDS.has(effect.kind)) sources.push(labeled);
		if (SINK_KINDS.has(effect.kind)) sinks.push(labeled);
	}
	return { sources, sinks };
}

function unknownBoundarySummary(phaseLabel: string): PhaseEffectSummary {
	return {
		sources: [{
			label: `${phaseLabel}/<dynamic-source>`,
			effect: {
				id: "<dynamic-source>",
				kind: "secret.read",
				confidentiality: "secret",
				integrity: "untrusted",
				__unknownBoundary: true,
				target: { kind: "secret", secret: { secretId: "<dynamic>" } },
			},
		}],
		sinks: [{
			label: `${phaseLabel}/<dynamic-sink>`,
			effect: {
				id: "<dynamic-sink>",
				kind: "service.call",
				confidentiality: "public",
				integrity: "verified",
				__unknownBoundary: true,
				target: { kind: "service", service: { serviceId: "<dynamic>" } },
			},
		}],
	};
}

function parseInlineFlow(raw: unknown): ComposedEffectFlowLike | undefined {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			return undefined;
		}
	}
	if (Array.isArray(value)) return { phases: value as EffectFlowPhaseLike[] };
	if (!isObject(value) || !Array.isArray(value.phases)) return undefined;
	return { name: value.name, phases: value.phases as EffectFlowPhaseLike[] };
}

/**
 * Conservative DAG-wide label flow. Every source reachable through a phase's
 * dependencies may influence that phase's sinks, including through unlabeled
 * intermediate phases. This is a pure static check; conditional branches are
 * intentionally not used to declassify data.
 */
export function validateEffectFlow(
	phases: readonly EffectFlowPhaseLike[],
	dependencyIds: (phase: EffectFlowPhaseLike) => readonly string[] = (phase) => [
		...(Array.isArray(phase.dependsOn) ? phase.dependsOn.filter((id): id is string => typeof id === "string") : []),
		...(Array.isArray(phase.from) ? phase.from.filter((id): id is string => typeof id === "string") : []),
	],
	phaseSummaries?: ReadonlyMap<string, PhaseEffectSummary>,
): EffectValidationResult {
	const issues: EffectValidationIssue[] = [];
	const byId = new Map<string, EffectFlowPhaseLike>();
	const ownSources = new Map<string, Map<string, ValidEffectRecord>>();
	const sinks = new Map<string, LabeledEffect[]>();
	for (const phase of phases) {
		if (typeof phase.id !== "string" || !phase.id) continue;
		byId.set(phase.id, phase);
		const summary = phaseSummaries?.get(phase.id) ?? directPhaseSummary(phase, phase.id);
		ownSources.set(phase.id, new Map(summary.sources.map(({ label, effect }) => [label, effect])));
		sinks.set(phase.id, summary.sinks);
	}
	const reachable = new Map([...ownSources].map(([id, sources]) => [id, new Map(sources)]));
	for (let pass = 0; pass < byId.size; pass++) {
		let changed = false;
		for (const [phaseId, phase] of byId) {
			const target = reachable.get(phaseId)!;
			for (const depId of dependencyIds(phase)) {
				for (const [sourceId, source] of reachable.get(depId) ?? []) {
					if (!target.has(sourceId)) {
						target.set(sourceId, source);
						changed = true;
					}
				}
			}
		}
		if (!changed) break;
	}
	for (const phaseId of byId.keys()) {
		const ownSourceIds = new Set(ownSources.get(phaseId)?.keys() ?? []);
		const upstreamSources = [...(reachable.get(phaseId) ?? [])]
			.filter(([sourceId]) => !ownSourceIds.has(sourceId));
		if (upstreamSources.length === 0) continue;
		for (const { label: sinkLabel, effect: sink } of sinks.get(phaseId) ?? []) {
			for (const [sourceId, source] of upstreamSources) {
				issues.push(...labelFlowIssues(source, sink, sourceId, sinkLabel));
			}
		}
	}
	return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

interface ComposedSummaryResult extends EffectValidationResult {
	summary: PhaseEffectSummary;
}

function summarizeComposedEffectFlow(
	flow: ComposedEffectFlowLike,
	options: ComposedEffectFlowOptions,
	prefix: string,
	seenUses: ReadonlySet<string>,
): ComposedSummaryResult {
	const phases = Array.isArray(flow.phases) ? flow.phases : [];
	const issues: EffectValidationIssue[] = [];
	const summaries = new Map<string, PhaseEffectSummary>();
	for (const phase of phases) {
		if (typeof phase.id !== "string" || !phase.id) continue;
		const phaseLabel = `${prefix}${phase.id}`;
		if (prefix && phase.effects !== undefined) {
			issues.push(...validateEffectIR({ effects: phase.effects }).issues.map((issue) => ({
				...issue,
				effectId: issue.effectId ? `${phaseLabel}/${issue.effectId}` : phaseLabel,
				message: issue.effectId
					? issue.message.replace(`'${issue.effectId}'`, `'${phaseLabel}/${issue.effectId}'`)
					: `${phaseLabel}: ${issue.message}`,
			})));
		}
		const summary = directPhaseSummary(phase, phaseLabel);
		const type = phase.type ?? "agent";
		if (type === "flow" || type === "expand") {
			let child: ComposedEffectFlowLike | undefined;
			let childSeen = seenUses;
			if (phase.def !== undefined) {
				child = parseInlineFlow(phase.def);
			} else if (type === "flow" && typeof phase.use === "string" && phase.use) {
				if (!seenUses.has(phase.use)) {
					try {
						child = options.resolveFlow?.(phase.use);
					} catch {
						child = undefined;
					}
					childSeen = new Set([...seenUses, phase.use]);
				}
			}
			const childResult = child
				? summarizeComposedEffectFlow(child, options, `${phaseLabel}/`, childSeen)
				: { ok: true, issues: [], summary: unknownBoundarySummary(phaseLabel) };
			issues.push(...childResult.issues);
			summary.sources.push(...childResult.summary.sources);
			summary.sinks.push(...childResult.summary.sinks);
		}
		summaries.set(phase.id, summary);
	}
	const flowResult = validateEffectFlow(phases, undefined, summaries);
	issues.push(...flowResult.issues);
	return {
		ok: !issues.some((issue) => issue.severity === "error"),
		issues,
		summary: {
			sources: [...summaries.values()].flatMap((summary) => summary.sources),
			sinks: [...summaries.values()].flatMap((summary) => summary.sinks),
		},
	};
}

/**
 * Validate label flow across nested flow/expand boundaries. Child sources are
 * summarized onto the parent node and child sinks receive the parent's
 * dependency-reachable sources. Unresolved saved/dynamic children expose a
 * maximally confidential source and public sink until runtime resolution.
 */
export function validateComposedEffectFlow(
	flow: ComposedEffectFlowLike,
	options: ComposedEffectFlowOptions = {},
): EffectValidationResult {
	const result = summarizeComposedEffectFlow(flow, options, "", new Set());
	return { ok: result.ok, issues: result.issues };
}

/** Type guard for a well-formed SecretRef (no material). */
export function isSecretRef(v: unknown): v is SecretRef {
	return isObject(v) && typeof v.secretId === "string" && v.secretId.length > 0 && !("value" in v) && !("material" in v);
}

/** Type guard for ServiceRef. */
export function isServiceRef(v: unknown): v is ServiceRef {
	return isObject(v) && typeof v.serviceId === "string" && v.serviceId.length > 0;
}

/** Collect mutating path keys from effects (static literals only). */
export function collectMutatingPathKeys(effects: EffectDecl[]): Array<{ effectId: string; pathKey: string }> {
	const out: Array<{ effectId: string; pathKey: string }> = [];
	for (const e of effects) {
		if (!MUTATING_KINDS.has(e.kind)) continue;
		if (e.target.kind !== "path") continue;
		const key = pathRefRelativeKey(e.target.path);
		if (key !== undefined) out.push({ effectId: e.id, pathKey: key });
	}
	return out;
}
