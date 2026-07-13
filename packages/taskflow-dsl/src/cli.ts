#!/usr/bin/env node
/**
 * taskflow-dsl CLI — build | check | decompile | new
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildFile } from "./build.ts";
import { checkFile } from "./check.ts";
import { decompileTaskflow } from "./decompile.ts";
import { formatDiagnostics, hasErrors } from "./diagnostics.ts";
import { skeletonHello, skeletonJson } from "./new-skeleton.ts";
import { assertContainedOutputWritable, resolveInput, writeContainedFileAtomic } from "./paths.ts";
import { desugar, parseJsonc, validateTaskflow, type Taskflow } from "taskflow-core";

const require = createRequire(import.meta.url);
const PKG_VERSION: string = (() => {
	try {
		return (require("../package.json") as { version: string }).version;
	} catch {
		return "0.0.0-dev";
	}
})();

function usage(): string {
	return `taskflow-dsl <command> [options] [path]

Commands:
  build <file>       Erase .tf.ts (or validate .json) → Taskflow / FlowIR
  check <file>       Erase + validate (no write)
  decompile <file>   Taskflow JSON → .tf.ts
  new [name]         Write hello skeleton

Options:
  --cwd <dir>        Project root for path resolution (default: process.cwd())
  -o, --out <path>   Output path (must stay under --cwd)
  --emit taskflow|flowir|both   (build, default: taskflow)
  --no-typecheck     (check) skip tsc Program diagnostics
  --json             Machine-readable diagnostics
  --force            Overwrite an existing regular output file
  --json-escape      new: emit JSON skeleton instead of .tf.ts
  -V, --version
  -h, --help
`;
}

function parseArgs(argv: string[]) {
	const args = argv.slice(2);
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "-h" || a === "--help") flags.help = true;
		else if (a === "-V" || a === "--version") flags.version = true;
		else if (a === "--json") flags.json = true;
		else if (a === "-o" || a === "--out") flags.out = args[++i] ?? "";
		else if (a === "--emit") flags.emit = args[++i] ?? "";
		else if (a === "--cwd") flags.cwd = args[++i] ?? "";
		else if (a === "--force") flags.force = true;
		else if (a === "--typecheck") flags.typecheck = true;
		else if (a === "--no-typecheck") flags.noTypecheck = true;
		else if (a === "--json-escape") flags.jsonEscape = true;
		else if (a.startsWith("-")) flags[a] = true;
		else positional.push(a);
	}
	return { flags, positional };
}

function main(): void {
	const { flags, positional } = parseArgs(process.argv);
	const unknownFlags = Object.keys(flags).filter((key) => key.startsWith("-"));
	if (unknownFlags.length) failUsage(`unknown option: ${unknownFlags[0]}`);
	if (flags.version) {
		process.stdout.write(`${PKG_VERSION}\n`);
		process.exit(0);
	}
	if (flags.help || positional.length === 0) {
		process.stdout.write(usage());
		process.exit(flags.help ? 0 : 2);
	}
	const cwd = typeof flags.cwd === "string" && flags.cwd ? path.resolve(flags.cwd) : process.cwd();
	const cmd = positional[0]!;
	const allowedByCommand: Record<string, Set<string>> = {
		build: new Set(["cwd", "out", "emit", "json", "force"]),
		check: new Set(["cwd", "typecheck", "noTypecheck", "json"]),
		decompile: new Set(["cwd", "out", "force"]),
		new: new Set(["cwd", "out", "force", "jsonEscape"]),
	};
	const allowed = allowedByCommand[cmd];
	if (allowed) {
		for (const key of Object.keys(flags)) {
			if (key === "help" || key === "version") continue;
			if (!allowed.has(key)) failUsage(`option --${key} is not valid for ${cmd}`);
		}
		const maxPositional = cmd === "new" ? 2 : 2;
		if (positional.length > maxPositional) failUsage(`${cmd} received unexpected positional arguments`);
	}

	try {
		if (cmd === "build") {
			const file = positional[1];
			if (!file) {
				process.stderr.write("build requires a file path\n");
				process.exit(2);
			}
			const input = resolveInput(cwd, file);
			const emitValue = String(flags.emit ?? "taskflow");
			if (emitValue !== "taskflow" && emitValue !== "flowir" && emitValue !== "both") {
				failUsage(`--emit must be taskflow, flowir, or both`);
			}
			const emit = emitValue;
			if (emit === "both" && typeof flags.out === "string" && flags.out) {
				failUsage(`--out is ambiguous with --emit both`);
			}
			if (flags.json && typeof flags.out === "string" && flags.out) failUsage(`--out cannot be used with --json`);
			const r = buildFile(input, { emit, irHash: true, validate: true });
			if (flags.json) {
				process.stdout.write(
					JSON.stringify(
						{
							ok: r.ok,
							diagnostics: r.diagnostics,
							irHash: r.irHash,
							taskflow: r.taskflow,
							flowir: r.flowir,
						},
						null,
						2,
					) + "\n",
				);
			} else {
				if (r.diagnostics.length) process.stderr.write(formatDiagnostics(r.diagnostics) + "\n");
				if (r.ok && r.taskflow) {
					const stem = input.replace(/\.tf\.ts$/i, "").replace(/\.jsonc?$/i, "");
					const taskflowOut =
						emit === "taskflow" || emit === "both"
							? typeof flags.out === "string" && flags.out && emit === "taskflow"
								? flags.out
								: `${stem}.taskflow.json`
							: undefined;
					const flowirOut =
						(emit === "flowir" || emit === "both") && r.flowir
							? typeof flags.out === "string" && flags.out && emit === "flowir"
								? flags.out
								: `${stem}.flowir.json`
							: undefined;
					const outputOptions = { force: flags.force === true };
					// Fail before the first write if either half of `--emit both` is
					// already unsafe or would overwrite without explicit consent.
					for (const output of [taskflowOut, flowirOut]) {
						if (output) assertContainedOutputWritable(cwd, outputRelativeTo(cwd, output), outputOptions);
					}
					if (emit === "taskflow" || emit === "both") {
						const outPath = writeContainedFileAtomic(
							cwd,
							outputRelativeTo(cwd, taskflowOut!),
							JSON.stringify(r.taskflow, null, 2) + "\n",
							outputOptions,
						);
						process.stdout.write(`wrote ${outPath}\n`);
					}
					if ((emit === "flowir" || emit === "both") && r.flowir) {
						const p = writeContainedFileAtomic(
							cwd,
							outputRelativeTo(cwd, flowirOut!),
							JSON.stringify({ hash: r.irHash, ir: r.flowir }, null, 2) + "\n",
							outputOptions,
						);
						process.stdout.write(`wrote ${p} (${r.irHash})\n`);
					}
					process.stdout.write(
						`ok name=${r.taskflow.name} phases=${r.taskflow.phases?.length ?? 0}` +
							(r.irHash ? ` ${r.irHash}` : "") +
							"\n",
					);
				}
			}
			process.exit(r.ok ? 0 : hasErrors(r.diagnostics) ? 1 : 0);
		}

		if (cmd === "check") {
			const file = positional[1];
			if (!file) {
				process.stderr.write("check requires a file path\n");
				process.exit(2);
			}
			if (flags.typecheck && flags.noTypecheck) failUsage(`--typecheck and --no-typecheck are mutually exclusive`);
			const r = checkFile(resolveInput(cwd, file), {
				typecheck: flags.noTypecheck !== true,
				cwd,
			});
			if (flags.json) {
				process.stdout.write(JSON.stringify({ ok: r.ok, diagnostics: r.diagnostics }, null, 2) + "\n");
			} else {
				if (r.diagnostics.length) process.stdout.write(formatDiagnostics(r.diagnostics) + "\n");
				process.stdout.write(r.ok ? "ok\n" : "failed\n");
			}
			process.exit(r.ok ? 0 : 1);
		}

		if (cmd === "decompile") {
			const file = positional[1];
			if (!file) {
				process.stderr.write("decompile requires a Taskflow JSON path\n");
				process.exit(2);
			}
			const input = resolveInput(cwd, file);
			const inputText = fs.readFileSync(input, "utf8");
			const raw = input.toLowerCase().endsWith(".jsonc") ? parseJsonc(inputText) : JSON.parse(inputText);
			const asRec = raw as Record<string, unknown>;
			let def: Taskflow;
			if (Array.isArray(asRec.phases)) {
				const v = validateTaskflow(raw);
				if (!v.ok) {
					process.stderr.write(v.errors.join("\n") + "\n");
					process.exit(1);
				}
				def = raw as Taskflow;
			} else {
				try {
					def = desugar(raw);
				} catch (e) {
					process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
					process.exit(1);
				}
				const v = validateTaskflow(def);
				if (!v.ok) {
					process.stderr.write(v.errors.join("\n") + "\n");
					process.exit(1);
				}
			}
			let src: string;
			try {
				src = decompileTaskflow(def);
			} catch (e) {
				process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
				process.exit(1);
			}
			let out =
				typeof flags.out === "string" && flags.out
					? flags.out
					: input.replace(/\.jsonc?$/i, "") + ".tf.ts";
			if (out === "-") {
				process.stdout.write(src);
			} else {
				out = writeContainedFileAtomic(cwd, outputRelativeTo(cwd, out), src, { force: flags.force === true });
				process.stdout.write(`wrote ${out}\n`);
			}
			process.exit(0);
		}

		if (cmd === "new") {
			const name = positional[1] ?? "hello";
			const content = flags.jsonEscape ? skeletonJson(name) : skeletonHello(name);
			let outRel =
				typeof flags.out === "string" && flags.out
					? flags.out
					: flags.jsonEscape
						? `./${name}.json`
						: `./${name}.tf.ts`;
			const out = writeContainedFileAtomic(cwd, outRel, content, { force: flags.force === true });
			process.stdout.write(`wrote ${out}\n`);
			process.exit(0);
		}

		process.stderr.write(`unknown command: ${cmd}\n${usage()}`);
		process.exit(2);
	} catch (e) {
		process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
		process.exit(2);
	}
}

function failUsage(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

function outputRelativeTo(cwd: string, out: string): string {
	return path.isAbsolute(out) ? path.relative(path.resolve(cwd), out) : out;
}

main();
