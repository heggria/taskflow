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
 * Unknown placeholders are left intact (with a recorded warning) rather than
 * throwing, so a partially-specified task still runs.
 */

export interface InterpolationContext {
	args: Record<string, unknown>;
	steps: Record<string, { output: string; json?: unknown }>;
	previousOutput?: string;
	/** loop variable bindings, e.g. { item: {...} } */
	locals?: Record<string, unknown>;
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\}/g;

export interface InterpolationResult {
	text: string;
	missing: string[];
}

export function interpolate(template: string, ctx: InterpolationContext): InterpolationResult {
	const missing: string[] = [];

	const text = template.replace(PLACEHOLDER, (whole, path: string) => {
		const value = resolvePath(path, ctx);
		if (value === undefined) {
			missing.push(path);
			return whole;
		}
		return stringify(value);
	});

	return { text, missing };
}

function resolvePath(path: string, ctx: InterpolationContext): unknown {
	const parts = path.split(".");
	const head = parts[0];

	// previous.output
	if (head === "previous") {
		if (parts[1] === "output") return ctx.previousOutput ?? undefined;
		return undefined;
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
		if (field === "output") return step.output;
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
	// Extract from a ```json fenced block
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) {
		try {
			return JSON.parse(fence[1].trim());
		} catch {
			// noop
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
	return undefined;
}

/** Coerce a parsed value into an array for map fan-out. */
export function coerceArray(value: unknown): unknown[] | null {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") {
		// {items: [...]} or {results: [...]} convenience
		for (const key of ["items", "results", "list", "data"]) {
			const v = (value as Record<string, unknown>)[key];
			if (Array.isArray(v)) return v;
		}
	}
	return null;
}
