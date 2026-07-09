import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCond } from "../src/flowir/cond.ts";

// ---------------------------------------------------------------------------
// Canonical form: equivalent expressions normalize identically
// ---------------------------------------------------------------------------

test("normalizeCond: operator-spacing differences canonicalize the same", () => {
	const a = normalizeCond("a==b");
	const b = normalizeCond("a  ==  b");
	const c = normalizeCond("a == b");
	assert.equal(a.canonical, b.canonical);
	assert.equal(a.canonical, c.canonical);
	assert.equal(a.canonical, "a==b");
});

test("normalizeCond: tab/newline whitespace is normalized away", () => {
	const a = normalizeCond("a==b");
	const b = normalizeCond("\ta\t==\tb\n");
	assert.equal(a.canonical, b.canonical);
});

test("normalizeCond: redundant enclosing parens are stripped", () => {
	const a = normalizeCond("a == b");
	const b = normalizeCond("(a == b)");
	const c = normalizeCond("((a == b))");
	assert.equal(a.canonical, b.canonical);
	assert.equal(a.canonical, c.canonical);
	assert.equal(a.canonical, "a==b");
});

test("normalizeCond: parens around the whole && expression are stripped", () => {
	const a = normalizeCond("a == b && c == d");
	const b = normalizeCond("(a == b && c == d)");
	assert.equal(a.canonical, b.canonical);
});

test("normalizeCond: inner grouping parens are preserved (precedence matters)", () => {
	// (a && b) || c  is NOT equivalent to a && (b || c); the parens are
	// load-bearing, so they must survive normalization.
	const grouped = normalizeCond("(a && b) || c");
	const regrouped = normalizeCond("a && (b || c)");
	assert.notEqual(grouped.canonical, regrouped.canonical);
	assert.equal(grouped.canonical, "(a&&b)||c");
});

test("normalizeCond: ref placeholder spacing is normalized", () => {
	const a = normalizeCond("{steps.foo.output} == done");
	const b = normalizeCond("{ steps.foo.output }==done");
	assert.equal(a.canonical, b.canonical);
	assert.equal(a.canonical, "{steps.foo.output}==done");
});

test("normalizeCond: quoted string contents are preserved verbatim", () => {
	const a = normalizeCond('{args.label} == "go live"');
	const b = normalizeCond('{args.label}=="go live"');
	assert.equal(a.canonical, b.canonical);
	assert.equal(a.canonical, '{args.label}=="go live"');
	// Internal spaces inside a string literal must survive whitespace removal.
	assert.ok(a.canonical.includes('"go live"'));
});

test("normalizeCond: single-quoted strings are preserved", () => {
	const a = normalizeCond("{args.x} == 'a b'");
	const b = normalizeCond("{args.x}=='a b'");
	assert.equal(a.canonical, b.canonical);
	assert.equal(a.canonical, "{args.x}=='a b'");
});

test("normalizeCond: logical/comparison operators all canonicalize", () => {
	const ops = ["==", "!=", ">=", "<=", ">", "<", "&&", "||"];
	for (const op of ops) {
		const spaced = normalizeCond(`a ${op} b`);
		const tight = normalizeCond(`a${op}b`);
		assert.equal(spaced.canonical, tight.canonical, `operator ${op}`);
		assert.equal(spaced.canonical, `a${op}b`, `operator ${op}`);
	}
});

test("normalizeCond: unary not spacing is normalized", () => {
	const a = normalizeCond("!a");
	const b = normalizeCond("! a");
	assert.equal(a.canonical, b.canonical);
	assert.equal(a.canonical, "!a");
});

// ---------------------------------------------------------------------------
// Canonical form: different expressions differ
// ---------------------------------------------------------------------------

test("normalizeCond: different operators produce different canonicals", () => {
	assert.notEqual(normalizeCond("a==b").canonical, normalizeCond("a!=b").canonical);
	assert.notEqual(normalizeCond("a>=b").canonical, normalizeCond("a>b").canonical);
});

test("normalizeCond: different operands produce different canonicals", () => {
	assert.notEqual(normalizeCond("a==b").canonical, normalizeCond("a==c").canonical);
	assert.notEqual(
		normalizeCond("{steps.x.output} == done").canonical,
		normalizeCond("{steps.y.output} == done").canonical,
	);
});

test("normalizeCond: operand order matters", () => {
	assert.notEqual(normalizeCond("a && b").canonical, normalizeCond("b && a").canonical);
});

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

test("normalizeCond: extracts a steps.* ref", () => {
	const n = normalizeCond('{steps.foo.output} == "done"');
	assert.deepEqual(n.refs, ["steps.foo.output"]);
});

test("normalizeCond: extracts args.* and env.* refs", () => {
	const n = normalizeCond("{args.n} > 3 && {env.MAX} > 0");
	assert.deepEqual(n.refs, ["args.n", "env.MAX"]);
});

