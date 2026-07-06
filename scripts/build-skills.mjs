// Single-source skill builder.
//
// skills-src/taskflow/ is the ONLY place skill content is authored:
//   entry.pi.md      — pi frontmatter + host binding preamble
//   entry.codex.md   — codex frontmatter + MCP tool table preamble
//   entry.claude.md  — claude frontmatter + MCP tool table preamble
//   entry.opencode.md— opencode frontmatter + MCP tool table preamble
//   core.md          — the shared body (host-conditional blocks allowed)
//   patterns.md, advanced.md, configuration.md — shared companions
//
// Host-conditional blocks use HTML comment markers on their own lines; the
// host field is a comma-list, kept when it contains the build target:
//   <!-- host:pi -->           …pi-only content…        <!-- /host:pi -->
//   <!-- host:codex,claude --> …MCP-hosts content…     <!-- /host:codex,claude -->
// Marker lines are always stripped. Nesting is not supported (build error).
//
// Outputs (generated, committed; drift-guarded by skills-build.test.ts):
//   packages/pi-taskflow/skills/taskflow/{SKILL.md,patterns.md,advanced.md,configuration.md}
//   packages/codex-taskflow/plugin/skills/taskflow/{…same four…}
//   packages/claude-taskflow/plugin/skills/taskflow/{…same four…}
//   packages/opencode-taskflow/plugin/skills/taskflow/{…same four…}
//
// Usage: node scripts/build-skills.mjs [--check]
//   --check: exit 1 if any generated file differs from what's on disk.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDir = join(root, "skills-src", "taskflow");

const HOSTS = ["pi", "codex", "claude", "opencode"];
const COMPANIONS = ["patterns.md", "advanced.md", "configuration.md"];
const OUT_DIRS = {
	pi: join(root, "packages", "pi-taskflow", "skills", "taskflow"),
	codex: join(root, "packages", "codex-taskflow", "plugin", "skills", "taskflow"),
	claude: join(root, "packages", "claude-taskflow", "plugin", "skills", "taskflow"),
	opencode: join(root, "packages", "opencode-taskflow", "plugin", "skills", "taskflow"),
};

const GENERATED_BANNER = (src) =>
	`<!-- GENERATED FILE — do not edit. Source: skills-src/taskflow/${src} (npm run build:skills) -->\n`;

/** Parse a `host:` marker's comma-list (`codex,claude`) into validated names. */
function parseHostList(spec, file, lineNo) {
	const hosts = spec.split(",").map((h) => h.trim()).filter(Boolean);
	if (hosts.length === 0) throw new Error(`${file}:${lineNo}: empty host list`);
	for (const h of hosts) {
		if (!HOSTS.includes(h)) throw new Error(`${file}:${lineNo}: unknown host '${h}'`);
	}
	return hosts;
}

/** Keep/drop host-conditional blocks for `host`; strip marker lines. A block's
 *  `host:` field is a comma-list, kept when it includes the build target. */
function filterForHost(text, host, file) {
	const out = [];
	let active = null; // comma-list (raw) of the block we're inside, or null
	let activeHosts = null; // parsed host names of that block
	let openLine = 0;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const open = line.match(/^\s*<!--\s*host:([\w,\s]+?)\s*-->\s*$/);
		const close = line.match(/^\s*<!--\s*\/host:([\w,\s]+?)\s*-->\s*$/);
		if (open) {
			if (active) throw new Error(`${file}:${i + 1}: nested host block (opened at line ${openLine})`);
			activeHosts = parseHostList(open[1], file, i + 1);
			active = open[1].replace(/\s/g, "");
			openLine = i + 1;
			continue;
		}
		if (close) {
			if (!active) throw new Error(`${file}:${i + 1}: closing marker without an open block`);
			if (close[1].replace(/\s/g, "") !== active)
				throw new Error(`${file}:${i + 1}: mismatched close (open='${active}')`);
			active = null;
			activeHosts = null;
			continue;
		}
		if (active === null || activeHosts.includes(host)) out.push(line);
	}
	if (active) throw new Error(`${file}: unclosed host block '${active}' opened at line ${openLine}`);
	// Collapse runs of 3+ blank lines left behind by dropped blocks.
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function read(name) {
	const p = join(srcDir, name);
	if (!existsSync(p)) throw new Error(`missing source file: ${p}`);
	return readFileSync(p, "utf8");
}

export function buildAll() {
	const core = read("core.md");
	const files = []; // { path, content }
	for (const host of HOSTS) {
		const entry = read(`entry.${host}.md`);
		// SKILL.md = frontmatter+preamble (entry) + filtered shared body.
		const skill =
			entry.replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${GENERATED_BANNER(`entry.${host}.md + core.md`)}`).trimEnd() +
			"\n\n" +
			filterForHost(core, host, "core.md").trim() +
			"\n";
		files.push({ path: join(OUT_DIRS[host], "SKILL.md"), content: skill });
		for (const c of COMPANIONS) {
			const body = GENERATED_BANNER(c) + "\n" + filterForHost(read(c), host, c).trim() + "\n";
			files.push({ path: join(OUT_DIRS[host], c), content: body });
		}
	}
	return files;
}

const check = process.argv.includes("--check");
const files = buildAll();
let drift = 0;
for (const f of files) {
	const rel = f.path.slice(root.length + 1);
	if (check) {
		const current = existsSync(f.path) ? readFileSync(f.path, "utf8") : "<missing>";
		if (current !== f.content) {
			console.error(`[build-skills] DRIFT: ${rel}`);
			drift++;
		}
	} else {
		mkdirSync(dirname(f.path), { recursive: true });
		writeFileSync(f.path, f.content);
		console.log(`[build-skills] wrote ${rel}`);
	}
}
if (check) {
	if (drift) {
		console.error(`\n[build-skills] ${drift} file(s) out of date — run: node scripts/build-skills.mjs`);
		process.exit(1);
	}
	console.log("[build-skills] all generated skill files up to date");
}
