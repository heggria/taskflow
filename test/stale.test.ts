import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStaleFrontier, dependentsOf, formatWhyStale, readMapOf } from "../extensions/stale.ts";
import type { PhaseState } from "../extensions/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal PhaseState carrying only the observed readSet. */
function ps(reads?: string[]): PhaseState {
	return {
		id: "x",
		status: "done",
		reads: reads?.map((stepId) => ({ stepId })),
	} as PhaseState;
}

function map(obj: Record<string, string[]>): Map<string, readonly string[]> {
	const m = new Map<string, string[]>();
	for (const [k, v] of Object.entries(obj)) m.set(k, v);
	return m;
}

// ---------------------------------------------------------------------------
// computeStaleFrontier
// ---------------------------------------------------------------------------

test("computeStaleFrontier: seed propagates through a chain", () => {
	// a ← b ← c  (b reads a, c reads b)
	const reads = map({ b: ["a"], c: ["b"] });
	assert.deepEqual([...computeStaleFrontier(reads, ["a"])].sort(), ["a", "b", "c"]);
});

test("computeStaleFrontier: diamond converges", () => {
	// a; b reads a; c reads a; d reads b+c
	const reads = map({ b: ["a"], c: ["a"], d: ["b", "c"] });
	assert.deepEqual([...computeStaleFrontier(reads, ["a"])].sort(), ["a", "b", "c", "d"]);
});

test("computeStaleFrontier: an unrelated phase is NOT stale", () => {
	const reads = map({ b: ["a"], z: [] });
	const frontier = computeStaleFrontier(reads, ["a"]);
	assert.ok(frontier.has("a") && frontier.has("b"));
	assert.ok(!frontier.has("z"), "z reads nothing stale → fresh");
});

test("computeStaleFrontier: a seed with no dependents is just itself", () => {
	const reads = map({ b: ["a"] });
	assert.deepEqual([...computeStaleFrontier(reads, ["b"])], ["b"]);
});

test("computeStaleFrontier: multiple seeds union", () => {
	const reads = map({ c: ["a"], d: ["b"] });
	assert.deepEqual([...computeStaleFrontier(reads, ["a", "b"])].sort(), ["a", "b", "c", "d"]);
});

test("computeStaleFrontier: empty graph → just the seed", () => {
	assert.deepEqual([...computeStaleFrontier(new Map(), ["x"])], ["x"]);
});

test("computeStaleFrontier: deterministic across repeated calls", () => {
	const reads = map({ b: ["a"], c: ["a", "b"] });
	assert.deepEqual([...computeStaleFrontier(reads, ["a"])], [...computeStaleFrontier(reads, ["a"])]);
});

// ---------------------------------------------------------------------------
// Property: the BFS frontier is exactly the naive fixpoint closure
// (sound AND complete) on random acyclic read graphs.
// ---------------------------------------------------------------------------

test("computeStaleFrontier (property): == naive transitive closure on random DAGs", () => {
	let seed = 1234567;
	const rand = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	for (let i = 0; i < 500; i++) {
		const n = 3 + (i % 6);
		const ids = Array.from({ length: n }, (_, k) => `p${k}`);
		// forward-only edges → guaranteed acyclic
		const reads = new Map<string, string[]>();
		for (let k = 0; k < n; k++) {
			const deps: string[] = [];
			for (let j = 0; j < k; j++) if (rand() < 0.45) deps.push(ids[j]);
			reads.set(ids[k], deps);
		}
		const seedId = ids[i % n];
		const frontier = computeStaleFrontier(reads, [seedId]);
		// naive fixpoint: a node is stale if it's the seed OR reads any stale node
		const naive = new Set<string>([seedId]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const [r, deps] of reads) {
				if (naive.has(r)) continue;
				if (deps.some((d) => naive.has(d))) {
					naive.add(r);
					changed = true;
				}
			}
		}
		assert.deepEqual(
			[...frontier].sort(),
			[...naive].sort(),
			`frontier mismatch on seed ${seedId}`,
		);
	}
});

// ---------------------------------------------------------------------------
// readMapOf / dependentsOf
// ---------------------------------------------------------------------------

test("readMapOf: builds from PhaseState.reads, drops empty readers", () => {
	const phases: Record<string, PhaseState> = { a: ps(), b: ps(["a"]), c: ps(["b"]) };
	const m = readMapOf(phases);
	assert.ok(!m.has("a"), "a read nothing → not in the map");
	assert.deepEqual(m.get("b"), ["a"]);
	assert.deepEqual(m.get("c"), ["b"]);
});

test("dependentsOf: who reads a phase", () => {
	const reads = map({ b: ["a"], c: ["a", "b"] });
	assert.deepEqual(dependentsOf(reads, "a").sort(), ["b", "c"]);
	assert.deepEqual(dependentsOf(reads, "b"), ["c"]);
	assert.deepEqual(dependentsOf(reads, "z"), []);
});

// ---------------------------------------------------------------------------
// Cyclic read graphs must terminate (a correct DAG can't produce these, but a
// pathological one could; the doc promises termination).
// ---------------------------------------------------------------------------

test("computeStaleFrontier: self-loop terminates and stays correct", () => {
	const reads = map({ a: ["a"], b: ["a"] });
	// seed a → a stale (self-read doesn't re-enqueue: already stale); b reads a → stale.
	assert.deepEqual([...computeStaleFrontier(reads, ["a"])].sort(), ["a", "b"]);
});

test("computeStaleFrontier: a 2-cycle terminates with both nodes", () => {
	const reads = map({ a: ["b"], b: ["a"] });
	assert.deepEqual([...computeStaleFrontier(reads, ["a"])].sort(), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// formatWhyStale (rendering)
// ---------------------------------------------------------------------------

test("formatWhyStale: full-graph mode (no seeds)", () => {
	const reads = map({ b: ["a"], c: ["b"] });
	const out = formatWhyStale("r1", "f", reads, []);
	assert.match(out, /Observed dependency graph/);
	assert.match(out, /b  reads: a/);
	assert.match(out, /c  reads: b/);
});

test("formatWhyStale: frontier mode shows causes", () => {
	const reads = map({ b: ["a"], c: ["b"] });
	const out = formatWhyStale("r1", "f", reads, ["a"]);
	assert.match(out, /Assuming changed: a/);
	assert.match(out, /Stale frontier \(transitive, 3 phases\)/);
	assert.match(out, /a  \(changed — seed\)/);
	assert.match(out, /b  ← reads a/);
	assert.match(out, /c  ← reads b/);
});

test("formatWhyStale: seed with no dependents reports 'only the seed'", () => {
	const reads = map({ b: ["a"] });
	const out = formatWhyStale("r1", "f", reads, ["b"]);
	assert.match(out, /only the seed/);
});

test("formatWhyStale: empty readSet", () => {
	const out = formatWhyStale("r1", "f", new Map(), []);
	assert.match(out, /No observed readSets/);
});
