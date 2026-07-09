/**
 * Canonical normalization of `when` / `until` / `eval` condition expressions.
 *
 * This is the **condition-IR seam** of the overstory-convergence roadmap's
 * FlowIR compiler: it lifts a raw condition string into a stable
 * {@link NormalizedCond} descriptor that two future consumers share:
 *
 *  - **Hashing** (consumer a): structurally-equivalent conditions MUST
 *    normalize to the same `canonical` string so they fold identically into
 *    the FlowIR content hash (whitespace, operator spacing, and redundant
 *    enclosing parens do not change meaning → must not change the hash).
 *  - **Deterministic replay** (consumer b): the `when-guard` decision is
 *    re-evaluated from the recorded expression; `refs` tells replay exactly
 *    which `steps.*` / `args.*` / `env.*` inputs the guard read so it can
 *    rebind them from the event log without token spend.
 *
 * **Single source of truth — no semantic drift.** The condition grammar
 * (tokenizer + recursive-descent parser + comparison/truthiness semantics)
 * lives in {@link ../interpolate.ts}. This module REUSES that parser by
 * delegating parse-validation (and fail-open semantics) to
 * {@link tryEvaluateCondition} — it does NOT duplicate or reimplement the
 * tokenizer/parser. If the parser accepts an expression, it is structurally
 * valid and we normalize its surface text; if the parser rejects it, we
 * fail open (see {@link normalizeCond}) so a broken guard never silently
 * drops a phase — matching the project's fail-open-for-guards invariant.
 *
 * The `canonical` form is a surface normalization (whitespace removal +
 * redundant enclosing-paren stripping with string-literal contents
 * preserved), not a full AST rewrite: for valid expressions whitespace only
 * separates tokens, so removing it (after protecting quoted literals) yields
 * a stable concatenation that is invariant under the cosmetic differences
 * hashing cares about. Reference extraction runs on the **literal-protected**
 * surface so `{steps.*}` text inside string literals is never treated as a
 * real dependency.
 *
 * Pure module: no IO, no `Date`, no randomness, never throws.
 *
 * @see docs/rfc-0.2.0-architecture.md §5.4 (`flowir/cond.ts` — 条件归一化)
 * @see ../interpolate.ts for the shared condition parser (tokenize / CondParser / compare / tryEvaluateCondition)
 */

import { tryEvaluateCondition, type InterpolationContext } from "../interpolate.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A condition expression lifted into a stable, hashable descriptor.
 *
 * - `source`  — the original expression text, verbatim (never normalized).
 * - `canonical` — a stable normalized surface form: whitespace-collapsed,
 *   operator-spacing-invariant, redundant enclosing parens stripped, with
 *   quoted-string contents preserved. Structurally-equivalent expressions
 *   produce byte-identical `canonical` strings.
 * - `refs` — the `steps.<id>…` / `args.<name>…` / `env.<VAR>…` references
 *   the expression reads (in first-occurrence order, de-duplicated). Empty
 *   when the expression failed to parse (fail-open). Placeholders that only
 *   appear inside string literals are **not** counted as refs.
 */
export interface NormalizedCond {
	source: string;
	canonical: string;
	refs: string[];
}

// ---------------------------------------------------------------------------
// Reference extraction (static scan — mirrors `collectRefs` in schema.ts)
// ---------------------------------------------------------------------------

/**
 * Matches `{steps.X}`, `{args.Y}`, `{env.Z}` placeholders, tolerant of
 * inner whitespace (the tokenizer trims inside braces, so `{ steps.x }` and
 * `{steps.x}` are the same ref). Captures the full dotted path so replay
 * knows precisely which input was read (e.g. `steps.triage.json.route`).
 */
const REF_RE = /\{\s*(steps|args|env)\.([a-zA-Z0-9_.-]+?)\s*\}/g;

/**
 * Extract refs from expression text that has already had string literals
 * replaced by placeholders (see {@link protectLiterals}). Scanning the
 * protected surface prevents false-positive refs for placeholder-looking
 * text that only appears inside quotes.
 */
function extractRefsFromProtected(protectedText: string): string[] {
	const seen = new Set<string>();
	const refs: string[] = [];
	REF_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = REF_RE.exec(protectedText)) !== null) {
		const ref = `${m[1]}.${m[2]}`;
		if (!seen.has(ref)) {
			seen.add(ref);
			refs.push(ref);
		}
	}
	return refs;
}

// ---------------------------------------------------------------------------
// Canonical surface form
// ---------------------------------------------------------------------------

/**
 * Protect quoted string literals (single or double quoted, with `\` escapes
 * preserved byte-for-byte) by replacing each with a whitespace-free
 * `\u0000<index>\u0000` placeholder. This preserves their contents
 * (including internal spaces and escape sequences) through whitespace
 * removal and prevents their inner parens/operators/placeholder-looking
 * text from confusing the paren stripper or ref extractor.
 * Returns the protected string and the list of original literals.
 */
