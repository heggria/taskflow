/**
 * Tests for store edge cases (safeFlowDirName, validateRunId, writeFileAtomic)
 * and cache fingerprint resolution (git, glob, file, env prefixes).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hashInput, newRunId, validateRunId, writeFileAtomic } from "../src/store.ts";

// ════════════════════════════════════════════════════════════════════
// HASH INPUT
// ════════════════════════════════════════════════════════════════════

test("hashInput: deterministic for same input", () => {
	const a = hashInput("foo", "bar");
	const b = hashInput("foo", "bar");
	assert.equal(a, b);
});

test("hashInput: different inputs produce different hashes", () => {
	const a = hashInput("foo", "bar");
	const b = hashInput("foo", "baz");
	assert.notEqual(a, b);
});

test("hashInput: empty parts still produces a hash", () => {
	const h = hashInput();
	assert.equal(typeof h, "string");
	assert.ok(h.length > 0);
});

test("hashInput: order matters", () => {
	const a = hashInput("a", "b");
	const b = hashInput("b", "a");
	assert.notEqual(a, b);
});

test("hashInput: result is 16 hex chars", () => {
	const h = hashInput("test");
	assert.equal(h.length, 16);
	assert.match(h, /^[0-9a-f]{16}$/);
});

// ════════════════════════════════════════════════════════════════════
// NEW RUN ID
// ════════════════════════════════════════════════════════════════════

test("newRunId: contains sanitized flow name prefix", () => {
	const id = newRunId("my-flow");
	assert.ok(id.startsWith("my-flow-"), `expected prefix "my-flow-", got "${id}"`);
});

test("newRunId: special characters in flow name are replaced", () => {
	const id = newRunId("my flow@name!");
	assert.ok(!id.includes(" "), "spaces should be replaced");
	assert.ok(!id.includes("@"), "@ should be replaced");
	assert.ok(!id.includes("!"), "! should be replaced");
});

test("newRunId: consecutive calls produce unique ids", () => {
	const a = newRunId("test");
	const b = newRunId("test");
	assert.notEqual(a, b);
});

test("newRunId: long flow name is truncated", () => {
	const longName = "a".repeat(100);
	const id = newRunId(longName);
	// The prefix should be at most 24 chars
	const prefix = id.split("-")[0];
	assert.ok(prefix.length <= 24, `prefix length ${prefix.length} should be <= 24`);
});

test("newRunId: dot-leading flow names remain valid and loadable", () => {
	const id = newRunId(".ci");
	assert.ok(id.startsWith(".ci-"));
	assert.equal(validateRunId(id), true);
});

test("validateRunId: rejects traversal and path separators", () => {
	for (const id of ["../escape", "a..b", "a/b", "a\\b", "", "x".repeat(161)]) {
		assert.equal(validateRunId(id), false, `expected ${JSON.stringify(id)} to be rejected`);
	}
});

// ════════════════════════════════════════════════════════════════════
// WRITE FILE ATOMIC
// ════════════════════════════════════════════════════════════════════

test("writeFileAtomic: creates parent directories", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-atomic-"));
	const nested = path.join(tmpDir, "a", "b", "c", "file.txt");
	writeFileAtomic(nested, "hello");
	const content = fs.readFileSync(nested, "utf-8");
	assert.equal(content, "hello");
	await fs.promises.rm(tmpDir, { recursive: true });
});

test("writeFileAtomic: overwrites existing file", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-atomic2-"));
	const filePath = path.join(tmpDir, "file.txt");
	writeFileAtomic(filePath, "first");
	writeFileAtomic(filePath, "second");
	const content = fs.readFileSync(filePath, "utf-8");
	assert.equal(content, "second");
	await fs.promises.rm(tmpDir, { recursive: true });
});

test("writeFileAtomic: no temp files left behind on success", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-atomic3-"));
	const filePath = path.join(tmpDir, "file.txt");
	writeFileAtomic(filePath, "content");
	const files = fs.readdirSync(tmpDir);
	assert.deepEqual(files, ["file.txt"], `unexpected files: ${files}`);
	await fs.promises.rm(tmpDir, { recursive: true });
});

// ════════════════════════════════════════════════════════════════════
// CACHE FINGERPRINT RESOLUTION
// ════════════════════════════════════════════════════════════════════

import { resolveFingerprint } from "../src/cache.ts";

test("resolveFingerprint: empty/undefined returns empty string", () => {
	assert.equal(resolveFingerprint(undefined, "/tmp"), "");
	assert.equal(resolveFingerprint([], "/tmp"), "");
});

test("resolveFingerprint: env: prefix reads environment variable", () => {
	process.env.TASKFLOW_TEST_VAR = "test-value-123";
	try {
		const fp = resolveFingerprint(["env:TASKFLOW_TEST_VAR"], "/tmp");
		assert.ok(fp.length > 0, "fingerprint should not be empty");
		// Changing the env var should change the fingerprint
		process.env.TASKFLOW_TEST_VAR = "different-value";
		const fp2 = resolveFingerprint(["env:TASKFLOW_TEST_VAR"], "/tmp");
		assert.notEqual(fp, fp2, "fingerprint should change when env var changes");
	} finally {
		delete process.env.TASKFLOW_TEST_VAR;
	}
});

test("resolveFingerprint: env: with unset variable uses empty string", () => {
	delete process.env.TASKFLOW_TEST_UNSET_VAR;
	const fp = resolveFingerprint(["env:TASKFLOW_TEST_UNSET_VAR"], "/tmp");
	assert.ok(fp.length > 0, "should still produce a fingerprint for unset env");
});

test("resolveFingerprint: file: prefix hashes file content", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-fp-"));
	const filePath = path.join(tmpDir, "config.json");
	await fs.promises.writeFile(filePath, '{"version": 1}');

	const fp = resolveFingerprint([`file:${filePath}`], tmpDir);
	assert.ok(fp.length > 0);

	// Changing file content changes the fingerprint
	await fs.promises.writeFile(filePath, '{"version": 2}');
	const fp2 = resolveFingerprint([`file:${filePath}`], tmpDir);
	assert.notEqual(fp, fp2);

	await fs.promises.rm(tmpDir, { recursive: true });
});

test("resolveFingerprint: file: with missing file produces stable sentinel", () => {
	const fp = resolveFingerprint(["file:/nonexistent/path/to/file"], "/tmp");
	assert.ok(fp.length > 0, "should produce a fingerprint even for missing files");
	// Same missing file → same fingerprint
	const fp2 = resolveFingerprint(["file:/nonexistent/path/to/file"], "/tmp");
	assert.equal(fp, fp2, "missing file fingerprint should be deterministic");
});

test("resolveFingerprint: glob: prefix hashes file list", async () => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-glob-"));
	await fs.promises.writeFile(path.join(tmpDir, "a.ts"), "a");
	await fs.promises.writeFile(path.join(tmpDir, "b.ts"), "b");

	const fp = resolveFingerprint(["glob:*.ts"], tmpDir);
	assert.ok(fp.length > 0);

	// Adding a file changes the glob match set
	await fs.promises.writeFile(path.join(tmpDir, "c.ts"), "c");
	const fp2 = resolveFingerprint(["glob:*.ts"], tmpDir);
	assert.notEqual(fp, fp2);

	await fs.promises.rm(tmpDir, { recursive: true });
});

test("resolveFingerprint: multiple entries are combined", () => {
	const fp = resolveFingerprint(["env:HOME", "env:PATH"], "/tmp");
	assert.ok(fp.length > 0);
	// Should be different from just one entry
	const fp2 = resolveFingerprint(["env:HOME"], "/tmp");
	assert.notEqual(fp, fp2);
});

test("resolveFingerprint: order of entries matters", () => {
	const fp1 = resolveFingerprint(["env:HOME", "env:PATH"], "/tmp");
	const fp2 = resolveFingerprint(["env:PATH", "env:HOME"], "/tmp");
	assert.notEqual(fp1, fp2, "entry order is part of the key");
});

test("resolveFingerprint: git: prefix in non-git dir produces stable sentinel", async () => {
	// Use a temp dir that is definitely NOT a git repo
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf-git-fp-"));
	const fp = resolveFingerprint(["git:HEAD"], tmpDir);
	assert.ok(fp.length > 0);
	// Same dir → same fingerprint
	const fp2 = resolveFingerprint(["git:HEAD"], tmpDir);
	assert.equal(fp, fp2, "non-git fingerprint should be deterministic");
	await fs.promises.rm(tmpDir, { recursive: true });
});
