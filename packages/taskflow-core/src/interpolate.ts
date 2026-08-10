/**
 * Template interpolation for taskflow tasks.
 *
 * Supported placeholders:
 *   {args.X}            invocation argument
 *   {steps.ID.output}   prior phase final output (string)
 *   {steps.ID.json}     prior phase output parsed as JSON (stringified back if object)
 *   {previous.output}   alias for the immediately-preceding completed phase output
 *   {item} / {item.f}   map loop variable (or custom name via phase.as)
 *
 * Unknown placeholders are left intact rather than throwing, so a
 * partially-specified task still runs. The unresolved refs are returned in
 * `missing[]`; the runtime surfaces them as a phase warning (see
 * `warnUnresolvedRefs` in runtime.ts) — logged and persisted to
 * `PhaseState.warnings`.
 */

export interface InterpolationContext {
	args: Record<string, unknown>;
	steps: Record<string, { output: string; json?: unknown }>;
	previousOutput?: string;
	/** loop variable bindings, e.g. { item: {...} } */
	locals?: Record<string, unknown>;
	/** Reflexion summary for loop iterations (loop phases with reflexion: true).
	 *  Resolved by the bare `{reflexion}` placeholder — a single string, no
	 *  sub-path traversal (mirrors {previous.output}). Undefined → the
	 *  placeholder stays intact (a missing warning), like any unknown ref. */
	reflexion?: string;
	/** Observed-read hook (M3): invoked once per successfully-resolved
	 *  placeholder path, so the runtime can capture which upstream phases a
	 *  phase actually consumed (its observed readSet). Unresolved refs do NOT
	 *  fire it (they become `missing` warnings instead). Default undefined →
	 *  zero overhead, fully backward-compatible. */
	onRead?: (ref: string) => void;
}

