import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as http from "node:http";
import { Value } from "typebox/value";
import {
	WebAssetManifestSchema,
	type WebAssetManifest,
	type WebStaticMediaType,
	type WebStaticRoutePattern,
} from "taskflow-control/web-static-manifest";

const MANIFEST_NAME = "taskflow-web-assets.json";
const HTML_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; manifest-src 'self'; worker-src 'self'";
const PERMISSIONS_POLICY =
	"accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()";

export type WebStaticAssetsOptions = {
	readonly root: string;
	readonly packageVersion: string;
	readonly protocolMajor: 1;
	readonly protocolMinor: number;
	readonly contentKeysetDigests: {
		readonly projected: string;
		readonly static: string;
		readonly combined: string;
	};
	readonly manifestName?: typeof MANIFEST_NAME;
};

type PinnedAsset = {
	readonly path: string;
	readonly sha256: string;
	readonly mediaType: WebStaticMediaType | "text/html; charset=utf-8";
	readonly bytes: Buffer;
	readonly entrypoint: boolean;
};

export type WebStaticAssets = {
	readonly root: string;
	readonly manifest: WebAssetManifest;
	readonly assets: ReadonlyMap<string, PinnedAsset>;
	readonly entrypoint: PinnedAsset;
};

export type StaticServeResult =
	| { readonly handled: false }
	| { readonly handled: true };

export class WebStaticAssetsError extends Error {
	override readonly name = "WebStaticAssetsError";
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}

function sha256(value: Uint8Array | string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertSortedUnique(values: readonly string[], label: string): void {
	for (let index = 0; index < values.length; index += 1) {
		if (
			(index > 0 && values[index - 1]! >= values[index]!) ||
			values[index] === undefined
		) {
			throw new WebStaticAssetsError(`${label} must be unique and sorted`);
		}
	}
}

function assertNoSymlinkComponents(root: string, relativePath: string): void {
	let current = root;
	for (const segment of relativePath.split("/")) {
		current = path.join(current, segment);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) {
			throw new WebStaticAssetsError(
				`asset path contains a symlink: ${relativePath}`,
			);
		}
	}
}

function pinnedFile(
	root: string,
	relativePath: string,
	expectedDigest: string,
	expectedSize: number | undefined,
	mediaType: PinnedAsset["mediaType"],
	entrypoint: boolean,
): PinnedAsset {
	const candidate = path.resolve(root, relativePath);
	const relative = path.relative(root, candidate);
	if (
		relative.startsWith("..") ||
		path.isAbsolute(relative) ||
		relative.includes("\\")
	) {
		throw new WebStaticAssetsError(`asset escaped package root: ${relativePath}`);
	}
	assertNoSymlinkComponents(root, relativePath);
	const lstat = fs.lstatSync(candidate);
	if (!lstat.isFile()) {
		throw new WebStaticAssetsError(`asset is not a regular file: ${relativePath}`);
	}
	const realRoot = fs.realpathSync(root);
	const realCandidate = fs.realpathSync(candidate);
	const realRelative = path.relative(realRoot, realCandidate);
	if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
		throw new WebStaticAssetsError(`asset canonical path escaped root: ${relativePath}`);
	}
	const bytes = fs.readFileSync(realCandidate);
	if (expectedSize !== undefined && bytes.byteLength !== expectedSize) {
		throw new WebStaticAssetsError(`asset size mismatch: ${relativePath}`);
	}
	if (sha256(bytes) !== expectedDigest) {
		throw new WebStaticAssetsError(`asset digest mismatch: ${relativePath}`);
	}
	if (
		relativePath.endsWith(".map") ||
		bytes.includes(Buffer.from("sourceMappingURL", "utf8"))
	) {
		throw new WebStaticAssetsError(`source map material is forbidden: ${relativePath}`);
	}
	return {
		path: relativePath,
		sha256: expectedDigest,
		mediaType,
		bytes,
		entrypoint,
	};
}

