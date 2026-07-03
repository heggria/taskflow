// Copy the repo-root README into each publishable package so npm shows it on
// the package page. The root README is the single source of truth; these copies
// are generated at build time and git-ignored (like dist/). npm automatically
// includes a package-root README.md in the tarball, so no `files` entry needed.
//
// The root README uses root-relative paths (./assets/hero.png, ./LICENSE, doc
// links). npm resolves relative paths against each package's
// repository.directory (packages/<pkg>), so they would 404 on the npm page.
// We rewrite root-relative links to absolute GitHub URLs: image/raw files to
// raw.githubusercontent.com, everything else to github.com/.../blob/<branch>.
// Anchor (#...) and absolute (http...) links are left untouched.
//
// Usage:
//   node scripts/copy-readme.mjs                 → copy into all publishable packages
//   node scripts/copy-readme.mjs pi-taskflow     → copy into one package (used per-package build)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// Packages that are published to npm and should carry the README.
const PUBLISHABLE = new Set(["taskflow-core", "pi-taskflow", "codex-taskflow", "claude-taskflow", "opencode-taskflow"]);

const REPO = "heggria/taskflow";
const BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const BLOB_BASE = `https://github.com/${REPO}/blob/${BRANCH}`;

// Paths that point at binary/raw assets render inline; everything else is a
// browsable file/dir and should open on github.com.
const RAW_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;

/** Turn a root-relative target ("./assets/x.png", "examples") into an absolute URL. */
function absolutize(target) {
	const clean = target.replace(/^\.\//, "").replace(/^\//, "");
	return (RAW_EXT.test(clean) ? RAW_BASE : BLOB_BASE) + "/" + clean;
}

function rewrite(md) {
	// HTML attributes: src="./..." / href="./..."
	md = md.replace(/(\b(?:src|href)=")(\.\/[^"]+)"/g, (_m, pre, target) => `${pre}${absolutize(target)}"`);
	// Markdown links/images: ](./...) or ](examples) — skip anchors (#) and absolute (http).
	md = md.replace(/\]\((\.\/?[^)#][^)]*)\)/g, (_m, target) => `](${absolutize(target)})`);
	return md;
}

const rootReadme = join(repoRoot, "README.md");
let content;
try {
	content = readFileSync(rootReadme, "utf8");
} catch {
	console.error(`[copy-readme] root README not found: ${rootReadme}`);
	process.exit(1);
}
const rewritten = rewrite(content);

const arg = process.argv[2];
if (arg && !PUBLISHABLE.has(arg)) {
	console.error(`[copy-readme] unknown package '${arg}' (expected one of: ${[...PUBLISHABLE].join(", ")})`);
	process.exit(1);
}
const targets = arg ? [arg] : [...PUBLISHABLE];

for (const pkg of targets) {
	const dest = join(repoRoot, "packages", pkg, "README.md");
	writeFileSync(dest, rewritten);
	console.log(`[copy-readme] README.md → packages/${pkg}/`);
}
