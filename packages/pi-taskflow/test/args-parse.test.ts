import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgsString } from "../src/index.ts";
import type { Taskflow } from "taskflow-core";

const def: Taskflow = {
	name: "typed-cli-args",
	args: {
		count: { type: "number" },
		enabled: { type: "boolean" },
		numeric: { type: "enum", values: [1, 2] },
		mixed: { type: "enum", values: ["1", 1] },
	},
	phases: [{ id: "work", type: "agent", task: "x", final: true }],
};

test("parseArgsString coerces declared number, boolean, and numeric enum values", () => {
	assert.deepEqual(parseArgsString("count=2.5 enabled=true numeric=2", def), {
		count: 2.5,
		enabled: true,
		numeric: 2,
	});
});

test("parseArgsString preserves an exact string member in a mixed enum", () => {
	assert.deepEqual(parseArgsString("mixed=1", def), { mixed: "1" });
	assert.deepEqual(parseArgsString('{"mixed":1}', def), { mixed: 1 });
});

test("parseArgsString leaves invalid typed text for boundary validation", () => {
	assert.deepEqual(parseArgsString("count=nope enabled=yes", def), { count: "nope", enabled: "yes" });
});

test("parseArgsString scans quoted values and decimal forms without backtracking", () => {
	assert.deepEqual(parseArgsString('label="hello \\"world\\"" count=-.5 numeric=2e0', def), {
		label: 'hello "world"',
		count: -0.5,
		numeric: 2,
	});
	assert.deepEqual(parseArgsString(`count=${"0".repeat(100_000)}x`, def), {
		count: `${"0".repeat(100_000)}x`,
	});
});
