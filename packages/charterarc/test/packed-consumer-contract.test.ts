import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function read(relativePath: string): Promise<string> {
	return readFile(path.join(repo, relativePath), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("packed consumer: verify the private CharterArc artifact without publishing it", async () => {
	const packageManifest: unknown = JSON.parse(await read("packages/charterarc/package.json"));
	assert.equal(
		isRecord(packageManifest) &&
			"private" in packageManifest &&
			packageManifest.private,
		true,
		"the experiment must stay private until its public contract is deliberately released",
	);

	const rootManifest: unknown = JSON.parse(await read("package.json"));
	assert.equal(isRecord(rootManifest), true);
	const scripts = isRecord(rootManifest) && isRecord(rootManifest.scripts)
		? rootManifest.scripts
		: null;
	assert.notEqual(scripts, null);
	assert.match(
		String(scripts?.["test:pack-charterarc"] ?? ""),
		/smoke-packed-charterarc\.mjs/,
		"the packed CharterArc consumer must be directly runnable",
	);

	const ci = await read(".github/workflows/ci.yml");
	assert.match(ci, /pnpm run test:pack-charterarc/);

	const smoke = await read("scripts/smoke-packed-charterarc.mjs");
	assert.match(smoke, /["']taskflow-core["']/);
	assert.match(smoke, /["']charterarc["']/);
	assert.match(smoke, /\bnpm\b[\s\S]*\binstall\b/);
	assert.match(smoke, /\bdefineProject\b/);
	assert.match(smoke, /\brunProject\b/);
	assert.match(
		smoke,
		/const packWorkspaceDir = join\(temporaryRoot, "workspace"\)/,
		"pnpm pack must run from a disposable workspace instead of relinking repository node_modules",
	);
	assert.match(
		smoke,
		/const pnpmStoreDir = join\(temporaryRoot, "pnpm-store"\)/,
		"the packed smoke must keep pnpm's generated store inside its disposable temp root",
	);
	assert.match(smoke, /npm_config_store_dir:\s*pnpmStoreDir/);
	assert.doesNotMatch(
		smoke,
		/\["--dir", packageDir, "--store-dir"/,
		"pnpm pack does not accept --store-dir and must not point a fresh store at repository node_modules",
	);

	const releasePacker = await read("scripts/pack-release-packages.mjs");
	const releaseNamesSource =
		/export const RELEASE_PACKAGE_NAMES = \[([\s\S]*?)\];/.exec(releasePacker)?.[1] ?? "";
	const releaseNames = [...releaseNamesSource.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
	assert.equal(
		releaseNames.includes("charterarc"),
		false,
		"packed-consumer evidence must not silently turn the private experiment into a public release",
	);
});
