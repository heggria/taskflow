/**
 * G3 typecheck evidence helper for Trusted Effects GA converge.
 * Runs monorepo `tsc --noEmit`, writes docs/internal/typecheck-evidence-0.3.0.txt,
 * exits non-zero on type errors (fail closed).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const outPath = join(root, "docs/internal/typecheck-evidence-0.3.0.txt");
mkdirSync(join(root, "docs/internal"), { recursive: true });

const branch = spawnSync("git", ["branch", "--show-current"], {
	encoding: "utf8",
	cwd: root,
}).stdout?.trim() || "unknown";

const date = new Date().toISOString();
const tsc = spawnSync("pnpm", ["exec", "tsc", "--noEmit"], {
	encoding: "utf8",
	cwd: root,
	env: process.env,
});

const stdout = (tsc.stdout ?? "") + (tsc.stderr ?? "");
const exitCode = typeof tsc.status === "number" ? tsc.status : 1;
const body = [
	"# G3 typecheck evidence",
	`branch: ${branch}`,
	`date: ${date}`,
	"command: pnpm exec tsc --noEmit",
	"---",
	stdout.trimEnd() || "(no compiler output)",
	"---",
	`exit: ${exitCode}`,
	"",
].join("\n");

writeFileSync(outPath, body, "utf8");
process.stdout.write(body);
process.exit(exitCode);