export function loadWebStaticAssets(
	options: WebStaticAssetsOptions,
): WebStaticAssets {
	const root = path.resolve(options.root);
	const rootStat = fs.lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new WebStaticAssetsError("web asset root must be a real directory");
	}
	const manifestName = options.manifestName ?? MANIFEST_NAME;
	if (manifestName !== MANIFEST_NAME) {
		throw new WebStaticAssetsError("web asset manifest name is not supported");
	}
	const manifestPath = path.join(root, manifestName);
	const manifestStat = fs.lstatSync(manifestPath);
	if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
		throw new WebStaticAssetsError("web asset manifest must be a regular file");
	}
	let manifestValue: unknown;
	try {
		manifestValue = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
	} catch (error) {
		throw new WebStaticAssetsError(
			`web asset manifest is not valid JSON: ${String(error)}`,
		);
	}
	if (!Value.Check(WebAssetManifestSchema, manifestValue)) {
		const [first] = Value.Errors(WebAssetManifestSchema, manifestValue);
		throw new WebStaticAssetsError(
			`web asset manifest failed schema${first ? `: ${first.message}` : ""}`,
		);
	}
	const manifest = manifestValue as WebAssetManifest;
	if (manifest.packageVersion !== options.packageVersion) {
		throw new WebStaticAssetsError(
			`web/daemon package mismatch (${manifest.packageVersion} != ${options.packageVersion})`,
		);
	}
	if (
		manifest.protocolConsumer.major !== options.protocolMajor ||
		options.protocolMinor < manifest.protocolConsumer.minMinor ||
		options.protocolMinor > manifest.protocolConsumer.maxMinor
	) {
		throw new WebStaticAssetsError("web/API protocol range is incompatible");
	}
	if (
		manifest.contentCatalogs.projectedKeysetSha256 !==
			options.contentKeysetDigests.projected ||
		manifest.contentCatalogs.staticKeysetSha256 !==
			options.contentKeysetDigests.static ||
		manifest.contentCatalogs.keysetSha256 !==
			options.contentKeysetDigests.combined
	) {
		throw new WebStaticAssetsError("web/API content keysets are incompatible");
	}
	const assetPaths = manifest.assets.map((asset) => asset.path);
	assertSortedUnique(assetPaths, "manifest assets");
	const routeIds = manifest.routeRegistry.patterns.map((route) => route.id);
	assertSortedUnique(routeIds, "route patterns");
	const routeShapes = manifest.routeRegistry.patterns
		.map((route) => canonical(route.tokens))
		.sort();
	assertSortedUnique(routeShapes, "route token patterns");
	if (
		sha256(Buffer.from(canonical(manifest.routeRegistry.patterns), "utf8")) !==
		manifest.routeRegistry.sha256
	) {
		throw new WebStaticAssetsError("route registry digest mismatch");
	}
	const assets = new Map<string, PinnedAsset>();
	for (const row of manifest.assets) {
		const asset = pinnedFile(
			root,
			row.path,
			row.sha256,
			row.size,
			row.mediaType,
			false,
		);
		assets.set(`/${row.path}`, asset);
	}
	for (const catalog of manifest.contentCatalogs.catalogs) {
		const asset = assets.get(`/${catalog.path}`);
		if (
			!asset ||
			asset.sha256 !== catalog.sha256 ||
			asset.bytes.byteLength !== catalog.size ||
			asset.mediaType !== "application/json; charset=utf-8"
		) {
			throw new WebStaticAssetsError(`content catalog is not bound: ${catalog.locale}`);
		}
	}
	assertSortedUnique(
		manifest.contentCatalogs.catalogs.map((catalog) => catalog.path).sort(),
		"content catalog paths",
	);
	const entrypoint = pinnedFile(
		root,
		manifest.entrypoint.path,
		manifest.entrypoint.sha256,
		undefined,
		"text/html; charset=utf-8",
		true,
	);
	return { root, manifest, assets, entrypoint };
}

/**
 * Decode one canonical request-target path for the static route partition.
 *
 * The returned value is routing-only and is never used as a filesystem path.
 * Static file lookup remains an exact manifest lookup over pinned package bytes.
 */
export function decodeCanonicalWebStaticPath(
	rawTarget: string,
): string | null {
	const rawPath = rawTarget.split(/[?#]/u, 1)[0] ?? "/";
	if (
		rawPath.length === 0 ||
		rawPath.includes("\\") ||
		/%(?:2f|5c|00)/iu.test(rawPath) ||
		/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(rawPath)
	) {
		return null;
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		return null;
	}
	if (
		decoded.includes("%") ||
		decoded.normalize("NFC") !== decoded ||
		decoded
			.split("/")
			.map((segment) => encodeURIComponent(segment))
			.join("/") !== rawPath
	) {
		return null;
	}
	if (
		decoded.includes("\\") ||
		decoded.includes("//") ||
		decoded.split("/").some((segment) => segment === "." || segment === "..") ||
		/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(decoded)
	) {
		return null;
	}
	return decoded.startsWith("/") ? decoded : null;
}

function routeMatches(
	pathname: string,
	pattern: WebStaticRoutePattern,
): boolean {
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length !== pattern.tokens.length) return false;
	return pattern.tokens.every((token, index) => {
		const segment = segments[index]!;
		if (token.kind === "literal") return segment === token.value;
		return (
			segment.length > 0 &&
			segment.length <= 128 &&
			/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment)
		);
	});
}

type HtmlAccept = "accept" | "reject" | "invalid";

