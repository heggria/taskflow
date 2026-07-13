/**
 * Exact host/OS evidence gating for workspace sandbox claims.
 *
 * A host version string or a static feature flag is not evidence.  Sandboxed
 * execution is enabled only when every field of the running target matches an
 * approved, checked-in probe result.  Missing and stale cells fail closed.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const HOST_PROBE_HOSTS = ["pi", "codex", "claude", "opencode", "grok"] as const;
export type HostProbeHost = (typeof HOST_PROBE_HOSTS)[number];

export const HOST_PROBE_OSES = ["macos", "linux", "windows"] as const;
export type HostProbeOs = (typeof HOST_PROBE_OSES)[number];
export const HOST_PROBE_VERSION = "tfws-probe:v1";

export type HostProbeClassification =
	| "sandboxed-single-root"
	| "sandboxed-multi-root"
	| "resolve-only"
	| "unsupported";

export interface HostProbeTarget {
	host: HostProbeHost;
	hostVersion: string;
	hostBinarySha256: string;
	os: HostProbeOs;
	osVersion: string;
	osBuild: string;
	arch: "arm64" | "x64";
	sandboxMechanismVersion: string;
	backendId: string;
	backendCapabilityVersion: string;
	backendCapabilitiesSha256: string;
	baselinePolicyId: string;
}

export interface HostProbeDecision {
	owner: string;
	status: "approved" | "rejected";
	reason: string;
}

export interface HostProbeEvidence {
	/** Repository-relative, redacted raw probe result. */
	path: string;
	sha256: string;
}

export interface HostSupportCell {
	target: HostProbeTarget;
	classification: HostProbeClassification;
	agent: HostProbeEvidence;
	script: HostProbeEvidence;
	fileBroker: HostProbeEvidence;
	decision: HostProbeDecision;
}

export interface HostSupportBaseline {
	schemaVersion: 1;
	baselineId: string;
	cells: HostSupportCell[];
}

export const PROCESS_SANDBOX_EVIDENCE_CHECKS = [
	"exactCwd",
	"readInsideReadOnly",
	"writeInsideReadOnlyDenied",
	"readInsideReadWrite",
	"writeInsideReadWrite",
	"siblingScopeDenied",
	"outsideScopeDenied",
	"symlinkEscapeDenied",
	"ambientUserDataDenied",
	"privateTempEnforced",
	"descendantEnforcement",
	"abortDescendantCleanup",
	"networkPolicyEnforced",
	"credentialIsolationEnforced",
	"baselineRuntimeUsable",
	"resolverOpenPathSwapDenied",
	"exactMetadataNoFollow",
	"unsupportedPolicyFailsClosed",
] as const;

export const FILE_BROKER_EVIDENCE_CHECKS = [
	"readInsideReadOnly",
	"writeInsideReadOnlyDenied",
	"readInsideReadWrite",
	"writeInsideReadWrite",
	"siblingScopeDenied",
	"outsideScopeDenied",
	"symlinkEscapeDenied",
	"brokeredReadNoFollow",
	"brokeredWriteNoFollow",
	"fingerprintNoFollow",
	"resolverOpenPathSwapDenied",
	"abortCleanup",
	"exactMetadataNoFollow",
	"unsupportedPolicyFailsClosed",
] as const;

export type ProcessSandboxEvidenceCheck = (typeof PROCESS_SANDBOX_EVIDENCE_CHECKS)[number];
export type FileBrokerEvidenceCheck = (typeof FILE_BROKER_EVIDENCE_CHECKS)[number];

export interface HostProbeSuiteEvidence<Check extends string> {
	pass: boolean;
	checks: Record<Check, boolean>;
}

export interface HostProbeResult {
	target: HostProbeTarget;
	classification: HostProbeClassification;
	agent: HostProbeSuiteEvidence<ProcessSandboxEvidenceCheck>;
	script: HostProbeSuiteEvidence<ProcessSandboxEvidenceCheck>;
	fileBroker: HostProbeSuiteEvidence<FileBrokerEvidenceCheck>;
}

export interface HostProbeEvidenceBundle {
	schemaVersion: 1;
	probeVersion: string;
	results: HostProbeResult[];
}

declare const VERIFIED_HOST_SUPPORT_BASELINE: unique symbol;
declare const VERIFIED_SANDBOX_HOST_APPROVAL: unique symbol;

export interface VerifiedHostSupportBaseline extends HostSupportBaseline {
	readonly [VERIFIED_HOST_SUPPORT_BASELINE]: true;
}

