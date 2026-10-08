/** P13 acceptance against an installed public package, never workspace imports. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function smokeControlBundle(consumerDir) {
	assert.equal(existsSync(join(consumerDir, "node_modules", "taskflow-control")), false,
		"public control must not depend on the private workspace package");
	const bundle = join(consumerDir, "node_modules", "taskflow-mcp-core");
	const manifest = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8"));
	assert.equal(manifest.bin["taskflow-control"], "./dist/control/control-cli.js");
	assert.ok(readFileSync(join(bundle, "CONTROL_GUIDE.md"), "utf8").includes("taskflow-control run"));
	// Unix control is the supported P13 transport. Keep the socket path below
	// macOS sockaddr_un limits even when the checkout or npm consumer is deep.
	const temporaryRoot = realpathSync(mkdtempSync("/tmp/tfpc-"));
	try {
		const project = join(temporaryRoot, "project");
		const home = join(temporaryRoot, "home");
		mkdirSync(project, { mode: 0o700 });
		const env = { ...process.env, TASKFLOW_HOME: home, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" };
		const call = (bin, args) => {
			const executable = join(consumerDir, "node_modules", ".bin", bin);
			assert.ok(realpathSync(executable).startsWith(realpathSync(bundle) + "/"), "binary must resolve inside the installed public package");
			const result = spawnSync(process.execPath, [executable, ...args], { cwd: project, env, encoding: "utf8", timeout: 30_000 });
			assert.equal(result.error, undefined, result.error?.message);
			assert.equal(result.status, 0, `${bin}: ${result.stderr}\n${result.stdout}`);
			return result.stdout;
		};
		assert.match(call("taskflow-control", ["--help"]), /taskflow-control run/);
		assert.match(call("taskflow-project-admin", ["--help"]), /move-rebind/);
		const flow = join(project, "fresh.json");
		writeFileSync(flow, JSON.stringify({ name: "fresh-public-control", phases: [{ id: "proof", type: "script", run: [process.execPath, "-e", "require('node:fs').writeFileSync('proof.txt','installed');process.stdout.write('PUBLIC_CONTROL_OK')"], final: true }] }));
		assert.equal(existsSync(join(home, "control", "registry.json")), false);
		// No --mode, --control-home, daemon configuration or source-only condition.
		const first = JSON.parse(call("taskflow-control", ["run", "--root", project, "--flow", flow]));
		assert.equal(first.run.status, "completed");
		assert.equal(first.run.slot, "released");
		assert.equal(first.result.finalOutput, "PUBLIC_CONTROL_OK");
		assert.equal(readFileSync(join(project, "proof.txt"), "utf8"), "installed");
		assert.ok(existsSync(join(home, "control", "registry.json")));
		const second = JSON.parse(call("taskflow-control", ["run", "--root", project, "--flow", flow]));
		assert.equal(second.projectId, first.projectId, "restart must retain the project identity");
		assert.equal(second.controlDomainId, first.controlDomainId);
		assert.notEqual(second.runId, first.runId);
		assert.equal(second.run.status, "completed");
		const status = JSON.parse(call("taskflow-control", ["status", "--root", project, "--mode", "auto", "--run", first.runId]));
		assert.equal(status.result.status, "completed");
		process.stdout.write("public control bundle passed: 2 installed bins, fresh default auto run, durable restart and status; no private package\n");
	} finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
}
