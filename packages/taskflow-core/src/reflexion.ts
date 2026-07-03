/**
 * Reflexion memory for loop phases — pure helpers.
 *
 * When a loop phase sets `reflexion: true`, each iteration i > 1 receives a
 * `{reflexion}` placeholder carrying a structured failure summary of the
 * immediately-prior iteration: what happened (contract violation / subagent
 * error / until-not-met), the precise diagnostics, and a truncated output
 * snippet. The model iterates WITH the failure signal instead of re-guessing
 * from a bare output (Reflexion, Shinn et al. 2023 — as a declarative field).
 *
 * Pure and total: assembly never throws on any input (the runtime additionally
 * wraps the call fail-open — a reflexion bug must never sink the phase).
 */

/** Cap on the assembled reflexion block (chars). Keeps the injected context
 *  from crowding out the actual task in the iteration prompt. */
export const REFLEXION_MAX_CHARS = 2000;

/** What iteration 1 sees: there is no prior iteration to reflect on. */
export const REFLEXION_SENTINEL = "_(first iteration — no prior feedback yet)_";

/** How the prior iteration ended, for the summary headline. */
export type ReflexionOutcome =
	| "until-not-met" // succeeded, but the stop condition evaluated false
	| "contract-violation" // expect contract failed (strongest signal)
	| "subagent-error"; // runner/exit failure

export interface ReflexionInput {
	/** 1-based index of the PRIOR iteration being summarized. */
	iteration: number;
	outcome: ReflexionOutcome;
	/** The prior iteration's raw output (or error-bearing output on failure). */
	output?: string;
	/** errorMessage of a failed prior iteration (contract diagnostics live here). */
	errorMessage?: string;
	/** The loop's `until` expression (shown when outcome is until-not-met). */
	until?: string;
}

/**
 * Build the reflexion summary block injected into the next iteration's prompt.
 * Sections are conditional — no empty headings. Total: never throws.
 */
export function buildReflexionSummary(input: ReflexionInput, maxChars: number = REFLEXION_MAX_CHARS): string {
	const lines: string[] = [`## Reflexion: iteration ${input.iteration} (prior)`];
	switch (input.outcome) {
		case "contract-violation":
			lines.push("- Outcome: FAILED — output contract violated");
			break;
		case "subagent-error":
			lines.push("- Outcome: FAILED — subagent error");
			break;
		case "until-not-met":
			lines.push("- Outcome: succeeded, but the stop condition was not met");
			if (input.until) lines.push(`- Stop condition still false: \`${oneLine(input.until, 200)}\``);
			break;
	}
	const diags = extractContractDiagnostics(input.errorMessage);
	if (diags.length > 0) {
		lines.push("- Contract diagnostics:");
		for (const d of diags) lines.push(`  - ${oneLine(d, 200)}`);
	} else if (input.outcome !== "until-not-met" && input.errorMessage) {
		lines.push(`- Error: ${oneLine(input.errorMessage, 400)}`);
	}
	lines.push("- Fix the issues above in this iteration.");

	const head = lines.join("\n");
	const output = (input.output ?? "").trim();
	if (!output) return truncateBlock(head, maxChars);

	// Fit the output snippet into whatever budget the headline left over.
	const frame = "\n- Prior output (truncated):\n```\n";
	const close = "\n```";
	const budget = maxChars - head.length - frame.length - close.length;
	if (budget < 40) return truncateBlock(head, maxChars); // no room for a useful snippet
	const snippet = truncateMiddle(output, budget);
	return `${head}${frame}${snippet}${close}`;
}

/**
 * Pull the per-path diagnostics out of a runOne contract-violation
 * errorMessage ("Output contract violated:\n- $.score: …\n- …").
 * Returns [] for any other error shape.
 */
export function extractContractDiagnostics(errorMessage?: string): string[] {
	if (!errorMessage || !errorMessage.startsWith("Output contract violated")) return [];
	return errorMessage
		.split("\n")
		.slice(1)
		.map((l) => l.replace(/^-\s*/, "").trim())
		.filter((l) => l.length > 0);
}

/** True when the errorMessage carries a contract violation (classification
 *  for ReflexionInput.outcome). */
export function isContractViolation(errorMessage?: string): boolean {
	return typeof errorMessage === "string" && errorMessage.startsWith("Output contract violated");
}

/** Keep first ~60% and last ~30% of an over-budget string (errors often sit
 *  at the end; intent at the start). */
function truncateMiddle(s: string, budget: number): string {
	if (s.length <= budget) return s;
	const marker = `\n…[truncated ${s.length - budget} chars]…\n`;
	const usable = budget - marker.length;
	if (usable < 20) return s.slice(0, Math.max(0, budget));
	const headLen = Math.floor(usable * 0.65);
	const tailLen = usable - headLen;
	return s.slice(0, headLen) + marker + s.slice(s.length - tailLen);
}

function truncateBlock(s: string, maxChars: number): string {
	return s.length <= maxChars ? s : `${s.slice(0, maxChars - 1)}…`;
}

function oneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
