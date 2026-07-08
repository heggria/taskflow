/**
 * readDefineFile: the disk-backed `defineFile` resolver.
 *
 * `defineFile` lets verify/compile/run share ONE persisted draft (typically in
 * the OS temp dir) so the agent writes the flow once and then verifies / edits
 * / runs it by path, instead of re-sending the whole definition each call.
 *
 * v0.2.0: readDefineFile now returns a `LoadResult` that distinguishes
 * `missing` from `unparseable` and carries the underlying parse error's
 * position (line/column) in `detail` — instead of collapsing both into `null`
 * and emitting a merged "not found or unparseable" message.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { describeLoadFailure, readDefineFile, type LoadResult } from "../src/store.ts";

function tmpFile(prefix: string, content: string): string {
	const p = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(p, content, "utf-8");
	return p;
}

/** Unwrap a successful LoadResult for ergonomic assertions. */
function valueOf<T>(r: { ok: true; value: T } | { ok: false; reason: string; detail: string }): T {
	assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r)}`);
	return (r as { ok: true; value: T }).value;
}

test("readDefineFile: parses a raw JSON flow definition", () => {
	const def = { name: "raw", phases: [{ id: "a", type: "agent", task: "hi", final: true }] };
	const f = tmpFile("raw", JSON.stringify(def));
	assert.equal((valueOf(readDefineFile(f)) as { name: string }).name, "raw");
	fs.unlinkSync(f);
});

test("readDefineFile: extracts the flow from a fenced ```json markdown block", () => {
	const md =
		"# My draft flow\n\n" +
		"Some prose explaining the idea.\n\n" +
		"```json\n" +
		'{\n  "name": "from-fence",\n  "phases": [\n    { "id": "a", "type": "agent", "task": "x", "final": true }\n  ]\n}\n' +
		"```\n\n" +
		"Trailing prose.\n";
	const f = tmpFile("fence", md);
	assert.equal((valueOf(readDefineFile(f)) as { name: string }).name, "from-fence");
	fs.unlinkSync(f);
});

test("readDefineFile: a missing file reports reason='missing' (no throw)", () => {
	const r = readDefineFile(path.join(os.tmpdir(), "taskflow-definitely-missing-xyz.json"));
	assert.equal(r.ok, false);
	assert.equal(r.reason, "missing");
});

test("readDefineFile: an unparseable file reports reason='unparseable' with the parse error (no throw)", () => {
	const f = tmpFile("junk", "this is not json {{{");
	const r = readDefineFile(f);
	assert.equal(r.ok, false);
	assert.equal(r.reason, "unparseable");
	// detail must carry the underlying SyntaxError — not a generic "unparseable".
	assert.match(r.detail, /JSON|token|Unexpected/i, `detail should contain a JSON parse error, got: ${r.detail}`);
	fs.unlinkSync(f);
});

test("readDefineFile: a bare newline inside a JSON string surfaces line/column (the 0.2.0 incident)", () => {
	// Reproduces the exact bug that motivated this rewrite: a hand-authored
	// defineFile with a stray bare LF inside a string literal. JSON.parse throws
	// "Bad control character in string literal ... at position N (line L column C)".
	// The old code swallowed that into null + "not found or unparseable"; the new
	// code surfaces the position so the author can fix it in seconds.
	const broken = '{\n  "name": "x",\n  "task": "line one\nline two"\n}\n';
	const f = tmpFile("bare-lf", broken);
	const r = readDefineFile(f);
	assert.equal(r.ok, false);
	assert.equal(r.reason, "unparseable");
	// V8 reports a position and (Node >=17) a line/column for control chars.
	assert.match(r.detail, /Bad control character/i, `expected control-char error, got: ${r.detail}`);
	fs.unlinkSync(f);
});

test("readDefineFile: handles a JSON string define value (shorthand forms parse too)", () => {
	// A bare JSON object is the common case — confirm a minimal valid shape round-trips.
	const def = { task: "do something", name: "shorthand" };
	const f = tmpFile("sh", JSON.stringify(def));
	assert.equal((valueOf(readDefineFile(f)) as { task: string }).task, "do something");
	fs.unlinkSync(f);
});

test("describeLoadFailure: formats a clear missing vs unparseable message", () => {
	const missing: Extract<LoadResult<unknown>, { ok: false }> = { ok: false, reason: "missing", path: "/tmp/x.json", detail: "ENOENT" };
	const broken: Extract<LoadResult<unknown>, { ok: false }> = { ok: false, reason: "unparseable", path: "/tmp/x.json", detail: "Bad control character in JSON at position 3979 (line 30 column 801)" };
	assert.equal(describeLoadFailure(missing, "defineFile"), "defineFile not found: /tmp/x.json");
	assert.match(describeLoadFailure(broken, "defineFile"), /defineFile could not be parsed — Bad control character.*position 3979.*\/tmp\/x\.json/);
});
