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
//   --check: assert the stamp is non-"unknown" (used by test:pack to verify
//   the published dist carries a real commit); exits non-zero otherwise.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
try {
	commit = execSync("git rev-parse HEAD", { cwd: coreRoot, encoding: "utf8" }).trim();
} catch {
	// git unavailable — fall back to env, then "unknown".
	commit = process.env.PI_TASKFLOW_BUILD_COMMIT?.trim() || "unknown";
}
if (!commit) commit = "unknown";

const stamp = { gitCommit: commit, buildTime: Date.now() };
mkdirSync(destDir, { recursive: true });
writeFileSync(dest, `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`[stamp-build-info] stamped ${dest} (commit ${commit.slice(0, 12)}${commit.length > 12 ? "…" : ""})`);

if (process.argv.includes("--check")) {
	if (commit === "unknown") {
		console.error("[stamp-build-info] --check FAILED: commit is 'unknown' (git unavailable and PI_TASKFLOW_BUILD_COMMIT unset)");
		process.exit(1);
	}
	console.log(`[stamp-build-info] --check OK: ${commit}`);
}
