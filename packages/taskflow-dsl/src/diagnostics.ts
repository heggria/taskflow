/**
 * Stable diagnostics for taskflow-dsl (CLI + library).
 */

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Range {
	line: number; // 1-based
	character: number; // 1-based
	endLine?: number;
	endCharacter?: number;
}

export interface Diagnostic {
	code: string;
	severity: DiagnosticSeverity;
	message: string;
	file?: string;
	range?: Range;
	hint?: string;
	related?: Array<{ file?: string; range?: Range; message: string }>;
}

export function formatDiagnostic(d: Diagnostic): string {
	const loc =
		d.file && d.range
			? `${d.file}:${d.range.line}:${d.range.character}`
			: d.file ?? "";
	const head = loc ? `${loc} - ${d.severity} ${d.code}: ${d.message}` : `${d.severity} ${d.code}: ${d.message}`;
	return d.hint ? `${head}\n  hint: ${d.hint}` : head;
}

export function formatDiagnostics(diags: readonly Diagnostic[]): string {
	return diags.map(formatDiagnostic).join("\n");
}

export function hasErrors(diags: readonly Diagnostic[]): boolean {
	return diags.some((d) => d.severity === "error");
}