/** Process-local authorization minted only for an exact approved evidence cell. */
export interface VerifiedSandboxHostApproval {
	readonly [VERIFIED_SANDBOX_HOST_APPROVAL]: true;
	readonly baselineId: string;
	readonly target: HostProbeTarget;
	readonly classification: "sandboxed-single-root" | "sandboxed-multi-root";
}

export interface HostSupportBaselineLoadOptions {
	repositoryRoot: string;
	/** Repository-relative baseline path. */
	baselinePath?: string;
	maxEvidenceBytes?: number;
}

export type HostSupportMatch =
	| { ok: true; cell: HostSupportCell; approval: VerifiedSandboxHostApproval }
	| { ok: false; reason: string };

const SHA256_RE = /^[0-9a-f]{64}$/;
const verifiedBaselines = new WeakSet<object>();
const verifiedSandboxApprovals = new WeakSet<object>();

const TARGET_KEYS = [
	"host",
	"hostVersion",
	"hostBinarySha256",
	"os",
	"osVersion",
	"osBuild",
	"arch",
	"sandboxMechanismVersion",
	"backendId",
	"backendCapabilityVersion",
	"backendCapabilitiesSha256",
	"baselinePolicyId",
] as const;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function targetKey(target: HostProbeTarget): string {
	return JSON.stringify([
		target.host,
		target.hostVersion,
		target.hostBinarySha256,
		target.os,
		target.osVersion,
		target.osBuild,
		target.arch,
		target.sandboxMechanismVersion,
		target.backendId,
		target.backendCapabilityVersion,
		target.backendCapabilitiesSha256,
		target.baselinePolicyId,
	]);
}

export function hostProbeTargetsEqual(left: HostProbeTarget, right: HostProbeTarget): boolean {
	return targetKey(left) === targetKey(right);
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function resolveTrustedRegularFile(repositoryRoot: string, relativePath: string): string {
	if (!relativePath || path.isAbsolute(relativePath)) throw new Error("evidence path must be repository-relative");
	const segments = relativePath.split(/[\\/]+/);
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error("evidence path contains an unsafe segment");
	}
	let current = repositoryRoot;
	for (const segment of segments) {
		current = path.join(current, segment);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error(`trusted baseline path must not contain symlinks: ${relativePath}`);
	}
	const canonical = fs.realpathSync(current);
	if (!isWithin(repositoryRoot, canonical)) throw new Error("trusted baseline path escapes the repository root");
	if (!fs.lstatSync(canonical).isFile()) throw new Error(`trusted baseline path is not a regular file: ${relativePath}`);
	return canonical;
}

interface TrustedJsonRead {
	bytes: Buffer;
	value: unknown;
}

function sameFileSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
	return left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs;
}

/** Resolve, open without following the final component, and consume exactly one
 * immutable byte snapshot. Hashing and JSON parsing both use these same bytes. */
function readTrustedJson(
	repositoryRoot: string,
	relativePath: string,
	maxBytes: number,
): TrustedJsonRead {
	const canonical = resolveTrustedRegularFile(repositoryRoot, relativePath);
	const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
	const fd = fs.openSync(canonical, fs.constants.O_RDONLY | noFollow);
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		if (!before.isFile()) throw new Error(`trusted baseline path is not a regular file: ${relativePath}`);
		if (before.size > BigInt(maxBytes)) throw new Error(`trusted baseline evidence exceeds ${maxBytes} bytes`);
		const bytes = fs.readFileSync(fd);
		if (bytes.byteLength > maxBytes) throw new Error(`trusted baseline evidence exceeds ${maxBytes} bytes`);
		const after = fs.fstatSync(fd, { bigint: true });
		if (!sameFileSnapshot(before, after)) throw new Error(`trusted baseline file changed while reading: ${relativePath}`);

		// Re-resolve every path component after the read. A parent-directory swap
		// cannot authorize the opened bytes unless the live path still identifies
		// this exact inode and immutable snapshot.
		const liveCanonical = resolveTrustedRegularFile(repositoryRoot, relativePath);
		const live = fs.lstatSync(liveCanonical, { bigint: true });
		if (!sameFileSnapshot(after, live)) throw new Error(`trusted baseline path changed while reading: ${relativePath}`);
		return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
	} finally {
		fs.closeSync(fd);
	}
}

function sha256Bytes(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
	const actual = Object.keys(value).sort();
	const required = [...expected].sort();
	if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
		throw new Error(`${name} must contain exactly: ${required.join(", ")}`);
	}
}

