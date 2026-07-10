/**
 * Phase option object-literal erase.
 */

import ts from "typescript";
import type { Diagnostic } from "../../diagnostics.ts";
import { calleeName, diag, evalLiteral } from "./ast.ts";
import { phaseByBinding, type PhaseDraft } from "./types.ts";

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
		if (!ts.isPropertyAssignment(p)) {
			diags.push(
				diag(
					file,
					sf,
					p,
					"TFDSL_RUNE_OPTS_DYNAMIC",
					`Phase options must use explicit static property assignments (no shorthand, spread, methods, or accessors).`,
				),
			);
			continue;
		}
		const key = ts.isIdentifier(p.name)
			? p.name.text
			: ts.isStringLiteral(p.name)
				? p.name.text
				: undefined;
		if (!key) {
			diags.push(diag(file, sf, p, "TFDSL_RUNE_OPTS_DYNAMIC", `Phase option names must be static identifiers or strings.`));
			continue;
		}
		const staticValue = (): unknown => {
			const value = evalLiteral(p.initializer);
			if (value === undefined) {
				diags.push(
					diag(file, sf, p.initializer, "TFDSL_RUNE_OPTS_DYNAMIC", `Option '${key}' must be a static JSON literal.`),
				);
			}
			return value;
		};
		if (extra?.allowKeys?.has(key)) {
			// Kind handlers erase task lambdas/templates and branch agent() arrays
			// with phase-aware logic after mergeOpts; do not misclassify them as
			// dynamic JSON literals here.
			if (
				key === "task" &&
				(ts.isArrowFunction(p.initializer) ||
					ts.isFunctionExpression(p.initializer) ||
					ts.isTemplateExpression(p.initializer))
			) {
				continue;
			}
			if (key === "branches" && ts.isArrayLiteralExpression(p.initializer)) continue;
			const v = staticValue();
			if (v !== undefined) out[key] = v;
			continue;
		}

		if (key === "dependsOn") {
			if (!ts.isArrayLiteralExpression(p.initializer)) {
				diags.push(diag(file, sf, p.initializer, "TFDSL_DEP_DYNAMIC", `dependsOn must be an array of phase handles or string ids.`));
				continue;
			}
			const ids: string[] = [];
			for (const el of p.initializer.elements) {
				if (ts.isStringLiteral(el)) ids.push(el.text);
				else if (ts.isIdentifier(el) && phaseByBinding(phases, el.text)) ids.push(phaseByBinding(phases, el.text)!.id);
				else {
					diags.push(
						diag(file, sf, el, "TFDSL_DEP_DYNAMIC", `dependsOn entry must be a previously declared phase handle or string id.`),
					);
				}
			}
			out.dependsOn = ids;
			continue;
		}

		if (key === "output") {
			if (ts.isCallExpression(p.initializer)) {
				const cn = calleeName(p.initializer.expression);
				if (cn === "json") {
					if (p.initializer.arguments.length !== 0) {
						diags.push(diag(file, sf, p.initializer, "TFDSL_RUNE_ARITY", `json<T>() does not accept runtime arguments.`));
						continue;
					}
					out.output = "json";
					const typeArg = p.initializer.typeArguments?.[0];
					if (!typeArg) {
						out.expect = { type: "object" };
					} else {
						const expect = expectFromTypeNode(typeArg);
						if (expect.ok) out.expect = expect.schema;
						else diags.push(diag(file, sf, typeArg, "TFDSL_JSON_TYPE_UNSUPPORTED", expect.message));
					}
					continue;
				}
			}
			const v = staticValue();
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

		if (key === "agent" || key === "model" || key === "thinking" || key === "when" || key === "join" || key === "cwd") {
			const v = staticValue();
			if (typeof v === "string") out[key] = v;
			else if (v !== undefined) diags.push(diag(file, sf, p.initializer, "TFDSL_RUNE_OPTS", `Option '${key}' must be a string.`));
			continue;
		}
		if (key === "final" || key === "optional" || key === "idempotent" || key === "reflexion" || key === "convergence") {
			const v = staticValue();
			if (typeof v === "boolean") out[key] = v;
			else if (v !== undefined) diags.push(diag(file, sf, p.initializer, "TFDSL_RUNE_OPTS", `Option '${key}' must be a boolean.`));
			continue;
		}
		if (key === "timeout" || key === "concurrency" || key === "maxIterations" || key === "variants") {
			const v = staticValue();
			if (typeof v === "number") out[key] = v;
			else if (v !== undefined) diags.push(diag(file, sf, p.initializer, "TFDSL_RUNE_OPTS", `Option '${key}' must be a number.`));
			continue;
		}
		if (
			key === "retry" || key === "expect" || key === "tools" ||
			key === "context" || key === "contextLimit" || key === "onBlock" || key === "eval" ||
			key === "score" || key === "cache" || key === "shareContext"
		) {
			const v = staticValue();
			if (v !== undefined) out[key] = v;
			continue;
		}
		if (key === "id") {
			const v = staticValue();
			if (typeof v === "string") out.id = v;
			else if (v !== undefined) diags.push(diag(file, sf, p.initializer, "TFDSL_RUNE_OPTS", `Option 'id' must be a string.`));
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
			const v = staticValue();
			if (v !== undefined) out[key] = v;
			continue;
		}
		diags.push(
			diag(
				file,
				sf,
				p,
				"TFDSL_RUNE_OPTS_UNKNOWN",
				`Unknown or non-static option '${key}' cannot be erased safely.`,
			),
		);
	}
	return out;
}

type TypeSchemaResult =
	| { ok: true; schema: Record<string, unknown> }
	| { ok: false; message: string };

/** Infer the small runtime `expect` contract from syntax only. Named/conditional types fail closed. */
function expectFromTypeNode(node: ts.TypeNode): TypeSchemaResult {
	switch (node.kind) {
		case ts.SyntaxKind.StringKeyword:
			return { ok: true, schema: { type: "string" } };
		case ts.SyntaxKind.NumberKeyword:
			return { ok: true, schema: { type: "number" } };
		case ts.SyntaxKind.BooleanKeyword:
			return { ok: true, schema: { type: "boolean" } };
	}
	if (ts.isLiteralTypeNode(node)) {
		const value = evalLiteral(node.literal as ts.Expression);
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
			return { ok: true, schema: { enum: [value] } };
		}
	}
	if (ts.isArrayTypeNode(node)) {
		const item = expectFromTypeNode(node.elementType);
		return item.ok ? { ok: true, schema: { type: "array", items: item.schema } } : item;
	}
	if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === "Array" && node.typeArguments?.length === 1) {
		const item = expectFromTypeNode(node.typeArguments[0]!);
		return item.ok ? { ok: true, schema: { type: "array", items: item.schema } } : item;
	}
	if (ts.isTypeLiteralNode(node)) {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		for (const member of node.members) {
			if (!ts.isPropertySignature(member) || !member.type || !member.name) {
				return { ok: false, message: `json<T>() only supports property signatures in object types.` };
			}
			const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
				? member.name.text
				: undefined;
			if (!name) return { ok: false, message: `json<T>() requires static object property names.` };
			const prop = expectFromTypeNode(member.type);
			if (!prop.ok) return prop;
			properties[name] = prop.schema;
			if (!member.questionToken) required.push(name);
		}
		const schema: Record<string, unknown> = { type: "object", properties };
		if (required.length) schema.required = required;
		return { ok: true, schema };
	}
	return {
		ok: false,
		message: `json<T>() cannot safely infer '${node.getText()}'; use a literal expect contract instead.`,
	};
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
