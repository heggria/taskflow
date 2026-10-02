#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { STABLE_PACKAGE_NAMES, releaseNpmTag } from "./verify-release-contract.mjs";

function queryRegistryTags(name) {
	const stdout = execFileSync("npm", ["view", name, "dist-tags", "--json", "--registry=https://registry.npmjs.org/"], {
		encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(stdout);
}

/** Read every package's channel. Never mutate tags or accept another channel. */
export function verifyReleaseDistTags(version, npmTag, queryTags = queryRegistryTags) {
	assert.equal(npmTag, releaseNpmTag(version), "release version/channel mismatch");
	const errors = [];
	const verified = [];
	for (const name of STABLE_PACKAGE_NAMES) {
		let tags;
		try { tags = queryTags(name); } catch {
			errors.push(`${name}: unable to read npm dist-tags`);
			continue;
		}
		if (tags === null || typeof tags !== "object" || Array.isArray(tags) || !Object.hasOwn(tags, npmTag)) {
			errors.push(`${name}: missing or malformed npm ${npmTag} dist-tag`);
		} else if (tags[npmTag] !== version) {
			errors.push(`${name}: npm ${npmTag} must equal ${version}`);
		} else {
			verified.push(name);
		}
	}
	assert.equal(errors.length, 0, `Release dist-tag verification failed:\n${errors.join("\n")}`);
	return { version, npmTag, verified };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const result = verifyReleaseDistTags(process.argv[2], process.argv[3]);
		process.stdout.write(`Release dist-tags PASS: ${result.verified.length} packages, ${result.npmTag}=${result.version}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
