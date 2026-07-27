/**
 * P16-1R E-1/E0 first-provider-attempt contract.
 *
 * This is deliberately narrower than the 0.2 scheduler: it accepts exactly one
 * fully static Script provider call whose selected live route exposes atomic
 * getOrCreate. It performs no I/O. A future schema-2 admission writer persists
 * the returned tuple with AdmissionIntentRecordedV2 + DispatchAttemptPlanned
 * before coordinator reservation.
 */
import { hashRequest } from "./hash.ts";
import type { BoundPlan } from "./types.ts";
import { isSafeId } from "./validate-ids.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^p16fd_[a-f0-9]{64}$/;
const FLOW_KEYS = ["name", "phases"] as const;
const SCRIPT_KEYS = ["id", "type", "run", "input", "timeout", "final"] as const;

export const FIRST_DISPATCH_CAPABILITY_KIND = "p16-1r-atomic-get-or-create-v1";

export interface FirstDispatchGetOrCreateRequest {
	providerName: string;
	providerContractVersion: string;
	providerRouteDigest: string;
	admissionId: string;
	runId: string;
	continuationId: string;
	attemptId: "first";
	phaseId: string;
	idempotencyKey: string;
	requestDigest: string;
}

export type FirstDispatchGetOrCreateResult =
	| {
			kind: "created" | "found";
			handle: string;
			echoedExactTuple: Readonly<FirstDispatchGetOrCreateRequest>;
	  }
	| { kind: "conflict"; existingTupleOrDigest: string }
	| { kind: "unavailable"; reason: string };

export type FirstDispatchGetOrCreate = (
	request: Readonly<FirstDispatchGetOrCreateRequest>,
) => Promise<FirstDispatchGetOrCreateResult>;

export interface FirstDispatchProviderCapability {
	readonly kind: typeof FIRST_DISPATCH_CAPABILITY_KIND;
	readonly providerName: string;
	readonly providerContractVersion: string;
	readonly providerRouteDigest: string;
	readonly getOrCreate: FirstDispatchGetOrCreate;
}

export interface FirstDispatchProviderRoute {
	readonly providerName: string;
	readonly providerContractVersion: string;
	readonly providerRouteDigest: string;
	readonly capability: FirstDispatchProviderCapability;
}

export interface FirstDispatchProviderRouteInput {
	readonly providerName: string;
	readonly providerContractVersion: string;
	readonly providerRouteDigest: string;
	readonly getOrCreate: FirstDispatchGetOrCreate;
}

const registeredCapabilities = new WeakSet<object>();

export function createFirstDispatchProviderRoute(
	input: FirstDispatchProviderRouteInput,
): Readonly<FirstDispatchProviderRoute> {
	if (!isSafeId(input.providerName)) throw new TypeError("invalid first-dispatch providerName");
	if (!isSafeId(input.providerContractVersion)) {
		throw new TypeError("invalid first-dispatch providerContractVersion");
	}
	if (!SHA256.test(input.providerRouteDigest)) {
		throw new TypeError("invalid first-dispatch providerRouteDigest");
	}
	if (typeof input.getOrCreate !== "function") {
		throw new TypeError("first-dispatch provider must expose atomic getOrCreate");
	}
	const capability: FirstDispatchProviderCapability = Object.freeze({
		kind: FIRST_DISPATCH_CAPABILITY_KIND,
		providerName: input.providerName,
		providerContractVersion: input.providerContractVersion,
		providerRouteDigest: input.providerRouteDigest,
		getOrCreate: input.getOrCreate,
	});
	registeredCapabilities.add(capability);
	return Object.freeze({
		providerName: input.providerName,
		providerContractVersion: input.providerContractVersion,
		providerRouteDigest: input.providerRouteDigest,
		capability,
	});
}

