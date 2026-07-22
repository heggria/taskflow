/**
 * Canonical hashing for BoundPlan / command request hashes (P6).
 * Single library — Node crypto only.
 */
import * as crypto from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
	return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Content-addressed bound plan hash: `bp:<64-hex>`.
 * Meta must include all execution-semantic fields (grants, approvalMode, policy,
 * provider class, timeouts) so semantic changes change the hash (P6).
 */
export function hashBoundPlan(program: unknown, meta: Record<string, unknown> = {}): string {
	const body = stableStringify({ program, meta });
	return `bp:${sha256Hex(body)}`;
}

/** Execution semantic hash: `es:<64-hex>`. */
export function hashExecutionSemantic(descriptor: unknown): string {
	return `es:${sha256Hex(stableStringify(descriptor))}`;
}

/**
 * BoundFragment dual hashes (P7): full audit identity + execution-semantic reuse key.
 * - boundFragmentHash (`bf:…`) — full fragment body for audit
 * - executionSemanticHash (`es:…`) — reuse key (no blind promotedPhases restore)
 */
export function hashBoundFragment(fragment: unknown, meta: Record<string, unknown> = {}): {
	boundFragmentHash: string;
	executionSemanticHash: string;
} {
	const semantics = extractExecutionSemantics(fragment);
	const body = stableStringify({ fragment, meta, semantics });
	return {
		boundFragmentHash: `bf:${sha256Hex(body)}`,
		executionSemanticHash: hashExecutionSemantic({ ...semantics, meta }),
	};
}

/** Extract timeout / provider-relevant fields from a Taskflow program for hashing. */
export function extractExecutionSemantics(program: unknown): Record<string, unknown> {
	if (!program || typeof program !== "object") return {};
	const p = program as {
		name?: string;
		budget?: unknown;
		concurrency?: unknown;
		idleTimeout?: unknown;
		phases?: Array<Record<string, unknown>>;
	};
	return {
		name: p.name,
		budget: p.budget,
		concurrency: p.concurrency,
		idleTimeout: p.idleTimeout,
		phases: (p.phases ?? []).map((ph) => ({
			id: ph.id,
			type: ph.type,
			agent: ph.agent,
			task: ph.task,
			run: ph.run,
			timeout: ph.timeout,
			idleTimeout: ph.idleTimeout,
			model: ph.model,
			tools: ph.tools,
			provider: ph.provider,
		})),
	};
}

/** Request hash for CommandRecord idempotency. */
export function hashRequest(body: unknown): string {
	return sha256Hex(stableStringify(body));
}

export function newId(prefix = ""): string {
	const id = crypto.randomUUID();
	return prefix ? `${prefix}_${id}` : id;
}

/** Deterministic JSON stringify (sorted object keys). */
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sortKeys);
	const obj = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(obj).sort()) {
		out[k] = sortKeys(obj[k]);
	}
	return out;
}
