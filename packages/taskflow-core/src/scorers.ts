/**
 * Scoring gates (`score`) — deterministic, composable output scorers.
 *
 * A `gate` phase may declare `score`: a list of zero-token deterministic
 * scorers (exact-match, contains, regex, json-schema, length-range,
 * code-compiles) evaluated against a target string, combined via
 * `all`/`any`/`weighted` against a threshold. When the deterministic
 * combination passes, the gate auto-passes with NO LLM call (mirroring the
 * `eval` fast-path); when it fails, control falls to the optional `llm-judge`
 * (`score.judge`) or the gate's regular `task`.
 *
 * This module is the PURE half (mirrors contract.ts): shape validation,
 * the 5 string scorers, combination, and report formatting. The impure
 * `code-compiles` scorer (spawns a compiler) lives in scorer-runtime.ts and
 * is dispatched by the runtime — never imported here.
 */

import { contractShapeErrors, contractViolations } from "./contract.ts";
import { safeParse } from "./interpolate.ts";

export const SCORER_TYPES = ["exact-match", "contains", "regex", "json-schema", "length-range", "code-compiles"] as const;
export type ScorerType = (typeof SCORER_TYPES)[number];

export const SCORE_COMBINE_MODES = ["all", "any", "weighted"] as const;
export type ScoreCombineMode = (typeof SCORE_COMBINE_MODES)[number];

/** Default weighted-combine threshold (used when `score.threshold` is omitted). */
export const SCORE_DEFAULT_THRESHOLD = 0.5;

/** Languages the code-compiles scorer can check (see scorer-runtime.ts). */
export const CODE_COMPILES_LANGUAGES = ["javascript", "typescript"] as const;

export interface Scorer {
	type: ScorerType;
	/** Result label; defaults to `<type>-<index>`. */
	name?: string;
	/** [exact-match|contains] The string to compare/find. */
	value?: string;
	/** [regex] JS RegExp source. An invalid pattern fails the scorer (with detail). */
	pattern?: string;
	/** [regex] Invert the match result. */
	negate?: boolean;
	/** [json-schema] An `expect`-style contract for the parsed target. */
	schema?: unknown;
	/** [length-range] Inclusive bounds on target length (chars). */
	min?: number;
	max?: number;
	/** [code-compiles] Which compiler to run. */
	language?: (typeof CODE_COMPILES_LANGUAGES)[number];
}

export interface ScorerResult {
	name: string;
	type: ScorerType;
	passed: boolean;
	/** 0 or 1 for deterministic scorers; the judge's [0,1] score when present. */
	score: number;
	detail?: string;
}

/** The `score` field's shape (validated by scorerShapeErrors, not TypeBox —
 *  keeps diagnostics precise and the surface documented in one place). */
export interface ScoreConfig {
	/** Interpolation ref for the scored string. Default: "{previous.output}". */
	target?: string;
	scorers: Scorer[];
	combine?: ScoreCombineMode;
	/** [weighted] Aligned to scorers (+1 trailing judge weight when judge present). */
	weights?: number[];
	/** [weighted] Combined score cutoff in (0, 1]. Default 0.5. */
	threshold?: number;
	/** Optional LLM-as-judge fallback, run only when the deterministics fail. */
	judge?: { agent?: string; task: string };
}

/** Fields every scorer may carry, plus the per-type applicable ones. A field
 *  set on a scorer whose type ignores it is a shape error — silently dropping
 *  `{type:"contains", negate:true}` would let the author believe negation
 *  happened. */