function protectLiterals(expr: string): { text: string; literals: string[] } {
	const literals: string[] = [];
	let out = "";
	let i = 0;
	const n = expr.length;
	while (i < n) {
		const c = expr[i];
		if (c === '"' || c === "'") {
			let j = i + 1;
			let val = c; // include opening quote
			while (j < n) {
				if (expr[j] === "\\" && j + 1 < n) {
					// Preserve the escape sequence intact (do not drop `\`).
					val += expr[j] + expr[j + 1];
					j += 2;
				} else if (expr[j] === c) {
					val += c; // closing quote
					j++;
					break;
				} else {
					val += expr[j];
					j++;
				}
			}
			// Unterminated string: keep whatever we scanned (incl. opening quote).
			literals.push(val);
			out += `\u0000${literals.length - 1}\u0000`;
			i = j;
		} else {
			out += c;
			i++;
		}
	}
	return { text: out, literals };
}

function restoreLiterals(text: string, literals: string[]): string {
	return text.replace(/\u0000(\d+)\u0000/g, (_m, idx) => literals[Number(idx)] ?? "");
}

/**
 * Repeatedly strip a single layer of redundant enclosing parentheses — i.e.
 * parens that wrap the *entire* expression: `((a==b))` → `(a==b)` → `a==b`.
 * Operates on literal-protected, whitespace-free input so string contents
 * and refs (which contain no parens) cannot unbalance the depth counter.
 * Inner redundant parens like `a && (b)` are intentionally left in place —
 * removing them correctly would require AST knowledge (precedence), which is
 * the parser's job, not this normalizer's.
 */
function stripEnclosingParens(s: string): string {
	for (;;) {
		if (s.length < 2 || s[0] !== "(") break;
		let depth = 0;
		let end = -1;
		for (let k = 0; k < s.length; k++) {
			const ch = s[k];
			if (ch === "(") depth++;
			else if (ch === ")") {
				depth--;
				if (depth === 0) {
					end = k;
					break;
				}
			}
		}
		if (end === s.length - 1) {
			s = s.slice(1, -1);
		} else {
			break;
		}
	}
	return s;
}

/**
 * Produce the canonical surface form of a (parser-accepted) expression:
 * protect string literals → remove all whitespace → strip redundant
 * enclosing parens → restore literals. For a valid expression whitespace
 * only separates tokens, so its removal is semantics-preserving and yields a
 * form invariant under the cosmetic differences (spacing / redundant outer
 * parens) that hashing must ignore.
 */
function canonicalize(expr: string): string {
	const { text, literals } = protectLiterals(expr);
	let compact = text.replace(/\s+/g, "");
	compact = stripEnclosingParens(compact);
	return restoreLiterals(compact, literals);
}

// ---------------------------------------------------------------------------
// normalizeCond
// ---------------------------------------------------------------------------

/**
 * Normalize a `when` / `until` / `eval` condition expression.
 *
 * The expression is parsed (validated) by reusing the shared condition
 * parser in {@link ../interpolate.ts} via {@link tryEvaluateCondition}; on a
 * parse error this **fails open** — returning `{ source, canonical:
 * source.trim(), refs: [] }` — so a malformed guard is never silently
 * dropped and never crashes a compile/replay pass. This mirrors the
 * project's fail-open-for-guards invariant (`when` parse errors → phase
 * still runs). Never throws.
 *
 * On success, `canonical` is the whitespace/paren-normalized surface form
 * (stable for hashing) and `refs` are the `steps.*` / `args.*` / `env.*`
 * references the expression reads (for replay rebinding). Placeholders that
 * only appear inside string literals are excluded from `refs`.
 */
export function normalizeCond(expr: string): NormalizedCond {
	const source = typeof expr === "string" ? expr : expr == null ? "" : String(expr);
	const trimmed = source.trim();

	// Reuse the interpolate condition parser to validate parseability and
	// inherit its fail-open semantics. An empty probing context is fine: ref
	// resolution returns `undefined` for missing steps/args but never throws,
	// so `error` is purely syntactic (tokenize/parse failures).
	const probe: InterpolationContext = { args: {}, steps: {} };
	const { error } = tryEvaluateCondition(trimmed, probe);

	if (error) {
		// Fail open: keep the raw (trimmed) text as canonical, no refs.
		return { source, canonical: trimmed, refs: [] };
	}

	const { text: protectedText } = protectLiterals(trimmed);
	return {
		source,
		canonical: canonicalize(trimmed),
		refs: extractRefsFromProtected(protectedText),
	};
}
