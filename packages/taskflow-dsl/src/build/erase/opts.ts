/**
 * Phase option object-literal erase.
 */

import ts from "typescript";
import type { Diagnostic } from "../../diagnostics.ts";
import { calleeName, diag, evalLiteral } from "./ast.ts";
import type { PhaseDraft } from "./types.ts";

/** Extra option keys allowed without TFDSL_RUNE_OPTS_UNKNOWN (sugar / kind-specific). */
export type MergeOptsExtra = {
	allowKeys?: ReadonlySet<string>;
};

export function mergeOpts(
	sf: ts.SourceFile,
	file: string,
	obj: ts.Expression | undefined,
	diags: Diagnostic[],
	phases: Map<string, PhaseDraft>,
	extra?: MergeOptsExtra,
): Record<string, unknown> {
	if (!obj) return {};
	if (!ts.isObjectLiteralExpression(obj)) {
		diags.push(diag(file, sf, obj, "TFDSL_RUNE_OPTS", `Phase options must be an object literal.`));
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const p of obj.properties) {
		if (!ts.isPropertyAssignment(p)) continue;
		const key = ts.isIdentifier(p.name)
			? p.name.text
			: ts.isStringLiteral(p.name)
				? p.name.text
				: undefined;
		if (!key) continue;
		if (extra?.allowKeys?.has(key)) {
			const v = evalLiteral(p.initializer);
			if (v !== undefined) out[key] = v;
			continue;
		}

		if (key === "dependsOn" && ts.isArrayLiteralExpression(p.initializer)) {
			const ids: string[] = [];
			for (const el of p.initializer.elements) {
				if (ts.isStringLiteral(el)) ids.push(el.text);
				else if (ts.isIdentifier(el) && phases.has(el.text)) ids.push(el.text);
			}
			out.dependsOn = ids;
			continue;
		}

		if (key === "output") {
			if (ts.isCallExpression(p.initializer)) {
				const cn = calleeName(p.initializer.expression);
				if (cn === "json") {
					out.output = "json";
					out.expect = { type: "object" };
					continue;
				}
			}
			const v = evalLiteral(p.initializer);
			if (v === "json" || v === "text") {
				out.output = v;
				if (v === "json" && out.expect === undefined) out.expect = { type: "object" };
				continue;
			}
			diags.push(
				diag(file, sf, p.initializer, "TFDSL_RUNE_OPTS", `output must be "json" | "text" or json().`),
			);
			continue;
		}

		if (key === "agent" || key === "model" || key === "when" || key === "join" || key === "cwd") {
			const v = evalLiteral(p.initializer);
			if (v !== undefined) out[key] = v;
			continue;
		}
		if (key === "final" || key === "optional" || key === "idempotent" || key === "reflexion" || key === "convergence") {
			const v = evalLiteral(p.initializer);
			if (typeof v === "boolean") out[key] = v;
			continue;
		}
		if (key === "timeout" || key === "concurrency" || key === "maxIterations" || key === "variants") {
			const v = evalLiteral(p.initializer);
			if (typeof v === "number") out[key] = v;
			continue;
		}
		if (key === "retry" || key === "expect" || key === "tools" || key === "thinking") {
			const v = evalLiteral(p.initializer);
			if (v !== undefined) out[key] = v;
			continue;
		}
		if (key === "id") {
			const v = evalLiteral(p.initializer);
			if (typeof v === "string") out.id = v;
			continue;
		}
		if (
			key === "input" ||
			key === "request" ||
			key === "until" ||
			key === "judge" ||
			key === "judgeAgent" ||
			key === "mode" ||
			key === "use" ||
			key === "onBlock" ||
			key === "cancelLosers" ||
			key === "expandMode" ||
			key === "maxNodes"
		) {
			const v = evalLiteral(p.initializer);
			if (v !== undefined) out[key] = v;
			continue;
		}
		diags.push(
			diag(
				file,
				sf,
				p,
				"TFDSL_RUNE_OPTS_UNKNOWN",
				`Unknown or non-static option '${key}' ignored in MVP erase.`,
				"warning",
			),
		);
	}
	return out;
}

export function phaseIdFromBinding(name: string, opts: Record<string, unknown>): string {
	if (typeof opts.id === "string" && opts.id) return opts.id;
	return name;
}

export function finalizeDraft(draft: PhaseDraft): void {
	delete draft.raw.id;
	if (draft.dependsOn.size) draft.raw.dependsOn = [...draft.dependsOn];
	if (draft.final) draft.raw.final = true;
}

export function registerDraft(session: { phases: Map<string, PhaseDraft>; order: string[] }, draft: PhaseDraft): string {
	finalizeDraft(draft);
	session.phases.set(draft.id, draft);
	if (!session.order.includes(draft.id)) session.order.push(draft.id);
	return draft.id;
}
