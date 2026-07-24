#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_NODE_MATRIX_VERSIONS } from "./web-runtime-versions.mjs";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const tests = [
	"packages/taskflow-control/test/web-protocol.test.ts",
	"packages/taskflow-control/test/web-cursor.test.ts",
	"packages/taskflow-control/test/web-event-service.test.ts",
	"packages/taskflow-control/test/web-pagination.test.ts",
	"packages/taskflow-control/test/web-live-state-model.test.ts",
	"packages/taskflow-control/test/web-task-state-matrix.test.ts",
	"packages/taskflow-daemon/test/web-session.test.ts",
	"packages/taskflow-daemon/test/web-gateway.test.ts",
];

function readCount(output, label) {
	const matches = [
		...output.matchAll(
			new RegExp(`(?:#|ℹ) ${label} (\\d+)`, "gu"),
		),
	];
	const value = matches.at(-1)?.[1];
	if (!value) {
		throw new Error(`Node matrix output omitted ${label}`);
	}
	return Number(value);
}

const git = spawnSync("git", ["rev-parse", "HEAD"], {
	cwd: repositoryRoot,
	encoding: "utf8",
});
if (git.status !== 0) {
	throw new Error(git.stderr || "cannot resolve candidate commit");
}
const gitCommit = git.stdout.trim();
if (!/^[0-9a-f]{40}$/u.test(gitCommit)) {
	throw new Error("candidate commit must be 40-hex");
}
const trackedStatus = spawnSync(
	"git",
	["status", "--porcelain", "--untracked-files=no"],
	{
		cwd: repositoryRoot,
		encoding: "utf8",
	},
);
if (trackedStatus.status !== 0) {
	throw new Error(
		trackedStatus.stderr ||
			"cannot inspect candidate worktree",
	);
}
const trackedDirty = trackedStatus.stdout.trim().length > 0;
if (trackedDirty) {
	throw new Error(
		"Node candidate evidence requires a tracked-clean worktree",
	);
}

const runtimes = [];
for (const version of WEB_NODE_MATRIX_VERSIONS) {
	const result = spawnSync(
		"npx",
		[
			"--yes",
			`node@${version}`,
			"--conditions=development",
			"--experimental-strip-types",
			"--test",
			...tests,
		],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		},
	);
	if (result.error) throw result.error;
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	if (result.status !== 0) process.exit(result.status ?? 1);
	const testCount = readCount(result.stdout, "tests");
	const passCount = readCount(result.stdout, "pass");
	const failCount = readCount(result.stdout, "fail");
	if (passCount !== testCount || failCount !== 0) {
		throw new Error(
			`Node ${version} reported ${passCount}/${testCount} pass and ${failCount} fail`,
		);
	}
	runtimes.push({
		node: version,
		testCount,
		passCount,
		failCount,
		suiteFiles: tests.length,
	});
}

const report = {
	schemaVersion: 1,
	status: "pass",
	measuredAt: new Date().toISOString(),
	candidate: {
		gitCommit,
		trackedDirty,
	},
	runtime: {
		launcherNode: process.version,
		platform: process.platform,
		arch: process.arch,
	},
	runtimes,
};
const outputDir = path.join(
	repositoryRoot,
	"artifacts/web-node-matrix",
	gitCommit,
);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
	path.join(outputDir, "report.json"),
	`${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(
	`P17 Node matrix passed (${WEB_NODE_MATRIX_VERSIONS.join(", ")}; ${tests.length} suites per runtime)\n`,
);
