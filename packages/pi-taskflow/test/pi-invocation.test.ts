/**
 * Regression for issue #139 blocker 2: after the runner module loads, the
 * detached child falls back to `spawn("pi", …)`. A native npm install exposes
 * Pi through Windows shims (`pi.cmd` / `pi.ps1`); `spawn("pi")` is ENOENT and
 * `spawn("pi.cmd")` without a shell is EINVAL on Node 24.
 *
 * Detached argv[1] is the detached-runner script, not the Pi CLI, so the
 * existing "re-exec current script if it looks like pi" branch never fires.
 * The child must re-enter the installed Pi JS CLI via `process.execPath`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	PI_TASKFLOW_PI_ENTRY_ENV,
	defaultResolveInstalledPiCli,
	getPiInvocation,
	resolveParentPiCliEntry,
} from "../src/runner.ts";

const ARGS = ["--mode", "json", "-p", "Task: Return OK."];
const NODE_WIN = "C:\\Program Files\\nodejs\\node.exe";
const NODE_POSIX = "/usr/bin/node";
const PI_CLI = "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js";
const DETACHED_RUNNER = "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\taskflow-core\\dist\\detached-runner.js";

test("getPiInvocation: override bin still wins", () => {
	const got = getPiInvocation(ARGS, {
		overrideBin: "/tmp/fake-pi",
		platform: "win32",
		execPath: NODE_WIN,
		currentScript: DETACHED_RUNNER,
	});
	assert.deepEqual(got, { command: "/tmp/fake-pi", args: ARGS });
});

test("getPiInvocation: Windows npm shim override is rejected (no shell, no EINVAL)", () => {
	assert.throws(
		() => getPiInvocation(ARGS, {
			overrideBin: "C:\\Users\\x\\AppData\\Roaming\\npm\\pi.cmd",
			platform: "win32",
			execPath: NODE_WIN,
			currentScript: DETACHED_RUNNER,
		}),
		/pi\.cmd|shim|EINVAL|PI_TASKFLOW_PI_ENTRY/i,
	);
});

test("getPiInvocation: serialized parent Pi CLI is re-entered via execPath", () => {
	const got = getPiInvocation(ARGS, {
		entry: PI_CLI,
		platform: "win32",
		execPath: NODE_WIN,
		currentScript: DETACHED_RUNNER,
		existsSync: (p) => p === PI_CLI,
	});
	assert.deepEqual(got, { command: NODE_WIN, args: [PI_CLI, ...ARGS] });
});

test("getPiInvocation: detached Windows child resolves installed dist/cli.js, never spawn(pi)", () => {
	const got = getPiInvocation(ARGS, {
		platform: "win32",
		execPath: NODE_WIN,
		currentScript: DETACHED_RUNNER,
		existsSync: (p) => p === PI_CLI,
		resolveInstalledCli: () => PI_CLI,
	});
	assert.equal(got.command, NODE_WIN);
	assert.equal(got.args[0], PI_CLI);
	assert.deepEqual(got.args.slice(1), ARGS);
	assert.notEqual(got.command, "pi");
	assert.doesNotMatch(got.command, /\.cmd$/i);
});

test("getPiInvocation: Windows without a JS entry fails closed (no bare pi)", () => {
	assert.throws(
		() => getPiInvocation(ARGS, {
			platform: "win32",
			execPath: NODE_WIN,
			currentScript: DETACHED_RUNNER,
			existsSync: () => false,
			resolveInstalledCli: () => undefined,
		}),
		/Windows|file:\/\/|shim|PI_TASKFLOW_PI_ENTRY|dist\/cli\.js/i,
	);
});

test("getPiInvocation: POSIX fallback to bare pi is unchanged", () => {
	const got = getPiInvocation(ARGS, {
		platform: "linux",
		execPath: NODE_POSIX,
		currentScript: "/opt/taskflow-core/dist/detached-runner.js",
		existsSync: () => false,
		resolveInstalledCli: () => undefined,
	});
	assert.deepEqual(got, { command: "pi", args: ARGS });
});

test("getPiInvocation: current script that looks like the Pi CLI is re-exec'd", () => {
	const got = getPiInvocation(ARGS, {
		platform: "win32",
		execPath: NODE_WIN,
		currentScript: PI_CLI,
		existsSync: (p) => p === PI_CLI,
	});
	assert.deepEqual(got, { command: NODE_WIN, args: [PI_CLI, ...ARGS] });
});

test("resolveParentPiCliEntry: prefers the live Pi CLI script", () => {
	const got = resolveParentPiCliEntry({
		currentScript: PI_CLI,
		existsSync: (p) => p === PI_CLI,
	});
	assert.equal(got, PI_CLI);
});

test("resolveParentPiCliEntry: ignores detached-runner argv[1]", () => {
	const got = resolveParentPiCliEntry({
		currentScript: DETACHED_RUNNER,
		existsSync: () => true,
		resolveInstalledCli: () => PI_CLI,
	});
	assert.equal(got, PI_CLI);
});

test("pi host serializes PI_TASKFLOW_PI_ENTRY into the detached child env", () => {
	const src = readFileSync(
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
		"utf8",
	);
	assert.match(src, new RegExp(PI_TASKFLOW_PI_ENTRY_ENV));
	assert.match(src, /resolveParentPiCliEntry/);
});

test("defaultResolveInstalledPiCli: walks from the public package entry, not package.json subpath", () => {
	const got = defaultResolveInstalledPiCli();
	if (!got) {
		// Peer not installed in this checkout — production still fail-closes on win32.
		return;
	}
	assert.match(got, /cli\.(js|mjs|cjs)$/);
	assert.ok(existsSync(got), got);
	assert.doesNotMatch(got, /\.(cmd|bat|ps1)$/i);
});

test("package.json subpath of pi-coding-agent is not exported (the dead-code trap)", async () => {
	// Runtime-built so tsc does not resolve the unexported package.json subpath.
	const subpath = "@earendil-works/pi-coding-agent/" + "package.json";
	await assert.rejects(
		() => import(subpath, { with: { type: "json" } }),
		(err: NodeJS.ErrnoException) => {
			assert.equal(err.code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
			return true;
		},
	);
});