const PLACEHOLDER = /\{([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\}/g;
const EXACT_PLACEHOLDER = /^\{([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\}$/;

export interface InterpolationResult {
	text: string;
	missing: string[];
}

export function interpolate(
	template: string | null | undefined,
	ctx: InterpolationContext,
): InterpolationResult {
	const missing: string[] = [];

	const text = String(template ?? "").replace(PLACEHOLDER, (whole, path: string) => {
		const value = resolvePath(path, ctx);
		if (value === undefined) {
			missing.push(path);
			return whole;
		}
		return stringify(value);
	});

	return { text, missing };
}

/** Resolve a structured field without stringifying an exact placeholder.
 * This lets flow.with preserve typed args and steps.*.json values, while mixed
 * templates keep the historical string interpolation behavior. */
export function interpolateValue(value: unknown, ctx: InterpolationContext): unknown {
	if (typeof value !== "string") return value;
	const exact = value.match(EXACT_PLACEHOLDER);
	if (exact) {
		const resolved = resolvePath(exact[1], ctx);
		return resolved === undefined ? value : resolved;
	}
	return interpolate(value, ctx).text;
}

/** Resolve + record an observed read (M3 observed-readSet). Fires only on
 *  successful resolution so an unresolved ref is NOT logged as a dependency
 *  (it stays a `missing` warning). The runtime threads a collector here to
 *  capture which upstream phases this phase actually consumed — the overstory
 *  "observed readSet@version" moat (nobody else records this). */
function resolvePath(path: string, ctx: InterpolationContext): unknown {
	const value = _resolvePath(path, ctx);
	if (value !== undefined) ctx.onRead?.(path);
	return value;
}

function _resolvePath(path: string, ctx: InterpolationContext): unknown {
	const parts = path.split(".");
	const head = parts[0];

	// previous.output
	if (head === "previous") {
		if (parts[1] === "output") return ctx.previousOutput ?? undefined;
		return undefined;
	}

	// reflexion — the loop's prior-iteration failure summary (single string,
	// no sub-paths). Only resolves when the runtime supplied one (reflexion
	// loops); otherwise falls through to undefined → missing warning.
	if (head === "reflexion") {
		if (parts.length > 1) return undefined;
		return ctx.reflexion ?? undefined;
	}

	// args.*
	if (head === "args") {
		return dig(ctx.args, parts.slice(1));
	}

	// steps.<id>.output | steps.<id>.json | steps.<id>.json.<field>
	if (head === "steps") {
		const stepId = parts[1];
		const step = stepId ? ctx.steps[stepId] : undefined;
		if (!step) return undefined;
		const field = parts[2];
		if (field === "output") {
			// Guard: {steps.X.output.trailing} — trailing segments after output are
			// likely author errors (output is a string, not an object). Return
			// undefined so the placeholder is left intact with a missing warning.
			if (parts.length > 3) return undefined;
			return step.output;
		}
		if (field === "json") {
			const json = step.json ?? safeParse(step.output);
			return dig(json, parts.slice(3));
		}
		return undefined;
	}

	// locals (map loop variable), e.g. item / item.field
	if (ctx.locals && head in ctx.locals) {
		return dig(ctx.locals[head], parts.slice(1));
	}

	return undefined;
}

/**
 * Traverse an object by a sequence of property keys. Returns `undefined`
 * when any segment is missing or the current value is not an object —
 * never throws, so extra path segments like {steps.X.json.a.b} where the
 * data is shallower resolve gracefully to undefined (M-8).
 */
function dig(obj: unknown, parts: string[]): unknown {
	let cur: unknown = obj;
	for (const part of parts) {
		if (cur === null || cur === undefined) return undefined;
		if (typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function safeParse(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	// Direct parse
	try {
		return JSON.parse(trimmed);
	} catch {
		// noop
	}
	// Extract from fenced blocks. Outputs often contain multiple fences
	// (e.g. a ```typescript evidence block before the ```json payload), so try
	// every fence — json-tagged blocks first, then untagged/other blocks.
	// Linear-time by construction: the info string `[^\n`]*` stops at the first
	// newline (no overlap with the body's `[\s\S]*?`), so there is no ambiguous
	// whitespace backtracking (js/polynomial-redos safe).
	const fenceRe = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
	const fenced: { lang: string; body: string }[] = [];
	let fm: RegExpExecArray | null;
	while ((fm = fenceRe.exec(trimmed)) !== null) {
		fenced.push({ lang: fm[1].trim().toLowerCase(), body: fm[2].trim() });
	}
	const ordered = [...fenced.filter((b) => b.lang === "json"), ...fenced.filter((b) => b.lang !== "json")];
	for (const block of ordered) {
		try {
			return JSON.parse(block.body);
		} catch {
			// noop — try the next fence
		}
	}
	// Extract the first balanced [...] or {...}
	const arrStart = trimmed.indexOf("[");
	const objStart = trimmed.indexOf("{");
	const start =
		arrStart === -1 ? objStart : objStart === -1 ? arrStart : Math.min(arrStart, objStart);
	if (start !== -1) {
		const open = trimmed[start];
		const close = open === "[" ? "]" : "}";
		const end = trimmed.lastIndexOf(close);
		if (end > start) {
			try {
				return JSON.parse(trimmed.slice(start, end + 1));
			} catch {
				// noop
			}
		}
	}
	// Anti-pattern detection (v0.0.8.1): array followed by a stray top-level
	// "key": value. A common LLM mistake — the model appends
	// `"deferred": [...]` after a JSON array, producing a non-JSON hybrid that
	// none of the above strategies can recover. We surface a diagnostic hint
	// so flow authors can spot the bug fast.
	//
	// We check the original (trimmed) input rather than the slice tail,
	// because `lastIndexOf(close)` lands on the *last* bracket — for the
	// anti-pattern the stray key is between the array's `]` and the trailing
	// `]`, not after the last one.
	if (/][\s\},]*"[^"\n]+"\s*:/.test(trimmed)) {
		console.warn(
			"[pi-taskflow safeParse] input looks like a JSON array followed by a stray top-level key " +
				`(pattern: [{...}], "key": ...). This is not valid JSON. ` +
				`Hint: put extra data as array members (e.g. {"id":"D-001","status":"deferred",...}) ` +
				`or split into a separate phase.`,
		);
	}
	return undefined;
}

/**
 * Strict JSON parse for files the USER authored or pointed at (as opposed to
 * `safeParse`, which is deliberately lenient for LLM/subagent output).
 *
 * Unlike `safeParse`, this THROWS on malformed input and preserves the original
 * `SyntaxError` — V8's message carries the offending byte position and, since
 * Node 17, a `lineNumber`/`columnNumber` pair. File loaders surface that to
 * the user so they can fix a stray bare newline (or similar) in seconds
 * instead of chasing a phantom "file not found".
 *
 * When `allowFence` is set (used by `defineFile`, which may point at a markdown
 * draft wrapping the JSON in a ```json block), a fenced block is tried if the
 * whole-document parse fails — but the *underlying* parse error is still
 * thrown if no block parses, so the position is never lost.
 */
export function parseStrict(text: string, opts?: { allowFence?: boolean }): unknown {
	const trimmed = text.trim();
	if (!trimmed) throw new SyntaxError("Cannot parse an empty document.");
	// Keep the FIRST SyntaxError we see — it points at the real problem in the
	// most natural location (whole-document first, then each fence body).
	let firstError: unknown;
	try {
		return JSON.parse(trimmed);
	} catch (e) {
		firstError = e;
		if (!opts?.allowFence) throw e;
	}
	// Same fence regex as safeParse (see comment there for ReDoS safety).
	const fenceRe = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
	let fm: RegExpExecArray | null;
	while ((fm = fenceRe.exec(trimmed)) !== null) {
		if (fm[1].trim().toLowerCase() === "json") {
			try {
				return JSON.parse(fm[2].trim());
			} catch (e) {
				firstError ??= e;
			}
		}
	}
	throw firstError;
}

/** Coerce a parsed value into an array for map fan-out. */
export function coerceArray(value: unknown): unknown[] | null {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") {
		// {items: [...]} or {results: [...]} convenience
		for (const key of ["items", "results", "list", "data", "findings"]) {
			const v = (value as Record<string, unknown>)[key];
			if (Array.isArray(v)) return v;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Conditional expressions (phase.when)
// ---------------------------------------------------------------------------
//
// A tiny, safe boolean expression language — NO eval / Function. Operands are
// either interpolation placeholders `{...}` (resolved to their raw value) or
// literals (quoted string, number, true/false/null, or a bare word treated as
// a string). Operators, by precedence (low → high):
//
//   ||   logical or
//   &&   logical and
//   ==  != == >= <= > <   comparison
//   !    logical not / unary
//   ( )  grouping
//
// A bare operand is evaluated for truthiness. Parse errors fail OPEN (return
// true) so a malformed guard never silently drops a phase.

type Tok =
	| { t: "ref"; v: string }
	| { t: "str"; v: string }
	| { t: "num"; v: number }
	| { t: "bool"; v: boolean }
	| { t: "null" }
	| { t: "op"; v: string };

const OPS = ["&&", "||", "==", "!=", ">=", "<=", ">", "<", "!", "(", ")"];

function tokenize(input: string): Tok[] {
	const toks: Tok[] = [];
	let i = 0;
	const n = input.length;
	while (i < n) {
		const c = input[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		// placeholder {path.to.value}
		if (c === "{") {
			const end = input.indexOf("}", i);
			if (end === -1) throw new Error("unterminated placeholder");
			toks.push({ t: "ref", v: input.slice(i + 1, end).trim() });
			i = end + 1;
			continue;
		}
		// quoted string
		if (c === '"' || c === "'") {
			// Handle escaped quotes. Note: ALL \X sequences are interpreted as literal X
			// (including \n → n, \t → t). This differs from JSON/JS escaping but is
			// correct for condition strings which only need quote escaping.
			let j = i + 1;
			let val = "";
			while (j < n) {
				if (input[j] === "\\" && j + 1 < n) {
					val += input[j + 1];
					j += 2;
				} else if (input[j] === c) {
					break;
				} else {
					val += input[j];
					j++;
				}
			}
			if (j >= n) throw new Error("unterminated string");
			toks.push({ t: "str", v: val });
			i = j + 1;
			continue;
		}
		// multi/single char operators
		const op = OPS.find((o) => input.startsWith(o, i));
		if (op) {
			toks.push({ t: "op", v: op });
			i += op.length;
			continue;
		}
		// number
		const numMatch = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(input.slice(i));
		if (numMatch) {
			toks.push({ t: "num", v: Number(numMatch[0]) });
			i += numMatch[0].length;
			continue;
		}
		// bareword → literal (true/false/null keywords, else string)
		const word = /^[^\s&|!=<>()"'{}]+/.exec(input.slice(i));
		if (word) {
			const w = word[0];
			if (w === "true") toks.push({ t: "bool", v: true });
			else if (w === "false") toks.push({ t: "bool", v: false });
			else if (w === "null") toks.push({ t: "null" });
			else toks.push({ t: "str", v: w });
			i += w.length;
			continue;
		}
		throw new Error(`unexpected char '${c}'`);
	}
	return toks;
}

function isNumeric(v: unknown): boolean {
	if (typeof v === "number") return Number.isFinite(v);
	if (typeof v === "string" && v.trim() !== "") return Number.isFinite(Number(v));
	return false;
}

function truthy(v: unknown): boolean {
	if (v === undefined || v === null) return false;
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		return !(s === "" || s === "false" || s === "0" || s === "no" || s === "off" || s === "null");
	}
	if (Array.isArray(v)) return v.length > 0;
	if (typeof v === "object") return Object.keys(v as object).length > 0;
	return Boolean(v);
}

function compare(a: unknown, op: string, b: unknown): boolean {
	if (isNumeric(a) && isNumeric(b)) {
		const x = Number(a);
		const y = Number(b);
		switch (op) {
			case "==": return x === y;
			case "!=": return x !== y;
			case ">": return x > y;
			case "<": return x < y;
			case ">=": return x >= y;
			case "<=": return x <= y;
		}
	}
	const sa = a === undefined || a === null ? "" : String(a);
	const sb = b === undefined || b === null ? "" : String(b);
	switch (op) {
		case "==": return sa === sb;
		case "!=": return sa !== sb;
		case ">": return sa > sb;
		case "<": return sa < sb;
		case ">=": return sa >= sb;
		case "<=": return sa <= sb;
	}
	return false;
}

/** Recursive-descent parser/evaluator over the token stream. */
class CondParser {
	private pos = 0;
	private readonly toks: Tok[];
	private readonly ctx: InterpolationContext;
	constructor(toks: Tok[], ctx: InterpolationContext) {
		this.toks = toks;
		this.ctx = ctx;
	}

	parse(): unknown {
		const v = this.parseOr();
		if (this.pos < this.toks.length) throw new Error("trailing tokens");
		return v;
	}
	private peek(): Tok | undefined {
		return this.toks[this.pos];
	}
	private eat(op: string): boolean {
		const t = this.peek();
		if (t && t.t === "op" && t.v === op) {
			this.pos++;
			return true;
		}
		return false;
	}
	private parseOr(): unknown {
		let left = this.parseAnd();
		while (this.eat("||")) {
			const right = this.parseAnd();
			left = truthy(left) || truthy(right);
		}
		return left;
	}
	private parseAnd(): unknown {
		let left = this.parseNot();
		while (this.eat("&&")) {
			const right = this.parseNot();
			left = truthy(left) && truthy(right);
		}
		return left;
	}
	private parseNot(): unknown {
		if (this.eat("!")) return !truthy(this.parseNot());
		return this.parseComparison();
	}
	private parseComparison(): unknown {
		const left = this.parsePrimary();
		const t = this.peek();
		if (t && t.t === "op" && ["==", "!=", ">", "<", ">=", "<="].includes(t.v)) {
			this.pos++;
			const right = this.parsePrimary();
			return compare(left, t.v, right);
		}
		return left;
	}
	private parsePrimary(): unknown {
		if (this.eat("(")) {
			const v = this.parseOr();
			if (!this.eat(")")) throw new Error("missing )");
			return v;
		}
		const t = this.peek();
		if (!t) throw new Error("unexpected end");
		this.pos++;
		switch (t.t) {
			case "ref": return resolvePath(t.v, this.ctx);
			case "str": return t.v;
			case "num": return t.v;
			case "bool": return t.v;
			case "null": return null;
			default: throw new Error(`unexpected operator '${(t as { v: string }).v}'`);
		}
	}
}

/**
 * Evaluate a `when` expression to a boolean. Returns `{ value, error }`.
 * Parse errors set `error` and fail OPEN (`value: true`) so a broken guard
 * never silently drops a phase.
 */
export function tryEvaluateCondition(
	expr: string,
	ctx: InterpolationContext,
): { value: boolean; error?: string } {
	const trimmed = (expr ?? "").trim();
	if (!trimmed) return { value: true };
	try {
		const toks = tokenize(trimmed);
		if (toks.length === 0) return { value: true };
		const result = new CondParser(toks, ctx).parse();
		return { value: truthy(result) };
	} catch (e) {
		return { value: true, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Boolean convenience wrapper over {@link tryEvaluateCondition}. */
export function evaluateCondition(expr: string, ctx: InterpolationContext): boolean {
	return tryEvaluateCondition(expr, ctx).value;
}
