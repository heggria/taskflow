/**
 * Regression for issue #139: detached-runner dynamically imports the host
 * runner module path the parent serialized. On native Windows that value is a
 * drive-letter filesystem path (`C:\\…\\runner.js`). Node's ESM loader treats
 * `C:` as a URL scheme and rejects it with ERR_UNSUPPORTED_ESM_URL_SCHEME.
 *
 * The helper must turn filesystem paths into `file://` URLs and leave already-
 * valid ESM specifiers alone. detached-runner must call the helper — a raw
 * `import(ctx.runnerModule)` is the bug.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toModuleImportSpecifier } from "../src/module-specifier.ts";

test("toModuleImportSpecifier: Windows drive-letter path becomes a file URL", () => {
	assert.equal(
		toModuleImportSpecifier("C:\\Users\\x\\pi-taskflow\\dist\\runner.js"),
		"file:///C:/Users/x/pi-taskflow/dist/runner.js",
	);
	assert.equal(
		toModuleImportSpecifier("D:/a/taskflow/packages/pi-taskflow/dist/runner.js"),
		"file:///D:/a/taskflow/packages/pi-taskflow/dist/runner.js",
	);
});

test("toModuleImportSpecifier: POSIX absolute path becomes a file URL", () => {
	const posix = "/home/x/pi-taskflow/dist/runner.js";
	// On win32 this is a drive-relative path; pathToFileURL prefixes the
	// current drive (CI windows-latest saw file:///D:/home/x/...). On POSIX
	// it is a real absolute path. Match the helper's pathToFileURL fallback.
	assert.equal(toModuleImportSpecifier(posix), pathToFileURL(posix).href);
});

test("toModuleImportSpecifier: file/data/node specifiers are left alone", () => {
	assert.equal(
		toModuleImportSpecifier("file:///C:/Users/x/runner.js"),
		"file:///C:/Users/x/runner.js",
	);
	assert.equal(toModuleImportSpecifier("node:fs"), "node:fs");
	assert.equal(toModuleImportSpecifier("data:text/javascript,export default 1"), "data:text/javascript,export default 1");
});

test("toModuleImportSpecifier: drive-letter is NOT treated as an ESM scheme", () => {
	const spec = toModuleImportSpecifier("C:\\tmp\\runner.js");
	assert.match(spec, /^file:/);
	assert.doesNotMatch(spec, /^c:/i);
});

test("toModuleImportSpecifier: Windows paths percent-encode # ? and spaces", () => {
	assert.equal(
		toModuleImportSpecifier("C:\\Program Files\\x\\a#b\\runner.js"),
		"file:///C:/Program%20Files/x/a%23b/runner.js",
	);
	assert.equal(
		toModuleImportSpecifier("C:\\tmp\\a?b.js"),
		"file:///C:/tmp/a%3Fb.js",
	);
});

test("toModuleImportSpecifier: UNC path becomes a file URL", () => {
	assert.equal(
		toModuleImportSpecifier("\\\\server\\share\\runner.js"),
		"file://server/share/runner.js",
	);
});

test("toModuleImportSpecifier: live path round-trips through dynamic import", async () => {
	const here = fileURLToPath(import.meta.url);
	const spec = toModuleImportSpecifier(here);
	assert.equal(spec, pathToFileURL(here).href);
	const mod = await import(spec);
	assert.equal(typeof mod, "object");
});

test("drive-letter strings are rejected by the ESM loader (the #139 symptom)", async () => {
	// Runtime-built so tsc does not try to resolve the Windows path as a module.
	const driveLetterPath = ["C:", "\\Users\\x\\pi-taskflow\\dist\\runner.js"].join("");
	await assert.rejects(
		() => import(driveLetterPath),
		(err: NodeJS.ErrnoException) => {
			assert.equal(err.code, "ERR_UNSUPPORTED_ESM_URL_SCHEME");
			assert.match(String(err.message), /protocol 'c:'/i);
			return true;
		},
	);
});

test("detached-runner imports runnerModule through toModuleImportSpecifier", () => {
	const src = readFileSync(
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/detached-runner.ts"),
		"utf8",
	);
	assert.match(src, /toModuleImportSpecifier/);
	assert.doesNotMatch(
		src,
		/await import\(\s*ctx\.runnerModule\s*\)/,
		"raw import(ctx.runnerModule) is the Windows ESM scheme bug",
	);
});

test("helper module exists next to detached-runner (not only in tests)", () => {
	const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/module-specifier.ts");
	assert.ok(existsSync(helper), helper);
});
