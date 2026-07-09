/**
 * Template / string erase → task text + dependency ids.
 */

import ts from "typescript";
import type { Diagnostic } from "../../diagnostics.ts";
import { diag } from "./ast.ts";
import type { PhaseDraft } from "./types.ts";

export function eraseStringish(
	sf: ts.SourceFile,
	file: string,
	node: ts.Expression,
	itemParam: string | undefined,
	phases: Map<string, PhaseDraft>,
	diags: Diagnostic[],
): { text: string; deps: string[] } | undefined {
	const deps: string[] = [];

	const pushDep = (id: string) => {
		if (phases.has(id) && !deps.includes(id)) deps.push(id);
	};

	const propToPlaceholder = (expr: ts.Expression): string | undefined => {
		if (ts.isIdentifier(expr) && itemParam && expr.text === itemParam) return "{item}";
		if (
			ts.isPropertyAccessExpression(expr) &&
			ts.isIdentifier(expr.expression) &&
			itemParam &&
			expr.expression.text === itemParam
		) {
			return `{item.${expr.name.text}}`;
		}
		if (ts.isPropertyAccessExpression(expr)) {
			const chain: string[] = [];
			let cur: ts.Expression = expr;
			while (ts.isPropertyAccessExpression(cur)) {
				chain.unshift(cur.name.text);
				cur = cur.expression;
			}
			if (ts.isIdentifier(cur) && phases.has(cur.text)) {
				pushDep(cur.text);
				if (chain[0] === "output" && chain.length === 1) return `{steps.${cur.text}.output}`;
				if (chain[0] === "json") {
					if (chain.length === 1) return `{steps.${cur.text}.json}`;
					return `{steps.${cur.text}.json.${chain.slice(1).join(".")}}`;
				}
			}
		}
		if (
			ts.isPropertyAccessExpression(expr) &&
			ts.isIdentifier(expr.expression) &&
			expr.expression.text === "args"
		) {
			return `{args.${expr.name.text}}`;
		}
		return undefined;
	};

	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return { text: node.text, deps };
	}

	if (ts.isTemplateExpression(node)) {
		let text = node.head.text;
		for (const span of node.templateSpans) {
			const ph = propToPlaceholder(span.expression);
			if (ph) {
				text += ph;
			} else if (ts.isIdentifier(span.expression) && phases.has(span.expression.text)) {
				pushDep(span.expression.text);
				text += `{steps.${span.expression.text}.output}`;
			} else {
				diags.push(
					diag(
						file,
						sf,
						span.expression,
						"TFDSL_TMPL_UNERASABLE",
						`Cannot erase template expression to a placeholder (only phase.output/json, item.*, args.* supported in MVP).`,
					),
				);
				return undefined;
			}
			text += span.literal.text;
		}
		return { text, deps };
	}

	if (ts.isIdentifier(node)) {
		diags.push(diag(file, sf, node, "TFDSL_RUNE_ARG", `Expected string or template for task text.`));
		return undefined;
	}

	// fall through for other literals is rare
	diags.push(diag(file, sf, node, "TFDSL_RUNE_ARG", `Expected static string/template task text.`));
	return undefined;
}

export function eraseGateTask(
	sf: ts.SourceFile,
	file: string,
	expr: ts.Expression,
	param: string,
	upstreamId: string | undefined,
	phases: Map<string, PhaseDraft>,
	diags: Diagnostic[],
): { text: string; deps: string[] } | undefined {
	const deps: string[] = [];
	if (upstreamId) deps.push(upstreamId);

	const rewrite = (e: ts.Expression): string | undefined => {
		if (
			ts.isPropertyAccessExpression(e) &&
			ts.isIdentifier(e.expression) &&
			e.expression.text === param &&
			(e.name.text === "output" || e.name.text === "json")
		) {
			if (!upstreamId) return undefined;
			return e.name.text === "output" ? `{steps.${upstreamId}.output}` : `{steps.${upstreamId}.json}`;
		}
		return undefined;
	};

	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { text: expr.text, deps };
	if (ts.isTemplateExpression(expr)) {
		let text = expr.head.text;
		for (const span of expr.templateSpans) {
			const ph = rewrite(span.expression);
			if (ph) text += ph;
			else {
				const er = eraseStringish(sf, file, span.expression, undefined, phases, diags);
				if (!er) return undefined;
				text += er.text;
				for (const d of er.deps) if (!deps.includes(d)) deps.push(d);
			}
			text += span.literal.text;
		}
		return { text, deps };
	}
	return undefined;
}

export function eraseLoopTask(
	sf: ts.SourceFile,
	file: string,
	expr: ts.Expression,
	prevName: string,
	loopId: string,
	diags: Diagnostic[],
): string | undefined {
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
	if (!ts.isTemplateExpression(expr)) {
		diags.push(diag(file, sf, expr, "TFDSL_RUNE_ARG", `loop task must be string or template.`));
		return undefined;
	}
	let text = expr.head.text;
	for (const span of expr.templateSpans) {
		const e = span.expression;
		if (
			ts.isPropertyAccessExpression(e) &&
			ts.isIdentifier(e.expression) &&
			e.expression.text === prevName &&
			e.name.text === "output"
		) {
			text += `{steps.${loopId}.output}`;
		} else if (ts.isIdentifier(e) && e.text === "loop") {
			text += `{loop.iteration}`;
		} else {
			diags.push(diag(file, sf, e, "TFDSL_TMPL_UNERASABLE", `Unsupported expression in loop task template.`));
			return undefined;
		}
		text += span.literal.text;
	}
	return text;
}

export function eraseReduceTask(
	sf: ts.SourceFile,
	file: string,
	expr: ts.Expression,
	fn: ts.ArrowFunction | ts.FunctionExpression,
	phases: Map<string, PhaseDraft>,
	diags: Diagnostic[],
): { text: string; deps: string[] } | undefined {
	const p0 = fn.parameters[0];
	const partsName = p0 && ts.isIdentifier(p0.name) ? p0.name.text : "p";
	const deps: string[] = [];
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { text: expr.text, deps };
	if (!ts.isTemplateExpression(expr)) return eraseStringish(sf, file, expr, undefined, phases, diags);
	let text = expr.head.text;
	for (const span of expr.templateSpans) {
		const e = span.expression;
		if (
			ts.isPropertyAccessExpression(e) &&
			ts.isPropertyAccessExpression(e.expression) &&
			ts.isIdentifier(e.expression.expression) &&
			e.expression.expression.text === partsName
		) {
			const phaseId = e.expression.name.text;
			if (phases.has(phaseId)) deps.push(phaseId);
			if (e.name.text === "output") text += `{steps.${phaseId}.output}`;
			else if (e.name.text === "json") text += `{steps.${phaseId}.json}`;
			else text += `{steps.${phaseId}.output}`;
		} else {
			const er = eraseStringish(sf, file, e, undefined, phases, diags);
			if (!er) return undefined;
			text += er.text;
			for (const d of er.deps) deps.push(d);
		}
		text += span.literal.text;
	}
	return { text, deps };
}
