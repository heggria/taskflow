import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	ancestorIds,
	ctxDirFor,
	drainPendingSpawns,
	initCtxDir,
	isValidKey,
	MAX_KEYS_PER_NODE,
	MAX_SPAWN_ASSIGNMENTS,
	MAX_STRUCTURED_BYTES,
	MAX_TASK_BYTES,
	MAX_VALUE_BYTES,
	nodeDepth,
	queueSpawn,
	readNodeFindings,
	readReport,
	readTree,
	readVisibleFindings,
	registerNode,
	setNodeStatus,
	writeFinding,
	writeReport,
} from "../src/context-store.ts";

async function tmpCtx(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ctxstore-"));
	return initCtxDir(dir);
}

test("context-store: write + read own findings", async () => {
	const ctx = await tmpCtx();
	try {
		registerNode(ctx, "a", "phaseA", undefined, "running");
		writeFinding(ctx, "a", "endpoints", ["/login", "/logout"]);
		const all = readVisibleFindings(ctx, "a") as Record<string, unknown>;
		assert.deepEqual(all.endpoints, ["/login", "/logout"]);
		assert.deepEqual(readVisibleFindings(ctx, "a", "endpoints"), ["/login", "/logout"]);
		assert.equal(readVisibleFindings(ctx, "a", "missing"), undefined);
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: a node sees a COMPLETED sibling's findings, not a running one", async () => {
	const ctx = await tmpCtx();
	try {
		registerNode(ctx, "sib-running", "p", undefined, "running");
		registerNode(ctx, "sib-done", "p", undefined, "done");
		registerNode(ctx, "me", "p", undefined, "running");
		writeFinding(ctx, "sib-running", "k1", "from-running");
		writeFinding(ctx, "sib-done", "k2", "from-done");
		const visible = readVisibleFindings(ctx, "me") as Record<string, unknown>;
		assert.equal(visible.k2, "from-done", "completed sibling visible");
		assert.equal(visible.k1, undefined, "running sibling NOT visible");
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: a node always sees its ANCESTORS' findings (even while running)", async () => {
	const ctx = await tmpCtx();
	try {
		registerNode(ctx, "root", "p", undefined, "running");
		registerNode(ctx, "child", "p", "root", "running");
		registerNode(ctx, "grand", "p", "child", "running");
		writeFinding(ctx, "root", "rootKey", "R");
		writeFinding(ctx, "child", "childKey", "C");
		const visible = readVisibleFindings(ctx, "grand") as Record<string, unknown>;
		assert.equal(visible.rootKey, "R");
		assert.equal(visible.childKey, "C");
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: own findings win over ancestor on key conflict", async () => {
	const ctx = await tmpCtx();
	try {
		registerNode(ctx, "root", "p", undefined, "done");
		registerNode(ctx, "child", "p", "root", "running");
		writeFinding(ctx, "root", "shared", "ancestor-value");
		writeFinding(ctx, "child", "shared", "own-value");
		const visible = readVisibleFindings(ctx, "child") as Record<string, unknown>;
		assert.equal(visible.shared, "own-value");
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: concurrent writes to the SAME node never lose a key (atomic + lock)", async () => {
	const ctx = await tmpCtx();
	try {
		registerNode(ctx, "n", "p", undefined, "running");
		const N = 40;
		await Promise.all(
			Array.from({ length: N }, (_, i) => Promise.resolve().then(() => writeFinding(ctx, "n", `k${i}`, i))),
		);
		const visible = readVisibleFindings(ctx, "n") as Record<string, unknown>;
		for (let i = 0; i < N; i++) assert.equal(visible[`k${i}`], i, `key k${i} survived`);
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: registerNode is idempotent (resume re-run does not duplicate)", async () => {
	const ctx = await tmpCtx();
	try {
		registerNode(ctx, "x", "phaseX", undefined, "running");
		registerNode(ctx, "x", "phaseX", undefined, "done"); // re-run on resume
		const tree = readTree(ctx);
		assert.equal(tree.nodes.filter((n) => n.nodeId === "x").length, 1, "no duplicate node");
		assert.equal(tree.nodes.find((n) => n.nodeId === "x")!.status, "done");
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: nodeDepth + ancestorIds walk the parent chain", async () => {
	const ctx = await tmpCtx();
	try {
		registerNode(ctx, "r", "p", undefined);
		registerNode(ctx, "c", "p", "r");
		registerNode(ctx, "g", "p", "c");
		const tree = readTree(ctx);
		assert.equal(nodeDepth(tree, "r"), 0);
		assert.equal(nodeDepth(tree, "c"), 1);
		assert.equal(nodeDepth(tree, "g"), 2);
		assert.deepEqual(ancestorIds(tree, "g"), ["c", "r"]);
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: nodeDepth tolerates a parent cycle without hanging", async () => {
	const ctx = await tmpCtx();
	try {
		// Hand-craft a corrupt cyclic tree.
		fs.writeFileSync(
			path.join(ctx, "tree.json"),
			JSON.stringify({ nodes: [
				{ nodeId: "a", phaseId: "p", parentNodeId: "b", status: "running", createdAt: 1, updatedAt: 1 },
				{ nodeId: "b", phaseId: "p", parentNodeId: "a", status: "running", createdAt: 1, updatedAt: 1 },
			] }),
		);
		const tree = readTree(ctx);
		assert.ok(nodeDepth(tree, "a") <= 2, "terminates on cycle");
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: report write + read round-trip", async () => {
	const ctx = await tmpCtx();
	try {
		writeReport(ctx, "n", "found 3 issues", { count: 3 });
		const rep = readReport(ctx, "n");
		assert.equal(rep?.summary, "found 3 issues");
		assert.deepEqual(rep?.structured, { count: 3 });
		assert.equal(readReport(ctx, "missing"), undefined);
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: queueSpawn + drainPendingSpawns (drain removes them)", async () => {
	const ctx = await tmpCtx();
	try {
		queueSpawn(ctx, "parent", [{ task: "t1" }, { task: "t2", agent: "scout" }]);
		queueSpawn(ctx, "parent", [{ task: "t3" }]);
		queueSpawn(ctx, "other", [{ task: "x" }]);
		const drained = drainPendingSpawns(ctx, "parent");
		assert.equal(drained.length, 3);
		assert.deepEqual(drained.map((a) => a.task).sort(), ["t1", "t2", "t3"]);
		assert.equal(drainPendingSpawns(ctx, "parent").length, 0, "second drain is empty");
		assert.equal(drainPendingSpawns(ctx, "other").length, 1, "other parent untouched");
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: guards reject bad keys, oversized values, too many keys, bad spawns", async () => {
	const ctx = await tmpCtx();
	try {
		assert.ok(!isValidKey("../escape"));
		assert.ok(!isValidKey("has space"));
		assert.ok(!isValidKey(""));
		assert.ok(isValidKey("ok.key-1_2"));

		registerNode(ctx, "n", "p", undefined);
		assert.throws(() => writeFinding(ctx, "n", "../bad", 1), /Invalid finding key/);
		assert.throws(() => writeFinding(ctx, "n", "big", "x".repeat(MAX_VALUE_BYTES + 1)), /exceeds/);
		assert.throws(() => queueSpawn(ctx, "n", []), /non-empty/);
		assert.throws(
			() => queueSpawn(ctx, "n", Array.from({ length: MAX_SPAWN_ASSIGNMENTS + 1 }, () => ({ task: "t" }))),
			/limited to/,
		);
		assert.throws(() => queueSpawn(ctx, "n", [{ task: "" }]), /exactly one of 'task'/);
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: MAX_KEYS_PER_NODE cap enforced", async () => {
	const ctx = await tmpCtx();
	try {
		registerNode(ctx, "n", "p", undefined);
		for (let i = 0; i < MAX_KEYS_PER_NODE; i++) writeFinding(ctx, "n", `k${i}`, i);
		assert.throws(() => writeFinding(ctx, "n", "overflow", 1), /exceeds .* keys/);
		// Overwriting an EXISTING key is still allowed at the cap.
		writeFinding(ctx, "n", "k0", 999);
		assert.equal((readVisibleFindings(ctx, "n") as Record<string, unknown>).k0, 999);
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: ctxDirFor rejects unsafe runIds, builds safe path", async () => {
	assert.throws(() => ctxDirFor("/runs", "../escape"), /Unsafe runId/);
	assert.throws(() => ctxDirFor("/runs", "a/b"), /Unsafe runId/);
	assert.equal(ctxDirFor("/runs", "good-run-1"), path.join("/runs", "ctx", "good-run-1"));
});

test("context-store: setNodeStatus updates status, no-op for unknown node", async () => {
	const ctx = await tmpCtx();
	try {
		registerNode(ctx, "n", "p", undefined, "running");
		setNodeStatus(ctx, "n", "done");
		assert.equal(readTree(ctx).nodes.find((x) => x.nodeId === "n")!.status, "done");
		setNodeStatus(ctx, "ghost", "failed"); // must not throw
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: read paths reject unsafe nodeIds (defense-in-depth)", async () => {
	const ctx = await tmpCtx();
	try {
		// '..' must never build a path that escapes the findings dir.
		assert.deepEqual(readNodeFindings(ctx, "../escape"), {});
		assert.deepEqual(readVisibleFindings(ctx, "../escape"), {});
		assert.equal(readVisibleFindings(ctx, "../escape", "k"), undefined);
		assert.equal(readReport(ctx, "../escape"), undefined);
		assert.throws(() => writeFinding(ctx, "../escape", "k", 1), /Unsafe nodeId/);
		assert.throws(() => writeReport(ctx, "../escape", "s"), /Unsafe nodeId/);
		assert.throws(() => queueSpawn(ctx, "../escape", [{ task: "t" }]), /Unsafe nodeId/);
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});

test("context-store: report structured + spawn task size caps enforced", async () => {
	const ctx = await tmpCtx();
	try {
		writeReport(ctx, "n", "ok", { small: true }); // under cap — fine
		assert.throws(
			() => writeReport(ctx, "n", "ok", { big: "x".repeat(MAX_STRUCTURED_BYTES) }),
			/structured.* exceeds/,
		);
		assert.throws(() => queueSpawn(ctx, "n", [{ task: "x".repeat(MAX_TASK_BYTES + 1) }]), /task exceeds/);
	} finally {
		fs.rmSync(ctx, { recursive: true, force: true });
	}
});