export interface FirstDispatchLinkContext {
	commandId: string;
	requestHash: string;
	callerPrincipalDigest: string;
	projectId: string;
	projectControlDomainId: string;
	admissionId: string;
	runId: string;
	continuationId: string;
	continuationVersion: number;
	admissionGenerationAtPlan: number;
	provider: FirstDispatchProviderRoute;
}

export interface FirstDispatchPlan {
	schemaVersion: 1;
	attemptId: "first";
	idempotencyKey: string;
	boundPlanHash: string;
	commandId: string;
	requestHash: string;
	callerPrincipalDigest: string;
	projectId: string;
	projectControlDomainId: string;
	admissionId: string;
	runId: string;
	continuationId: string;
	continuationVersion: number;
	admissionGenerationAtPlan: number;
	phaseId: string;
	phaseType: "script";
	provider: Readonly<{
		capabilityKind: typeof FIRST_DISPATCH_CAPABILITY_KIND;
		providerName: string;
		providerContractVersion: string;
		providerRouteDigest: string;
	}>;
	request: Readonly<{
		run: string | readonly string[];
		input?: string;
		timeout?: number;
	}>;
	requestDigest: string;
	plannedAttemptHash: string;
}

export interface FirstDispatchDurableEvidence {
	readonly plannedEventId: string;
	readonly attemptId: "first";
	readonly idempotencyKey: string;
	readonly boundPlanHash: string;
	readonly commandId: string;
	readonly requestHash: string;
	readonly callerPrincipalDigest: string;
	readonly projectId: string;
	readonly projectControlDomainId: string;
	readonly admissionId: string;
	readonly runId: string;
	readonly continuationId: string;
	readonly continuationVersion: number;
	readonly admissionGenerationAtPlan: number;
	readonly phaseId: string;
	readonly phaseType: "script";
	readonly provider: Readonly<FirstDispatchPlan["provider"]>;
	readonly requestDigest: string;
	readonly plannedAttemptHash: string;
}

export type FirstDispatchLinkResult =
	| { ok: true; plan: Readonly<FirstDispatchPlan> }
	| {
			ok: false;
			code: "TF_FEATURE_REQUIRED";
			recoveryAction: "none";
			sideEffects: "none";
			reason: string;
	  };

export type FirstDispatchPlanValidationResult =
	| { ok: true; plan: Readonly<FirstDispatchPlan> }
	| {
			ok: false;
			code: "TF_DURABILITY_FAILED";
			recoveryAction: "operator";
			sideEffects: "unknown";
			reason: string;
	  };

function unsupported(reason: string): FirstDispatchLinkResult {
	return {
		ok: false,
		code: "TF_FEATURE_REQUIRED",
		recoveryAction: "none",
		sideEffects: "none",
		reason,
	};
}

