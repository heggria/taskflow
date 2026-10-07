import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ProjectRegistry } from "../src/project-registry.ts";
import { ControlError } from "../src/errors.ts";

function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tf-registry-")));
	const projects = ["a", "b"].map((name) => { const p = path.join(root, name); fs.mkdirSync(p); return p; });
	const file = path.join(root, "user", "registry.json");
	const registry = new ProjectRegistry(file);
	return { root, projects, file, registry, cleanup() { registry.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const storePath = (root: string) => path.join(root, ".taskflow", "control");
const durability = (error: unknown) => error instanceof ControlError && error.code === "TF_DURABILITY_FAILED";

test("registry mounts two real stores with explicit routing and stable distinct identities", () => {
	const f = fixture(); try {
		const a = f.registry.mount(storePath(f.projects[0])), b = f.registry.mount(storePath(f.projects[1]));
		assert.notEqual(a.store.header.projectId, b.store.header.projectId);
		assert.notEqual(a.store.header.controlDomainId, b.store.header.controlDomainId);
		assert.equal(f.registry.resolve(a.store.header.projectId).store, a.store);
		assert.equal(f.registry.resolve(b.store.header.projectId).store, b.store);
		assert.throws(() => f.registry.resolve(), /explicit projectId/);
		assert.equal(f.registry.mount(storePath(f.projects[0])), a);
		assert.equal(f.registry.list().length, 2);
	} finally { f.cleanup(); }
});

test("registry loss rebuilds from exact existing headers and never invents run state", () => {
	const f = fixture(); let reopened: ProjectRegistry | undefined; try {
		const a = f.registry.mount(storePath(f.projects[0]));
		const identity = a.store.header, bytes = fs.readFileSync(path.join(a.store.storePath, "header"));
		f.registry.close(); fs.unlinkSync(f.file);
		reopened = new ProjectRegistry(f.file);
		const again = reopened.mount(storePath(f.projects[0]));
		assert.deepEqual(again.store.header, identity);
		assert.deepEqual(fs.readFileSync(path.join(again.store.storePath, "header")), bytes);
		assert.equal(again.store.commitSeq, 0);
	} finally { reopened?.close(); f.cleanup(); }
});

test("persisted registry discovery does not automatically open or authorize project paths", () => {
	const f = fixture(); let reopened: ProjectRegistry | undefined; try {
		const id = f.registry.mount(storePath(f.projects[0])).store.header.projectId;
		f.registry.close(); reopened = new ProjectRegistry(f.file);
		assert.equal(reopened.list()[0].mountState, "unmounted");
		assert.throws(() => reopened!.resolve(id), /not mounted/);
		assert.equal(reopened.mount(storePath(f.projects[0])).store.header.projectId, id);
	} finally { reopened?.close(); f.cleanup(); }
});

test("missing ledger header is rejected without resetting its remaining bytes", () => {
	const f = fixture(); let reopened: ProjectRegistry | undefined; try {
		const a = f.registry.mount(storePath(f.projects[0])); f.registry.close();
		const seq = path.join(a.store.storePath, "commit-seq.json"), before = fs.readFileSync(seq);
		fs.unlinkSync(path.join(a.store.storePath, "header")); fs.unlinkSync(f.file);
		reopened = new ProjectRegistry(f.file);
		assert.throws(() => reopened!.mount(storePath(f.projects[0])), durability);
		assert.equal(fs.existsSync(path.join(a.store.storePath, "header")), false);
		assert.deepEqual(fs.readFileSync(seq), before);
	} finally { reopened?.close(); f.cleanup(); }
});

test("copied ledger cannot alias another project and preserves copied evidence", () => {
	const f = fixture(); try {
		const a = f.registry.mount(storePath(f.projects[0]));
		const copied = storePath(f.projects[1]); fs.cpSync(a.store.storePath, copied, { recursive: true });
		fs.unlinkSync(path.join(copied, "writer.lock"));
		const before = fs.readFileSync(path.join(copied, "header"));
		assert.throws(() => f.registry.mount(copied), durability);
		assert.deepEqual(fs.readFileSync(path.join(copied, "header")), before);
		assert.equal(f.registry.resolve(a.store.header.projectId).store, a.store);
	} finally { f.cleanup(); }
});

test("mounted header mutation prevents routing while leaving bytes untouched", () => {
	const f = fixture(); try {
		const a = f.registry.mount(storePath(f.projects[0]));
		const file = path.join(a.store.storePath, "header"); fs.writeFileSync(file, "corrupt");
		assert.throws(() => f.registry.resolve(a.store.header.projectId), durability);
		assert.equal(fs.readFileSync(file, "utf8"), "corrupt");
	} finally { f.cleanup(); }
});

test("symlink and replaced registry directory fail closed", () => {
	const f = fixture(); try {
		const alias = path.join(f.root, "alias"); fs.symlinkSync(f.projects[0], alias, "dir");
		assert.throws(() => f.registry.mount(storePath(alias)), durability);
		const original = path.dirname(f.file); fs.renameSync(original, `${original}-old`); fs.mkdirSync(original);
		assert.throws(() => f.registry.mount(storePath(f.projects[0])), durability);
	} finally { f.cleanup(); }
});

test("corrupt discovery projection is preserved and does not reset ledger identity", () => {
	const f = fixture(); try {
		const a = f.registry.mount(storePath(f.projects[0])); f.registry.close();
		const before = fs.readFileSync(path.join(a.store.storePath, "header")); fs.writeFileSync(f.file, "broken");
		assert.throws(() => new ProjectRegistry(f.file));
		assert.equal(fs.readFileSync(f.file, "utf8"), "broken");
		assert.deepEqual(fs.readFileSync(path.join(a.store.storePath, "header")), before);
	} finally { f.cleanup(); }
});
