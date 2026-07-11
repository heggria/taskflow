#!/usr/bin/env node

/**
 * Consumer smoke test for the exact tarballs that pnpm will publish.
 *
 * This deliberately does not import workspace sources. It packs all nine
 * packages, installs those tarballs into a fresh npm project, then exercises
 * every explicit public export and every shipped executable.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageNames = [
	"taskflow-core",
	"taskflow-mcp-core",
	"taskflow-hosts",
	"taskflow-dsl",
	"pi-taskflow",
	"codex-taskflow",
	"claude-taskflow",
	"opencode-taskflow",
	"grok-taskflow",
];
const rootManifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const peerNames = [
	"typebox",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];
const peerSpecs = peerNames.map((name) => {
	const range = rootManifest.devDependencies?.[name];
	assert.equal(typeof range, "string", `root devDependencies must pin the consumer peer ${name}`);
	return `${name}@${range}`;
});
const temporaryRoot = mkdtempSync(join(tmpdir(), "taskflow-packed-consumer-"));
const tarballDir = join(temporaryRoot, "tarballs");
const consumerDir = join(temporaryRoot, "consumer");
const consumerRequire = createRequire(join(consumerDir, "consumer.mjs"));

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: repo,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		...options,
	});
}

function packedManifest(name) {
	return JSON.parse(readFileSync(join(consumerDir, "node_modules", name, "package.json"), "utf8"));
}

async function importFromConsumer(specifier) {
	const entry = pathToFileURL(consumerRequire.resolve(specifier)).href;
	await import(entry);
}

function smokeMcpBin(binName) {
	const executable = join(consumerDir, "node_modules", ".bin", binName);
	const request = `${JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {} },
	})}\n`;
	const result = spawnSync(executable, [], {
		cwd: consumerDir,
		encoding: "utf8",
		input: request,
		timeout: 10_000,
	});
	assert.equal(result.error, undefined, `${binName} failed to start: ${result.error?.message ?? "unknown error"}`);
	assert.equal(result.status, 0, `${binName} exited ${result.status}: ${result.stderr}`);
	const responseLine = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	assert.ok(responseLine, `${binName} returned no initialize response`);
	const response = JSON.parse(responseLine);
	assert.equal(response.id, 1, `${binName} returned an unexpected response id`);
	assert.equal(response.result?.serverInfo?.name, "taskflow", `${binName} returned invalid server metadata`);
}

try {
	mkdirSync(tarballDir, { recursive: true });
	mkdirSync(consumerDir, { recursive: true });
	const tarballs = [];
	for (const name of packageNames) {
		const packageDir = join(repo, "packages", name);
		const packed = JSON.parse(run("pnpm", ["--dir", packageDir, "pack", "--pack-destination", tarballDir, "--json"]));
		assert.ok(packed.filename, `pnpm pack did not return a filename for ${name}`);
		tarballs.push(resolve(packed.filename));
	}

	writeFileSync(
		join(consumerDir, "package.json"),
		`${JSON.stringify({ name: "taskflow-packed-consumer", private: true, type: "module" }, null, 2)}\n`,
	);
	run(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			...peerSpecs,
			...tarballs,
		],
		{ cwd: consumerDir },
	);

	const expectedVersion = rootManifest.version;
	const lock = JSON.parse(readFileSync(join(consumerDir, "package-lock.json"), "utf8"));
	for (const name of packageNames) {
		const manifest = packedManifest(name);
		assert.equal(manifest.version, expectedVersion, `${name} installed at the wrong version`);
		for (const range of Object.values(manifest.dependencies ?? {})) {
			assert.doesNotMatch(range, /^workspace:/, `${name} tarball leaked a workspace dependency`);
		}
		const installedEntries = Object.entries(lock.packages ?? {}).filter(([location]) =>
			location === `node_modules/${name}` || location.endsWith(`/node_modules/${name}`),
		);
		assert.equal(installedEntries.length, 1, `${name} was installed more than once or is missing`);
		assert.match(installedEntries[0][1]?.resolved ?? "", /^file:/, `${name} did not resolve from a locally packed tarball`);
	}

	const publicImports = [
		"taskflow-core",
		"taskflow-mcp-core",
		"taskflow-mcp-core/server",
		"taskflow-mcp-core/jsonrpc",
		"taskflow-mcp-core/svg",
		"taskflow-hosts",
		"taskflow-hosts/codex",
		"taskflow-hosts/claude",
		"taskflow-hosts/opencode",
		"taskflow-hosts/grok",
		"taskflow-dsl",
		"taskflow-dsl/build",
		"taskflow-dsl/check",
		"taskflow-dsl/decompile",
		"taskflow-dsl/diagnostics",
		"pi-taskflow",
		"codex-taskflow",
		"codex-taskflow/mcp/server",
		"claude-taskflow",
		"claude-taskflow/mcp/server",
		"opencode-taskflow",
		"opencode-taskflow/mcp/server",
		"grok-taskflow",
		"grok-taskflow/mcp/server",
	];
	// detached-runner is a spawn-only public entry point and intentionally exits
	// when imported without its context-file argv; resolution proves it ships
	// without executing that process entry in the smoke-test process.
	consumerRequire.resolve("taskflow-core/detached-runner");
	for (const specifier of publicImports) await importFromConsumer(specifier);

	const dslVersion = run(join(consumerDir, "node_modules", ".bin", "taskflow-dsl"), ["--version"], {
		cwd: consumerDir,
	}).trim();
	assert.equal(dslVersion, expectedVersion, "taskflow-dsl executable reported the wrong version");
	for (const binName of ["codex-taskflow-mcp", "claude-taskflow-mcp", "opencode-taskflow-mcp", "grok-taskflow-mcp"]) {
		smokeMcpBin(binName);
	}

	process.stdout.write(`packed consumer smoke passed: ${packageNames.length} packages, ${publicImports.length} imports, 5 bins\n`);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
