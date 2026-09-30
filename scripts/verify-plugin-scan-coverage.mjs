#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The scanner's severity/score gate does not fail closed when an optional
// integration is missing. Require evidence that every reported skill scanner
// actually ran; its findings remain subject to the original high/80 gates.
export function verifyPluginScanCoverage(report) {
	assert.equal(report?.schema_version, "scan-result.v1", "unsupported scanner report schema");
	assert.ok(Array.isArray(report.summary?.integrations), "scanner report must contain integrations");
	const skills = report.summary.integrations.filter((integration) =>
		typeof integration?.name === "string" && integration.name.includes("cisco-skill-scanner"));
	assert.ok(skills.length > 0, "scanner report is missing Cisco skill-scan coverage");
	for (const integration of skills) {
		assert.equal(integration.status, "enabled", `${integration.name}: deep scan must complete (${integration.message ?? integration.status})`);
		assert.equal(integration.metadata?.policy, "balanced", `${integration.name}: unexpected scan policy`);
	}
	return skills.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	assert.ok(process.argv[2], "usage: verify-plugin-scan-coverage.mjs <report.json>");
	const count = verifyPluginScanCoverage(JSON.parse(readFileSync(process.argv[2], "utf8")));
	console.log(`Verified completed Cisco deep scanning for ${count} integration(s).`);
}