const SCORER_COMMON_KEYS = ["type", "name"] as const;
const SCORER_TYPE_KEYS: Record<ScorerType, readonly string[]> = {
	"exact-match": ["value"],
	contains: ["value"],
	regex: ["pattern", "negate"],
	"json-schema": ["schema"],
	"length-range": ["min", "max"],
	"code-compiles": ["language"],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Statically check an author-written `score` value. Returns human-readable
 * shape errors ([] = valid). Total: never throws on arbitrary JSON-valid
 * input. Mirrors contractShapeErrors (the `expect` validator).
 */
export function scorerShapeErrors(score: unknown, path = "score"): string[] {
	if (!isPlainObject(score)) return [`${path}: must be an object ({scorers: [...], combine?, threshold?, judge?})`];
	const errors: string[] = [];

	if (score.target !== undefined && typeof score.target !== "string")
		errors.push(`${path}.target: must be a string interpolation ref (e.g. "{steps.gen.output}")`);

	if (!Array.isArray(score.scorers) || score.scorers.length === 0) {
		errors.push(`${path}.scorers: must be a non-empty array of scorers`);
		return errors; // scorer-dependent checks below would be noise
	}
	score.scorers.forEach((s, i) => {
		const p = `${path}.scorers[${i}]`;
		if (!isPlainObject(s)) {
			errors.push(`${p}: must be an object with a 'type'`);
			return;
		}
		const t = s.type;
		if (typeof t !== "string" || !(SCORER_TYPES as readonly string[]).includes(t)) {
			errors.push(`${p}.type: must be one of ${SCORER_TYPES.join("|")}`);
			return;
		}
		// Reject fields the scorer's type ignores (and unknown fields outright).
		const allowed = new Set<string>([...SCORER_COMMON_KEYS, ...SCORER_TYPE_KEYS[t as ScorerType]]);
		for (const k of Object.keys(s)) {
			if (!allowed.has(k)) errors.push(`${p}.${k}: not applicable to '${t}' scorers (allowed: ${[...allowed].join(", ")})`);
		}
		if (s.name !== undefined && typeof s.name !== "string") errors.push(`${p}.name: must be a string`);
		if ((t === "exact-match" || t === "contains") && typeof s.value !== "string")
			errors.push(`${p}.value: required string for '${t}'`);
		if (t === "regex") {
			if (typeof s.pattern !== "string") errors.push(`${p}.pattern: required string for 'regex'`);
			if (s.negate !== undefined && typeof s.negate !== "boolean") errors.push(`${p}.negate: must be a boolean`);
		}
		if (t === "json-schema") {
			if (s.schema === undefined) errors.push(`${p}.schema: required for 'json-schema'`);
			else errors.push(...contractShapeErrors(s.schema, `${p}.schema`));
		}
		if (t === "length-range") {
			if (s.min === undefined && s.max === undefined)
				errors.push(`${p}: 'length-range' requires 'min' and/or 'max'`);
			if (s.min !== undefined && (typeof s.min !== "number" || s.min < 0))
				errors.push(`${p}.min: must be a number >= 0`);
			if (s.max !== undefined && (typeof s.max !== "number" || s.max < 0))
				errors.push(`${p}.max: must be a number >= 0`);
			if (typeof s.min === "number" && typeof s.max === "number" && s.min > s.max)
				errors.push(`${p}: min (${s.min}) must be <= max (${s.max})`);
		}
		if (t === "code-compiles") {
			if (typeof s.language !== "string" || !(CODE_COMPILES_LANGUAGES as readonly string[]).includes(s.language))
				errors.push(`${p}.language: must be one of ${CODE_COMPILES_LANGUAGES.join("|")}`);
		}
	});

	const combine = score.combine ?? "all";
	if (typeof combine !== "string" || !(SCORE_COMBINE_MODES as readonly string[]).includes(combine)) {
		errors.push(`${path}.combine: must be one of ${SCORE_COMBINE_MODES.join("|")}`);
	} else if (combine === "weighted") {
		const judgeCount = isPlainObject(score.judge) ? 1 : 0;
		const expected = score.scorers.length + judgeCount;
		if (!Array.isArray(score.weights)) {
			errors.push(`${path}.weights: required array for combine:"weighted" (${expected} entries${judgeCount ? " — last one is the judge's weight" : ""})`);
		} else {
			if (score.weights.length !== expected)
				errors.push(`${path}.weights: expected ${expected} entries (scorers${judgeCount ? " + judge" : ""}), got ${score.weights.length}`);
			score.weights.forEach((w, i) => {
				if (typeof w !== "number" || !Number.isFinite(w) || w <= 0)
					errors.push(`${path}.weights[${i}]: must be a number > 0`);
			});
		}
		if (score.threshold !== undefined && (typeof score.threshold !== "number" || !(score.threshold > 0) || score.threshold > 1))
			errors.push(`${path}.threshold: must be a number in (0, 1]`);
	} else {
		if (score.weights !== undefined) errors.push(`${path}.weights: only valid with combine:"weighted"`);
		if (score.threshold !== undefined) errors.push(`${path}.threshold: only valid with combine:"weighted"`);
	}

	if (score.judge !== undefined) {
		if (!isPlainObject(score.judge)) errors.push(`${path}.judge: must be an object ({agent?, task})`);
		else {
			if (typeof score.judge.task !== "string" || !score.judge.task.trim())
				errors.push(`${path}.judge.task: required non-empty string`);
			if (score.judge.agent !== undefined && typeof score.judge.agent !== "string")
				errors.push(`${path}.judge.agent: must be a string agent name`);
		}
	}

	for (const k of Object.keys(score)) {
		if (!["target", "scorers", "combine", "weights", "threshold", "judge"].includes(k))
			errors.push(`${path}.${k}: unknown score keyword (supported: target, scorers, combine, weights, threshold, judge)`);
	}
	return errors;
}

/** Default result label for a scorer. */
export function scorerName(s: Scorer, index: number): string {
	return typeof s.name === "string" && s.name.trim() ? s.name.trim() : `${s.type}-${index}`;
}

/**
 * Evaluate one PURE scorer against the target string. Total: never throws —
 * an invalid configuration (e.g. a bad regex) fails the scorer with a detail.
 * `code-compiles` is NOT handled here (impure — see scorer-runtime.ts).
 */
export function evaluatePureScorer(scorer: Scorer, index: number, target: string): ScorerResult {
	const name = scorerName(scorer, index);
	const mk = (passed: boolean, detail?: string): ScorerResult => ({
		name,
		type: scorer.type,
		passed,
		score: passed ? 1 : 0,
		detail,
	});
	switch (scorer.type) {
		case "exact-match": {
			const passed = target === (scorer.value ?? "");
			return mk(passed, passed ? undefined : `target (${target.length} chars) !== value (${(scorer.value ?? "").length} chars)`);
		}
		case "contains": {
			const passed = target.includes(scorer.value ?? "");
			return mk(passed, passed ? undefined : `target does not contain ${JSON.stringify(truncate(scorer.value ?? "", 80))}`);
		}
		case "regex": {
			let re: RegExp;
			try {
				re = new RegExp(scorer.pattern ?? "");
			} catch (e) {
				return mk(false, `invalid pattern: ${e instanceof Error ? e.message : String(e)}`);
			}
			const matched = re.test(target);
			const passed = scorer.negate === true ? !matched : matched;
			return mk(passed, passed ? undefined : `/${scorer.pattern}/ ${scorer.negate ? "matched (negated)" : "did not match"}`);
		}
		case "json-schema": {
			// Same lenient parse as the `expect` contract path (fence-extraction
			// included) so a json-schema scorer and an expect contract agree on
			// what "the JSON output" is.
			const parsed = safeParse(target);
			if (parsed === undefined) return mk(false, "target is not valid JSON");
			const violations = contractViolations(parsed, scorer.schema);
			return mk(violations.length === 0, violations.length ? violations.join("; ") : undefined);
		}
		case "length-range": {
			const len = target.length;
			const min = typeof scorer.min === "number" ? scorer.min : 0;
			const max = typeof scorer.max === "number" ? scorer.max : Infinity;
			const passed = len >= min && len <= max;
			return mk(passed, passed ? undefined : `length ${len} outside [${min}, ${max === Infinity ? "∞" : max}]`);
		}
		case "code-compiles":
			// Dispatched by the runtime to scorer-runtime.ts; reaching here means
			// the dispatch was missed — fail visibly rather than fake a pass.
			return mk(false, "code-compiles must be evaluated by the runtime (impure scorer)");
		default:
			return mk(false, `unknown scorer type '${(scorer as { type?: string }).type}'`);
	}
}

/**
 * Combine deterministic scorer results per the combine mode. `judgeWeight`
 * (weighted mode, judge configured but NOT yet run) enlarges the denominator
 * so the deterministic-only combination is a LOWER BOUND: when it already
 * clears the threshold, the judge's score could not change the outcome and
 * the gate may auto-pass without spending judge tokens.
 */
export function combineScores(
	results: ScorerResult[],
	combine: ScoreCombineMode,
	weights?: number[],
	threshold: number = SCORE_DEFAULT_THRESHOLD,
	judgeWeight = 0,
): { combined: number; passed: boolean } {
	if (results.length === 0) return { combined: 0, passed: false };
	if (combine === "any") {
		const passed = results.some((r) => r.passed);
		return { combined: passed ? 1 : 0, passed };
	}
	if (combine === "weighted") {
		const w = Array.isArray(weights) && weights.length >= results.length ? weights : results.map(() => 1);
		let sum = 0;
		let total = judgeWeight;
		for (let i = 0; i < results.length; i++) {
			const wi = typeof w[i] === "number" && w[i] > 0 ? w[i] : 1;
			sum += results[i].score * wi;
			total += wi;
		}
		const combined = total > 0 ? sum / total : 0;
		return { combined, passed: combined >= threshold };
	}
	// "all" (default)
	const passed = results.every((r) => r.passed);
	return { combined: passed ? 1 : 0, passed };
}

/** Fold a completed judge result into a weighted combination (judge = last weight). */
export function combineWithJudge(
	results: ScorerResult[],
	weights: number[] | undefined,
	threshold: number,
	judgeScore: number,
): { combined: number; passed: boolean } {
	const w = Array.isArray(weights) && weights.length === results.length + 1 ? weights : [...results.map(() => 1), 1];
	let sum = 0;
	let total = 0;
	for (let i = 0; i < results.length; i++) {
		sum += results[i].score * w[i];
		total += w[i];
	}
	const jw = w[results.length];
	sum += Math.max(0, Math.min(1, judgeScore)) * jw;
	total += jw;
	const combined = total > 0 ? sum / total : 0;
	return { combined, passed: combined >= threshold };
}

/** Human-readable scorer report — appended to the judge/gate prompt so the
 *  LLM sees exactly which deterministic checks failed and why. */
export function formatScorerReport(results: ScorerResult[], combined: number, threshold?: number): string {
	const lines = results.map((r) => `- [${r.passed ? "PASS" : "FAIL"}] ${r.name} (${r.type})${r.detail ? `: ${r.detail}` : ""}`);
	const summary = threshold !== undefined
		? `Combined score: ${combined.toFixed(3)} (threshold ${threshold})`
		: `Combined score: ${combined.toFixed(3)}`;
	return `## Deterministic scorer report\n${lines.join("\n")}\n${summary}`;
}

/** The structured score result stored as the gate's `ps.json` — reachable
 *  downstream via `{steps.<gate>.json.combined}` / `...json.results.0.passed`. */
export function scoreResultJSON(
	results: ScorerResult[],
	combined: number,
	verdict: "pass" | "block",
	threshold?: number,
	judge?: { score: number; reason?: string },
): Record<string, unknown> {
	const out: Record<string, unknown> = { verdict, combined, results };
	if (threshold !== undefined) out.threshold = threshold;
	if (judge) out.judge = judge;
	return out;
}

/**
 * Parse an LLM judge's output into a score + verdict. Accepts JSON
 * ({score: 0..1, verdict?, reason?}), bare {verdict}, or a text
 * `SCORE: 0.x` / `VERDICT: PASS|BLOCK` marker. Fail-open per the project
 * invariant: unparseable output PASSES with score 1 (ambiguity must not
 * block the flow — same stance as parseGateVerdict).
 */
export function parseJudgeOutput(output: string): {
	score: number;
	verdict: "pass" | "block";
	reason?: string;
	parsed: boolean;
} {
	const clamp = (n: number) => Math.max(0, Math.min(1, n));
	const json = safeParse(output);
	if (json && typeof json === "object" && !Array.isArray(json)) {
		const o = json as Record<string, unknown>;
		const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : undefined;
		const rawScore = typeof o.score === "number" ? o.score : typeof o.score === "string" ? Number(o.score) : NaN;
		const hasScore = Number.isFinite(rawScore);
		if (typeof o.verdict === "string") {
			const block = /block|fail|stop|reject|halt/i.test(o.verdict);
			return { score: hasScore ? clamp(rawScore) : block ? 0 : 1, verdict: block ? "block" : "pass", reason, parsed: true };
		}
		if (hasScore) {
			const s = clamp(rawScore);
			return { score: s, verdict: s >= 0.5 ? "pass" : "block", reason, parsed: true };
		}
	}
	const scoreMatches = [...output.matchAll(/SCORE\s*[:=]\s*([01](?:\.\d+)?)/gi)];
	const verdictMatches = [...output.matchAll(/VERDICT\s*[:=]\s*(PASS|BLOCK|FAIL|STOP|OK|REJECT|HALT)/gi)];
	if (scoreMatches.length || verdictMatches.length) {
		const s = scoreMatches.length ? clamp(Number(scoreMatches[scoreMatches.length - 1][1])) : undefined;
		const v = verdictMatches.length ? verdictMatches[verdictMatches.length - 1][1].toUpperCase() : undefined;
		const blocked = v !== undefined ? !(v === "PASS" || v === "OK") : (s ?? 1) < 0.5;
		return { score: s ?? (blocked ? 0 : 1), verdict: blocked ? "block" : "pass", parsed: true };
	}
	// Fail-open: ambiguous judge output must not block the flow.
	return { score: 1, verdict: "pass", reason: "unparseable judge output (fail-open pass)", parsed: false };
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}
