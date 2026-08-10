import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-dsl-dist-e2e-"));

function exec(command: string, args: string[], cwd = repo): string {
	return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

try {
	exec("pnpm", ["--filter", "taskflow-core", "build"]);
	exec("pnpm", ["--filter", "taskflow-dsl", "build"]);
	const cli = path.join(repo, "packages/taskflow-dsl/dist/cli.js");
	assert.equal(fs.existsSync(cli), true, "dist/cli.js must exist after build");
	assert.match(exec(process.execPath, [cli, "--version"]), /^0\.2\.1\s*$/);

	const project = path.join(temp, "project");
	fs.mkdirSync(project);
	const source = path.join(project, "hello.tf.ts");
	fs.writeFileSync(source, `import { flow, agent } from "taskflow-dsl";\nexport default flow("hello", () => agent("hi"));\n`);
	const json = exec(process.execPath, [cli, "build", "hello.tf.ts", "--cwd", project, "--json", "--emit", "both"]);
	const result = JSON.parse(json) as { ok: boolean; taskflow?: unknown; flowir?: unknown; irHash?: string };
	assert.equal(result.ok, true);
	assert.ok(result.taskflow);
	assert.ok(result.flowir);
	assert.match(result.irHash ?? "", /^ir:[0-9a-f]{64}$/);
	assert.equal(fs.existsSync(path.join(project, "hello.taskflow.json")), false, "--json must not write files");
	const jsonc = path.join(project, "commented.jsonc");
	fs.writeFileSync(jsonc, `{"name":"commented",// comment\n"phases":[{"id":"main","type":"agent","task":"ok","final":true,}],}`);
	assert.match(
		exec(process.execPath, [cli, "decompile", "commented.jsonc", "--cwd", project, "--out", "-"]),
		/export default flow\("commented"/,
	);

	const packs = path.join(temp, "packs");
	fs.mkdirSync(packs);
	exec("pnpm", ["pack", "--pack-destination", packs], path.join(repo, "packages/taskflow-core"));
	exec("pnpm", ["pack", "--pack-destination", packs], path.join(repo, "packages/taskflow-dsl"));
	const tgz = fs.readdirSync(packs).filter((f) => f.endsWith(".tgz")).map((f) => path.join(packs, f));
	assert.equal(tgz.length, 2);
	const install = path.join(temp, "install");
	fs.mkdirSync(install);
	fs.writeFileSync(path.join(install, "package.json"), JSON.stringify({ private: true }));
	exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tgz], install);
	const installedCli = path.join(install, "node_modules/.bin/taskflow-dsl");
	assert.match(exec(installedCli, ["--version"], install), /^0\.2\.1\s*$/);
	const installedSource = path.join(install, "installed.tf.ts");
	fs.writeFileSync(installedSource, `import { flow, agent } from "taskflow-dsl";\nexport default flow("installed", () => agent("ok", { context: ["README.md"], cache: { scope: "off" } }));\n`);
	assert.match(exec(installedCli, ["check", "installed.tf.ts", "--cwd", install], install), /^ok\s*$/);
	fs.writeFileSync(installedSource, `import { flow, agent } from "taskflow-dsl";\nconst bad: number = "wrong";\nexport default flow("installed", () => agent("ok"));\n`);
	let invalidTypeRejected = false;
	try {
		exec(installedCli, ["check", "installed.tf.ts", "--cwd", install], install);
	} catch (error) {
		invalidTypeRejected = true;
		assert.equal((error as { status?: number }).status, 1);
	}
	assert.equal(invalidTypeRejected, true, "installed check must typecheck by default");

	let rejected = false;
	try {
		exec(installedCli, ["build", "hello.tf.ts", "--cwd", project, "--emit", "invalid"], install);
	} catch (error) {
		rejected = true;
		const status = (error as { status?: number }).status;
		assert.equal(status, 2);
	}
	assert.equal(rejected, true, "invalid --emit must fail");
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
