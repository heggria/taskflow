/**
 * Verifier discovery tests — convention-dir loading from
 * `.pi/taskflows/verifiers/`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverVerifiers, listVerifierPaths } from "../src/verifiers/discover.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-verifier-discover-"));
}

function writeVerifier(dir: string, name: string, code: string) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), code);
}

// ---------------------------------------------------------------------------
// Discovery from project dir
// ---------------------------------------------------------------------------

test("discover: loads a default-export verifier from project dir", async () => {
	const cwd = tmpDir();
	const vDir = path.join(cwd, ".pi", "taskflows", "verifiers");
	writeVerifier(
		vDir,
		"my-check.ts",
		`export default { name: "my-check", verify: () => [{ message: "found it", severity: "warning" }] };`,
	);
	const r = await discoverVerifiers(cwd);
	assert.equal(r.verifiers.length, 1);
	assert.equal(r.verifiers[0].name, "my-check");
	assert.equal(r.warnings.length, 0);
	assert.ok(r.dirs.some((d) => d.includes("verifiers")));
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("discover: loads named 'verifier' export", async () => {
	const cwd = tmpDir();
	const vDir = path.join(cwd, ".pi", "taskflows", "verifiers");
	writeVerifier(
		vDir,
		"named.ts",
		`export const verifier = { name: "named-check", verify: () => [] };`,
	);
	const r = await discoverVerifiers(cwd);
	assert.equal(r.verifiers.length, 1);
	assert.equal(r.verifiers[0].name, "named-check");
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("discover: loads named 'verifiers' array export", async () => {
	const cwd = tmpDir();
	const vDir = path.join(cwd, ".pi", "taskflows", "verifiers");
	writeVerifier(
		vDir,
		"multi.ts",
		`export const verifiers = [
			{ name: "a", verify: () => [] },
			{ name: "b", verify: () => [] },
		];`,
	);
	const r = await discoverVerifiers(cwd);
	assert.equal(r.verifiers.length, 2);
	assert.deepEqual(r.verifiers.map((v) => v.name), ["a", "b"]);
	fs.rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fail-open: broken modules are skipped
// ---------------------------------------------------------------------------

test("discover: a broken module is skipped with a warning", async () => {
	const cwd = tmpDir();
	const vDir = path.join(cwd, ".pi", "taskflows", "verifiers");
	writeVerifier(vDir, "broken.ts", `throw new Error("boom");`);
	writeVerifier(vDir, "good.ts", `export default { name: "good", verify: () => [] };`);
	const r = await discoverVerifiers(cwd);
	assert.equal(r.verifiers.length, 1);
	assert.equal(r.verifiers[0].name, "good");
	assert.ok(r.warnings.some((w) => w.includes("broken.ts")));
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("discover: a module with no valid export produces a warning", async () => {
	const cwd = tmpDir();
	const vDir = path.join(cwd, ".pi", "taskflows", "verifiers");
	writeVerifier(vDir, "empty.ts", `export const notAVerifier = 42;`);
	const r = await discoverVerifiers(cwd);
	assert.equal(r.verifiers.length, 0);
	assert.ok(r.warnings.some((w) => w.includes("no valid TaskflowVerifier")));
	fs.rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// No verifiers dir → empty result
// ---------------------------------------------------------------------------

test("discover: no verifiers dir returns empty", async () => {
	const cwd = tmpDir();
	const r = await discoverVerifiers(cwd);
	assert.equal(r.verifiers.length, 0);
	assert.equal(r.warnings.length, 0);
	fs.rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// listVerifierPaths (sync)
// ---------------------------------------------------------------------------

test("listVerifierPaths: lists files without importing", () => {
	const cwd = tmpDir();
	const vDir = path.join(cwd, ".pi", "taskflows", "verifiers");
	writeVerifier(vDir, "a.ts", "");
	writeVerifier(vDir, "b.js", "");
	writeVerifier(vDir, ".hidden.ts", "");
	writeVerifier(vDir, "readme.md", "");
	const r = listVerifierPaths(cwd);
	assert.equal(r.project.length, 2, "only .ts and .js, no hidden, no .md");
	assert.ok(r.project.every((f) => f.endsWith(".ts") || f.endsWith(".js")));
	fs.rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hidden files and non-verifier extensions are ignored
// ---------------------------------------------------------------------------

test("discover: hidden files and non-ts/js files are ignored", async () => {
	const cwd = tmpDir();
	const vDir = path.join(cwd, ".pi", "taskflows", "verifiers");
	writeVerifier(vDir, ".hidden.ts", `export default { name: "hidden", verify: () => [] };`);
	writeVerifier(vDir, "readme.md", `# not a verifier`);
	writeVerifier(vDir, "real.ts", `export default { name: "real", verify: () => [] };`);
	const r = await discoverVerifiers(cwd);
	assert.equal(r.verifiers.length, 1);
	assert.equal(r.verifiers[0].name, "real");
	fs.rmSync(cwd, { recursive: true, force: true });
});
