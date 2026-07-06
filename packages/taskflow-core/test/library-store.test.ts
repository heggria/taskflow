/**
 * Library store persistence: sidecar readMeta/writeMeta, listFlows A1 filter
 * fix (sidecar must NOT appear as a candidate flow), bumpReuseInSidecar.
 * Refs: docs/rfc-library-reuse.md §3.1, §八 (A1 fix).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Taskflow } from "../src/schema.ts";
import {
	bumpReuseInSidecar,
	listFlows,
	readMeta,
	saveFlow,
	saveFlowWithMeta,
	sidecarPathFor,
} from "../src/store.ts";
import { deriveMeta } from "../src/library/meta.ts";

function makeTmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-lib-store-"));
	fs.mkdirSync(path.join(tmp, ".pi", "taskflows"), { recursive: true });
	return tmp;
}

const sampleDef: Taskflow = {
	name: "audit-endpoints",
	description: "audit",
	args: { dir: { default: "src/routes" } },
	phases: [
		{ id: "d", type: "agent", agent: "scout", task: "List {args.dir}", output: "json" },
		{ id: "r", type: "reduce", from: ["d"], agent: "writer", task: "{steps.d.output}", dependsOn: ["d"], final: true },
	],
} as Taskflow;

test("saveFlowWithMeta: writes flow + sidecar, readMeta recovers it", () => {
	const cwd = makeTmpCwd();
	try {
		const meta = deriveMeta(sampleDef, { purpose: "审计鉴权", tags: ["audit", "auth"] });
		const { filePath, metaPath } = saveFlowWithMeta(cwd, sampleDef, meta);
		assert.ok(fs.existsSync(filePath));
		assert.ok(fs.existsSync(metaPath));
		assert.equal(path.basename(metaPath), "audit-endpoints.meta.json");
		const back = readMeta(cwd, "audit-endpoints");
		assert.equal(back?.purpose, "审计鉴权");
		assert.deepEqual(back?.tags, ["audit", "auth"]);
		assert.equal(back?.phaseSignature, "agent→reduce");
		assert.equal(back?.reuseCount, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("A1 fix: listFlows excludes .meta.json sidecar (no ghost flow)", () => {
	const cwd = makeTmpCwd();
	try {
		// Save via the new path (writes both flow + sidecar).
		saveFlowWithMeta(cwd, sampleDef, deriveMeta(sampleDef, {}));
		const flows = listFlows(cwd);
		const names = flows.map((f) => f.name);
		// listFlows also scans the user-global dir, so don't assume a total count;
		// just assert our flow appears exactly once and nothing sidecar-derived appears.
		assert.ok(names.includes("audit-endpoints"));
		assert.equal(names.filter((n) => n === "audit-endpoints").length, 1);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("A1 regression guard: a sidecar that looks flow-like (has a name field) is still excluded", () => {
	const cwd = makeTmpCwd();
	try {
		// Manually drop a .meta.json that has a `name` field (which readFlowFile would accept).
		// The listFlows filter must reject it by suffix BEFORE readFlowFile runs.
		saveFlowWithMeta(cwd, sampleDef, deriveMeta(sampleDef, {}));
		const metaPath = sidecarPathFor(cwd, "audit-endpoints");
		const malicious = JSON.stringify({ ...readMeta(cwd, "audit-endpoints"), name: "ghost-xyz" }, null, 2);
		fs.writeFileSync(metaPath, malicious, "utf-8");
		const flows = listFlows(cwd);
		const names = flows.map((f) => f.name);
		// The ghost must NOT appear anywhere (project nor user scope).
		assert.ok(!names.includes("ghost-xyz"), "sidecar with a name field must not become a ghost flow");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("readMeta: returns null for missing flow", () => {
	const cwd = makeTmpCwd();
	try {
		assert.equal(readMeta(cwd, "does-not-exist"), null);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("bumpReuseInSidecar: increments reuseCount + lastUsedAt, idempotent under re-bump", () => {
	const cwd = makeTmpCwd();
	try {
		saveFlowWithMeta(cwd, sampleDef, deriveMeta(sampleDef, {}));
		assert.equal(readMeta(cwd, "audit-endpoints")?.reuseCount, 0);
		assert.equal(readMeta(cwd, "audit-endpoints")?.lastUsedAt, null);

		const n1 = bumpReuseInSidecar(cwd, "audit-endpoints");
		assert.equal(n1, 1);
		const after1 = readMeta(cwd, "audit-endpoints");
		assert.equal(after1?.reuseCount, 1);
		assert.ok((after1?.lastUsedAt ?? 0) > 0);

		const n2 = bumpReuseInSidecar(cwd, "audit-endpoints");
		assert.equal(n2, 2);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("bumpReuseInSidecar: returns null when the flow itself doesn't exist", () => {
	const cwd = makeTmpCwd();
	try {
		assert.equal(bumpReuseInSidecar(cwd, "nope"), null);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("bumpReuseInSidecar: creates a minimal sidecar if save used the legacy saveFlow (no sidecar yet)", () => {
	const cwd = makeTmpCwd();
	try {
		// legacy save (no sidecar) — backward compat
		saveFlow(cwd, sampleDef, "project");
		assert.equal(readMeta(cwd, "audit-endpoints"), null);
		const n = bumpReuseInSidecar(cwd, "audit-endpoints");
		assert.equal(n, 1);
		const m = readMeta(cwd, "audit-endpoints");
		assert.equal(m?.reuseCount, 1);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
