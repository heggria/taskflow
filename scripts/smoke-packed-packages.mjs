#!/usr/bin/env node

/**
 * Consumer smoke test for the exact deterministic tarballs npm will publish.
 *
 * This deliberately does not import workspace sources. It packs all nine
 * packages, installs those tarballs into a fresh npm project, then exercises
 * every explicit public export and every shipped executable.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packReleasePackages } from "./pack-release-packages.mjs";

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
	return import(entry);
}

async function smokeWildcardExports(packageName, excludedImports = new Set()) {
	const packageRoot = resolve(dirname(consumerRequire.resolve(packageName)), "..");
	const manifest = packedManifest(packageName);
	if (!Object.keys(manifest.exports ?? {}).some((key) => key.includes("*"))) return 0;
	let count = 0;
	for (const relative of globSync("dist/**/*.js", { cwd: packageRoot })) {
		const subpath = relative.slice("dist/".length, -".js".length);
		if (subpath.startsWith("resources/") && manifest.exports?.["./resources/*"] === null) continue;
		const specifier = `${packageName}/${subpath}`;
		consumerRequire.resolve(specifier);
		if (!excludedImports.has(specifier)) await importFromConsumer(specifier);
		count += 1;
	}
	return count;
}

function smokeMcpBin(binName, expectedServerName) {
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
	assert.equal(response.result?.serverInfo?.name, expectedServerName, `${binName} returned invalid server metadata`);
}

