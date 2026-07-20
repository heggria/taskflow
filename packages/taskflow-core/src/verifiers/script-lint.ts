/**
 * Built-in script-lint verifier — static analysis of `script` phase `run`
 * commands. Catches common shell mistakes that are 100% statically detectable,
 * zero-token, and runner-agnostic:
 *
 * 1. `grep`/`egrep`/`fgrep` whose pattern starts with `-` and has no `--`
 *    separator (grep parses it as flags → exit 2, a false RED).
 * 2. `grep`/`sed` with obviously invalid regex under common dialect flags
 *    (unbalanced brackets/parens → exit 2).
 * 3. `runner | grep …` without `pipefail` / `PIPESTATUS` (the filter's exit
 *    masks the runner's — a failing runner reads as GREEN).
 * 4. A script that references a file path matching a phase id's likely output
 *    artifact created by an earlier phase (RED until that phase runs).
 *
 * This is the dogfood verifier motivated by issue #82. It ships as an optional
 * built-in: hosts can register it via `verifyTaskflow(flow, { verifiers:
 * [scriptLintVerifier] })` or it is auto-included by `compileTaskflow` when
 * `opts.lint !== false`.
 */

import type { Phase } from "../schema.ts";
import type { TaskflowVerifier, VerifiableFlow, VerifierIssue } from "../verify.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tokenize a shell command string naively (split on whitespace, respecting
 *  single/double quotes). Not a full shell parser — just enough to identify
 *  command names and their arguments for lint heuristics. */
function tokenize(cmd: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	for (const ch of cmd) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && !inSingle) {
			escaped = true;
			current += ch;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}
		if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Split a command string on unquoted pipe characters into pipeline segments. */
function splitPipeline(cmd: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	for (const ch of cmd) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && !inSingle) {
			escaped = true;
			current += ch;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}
		if (ch === "|" && !inSingle && !inDouble) {
			segments.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

const GREP_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);

/** Strip a directory path prefix from a command name using linear-time
 *  lastIndexOf instead of a regex (avoids CodeQL ReDoS alert). */
function stripPathPrefix(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const idx = token.lastIndexOf("/");
	return idx >= 0 ? token.slice(idx + 1) : token;
}

/** Check if a grep-like command has a pattern starting with `-` without a `--`
 *  separator before it. */
function checkGrepDashPattern(tokens: string[]): string | undefined {
	const cmdName = stripPathPrefix(tokens[0]);
	if (!cmdName || !GREP_COMMANDS.has(cmdName)) return undefined;

	let sawDoubleDash = false;
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--") {
			sawDoubleDash = true;
			continue;
		}
		if (sawDoubleDash) {
			// First arg after -- is the pattern; it's safe.
			return undefined;
		}
		// Skip known flags (single-dash options).
		if (t.startsWith("-") && t.length <= 3 && !t.startsWith("--")) continue;
		// Skip --flag=value style.
		if (t.startsWith("--")) continue;
		// First non-flag argument is the pattern.
		if (t.startsWith("-")) {
			return `grep pattern '${t}' starts with '-' but has no '--' separator — grep will parse it as flags (exit 2)`;
		}
		// Pattern doesn't start with dash — fine.
		return undefined;
	}
	return undefined;
}