function verifyTarget(value: unknown, name: string): HostProbeTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	const target = value as Record<string, unknown>;
	assertExactKeys(target, TARGET_KEYS, name);
	if (!HOST_PROBE_HOSTS.includes(target.host as HostProbeHost)) throw new Error(`${name}.host is invalid`);
	if (!HOST_PROBE_OSES.includes(target.os as HostProbeOs)) throw new Error(`${name}.os is invalid`);
	if (target.arch !== "arm64" && target.arch !== "x64") throw new Error(`${name}.arch is invalid`);
	for (const field of [
		"hostVersion",
		"osVersion",
		"osBuild",
		"sandboxMechanismVersion",
		"backendId",
		"backendCapabilityVersion",
		"baselinePolicyId",
	] as const) {
		if (!isNonEmptyString(target[field]) || /[\u0000-\u001f\u007f]/.test(target[field])) {
			throw new Error(`${name}.${field} must be non-empty and contain no control characters`);
		}
	}
	if (typeof target.hostBinarySha256 !== "string" || !SHA256_RE.test(target.hostBinarySha256)) {
		throw new Error(`${name}.hostBinarySha256 must be lowercase sha256`);
	}
	if (typeof target.backendCapabilitiesSha256 !== "string" || !SHA256_RE.test(target.backendCapabilitiesSha256)) {
		throw new Error(`${name}.backendCapabilitiesSha256 must be lowercase sha256`);
	}
	return target as unknown as HostProbeTarget;
}

export function isExactHostProbeTarget(value: unknown): value is HostProbeTarget {
	try {
		verifyTarget(value, "host probe target");
		return true;
	} catch {
		return false;
	}
}

function verifySuiteEvidence(
	value: unknown,
	requiredChecks: readonly string[],
	name: string,
): { pass: boolean } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	const suite = value as Record<string, unknown>;
	assertExactKeys(suite, ["pass", "checks"], name);
	if (typeof suite.pass !== "boolean") throw new Error(`${name}.pass must be boolean`);
	if (!suite.checks || typeof suite.checks !== "object" || Array.isArray(suite.checks)) {
		throw new Error(`${name}.checks must be an object`);
	}
	const checks = suite.checks as Record<string, unknown>;
	assertExactKeys(checks, requiredChecks, `${name}.checks`);
	if (Object.values(checks).some((check) => typeof check !== "boolean")) {
		throw new Error(`${name}.checks must contain only booleans`);
	}
	const derivedPass = requiredChecks.every((check) => checks[check] === true);
	if (suite.pass !== derivedPass) throw new Error(`${name}.pass does not match its required checks`);
	return { pass: suite.pass };
}

function verifyEvidenceBundle(value: unknown): HostProbeEvidenceBundle {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("evidence bundle must be an object");
	const document = value as Record<string, unknown>;
	assertExactKeys(document, ["schemaVersion", "probeVersion", "results"], "evidence bundle");
	if (document.schemaVersion !== 1) throw new Error("evidence bundle schemaVersion must be 1");
	if (document.probeVersion !== HOST_PROBE_VERSION) {
		throw new Error(`evidence bundle probeVersion must be ${HOST_PROBE_VERSION}`);
	}
	if (!Array.isArray(document.results) || document.results.length === 0) {
		throw new Error("evidence bundle results must be a non-empty array");
	}
	const seen = new Set<string>();
	for (const [index, value] of document.results.entries()) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`evidence bundle results[${index}] must be an object`);
		}
		const result = value as Record<string, unknown>;
		assertExactKeys(result, ["target", "classification", "agent", "script", "fileBroker"], `evidence bundle results[${index}]`);
		const target = verifyTarget(result.target, `evidence bundle results[${index}].target`);
		const key = targetKey(target);
		if (seen.has(key)) throw new Error("evidence bundle contains duplicate exact targets");
		seen.add(key);
		if (!["sandboxed-single-root", "sandboxed-multi-root", "resolve-only", "unsupported"].includes(result.classification as string)) {
			throw new Error(`evidence bundle results[${index}].classification is invalid`);
		}
		verifySuiteEvidence(result.agent, PROCESS_SANDBOX_EVIDENCE_CHECKS, `evidence bundle results[${index}].agent`);
		verifySuiteEvidence(result.script, PROCESS_SANDBOX_EVIDENCE_CHECKS, `evidence bundle results[${index}].script`);
		verifySuiteEvidence(result.fileBroker, FILE_BROKER_EVIDENCE_CHECKS, `evidence bundle results[${index}].fileBroker`);
	}
	return document as unknown as HostProbeEvidenceBundle;
}

