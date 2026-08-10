#!/usr/bin/env node

/**
 * Build byte-for-byte reproducible npm tarballs from pnpm workspace packages.
 *
 * pnpm correctly rewrites `workspace:*`, but its rewritten dependency object is
 * populated asynchronously and can appear in different key orders. Because
 * package.json is stored verbatim, semantically identical `pnpm pack` calls can
 * produce different registry integrity hashes. We stage pnpm's publish-ready
 * content, canonicalize the manifest, then let npm create the final deterministic
 * tarball. The same bytes are smoked, published, and verified.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_PACKAGE_NAMES = [
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

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha512Integrity(data) {
	return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

function parsePackResult(output, cwd) {
	const parsed = JSON.parse(output);
	const result = Array.isArray(parsed) ? parsed[0] : parsed;
	if (!result?.filename) throw new Error(`pack did not return a filename: ${output}`);
	return resolve(cwd, result.filename);
}

function canonicalizeManifest(manifest) {
	const canonical = { ...manifest };
	// Do not recursively sort arbitrary manifest objects. In particular, key
	// order in conditional `exports` / `imports` is part of Node's resolution
	// semantics. pnpm's publish transform only introduces nondeterminism in the
	// asynchronously rewritten dependency maps, whose order is semantically inert.
	for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
		const value = canonical[field];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			canonical[field] = Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
		}
	}
	return canonical;
}

export function packDeterministicPackage(packageDir, destination) {
	const absolutePackageDir = resolve(packageDir);
	const absoluteDestination = resolve(destination);
	mkdirSync(absoluteDestination, { recursive: true });
	const temporaryRoot = mkdtempSync(join(tmpdir(), "taskflow-deterministic-pack-"));
	const pnpmDir = join(temporaryRoot, "pnpm");
	const stageDir = join(temporaryRoot, "stage");
	mkdirSync(pnpmDir);
	mkdirSync(stageDir);
	try {
		const pnpmOutput = execFileSync(
			"pnpm",
			["--dir", absolutePackageDir, "pack", "--pack-destination", pnpmDir, "--json"],
			{ cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
		);
		const stagedTarball = parsePackResult(pnpmOutput, pnpmDir);
		execFileSync("tar", ["-xzf", stagedTarball, "-C", stageDir], { stdio: "inherit" });
		const stagedPackage = join(stageDir, "package");
		const manifestPath = join(stagedPackage, "package.json");
		const manifest = canonicalizeManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		const npmOutput = execFileSync(
			"npm",
			["pack", stagedPackage, "--pack-destination", absoluteDestination, "--json", "--ignore-scripts"],
			{ cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
		);
		const filename = parsePackResult(npmOutput, absoluteDestination);
		const bytes = readFileSync(filename);
		return {
			name: manifest.name,
			version: manifest.version,
			packageDir: absolutePackageDir,
			filename,
			basename: basename(filename),
			integrity: sha512Integrity(bytes),
		};
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

export function packReleasePackages(destination, packageNames = RELEASE_PACKAGE_NAMES, verifyDeterminism = true) {
	const absoluteDestination = resolve(destination);
	rmSync(absoluteDestination, { recursive: true, force: true });
	mkdirSync(absoluteDestination, { recursive: true });
	const entries = [];
	for (const name of packageNames) {
		const packageDir = join(repo, "packages", name);
		const packed = packDeterministicPackage(packageDir, absoluteDestination);
		if (verifyDeterminism) {
			const verificationDir = mkdtempSync(join(tmpdir(), "taskflow-pack-repeat-"));
			try {
				const repeated = packDeterministicPackage(packageDir, verificationDir);
				if (repeated.integrity !== packed.integrity) {
					throw new Error(`${name} is not reproducible: ${packed.integrity} != ${repeated.integrity}`);
				}
			} finally {
				rmSync(verificationDir, { recursive: true, force: true });
			}
		}
		entries.push({
			name: packed.name,
			version: packed.version,
			packageDir: `packages/${name}`,
			filename: packed.basename,
			integrity: packed.integrity,
		});
	}
	const manifest = { schemaVersion: 1, entries };
	writeFileSync(join(absoluteDestination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

async function main() {
	const destination = resolve(process.argv[2] ?? join(repo, ".release-tarballs"));
	const names = process.argv.slice(3);
	const manifest = packReleasePackages(destination, names.length ? names : RELEASE_PACKAGE_NAMES);
	for (const entry of manifest.entries) {
		process.stdout.write(`${entry.name}@${entry.version} ${entry.filename} ${entry.integrity}\n`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
