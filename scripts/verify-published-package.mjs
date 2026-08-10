#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packDeterministicPackage } from "./pack-release-packages.mjs";

const SLSA_V1 = "https://slsa.dev/provenance/v1";
const GITHUB_ACTIONS_BUILD = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";

export function sha512Integrity(data) {
	return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

function maintainerNames(maintainers) {
	if (!Array.isArray(maintainers)) return [];
	return maintainers
		.map((m) => (typeof m === "string" ? m.split(/[ <]/, 1)[0] : m && typeof m.name === "string" ? m.name : ""))
		.filter(Boolean);
}

function integrityHex(integrity) {
	const match = /^sha512-(.+)$/.exec(integrity);
	return match ? Buffer.from(match[1], "base64").toString("hex") : "";
}

export function verifyRegistryIdentity({
	pkg,
	metadata,
	provenanceStatement,
	localIntegrity,
	trustedOwners,
	expectedRepository,
	expectedRef,
	expectedSha,
}) {
	const errors = [];
	if (metadata?.name !== pkg.name || metadata?.version !== pkg.version) {
		errors.push(`registry identity is ${metadata?.name ?? "?"}@${metadata?.version ?? "?"}, expected ${pkg.name}@${pkg.version}`);
	}
	const owners = maintainerNames(metadata?.maintainers);
	if (!owners.some((owner) => trustedOwners.includes(owner))) {
		errors.push(`no trusted npm owner (${trustedOwners.join(", ")}) in registry maintainers: ${owners.join(", ") || "none"}`);
	}
	const remoteIntegrity = metadata?.dist?.integrity;
	if (typeof remoteIntegrity !== "string" || remoteIntegrity !== localIntegrity) {
		errors.push(`tarball integrity mismatch: registry=${remoteIntegrity ?? "missing"} local=${localIntegrity}`);
	}
	if (metadata?.dist?.attestations?.provenance?.predicateType !== SLSA_V1) {
		errors.push("registry metadata has no SLSA v1 provenance attestation");
	}
	if (!provenanceStatement || provenanceStatement.predicateType !== SLSA_V1) {
		errors.push("SLSA v1 provenance statement is missing or malformed");
		return errors;
	}
	const workflow = provenanceStatement.predicate?.buildDefinition?.externalParameters?.workflow;
	if (provenanceStatement.predicate?.buildDefinition?.buildType !== GITHUB_ACTIONS_BUILD) {
		errors.push("provenance was not produced by the GitHub Actions workflow build type");
	}
	if (workflow?.repository !== expectedRepository) errors.push(`provenance repository is ${workflow?.repository ?? "missing"}`);
	if (workflow?.path !== ".github/workflows/publish.yml") errors.push(`provenance workflow is ${workflow?.path ?? "missing"}`);
	if (workflow?.ref !== expectedRef) errors.push(`provenance ref is ${workflow?.ref ?? "missing"}, expected ${expectedRef}`);
	const subject = Array.isArray(provenanceStatement.subject)
		? provenanceStatement.subject.find((s) => s?.name === `pkg:npm/${pkg.name}@${pkg.version}`)
		: undefined;
	const expectedDigest = integrityHex(localIntegrity);
	if (!subject || subject.digest?.sha512 !== expectedDigest) errors.push("provenance subject digest does not match the local tarball");
	if (expectedSha) {
		const dependencies = provenanceStatement.predicate?.buildDefinition?.resolvedDependencies;
		const commit = Array.isArray(dependencies) ? dependencies.find((d) => d?.digest?.gitCommit)?.digest?.gitCommit : undefined;
		if (commit !== expectedSha) errors.push(`provenance commit is ${commit ?? "missing"}, expected ${expectedSha}`);
	}
	return errors;
}

function packIntegrity(packageDir, suppliedTarball) {
	if (suppliedTarball) return sha512Integrity(readFileSync(suppliedTarball));
	const destination = mkdtempSync(join(tmpdir(), "taskflow-pack-verify-"));
	try {
		const packed = packDeterministicPackage(packageDir, destination);
		return packed.integrity;
	} finally {
		rmSync(destination, { recursive: true, force: true });
	}
}

async function fetchProvenanceStatement(url) {
	if (!url) throw new Error("registry did not provide an attestation URL");
	const response = await fetch(url);
	if (!response.ok) throw new Error(`attestation fetch failed: HTTP ${response.status}`);
	const body = await response.json();
	const attestation = body?.attestations?.find((entry) => entry?.predicateType === SLSA_V1);
	const payload = attestation?.bundle?.dsseEnvelope?.payload;
	if (typeof payload !== "string") throw new Error("SLSA provenance bundle has no DSSE payload");
	return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

async function main() {
	const packageDir = resolve(process.argv[2] ?? "");
	if (!process.argv[2]) throw new Error("usage: verify-published-package.mjs <package-dir>");
	const tarball = process.argv[3] ? resolve(process.argv[3]) : undefined;
	const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const spec = `${pkg.name}@${pkg.version}`;
	const metadata = JSON.parse(execFileSync("npm", ["view", spec, "--json"], { encoding: "utf8" }));
	const localIntegrity = packIntegrity(packageDir, tarball);
	const provenanceStatement = await fetchProvenanceStatement(metadata?.dist?.attestations?.url);
	const trustedOwners = (process.env.NPM_TRUSTED_OWNERS ?? "heggria,muyun")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
	const expectedRepository = process.env.PUBLISH_REPOSITORY_URL ?? "https://github.com/heggria/taskflow";
	const expectedRef = `refs/tags/v${pkg.version}`;
	const errors = verifyRegistryIdentity({
		pkg,
		metadata,
		provenanceStatement,
		localIntegrity,
		trustedOwners,
		expectedRepository,
		expectedRef,
		expectedSha: process.env.GITHUB_SHA,
	});
	if (errors.length) throw new Error(`${spec} failed published-package verification:\n- ${errors.join("\n- ")}`);
	process.stdout.write(`verified ${spec}: owner + provenance + integrity (${basename(packageDir)})\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