function htmlAccept(request: http.IncomingMessage): HtmlAccept {
	const values: string[] = [];
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index]?.toLowerCase() === "accept") {
			values.push(request.rawHeaders[index + 1] ?? "");
		}
	}
	if (values.length === 0) return "accept";
	const ranges = values.join(",").split(",");
	const candidates: Array<{ specificity: number; quality: number }> = [];
	for (const range of ranges) {
		const parts = range.split(";");
		const match =
			/^\s*([A-Za-z0-9!#$&^_.+-]+|\*)\/([A-Za-z0-9!#$&^_.+-]+|\*)\s*$/u.exec(
				parts.shift() ?? "",
			);
		if (!match) return "invalid";
		const type = match[1]!.toLowerCase();
		const subtype = match[2]!.toLowerCase();
		if (type === "*" && subtype !== "*") return "invalid";
		let quality = 1;
		let sawQuality = false;
		for (const part of parts) {
			const parameter =
				/^\s*([A-Za-z0-9!#$&^_.+-]+)\s*=\s*([A-Za-z0-9!#$&^_.+-]+|"(?:\\.|[^"\\])*")\s*$/u.exec(
					part,
				);
			if (!parameter) return "invalid";
			if (parameter[1]!.toLowerCase() !== "q") continue;
			if (
				sawQuality ||
				!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(parameter[2]!)
			) {
				return "invalid";
			}
			sawQuality = true;
			quality = Number(parameter[2]);
		}
		if (type === "text" && subtype === "html") {
			candidates.push({ specificity: 2, quality });
		} else if (type === "text" && subtype === "*") {
			candidates.push({ specificity: 1, quality });
		} else if (type === "*" && subtype === "*") {
			candidates.push({ specificity: 0, quality });
		}
	}
	if (candidates.length === 0) return "reject";
	const specificity = Math.max(...candidates.map((item) => item.specificity));
	const quality = Math.max(
		...candidates
			.filter((item) => item.specificity === specificity)
			.map((item) => item.quality),
	);
	return quality > 0 ? "accept" : "reject";
}

function staticHeaders(asset: PinnedAsset): http.OutgoingHttpHeaders {
	const headers: http.OutgoingHttpHeaders = {
		"Content-Type": asset.mediaType,
		"Content-Length": String(asset.bytes.byteLength),
		"Cache-Control": asset.entrypoint
			? "no-store"
			: "public, max-age=31536000, immutable",
		"Cross-Origin-Resource-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff",
	};
	if (asset.entrypoint) {
		headers["Content-Security-Policy"] = HTML_CSP;
		headers["Referrer-Policy"] = "no-referrer";
		headers["Cross-Origin-Opener-Policy"] = "same-origin";
		headers["Permissions-Policy"] = PERMISSIONS_POLICY;
	}
	return headers;
}

function sendAsset(
	request: http.IncomingMessage,
	response: http.ServerResponse,
	asset: PinnedAsset,
): void {
	response.writeHead(200, staticHeaders(asset));
	response.end(request.method === "HEAD" ? undefined : asset.bytes);
}

function sendStaticStatus(
	response: http.ServerResponse,
	status: number,
	message: string,
	headers: http.OutgoingHttpHeaders = {},
): void {
	const bytes = Buffer.from(
		JSON.stringify({
			ok: false,
			error: { code: "TF_NOT_FOUND", message },
		}),
		"utf8",
	);
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(bytes.byteLength),
		"Cache-Control": "no-store",
		"Cross-Origin-Resource-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff",
		...headers,
	});
	response.end(bytes);
}

export function serveWebStaticRequest(
	bundle: WebStaticAssets,
	request: http.IncomingMessage,
	response: http.ServerResponse,
): StaticServeResult {
	const pathname = decodeCanonicalWebStaticPath(request.url ?? "/");
	if (!pathname) {
		sendStaticStatus(response, 400, "Static request path is invalid.");
		return { handled: true };
	}
	const asset = bundle.assets.get(pathname);
	if (pathname.startsWith("/assets/")) {
		if (!asset) sendStaticStatus(response, 404, "Static asset was not found.");
		else if (request.method !== "GET" && request.method !== "HEAD") {
			sendStaticStatus(response, 405, "Static asset method is not allowed.", {
				Allow: "GET, HEAD",
			});
		} else {
			sendAsset(request, response, asset);
		}
		return { handled: true };
	}
	const knownRoute = bundle.manifest.routeRegistry.patterns.some((pattern) =>
		routeMatches(pathname, pattern),
	);
	if (!knownRoute) return { handled: false };
	if (request.method !== "GET" && request.method !== "HEAD") {
		sendStaticStatus(response, 405, "Application route method is not allowed.", {
			Allow: "GET, HEAD",
		});
		return { handled: true };
	}
	const accept = htmlAccept(request);
	if (accept === "invalid") {
		sendStaticStatus(response, 400, "Accept header is invalid.");
		return { handled: true };
	}
	if (accept === "reject") {
		sendStaticStatus(response, 406, "This route requires an HTML response.");
		return { handled: true };
	}
	sendAsset(request, response, bundle.entrypoint);
	return { handled: true };
}
