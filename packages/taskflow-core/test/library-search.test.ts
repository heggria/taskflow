/**
 * Library search ranking: levenshtein, structScore, textScore, cosine,
 * staleness resolution, searchLibrary (structural mode). Phase 1 has no
 * embedder, so all tests exercise the structural/keyword fallback.
 * Refs: docs/rfc-library-reuse.md §5.2, §5.2.1, §5.2.2.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Taskflow } from "../src/schema.ts";
import { saveFlowWithMeta } from "../src/store.ts";
import { deriveMeta } from "../src/library/meta.ts";
import { cosine, levenshtein, resolveCandidate, searchLibrary } from "../src/library/search.ts";
import type { LibraryDeps } from "../src/library/types.ts";

function makeTmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-lib-search-"));
	fs.mkdirSync(path.join(tmp, ".pi", "taskflows"), { recursive: true });
	return tmp;
}

// ---------------------------------------------------------------------------
// levenshtein (§5.2.1)
// ---------------------------------------------------------------------------

test("levenshtein: basics", () => {
	assert.equal(levenshtein("", ""), 0);
	assert.equal(levenshtein("abc", "abc"), 0);
	assert.equal(levenshtein("abc", "abd"), 1);
	assert.equal(levenshtein("agent→map→reduce", "agent→map→reduce"), 0);
	// appending "→gate" costs 5 chars (the arrow is multi-code-unit but length tracks JS string length)
	assert.equal(levenshtein("agent→map", "agent→map→gate"), 5);
});

// ---------------------------------------------------------------------------
// cosine (§4.1)
// ---------------------------------------------------------------------------

test("cosine: identical vectors → 1", () => {
	assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});
test("cosine: orthogonal → 0", () => {
	assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});
test("cosine: handles non-normalized input", () => {
	// [1,1] and [2,2] point the same direction → 1.0
	assert.ok(Math.abs(cosine([1, 1], [2, 2]) - 1) < 1e-9);
});
test("cosine: NaN/Infinity values skipped (graceful)", () => {
	const c = cosine([1, NaN, 2], [1, 1, 2]);
	assert.ok(Number.isFinite(c));
});

// ---------------------------------------------------------------------------
// resolveCandidate staleness (§5.2.2)
// ---------------------------------------------------------------------------

test("resolveCandidate: no sidecar → embedding null, structural fields live-derived", () => {
	const def: Taskflow = {
		name: "x",
		phases: [{ id: "a", type: "agent", task: "{args.x}" }],
		args: { x: { default: "1" } },
	} as Taskflow;
	const c = resolveCandidate(def, "project", "x", null);
	assert.equal(c.embedding, null);
	assert.equal(c.embeddingStale, true);
	assert.equal(c.phaseSignature, "agent");
	assert.equal(c.reuseCount, 0);
});

test("resolveCandidate: signature mismatch → embedding treated stale even if sidecar has one", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "a", type: "map", over: "{items}", task: "y" }] } as Taskflow;
	// sidecar claims agent signature (old) + an embedding; live def is now a map.
	const sidecar = {
		schemaVersion: 1 as const,
		phaseSignature: "agent", // mismatch with live "map"
		phaseCount: 1,
		agentUsage: [],
		generality: 0.5,
		reuseCount: 2,
		lastUsedAt: 1,
		createdAt: 1,
		version: 1,
		embedding: [0.1, 0.2, 0.3],
		embeddingModel: "m",
		embeddingDim: 3,
		embeddedAt: 1,
	};
	const c = resolveCandidate(def, "project", "x", sidecar);
	// structural fields always fresh:
	assert.equal(c.phaseSignature, "map");
	// embedding gated out because signatures differ:
	assert.equal(c.embedding, null);
	assert.equal(c.embeddingStale, true);
	// but reuseCount (sidecar bookkeeping) is trusted:
	assert.equal(c.reuseCount, 2);
});

test("resolveCandidate: signature match → embedding trusted", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "a", type: "agent", task: "y" }] } as Taskflow;
	const sidecar = {
		schemaVersion: 1 as const,
		phaseSignature: "agent",
		phaseCount: 1,
		agentUsage: [],
		generality: 0.5,
		reuseCount: 0,
		lastUsedAt: null,
		createdAt: 1,
		version: 1,
		embedding: [0.4, 0.5],
		embeddingModel: "m",
		embeddingDim: 2,
		embeddedAt: 1,
	};
	const c = resolveCandidate(def, "project", "x", sidecar);
	assert.deepEqual(c.embedding, [0.4, 0.5]);
	assert.equal(c.embeddingStale, false);
});

// ---------------------------------------------------------------------------
// searchLibrary (structural / keyword mode — no embedder)
// ---------------------------------------------------------------------------

test("searchLibrary: keyword match ranks purpose-matching flow first (structural mode)", async () => {
	const cwd = makeTmpCwd();
	try {
		const audit: Taskflow = {
			name: "audit-endpoints",
			description: "audit endpoints for auth",
			args: { dir: { default: "src/routes" } },
			phases: [
				{ id: "d", type: "agent", agent: "scout", task: "List endpoints under {args.dir}.", output: "json" },
				{ id: "m", type: "map", over: "{steps.d.json}", as: "item", agent: "analyst", task: "Audit {item}.", dependsOn: ["d"] },
				{ id: "r", type: "reduce", from: ["m"], agent: "writer", task: "Report:\n{steps.m.output}", dependsOn: ["m"], final: true },
			],
		} as Taskflow;
		const unrelated: Taskflow = {
			name: "hello-world",
			phases: [{ id: "a", type: "agent", task: "say hello world greeting", final: true }],
		} as Taskflow;
		saveFlowWithMeta(cwd, audit, deriveMeta(audit, { purpose: "审计 API endpoint 是否缺少鉴权", tags: ["audit", "auth"] }));
		saveFlowWithMeta(cwd, unrelated, deriveMeta(unrelated, {}));

		const deps: LibraryDeps = { settings: { enabled: true, scope: "both" }, cwd };
		const res = await searchLibrary(deps, { query: "audit api endpoints auth 鉴权" });

		assert.equal(res.searchMode, "structural"); // no embedder configured
		assert.ok(res.results.length >= 1);
		assert.equal(res.results[0].name, "audit-endpoints");
		assert.ok(res.results[0].score > 0, "audit flow should score above 0");
		assert.ok(res.results[0].score > (res.results[1]?.score ?? -1));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("searchLibrary: query with no real matches → empty results, structural mode", async () => {
	const cwd = makeTmpCwd();
	try {
		const deps: LibraryDeps = { settings: { enabled: true, scope: "both" }, cwd };
		const res = await searchLibrary(deps, { query: "zzznomatch-xyz-12345" });
		assert.equal(res.results.length, 0);
		assert.equal(res.searchMode, "structural");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("searchLibrary: minScore filters low results", async () => {
	const cwd = makeTmpCwd();
	try {
		const a: Taskflow = { name: "a", phases: [{ id: "x", type: "agent", task: "auth audit" }] } as Taskflow;
		const b: Taskflow = { name: "b", phases: [{ id: "x", type: "agent", task: "cooking recipe pasta" }] } as Taskflow;
		saveFlowWithMeta(cwd, a, deriveMeta(a, { purpose: "auth audit" }));
		saveFlowWithMeta(cwd, b, deriveMeta(b, { purpose: "cooking recipe" }));
		const deps: LibraryDeps = { settings: { enabled: true, scope: "both" }, cwd };
		const res = await searchLibrary(deps, { query: "auth audit", minScore: 0.5 });
		// only flows scoring >= 0.5 survive
		for (const r of res.results) assert.ok(r.score >= 0.5, `score ${r.score} below minScore`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("searchLibrary: phaseSignatureHint boosts structurally-matching flows", async () => {
	const cwd = makeTmpCwd();
	try {
		const audit: Taskflow = {
			name: "audit",
			args: { dir: { default: "x" } },
			phases: [
				{ id: "d", type: "agent", task: "{args.dir}", agent: "scout" },
				{ id: "m", type: "map", over: "{steps.d.json}", task: "{item}", dependsOn: ["d"] },
				{ id: "r", type: "reduce", from: ["m"], task: "{steps.m.output}", dependsOn: ["m"], final: true },
			],
		} as Taskflow;
		const simple: Taskflow = { name: "simple", phases: [{ id: "a", type: "agent", task: "do thing", final: true }] } as Taskflow;
		saveFlowWithMeta(cwd, audit, deriveMeta(audit, { purpose: "fan out work" }));
		saveFlowWithMeta(cwd, simple, deriveMeta(simple, { purpose: "fan out work" })); // same purpose
		const deps: LibraryDeps = { settings: { enabled: true, scope: "both" }, cwd };
		// With a signature hint matching audit's structure, audit should outrank simple.
		const res = await searchLibrary(deps, { query: "fan out work", phaseSignatureHint: "agent→map→reduce" });
		assert.equal(res.results[0].name, "audit");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("searchLibrary: CJK substring match — paraphrased Chinese query finds a Chinese purpose (no whitespace in CJK)", async () => {
	const cwd = makeTmpCwd();
	try {
		const audit: Taskflow = {
			name: "audit-endpoints",
			args: { dir: { default: "src/routes" } },
			phases: [{ id: "d", type: "agent", agent: "scout", task: "List {args.dir}.", output: "json", final: true }],
		} as Taskflow;
		saveFlowWithMeta(cwd, audit, deriveMeta(audit, { purpose: "审计一组 API endpoint 是否缺少鉴权检查", tags: ["audit", "auth"] }));
		const deps: LibraryDeps = { settings: { enabled: true, scope: "both" }, cwd };
		// Paraphrase with different surrounding words but a shared CJK term "鉴权".
		const res = await searchLibrary(deps, { query: "检查接口安全性 鉴权 缺失" });
		assert.ok(res.results.length >= 1, "CJK substring match should surface the flow");
		assert.equal(res.results[0].name, "audit-endpoints");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
