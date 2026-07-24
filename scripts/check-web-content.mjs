#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	WEB_COMBINED_CONTENT_KEYS,
	WEB_CONTENT_LOCALES,
	WEB_PROJECTED_CONTENT_CATALOG,
	WEB_STATIC_CONTENT_KEYS,
	assertWebContentCatalogsValid,
	webContentCanonicalMaterial,
} from "../packages/taskflow-web/src/content/catalog.ts";

function canonical(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
		.join(",")}}`;
}

function sha256(value) {
	return `sha256:${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function sourceFiles(root) {
	const result = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) result.push(...sourceFiles(absolute));
		else if (entry.isFile() && absolute.endsWith(".tsx")) result.push(absolute);
	}
	return result.sort((left, right) => left.localeCompare(right, "en"));
}

function hasVisibleWords(value) {
	return /[\p{L}\p{N}]/u.test(value.trim());
}

function lintInlineStaticStrings() {
	const root = path.resolve("packages/taskflow-web/src");
	const findings = [];
	for (const file of sourceFiles(root)) {
		const source = fs.readFileSync(file, "utf8");
		const report = (index, value, surface) => {
			if (!hasVisibleWords(value)) return;
			const prefix = source.slice(0, index);
			const line = prefix.split("\n").length;
			const lastBreak = prefix.lastIndexOf("\n");
			const character = index - lastBreak;
			findings.push(
				`${path.relative(process.cwd(), file)}:${line}:${character} ${surface}: ${JSON.stringify(value.trim())}`,
			);
		};
		for (const match of source.matchAll(
			/(?:<[\p{L}][^<>\r\n]*>|<>)\s*([^<>{}\r\n]*[\p{L}\p{N}][^<>{}\r\n]*)\s*<\//gu,
		)) {
			report(match.index, match[1] ?? "", "inline JSX text");
		}
		for (const match of source.matchAll(
			/\b(aria-label|alt|placeholder|title)\s*=\s*(["'])([^"'\r\n]+)\2/gu,
		)) {
			report(
				match.index,
				match[3] ?? "",
				`inline ${match[1] ?? "accessible name"}`,
			);
		}
		for (const match of source.matchAll(
			/>\s*\{\s*(["'`])([^"'`\r\n]*[\p{L}\p{N}][^"'`\r\n]*)\1\s*\}\s*</gu,
		)) {
			report(match.index, match[2] ?? "", "inline JSX expression");
		}
	}
	if (findings.length > 0) {
		throw new Error(
			`Unregistered static browser copy:\n${findings.join("\n")}`,
		);
	}
}

assertWebContentCatalogsValid();
lintInlineStaticStrings();
const material = webContentCanonicalMaterial();
const result = {
	version: material.version,
	projectedKeyCount: Object.keys(WEB_PROJECTED_CONTENT_CATALOG).length,
	staticKeyCount: WEB_STATIC_CONTENT_KEYS.length,
	combinedKeyCount: WEB_COMBINED_CONTENT_KEYS.length,
	projectedKeysetSha256: sha256(material.projectedRegistry),
	staticKeysetSha256: sha256(material.staticRegistry),
	combinedKeysetSha256: sha256(material.combinedKeys),
	catalogs: Object.fromEntries(
		WEB_CONTENT_LOCALES.map((locale) => [
			locale,
			sha256(material.catalogs[locale]),
		]),
	),
};

if (process.argv.includes("--json")) {
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
	process.stdout.write(
		`web content valid (${result.projectedKeyCount} projected + ${result.staticKeyCount} static = ${result.combinedKeyCount}; ${WEB_CONTENT_LOCALES.join(", ")})\n`,
	);
}
