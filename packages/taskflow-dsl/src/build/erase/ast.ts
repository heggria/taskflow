/**
 * TypeScript AST primitives for erase (no domain knowledge of phases).
 */

import ts from "typescript";
import type { Diagnostic } from "../../diagnostics.ts";

export function posOf(sf: ts.SourceFile, node: ts.Node): { line: number; character: number } {
	const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
	return { line: line + 1, character: character + 1 };
}

export function diag(
	file: string,
	sf: ts.SourceFile,
	node: ts.Node,
	code: string,
	message: string,
	severity: Diagnostic["severity"] = "error",
	hint?: string,
): Diagnostic {
	const p = posOf(sf, node);
	return {
		code,
		severity,
		message,
		file,
		range: { line: p.line, character: p.character },
		hint,
	};
}

export function calleeName(expr: ts.Expression): string | undefined {
	if (ts.isIdentifier(expr)) return expr.text;
	if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
		return `${expr.expression.text}.${expr.name.text}`;
	}
	return undefined;
}

export function evalLiteral(node: ts.Expression): unknown {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (
		ts.isPrefixUnaryExpression(node) &&
		(node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken) &&
		ts.isNumericLiteral(node.operand)
	) {
		const value = Number(node.operand.text);
		return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
	}
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (node.kind === ts.SyntaxKind.NullKeyword) return null;
	if (ts.isArrayLiteralExpression(node)) {
		const values: unknown[] = [];
		for (const element of node.elements) {
			if (ts.isSpreadElement(element)) return undefined;
			const value = evalLiteral(element as ts.Expression);
			if (value === undefined) return undefined;
			values.push(value);
		}
		return values;
	}
	if (ts.isObjectLiteralExpression(node)) {
		const o: Record<string, unknown> = {};
		for (const p of node.properties) {
			if (!ts.isPropertyAssignment(p)) return undefined;
			const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)
				? p.name.text
				: undefined;
			if (!key) return undefined;
			const value = evalLiteral(p.initializer);
			if (value === undefined) return undefined;
			o[key] = value;
		}
		return o;
	}
	return undefined;
}
