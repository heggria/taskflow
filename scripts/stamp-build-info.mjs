// Stamp the build identity into dist/build-info.json so the published
// taskflow-core package can report the git commit it was built from WITHOUT
// running git at runtime (0.2.0 dogfood issue 4). The stamp lives under dist/
// (gitignored) so a normal build never dirties the source tree.
//
// `gitCommit` is best-effort: if `git rev-parse HEAD` fails (shallow clone
// without git, detached export, etc.), the field falls back to the env var
// PI_TASKFLOW_BUILD_COMMIT, then to "unknown". The runtime reader also honors
// PI_TASKFLOW_BUILD_COMMIT, so a CI that cannot run git can still stamp a
// known commit via env.
//
// Usage: node scripts/stamp-build-info.mjs [--check]
//   --check: read (never rewrite) the existing stamp and assert that it carries
//   the current concrete commit/build time; exits non-zero otherwise.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coreRoot = join(here, "..", "packages", "taskflow-core");
const destDir = join(coreRoot, "dist");
const dest = join(destDir, "build-info.json");

if (!existsSync(destDir)) {
	console.error(`[stamp-build-info] dist/ not found: ${destDir}. Run tsc first.`);
	process.exit(1);
}

let commit = "";
let commitTimeMs;
try {
	commit = execSync("git rev-parse HEAD", { cwd: coreRoot, encoding: "utf8" }).trim();
	const seconds = Number(execSync("git show -s --format=%ct HEAD", { cwd: coreRoot, encoding: "utf8" }).trim());
	if (Number.isFinite(seconds) && seconds >= 0) commitTimeMs = seconds * 1000;
} catch {
	// git unavailable — fall back to env, then "unknown".
	commit = process.env.PI_TASKFLOW_BUILD_COMMIT?.trim() || "unknown";
}
if (!commit) commit = "unknown";

// SOURCE_DATE_EPOCH keeps exported/CI builds reproducible; otherwise a real git
// build uses the immutable commit timestamp. Unknown source builds omit time
// rather than injecting Date.now() and making identical tarballs differ.
const sourceEpoch = Number(process.env.SOURCE_DATE_EPOCH);
const buildTime = Number.isFinite(sourceEpoch) && sourceEpoch >= 0
	? sourceEpoch * 1000
	: commitTimeMs;
const stamp = { gitCommit: commit, ...(buildTime !== undefined ? { buildTime } : {}) };

if (process.argv.includes("--check")) {
	let actual;
	try {
		actual = JSON.parse(readFileSync(dest, "utf8"));
	} catch (error) {
		console.error(`[stamp-build-info] --check FAILED: cannot read existing stamp: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	if (!actual || typeof actual !== "object" || !/^[0-9a-f]{40}$/i.test(actual.gitCommit ?? "")) {
		console.error("[stamp-build-info] --check FAILED: existing stamp must contain a concrete 40-hex gitCommit");
		process.exit(1);
	}
	if (/^[0-9a-f]{40}$/i.test(commit) && actual.gitCommit !== commit) {
		console.error(`[stamp-build-info] --check FAILED: existing commit ${actual.gitCommit} does not match current commit ${commit}`);
		process.exit(1);
	}
	if (buildTime !== undefined && actual.buildTime !== buildTime) {
		console.error(`[stamp-build-info] --check FAILED: existing buildTime ${actual.buildTime} does not match expected ${buildTime}`);
		process.exit(1);
	}
	console.log(`[stamp-build-info] --check OK: ${actual.gitCommit}`);
	process.exit(0);
}

mkdirSync(destDir, { recursive: true });
writeFileSync(dest, `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`[stamp-build-info] stamped ${dest} (commit ${commit.slice(0, 12)}${commit.length > 12 ? "…" : ""})`);
