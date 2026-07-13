import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
const distPath = fileURLToPath(dist);
const root = fs.readFileSync(new URL("index.html", dist), "utf8");
const basePath = process.env.TASKFLOW_BASE_PATH || "";

if (root.includes('id="__next_error__"') || !root.includes("0; url=./en/")) {
	throw new Error("Static export root must be a basePath-safe meta refresh to ./en/, not a Next redirect error shell");
}

for (const document of ["index.html", "404/index.html", "404.html"]) {
	const html = fs.readFileSync(new URL(document, dist), "utf8");
	if (!/^<!DOCTYPE html><html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) {
		throw new Error(`${document}: static export is missing the root document shell`);
	}
}

for (const relative of fs.globSync("**/*.html", { cwd: distPath })) {
	const html = fs.readFileSync(path.join(distPath, relative), "utf8");
	if (basePath) {
		for (const match of html.matchAll(/href="(\/(?:en|zh-cn)(?:\/[^"#?]*)?)"/g)) {
			throw new Error(`${relative}: internal link omits the ${basePath} basePath: ${match[1]}`);
		}
	}
	for (const match of html.matchAll(/http-equiv="refresh"[^>]*content="[^"]*url=([^";]+)[^"]*"/gi)) {
		const target = match[1]?.trim() ?? "";
		const safe =
			target.startsWith("./") ||
			target.startsWith("https://heggria.github.io/taskflow/") ||
			target.startsWith("/taskflow/");
		if (!safe) throw new Error(`${relative}: refresh target escapes the /taskflow basePath: ${target}`);
	}
}

process.stdout.write("Static export redirect/basePath check passed.\n");
