import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const docsRoot = join(root, "content", "docs");
const locales = ["en", "zh-cn"];

const forbidden = [
	{
		label: "subagent transcript marker",
		pattern: /^#{2,4}\s+\[[1-9]\/[1-9]\]/m,
	},
	{ label: "review transcript heading", pattern: /^##\s+Risk Review\s*$/m },
	{ label: "generated file handoff", pattern: /^##\s+FILE:\s+/m },
	{
		label: "analysis transcript prose",
		pattern:
			/Based on my analysis|Proceeding with the deliverable|Now I have all the evidence needed/,
	},
	{
		label: "navigation edit instructions",
		pattern:
			/meta\.json (?:Placement|update)|insert .* in the [`'"]?pages[`'"]? array/i,
	},
];

const failures = [];

function walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(path);
			continue;
		}
		if (!entry.name.endsWith(".mdx")) continue;

		const source = readFileSync(path, "utf8");
		for (const check of forbidden) {
			if (check.pattern.test(source)) {
				failures.push(`${relative(root, path)}: ${check.label}`);
			}
		}
	}
}

for (const locale of locales) {
	const localeDir = join(docsRoot, locale);
	for (const entry of readdirSync(localeDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const sectionDir = join(localeDir, entry.name);
		const hasMdx = readdirSync(sectionDir).some((name) =>
			name.endsWith(".mdx"),
		);
		if (hasMdx && !existsSync(join(sectionDir, "meta.json"))) {
			failures.push(
				`${relative(root, sectionDir)}: missing folder-level meta.json`,
			);
		}
	}

	const rootMetaPath = join(localeDir, "meta.json");
	const rootMeta = JSON.parse(readFileSync(rootMetaPath, "utf8"));
	for (const page of rootMeta.pages ?? []) {
		if (typeof page === "string" && page.includes("/index")) {
			failures.push(
				`${relative(root, rootMetaPath)}: root navigation must reference folders, not '${page}'`,
			);
		}
	}
}

walk(docsRoot);

if (failures.length > 0) {
	console.error("Docs hygiene check failed:\n");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}

console.log("Docs hygiene check passed.");