function verifyEvidenceDocument(
	value: unknown,
	cell: HostSupportCell,
	kind: "agent" | "script" | "fileBroker",
	requirePass: boolean,
): void {
	const document = verifyEvidenceBundle(value);
	const result = document.results.find((candidate) => targetKey(candidate.target) === targetKey(cell.target));
	if (!result) {
		throw new Error(`${kind} evidence target does not exactly match its baseline cell`);
	}
	if (result.classification !== cell.classification) {
		throw new Error(`${kind} evidence classification does not exactly match its baseline cell`);
	}
	if (requirePass && result[kind].pass !== true) {
		throw new Error(`${kind} evidence did not pass`);
	}
}

/** Validate trusted baseline data before it can authorize a sandbox claim. */
export function validateHostSupportBaseline(value: unknown): string[] {
	const errors: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) return ["baseline must be an object"];
	const rootKeys = Object.keys(value).filter((key) => !["schemaVersion", "baselineId", "cells"].includes(key));
	if (rootKeys.length > 0) errors.push(`baseline has unsupported fields: ${rootKeys.join(", ")}`);
	const baseline = value as Partial<HostSupportBaseline>;
	if (baseline.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	if (!isNonEmptyString(baseline.baselineId)) errors.push("baselineId must be a non-empty string");
	if (!Array.isArray(baseline.cells)) return [...errors, "cells must be an array"];

	const seen = new Set<string>();
	baseline.cells.forEach((raw, index) => {
		const prefix = `cells[${index}]`;
		if (!raw || typeof raw !== "object") {
			errors.push(`${prefix} must be an object`);
			return;
		}
		const cell = raw as HostSupportCell;
		const cellKeys = Object.keys(cell).filter((key) =>
			!["target", "classification", "agent", "script", "fileBroker", "decision"].includes(key));
		if (cellKeys.length > 0) errors.push(`${prefix} has unsupported fields: ${cellKeys.join(", ")}`);
		const target = cell.target;
		if (!target || typeof target !== "object") {
			errors.push(`${prefix}.target must be an object`);
			return;
		}
		const targetKeys = Object.keys(target).filter((key) => !TARGET_KEYS.includes(key as (typeof TARGET_KEYS)[number]));
		if (targetKeys.length > 0) errors.push(`${prefix}.target has unsupported fields: ${targetKeys.join(", ")}`);
		if (!HOST_PROBE_HOSTS.includes(target.host)) errors.push(`${prefix}.target.host is invalid`);
		if (!HOST_PROBE_OSES.includes(target.os)) errors.push(`${prefix}.target.os is invalid`);
		if (target.arch !== "arm64" && target.arch !== "x64") errors.push(`${prefix}.target.arch is invalid`);
		for (const field of [
			"hostVersion",
			"osVersion",
			"osBuild",
			"sandboxMechanismVersion",
			"backendId",
			"backendCapabilityVersion",
			"baselinePolicyId",
		] as const) {
			if (!isNonEmptyString(target[field]) || /[\u0000-\u001f\u007f]/.test(target[field])) {
				errors.push(`${prefix}.target.${field} must be non-empty and contain no control characters`);
			}
		}
		if (!SHA256_RE.test(target.hostBinarySha256)) errors.push(`${prefix}.target.hostBinarySha256 must be lowercase sha256`);
		if (!SHA256_RE.test(target.backendCapabilitiesSha256)) {
			errors.push(`${prefix}.target.backendCapabilitiesSha256 must be lowercase sha256`);
		}
		const key = targetKey(target);
		if (seen.has(key)) errors.push(`${prefix} duplicates an exact target cell`);
		seen.add(key);

		if (!["sandboxed-single-root", "sandboxed-multi-root", "resolve-only", "unsupported"].includes(cell.classification)) {
			errors.push(`${prefix}.classification is invalid`);
		}
		for (const field of ["agent", "script", "fileBroker"] as const) {
			const evidence = cell[field];
			if (!evidence || typeof evidence !== "object") {
				errors.push(`${prefix}.${field} must be an evidence object`);
				continue;
			}
			const evidenceKeys = Object.keys(evidence).filter((key) => !["path", "sha256"].includes(key));
			if (evidenceKeys.length > 0) errors.push(`${prefix}.${field} has unsupported fields: ${evidenceKeys.join(", ")}`);
			if (!isNonEmptyString(evidence.path) || evidence.path.startsWith("/") || evidence.path.includes("..")) {
				errors.push(`${prefix}.${field}.path must be a safe repository-relative path`);
			}
			if (!SHA256_RE.test(evidence.sha256)) errors.push(`${prefix}.${field}.sha256 must be lowercase sha256`);
		}
		if (!cell.decision || typeof cell.decision !== "object") {
			errors.push(`${prefix}.decision must be an object`);
		} else {
			const decisionKeys = Object.keys(cell.decision).filter((key) => !["owner", "status", "reason"].includes(key));
			if (decisionKeys.length > 0) errors.push(`${prefix}.decision has unsupported fields: ${decisionKeys.join(", ")}`);
			if (!isNonEmptyString(cell.decision.owner)) errors.push(`${prefix}.decision.owner must be non-empty`);
			if (!isNonEmptyString(cell.decision.reason)) errors.push(`${prefix}.decision.reason must be non-empty`);
			if (cell.decision.status !== "approved" && cell.decision.status !== "rejected") {
				errors.push(`${prefix}.decision.status is invalid`);
			}
		}
	});
	return errors;
}

