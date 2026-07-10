/**
 * Check — AST erase + validateTaskflow by default.
 * Optional `--typecheck` / `typecheck: true` adds a TypeScript Program pass.
 */

import fs from "node:fs";
import path from "node:path";
import { buildFile, buildSource, type BuildResult } from "./build.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { hasErrors } from "./diagnostics.ts";
import { typecheckFile } from "./typecheck.ts";

export interface CheckOptions {
	/** Skip Taskflow validate (rune/static only). Default false. */
	noValidate?: boolean;
	/** Run full tsc Program diagnostics on .tf.ts files (default true). */
	typecheck?: boolean;
	/** cwd for tsconfig discovery when typecheck is on. */
	cwd?: string;
}

export interface CheckResult {
	ok: boolean;
	diagnostics: Diagnostic[];
	file?: string;
}

export function checkSource(sourceText: string, file = "flow.tf.ts", opts: CheckOptions = {}): CheckResult {
	const r: BuildResult = buildSource(sourceText, file, {
		validate: !opts.noValidate,
		irHash: false,
		emit: "taskflow",
	});
	return { ok: r.ok, diagnostics: r.diagnostics, file: r.file };
}

export function checkFile(filePath: string, opts: CheckOptions = {}): CheckResult {
	const abs = path.resolve(filePath);
	if (!fs.existsSync(abs)) {
		return {
			ok: false,
			diagnostics: [
				{
					code: "TFDSL_IO_MISSING",
					severity: "error",
					message: `File not found: ${abs}`,
					file: abs,
				},
			],
			file: abs,
		};
	}
	const r = buildFile(abs, { validate: !opts.noValidate, irHash: false, emit: "taskflow" });
	const diagnostics = [...r.diagnostics];
	const isTypeScriptDsl = abs.endsWith(".tf.ts") || path.extname(abs).toLowerCase() === ".ts";
	if (isTypeScriptDsl && opts.typecheck !== false) {
		diagnostics.push(...typecheckFile(abs, opts.cwd ?? path.dirname(abs)));
	}
	return { ok: !hasErrors(diagnostics), diagnostics, file: r.file };
}