function durabilityFailure(reason: string): FirstDispatchPlanValidationResult {
	return {
		ok: false,
		code: "TF_DURABILITY_FAILED",
		recoveryAction: "operator",
		sideEffects: "unknown",
		reason,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function hasAllKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
	return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasInterpolation(value: string): boolean {
	return value.includes("{") || value.includes("}");
}

function staticRun(value: unknown): string | readonly string[] | undefined {
	if (typeof value === "string") {
		return value.length > 0 && !hasInterpolation(value) ? value : undefined;
	}
	if (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(entry) => typeof entry === "string" && entry.length > 0 && !hasInterpolation(entry),
		)
	) {
		return Object.freeze([...value]);
	}
	return undefined;
}

function validContext(context: FirstDispatchLinkContext): string | undefined {
	for (const [name, value] of Object.entries({
		commandId: context.commandId,
		projectId: context.projectId,
		projectControlDomainId: context.projectControlDomainId,
		admissionId: context.admissionId,
		runId: context.runId,
		continuationId: context.continuationId,
	})) {
		if (!isSafeId(value)) return `invalid ${name} for E-1`;
	}
	if (!SHA256.test(context.requestHash)) return "invalid requestHash for E-1";
	if (!SHA256.test(context.callerPrincipalDigest)) {
		return "invalid callerPrincipalDigest for E-1";
	}
	if (!Number.isSafeInteger(context.continuationVersion) || context.continuationVersion < 1) {
		return "invalid continuationVersion for E-1";
	}
	if (
		!Number.isSafeInteger(context.admissionGenerationAtPlan) ||
		context.admissionGenerationAtPlan < 0
	) {
		return "invalid admissionGenerationAtPlan for E-1";
	}
	const { provider } = context;
	if (
		!isSafeId(provider.providerName) ||
		!isSafeId(provider.providerContractVersion) ||
		!SHA256.test(provider.providerRouteDigest)
	) {
		return "invalid provider route for E-1";
	}
	const capability: unknown = provider.capability;
	if (
		!isRecord(capability) ||
		capability.kind !== FIRST_DISPATCH_CAPABILITY_KIND ||
		!registeredCapabilities.has(capability) ||
		typeof capability.getOrCreate !== "function"
	) {
		return "provider route lacks a live registered atomic getOrCreate capability";
	}
	if (
		capability.providerName !== provider.providerName ||
		capability.providerContractVersion !== provider.providerContractVersion ||
		capability.providerRouteDigest !== provider.providerRouteDigest
	) {
		return "provider capability identity does not match its selected route";
	}
	return undefined;
}

export function deriveFirstDispatchIdempotencyKey(input: {
	admissionId: string;
	continuationId: string;
	phaseId: string;
}): string {
	return `p16fd_${hashRequest({
		schema: "p16-1r-first-dispatch-idempotency/v1",
		admissionId: input.admissionId,
		continuationId: input.continuationId,
		attemptId: "first",
		phaseId: input.phaseId,
	})}`;
}

function canonicalRequest(plan: FirstDispatchPlan): Record<string, unknown> {
	return {
		schema: "p16-1r-first-dispatch-plan/v1",
		boundPlanHash: plan.boundPlanHash,
		identity: {
			commandId: plan.commandId,
			requestHash: plan.requestHash,
			callerPrincipalDigest: plan.callerPrincipalDigest,
			projectId: plan.projectId,
			projectControlDomainId: plan.projectControlDomainId,
			admissionId: plan.admissionId,
			runId: plan.runId,
			continuationId: plan.continuationId,
			continuationVersion: plan.continuationVersion,
			admissionGenerationAtPlan: plan.admissionGenerationAtPlan,
		},
		provider: plan.provider,
		phase: { id: plan.phaseId, type: plan.phaseType, request: plan.request },
	};
}

function expectedDigests(plan: FirstDispatchPlan): {
	requestDigest: string;
	plannedAttemptHash: string;
} {
	const request = canonicalRequest(plan);
	return {
		requestDigest: hashRequest(request),
		plannedAttemptHash: hashRequest({
			...request,
			attempt: { attemptId: plan.attemptId, idempotencyKey: plan.idempotencyKey },
		}),
	};
}

/**
 * Link the one provider call covered by the first P16-1R protocol. This must be
 * called before command claim, E0 journal append, coordinator reservation, or
 * provider work.
 */
export function linkFirstDispatchPlan(
	boundPlan: BoundPlan,
	context: FirstDispatchLinkContext,
): FirstDispatchLinkResult {
	const contextError = validContext(context);
	if (contextError) return unsupported(contextError);
	if (!/^bp:[a-f0-9]{64}$/.test(boundPlan.boundPlanHash)) {
		return unsupported("invalid boundPlanHash for E-1");
	}
	if (!isSafeId(boundPlan.providerClass ?? "")) {
		return unsupported("BoundPlan has no immutable providerClass for E-1");
	}
	if (boundPlan.providerClass !== context.provider.providerName) {
		return unsupported("BoundPlan providerClass does not match selected route");
	}
	if (!isRecord(boundPlan.program) || !hasOnlyKeys(boundPlan.program, FLOW_KEYS)) {
		return unsupported("program contains unsupported dynamic fields");
	}
	const phases = boundPlan.program.phases;
	if (!Array.isArray(phases) || phases.length !== 1) {
		return unsupported("P16-1R permits exactly one phase and one provider call");
	}
	const phase = phases[0];
	if (!isRecord(phase) || !hasOnlyKeys(phase, SCRIPT_KEYS)) {
		return unsupported("first provider phase has unsupported execution modifiers");
	}
	if (phase.type !== "script") {
		return unsupported("first executable phase is not a script provider call");
	}
	const phaseId = typeof phase.id === "string" ? phase.id : "";
	if (!isSafeId(phaseId)) {
		return unsupported("first provider phase has invalid id");
	}
	const run = staticRun(phase.run);
	if (!run) return unsupported("first provider request is not fully static");
	if (
		phase.input !== undefined &&
		(typeof phase.input !== "string" || hasInterpolation(phase.input))
	) {
		return unsupported("first provider request is not fully static");
	}
	if (
		phase.timeout !== undefined &&
		(typeof phase.timeout !== "number" ||
			!Number.isSafeInteger(phase.timeout) ||
			phase.timeout < 1000)
	) {
		return unsupported("first provider phase has invalid timeout");
	}
	if (phase.final !== undefined && typeof phase.final !== "boolean") {
		return unsupported("first provider phase has invalid final marker");
	}

	const provider = Object.freeze({
		capabilityKind: FIRST_DISPATCH_CAPABILITY_KIND,
		providerName: context.provider.providerName,
		providerContractVersion: context.provider.providerContractVersion,
		providerRouteDigest: context.provider.providerRouteDigest,
	});
	const request = Object.freeze({
		run,
		...(phase.input === undefined ? {} : { input: phase.input }),
		...(phase.timeout === undefined ? {} : { timeout: phase.timeout }),
	});
	const idempotencyKey = deriveFirstDispatchIdempotencyKey({
		admissionId: context.admissionId,
		continuationId: context.continuationId,
		phaseId,
	});
	const pending: FirstDispatchPlan = {
		schemaVersion: 1,
		attemptId: "first",
		idempotencyKey,
		boundPlanHash: boundPlan.boundPlanHash,
		commandId: context.commandId,
		requestHash: context.requestHash,
		callerPrincipalDigest: context.callerPrincipalDigest,
		projectId: context.projectId,
		projectControlDomainId: context.projectControlDomainId,
		admissionId: context.admissionId,
		runId: context.runId,
		continuationId: context.continuationId,
		continuationVersion: context.continuationVersion,
		admissionGenerationAtPlan: context.admissionGenerationAtPlan,
		phaseId,
		phaseType: "script",
		provider,
		request,
		requestDigest: "",
		plannedAttemptHash: "",
	};
	const digests = expectedDigests(pending);
	return { ok: true, plan: Object.freeze({ ...pending, ...digests }) };
}

const PLAN_KEYS = [
	"schemaVersion",
	"attemptId",
	"idempotencyKey",
	"boundPlanHash",
	"commandId",
	"requestHash",
	"callerPrincipalDigest",
	"projectId",
	"projectControlDomainId",
	"admissionId",
	"runId",
	"continuationId",
	"continuationVersion",
	"admissionGenerationAtPlan",
	"phaseId",
	"phaseType",
	"provider",
	"request",
	"requestDigest",
	"plannedAttemptHash",
] as const;

const PROVIDER_KEYS = [
	"capabilityKind",
	"providerName",
	"providerContractVersion",
	"providerRouteDigest",
] as const;

export function validateFirstDispatchPlan(value: unknown): FirstDispatchPlanValidationResult {
	if (!isRecord(value) || !hasOnlyKeys(value, PLAN_KEYS) || !hasAllKeys(value, PLAN_KEYS)) {
		return durabilityFailure("persisted first-dispatch plan has unsupported or missing fields");
	}
	if (
		value.schemaVersion !== 1 ||
		value.attemptId !== "first" ||
		value.phaseType !== "script" ||
		!IDEMPOTENCY_KEY.test(typeof value.idempotencyKey === "string" ? value.idempotencyKey : "") ||
		!/^bp:[a-f0-9]{64}$/.test(typeof value.boundPlanHash === "string" ? value.boundPlanHash : "") ||
		!SHA256.test(typeof value.requestHash === "string" ? value.requestHash : "") ||
		!SHA256.test(
			typeof value.callerPrincipalDigest === "string" ? value.callerPrincipalDigest : "",
		) ||
		!SHA256.test(typeof value.requestDigest === "string" ? value.requestDigest : "") ||
		!SHA256.test(typeof value.plannedAttemptHash === "string" ? value.plannedAttemptHash : "")
	) {
		return durabilityFailure("persisted first-dispatch plan has malformed immutable fields");
	}
	for (const field of [
		"commandId",
		"projectId",
		"projectControlDomainId",
		"admissionId",
		"runId",
		"continuationId",
		"phaseId",
	] as const) {
		if (!isSafeId(typeof value[field] === "string" ? value[field] : "")) {
			return durabilityFailure(`persisted first-dispatch plan has invalid ${field}`);
		}
	}
	if (
		typeof value.continuationVersion !== "number" ||
		!Number.isSafeInteger(value.continuationVersion) ||
		value.continuationVersion < 1 ||
		typeof value.admissionGenerationAtPlan !== "number" ||
		!Number.isSafeInteger(value.admissionGenerationAtPlan) ||
		value.admissionGenerationAtPlan < 0
	) {
		return durabilityFailure("persisted first-dispatch plan has invalid version fields");
	}
	if (
		!isRecord(value.provider) ||
		!hasOnlyKeys(value.provider, PROVIDER_KEYS) ||
		!hasAllKeys(value.provider, PROVIDER_KEYS) ||
		value.provider.capabilityKind !== FIRST_DISPATCH_CAPABILITY_KIND ||
		!isSafeId(
			typeof value.provider.providerName === "string" ? value.provider.providerName : "",
		) ||
		!isSafeId(
			typeof value.provider.providerContractVersion === "string"
				? value.provider.providerContractVersion
				: "",
		) ||
		!SHA256.test(
			typeof value.provider.providerRouteDigest === "string"
				? value.provider.providerRouteDigest
				: "",
		)
	) {
		return durabilityFailure("persisted first-dispatch provider descriptor is invalid");
	}
	if (
		!isRecord(value.request) ||
		!hasOnlyKeys(value.request, ["run", "input", "timeout"]) ||
		!Object.prototype.hasOwnProperty.call(value.request, "run")
	) {
		return durabilityFailure("persisted first-dispatch request is invalid");
	}
	const run = staticRun(value.request.run);
	if (!run) return durabilityFailure("persisted first-dispatch request is not fully static");
	if (
		value.request.input !== undefined &&
		(typeof value.request.input !== "string" || hasInterpolation(value.request.input))
	) {
		return durabilityFailure("persisted first-dispatch request input is invalid");
	}
	if (
		value.request.timeout !== undefined &&
		(typeof value.request.timeout !== "number" ||
			!Number.isSafeInteger(value.request.timeout) ||
			value.request.timeout < 1000)
	) {
		return durabilityFailure("persisted first-dispatch request timeout is invalid");
	}

	const plan: FirstDispatchPlan = {
		schemaVersion: 1,
		attemptId: "first",
		idempotencyKey: value.idempotencyKey as string,
		boundPlanHash: value.boundPlanHash as string,
		commandId: value.commandId as string,
		requestHash: value.requestHash as string,
		callerPrincipalDigest: value.callerPrincipalDigest as string,
		projectId: value.projectId as string,
		projectControlDomainId: value.projectControlDomainId as string,
		admissionId: value.admissionId as string,
		runId: value.runId as string,
		continuationId: value.continuationId as string,
		continuationVersion: value.continuationVersion,
		admissionGenerationAtPlan: value.admissionGenerationAtPlan,
		phaseId: value.phaseId as string,
		phaseType: "script",
		provider: Object.freeze({
			capabilityKind: FIRST_DISPATCH_CAPABILITY_KIND,
			providerName: value.provider.providerName as string,
			providerContractVersion: value.provider.providerContractVersion as string,
			providerRouteDigest: value.provider.providerRouteDigest as string,
		}),
		request: Object.freeze({
			run,
			...(value.request.input === undefined ? {} : { input: value.request.input }),
			...(value.request.timeout === undefined ? {} : { timeout: value.request.timeout }),
		}),
		requestDigest: value.requestDigest as string,
		plannedAttemptHash: value.plannedAttemptHash as string,
	};
	if (
		deriveFirstDispatchIdempotencyKey(plan) !== plan.idempotencyKey ||
		expectedDigests(plan).requestDigest !== plan.requestDigest ||
		expectedDigests(plan).plannedAttemptHash !== plan.plannedAttemptHash
	) {
		return durabilityFailure("persisted first-dispatch hashes do not match immutable tuple");
	}
	return { ok: true, plan: Object.freeze(plan) };
}

/**
 * Structural self-consistency is insufficient against a coherent replacement.
 * Reopen must compare the plan with independently derived command/admission/
 * continuation/BoundPlan/event evidence before any owner or provider action.
 */
export function validateFirstDispatchPlanAgainstDurableEvidence(
	value: unknown,
	evidence: unknown,
): FirstDispatchPlanValidationResult {
	const parsed = validateFirstDispatchPlan(value);
	if (!parsed.ok) return parsed;
	const evidenceKeys = [
		"plannedEventId",
		"attemptId",
		"idempotencyKey",
		"boundPlanHash",
		"commandId",
		"requestHash",
		"callerPrincipalDigest",
		"projectId",
		"projectControlDomainId",
		"admissionId",
		"runId",
		"continuationId",
		"continuationVersion",
		"admissionGenerationAtPlan",
		"phaseId",
		"phaseType",
		"provider",
		"requestDigest",
		"plannedAttemptHash",
	] as const;
	if (
		!isRecord(evidence) ||
		!hasOnlyKeys(evidence, evidenceKeys) ||
		!hasAllKeys(evidence, evidenceKeys)
	) {
		return durabilityFailure(
			"first-dispatch durable evidence has unsupported or missing fields",
		);
	}
	if (
		!isSafeId(
			typeof evidence.plannedEventId === "string" ? evidence.plannedEventId : "",
		)
	) {
		return durabilityFailure("first-dispatch durable evidence has invalid plannedEventId");
	}
	const plan = parsed.plan;
	for (const field of [
		"attemptId",
		"idempotencyKey",
		"boundPlanHash",
		"commandId",
		"requestHash",
		"callerPrincipalDigest",
		"projectId",
		"projectControlDomainId",
		"admissionId",
		"runId",
		"continuationId",
		"continuationVersion",
		"admissionGenerationAtPlan",
		"phaseId",
		"phaseType",
		"requestDigest",
		"plannedAttemptHash",
	] as const) {
		if (evidence[field] !== plan[field]) {
			return durabilityFailure(
				`first-dispatch durable evidence does not match ${field}`,
			);
		}
	}
	for (const field of PROVIDER_KEYS) {
		if (
			!isRecord(evidence.provider) ||
			!hasOnlyKeys(evidence.provider, PROVIDER_KEYS) ||
			!hasAllKeys(evidence.provider, PROVIDER_KEYS) ||
			evidence.provider[field] !== plan.provider[field]
		) {
			return durabilityFailure(
				`first-dispatch durable evidence does not match provider ${field}`,
			);
		}
	}
	return parsed;
}