/** Load and verify the checked-in finite allowlist plus every evidence body it
 * relies on. Matcher authorization accepts only the process-local branded
 * snapshot returned here; shape-correct caller data is never authority. */
export function loadVerifiedHostSupportBaseline(
	options: HostSupportBaselineLoadOptions,
): VerifiedHostSupportBaseline {
	const repositoryRoot = fs.realpathSync(options.repositoryRoot);
	if (!fs.statSync(repositoryRoot).isDirectory()) throw new Error("repositoryRoot must be a directory");
	const maxBytes = options.maxEvidenceBytes ?? 5 * 1024 * 1024;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxEvidenceBytes must be a positive safe integer");
	const baselinePath = options.baselinePath ?? "conformance/workspace/host-support-baseline.json";
	const raw = readTrustedJson(repositoryRoot, baselinePath, maxBytes).value;
	const errors = validateHostSupportBaseline(raw);
	if (errors.length > 0) throw new Error(`invalid host support baseline: ${errors.join("; ")}`);
	const snapshot = structuredClone(raw) as HostSupportBaseline;

	const evidenceCache = new Map<string, TrustedJsonRead>();
	for (const cell of snapshot.cells) {
		const requirePass = cell.decision.status === "approved" &&
			(cell.classification === "sandboxed-single-root" || cell.classification === "sandboxed-multi-root");
		for (const kind of ["agent", "script", "fileBroker"] as const) {
			const evidence = cell[kind];
			let trusted = evidenceCache.get(evidence.path);
			if (!trusted) {
				trusted = readTrustedJson(repositoryRoot, evidence.path, maxBytes);
				evidenceCache.set(evidence.path, trusted);
			}
			if (sha256Bytes(trusted.bytes) !== evidence.sha256) {
				throw new Error(`${kind} evidence sha256 mismatch for ${evidence.path}`);
			}
			verifyEvidenceDocument(trusted.value, cell, kind, requirePass);
		}
	}

	const verified = deepFreeze(snapshot) as VerifiedHostSupportBaseline;
	verifiedBaselines.add(verified);
	return verified;
}

/**
 * Match a live target against the finite approved evidence set.
 *
 * Only a sandboxed classification with an approved owner decision is a match.
 * Resolve-only/unsupported cells remain useful audit evidence but never enable
 * a sandboxed bridge.
 */
export function matchSandboxedHostTarget(
	baseline: HostSupportBaseline,
	target: HostProbeTarget,
): HostSupportMatch {
	if (!verifiedBaselines.has(baseline)) {
		return { ok: false, reason: "host support baseline was not loaded and evidence-verified by the trusted loader" };
	}
	const errors = validateHostSupportBaseline(baseline);
	if (errors.length) return { ok: false, reason: `invalid host support baseline: ${errors.join("; ")}` };
	const cell = baseline.cells.find((candidate) => targetKey(candidate.target) === targetKey(target));
	if (!cell) return { ok: false, reason: "no exact host/OS/architecture/binary evidence cell" };
	if (cell.decision.status !== "approved") return { ok: false, reason: `evidence cell is ${cell.decision.status}` };
	if (cell.classification !== "sandboxed-single-root" && cell.classification !== "sandboxed-multi-root") {
		return { ok: false, reason: `evidence cell is classified ${cell.classification}` };
	}
	const approval = deepFreeze({
		baselineId: baseline.baselineId,
		target: structuredClone(cell.target),
		classification: cell.classification,
	}) as VerifiedSandboxHostApproval;
	verifiedSandboxApprovals.add(approval);
	return { ok: true, cell, approval };
}

/** Shape-correct, cloned, or deserialized approval objects are not authority. */
export function isVerifiedSandboxHostApproval(value: unknown): value is VerifiedSandboxHostApproval {
	return typeof value === "object" && value !== null && verifiedSandboxApprovals.has(value);
}
