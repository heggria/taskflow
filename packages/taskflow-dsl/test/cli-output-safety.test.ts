import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeContainedFileAtomic } from "../src/paths.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repo, "packages/taskflow-dsl/src/cli.ts");

function runCli(args: string[]) {
	return spawnSync(
		process.execPath,
		["--conditions=development", "--experimental-strip-types", cli, ...args],
		{ cwd: repo, encoding: "utf8" },
	);
}

test("CLI outputs: build refuses overwrite, --force atomically replaces regular files", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "tf-dsl-build-output-"));
	try {
		const project = path.join(root, "project");
		mkdirSync(project);
		writeFileSync(
			path.join(project, "review.tf.ts"),
			'import { flow, agent } from "taskflow-dsl";\nexport default flow("review", () => agent("ok"));\n',
		);
		const output = path.join(project, "review.taskflow.json");
		writeFileSync(output, "sentinel");

		const refused = runCli(["build", "review.tf.ts", "--cwd", project]);
		assert.equal(refused.status, 2, refused.stderr);
		assert.match(refused.stderr, /TFDSL_IO_EXISTS: refusing to overwrite/);
		assert.equal(readFileSync(output, "utf8"), "sentinel");

		const forced = runCli(["build", "review.tf.ts", "--cwd", project, "--force"]);
		assert.equal(forced.status, 0, forced.stderr);
		assert.equal(JSON.parse(readFileSync(output, "utf8")).name, "review");
		assert.deepEqual(readdirSync(project).filter((name) => name.endsWith(".tmp")), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CLI outputs: --emit both preflights both destinations before writing either", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "tf-dsl-build-both-"));
	try {
		writeFileSync(
			path.join(root, "review.tf.ts"),
			'import { flow, agent } from "taskflow-dsl";\nexport default flow("review", () => agent("ok"));\n',
		);
		writeFileSync(path.join(root, "review.flowir.json"), "sentinel");

		const result = runCli(["build", "review.tf.ts", "--cwd", root, "--emit", "both"]);
		assert.equal(result.status, 2, result.stderr);
		assert.match(result.stderr, /TFDSL_IO_EXISTS: refusing to overwrite/);
		assert.equal(existsSync(path.join(root, "review.taskflow.json")), false);
		assert.equal(readFileSync(path.join(root, "review.flowir.json"), "utf8"), "sentinel");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CLI outputs: build and decompile reject symlinks escaping --cwd, including with --force", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "tf-dsl-symlink-output-"));
	try {
		const project = path.join(root, "project");
		const outside = path.join(root, "outside");
		mkdirSync(project);
		mkdirSync(outside);
		writeFileSync(
			path.join(project, "review.tf.ts"),
			'import { flow, agent } from "taskflow-dsl";\nexport default flow("review", () => agent("ok"));\n',
		);
		const outsideBuild = path.join(outside, "stolen.json");
		writeFileSync(outsideBuild, "outside-build");
		symlinkSync(outsideBuild, path.join(project, "review.taskflow.json"));

		const build = runCli(["build", "review.tf.ts", "--cwd", project, "--force"]);
		assert.equal(build.status, 2, build.stderr);
		assert.match(build.stderr, /TFDSL_IO_PATH: output path escapes --cwd through a symlink/);
		assert.equal(readFileSync(outsideBuild, "utf8"), "outside-build");

		writeFileSync(
			path.join(project, "flow.json"),
			JSON.stringify({ name: "flow", phases: [{ id: "main", type: "agent", task: "ok", final: true }] }),
		);
		const outsideSource = path.join(outside, "stolen.tf.ts");
		writeFileSync(outsideSource, "outside-source");
		symlinkSync(outsideSource, path.join(project, "flow.tf.ts"));

		const decompile = runCli(["decompile", "flow.json", "--cwd", project, "--force"]);
		assert.equal(decompile.status, 2, decompile.stderr);
		assert.match(decompile.stderr, /TFDSL_IO_PATH: output path escapes --cwd through a symlink/);
		assert.equal(readFileSync(outsideSource, "utf8"), "outside-source");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CLI outputs: decompile refuses an existing default output unless --force is explicit", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "tf-dsl-decompile-output-"));
	try {
		writeFileSync(
			path.join(root, "flow.json"),
			JSON.stringify({ name: "flow", phases: [{ id: "main", type: "agent", task: "ok", final: true }] }),
		);
		const output = path.join(root, "flow.tf.ts");
		writeFileSync(output, "sentinel");

		const refused = runCli(["decompile", "flow.json", "--cwd", root]);
		assert.equal(refused.status, 2, refused.stderr);
		assert.match(refused.stderr, /TFDSL_IO_EXISTS: refusing to overwrite/);
		assert.equal(readFileSync(output, "utf8"), "sentinel");

		const forced = runCli(["decompile", "flow.json", "--cwd", root, "--force"]);
		assert.equal(forced.status, 0, forced.stderr);
		assert.match(readFileSync(output, "utf8"), /flow\("flow"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("atomic output helper commits complete files and never follows a destination symlink", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "tf-dsl-atomic-output-"));
	try {
		const output = writeContainedFileAtomic(root, "nested/result.json", "first");
		assert.equal(readFileSync(output, "utf8"), "first");
		assert.throws(
			() => writeContainedFileAtomic(root, "nested/result.json", "second"),
			/TFDSL_IO_EXISTS: refusing to overwrite/,
		);
		writeContainedFileAtomic(root, "nested/result.json", "second", { force: true });
		assert.equal(readFileSync(output, "utf8"), "second");

		const directoryOutput = path.join(root, "nested/directory-output");
		mkdirSync(directoryOutput);
		assert.throws(
			() => writeContainedFileAtomic(root, "nested/directory-output", "nope", { force: true }),
			/TFDSL_IO_TYPE: refusing to replace non-regular output/,
		);
		assert.equal(readdirSync(directoryOutput).length, 0);

		unlinkSync(output);
		const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
		writeFileSync(outside, "outside");
		try {
			symlinkSync(outside, output);
			assert.throws(
				() => writeContainedFileAtomic(root, "nested/result.json", "third", { force: true }),
				/TFDSL_IO_PATH|refusing symlink output/,
			);
			assert.equal(readFileSync(outside, "utf8"), "outside");
		} finally {
			rmSync(outside, { force: true });
		}
		assert.deepEqual(readdirSync(path.dirname(output)).filter((name) => name.endsWith(".tmp")), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
