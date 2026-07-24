import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Value } from "typebox/value";
import { WebAssetManifestSchema } from "taskflow-control/web-static-manifest";
import { WEB_APP_ROUTE_PATTERNS } from "../src/app-routes.ts";
import {
	WEB_CONTENT_LOCALES,
	webContentCanonicalMaterial,
} from "../src/content/catalog.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(packageRoot, "dist", "app");
const assetsRoot = path.join(outputRoot, "assets");
const SIMPLE_SHELL_JS_GZIP_MAX_BYTES = 220 * 1024;

function canonical(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
		.join(",")}}`;
}

function sha256Bytes(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Canonical(value) {
	return sha256Bytes(Buffer.from(canonical(value), "utf8"));
}

function compareCodeUnits(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function mediaType(file) {
	switch (path.extname(file).toLowerCase()) {
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".ico":
			return "image/x-icon";
		case ".woff2":
			return "font/woff2";
		default:
			throw new TypeError(`unsupported packaged asset type: ${file}`);
	}
}

function assetRow(relativePath) {
	const bytes = fs.readFileSync(path.join(outputRoot, relativePath));
	if (
		relativePath.endsWith(".map") ||
		bytes.includes(Buffer.from("sourceMappingURL", "utf8"))
	) {
		throw new TypeError(`production source map material is forbidden: ${relativePath}`);
	}
	return {
		path: relativePath,
		sha256: sha256Bytes(bytes),
		size: bytes.byteLength,
		mediaType: mediaType(relativePath),
	};
}

function initialJavaScriptPaths(html) {
	const paths = [];
	for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gu)) {
		const isScript = tag.startsWith("<script");
		const isModulePreload =
			/\brel="modulepreload"/u.test(tag);
		if (!isScript && !isModulePreload) continue;
		const match = /\b(?:src|href)="\/([^"]+\.js)"/u.exec(tag);
		if (match?.[1]) paths.push(match[1]);
	}
	if (paths.length === 0 || new Set(paths).size !== paths.length) {
		throw new TypeError(
			"production entrypoint must reference a unique initial JavaScript set",
		);
	}
	return paths;
}

if (!fs.existsSync(path.join(outputRoot, "index.html"))) {
	throw new TypeError("Vite output is missing index.html");
}
fs.mkdirSync(assetsRoot, { recursive: true });

const content = webContentCanonicalMaterial();
const catalogRows = [];
for (const locale of WEB_CONTENT_LOCALES) {
	const payload = Buffer.from(
		`${canonical({
			version: content.version,
			locale,
			entries: content.catalogs[locale],
		})}\n`,
		"utf8",
	);
	const digest = sha256Bytes(payload);
	const name = `content-${locale.toLowerCase()}-${digest.slice(7, 23)}.json`;
	const relativePath = `assets/${name}`;
	fs.writeFileSync(path.join(outputRoot, relativePath), payload, {
		flag: "wx",
		mode: 0o644,
	});
	catalogRows.push({
		locale,
		path: relativePath,
		sha256: digest,
		size: payload.byteLength,
	});
}

const assetPaths = fs
	.readdirSync(assetsRoot, { withFileTypes: true })
	.filter((entry) => entry.isFile())
	.map((entry) => `assets/${entry.name}`)
	.sort(compareCodeUnits);
const assets = assetPaths.map(assetRow);
const entrypointBytes = fs.readFileSync(path.join(outputRoot, "index.html"));
const initialJsPaths = initialJavaScriptPaths(
	entrypointBytes.toString("utf8"),
);
for (const relativePath of initialJsPaths) {
	if (!assetPaths.includes(relativePath)) {
		throw new TypeError(
			`initial JavaScript is absent from the packaged asset set: ${relativePath}`,
		);
	}
}
const simpleShellJsGzipBytes = initialJsPaths.reduce(
	(total, relativePath) =>
		total +
		gzipSync(fs.readFileSync(path.join(outputRoot, relativePath)))
			.byteLength,
	0,
);
if (simpleShellJsGzipBytes > SIMPLE_SHELL_JS_GZIP_MAX_BYTES) {
	throw new TypeError(
		`Simple shell JavaScript is ${simpleShellJsGzipBytes} gzip bytes; maximum is ${SIMPLE_SHELL_JS_GZIP_MAX_BYTES}`,
	);
}
const routePatterns = [...WEB_APP_ROUTE_PATTERNS].sort((a, b) =>
	compareCodeUnits(a.id, b.id),
);
const packageJson = JSON.parse(
	fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);
const buildMaterial = {
	entrypoint: sha256Bytes(entrypointBytes),
	assets: assets.map(({ path: assetPath, sha256, size }) => ({
		path: assetPath,
		sha256,
		size,
	})),
	routes: routePatterns,
	contentVersion: content.version,
};
const manifest = {
	manifestVersion: "taskflow-web-assets.v1",
	packageVersion: packageJson.version,
	webBuildId: sha256Canonical(buildMaterial),
	protocolConsumer: { major: 1, minMinor: 0, maxMinor: 0 },
	entrypoint: {
		path: "index.html",
		sha256: sha256Bytes(entrypointBytes),
	},
	assets,
	routeRegistry: {
		version: "taskflow-web-routes.v1",
		patterns: routePatterns,
		sha256: sha256Canonical(routePatterns),
	},
	contentCatalogs: {
		version: "taskflow-content.v1",
		defaultLocale: "en",
		supportedLocales: ["en", "zh-CN"],
		projectedKeysetSha256: sha256Canonical(content.projectedRegistry),
		staticKeysetSha256: sha256Canonical(content.staticRegistry),
		keysetSha256: sha256Canonical(content.combinedKeys),
		catalogs: catalogRows,
	},
};

if (!Value.Check(WebAssetManifestSchema, manifest)) {
	const errors = [...Value.Errors(WebAssetManifestSchema, manifest)]
		.slice(0, 8)
		.map((error) => `${error.path}: ${error.message}`)
		.join("; ");
	throw new TypeError(`generated asset manifest failed P17 schema: ${errors}`);
}
fs.writeFileSync(
	path.join(outputRoot, "taskflow-web-assets.json"),
	`${canonical(manifest)}\n`,
	{ flag: "wx", mode: 0o644 },
);
process.stdout.write(
	`[build-assets] Simple shell JavaScript: ${simpleShellJsGzipBytes}/${SIMPLE_SHELL_JS_GZIP_MAX_BYTES} gzip bytes across ${initialJsPaths.length} assets\n`,
);
