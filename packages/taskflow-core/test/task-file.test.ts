/**
 * #143 taskFile is load-time include sugar, not a runtime channel.
 * After a trusted loader inlines the file into `task` and deletes `taskFile`,
 * validate / interpolate / cache / both kernels see only `task`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { interpolate } from "../src/interpolate.ts";
import { desugar, validateTaskflow } from "../src/schema.ts";
import {
	getFlow,
	MAX_TASK_FILE_BYTES,
	readDefineFile,
	readDefineFileWithSource,
	type LoadResult,
} from "../src/store.ts";

function valueOf<T>(r: LoadResult<T>): T {
	assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r)}`);
	return (r as { ok: true; value: T }).value;
}

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-task-file-"));
}

function writeJson(dir: string, name: string, value: unknown): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return file;
}

test("validateTaskflow: task and taskFile are mutually exclusive", () => {
	const result = validateTaskflow({
		name: "xor",
		phases: [
			{
				id: "review",
				type: "agent",
				task: "inline",
				taskFile: "prompts/review.md",
				final: true,
			},
		],
	});
	assert.equal(result.ok, false);
	const joined = result.errors.join("\n");
	assert.doesNotMatch(joined, /unknown field 'taskFile'/i);
	assert.match(joined, /task['"]? and ['"]?taskFile|mutually exclusive/i);
});

test("validateTaskflow: leftover taskFile on inline define is TF_TASKFILE_NO_PROVENANCE", () => {
	const result = validateTaskflow({
		name: "inline",
		phases: [{ id: "review", type: "agent", taskFile: "prompts/review.md", final: true }],
	});
	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /TF_TASKFILE_NO_PROVENANCE/);
});

test("validateTaskflow: leftover taskFile on dynamic def is TF_DYNAMIC_RESOURCE_FORBIDDEN", () => {
	const result = validateTaskflow(
		{
			name: "generated",
			phases: [{ id: "review", type: "agent", taskFile: "prompts/review.md", final: true }],
		},
		{ dynamic: true },
	);
	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /TF_DYNAMIC_RESOURCE_FORBIDDEN/);
	assert.doesNotMatch(result.errors.join("\n"), /TF_TASKFILE_NO_PROVENANCE/);
});

test("readDefineFileWithSource: inlines taskFile into task and deletes the field", () => {
	const dir = tmpDir();
	try {
		fs.mkdirSync(path.join(dir, "prompts"));
		const body = "Review every changed file under {args.dir} for security risks.\n";
		fs.writeFileSync(path.join(dir, "prompts", "review.md"), body, "utf8");
		const file = writeJson(dir, "flow.json", {
			name: "review",
			phases: [{ id: "review", type: "agent", taskFile: "prompts/review.md", final: true }],
		});
		const loaded = valueOf(readDefineFileWithSource(file));
		const def = loaded.value as {
			phases: Array<{ id: string; task?: string; taskFile?: string }>;
		};
		assert.equal(def.phases[0]!.task, body);
		assert.equal(def.phases[0]!.taskFile, undefined);
		const validated = validateTaskflow(def);
		assert.equal(validated.ok, true, validated.errors.join("; "));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("inlined taskFile body interpolates {args} after materialize", () => {
	const dir = tmpDir();
	try {
		fs.mkdirSync(path.join(dir, "prompts"));
		fs.writeFileSync(path.join(dir, "prompts", "hi.md"), "Hello {args.name}", "utf8");
		const file = writeJson(dir, "flow.json", {
			name: "greet",
			args: { name: { default: "world" } },
			phases: [{ id: "say", type: "agent", taskFile: "prompts/hi.md", final: true }],
		});
		const def = valueOf(readDefineFile(file)) as { phases: Array<{ task: string }> };
		const result = interpolate(def.phases[0]!.task, { args: { name: "Ada" }, steps: {} });
		assert.equal(result.text, "Hello Ada");
		assert.deepEqual(result.missing, []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("taskFile path with .. is rejected and never read", () => {
	const dir = tmpDir();
	const outside = tmpDir();
	try {
		fs.writeFileSync(path.join(outside, "secret.md"), "SECRET", "utf8");
		const file = writeJson(dir, "flow.json", {
			name: "escape",
			phases: [{ id: "p", type: "agent", taskFile: `../${path.basename(outside)}/secret.md`, final: true }],
		});
		const loaded = readDefineFileWithSource(file);
		assert.equal(loaded.ok, false);
		if (!loaded.ok) {
			assert.match(loaded.detail, /escapes the flow definition directory/);
			assert.match(loaded.path, /\.\./);
			assert.doesNotMatch(loaded.detail, /SECRET/);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("taskFile symlink leaf is rejected", (t) => {
	const dir = tmpDir();
	try {
		fs.mkdirSync(path.join(dir, "prompts"));
		const target = path.join(dir, "prompts", "real.md");
		const link = path.join(dir, "prompts", "link.md");
		fs.writeFileSync(target, "via symlink", "utf8");
		try {
			fs.symlinkSync(target, link, "file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") {
				t.skip("file symlinks unavailable");
				return;
			}
			throw error;
		}
		const file = writeJson(dir, "flow.json", {
			name: "symlink",
			phases: [{ id: "p", type: "agent", taskFile: "prompts/link.md", final: true }],
		});
		const loaded = readDefineFileWithSource(file);
		assert.equal(loaded.ok, false);
		if (!loaded.ok) {
			assert.match(loaded.detail, /non-symlink/);
			assert.match(loaded.path, /prompts\/link\.md/);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("taskFile symlink that escapes the flow dir is rejected", (t) => {
	const dir = tmpDir();
	const outside = tmpDir();
	try {
		fs.writeFileSync(path.join(outside, "secret.md"), "SECRET", "utf8");
		fs.mkdirSync(path.join(dir, "prompts"));
		const link = path.join(dir, "prompts", "out.md");
		try {
			fs.symlinkSync(path.join(outside, "secret.md"), link, "file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") {
				t.skip("file symlinks unavailable");
				return;
			}
			throw error;
		}
		const file = writeJson(dir, "flow.json", {
			name: "escape-link",
			phases: [{ id: "p", type: "agent", taskFile: "prompts/out.md", final: true }],
		});
		const loaded = readDefineFileWithSource(file);
		assert.equal(loaded.ok, false);
		if (!loaded.ok) {
			assert.match(loaded.detail, /non-symlink|escaped|escapes/);
			assert.doesNotMatch(loaded.detail, /SECRET/);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("missing taskFile fails closed with the authored path", () => {
	const dir = tmpDir();
	try {
		const file = writeJson(dir, "flow.json", {
			name: "missing",
			phases: [{ id: "p", type: "agent", taskFile: "prompts/nope.md", final: true }],
		});
		const loaded = readDefineFileWithSource(file);
		assert.equal(loaded.ok, false);
		if (!loaded.ok) {
			assert.equal(loaded.reason, "missing");
			assert.equal(loaded.path, "prompts/nope.md");
			assert.match(loaded.detail, /prompts\/nope\.md/);
			assert.doesNotMatch(loaded.detail, /at Object\.|node:internal/);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("parallel branches[].taskFile materializes", () => {
	const dir = tmpDir();
	try {
		fs.mkdirSync(path.join(dir, "prompts"));
		fs.writeFileSync(path.join(dir, "prompts", "a.md"), "branch-a", "utf8");
		fs.writeFileSync(path.join(dir, "prompts", "b.md"), "branch-b", "utf8");
		const file = writeJson(dir, "flow.json", {
			name: "fan",
			phases: [
				{
					id: "both",
					type: "parallel",
					branches: [{ taskFile: "prompts/a.md" }, { taskFile: "prompts/b.md" }],
					final: true,
				},
			],
		});
		const def = valueOf(readDefineFile(file)) as {
			phases: Array<{ branches: Array<{ task?: string; taskFile?: string }> }>;
		};
		assert.equal(def.phases[0]!.branches[0]!.task, "branch-a");
		assert.equal(def.phases[0]!.branches[1]!.task, "branch-b");
		assert.equal(def.phases[0]!.branches[0]!.taskFile, undefined);
		assert.equal(def.phases[0]!.branches[1]!.taskFile, undefined);
		const validated = validateTaskflow(def);
		assert.equal(validated.ok, true, validated.errors.join("; "));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("validateTaskflow: gate with only score still valid", () => {
	const result = validateTaskflow({
		name: "scored",
		phases: [
			{
				id: "quality",
				type: "gate",
				score: {
					scorers: [{ type: "length-range", min: 1 }],
				},
				final: true,
			},
		],
	});
	assert.equal(result.ok, true, result.errors.join("; "));
});

test("editing the included file changes the inlined task", () => {
	const dir = tmpDir();
	try {
		fs.mkdirSync(path.join(dir, "prompts"));
		const prompt = path.join(dir, "prompts", "x.md");
		fs.writeFileSync(prompt, "v1", "utf8");
		const file = writeJson(dir, "flow.json", {
			name: "edit",
			phases: [{ id: "p", type: "agent", taskFile: "prompts/x.md", final: true }],
		});
		const first = valueOf(readDefineFile(file)) as { phases: Array<{ task: string }> };
		assert.equal(first.phases[0]!.task, "v1");
		fs.writeFileSync(prompt, "v2", "utf8");
		const second = valueOf(readDefineFile(file)) as { phases: Array<{ task: string }> };
		assert.equal(second.phases[0]!.task, "v2");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("saved-flow load materializes taskFile the same way as defineFile", () => {
	const cwd = tmpDir();
	try {
		const flowDir = path.join(cwd, ".pi", "taskflows");
		fs.mkdirSync(path.join(flowDir, "prompts"), { recursive: true });
		fs.writeFileSync(path.join(flowDir, "prompts", "saved.md"), "from-saved-flow", "utf8");
		fs.writeFileSync(
			path.join(flowDir, "review.json"),
			`${JSON.stringify({
				name: "review",
				phases: [{ id: "review", type: "agent", taskFile: "prompts/saved.md", final: true }],
			})}\n`,
			"utf8",
		);
		const saved = getFlow(cwd, "review");
		assert.ok(saved, "expected saved flow 'review'");
		assert.equal((saved.def.phases[0] as { task?: string }).task, "from-saved-flow");
		assert.equal((saved.def.phases[0] as { taskFile?: string }).taskFile, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("interpolated taskFile path is rejected without reading", () => {
	const dir = tmpDir();
	try {
		const file = writeJson(dir, "flow.json", {
			name: "dyn-path",
			phases: [{ id: "p", type: "agent", taskFile: "{args.promptPath}", final: true }],
		});
		const loaded = readDefineFileWithSource(file);
		assert.equal(loaded.ok, false);
		if (!loaded.ok) {
			assert.match(loaded.detail, /not interpolated/);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("defineFile shorthand { taskFile } materializes then desugars", () => {
	const dir = tmpDir();
	try {
		fs.mkdirSync(path.join(dir, "prompts"));
		fs.writeFileSync(path.join(dir, "prompts", "one.md"), "shorthand-body", "utf8");
		const file = writeJson(dir, "flow.json", {
			name: "short",
			taskFile: "prompts/one.md",
		});
		const def = valueOf(readDefineFile(file));
		const flow = desugar(def);
		assert.equal(flow.phases[0]!.task, "shorthand-body");
		assert.equal((flow.phases[0] as { taskFile?: string }).taskFile, undefined);
		const validated = validateTaskflow(flow);
		assert.equal(validated.ok, true, validated.errors.join("; "));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("inline shorthand leftover taskFile is TF_TASKFILE_NO_PROVENANCE after desugar", () => {
	const flow = desugar({ name: "inline-short", taskFile: "prompts/one.md" });
	const result = validateTaskflow(flow);
	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /TF_TASKFILE_NO_PROVENANCE/);
});

test("taskFile over the 256 KiB cap fails closed and names taskFile", () => {
	const dir = tmpDir();
	try {
		fs.mkdirSync(path.join(dir, "prompts"));
		fs.writeFileSync(path.join(dir, "prompts", "huge.md"), "x".repeat(MAX_TASK_FILE_BYTES + 1), "utf8");
		const file = writeJson(dir, "flow.json", {
			name: "huge",
			phases: [{ id: "p", type: "agent", taskFile: "prompts/huge.md", final: true }],
		});
		const loaded = readDefineFileWithSource(file);
		assert.equal(loaded.ok, false);
		if (!loaded.ok) {
			assert.match(loaded.detail, /taskFile exceeds/);
			assert.match(loaded.detail, new RegExp(String(MAX_TASK_FILE_BYTES)));
			assert.doesNotMatch(loaded.detail, /definition exceeds/);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("nested inline def taskFile is not inlined and stays fail-closed", () => {
	const dir = tmpDir();
	try {
		fs.mkdirSync(path.join(dir, "prompts"));
		fs.writeFileSync(path.join(dir, "prompts", "child.md"), "nested-body", "utf8");
		const file = writeJson(dir, "flow.json", {
			name: "outer",
			phases: [
				{
					id: "child",
					type: "flow",
					def: {
						name: "inner",
						phases: [{ id: "c", type: "agent", taskFile: "prompts/child.md", final: true }],
					},
					final: true,
				},
			],
		});
		const def = valueOf(readDefineFile(file)) as {
			phases: Array<{ def?: { phases: Array<{ task?: string; taskFile?: string }> } }>;
		};
		const inner = def.phases[0]!.def!.phases[0]!;
		assert.equal(inner.taskFile, "prompts/child.md");
		assert.equal(inner.task, undefined);
		const leftover = validateTaskflow(def.phases[0]!.def);
		assert.equal(leftover.ok, false);
		assert.match(leftover.errors.join("\n"), /TF_TASKFILE_NO_PROVENANCE/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
