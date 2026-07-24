#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_ENDPOINTS } from "../packages/taskflow-control/src/web-protocol.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p17Path = path.join(
	repoRoot,
	"docs/internal/p-adrs/P17-browser-protocol.md",
);
const begin = "<!-- BEGIN GENERATED: P17-WEB-ENDPOINTS -->";
const end = "<!-- END GENERATED: P17-WEB-ENDPOINTS -->";

export function renderWebEndpointInventory() {
	const lines = [
		begin,
		"| Method/path | Request schema | Success `data` | Operation class |",
		"|-------------|----------------|----------------|-----------------|",
	];
	for (const endpoint of Object.values(WEB_ENDPOINTS)) {
		const requestName = endpoint.requestSchemaName.endsWith(" query")
			? `\`${endpoint.requestSchemaName.slice(0, -6)}\` query`
			: endpoint.requestSchemaName === "none"
				? "none"
				: `\`${endpoint.requestSchemaName}\``;
		lines.push(
			`| \`${endpoint.method} ${endpoint.path}\` | ${requestName} | \`${endpoint.successDataName}\` | ${endpoint.operationClass} |`,
		);
	}
	lines.push(end);
	return lines.join("\n");
}

function replaceGeneratedBlock(source, generated) {
	const start = source.indexOf(begin);
	const finish = source.indexOf(end);
	if (start < 0 || finish < start) {
		throw new Error("P17 endpoint inventory markers are missing or misordered");
	}
	return `${source.slice(0, start)}${generated}${source.slice(finish + end.length)}`;
}

const source = fs.readFileSync(p17Path, "utf8");
const expected = replaceGeneratedBlock(source, renderWebEndpointInventory());
if (process.argv.includes("--write")) {
	fs.writeFileSync(p17Path, expected);
	process.stdout.write(
		`updated P17 endpoint inventory from ${Object.keys(WEB_ENDPOINTS).length} registry entries\n`,
	);
} else if (expected !== source) {
	process.stderr.write(
		"P17 endpoint inventory drifted from WEB_ENDPOINTS; run pnpm generate:web-protocol-docs\n",
	);
	process.exitCode = 1;
} else {
	process.stdout.write(
		`P17 endpoint inventory matches ${Object.keys(WEB_ENDPOINTS).length} registry entries\n`,
	);
}
