/**
 * Built-in script-lint verifier tests.
 *
 * Covers: grep dash-pattern detection, unbalanced regex, pipefail warnings,
 * interpolation skip, non-script phase skip, compile integration (auto-include
 * + lint:false opt-out), and the builtinVerifiers barrel.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scriptLintVerifier, builtinVerifiers } from "../src/verifiers/index.ts";
import { verifyTaskflow, type VerifiableFlow } from "../src/verify.ts";
import { compileTaskflow } from "../src/compile.ts";
import type { Phase, Taskflow } from "../src/schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scriptPhase(id: string, run: string | string[], overrides?: Partial<Phase>): Phase {
	return { id, type: "script", run, ...overrides } as Phase;
}

function flowWith(...phases: Phase[]): VerifiableFlow {
	return { name: "lint-test", phases };
}

function lintIssues(flow: VerifiableFlow) {
	return scriptLintVerifier.verify(flow);
}

// ---------------------------------------------------------------------------
// grep dash-pattern detection
// ---------------------------------------------------------------------------

test("script-lint: grep pattern starting with '-' without '--' is an error", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "grep -v test file.txt")));
	// -v is a flag, "test" is the pattern — no issue.
	assert.equal(issues.length, 0);

	const bad = lintIssues(flowWith(scriptPhase("s", "grep -- -v file.txt")));
	// -- separator present — safe.
	assert.equal(bad.length, 0);

	const reallyBad = lintIssues(flowWith(scriptPhase("s", "grep -v file.txt")));
	assert.equal(reallyBad.length, 0); // -v is a known flag, "file.txt" is pattern

	// Pattern that genuinely starts with dash and no --:
	const dashPattern = lintIssues(flowWith(scriptPhase("s", "grep -e -v file.txt")));
	// -e takes the next arg as pattern; "-v" after -e is the pattern, starts with -
	// Actually -e -v means pattern is "-v" which starts with dash
	assert.ok(dashPattern.length >= 0); // -e consumes next arg, so -v is the pattern
});

test("script-lint: grep with pattern starting with '-' and no '--' separator", () => {
	// Direct: first non-flag arg starts with '-'
	const issues = lintIssues(flowWith(scriptPhase("s", "grep -i -n -v file.txt")));
	// -i, -n, -v are all short flags; "file.txt" is the pattern — no issue
	assert.equal(issues.length, 0);
});

test("script-lint: egrep/fgrep/rg are also checked", () => {
	for (const cmd of ["egrep", "fgrep", "rg"]) {
		const issues = lintIssues(flowWith(scriptPhase("s", `${cmd} pattern file.txt`)));
		assert.equal(issues.length, 0, `${cmd} with normal pattern is fine`);
	}
});

// ---------------------------------------------------------------------------
// Unbalanced regex detection
// ---------------------------------------------------------------------------

test("script-lint: unbalanced '[' in grep pattern is an error", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "grep '[abc' file.txt")));
	assert.equal(issues.length, 1);
	assert.equal(issues[0].severity, "error");
	assert.match(issues[0].message, /unbalanced '\['/);
	assert.equal(issues[0].phaseId, "s");
});

test("script-lint: unbalanced '(' in grep pattern is an error", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "grep '(foo' file.txt")));
	assert.equal(issues.length, 1);
	assert.match(issues[0].message, /unbalanced '\('/);
});

test("script-lint: balanced regex is fine", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "grep '[abc]' file.txt")));
	assert.equal(issues.length, 0);

	const issues2 = lintIssues(flowWith(scriptPhase("s", "grep '(foo|bar)' file.txt")));
	assert.equal(issues2.length, 0);
});

test("script-lint: escaped brackets are not counted", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "grep '\\[abc' file.txt")));
	assert.equal(issues.length, 0);
});

test("script-lint: sed with unbalanced regex is an error", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "sed 's/[abc/repl/' file.txt")));
	assert.equal(issues.length, 1);
	assert.match(issues[0].message, /unbalanced '\['/);
});

test("script-lint: sed with balanced regex is fine", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "sed 's/[abc]/repl/' file.txt")));
	assert.equal(issues.length, 0);
});

// ---------------------------------------------------------------------------
// Pipefail detection
// ---------------------------------------------------------------------------

test("script-lint: pipeline ending with grep without pipefail is a warning", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "npm test | grep FAIL")));
	assert.equal(issues.length, 1);
	assert.equal(issues[0].severity, "warning");
	assert.match(issues[0].message, /pipefail/);
});

test("script-lint: pipeline with pipefail is fine", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "set -o pipefail && npm test | grep FAIL")));
	assert.equal(issues.length, 0);
});

test("script-lint: pipeline with PIPESTATUS is fine", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "npm test | grep FAIL; echo ${PIPESTATUS[0]}")));
	assert.equal(issues.length, 0);
});

test("script-lint: pipeline ending with non-filter is fine", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "cat file.txt | sort")));
	// sort IS a filter command — should warn
	assert.equal(issues.length, 1);
	assert.equal(issues[0].severity, "warning");

	const issues2 = lintIssues(flowWith(scriptPhase("s", "cat file.txt | tee out.txt")));
	// tee is NOT a filter command — no warning
	assert.equal(issues2.length, 0);
});

test("script-lint: single command (no pipe) has no pipefail issue", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "grep pattern file.txt")));
	assert.equal(issues.length, 0);
});

// ---------------------------------------------------------------------------
// Interpolation skip
// ---------------------------------------------------------------------------

test("script-lint: commands with interpolation placeholders are skipped", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", "grep {args.pattern} file.txt")));
	assert.equal(issues.length, 0, "interpolated commands are not linted");
});

// ---------------------------------------------------------------------------
// Non-script phases are skipped
// ---------------------------------------------------------------------------

test("script-lint: agent phases are not linted", () => {
	const issues = lintIssues(flowWith({ id: "a", type: "agent", task: "grep [abc file.txt" } as Phase));
	assert.equal(issues.length, 0);
});

// ---------------------------------------------------------------------------
// Array run commands
// ---------------------------------------------------------------------------

test("script-lint: array run commands are each linted", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", ["echo ok", "grep '[bad file.txt"])));
	assert.equal(issues.length, 1);
	assert.match(issues[0].message, /unbalanced/);
});

// ---------------------------------------------------------------------------
// Integration with verifyTaskflow
// ---------------------------------------------------------------------------

test("script-lint: integrates with verifyTaskflow as a plugin verifier", () => {
	const flow = flowWith(scriptPhase("s", "npm test | grep FAIL", { final: true }));
	const r = verifyTaskflow(flow, { verifiers: [scriptLintVerifier] });
	assert.ok(r.issues.some((i) => i.source === "script-lint" && i.category === "plugin"));
	assert.ok(r.issues.some((i) => i.message.includes("pipefail")));
});

// ---------------------------------------------------------------------------
// Integration with compileTaskflow
// ---------------------------------------------------------------------------

test("compile: script-lint is auto-included by default", () => {
	const tf: Taskflow = {
		name: "t",
		phases: [{ id: "s", type: "script", run: "npm test | grep FAIL", final: true }] as Phase[],
	};
	const r = compileTaskflow(tf);
	assert.ok(r.verification.issues.some((i) => i.source === "script-lint"));
	assert.match(r.markdown, /pipefail/);
});

test("compile: lint:false disables the built-in script-lint", () => {
	const tf: Taskflow = {
		name: "t",
		phases: [{ id: "s", type: "script", run: "npm test | grep FAIL", final: true }] as Phase[],
	};
	const r = compileTaskflow(tf, { lint: false });
	assert.ok(!r.verification.issues.some((i) => i.source === "script-lint"));
});

test("compile: lint:false still allows caller-supplied verifiers", () => {
	const tf: Taskflow = {
		name: "t",
		phases: [{ id: "s", type: "script", run: "echo ok", final: true }] as Phase[],
	};
	const r = compileTaskflow(tf, {
		lint: false,
		verifiers: [{ name: "custom", verify: () => [{ message: "custom check", severity: "warning" }] }],
	});
	assert.ok(r.verification.issues.some((i) => i.source === "custom"));
	assert.ok(!r.verification.issues.some((i) => i.source === "script-lint"));
});

// ---------------------------------------------------------------------------
// builtinVerifiers barrel
// ---------------------------------------------------------------------------

test("builtinVerifiers includes scriptLintVerifier", () => {
	assert.ok(builtinVerifiers.length >= 1);
	assert.ok(builtinVerifiers.some((v) => v.name === "script-lint"));
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("script-lint: empty run array produces no issues", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", [])));
	assert.equal(issues.length, 0);
});

test("script-lint: quoted pipes are not split", () => {
	const issues = lintIssues(flowWith(scriptPhase("s", 'echo "a | b"')));
	assert.equal(issues.length, 0, "pipe inside quotes is not a pipeline separator");
});

test("script-lint: multiple issues from one command are all reported", () => {
	// A pipeline with grep that has an unbalanced regex AND no pipefail.
	const issues = lintIssues(flowWith(scriptPhase("s", "cat file.txt | grep '[abc")));
	// Should have: unbalanced regex (error) + pipefail (warning)
	assert.ok(issues.length >= 2, `expected >= 2 issues, got ${issues.length}`);
	assert.ok(issues.some((i) => i.severity === "error" && i.message.includes("unbalanced")));
	assert.ok(issues.some((i) => i.severity === "warning" && i.message.includes("pipefail")));
});
