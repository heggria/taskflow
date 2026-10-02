import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { STABLE_PACKAGE_NAMES, verifyReleaseContract } from "../../../scripts/verify-release-contract.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function fixture(changelogState: "unreleased" | "dated" = "unreleased") {
	const root = mkdtempSync(join(tmpdir(), "taskflow-release-contract-"));
	const files = ["package.json", ...[...STABLE_PACKAGE_NAMES, "charterarc", "taskflow-control"].map((name) => `packages/${name}/package.json`),
		...(["codex", "claude", "grok"] as const).flatMap((host) => [`packages/${host}-taskflow/plugin/.${host}-plugin/plugin.json`, `packages/${host}-taskflow/plugin/.mcp.json`]),
		"packages/opencode-taskflow/plugin/opencode.json", "packages/hermes-taskflow/plugin/hermes.config.snippet.yaml"];
	for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); copyFileSync(join(repo, file), join(root, file)); }
	const heading = changelogState === "dated" ? "2030-01-02" : "Unreleased";
	writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## [1.0.0] — ${heading}\n`);
	return root;
}
function change(root: string, file: string, mutate: (manifest: Record<string, unknown>) => void) {
	const path = join(root, file); const manifest = JSON.parse(readFileSync(path, "utf8")); mutate(manifest); writeFileSync(path, JSON.stringify(manifest));
}

test("1.0 release contract binds exactly the ten public packages", () => {
	const root = fixture();
	try {
		const result = verifyReleaseContract(root);
		assert.deepEqual(result.packages, ["taskflow-core", "taskflow-mcp-core", "taskflow-hosts", "taskflow-dsl", "pi-taskflow", "codex-taskflow", "claude-taskflow", "opencode-taskflow", "grok-taskflow", "hermes-taskflow"]);
		assert.equal(result.version, "1.0.0"); assert.equal(result.npmTag, "latest");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

for (const changelogState of ["unreleased", "dated"] as const) {
	test(`release contract accepts ${changelogState} preparation and admits only dated publication`, () => {
		// The fixture writes its own heading; dating the real release must not
		// change test expectations or prevent the tag workflow from proceeding.
		const root = fixture(changelogState);
		try {
			assert.equal(verifyReleaseContract(root).npmTag, "latest");
			if (changelogState === "unreleased") {
				assert.throws(() => verifyReleaseContract(root, { published: true }), /dated changelog/);
			} else {
				assert.equal(verifyReleaseContract(root, { published: true }).npmTag, "latest");
			}
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}

test("release contract rejects drift, unpinned templates and experimental dependencies before publication", () => {
	const cases: [string, (root: string) => void, RegExp][] = [
		["adapter version", (root) => change(root, "packages/pi-taskflow/package.json", (m) => { m.version = "0.0.0"; }), /pi-taskflow: release version/],
		["plugin version", (root) => change(root, "packages/codex-taskflow/plugin/.codex-plugin/plugin.json", (m) => { m.version = "0.0.0"; }), /codex: plugin version/],
		["hermes floating pin", (root) => { const path = join(root, "packages/hermes-taskflow/plugin/hermes.config.snippet.yaml"); writeFileSync(path, readFileSync(path, "utf8").replace("hermes-taskflow@1.0.0", "hermes-taskflow@latest")); }, /hermes: MCP pin/],
		["experimental control", (root) => change(root, "packages/taskflow-control/package.json", (m) => { m.private = false; }), /control must remain private/],
		["experimental dependency", (root) => change(root, "packages/taskflow-hosts/package.json", (m) => { m.dependencies = { "taskflow-control": "workspace:*" }; }), /experimental dependency/],
		["mixed dependency", (root) => change(root, "packages/taskflow-hosts/package.json", (m) => { m.dependencies = { "taskflow-core": "^1.0.0" }; }), /must use workspace/],
		["experimental latest", (root) => change(root, "packages/charterarc/package.json", (m) => { m.publishConfig = { tag: "latest" }; }), /experimental channel/],
	];
	for (const [name, mutate, expected] of cases) {
		const root = fixture(); try { mutate(root); assert.throws(() => verifyReleaseContract(root), expected, name); } finally { rmSync(root, { recursive: true, force: true }); }
	}
});


test("published changelog dates must exist in the Gregorian calendar", () => {
	for (const date of ["2026-99-99", "2026-02-30", "2026-02-29", "1900-02-29", "2026-00-01", "2026-12-32"]) {
		const root = fixture("dated");
		try {
			writeFileSync(join(root, "CHANGELOG.md"), `## [1.0.0] — ${date}\n`);
			assert.throws(() => verifyReleaseContract(root, { published: true }), /real calendar date/, date);
			assert.throws(() => verifyReleaseContract(root), /real calendar date/, `${date}: candidate must also reject invalid dates`);
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
	for (const date of ["2026-10-02", "2028-02-29", "2000-02-29"]) {
		const root = fixture("dated");
		try {
			writeFileSync(join(root, "CHANGELOG.md"), `## [1.0.0] — ${date}\n`);
			assert.equal(verifyReleaseContract(root, { published: true }).npmTag, "latest", date);
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});
