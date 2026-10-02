#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STABLE_PACKAGE_NAMES = [
	"taskflow-core", "taskflow-mcp-core", "taskflow-hosts", "taskflow-dsl",
	"pi-taskflow", "codex-taskflow", "claude-taskflow", "opencode-taskflow",
	"grok-taskflow", "hermes-taskflow",
];

/** Stable versions publish to latest; only numbered beta prereleases are admitted. */
export function releaseNpmTag(version) {
	assert.match(version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta(?:\.(?:0|[1-9]\d*))+)?$/, "release version must be stable semver or a numbered beta");
	return version.includes("-") ? "beta" : "latest";
}

/** Verify the prepared source contract before any release registry mutation. */
export function verifyReleaseContract(repo, { published = false } = {}) {
	const readJson = (path) => JSON.parse(readFileSync(resolve(repo, path), "utf8"));
	const root = readJson("package.json");
	const version = root.version;
	const npmTag = releaseNpmTag(version);
	assert.equal(root.private, true, "monorepo root must remain private");
	for (const name of STABLE_PACKAGE_NAMES) {
		const manifest = readJson(`packages/${name}/package.json`);
		assert.equal(manifest.name, name, `${name}: package identity mismatch`);
		assert.equal(manifest.version, version, `${name}: release version mismatch`);
		assert.notEqual(manifest.private, true, `${name}: release package is private`);
		assert.equal(manifest.publishConfig?.access, "public", `${name}: public access required`);
		for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
			for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
				assert.ok(!["taskflow-control", "charterarc"].includes(dependency), `${name}: experimental dependency ${dependency} leaked into stable package`);
				if (STABLE_PACKAGE_NAMES.includes(dependency)) assert.equal(range, "workspace:*", `${name}: ${dependency} must use workspace:* before packing`);
			}
		}
	}
	for (const host of ["codex", "claude", "grok"]) {
		assert.equal(readJson(`packages/${host}-taskflow/plugin/.${host}-plugin/plugin.json`).version, version, `${host}: plugin version mismatch`);
		const args = readJson(`packages/${host}-taskflow/plugin/.mcp.json`).mcpServers.taskflow.args;
		assert.equal(args.filter((arg) => arg.startsWith(`${host}-taskflow@`)).join(), `${host}-taskflow@${version}`, `${host}: MCP pin mismatch`);
	}
	const opencodeArgs = readJson("packages/opencode-taskflow/plugin/opencode.json").mcp.taskflow.command;
	assert.equal(opencodeArgs.filter((arg) => arg.startsWith("opencode-taskflow@")).join(), `opencode-taskflow@${version}`, "opencode: MCP pin mismatch");
	const hermes = readFileSync(resolve(repo, "packages/hermes-taskflow/plugin/hermes.config.snippet.yaml"), "utf8");
	const hermesPins = hermes.match(/hermes-taskflow@[^"\s,\]]+/g) ?? [];
	assert.deepEqual(hermesPins, [`hermes-taskflow@${version}`], "hermes: MCP pin mismatch");
	assert.equal(readJson("packages/taskflow-control/package.json").private, true, "experimental taskflow-control must remain private");
	const charterarc = readJson("packages/charterarc/package.json");
	assert.match(charterarc.version, /-experimental\./, "CharterArc must retain a separate experimental version");
	assert.equal(charterarc.publishConfig?.tag, "experimental", "CharterArc must retain its experimental channel");
	const changelog = readFileSync(resolve(repo, "CHANGELOG.md"), "utf8");
	const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const date = published ? "[0-9]{4}-[0-9]{2}-[0-9]{2}" : "(?:Unreleased|[0-9]{4}-[0-9]{2}-[0-9]{2})";
	const heading = changelog.match(new RegExp(`^## \\[${escapedVersion}\\] — (${date})$`, "m"));
	assert.ok(heading, `${version}: ${published ? "dated" : "candidate"} changelog heading required`);
	const releaseDate = heading[1];
	if (releaseDate !== "Unreleased") {
		// Date.parse can normalize February 30 into March. Round-trip to reject
		// normalization, invalid months/days and invalid leap-year dates.
		const timestamp = Date.parse(`${releaseDate}T00:00:00.000Z`);
		assert.ok(Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === releaseDate,
			`${version}: changelog date must be a real calendar date (got ${releaseDate})`);
	}
	return { version, packages: [...STABLE_PACKAGE_NAMES], npmTag };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const rootArg = process.argv.indexOf("--root");
		const repo = rootArg < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), "..") : resolve(process.argv[rootArg + 1]);
		const result = verifyReleaseContract(repo, { published: process.argv.includes("--published") });
		process.stdout.write(`Release contract PASS: ${result.packages.length} packages @ ${result.version}, npm ${result.npmTag}${process.argv.includes("--published") ? ", dated changelog" : ", candidate validation only"}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