test("normalizeCond: extracts a deeply-nested steps json ref", () => {
	const n = normalizeCond("{steps.triage.json.route} == deep");
	assert.deepEqual(n.refs, ["steps.triage.json.route"]);
});

test("normalizeCond: de-duplicates refs preserving first-occurrence order", () => {
	const n = normalizeCond("{args.n} > 3 || {args.n} < 0");
	assert.deepEqual(n.refs, ["args.n"]);
});

test("normalizeCond: refs are tolerant of inner brace whitespace", () => {
	const a = normalizeCond("{steps.foo.output} == done").refs;
	const b = normalizeCond("{ steps.foo.output } == done").refs;
	assert.deepEqual(a, b);
	assert.deepEqual(a, ["steps.foo.output"]);
});

test("normalizeCond: no refs in a literal-only expression", () => {
	assert.deepEqual(normalizeCond("true && false").refs, []);
});

test("normalizeCond: placeholders inside string literals are NOT refs", () => {
	// The right-hand side is a string that looks like a placeholder — not a dependency.
	const n = normalizeCond('{args.x} == "{steps.y.output}"');
	assert.deepEqual(n.refs, ["args.x"]);
	assert.ok(n.canonical.includes('"{steps.y.output}"'));
});

test("normalizeCond: single-quoted literal placeholders are NOT refs", () => {
	const n = normalizeCond("{args.label} == '{steps.fake.output}'");
	assert.deepEqual(n.refs, ["args.label"]);
});

test("normalizeCond: escaped quotes inside strings are preserved", () => {
	// Backslash-escaped quote must survive protect/restore byte-for-byte.
	const raw = String.raw`{args.x} == "say \"hi\""`;
	const n = normalizeCond(raw);
	assert.equal(n.canonical, String.raw`{args.x}=="say \"hi\""`);
	assert.deepEqual(n.refs, ["args.x"]);
});

// ---------------------------------------------------------------------------
// Fail-open (never throws; malformed → canonical = source.trim(), refs = [])
// ---------------------------------------------------------------------------

test("normalizeCond: malformed expression fails open (unterminated placeholder)", () => {
	const malformed = "{steps.foo.output ==";
	const n = normalizeCond(malformed);
	assert.equal(n.source, malformed);
	assert.equal(n.canonical, malformed.trim());
	assert.deepEqual(n.refs, []);
});

test("normalizeCond: malformed expression fails open (trailing tokens)", () => {
	const n = normalizeCond("{steps.a.output} {steps.b.output}");
	assert.deepEqual(n.refs, []);
	assert.equal(n.canonical, "{steps.a.output} {steps.b.output}");
});

test("normalizeCond: malformed expression fails open (double operator)", () => {
	const malformed = "a == == b";
	const n = normalizeCond(malformed);
	assert.equal(n.canonical, "a == == b");
	assert.deepEqual(n.refs, []);
});

test("normalizeCond: unterminated string fails open", () => {
	const malformed = '{args.x} == "unterminated';
	const n = normalizeCond(malformed);
	assert.equal(n.canonical, malformed.trim());
	assert.deepEqual(n.refs, []);
});

test("normalizeCond: empty expression does not throw", () => {
	const n = normalizeCond("");
	assert.equal(n.source, "");
	assert.equal(n.canonical, "");
	assert.deepEqual(n.refs, []);
});

test("normalizeCond: whitespace-only expression does not throw", () => {
	const n = normalizeCond("   \t\n  ");
	assert.equal(n.canonical, "");
	assert.deepEqual(n.refs, []);
});

test("normalizeCond: never throws on nullish input", () => {
	// Defensive: the signature is `string`, but fail-open must hold.
	const n = normalizeCond(null as unknown as string);
	assert.equal(n.canonical, "");
	assert.deepEqual(n.refs, []);
});

test("normalizeCond: source is always the verbatim input", () => {
	const raw = "  a == b  ";
	assert.equal(normalizeCond(raw).source, raw);
});

// ---------------------------------------------------------------------------
// Hashing fitness: equivalent expressions are byte-identical
// ---------------------------------------------------------------------------

test("normalizeCond: equivalent conditions hash identically (full descriptor)", () => {
	// Two authoring styles of the same guard must fold into one hash.
	const styles = [
		"{steps.triage.json.route} == deep",
		"{ steps.triage.json.route }==deep",
		"({steps.triage.json.route} == deep)",
		"(({steps.triage.json.route} == deep))",
	];
	const canonicals = new Set(styles.map((s) => normalizeCond(s).canonical));
	assert.equal(canonicals.size, 1, "all styles share one canonical form");
});

test("normalizeCond: refs consistent across equivalent forms", () => {
	const styles = [
		"{steps.triage.json.route} == deep",
		"({steps.triage.json.route} == deep)",
		"{ steps.triage.json.route } == deep",
	];
	const refsSets = styles.map((s) => JSON.stringify(normalizeCond(s).refs));
	assert.ok(refsSets.every((r) => r === refsSets[0]));
	assert.deepEqual(JSON.parse(refsSets[0]), ["steps.triage.json.route"]);
});
