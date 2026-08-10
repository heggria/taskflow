/**
 * P1–P17 ADR presence gate (core plus provisional browser protocol baseline).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const adrDir = join(repoRoot, "docs", "internal", "p-adrs");

const REQUIRED = [
	"P1-policy-overlay.md",
	"P2-empty-policy-exposure.md",
	"P3-domain-registry-identity.md",
	"P4-negotiation-errors.md",
	"P5-phase-feature-matrix.md",
	"P6-canonical-hash-refs.md",
	"P7-dynamic-paths-dual-hashes.md",
	"P8-enforcement-capabilities.md",
	"P9-legacy-conflict.md",
	"P10-rollback-tiers.md",
	"P11-compaction-cursor.md",
	"P12-command-batch-reauth.md",
	"P13-bootstrap-singleton.md",
	"P14-controlstore-engine.md",
	"P15-approval-protocol.md",
	"P16-coordinator-concurrency.md",
	"P17-browser-protocol.md",
];

test("P1–P17 ADR documents all exist", () => {
	assert.ok(existsSync(adrDir), `missing ${adrDir}`);
	const files = new Set(readdirSync(adrDir));
	for (const f of REQUIRED) {
		assert.ok(files.has(f), `missing ADR ${f}`);
		const body = readFileSync(join(adrDir, f), "utf-8");
		if (f === "P17-browser-protocol.md") {
			assert.match(body, /> Status: \*\*Provisional\*\*/, "P17 must not claim wire freeze");
		} else {
			assert.match(body, /> Status: \*\*Accepted\*\*/, `${f} should be Accepted`);
		}
		assert.ok(body.length > 200, `${f} too short`);
	}
	assert.equal(REQUIRED.length, 17);
});

test("no DomainTransfer API in taskflow-control public surface", () => {
	const idx = readFileSync(
		join(repoRoot, "packages", "taskflow-control", "src", "index.ts"),
		"utf-8",
	);
	assert.ok(!idx.toLowerCase().includes("domaintransfer"));
});
