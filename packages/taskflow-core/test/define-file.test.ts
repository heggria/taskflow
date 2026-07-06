/**
 * readDefineFile: the disk-backed `defineFile` resolver.
 *
 * `defineFile` lets verify/compile/run share ONE persisted draft (typically in
 * the OS temp dir) so the agent writes the flow once and then verifies / edits
 * / runs it by path, instead of re-sending the whole definition each call.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readDefineFile } from "../src/store.ts";

function tmpFile(prefix: string, content: string): string {
	const p = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(p, content, "utf-8");
	return p;
}

test("readDefineFile: parses a raw JSON flow definition", () => {
	const def = { name: "raw", phases: [{ id: "a", type: "agent", task: "hi", final: true }] };
	const f = tmpFile("raw", JSON.stringify(def));
	assert.equal((readDefineFile(f) as { name: string }).name, "raw");
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
	assert.equal((readDefineFile(f) as { name: string }).name, "from-fence");
	fs.unlinkSync(f);
});

test("readDefineFile: returns null for a missing file (no throw)", () => {
	assert.equal(readDefineFile(path.join(os.tmpdir(), "taskflow-definitely-missing-xyz.json")), null);
});

test("readDefineFile: returns null for an unparseable file", () => {
	const f = tmpFile("junk", "this is not json {{{");
	assert.equal(readDefineFile(f), null);
	fs.unlinkSync(f);
});

test("readDefineFile: handles a JSON string define value (shorthand forms parse too)", () => {
	// A bare JSON object is the common case — confirm a minimal valid shape round-trips.
	const def = { task: "do something", name: "shorthand" };
	const f = tmpFile("sh", JSON.stringify(def));
	assert.equal((readDefineFile(f) as { task: string }).task, "do something");
	fs.unlinkSync(f);
});
