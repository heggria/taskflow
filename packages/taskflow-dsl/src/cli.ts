#!/usr/bin/env node
/**
 * taskflow-dsl CLI — build | check | decompile | new
 */

import fs from "node:fs";
import path from "node:path";
import { buildFile } from "./build.ts";
import { checkFile } from "./check.ts";
import { decompileTaskflow } from "./decompile.ts";
import { formatDiagnostics, hasErrors } from "./diagnostics.ts";
import { skeletonHello, skeletonJson } from "./new-skeleton.ts";
import { desugar, validateTaskflow, type Taskflow } from "taskflow-core";

function usage(): string {
	return `taskflow-dsl <command> [options] [path]

Commands:
  build <file>       Erase .tf.ts (or validate .json) → Taskflow / FlowIR
  check <file>       Erase + validate (no write)
  decompile <file>   Taskflow JSON → .tf.ts
  new [name]         Write hello skeleton

Options:
  -o, --out <path>   Output path
  --emit taskflow|flowir|both   (build, default: taskflow)
  --json             Machine-readable diagnostics
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
		else if (a === "--json") flags.json = true;
		else if (a === "-o" || a === "--out") flags.out = args[++i] ?? "";
		else if (a === "--emit") flags.emit = args[++i] ?? "taskflow";
		else if (a === "--force") flags.force = true;
		else if (a === "--json-escape") flags.jsonEscape = true;
		else if (a.startsWith("-")) flags[a] = true;
		else positional.push(a);
	}
	return { flags, positional };
}

function main(): void {
	const { flags, positional } = parseArgs(process.argv);
	if (flags.help || positional.length === 0) {
		process.stdout.write(usage());
		process.exit(flags.help ? 0 : 2);
	}
	const cmd = positional[0]!;

	try {
		if (cmd === "build") {
			const file = positional[1];
			if (!file) {
				process.stderr.write("build requires a file path\n");
				process.exit(2);
			}
			const emit = (String(flags.emit ?? "taskflow") as "taskflow" | "flowir" | "both");
			const r = buildFile(file, { emit, irHash: true, validate: true });
			if (flags.json) {
				process.stdout.write(
					JSON.stringify(
						{
							ok: r.ok,
							diagnostics: r.diagnostics,
							irHash: r.irHash,
							taskflow: r.taskflow,
						},
						null,
						2,
					) + "\n",
				);
			} else {
				if (r.diagnostics.length) process.stderr.write(formatDiagnostics(r.diagnostics) + "\n");
				if (r.ok && r.taskflow) {
					const stem = path.resolve(file).replace(/\.tf\.ts$/i, "").replace(/\.jsonc?$/i, "");
					const outTf =
						typeof flags.out === "string" && flags.out && emit === "taskflow"
							? flags.out
							: `${stem}.taskflow.json`;
					if (emit === "taskflow" || emit === "both") {
						const p = emit === "both" || !flags.out ? `${stem}.taskflow.json` : String(flags.out);
						fs.writeFileSync(p, JSON.stringify(r.taskflow, null, 2) + "\n");
						process.stdout.write(`wrote ${p}\n`);
					}
					if ((emit === "flowir" || emit === "both") && r.flowir) {
						const p = `${stem}.flowir.json`;
						fs.writeFileSync(
							p,
							JSON.stringify({ hash: r.irHash, ir: r.flowir }, null, 2) + "\n",
						);
						process.stdout.write(`wrote ${p} (${r.irHash})\n`);
					}
					if (emit === "taskflow" && flags.out) {
						fs.writeFileSync(String(flags.out), JSON.stringify(r.taskflow, null, 2) + "\n");
					}
					process.stdout.write(
						`ok name=${r.taskflow.name} phases=${r.taskflow.phases?.length ?? 0}` +
							(r.irHash ? ` ${r.irHash}` : "") +
							"\n",
					);
					void outTf;
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
			const r = checkFile(file);
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
			const raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
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
			const src = decompileTaskflow(def);
			const out =
				typeof flags.out === "string" && flags.out
					? flags.out
					: path.resolve(file).replace(/\.jsonc?$/i, "") + ".tf.ts";
			if (out === "-") process.stdout.write(src);
			else {
				fs.writeFileSync(out, src);
				process.stdout.write(`wrote ${out}\n`);
			}
			process.exit(0);
		}

		if (cmd === "new") {
			const name = positional[1] ?? "hello";
			const content = flags.jsonEscape ? skeletonJson(name) : skeletonHello(name);
			const out =
				typeof flags.out === "string" && flags.out
					? flags.out
					: flags.jsonEscape
						? `./${name}.json`
						: `./${name}.tf.ts`;
			if (fs.existsSync(out) && !flags.force) {
				process.stderr.write(`refusing to overwrite ${out} (use --force)\n`);
				process.exit(2);
			}
			fs.writeFileSync(out, content);
			process.stdout.write(`wrote ${out}\n`);
			process.exit(0);
		}

		process.stderr.write(`unknown command: ${cmd}\n${usage()}`);
		process.exit(2);
	} catch (e) {
		process.stderr.write((e instanceof Error ? e.stack ?? e.message : String(e)) + "\n");
		process.exit(2);
	}
}

main();
