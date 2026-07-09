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
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (node.kind === ts.SyntaxKind.NullKeyword) return null;
	if (ts.isArrayLiteralExpression(node)) {
		return node.elements.map((e) => (ts.isSpreadElement(e) ? undefined : evalLiteral(e as ts.Expression)));
	}
	if (ts.isObjectLiteralExpression(node)) {
		const o: Record<string, unknown> = {};
		for (const p of node.properties) {
			if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
				o[p.name.text] = evalLiteral(p.initializer);
			} else if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name)) {
				o[p.name.text] = evalLiteral(p.initializer);
			}
		}
		return o;
	}
	return undefined;
}
