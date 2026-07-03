/**
 * Impure scorers — the runtime half of the scoring-gate seam.
 *
 * `code-compiles` spawns a real compiler and therefore cannot live in the
 * pure scorers.ts module (mirrors the contract.ts ↔ runtime.ts split). The
 * runtime dispatches here for impure scorer types; everything else goes to
 * `evaluatePureScorer`.
 *
 * Fail semantics: an unavailable compiler, a spawn error, or a timeout is a
 * FAILED scorer (passed:false with a detail) — never a throw. The gate's
 * fail-open path (judge / task fallback) then decides what a failed check
 * means; a missing toolchain must not crash the run.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Scorer, type ScorerResult, scorerName } from "./scorers.ts";

/** Wall-clock cap for one compiler invocation. */
export const CODE_COMPILES_TIMEOUT_MS = 30_000;

/**
 * Check that the target parses/compiles for the scorer's `language`.
 *   - javascript: `node --check <file>` (syntax check; no execution, no deps)
 *   - typescript: `npx --no-install tsc --noEmit <file>` (types + syntax;
 *     requires a resolvable `tsc` — its absence FAILS the scorer with detail)
 *
 * If the target contains a single fenced code block, its body is compiled
 * (model outputs usually wrap code in fences); otherwise the raw target is.
 */
export async function runCodeCompilesScorer(
	scorer: Scorer,
	index: number,
	target: string,
	cwd: string,
): Promise<ScorerResult> {
	const name = scorerName(scorer, index);
	const mk = (passed: boolean, detail?: string): ScorerResult => ({
		name,
		type: scorer.type,
		passed,
		score: passed ? 1 : 0,
		detail,
	});

	const lang = scorer.language;
	if (lang !== "javascript" && lang !== "typescript") {
		return mk(false, `unsupported language '${String(lang)}' (expected javascript|typescript)`);
	}

	const code = extractCode(target);
	const ext = lang === "typescript" ? ".ts" : ".mjs";
	const file = path.join(os.tmpdir(), `taskflow-scorer-${process.pid}-${Date.now()}-${index}${ext}`);
	try {
		fs.writeFileSync(file, code, "utf-8");
		const [cmd, args] =
			lang === "typescript"
				? ["npx", ["--no-install", "tsc", "--noEmit", "--skipLibCheck", file]]
				: [process.execPath, ["--check", file]];
		const r = await runProcess(cmd, args as string[], cwd);
		if (r.timedOut) return mk(false, `compiler timed out after ${CODE_COMPILES_TIMEOUT_MS}ms`);
		if (r.spawnError) return mk(false, `compiler unavailable: ${r.spawnError}`);
		if (r.code === 0) return mk(true);
		const diag = (r.stderr || r.stdout).trim().split("\n").slice(0, 5).join("\n");
		return mk(false, diag || `compiler exited ${r.code}`);
	} catch (e) {
		return mk(false, `scorer error: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		try {
			fs.unlinkSync(file);
		} catch {
			/* best-effort cleanup */
		}
	}
}

/** If the target contains exactly one fenced code block, compile its body;
 *  otherwise compile the raw target. Multiple fences → raw target (we cannot
 *  guess which block the author meant; a syntax error will say so). */
function extractCode(target: string): string {
	const fences = [...target.matchAll(/```\w*[ \t]*\r?\n([\s\S]*?)```/g)];
	if (fences.length === 1) return fences[0][1];
	return target;
}

function runProcess(
	cmd: string,
	args: string[],
	cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (r: { code: number | null; spawnError?: string }) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ code: r.code, stdout, stderr, timedOut, spawnError: r.spawnError });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			resolve({ code: null, stdout, stderr, timedOut: false, spawnError: e instanceof Error ? e.message : String(e) });
			return;
		}
		timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}, CODE_COMPILES_TIMEOUT_MS);
		child.stdout?.on("data", (c: Buffer) => {
			stdout += c.toString();
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr += c.toString();
		});
		child.on("error", (e) => finish({ code: null, spawnError: e.message }));
		child.on("close", (code) => finish({ code }));
	});
}
