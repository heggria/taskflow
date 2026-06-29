import assert from "node:assert/strict";
import { test } from "node:test";
import {
	computeStaleFrontier,
	declaredReadMapOfDef,
	dependentsOf,
	formatWhyStale,
} from "../src/stale.ts";
import type { Phase, Taskflow } from "../src/schema.ts";

function map(obj: Record<string, string[]>): Map<string, readonly string[]> {
	const m = new Map<string, string[]>();
	for (const [k, v] of Object.entries(obj)) m.set(k, v);
	return m;
}

// ---------------------------------------------------------------------------
// computeStaleFrontier — 3-arg union semantics
// ---------------------------------------------------------------------------

test("computeStaleFrontier (union): declared-only edge extends the frontier", () => {
	// observed: b reads nothing. declared: b reads a. Seeding a → b is stale via
	// the declared plane (the observed plane alone would leave b fresh).
	const reads = map({ b: [] });
	const declared = map({ b: ["a"] });
	assert.deepEqual([...computeStaleFrontier(reads, ["a"], declared)].sort(), ["a", "b"]);
});

test("computeStaleFrontier (union): declared undefined → observed-only (backward-compat)", () => {
	const reads = map({ b: ["a"], c: ["b"] });
	// 3-arg with declared undefined must equal the 2-arg call exactly.
	assert.deepEqual(
		[...computeStaleFrontier(reads, ["a"], undefined)].sort(),
		[...computeStaleFrontier(reads, ["a"])].sort(),
	);
});

test("computeStaleFrontier (union): observed ⊆ declared → same as declared-only", () => {
	// observed is a subset of declared; union == declared.
	const reads = map({ b: ["a"] });
	const declared = map({ b: ["a"], c: ["a"] });
	assert.deepEqual([...computeStaleFrontier(reads, ["a"], declared)].sort(), ["a", "b", "c"]);
});

test("computeStaleFrontier (union): cycle in declared terminates", () => {
	// A pathological declared cycle (a reads b, b reads a). Seeding a → both.
	const reads = new Map<string, string[]>();
	const declared = map({ a: ["b"], b: ["a"] });
	const frontier = computeStaleFrontier(reads, ["a"], declared);
	assert.deepEqual([...frontier].sort(), ["a", "b"]);
});

test("computeStaleFrontier (union): self-loop in declared does not hang", () => {
	const reads = new Map<string, string[]>();
	const declared = map({ a: ["a"], b: ["a"] });
	assert.deepEqual([...computeStaleFrontier(reads, ["a"], declared)].sort(), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// dependentsOf — 3-arg union
// ---------------------------------------------------------------------------

test("dependentsOf (union): union of observed + declared dependents", () => {
	const reads = map({ b: ["a"] });        // b observed-reads a
	const declared = map({ c: ["a"] });     // c declared-reads a (not observed)
	assert.deepEqual(dependentsOf(reads, "a", declared).sort(), ["b", "c"]);
	// without declared → observed only.
	assert.deepEqual(dependentsOf(reads, "a").sort(), ["b"]);
});

// ---------------------------------------------------------------------------
// Property: 3-arg frontier == naive transitive closure of (observed ∪ declared)
// on random acyclic graphs. (Mirrors the 2-arg property test in stale.test.ts.)
// ---------------------------------------------------------------------------

test("computeStaleFrontier (property): == naive closure of observed∪declared on random DAGs", () => {
	let seed = 987654321;
	const rand = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	for (let i = 0; i < 500; i++) {
		const n = 3 + (i % 6);
		const ids = Array.from({ length: n }, (_, k) => `p${k}`);
		// Two independent forward-only edge sets → both acyclic, union acyclic.
		const reads = new Map<string, string[]>();
		const declared = new Map<string, string[]>();
		for (let k = 0; k < n; k++) {
			const obs: string[] = [];
			const dec: string[] = [];
			for (let j = 0; j < k; j++) {
				if (rand() < 0.35) obs.push(ids[j]);
				if (rand() < 0.35) dec.push(ids[j]);
			}
			if (obs.length) reads.set(ids[k], obs);
			if (dec.length) declared.set(ids[k], dec);
		}
		const seedId = ids[i % n];
		const frontier = computeStaleFrontier(reads, [seedId], declared);
		// naive fixpoint over the union graph: a node is stale if it's the seed
		// OR reads (observed ∪ declared) any stale node.
		const unionOf = (id: string): string[] => [
			...(reads.get(id) ?? []),
			...(declared.get(id) ?? []),
		];
		const naive = new Set<string>([seedId]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const id of ids) {
				if (naive.has(id)) continue;
				if (unionOf(id).some((d) => naive.has(d))) {
					naive.add(id);
					changed = true;
				}
			}
		}
		assert.deepEqual(
			[...frontier].sort(),
			[...naive].sort(),
			`frontier mismatch on seed ${seedId} (iter ${i})`,
		);
	}
});

// ---------------------------------------------------------------------------
// declaredReadMapOfDef
// ---------------------------------------------------------------------------

test("declaredReadMapOfDef: builds from a Taskflow def, excludes self-refs", () => {
	const def: Taskflow = {
		name: "x",
		phases: [
			{ id: "scout", type: "agent", task: "scan" } as Phase,
			{ id: "refine", type: "loop", maxIterations: 2, until: "{steps.refine.output}==x", task: "r {steps.scout.output}", dependsOn: ["scout"] } as Phase,
		],
	} as Taskflow;
	const m = declaredReadMapOfDef(def);
	assert.deepEqual(m.get("refine"), ["scout"]);
	assert.ok(!m.has("scout"), "scout reads nothing → absent");
});

test("declaredReadMapOfDef: empty reads → absent from map", () => {
	const def: Taskflow = {
		name: "x",
		phases: [{ id: "a", type: "agent", task: "no refs" } as Phase],
	} as Taskflow;
	assert.equal(declaredReadMapOfDef(def).size, 0);
});

// ---------------------------------------------------------------------------
// formatWhyStale — 5-arg union rendering
// ---------------------------------------------------------------------------

test("formatWhyStale (union): frontier mode annotates (declared) edges", () => {
	const reads = map({ b: [] });          // b observed-reads nothing
	const declared = map({ b: ["a"] });    // b declared-reads a
	const out = formatWhyStale("r1", "f", reads, ["a"], declared);
	assert.match(out, /Assuming changed: a/);
	assert.match(out, /b  ← reads a \(declared\)/);
});

test("formatWhyStale (union): declared undefined → current rendering (backward-compat)", () => {
	const reads = map({ b: ["a"] });
	const outUnion = formatWhyStale("r1", "f", reads, ["a"], undefined);
	const outOld = formatWhyStale("r1", "f", reads, ["a"]);
	assert.equal(outUnion, outOld);
});

test("formatWhyStale (union): full-graph mode shows declared-only edges", () => {
	const reads = map({ b: ["a"] });
	const declared = map({ c: ["a"] });
	const out = formatWhyStale("r1", "f", reads, [], declared);
	assert.match(out, /b  reads: a/);
	assert.match(out, /c  reads: a \(declared\)/);
});