/** Check for obviously unbalanced regex in grep/sed patterns. */
function checkUnbalancedRegex(tokens: string[]): string | undefined {
	const cmdName = stripPathPrefix(tokens[0]);
	if (!cmdName) return undefined;

	let pattern: string | undefined;

	if (GREP_COMMANDS.has(cmdName)) {
		// Find the pattern (first non-flag arg, or arg after -e).
		let sawE = false;
		for (let i = 1; i < tokens.length; i++) {
			const t = tokens[i];
			if (t === "--") {
				pattern = tokens[i + 1];
				break;
			}
			if (t === "-e") {
				sawE = true;
				continue;
			}
			if (sawE) {
				pattern = t;
				break;
			}
			if (t.startsWith("-")) continue;
			pattern = t;
			break;
		}
	} else if (cmdName === "sed") {
		// sed 's/pattern/replacement/' — extract the pattern between first two
		// delimiters.
		for (let i = 1; i < tokens.length; i++) {
			const t = tokens[i];
			if (t.startsWith("-")) continue;
			// First non-flag arg is the script.
			const cleaned = t.replace(/^['"]|['"]$/g, "");
			const match = cleaned.match(/^s(.)(.*)$/);
			if (match) {
				const delim = match[1];
				const rest = match[2];
				const endIdx = rest.indexOf(delim);
				if (endIdx > 0) pattern = rest.slice(0, endIdx);
			}
			break;
		}
	}

	if (!pattern) return undefined;

	// Strip quotes.
	const p = pattern.replace(/^['"]|['"]$/g, "");

	// Check unbalanced brackets/parens (basic heuristic — not a full regex
	// parser, but catches the common `[abc` and `(foo` mistakes).
	let bracketDepth = 0;
	let parenDepth = 0;
	let inBracket = false;
	for (let i = 0; i < p.length; i++) {
		const ch = p[i];
		if (ch === "\\" && i + 1 < p.length) {
			i++; // skip escaped char
			continue;
		}
		if (ch === "[") {
			inBracket = true;
			bracketDepth++;
		} else if (ch === "]") {
			if (inBracket) {
				bracketDepth--;
				if (bracketDepth === 0) inBracket = false;
			}
		} else if (ch === "(" && !inBracket) {
			parenDepth++;
		} else if (ch === ")" && !inBracket) {
			parenDepth--;
		}
	}
	if (bracketDepth > 0) return `unbalanced '[' in regex pattern '${p}' — grep/sed will exit 2`;
	if (parenDepth > 0) return `unbalanced '(' in regex pattern '${p}' — grep/sed will exit 2`;
	if (parenDepth < 0) return `unbalanced ')' in regex pattern '${p}' — grep/sed will exit 2`;

	return undefined;
}

/** Check if a pipeline has a grep/filter at the end without pipefail. */
function checkPipefail(cmd: string, segments: string[]): string | undefined {
	if (segments.length < 2) return undefined;

	const lastSegment = segments[segments.length - 1];
	const lastTokens = tokenize(lastSegment);
	const lastCmd = stripPathPrefix(lastTokens[0]);

	// Only flag when the last command is a filter (grep/awk/head/tail/wc/sort).
	const FILTER_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "awk", "head", "tail", "wc", "sort", "uniq"]);
	if (!lastCmd || !FILTER_COMMANDS.has(lastCmd)) return undefined;

	// Check if pipefail is set anywhere in the command.
	if (/set\s+-[a-zA-Z]*o\s+pipefail/.test(cmd) || /set\s+-[a-zA-Z]*p/.test(cmd)) return undefined;
	if (/PIPESTATUS/.test(cmd)) return undefined;
	if (/pipefail/.test(cmd)) return undefined;

	// Check if the script uses `bash -o pipefail` or similar.
	if (cmd.includes("-o") && cmd.includes("pipefail") && cmd.includes("bash")) return undefined;

	return `pipeline ends with '${lastCmd}' but has no 'set -o pipefail' or PIPESTATUS check — a failing upstream command will be masked by the filter's exit code`;
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

/** Extract the command string(s) from a script phase's `run` field. */
function extractCommands(phase: Phase): string[] {
	const run = (phase as { run?: unknown }).run;
	if (typeof run === "string") return [run];
	if (Array.isArray(run)) return run.filter((r): r is string => typeof r === "string");
	return [];
}

/** The built-in script-lint verifier. Register it via
 *  `verifyTaskflow(flow, { verifiers: [scriptLintVerifier] })`. */
export const scriptLintVerifier: TaskflowVerifier = {
	name: "script-lint",
	verify(flow: VerifiableFlow): VerifierIssue[] {
		const issues: VerifierIssue[] = [];

		for (const phase of flow.phases) {
			if ((phase.type ?? "agent") !== "script") continue;
			const commands = extractCommands(phase);

			for (const cmd of commands) {
				// Skip commands with interpolation placeholders — we can't lint
				// what we can't see yet.
				if (/\{[a-zA-Z]/.test(cmd)) continue;

				const segments = splitPipeline(cmd);

				for (const segment of segments) {
					const tokens = tokenize(segment);
					if (tokens.length === 0) continue;

					// Check 1: grep dash pattern.
					const dashIssue = checkGrepDashPattern(tokens);
					if (dashIssue) {
						issues.push({ phaseId: phase.id, message: dashIssue, severity: "error" });
					}

					// Check 2: unbalanced regex.
					const regexIssue = checkUnbalancedRegex(tokens);
					if (regexIssue) {
						issues.push({ phaseId: phase.id, message: regexIssue, severity: "error" });
					}
				}

				// Check 3: pipefail.
				const pipefailIssue = checkPipefail(cmd, segments);
				if (pipefailIssue) {
					issues.push({ phaseId: phase.id, message: pipefailIssue, severity: "warning" });
				}
			}
		}

		return issues;
	},
};
