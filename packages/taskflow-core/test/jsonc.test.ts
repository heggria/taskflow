import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc, stripJsonComments } from "../src/jsonc.ts";

test("stripJsonComments: removes line comments (//)", () => {
	const input = `{\n  "name": "x", // the name\n  "n": 1\n}`;
	const out = stripJsonComments(input);
	assert.deepEqual(JSON.parse(out), { name: "x", n: 1 });
});

test("stripJsonComments: removes block comments (/* */)", () => {
	const input = `{/* leading */ "name": "x" /* trailing */}`;
	assert.deepEqual(stripJsonComments(input), `{  "name": "x"  }`);
});

test("stripJsonComments: leaves comments inside strings untouched", () => {
	const input = `{"task": "split on // and /* not a comment */"} `;
	assert.equal(stripJsonComments(input), input);
});

test("stripJsonComments: boundary between string and real comment", () => {
	// The // and /* ... */ inside the string value are data; the trailing
	// `// real comment` is outside the string and must be stripped.
	const input = `{ "s": "a//b/*c*/d", "n": 1 } // real comment`;
	const out = stripJsonComments(input);
	assert.deepEqual(JSON.parse(out), { s: "a//b/*c*/d", n: 1 });
});

test("stripJsonComments: removes trailing commas before } and ]", () => {
	assert.equal(stripJsonComments('{"a":1,}'), '{"a":1}');
	assert.equal(stripJsonComments('{"a":[1,2,],}'), '{"a":[1,2]}');
	assert.equal(stripJsonComments('{\n  "a": 1,\n}'), '{\n  "a": 1\n}');
});

test("stripJsonComments: does not strip commas that look trailing inside strings", () => {
	const input = `{"s": "x,]"}`;
	assert.equal(stripJsonComments(input), input);
});

test("parseJsonc: parses a realistic flow definition with comments", () => {
	const flow = `{
  // This is a security review flow
  "name": "review",
  "args": { "dir": { "default": "src" } }, /* override on the CLI */
  "phases": [
    {
      "id": "discover", // first phase
      "type": "agent",
      "task": "List files"
    },
  ],
}`;
	const parsed = parseJsonc(flow) as { name: string; phases: Array<{ id: string }> };
	assert.equal(parsed.name, "review");
	assert.equal(parsed.phases[0].id, "discover");
	assert.equal(parsed.phases.length, 1);
});

test("parseJsonc: still throws SyntaxError for genuinely broken JSON", () => {
	assert.throws(() => parseJsonc("{ not valid "));
	assert.throws(() => parseJsonc('{"unclosed": '));
});

test("parseJsonc: a pure JSON input parses identically to JSON.parse", () => {
	const pure = `{"a":[1,2,3],"b":{"c":true}}`;
	assert.deepEqual(parseJsonc(pure), JSON.parse(pure));
});
