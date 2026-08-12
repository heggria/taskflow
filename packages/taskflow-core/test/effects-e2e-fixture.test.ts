/** No-LLM runtime fixture for the resource-controlled Trusted Effects path. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { type Taskflow, validateTaskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";

function mkState(def: Taskflow, cwd: string, runId: string): RunState {
	return {
		runId,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

function deps(cwd: string, control: string): RuntimeDeps {
	return {
		cwd,
		workspaceControlDirectory: control,
		agents: [],
		runTask: async () => { throw new Error("script-only fixture must not call an LLM"); },
		persist: () => {},
		onProgress: () => {},
	};
}

function fileEffect(id: string, relativePath: string, intent: "create-file" | "existing-file" = "create-file") {
	return {
		id,
		kind: "fs.write" as const,
		purpose: `write ${relativePath}`,
		confidentiality: "internal" as const,
		integrity: "project" as const,
		target: {
			kind: "path" as const,
			path: { workspace: "project", subpath: { literalPath: relativePath }, intent },
		},
	};
}

test("fixture: script output commits through resource authority without an LLM", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-fixture-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const def: Taskflow = {
			name: "trusted-effects-write",
			phases: [{
				id: "write-report",
				type: "script",
				run: ["node", "-e", "process.stdout.write('REPORT')"],
				effects: [fileEffect("report", "out/report.md")],
				final: true,
			}],
		};
		assert.equal(validateTaskflow(def).ok, true);
		const result = await executeTaskflow(mkState(def, root, "fixture-commit"), deps(root, control));
		assert.equal(result.ok, true, result.finalOutput);
		assert.equal(fs.readFileSync(path.join(root, "out/report.md"), "utf8"), "REPORT");
		assert.ok((result.state.phases["write-report"]?.warnings ?? []).some((warning) => /resource intent/.test(warning)));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("fixture: checked-in Trusted Effects example executes through the same path", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-example-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/trusted-effects-write.json");
		const def = JSON.parse(fs.readFileSync(example, "utf8")) as Taskflow;
		const result = await executeTaskflow(mkState(def, root, "fixture-example"), deps(root, control));
		assert.equal(result.ok, true, result.finalOutput);
		assert.ok(fs.existsSync(path.join(root, "out/report.md")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("fixture: direct overwrite of an existing final is rejected and original bytes are restored", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-existing-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		fs.mkdirSync(path.join(root, "out"));
		fs.writeFileSync(path.join(root, "out/report.md"), "ORIGINAL");
		const def: Taskflow = {
			name: "trusted-effects-restore-existing",
			phases: [{
				id: "write-report",
				type: "script",
				run: ["node", "-e", "require('fs').writeFileSync('out/report.md','BYPASS');process.stdout.write('DECLARED')"],
				effects: [fileEffect("report", "out/report.md", "existing-file")],
				final: true,
			}],
		};
		const result = await executeTaskflow(mkState(def, root, "fixture-restore"), deps(root, control));
		assert.equal(result.ok, false);
		assert.equal(fs.readFileSync(path.join(root, "out/report.md"), "utf8"), "ORIGINAL");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("fixture: multi-write JSON output commits as one resource transaction", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-multi-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const def: Taskflow = {
			name: "trusted-effects-multi",
			phases: [{
				id: "write",
				type: "script",
				run: ["node", "-e", "process.stdout.write(JSON.stringify({a:'A',b:'B'}))"],
				effects: [fileEffect("a", "a.txt"), fileEffect("b", "b.txt")],
				final: true,
			}],
		};
		const result = await executeTaskflow(mkState(def, root, "fixture-multi"), deps(root, control));
		assert.equal(result.ok, true, result.finalOutput);
		assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "A");
		assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "B");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});

test("fixture: overlapping declared targets fail before script invocation", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-overlap-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tf-te-control-"));
	try {
		const marker = path.join(root, "invoked");
		const def: Taskflow = {
			name: "trusted-effects-overlap",
			phases: [{
				id: "write",
				type: "script",
				run: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'yes')`],
				effects: [fileEffect("a", "same.txt"), fileEffect("b", "same.txt")],
				final: true,
			}],
		};
		const result = await executeTaskflow(mkState(def, root, "fixture-overlap"), deps(root, control));
		assert.equal(result.ok, false);
		assert.equal(fs.existsSync(marker), false);
		assert.match(result.state.phases.write?.error ?? "", /overlap|effectir-invalid/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	}
});
