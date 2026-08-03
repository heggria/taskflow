#!/usr/bin/env node

/**
 * Consumer smoke for the private CharterArc artifact without publishing it.
 *
 * Packs taskflow-core + taskflow-hosts + charterarc with pnpm (so workspace:* is
 * rewritten), installs those tarballs into a fresh npm project, then exercises
 * the public surface: defineProject and runProject against the installed dist,
 * including the Grok bootstrap wiring applications copy from the README.
 *
 * Packing runs from a disposable workspace with an isolated pnpm store so the
 * smoke never relinks the repository node_modules. CharterArc stays private —
 * it is not listed in RELEASE_PACKAGE_NAMES.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageNames = ["taskflow-core", "taskflow-hosts", "charterarc"];
const rootManifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const typeboxRange = rootManifest.devDependencies?.typebox;
assert.equal(typeof typeboxRange, "string", "root devDependencies must pin typebox for the CharterArc consumer");

const temporaryRoot = mkdtempSync(join(tmpdir(), "charterarc-packed-consumer-"));
const tarballDir = join(temporaryRoot, "tarballs");
const consumerDir = join(temporaryRoot, "consumer");
const npmCacheDir = join(temporaryRoot, "npm-cache");
const packWorkspaceDir = join(temporaryRoot, "workspace");
const pnpmStoreDir = join(temporaryRoot, "pnpm-store");
const consumerRequire = createRequire(join(consumerDir, "consumer.mjs"));

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: repo,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		...options,
	});
}

function preparePackWorkspace() {
	mkdirSync(join(packWorkspaceDir, "packages"), { recursive: true });
	writeFileSync(
		join(packWorkspaceDir, "package.json"),
		`${JSON.stringify({ name: "charterarc-pack-workspace", private: true }, null, 2)}\n`,
	);
	writeFileSync(join(packWorkspaceDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

	for (const name of packageNames) {
		const sourceDir = join(repo, "packages", name);
		const targetDir = join(packWorkspaceDir, "packages", name);
		cpSync(sourceDir, targetDir, {
			recursive: true,
			filter: (source) => {
				const base = source.slice(sourceDir.length);
				return !base.split(/[/\\]/).includes("node_modules");
			},
		});
	}

	// Resolve workspace:* and materialize publish-ready manifests without
	// touching the repository install graph or store.
	run(
		"pnpm",
		["install", "--ignore-scripts", "--no-frozen-lockfile"],
		{
			cwd: packWorkspaceDir,
			env: {
				...process.env,
				npm_config_store_dir: pnpmStoreDir,
			},
		},
	);
}

function packPackage(name) {
	const packageDir = join(packWorkspaceDir, "packages", name);
	const output = run(
		"pnpm",
		["pack", "--pack-destination", tarballDir, "--json"],
		{
			cwd: packageDir,
			env: {
				...process.env,
				npm_config_store_dir: pnpmStoreDir,
			},
		},
	);
	const parsed = JSON.parse(output);
	const result = Array.isArray(parsed) ? parsed[0] : parsed;
	if (!result?.filename) throw new Error(`pnpm pack did not return a filename for ${name}: ${output}`);
	// pnpm returns an absolute path under --pack-destination.
	return resolve(result.filename);
}

function packedManifest(name) {
	return JSON.parse(readFileSync(join(consumerDir, "node_modules", name, "package.json"), "utf8"));
}

async function importFromConsumer(specifier) {
	const entry = pathToFileURL(consumerRequire.resolve(specifier)).href;
	return import(entry);
}

try {
	mkdirSync(tarballDir, { recursive: true });
	mkdirSync(consumerDir, { recursive: true });
	mkdirSync(npmCacheDir, { recursive: true });
	preparePackWorkspace();

	const tarballs = packageNames.map((name) => packPackage(name));

	writeFileSync(
		join(consumerDir, "package.json"),
		`${JSON.stringify({ name: "charterarc-packed-consumer", private: true, type: "module" }, null, 2)}\n`,
	);
	run(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--cache",
			npmCacheDir,
			`typebox@${typeboxRange}`,
			...tarballs,
		],
		{ cwd: consumerDir },
	);

	for (const name of packageNames) {
		const manifest = packedManifest(name);
		assert.equal(manifest.version, rootManifest.version, `${name} installed at the wrong version`);
		for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
			assert.doesNotMatch(range, /^workspace:/, `${name} tarball leaked a workspace dependency`);
		}
		assert.equal(
			JSON.stringify(manifest.exports ?? {}).includes('"development"'),
			false,
			`${name} packed exports must not retain source-only development conditions`,
		);
	}

	const charterarc = await importFromConsumer("charterarc");
	assert.equal(typeof charterarc.defineProject, "function", "packed charterarc must export defineProject");
	assert.equal(typeof charterarc.runProject, "function", "packed charterarc must export runProject");

	const core = await importFromConsumer("taskflow-core");
	assert.equal(typeof core.discoverAgents, "function", "packed taskflow-core must export discoverAgents");
	const { grokSubagentRunner } = await importFromConsumer("taskflow-hosts/grok");
	assert.equal(typeof grokSubagentRunner.runTask, "function", "packed taskflow-hosts/grok must export grokSubagentRunner.runTask");
	assert.equal(
		typeof grokSubagentRunner.usageAccounting,
		"string",
		"packed grok runner must expose usageAccounting for cost evidence",
	);

	const maintenance = (name) => ({
		name,
		phases: [{
			id: "repair",
			type: "script",
			run: [process.execPath, "-e", "process.stdout.write('repaired')"],
			final: true,
		}],
	});

	// healthy Grok bootstrap must not start a model: inject the real runner
	// and agent discovery the README documents, but keep observe satisfied so
	// runProject returns without authorizing a maintenance Run.
	const project = charterarc.defineProject({
		desired: "packed consumer Grok bootstrap stays satisfied without a model call",
		observe: async () => ({ status: "satisfied", summary: "healthy Grok bootstrap" }),
		maintain: maintenance("packed-charterarc-grok-maintain"),
	});
	const outcome = await charterarc.runProject(project, {
		taskflow: {
			cwd: consumerDir,
			agents: core.discoverAgents(consumerDir, "both").agents,
			runTask: grokSubagentRunner.runTask,
			usageAccounting: grokSubagentRunner.usageAccounting,
		},
	});
	assert.equal(outcome.status, "satisfied");
	assert.equal(outcome.ok, true);
	assert.equal(outcome.before.status, "satisfied");
	assert.equal(outcome.run, undefined);

	const runtime = {
		taskflow: {
			cwd: consumerDir,
			agents: [],
		},
	};

	// Drift path: one ordinary Run, then re-observe.
	let observations = 0;
	const driftProject = charterarc.defineProject({
		desired: "packed consumer can repair confirmed drift",
		observe: async () => ({
			status: observations++ === 0 ? "drifted" : "satisfied",
			summary: observations === 1 ? "before repair" : "after repair",
		}),
		maintain: maintenance("packed-charterarc-repair"),
	});
	const driftOutcome = await charterarc.runProject(driftProject, runtime);
	assert.equal(driftOutcome.before.status, "drifted");
	assert.equal(driftOutcome.status, "satisfied");
	assert.equal(driftOutcome.ok, true);
	assert.equal(driftOutcome.run?.ok, true);
	assert.equal(driftOutcome.run?.finalOutput, "repaired");
	assert.equal(driftOutcome.after?.status, "satisfied");

	process.stdout.write("packed CharterArc consumer smoke passed: taskflow-core + taskflow-hosts + charterarc\n");
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
