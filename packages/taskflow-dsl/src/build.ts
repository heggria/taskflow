/**
 * Library API: buildFile / buildSource → Taskflow (+ optional FlowIR).
 */

import fs from "node:fs";
import path from "node:path";
import {
	compileTaskflowToFlowIR,
	hashFlowIR,
	validateTaskflow,
	desugar,
	type Taskflow,
} from "taskflow-core";
// desugar: only for JSON shorthand escape path
import { eraseSource } from "./build/erase.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { hasErrors } from "./diagnostics.ts";

export type EmitMode = "taskflow" | "flowir" | "both";

export interface BuildOptions {
	/** Emit mode when writing files (library default: in-memory taskflow only). */
	emit?: EmitMode;
	/** Also run validateTaskflow (default true). */
	validate?: boolean;
	/** Compute FlowIR hash (default true when flowir requested). */
	irHash?: boolean;
}

export interface BuildResult {
	ok: boolean;
	diagnostics: Diagnostic[];
	taskflow?: Taskflow;
	flowir?: unknown;
	irHash?: string;
	file?: string;
}

export function buildSource(sourceText: string, file = "flow.tf.ts", opts: BuildOptions = {}): BuildResult {
	const erased = eraseSource(sourceText, file);
	if (!erased.ok || !erased.taskflow) {
		return { ok: false, diagnostics: erased.diagnostics, file };
	}

	const diagnostics = [...erased.diagnostics];
	const validate = opts.validate !== false;
	if (validate) {
		const v = validateTaskflow(erased.taskflow);
		if (!v.ok) {
			for (const e of v.errors) {
				diagnostics.push({
					code: "TFDSL_CORE_VALIDATE",
					severity: "error",
					message: e,
					file,
				});
			}
			return { ok: false, diagnostics, file };
		}
	}

	// Full documents already have `phases` — do NOT call desugar (that API is
	// shorthand-only: task/tasks/chain). validateTaskflow already accepted the shape.
	const taskflow = erased.taskflow as Taskflow;
	let flowir: unknown;
	let irHash: string | undefined;
	const wantIr = opts.emit === "flowir" || opts.emit === "both" || opts.irHash !== false;
	if (wantIr) {
		try {
			const compiled = compileTaskflowToFlowIR(taskflow);
			flowir = compiled.canonical;
			irHash = hashFlowIR(compiled.canonical);
		} catch (e) {
			diagnostics.push({
				code: "TFDSL_CORE_IR",
				severity: "error",
				message: e instanceof Error ? e.message : String(e),
				file,
			});
			return { ok: false, diagnostics, file };
		}
	}

	return {
		ok: !hasErrors(diagnostics),
		diagnostics,
		taskflow,
		flowir,
		irHash,
		file,
	};
}

export function buildFile(filePath: string, opts: BuildOptions = {}): BuildResult {
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
	const ext = path.extname(abs).toLowerCase();
	if (ext === ".json" || ext === ".jsonc") {
		return buildJsonFile(abs, opts);
	}
	if (!abs.endsWith(".tf.ts") && ext !== ".ts") {
		return {
			ok: false,
			diagnostics: [
				{
					code: "TFDSL_INPUT_KIND",
					severity: "error",
					message: `Unsupported input kind (expected .tf.ts or .json): ${abs}`,
					file: abs,
				},
			],
			file: abs,
		};
	}
	const text = fs.readFileSync(abs, "utf8");
	return buildSource(text, abs, opts);
}

function buildJsonFile(abs: string, opts: BuildOptions): BuildResult {
	const text = fs.readFileSync(abs, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return {
			ok: false,
			diagnostics: [
				{
					code: "TFDSL_IO_JSON",
					severity: "error",
					message: e instanceof Error ? e.message : String(e),
					file: abs,
				},
			],
			file: abs,
		};
	}
	const diagnostics: Diagnostic[] = [];
	// JSON escape: allow full Taskflow or shorthand (task/tasks/chain).
	let taskflow: Taskflow;
	const asRec = parsed as Record<string, unknown>;
	if (Array.isArray(asRec.phases)) {
		const v = validateTaskflow(parsed);
		if (!v.ok) {
			for (const e of v.errors) {
				diagnostics.push({ code: "TFDSL_CORE_VALIDATE", severity: "error", message: e, file: abs });
			}
			return { ok: false, diagnostics, file: abs };
		}
		taskflow = parsed as Taskflow;
	} else {
		try {
			taskflow = desugar(parsed);
		} catch (e) {
			diagnostics.push({
				code: "TFDSL_CORE_DESUGAR",
				severity: "error",
				message: e instanceof Error ? e.message : String(e),
				file: abs,
			});
			return { ok: false, diagnostics, file: abs };
		}
		const v = validateTaskflow(taskflow);
		if (!v.ok) {
			for (const e of v.errors) {
				diagnostics.push({ code: "TFDSL_CORE_VALIDATE", severity: "error", message: e, file: abs });
			}
			return { ok: false, diagnostics, file: abs };
		}
	}
	let flowir: unknown;
	let irHash: string | undefined;
	if (opts.emit === "flowir" || opts.emit === "both" || opts.irHash !== false) {
		const compiled = compileTaskflowToFlowIR(taskflow);
		flowir = compiled.canonical;
		irHash = hashFlowIR(compiled.canonical);
	}
	return { ok: true, diagnostics, taskflow, flowir, irHash, file: abs };
}

export { eraseSource } from "./build/erase.ts";
