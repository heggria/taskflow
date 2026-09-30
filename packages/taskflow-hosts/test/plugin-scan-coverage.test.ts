import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyPluginScanCoverage } from "../../../scripts/verify-plugin-scan-coverage.mjs";

const enabled = { name: "taskflow / cisco-skill-scanner", status: "enabled", metadata: { policy: "balanced" } };
const report = (integrations: unknown[]) => ({ schema_version: "scan-result.v1", summary: { integrations } });

test("plugin scan coverage accepts completed deep scans and ignores unrelated MCP status", () => {
	assert.equal(verifyPluginScanCoverage(report([enabled, { name: "cisco-mcp-scanner", status: "skipped" }])), 1);
});

test("plugin scan coverage fails closed for missing, skipped, failed, or timed-out scans", () => {
	for (const status of ["unavailable", "skipped", "failed", "timed_out", undefined]) {
		assert.throws(() => verifyPluginScanCoverage(report([{ ...enabled, status }])), /deep scan must complete/);
	}
	for (const invalid of [{}, { schema_version: "scan-result.v1" }, report([]), report([{ name: "cisco-mcp-scanner", status: "enabled" }])]) {
		assert.throws(() => verifyPluginScanCoverage(invalid));
	}
	assert.throws(() => verifyPluginScanCoverage(report([enabled, { ...enabled, status: "failed" }])));
	assert.throws(() => verifyPluginScanCoverage(report([{ ...enabled, metadata: { policy: "permissive" } }])));
});