try {
	mkdirSync(tarballDir, { recursive: true });
	mkdirSync(consumerDir, { recursive: true });
	const suppliedTarballDir = process.argv[2] ? resolve(process.argv[2]) : undefined;
	const releaseTarballDir = suppliedTarballDir ?? tarballDir;
	const releaseManifest = suppliedTarballDir
		? JSON.parse(readFileSync(join(releaseTarballDir, "manifest.json"), "utf8"))
		: packReleasePackages(releaseTarballDir, packageNames);
	assert.deepEqual(
		releaseManifest.entries.map((entry) => entry.name),
		packageNames,
		"release tarball manifest must contain all packages in publish order",
	);
	const tarballs = releaseManifest.entries.map((entry) => resolve(releaseTarballDir, entry.filename));

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
		for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
			assert.doesNotMatch(range, /^workspace:/, `${name} tarball leaked a workspace dependency`);
			if (packageNames.includes(dependency)) {
				assert.equal(range, expectedVersion, `${name} must pin internal dependency ${dependency} exactly`);
			}
		}
		assert.equal(
			JSON.stringify(manifest.exports ?? {}).includes('"development"'),
			false,
			`${name} published exports must not retain source-only development conditions`,
		);
		for (const target of exportTargets(manifest.exports, "types")) {
			assertExportTargetShips(name, target, "TypeScript declaration");
		}
		for (const target of exportTargets(manifest.exports, "default")) {
			assertExportTargetShips(name, target, "runtime export");
		}
		const installedEntries = Object.entries(lock.packages ?? {}).filter(([location]) =>
			location === `node_modules/${name}` || location.endsWith(`/node_modules/${name}`),
		);
		assert.equal(installedEntries.length, 1, `${name} was installed more than once or is missing`);
		assert.match(installedEntries[0][1]?.resolved ?? "", /^file:/, `${name} did not resolve from a locally packed tarball`);
	}
	const packedCore = await importFromConsumer("taskflow-core");
	const buildInfo = packedCore.getBuildInfo();
	assert.equal(buildInfo.packageVersion, expectedVersion, "packed taskflow-core reported the wrong package version");
	assert.match(buildInfo.gitCommit, /^[0-9a-f]{40}$/i, "packed taskflow-core must ship a concrete build commit");
	assert.equal(Number.isInteger(buildInfo.schemaVersion), true, "packed taskflow-core must report an integer schema version");
	assert.equal(
		typeof buildInfo.buildTime === "number" && Number.isFinite(buildInfo.buildTime),
		true,
		"packed taskflow-core must ship a finite build timestamp",
	);
	const piRunnerPath = join(consumerDir, "node_modules", "pi-taskflow", "dist", "runner.js");
	const piRunner = await import(pathToFileURL(piRunnerPath).href);
	const contextExtension = piRunner.ctxExtensionPath();
	assert.equal(typeof contextExtension, "string", "packed pi-taskflow must resolve its Shared Context Tree extension");
	assert.equal(
		contextExtension,
		realpathSync(join(consumerDir, "node_modules", "pi-taskflow", "dist", "index.js")),
		"packed pi-taskflow must explicitly load dist/index.js under --no-extensions",
	);
	const fakePi = join(temporaryRoot, "fake-pi.mjs");
	const fakePiCapture = join(temporaryRoot, "fake-pi-argv.json");
	const sharedContextDir = join(temporaryRoot, "shared-context");
	mkdirSync(sharedContextDir);
	writeFileSync(
		fakePi,
		`#!${process.execPath}\n` +
			`import fs from "node:fs";\n` +
			`fs.writeFileSync(${JSON.stringify(fakePiCapture)}, JSON.stringify({argv:process.argv.slice(2),ctxDir:process.env.PI_TASKFLOW_CTX_DIR,nodeId:process.env.PI_TASKFLOW_NODE_ID}));\n` +
			`const emit=value=>process.stdout.write(JSON.stringify(value)+"\\n");\n` +
			`emit({type:"agent_start"}); emit({type:"turn_start"});\n` +
			`emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"PACKED_CTX_OK"}],stopReason:"stop"}});\n` +
			`emit({type:"agent_end"});\n`,
	);
	chmodSync(fakePi, 0o755);
	const previousPiBin = process.env.PI_TASKFLOW_PI_BIN;
	try {
		process.env.PI_TASKFLOW_PI_BIN = fakePi;
		const packedPiResult = await piRunner.runAgentTask(
			consumerDir,
			[{ name: "packed", description: "packed", systemPrompt: "", source: "user", filePath: "" }],
			"packed",
			"shared context smoke",
			{ ctxDir: sharedContextDir, nodeId: "root", idleTimeoutMs: 5_000 },
			undefined,
			{ resourceProfile: "isolated", extensions: [], terminalGraceMs: 50 },
		);
		assert.equal(packedPiResult.exitCode, 0, `packed Pi Shared Context run failed: ${packedPiResult.stderr}`);
		assert.equal(packedPiResult.output, "PACKED_CTX_OK");
		const captured = JSON.parse(readFileSync(fakePiCapture, "utf8"));
		assert.equal(captured.ctxDir, sharedContextDir);
		assert.equal(captured.nodeId, "root");
		assert.ok(captured.argv.includes("--no-extensions"));
		const extensionValues = captured.argv.flatMap((entry, index) => entry === "--extension" ? [captured.argv[index + 1]] : []);
		assert.deepEqual(extensionValues, [contextExtension], "packed Shared Context must load only its installed dist extension");
	} finally {
		if (previousPiBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = previousPiBin;
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
	assert.throws(
		() => consumerRequire.resolve("taskflow-core/resources/index"),
		/PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/,
		"unfinished Workspace Capability internals must not become a root-package compatibility promise",
	);
	for (const specifier of publicImports) await importFromConsumer(specifier);
	const wildcardExports =
		await smokeWildcardExports("taskflow-core", new Set(["taskflow-core/detached-runner"])) +
		await smokeWildcardExports("taskflow-hosts");

	const dslVersion = run(join(consumerDir, "node_modules", ".bin", "taskflow-dsl"), ["--version"], {
		cwd: consumerDir,
	}).trim();
	assert.equal(dslVersion, expectedVersion, "taskflow-dsl executable reported the wrong version");
	writeFileSync(join(consumerDir, "types-smoke.ts"), `${publicImports.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n")}\n`);
	run(
		join(consumerDir, "node_modules", ".bin", "tsc"),
		["--noEmit", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "types-smoke.ts"],
		{ cwd: consumerDir },
	);
	for (const required of [
		"plugin/opencode.json",
		"plugin/skills/taskflow/SKILL.md",
		"plugin/assets/taskflow.svg",
	]) {
		assert.ok(
			readFileSync(join(consumerDir, "node_modules", "opencode-taskflow", required), "utf8").length > 0,
			`opencode-taskflow tarball is missing ${required}`,
		);
	}
	for (const [binName, serverName] of [
		["codex-taskflow-mcp", "taskflow-codex"],
		["claude-taskflow-mcp", "taskflow-claude"],
		["opencode-taskflow-mcp", "taskflow-opencode"],
		["grok-taskflow-mcp", "taskflow-grok"],
	]) {
		smokeMcpBin(binName, serverName);
	}

	process.stdout.write(
		`packed consumer smoke passed: ${packageNames.length} packages, ${publicImports.length} explicit imports, ${wildcardExports} wildcard exports, 5 bins\n`,
	);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}

function exportTargets(exportsValue, condition) {
	const targets = [];
	for (const entry of Object.values(exportsValue ?? {})) {
		if (entry && typeof entry === "object" && typeof entry[condition] === "string") targets.push(entry[condition]);
	}
	return targets;
}

function assertExportTargetShips(packageName, target, label) {
	const packageRoot = join(consumerDir, "node_modules", packageName);
	if (target.includes("*")) {
		const pattern = target.replace(/^\.\//, "").replaceAll("*", "**/*");
		assert.ok(globSync(pattern, { cwd: packageRoot }).length > 0, `${packageName} ${label} pattern ships no files: ${target}`);
		return;
	}
	assert.ok(readFileSync(join(packageRoot, target), "utf8").length >= 0, `${packageName} is missing ${label}: ${target}`);
}
