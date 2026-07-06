/**
 * Zero-dependency JSONC (JSON with Comments) strip + parse.
 *
 * Flow definition files are hand-authored, and authors want to annotate them
 * with `//` line comments and `/* block *​/` comments just like jsonc/JSON5.
 * Standard `JSON.parse` rejects comments outright. This module strips comments
 * (only those OUTSIDE string literals) and trailing commas before parsing, so
 * a flow `.json` file may legally contain comments.
 *
 * Scope: this is used ONLY for user-authored flow definition files
 * (readFlowFile). It must NOT be used to parse LLM/subagent output — that path
 * (safeParse) stays strict by design, since model output is untrusted and we
 * want structural failures to surface.
 *
 * The algorithm is a single linear scan that tracks whether the cursor is
 * inside a string literal (respecting `\"` escapes). Comments are replaced
 * with spaces so that line/column numbers in any error message stay aligned
 * with the original source. Trailing commas before a closing brace/bracket
 * (like `{"a": 1,}` or `[1, 2,]`) are also removed — a common hand-editing
 * convenience that JSON.parse rejects.
 */

/** Strip JSONC comments (// line and block) and trailing commas. Exported for testing. */
export function stripJsonComments(input: string): string {
	let out = "";
	let i = 0;
	const n = input.length;

	while (i < n) {
		const ch = input[i];
		const next = input[i + 1];

		// String literal — copy verbatim, honoring escape sequences. A `//` or
		// `/*` that appears inside a string is part of the value, not a comment,
		// and a `,` inside a string is not a trailing comma.
		if (ch === '"') {
			out += ch;
			i++;
			while (i < n) {
				const c = input[i];
				if (c === "\\" && i + 1 < n) {
					// Keep the escape char and the escaped char together.
					out += c + input[i + 1];
					i += 2;
					continue;
				}
				out += c;
				i++;
				if (c === '"') break;
			}
			continue;
		}

		// Line comment `// ... \n` — drop it (do not emit a space, so line
		// numbers stay aligned with the original source).
		if (ch === "/" && next === "/") {
			while (i < n && input[i] !== "\n") i++;
			continue;
		}

		// Block comment `/* ... */` — replace with a single space so that
		// positions of the surrounding tokens are preserved.
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++;
			i += 2; // consume the closing */
			out += " ";
			continue;
		}

		// Trailing comma: skip the comma when the next non-whitespace char is
		// a closing brace or bracket. Only checked outside string literals.
		// Newlines between the comma and the closer are preserved so that
		// line numbers stay aligned with the original source.
		if (ch === ",") {
			let j = i + 1;
			let sawNewline = false;
			while (j < n) {
				const c = input[j];
				if (c === " " || c === "\t" || c === "\r") {
					j++;
				} else if (c === "\n") {
					sawNewline = true;
					j++;
				} else {
					break;
				}
			}
			if (j < n && (input[j] === "}" || input[j] === "]")) {
				if (sawNewline) out += "\n";
				i = j;
				continue;
			}
		}

		out += ch;
		i++;
	}

	return out;
}

/**
 * Parse a JSONC string (JSON with comments and trailing commas allowed) into a
 * value of type T. Throws the same SyntaxError `JSON.parse` would throw for any
 * other structural problem, so callers can wrap it in try/catch as usual.
 */
export function parseJsonc<T = unknown>(input: string): T {
	return JSON.parse(stripJsonComments(input)) as T;
}
