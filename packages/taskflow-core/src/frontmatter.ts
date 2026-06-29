/**
 * Minimal YAML-frontmatter parser for agent `.md` files.
 *
 * Vendored so taskflow-core stays dependency-free (the host SDK's
 * `parseFrontmatter` pulls in the `yaml` package). Agent frontmatter is flat
 * `key: value` — scalars, quoted strings, comma lists, or inline `[a, b]`
 * sequences — which is all this parser needs to support. Anything it can't
 * parse degrades to a string value (the caller already tolerates that).
 */

export interface Frontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
}

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function extract(content: string): { yamlString: string | null; body: string } {
	const normalized = normalizeNewlines(content);
	if (!normalized.startsWith("---")) return { yamlString: null, body: normalized };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { yamlString: null, body: normalized };
	return {
		yamlString: normalized.slice(4, endIndex),
		body: normalized.slice(endIndex + 4).trim(),
	};
}

/** Strip one layer of matching quotes. */
function unquote(s: string): string {
	const t = s.trim();
	if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
		return t.slice(1, -1);
	}
	return t;
}

/** Parse a scalar value, an inline `[a, b]` sequence, or a quoted string. */
function parseValue(raw: string): unknown {
	const v = raw.trim();
	if (v === "") return "";
	// Inline flow sequence: [a, b, c]
	if (v.startsWith("[") && v.endsWith("]")) {
		const inner = v.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(",").map((x) => unquote(x)).filter((x) => x.length > 0);
	}
	// Booleans / null kept as their YAML meaning so the caller can reject them.
	if (v === "true") return true;
	if (v === "false") return false;
	if (v === "null" || v === "~") return null;
	return unquote(v);
}

/**
 * Parse frontmatter from a markdown file. Returns `{ frontmatter, body }`.
 * Lines that aren't `key: value` (e.g. block sequences) are skipped; the caller
 * only relies on flat keys.
 */
export function parseFrontmatter(content: string): Frontmatter {
	const { yamlString, body } = extract(content);
	if (!yamlString) return { frontmatter: {}, body };
	const frontmatter: Record<string, unknown> = {};
	const lines = yamlString.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		// Block sequence item (`- value`) is consumed by its parent key below.
		if (trimmed.startsWith("- ")) continue;
		const colon = trimmed.indexOf(":");
		if (colon === -1) continue;
		const key = trimmed.slice(0, colon).trim();
		if (!key) continue;
		const rest = trimmed.slice(colon + 1).trim();
		if (rest === "") {
			// Possibly a block sequence: collect following `- item` lines.
			const items: string[] = [];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const next = lines[j];
				const nt = next.trim();
				if (nt === "" || nt.startsWith("#")) continue;
				if (next.match(/^\s+-\s/)) {
					items.push(unquote(nt.replace(/^-\s*/, "")));
				} else break;
			}
			if (items.length > 0) {
				frontmatter[key] = items.filter((x) => x.length > 0);
				i = j - 1; // skip consumed sequence lines
			} else {
				frontmatter[key] = "";
			}
			continue;
		}
		frontmatter[key] = parseValue(rest);
	}
	return { frontmatter, body };
}

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
