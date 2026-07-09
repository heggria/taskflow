/**
 * Optional full tsc Program diagnostics for a .tf.ts file.
 */

import path from "node:path";
import ts from "typescript";
import type { Diagnostic } from "./diagnostics.ts";

export function typecheckFile(filePath: string, cwd = process.cwd()): Diagnostic[] {
	const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
	const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
	let options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		skipLibCheck: true,
		noEmit: true,
		esModuleInterop: true,
		allowJs: false,
	};
	if (configPath) {
		const read = ts.readConfigFile(configPath, ts.sys.readFile);
		if (!read.error) {
			const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
			options = { ...parsed.options, noEmit: true };
		}
	}
	const host = ts.createCompilerHost(options);
	const program = ts.createProgram([abs], options, host);
	const diags = [
		...program.getSyntacticDiagnostics(),
		...program.getSemanticDiagnostics(),
	].filter((d) => {
		const f = d.file?.fileName;
		return !f || path.resolve(f) === abs;
	});
	return diags.map((d) => {
		const file = d.file;
		let range: Diagnostic["range"];
		if (file && d.start !== undefined) {
			const { line, character } = file.getLineAndCharacterOfPosition(d.start);
			range = { line: line + 1, character: character + 1 };
		}
		return {
			code: `TS${d.code}`,
			severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
			message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
			file: file?.fileName ?? abs,
			range,
		} satisfies Diagnostic;
	});
}
