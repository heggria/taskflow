#!/usr/bin/env node
/**
 * Real old/new packaged WebUI compatibility pair.
 *
 * Each root must be an independently built/installed tree containing:
 *   packages/taskflow-control/dist/index.js
 *   packages/taskflow-daemon/dist/web-gateway.js
 *   packages/taskflow-web/dist/app/taskflow-web-assets.json
 *
 * The harness intentionally cross-pairs code rather than replaying DTO files:
 * old browser assets → new gateway, then new browser assets → old gateway.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

function parseArgs(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const key = argv[index];
		if (!key?.startsWith("--")) {
			throw new Error(`Unexpected argument: ${key}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`Missing value for ${key}`);
		}
		values.set(key, value);
		index += 1;
	}
	const oldRoot = values.get("--old-root");
	const newRoot = values.get("--new-root");
	const output = values.get("--output");
	if (!oldRoot || !newRoot || !output) {
		throw new Error(
			"Usage: test-web-packaged-compatibility.mjs --old-root <built tree> --new-root <built tree> --output <report.json>",
		);
	}
	return {
		oldRoot: path.resolve(oldRoot),
		newRoot: path.resolve(newRoot),
		output: path.resolve(output),
	};
}

function resolveFile(root, candidates, label) {
	for (const candidate of candidates) {
		const file = path.join(root, candidate);
		if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
	}
	throw new Error(
		`${label} is missing from ${root}; checked ${candidates.join(", ")}`,
	);
}

function resolveBuild(root) {
	const controlModule = resolveFile(
		root,
		[
			"packages/taskflow-control/dist/index.js",
			"node_modules/taskflow-control/dist/index.js",
		],
		"taskflow-control dist",
	);
	const gatewayModule = resolveFile(
		root,
		[
			"packages/taskflow-daemon/dist/web-gateway.js",
			"node_modules/taskflow-daemon/dist/web-gateway.js",
		],
		"taskflow-daemon dist",
	);
	const manifestPath = resolveFile(
		root,
		[
			"packages/taskflow-web/dist/app/taskflow-web-assets.json",
			"node_modules/taskflow-web/dist/app/taskflow-web-assets.json",
		],
		"taskflow-web asset manifest",
	);
	const buildInfoPath = resolveFile(
		root,
		[
			"packages/taskflow-core/dist/build-info.json",
			"node_modules/taskflow-core/dist/build-info.json",
		],
		"taskflow-core build identity",
	);
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
	if (
		typeof buildInfo.gitCommit !== "string" ||
		!/^[0-9a-f]{40}$/iu.test(buildInfo.gitCommit)
	) {
		throw new Error(
			`taskflow-core build identity in ${buildInfoPath} does not contain a concrete git commit`,
		);
	}
	const staticRoot = path.dirname(manifestPath);
	return {
		root,
		controlModule,
		gatewayModule,
		manifestPath,
		manifest,
		staticRoot,
		identity: {
			gitCommit: buildInfo.gitCommit,
			buildTime:
				typeof buildInfo.buildTime === "number"
					? buildInfo.buildTime
					: null,
			packageVersion: manifest.packageVersion,
			manifestVersion: manifest.manifestVersion,
			manifestSha256: `sha256:${createHash("sha256")
				.update(fs.readFileSync(manifestPath))
				.digest("hex")}`,
			entrypointSha256: manifest.entrypoint?.sha256,
			projectedKeysetSha256:
				manifest.contentCatalogs?.projectedKeysetSha256,
			staticKeysetSha256:
				manifest.contentCatalogs?.staticKeysetSha256,
			combinedKeysetSha256:
				manifest.contentCatalogs?.keysetSha256,
		},
	};
}

async function runPair(serverBuild, clientBuild, label) {
	const control = await import(
		pathToFileURL(serverBuild.controlModule).href
	);
	const daemon = await import(
		pathToFileURL(serverBuild.gatewayModule).href
	);
	if (
		typeof control.createControlHost !== "function" ||
		typeof daemon.startWebGateway !== "function"
	) {
		throw new Error(
			`${label}: historical build does not expose the P17 gateway seam`,
		);
	}
	const tempRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "taskflow-web-compat-"),
	);
	const projectRoot = path.join(tempRoot, "project");
	const homeRoot = path.join(tempRoot, "home");
	fs.mkdirSync(projectRoot, { recursive: true });
	fs.mkdirSync(homeRoot, { recursive: true });
	const host = control.createControlHost({
		projectRoot,
		env: { ...process.env, TASKFLOW_HOME: homeRoot },
		controlMode: "standalone",
		skipSingleton: true,
	});
	let gateway;
	let browser;
	try {
		gateway = await daemon.startWebGateway({
			host,
			packageVersion: clientBuild.manifest.packageVersion,
			contentKeysetDigests: {
				projected:
					clientBuild.manifest.contentCatalogs
						.projectedKeysetSha256,
				static:
					clientBuild.manifest.contentCatalogs
						.staticKeysetSha256,
				combined:
					clientBuild.manifest.contentCatalogs
						.keysetSha256,
			},
			staticAssets: { root: clientBuild.staticRoot },
		});
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext();
		const page = await context.newPage();
		const pageErrors = [];
		const consoleErrors = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") {
				consoleErrors.push(message.text());
			}
		});
		const bootstrapResponsePromise = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname ===
				"/api/v1/bootstrap",
			{ timeout: 15_000 },
		);
		const navigation = await page.goto(gateway.launchUrl, {
			waitUntil: "domcontentloaded",
			timeout: 15_000,
		});
		const bootstrapResponse = await bootstrapResponsePromise;
		const bootstrapBody = await bootstrapResponse.json();
		await page.locator("#main-content h1").waitFor({
			state: "visible",
			timeout: 15_000,
		});
		const bodyText = await page.locator("body").innerText();
		const pass =
			(navigation?.status() ?? 0) === 200 &&
			bootstrapResponse.status() === 200 &&
			bootstrapBody?.ok === true &&
			bootstrapBody?.schemaVersion === "web.v1" &&
			bodyText.trim().length > 0 &&
			pageErrors.length === 0 &&
			consoleErrors.length === 0;
		return {
			label,
			pass,
			server: serverBuild.identity,
			client: clientBuild.identity,
			navigationStatus: navigation?.status() ?? 0,
			bootstrapStatus: bootstrapResponse.status(),
			bootstrapSchemaVersion:
				bootstrapBody?.schemaVersion ?? null,
			bootstrapPackageVersion:
				bootstrapBody?.data?.buildInfo
					?.packageVersion ?? null,
			pageErrorCount: pageErrors.length,
			consoleErrorCount: consoleErrors.length,
			pageErrors,
			consoleErrors,
		};
	} finally {
		await browser?.close();
		await gateway?.stop();
		host.close();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

const args = parseArgs(process.argv.slice(2));
const oldBuild = resolveBuild(args.oldRoot);
const newBuild = resolveBuild(args.newRoot);
if (
	oldBuild.identity.manifestSha256 ===
	newBuild.identity.manifestSha256
) {
	throw new Error(
		"old-root and new-root resolve to the same asset build; historical compatibility evidence requires distinct immutable builds",
	);
}
if (oldBuild.identity.gitCommit === newBuild.identity.gitCommit) {
	throw new Error(
		"old-root and new-root carry the same stamped git commit; historical compatibility evidence requires distinct immutable builds",
	);
}
const pairs = [
	await runPair(newBuild, oldBuild, "old-client/new-server"),
	await runPair(oldBuild, newBuild, "new-client/old-server"),
];
const report = {
	schemaVersion: 2,
	status: pairs.every((pair) => pair.pass) ? "pass" : "fail",
	measuredAt: new Date().toISOString(),
	runtime: {
		node: process.version,
		platform: process.platform,
		arch: process.arch,
	},
	builds: {
		old: oldBuild.identity,
		new: newBuild.identity,
	},
	pairs,
};
fs.mkdirSync(path.dirname(args.output), { recursive: true });
fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "pass") process.exitCode = 1;
