/**
 * Lightweight check — AST erase + validateTaskflow, no artifact write.
 *
 * S4 honesty: this is **not** a full tsc Program typecheck (RFC §2.2 optional
 * path). It catches erase/DAG errors only. Use `tsc` / IDE for TS type errors.
 */

import fs from "node:fs";
import path from "node:path";
import { buildFile, buildSource, type BuildResult } from "./build.ts";
import type { Diagnostic } from "./diagnostics.ts";

export interface CheckOptions {
	/** Skip Taskflow validate (rune/static only). Default false. */
	noValidate?: boolean;
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
	return { ok: r.ok, diagnostics: r.diagnostics, file: r.file };
}
